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
 */
export function parseDelimitedText(input: string): string[][] {
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
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let atCellStart = true;

  const endCell = () => {
    row.push(cell);
    cell = '';
    atCellStart = true;
  };
  const endRow = () => {
    endCell();
    rows.push(row);
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

  const kept = rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ''));
  let width = 0;
  for (const r of kept) {
    for (let c = r.length - 1; c >= 0; c--) {
      if (r[c] !== '') {
        if (c + 1 > width) width = c + 1;
        break;
      }
    }
  }
  return kept.map((r) => {
    const out = r.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });
}
