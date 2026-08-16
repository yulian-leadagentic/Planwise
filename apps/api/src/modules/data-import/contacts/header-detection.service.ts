import { Injectable } from '@nestjs/common';

import { ExtractedSheet } from './triage.service';
import {
  ContactField,
  CONTACT_FIELDS,
  matchHeaderToField,
  normalizeHeader,
  scoreHeaderRow,
} from './header-dictionary';

/**
 * BM2 · Contacts import · Stage 2 — Per-sheet header detection.
 *
 * §3-Stage-2 of the methodology: scan each sheet's first ~12 rows, score
 * every row against the §4 header dictionary, and pick the best-scoring
 * row as the header. Banner rows (project name, edit date, logo image
 * alt-text, all-caps section titles, all-empty rows) are skipped
 * because the dictionary doesn't match them.
 *
 * A **workbook is graded sheet-by-sheet** (21 of the real xlsx files
 * are multi-sheet) — one poor sheet doesn't disqualify the others.
 * The minimum confident header row scores ≥ 2 canonical fields
 * (methodology §3: "The best row with score ≥ 2 is the header").
 *
 * When no row scores ≥ 2 the sheet is not flagged with a stack trace;
 * it's downgraded to `headerless` with a suggested email-only lane
 * (14 files in the real set fall into this bucket) OR marked
 * `non-contact` when the content looks structurally unrelated (8
 * files — an elevations table mislabeled `-Contacts`).
 */
@Injectable()
export class ContactsHeaderDetectionService {
  /**
   * Grade every sheet in a triage result. Returns one entry per sheet
   * with the winning header row (if any), the auto-suggested column
   * mapping derived from that row, and a `verdict` for the UI:
   *
   *   'auto'         → header ≥ 2 dictionary hits, ready for auto-map
   *                    (§9 target: ≥70% of real files fall here)
   *   'manual'       → header found but too weak to auto-commit — user
   *                    must confirm mapping (typically 1 hit; e.g. a
   *                    sheet with only "email" mapped)
   *   'headerless'   → no header row found; email column extractable
   *                    → email-only import lane (14 files in the set)
   *   'non-contact'  → opened fine but no contact-shaped columns at
   *                    all — nothing to import (e.g. an elevations
   *                    sheet mislabeled `-Contacts`)
   */
  grade(sheets: ExtractedSheet[]): SheetGrade[] {
    return sheets.map((sheet) => this.gradeSheet(sheet));
  }

  private gradeSheet(sheet: ExtractedSheet): SheetGrade {
    const rows = sheet.rows;

    // Truly empty sheet — surface a clean reject reason instead of
    // returning an empty header row.
    if (rows.length === 0) {
      return {
        sheetName: sheet.name,
        verdict: 'non-contact',
        reason: 'the sheet is empty',
        headerRowIndex: null,
        headerCells: [],
        mapping: {},
        confidence: 0,
        totalCandidateRows: 0,
        dataRowCount: 0,
        headerMatchedFieldCount: 0,
      };
    }

    // Scan the first ~12 rows for header candidates. Real spreadsheets
    // in the sample fold a title / project / date banner at the top —
    // the winning row is almost always in rows 1-6, but the methodology
    // gives us slack for weird layouts.
    const HEADER_SCAN_LIMIT = 12;
    const scanLimit = Math.min(rows.length, HEADER_SCAN_LIMIT);
    let best: {
      idx: number;
      score: number;
      matched: Map<number, ContactField>;
    } | null = null;

    for (let i = 0; i < scanLimit; i++) {
      const row = rows[i];
      if (!row || row.every((c) => !c || !c.trim())) continue;
      if (isBannerRow(row)) continue;
      const { score, matched } = scoreHeaderRow(row);
      if (!best || score > best.score) {
        best = { idx: i, score, matched };
      }
    }

    const dataRowCount = best ? countDataRows(rows, best.idx) : 0;

    // ─── No dictionary hit anywhere in the header scan window ──────
    if (!best || best.score === 0) {
      // Fallback — look for an email-shaped column anywhere in the
      // sheet body. Catches the "bare email list" case (§1 headerless
      // lane, 14 files).
      const emailColIdx = findEmailColumnInBody(rows);
      if (emailColIdx !== null) {
        const cells: string[] = (rows[0] ?? []).map((c) => c ?? '');
        // Synthesize a header for the mapping — we already know the
        // column, so use a stable label.
        const headerCells = cells.length > emailColIdx
          ? cells
          : Array.from({ length: emailColIdx + 1 }, (_, i) => cells[i] ?? '');
        headerCells[emailColIdx] = headerCells[emailColIdx] || 'email';
        return {
          sheetName: sheet.name,
          verdict: 'headerless',
          reason: 'no header row detected — treating as email-only list',
          headerRowIndex: null,
          headerCells,
          mapping: { email: emailColIdx },
          confidence: 0.3,
          totalCandidateRows: scanLimit,
          dataRowCount: rows.length,
          headerMatchedFieldCount: 1,
        };
      }
      return {
        sheetName: sheet.name,
        verdict: 'non-contact',
        reason: 'no contact-shaped columns found — this sheet does not look like a contact list',
        headerRowIndex: null,
        headerCells: rows[0] ?? [],
        mapping: {},
        confidence: 0,
        totalCandidateRows: scanLimit,
        dataRowCount: rows.length,
        headerMatchedFieldCount: 0,
      };
    }

    // ─── Weak header — one dictionary hit ────────────────────────────
    // §3-Stage-2 sets the auto threshold at 2. A single hit still counts
    // as "found a header" but needs user confirmation.
    if (best.score < 2) {
      return {
        sheetName: sheet.name,
        verdict: 'manual',
        reason: `only ${best.score} column matched a known contact field — confirm the mapping before continuing`,
        headerRowIndex: best.idx,
        headerCells: rows[best.idx] ?? [],
        mapping: mapFromMatched(best.matched),
        confidence: 0.5,
        totalCandidateRows: scanLimit,
        dataRowCount,
        headerMatchedFieldCount: best.score,
      };
    }

    // ─── Auto — score ≥ 2 canonical fields ────────────────────────────
    // Confidence is 0.6 + 0.05 per additional field beyond the 2-field
    // floor, capped at 1.0. A 6-field header scores 0.8; a Google
    // Contacts export (14+ fields matched) hits 1.0.
    const confidence = Math.min(1, 0.6 + 0.05 * Math.max(0, best.score - 2));

    return {
      sheetName: sheet.name,
      verdict: 'auto',
      reason: `header row detected at row ${best.idx + 1} (${best.score} canonical fields matched)`,
      headerRowIndex: best.idx,
      headerCells: rows[best.idx] ?? [],
      mapping: mapFromMatched(best.matched),
      confidence,
      totalCandidateRows: scanLimit,
      dataRowCount,
      headerMatchedFieldCount: best.score,
    };
  }
}

// ─── Types ─────────────────────────────────────────────────────────────

export type SheetVerdict = 'auto' | 'manual' | 'headerless' | 'non-contact';

export interface SheetGrade {
  sheetName: string;
  verdict: SheetVerdict;
  reason: string;
  /** 0-based row index in the sheet where the header was found; null if none. */
  headerRowIndex: number | null;
  /** The header row's cell contents (or the sheet's first row if no header). */
  headerCells: string[];
  /**
   * Auto-suggested column mapping. Keyed by canonical field, valued by
   * the 0-based column index in the sheet. The user may override in
   * Stage 3.
   */
  mapping: Partial<Record<ContactField, number>>;
  /** 0..1 — Stage 2 confidence; feeds Stage 5's "0-click eligible" marker. */
  confidence: number;
  totalCandidateRows: number;
  dataRowCount: number;
  headerMatchedFieldCount: number;
}

// ─── Row shape heuristics ──────────────────────────────────────────────

/**
 * Banner rows are the top-of-sheet title lines that survive Excel's
 * "merge cells" reformatting. Symptoms:
 *   • only one non-empty cell in the row (a title spanning merged cells)
 *   • all uppercase (Latin) OR looks like a project code like "190039"
 *   • no dictionary hit and no dictionary-adjacent shape
 * Skip rules kick in BEFORE scoring so a "PROJECT #190039" line doesn't
 * poison the header pick.
 */
function isBannerRow(row: readonly string[]): boolean {
  const nonEmpty = row.filter((c) => c && c.trim());
  if (nonEmpty.length === 0) return true;
  if (nonEmpty.length === 1) {
    // One-cell rows are almost always merged banners. Only NOT a banner
    // if that lone cell matches a known field header — but a one-column
    // sheet is exotic; err on skip.
    const only = nonEmpty[0].trim();
    return matchHeaderToField(only) === null;
  }
  // Rows with 2-3 short cells that look like "Project:" "190039" are
  // banners too. Header rows have several short label-shaped cells
  // that DON'T match a field.
  //
  // We only skip if EVERY non-empty cell is clearly not a header
  // candidate AND at least one cell looks like meta-label (ends in :
  // or is a bare number/date).
  const looksMeta = nonEmpty.every((c) => {
    const t = c.trim();
    if (matchHeaderToField(t)) return false;
    return t.endsWith(':') || /^\d{4,}$/.test(t) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t);
  });
  return looksMeta;
}

/**
 * Given the winning matched-col → field map, produce a
 * field → colIndex mapping. If two source columns matched the same
 * field, the first-wins (preserves the leftmost "email" column when
 * "e-mail 1 - value" + "e-mail 2 - value" both hit).
 */
function mapFromMatched(matched: Map<number, ContactField>): Partial<Record<ContactField, number>> {
  const out: Partial<Record<ContactField, number>> = {};
  // Iterate in column order (map insertion order = column left→right)
  for (const [col, field] of matched) {
    if (out[field] == null) out[field] = col;
  }
  return out;
}

/** Simple email regex — used by the headerless-fallback column scan.
 *  The strict grammar-validated splitter lives in Stage 4. */
const EMAIL_LIKE = /^[\w.+-]+@[\w-]+\.[a-z]{2,}$/i;

/**
 * When no header scored ≥ 1 dictionary hit, look for a column that is
 * majority email addresses. Real "bare email list" sheets in the
 * dataset have one column of addresses and nothing else.
 */
function findEmailColumnInBody(rows: readonly (readonly string[])[]): number | null {
  if (rows.length === 0) return null;
  const width = Math.max(...rows.map((r) => r.length));
  const perColHits: number[] = new Array(width).fill(0);
  const perColTotal: number[] = new Array(width).fill(0);
  const sampleLimit = Math.min(rows.length, 200);
  for (let r = 0; r < sampleLimit; r++) {
    const row = rows[r] ?? [];
    for (let c = 0; c < width; c++) {
      const v = row[c]?.trim();
      if (!v) continue;
      perColTotal[c]++;
      if (EMAIL_LIKE.test(v)) perColHits[c]++;
    }
  }
  let bestCol = -1;
  let bestRatio = 0;
  for (let c = 0; c < width; c++) {
    if (perColTotal[c] < 3) continue; // need at least a handful of samples
    const ratio = perColHits[c] / perColTotal[c];
    if (ratio >= 0.5 && ratio > bestRatio) {
      bestRatio = ratio;
      bestCol = c;
    }
  }
  return bestCol >= 0 ? bestCol : null;
}

function countDataRows(rows: readonly (readonly string[])[], headerIdx: number): number {
  let count = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row && row.some((c) => c && c.trim())) count++;
  }
  return count;
}

// Re-export for callers that only import from this file.
export { CONTACT_FIELDS };
export type { ContactField };
