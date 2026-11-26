/**
 * BM2-28 (QA6) · Delimited-text reader for the contacts import wizard.
 *
 * CSV used to go through SheetJS, which guesses value types: a phone
 * written as 0501234567 became the number 501234567, and a file whose
 * first cell is "ID" is taken for a SYLK file. Contact lists need every
 * cell exactly as typed, so CSV / TSV / semicolon files are parsed here:
 * RFC 4180 quoting, `sep=;` hint line (Excel), delimiter guessed from the
 * first lines, every cell kept as text.
 */

import { CellBudget, SheetMeter } from './import-limits';

const DELIMITERS = [',', ';', '\t', '|'] as const;

/** Count delimiter characters outside double quotes in the first lines. */
function guessDelimiter(text: string): string {
  const sample = text.slice(0, 16 * 1024);
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  let lines = 0;
  for (let i = 0; i < sample.length && lines < 20; i++) {
    const ch = sample[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === '\n') {
      lines++;
      continue;
    }
    if (counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const n = counts.get(d) ?? 0;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Parse delimited text into rows of string cells. Fully empty rows are
 * dropped, rows are padded to the widest row, and trailing columns that
 * are empty in every row are removed.
 *
 * Review 2 (B1) · The rows are metered against the file's cell budget as
 * they are built (rows, columns to the last value, padded area), and the
 * parse stops with a clear rejection once it is exceeded. Empty cells are
 * only counted, and stored when a value follows them in the same row, so
 * a row of a million delimiters costs nothing and a value past column
 * 200 is refused before the row is built.
 */
export function parseDelimitedText(input: string, meter: SheetMeter = new CellBudget().meter('Sheet1')): string[][] {
  let text = input.replace(/^﻿/, '');
  let delimiter: string;
  const hint = text.match(/^sep=(.)\r?\n/i);
  if (hint) {
    delimiter = hint[1];
    text = text.slice(hint[0].length);
  } else {
    delimiter = guessDelimiter(text);
  }

  const rows: string[][] = [];
  let width = 0;
  let row: string[] = [];
  let pendingEmpty = 0;
  let cell = '';
  let inQuotes = false;
  let atCellStart = true;

  const endCell = () => {
    const value = cell.trim();
    cell = '';
    atCellStart = true;
    if (value === '') {
      pendingEmpty++;
      return;
    }
    meter.widen(row.length + pendingEmpty + 1);
    for (; pendingEmpty > 0; pendingEmpty--) row.push('');
    row.push(value);
  };
  const endRow = () => {
    endCell();
    pendingEmpty = 0;
    if (row.length > 0) {
      meter.addRow(row.length);
      if (row.length > width) width = row.length;
      rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && atCellStart) {
      inQuotes = true;
      atCellStart = false;
      continue;
    }
    if (ch === delimiter) {
      endCell();
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
      continue;
    }
    if (ch === '\n') {
      endRow();
      continue;
    }
    cell += ch;
    atCellStart = false;
  }
  if (cell !== '' || row.length > 0) endRow();
  meter.close();

  for (const r of rows) {
    while (r.length < width) r.push('');
  }
  return rows;
}
