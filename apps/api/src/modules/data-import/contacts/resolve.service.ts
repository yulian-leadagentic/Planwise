import { BadRequestException, Injectable } from '@nestjs/common';

import { ContactsHeaderDetectionService, SheetGrade } from './header-detection.service';
import { CONTACT_FIELDS, ContactField } from './header-dictionary';
import { ContactsSplitMergeService, ColumnMapping, ResolvedRow } from './split-merge.service';
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
    const dataRows = sheetToRecords(sheet.rows, headerIdx, headerCells);

    // Fail-fast: every mapped header must actually exist in the sheet.
    const missing = Object.entries(mapping)
      .filter(([, header]) => header && !headerCells.some((h) => h === header))
      .map(([field, header]) => `${field} → "${header}"`);
    if (missing.length > 0) {
      throw new BadRequestException(
        `Mapping references headers not present in sheet "${sheet.name}": ${missing.join(', ')}`,
      );
    }

    // ── Stage 4 — split + forward-fill ─────────────────────────────
    const resolved = this.splitMerge.resolve(dataRows, mapping);

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
  const mappedHeaders = new Set(Object.values(mapping).filter(Boolean) as string[]);
  for (let i = 0; i < sheet.rows.length; i++) {
    const row = sheet.rows[i]?.map((c) => (c ?? '').trim());
    if (!row) continue;
    if ([...mappedHeaders].every((h) => row.includes(h))) return i;
  }
  return 0;
}

function sheetToRecords(
  rows: string[][],
  headerIdx: number,
  headerCells: string[],
): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
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
    out.push(record);
  }
  return out;
}

function validateMapping(mapping: ColumnMapping) {
  const validFields = new Set<string>(CONTACT_FIELDS);
  for (const [key, value] of Object.entries(mapping)) {
    if (!validFields.has(key as ContactField)) {
      throw new BadRequestException(
        `Unknown mapping field "${key}". Allowed: ${CONTACT_FIELDS.join(', ')}`,
      );
    }
    if (value != null && typeof value !== 'string') {
      throw new BadRequestException(`mapping.${key} must be a string header name`);
    }
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
