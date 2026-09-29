import { BadRequestException, Injectable } from '@nestjs/common';

import { ContactsHeaderDetectionService, SheetGrade } from './header-detection.service';
import { CONTACT_FIELDS, ContactField } from './header-dictionary';
import { ContactsSplitMergeService, ColumnMapping, ResolvedRow, mappingHeaders } from './split-merge.service';
import { ContactsDedupService, DedupDecision } from './dedup.service';
import { ExtractedSheet, TriageResult } from './triage.service';

/**
 * BM2 · Contacts import wizard · Stage 5 orchestrator — takes the
 * Stage 1/2 upload result + the user's per-sheet mapping decisions
 * and returns a fully resolved preview: split cells marked, forward-
 * fill applied, per-row dedup decisions computed. No writes.
 *
 * The wizard sends this back with the same shape at Stage 6 commit
 * (plus user overrides) — the resolve step is the single source of
 * truth for what would be persisted.
 */
@Injectable()
export class ContactsResolveService {
  constructor(
    private readonly headerDetection: ContactsHeaderDetectionService,
    private readonly splitMerge: ContactsSplitMergeService,
    private readonly dedup: ContactsDedupService,
  ) {}

  /**
   * Preview a single sheet. The wizard drives multi-sheet workbooks by
   * calling this per selected sheet and stitching the summaries.
   */
  async previewSheet(input: PreviewSheetInput): Promise<SheetPreview> {
    const { sheet, mapping, headerRowIndex } = input;
    if (!sheet) throw new BadRequestException('sheet is required');
    if (!mapping || Object.keys(mapping).length === 0) {
      throw new BadRequestException('mapping is empty — set at least one column');
    }
    validateMapping(mapping);

    // ── Build header-keyed rows from the raw 2D array ──────────────
    const headerIdx = headerRowIndex ?? findHeaderIndexFromGrade(sheet, mapping);
    const headerCells: string[] = (sheet.rows[headerIdx] ?? []).map((c) => (c ?? '').trim());
    const { records: dataRows, excelRowIndexes } = sheetToRecords(sheet.rows, headerIdx, headerCells);

    // Fail-fast: every mapped header must actually exist in the sheet.
    // QA4 R2 IMP-8 — a field may map to a list of headers; each header
    // in the list is validated independently.
    const headerSet = new Set(headerCells.filter(Boolean));
    const missing: string[] = [];
    for (const [field, value] of Object.entries(mapping)) {
      for (const header of mappingHeaders(value as string | string[] | undefined)) {
        if (!headerSet.has(header)) {
          missing.push(`${field} → "${header}"`);
        }
      }
    }
    if (missing.length > 0) {
      throw new BadRequestException(
        `Mapping references headers not present in sheet "${sheet.name}": ${missing.join(', ')}`,
      );
    }

    // ── Stage 4 — split + forward-fill ─────────────────────────────
    // Pass Excel row numbers so `sourceRowIndex` on every resolved row
    // is the actual sheet row the user would see in Excel (QA4 IMP-3).
    const resolved = this.splitMerge.resolve(dataRows, mapping, excelRowIndexes);

    // ── Stage 5 dedup preview ──────────────────────────────────────
    const decisions = await this.dedup.decide(resolved);

    return {
      sheetName: sheet.name,
      headerRowIndex: headerIdx,
      headerCells,
      dataRowCount: dataRows.length,
      mapping,
      resolvedRows: resolved,
      decisions,
      summary: summarize(resolved, decisions),
    };
  }
}

// ─── Types ─────────────────────────────────────────────────────────────

export interface PreviewSheetInput {
  sheet: ExtractedSheet;
  /** Canonical field → source-header text mapping (from Stage 3). */
  mapping: ColumnMapping;
  /** 0-based index of the header row. If omitted, we take Stage 2's best guess. */
  headerRowIndex?: number;
}

export interface SheetPreview {
  sheetName: string;
  headerRowIndex: number;
  headerCells: string[];
  dataRowCount: number;
  mapping: ColumnMapping;
  resolvedRows: ResolvedRow[];
  decisions: DedupDecision[];
  summary: PreviewSummary;
}

export interface PreviewSummary {
  totalRows: number;
  eligible: number;                 // meets minimum contract §7
  belowContract: number;            // fails §7 — dropped at commit
  orgsToCreate: number;
  orgsToLink: number;
  orgConflicts: number;
  orgsSkipped: number;
  contactsToCreate: number;
  contactsToLink: number;
  contactsSkipped: number;
  emailSplitRows: number;           // §9 visibility target
  phoneSplitRows: number;
  companyFilledRows: number;
  disciplineFilledRows: number;
  emailSplitFailedRows: number;
  phoneSplitFailedRows: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function findHeaderIndexFromGrade(sheet: ExtractedSheet, mapping: ColumnMapping): number {
  // Fallback — scan for the first row that contains ALL mapped headers.
  // QA4 R2 IMP-8 — a mapping value may be a list; flatten before the scan.
  const mappedHeaders = new Set<string>();
  for (const value of Object.values(mapping)) {
    for (const header of mappingHeaders(value as string | string[] | undefined)) {
      mappedHeaders.add(header);
    }
  }
  for (let i = 0; i < sheet.rows.length; i++) {
    const row = sheet.rows[i]?.map((c) => (c ?? '').trim());
    if (!row) continue;
    if ([...mappedHeaders].every((h) => row.includes(h))) return i;
  }
  return 0;
}

/**
 * Convert the raw 2D sheet grid into header-keyed records, dropping
 * empty rows. Returns a parallel array of 1-based Excel row numbers so
 * downstream stages can report each row's actual sheet position (QA4
 * IMP-3) — necessary because we skip blank rows and the position within
 * the returned records no longer matches the sheet.
 */
function sheetToRecords(
  rows: string[][],
  headerIdx: number,
  headerCells: string[],
): { records: Array<Record<string, string>>; excelRowIndexes: number[] } {
  const records: Array<Record<string, string>> = [];
  const excelRowIndexes: number[] = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const record: Record<string, string> = {};
    let hasAny = false;
    for (let c = 0; c < headerCells.length; c++) {
      const key = headerCells[c];
      if (!key) continue;
      const v = (row[c] ?? '').trim();
      record[key] = v;
      if (v) hasAny = true;
    }
    if (!hasAny) continue;
    records.push(record);
    // Excel is 1-based; `r` is the 0-based index into the sheet grid.
    excelRowIndexes.push(r + 1);
  }
  return { records, excelRowIndexes };
}

function validateMapping(mapping: ColumnMapping) {
  const validFields = new Set<string>(CONTACT_FIELDS);
  for (const [key, value] of Object.entries(mapping)) {
    if (!validFields.has(key as ContactField)) {
      throw new BadRequestException(
        `Unknown mapping field "${key}". Allowed: ${CONTACT_FIELDS.join(', ')}`,
      );
    }
    // QA4 R2 IMP-8 — either a single string header name or an array
    // of them. Any other shape is a bad request.
    if (value == null) continue;
    if (typeof value === 'string') continue;
    if (Array.isArray(value) && value.every((h) => typeof h === 'string')) continue;
    throw new BadRequestException(
      `mapping.${key} must be a header string or an array of header strings`,
    );
  }
}

function summarize(rows: ResolvedRow[], decisions: DedupDecision[]): PreviewSummary {
  const s: PreviewSummary = {
    totalRows: rows.length,
    eligible: 0,
    belowContract: 0,
    orgsToCreate: 0,
    orgsToLink: 0,
    orgConflicts: 0,
    orgsSkipped: 0,
    contactsToCreate: 0,
    contactsToLink: 0,
    contactsSkipped: 0,
    emailSplitRows: 0,
    phoneSplitRows: 0,
    companyFilledRows: 0,
    disciplineFilledRows: 0,
    emailSplitFailedRows: 0,
    phoneSplitFailedRows: 0,
  };
  for (const d of decisions) {
    if (d.meetsMinimumContract) s.eligible++;
    else s.belowContract++;
    if (d.org.action === 'create') s.orgsToCreate++;
    else if (d.org.action === 'link') s.orgsToLink++;
    else if (d.org.action === 'conflict') s.orgConflicts++;
    else if (d.org.action === 'skip') s.orgsSkipped++;
    if (d.contact.action === 'create') s.contactsToCreate++;
    else if (d.contact.action === 'link') s.contactsToLink++;
    else if (d.contact.action === 'skip') s.contactsSkipped++;
  }
  for (const row of rows) {
    if (row.synthesis.emailSplit) s.emailSplitRows++;
    if (row.synthesis.phoneSplit) s.phoneSplitRows++;
    if (row.synthesis.companyFilled) s.companyFilledRows++;
    if (row.synthesis.disciplineFilled) s.disciplineFilledRows++;
    if (row.synthesis.emailSplitFailed) s.emailSplitFailedRows++;
    if (row.synthesis.phoneSplitFailed) s.phoneSplitFailedRows++;
  }
  return s;
}

// Convenience re-exports so callers stay grouped.
export type { SheetGrade };
