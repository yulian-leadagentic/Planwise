import { Injectable, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import ExcelJS from 'exceljs';

/**
 * Maximum rows we accept per upload. Anything bigger should be split or
 * imported in batches; we don't want a single HTTP request holding the
 * worker for minutes (and risking memory pressure). The wizard surfaces
 * this number in the UI so the user knows up front.
 */
export const MAX_IMPORT_ROWS = 10_000;

/** Max file size (bytes). 5 MB is generous for ~10k structured rows. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export interface ParsedSheet {
  /** Headers exactly as they appeared in row 1 (after trim). */
  headers: string[];
  /** Data rows. Each row is keyed by header text. Missing cells = ''. */
  rows: Array<Record<string, string>>;
  /** SHA-256 of the original file bytes — used to detect duplicate uploads. */
  fileHash: string;
}

@Injectable()
export class ExcelParserService {
  /**
   * Parse the FIRST worksheet of an .xlsx file into a header + rows
   * structure. Cells are stringified (numbers become "123", dates become
   * ISO date strings) so importers can apply their own field-level
   * parsing rules — keeps this service entity-agnostic.
   *
   * Throws BadRequestException on any structural problem (wrong format,
   * no rows, missing headers, oversized file). The caller doesn't have
   * to do its own up-front checks.
   */
  async parse(buffer: Buffer): Promise<ParsedSheet> {
    if (buffer.length === 0) {
      throw new BadRequestException('Uploaded file is empty.');
    }
    if (buffer.length > MAX_IMPORT_BYTES) {
      throw new BadRequestException(
        `File is larger than ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB. Split into smaller batches.`,
      );
    }

    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as any);
    } catch (e: any) {
      throw new BadRequestException('Could not read the file. Make sure it is a valid .xlsx workbook.');
    }

    const sheet = wb.worksheets[0];
    if (!sheet || sheet.rowCount === 0) {
      throw new BadRequestException('The workbook has no sheets or the first sheet is empty.');
    }

    // Read header row (row 1) as strings — strip outer whitespace so a
    // template header "Email " (trailing space) matches "Email".
    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: false }, (cell) => {
      const v = cellToString(cell.value);
      if (v) headers.push(v.trim());
    });

    if (headers.length === 0) {
      throw new BadRequestException('The first row of the sheet must contain column headers.');
    }
    const dupHeader = findDuplicate(headers);
    if (dupHeader) {
      throw new BadRequestException(`Duplicate header in the file: "${dupHeader}". Each column must have a unique name.`);
    }

    // Read body rows. We iterate every row index from 2..rowCount so we
    // don't lose rows with leading empty cells (eachRow skips fully-empty
    // rows but a row with only the first cell empty is still data).
    const rows: Array<Record<string, string>> = [];
    for (let rIdx = 2; rIdx <= sheet.rowCount; rIdx++) {
      const row = sheet.getRow(rIdx);
      const record: Record<string, string> = {};
      let hasAny = false;
      headers.forEach((h, hIdx) => {
        const cell = row.getCell(hIdx + 1);
        const val = cellToString(cell.value).trim();
        record[h] = val;
        if (val) hasAny = true;
      });
      // Skip rows that are fully empty (common in user spreadsheets)
      if (!hasAny) continue;
      rows.push(record);

      if (rows.length > MAX_IMPORT_ROWS) {
        throw new BadRequestException(
          `File has more than ${MAX_IMPORT_ROWS} data rows. Split into smaller batches.`,
        );
      }
    }

    if (rows.length === 0) {
      throw new BadRequestException('The file has headers but no data rows.');
    }

    return { headers, rows, fileHash };
  }
}

/**
 * Normalize an Excel cell value into a string. ExcelJS returns numbers,
 * Dates, hyperlink objects, rich-text, etc. — we want a single canonical
 * string the importers can validate against. Empty/null becomes ''.
 */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) {
    // ISO date (YYYY-MM-DD) — date-only fields don't need the time portion
    return value.toISOString().split('T')[0];
  }
  if (typeof value === 'object') {
    const obj = value as any;
    // Hyperlink: { text, hyperlink }
    if (typeof obj.text === 'string') return obj.text;
    // Rich text: { richText: [{ text }] }
    if (Array.isArray(obj.richText)) {
      return obj.richText.map((r: any) => r.text ?? '').join('');
    }
    // Formula: { result, formula }
    if ('result' in obj) return cellToString(obj.result);
  }
  return String(value);
}

function findDuplicate(arr: string[]): string | null {
  const seen = new Set<string>();
  for (const x of arr) {
    const k = x.toLowerCase();
    if (seen.has(k)) return x;
    seen.add(k);
  }
  return null;
}
