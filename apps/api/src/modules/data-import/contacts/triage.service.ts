import { Injectable, Logger } from '@nestjs/common';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
// pdf-parse ships CommonJS; require-style import avoids the ESM interop
// pothole where `import pdf from 'pdf-parse'` resolves to undefined at
// runtime under swc's transpiler.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse: (buf: Buffer) => Promise<{ text: string; numpages: number }> =
  require('pdf-parse');

/**
 * BM2 · Contacts import · Stage 1 — Triage + tolerant readers.
 *
 * The client's real "before-processing" folder has 246 files nominally
 * spreadsheets, of which 27 lie about their extension (per §1 of
 * `docs/bm2/bp-import-methodology.md`): renamed .xls, images renamed
 * .xlsx, draw.io diagrams, HTML tables. The single upload path must
 * therefore be defensive about the true file type — sniff the magic
 * bytes, never trust the extension, and route each real type to a
 * reader that handles it in-process. New clients keep sending the
 * same mix forever, so this is a permanent product capability, NOT a
 * one-time script (§3-Stage-1, §8).
 *
 * Accept path — extraction happens here, downstream stages consume rows:
 *   • xlsx / xls / csv / html-mislabeled-as-xlsx → SheetJS `xlsx`. It
 *     natively reads legacy .xls (OLE2), modern .xlsx, csv, and HTML
 *     tables saved as .xlsx — no LibreOffice, no external converter.
 *   • docx (Word tables) → `mammoth` extracts the doc's tables; each
 *     table becomes one "sheet" so header detection can run against it.
 *   • pdf → `pdf-parse` best-effort text-layer + a Hebrew RTL reversal
 *     pass. Comes back with a low `confidence`; Stage 5 forces these
 *     into the manual/conflict lane rather than silently trusting.
 *
 * Reject path — surfaced with a human-readable reason (§9 target,
 * "triage never shows a stack trace"):
 *   • Images (PNG/JPEG/GIF/TIFF) → "file is an image, not a contact sheet"
 *   • draw.io / vsdx → "diagram, not tabular data"
 *   • Unknown binary → "could not identify file type"
 *
 * The service is intentionally stateless; DataImportModule provides one
 * shared instance and reuses it across every uploaded file.
 */
@Injectable()
export class ContactsTriageService {
  private readonly logger = new Logger(ContactsTriageService.name);

  /** Entry point — sniff and dispatch. */
  async triage(
    buffer: Buffer,
    filename?: string,
  ): Promise<TriageResult> {
    if (!buffer || buffer.length === 0) {
      return reject('the uploaded file is empty (0 bytes)');
    }

    const sig = sniffMagicBytes(buffer);

    // ─── Reject — true non-data ──────────────────────────────────────
    if (sig === 'png' || sig === 'jpeg' || sig === 'gif' || sig === 'tiff' || sig === 'bmp') {
      return reject(
        `this file is an image (${sig.toUpperCase()}), not a contact sheet — check the filename or ask for the original spreadsheet`,
      );
    }
    if (sig === 'drawio') {
      return reject(
        'this file is a draw.io diagram (mxfile), not a contact sheet — export the underlying data as .xlsx / .csv',
      );
    }
    if (sig === 'exe' || sig === 'elf' || sig === 'macho') {
      return reject('this file looks like an executable, not a spreadsheet');
    }
    if (sig === 'zip-other') {
      // A ZIP that is neither Office (.xlsx/.docx) nor known Office-XML —
      // e.g. a bare .zip of files, a keynote/pages doc, etc.
      return reject('this is a generic ZIP archive; extract the contact spreadsheet inside first');
    }

    // ─── Accept — dispatch to a tolerant reader ─────────────────────
    try {
      if (sig === 'xlsx' || sig === 'ole2' || sig === 'html' || sig === 'xml' || sig === 'csv') {
        return await this.readTabular(buffer, sig, filename);
      }
      if (sig === 'docx') {
        return await this.readDocx(buffer, filename);
      }
      if (sig === 'pdf') {
        return await this.readPdf(buffer, filename);
      }
      // Very small or unknown-magic files — last-chance CSV attempt.
      if (looksLikeText(buffer)) {
        return await this.readTabular(buffer, 'csv', filename);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`triage read failed (${sig}): ${message}`);
      return reject(
        `could not read this file as a spreadsheet — ${humanizeReaderError(message)}`,
      );
    }

    return reject('could not identify this file type — expected .xlsx, .xls, .csv, .docx, or .pdf');
  }

  // ─── Readers ────────────────────────────────────────────────────────

  /**
   * Tabular reader — handles xlsx, legacy xls (OLE2), csv, and HTML-as-xlsx
   * in one shot via SheetJS. Every sheet returns a 2D string array
   * (`rows[r][c]`); numbers/dates are stringified so downstream Stage 2
   * header detection can score cells against the header dictionary.
   *
   * Note on `raw: false`: SheetJS formats dates + numbers by cell type
   * rather than returning JS Date objects. This preserves what the human
   * saw in Excel (e.g. "2026-03-05" instead of a numeric serial 46091)
   * and keeps everything as string, which is what Stage 2/4 want.
   */
  private async readTabular(
    buffer: Buffer,
    sig: TabularSig,
    filename?: string,
  ): Promise<TriageResult> {
    // For pure CSV, cellText: '' avoids SheetJS turning empty cells
    // into `undefined` — Stage 2 wants a consistent shape.
    const wb = XLSX.read(buffer, {
      type: 'buffer',
      cellDates: false,
      cellText: false,
      raw: false,
      // codepage 1255 = Hebrew CP-1255; falls back cleanly for non-Hebrew.
      codepage: 65001,
    });
    if (!wb.SheetNames || wb.SheetNames.length === 0) {
      return reject('the file opened but contains no worksheets');
    }
    const sheets: ExtractedSheet[] = wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      // sheet_to_json with header:1 gives a 2D array (rows of cells).
      // defval:'' keeps empty cells as '', which matters for
      // forward-fill (Stage 4) — we want to know a cell is blank vs
      // missing entirely.
      const rows = XLSX.utils.sheet_to_json<string[]>(ws, {
        header: 1,
        defval: '',
        raw: false,
        blankrows: false,
      });
      // Coerce every cell to string. SheetJS with raw:false already
      // gives strings for numbers/dates via formatting, but boolean +
      // undefined edge cases slip through.
      const stringRows = rows.map((row) =>
        (row ?? []).map((c) => (c == null ? '' : String(c))),
      );
      return { name, rows: stringRows };
    });
    return {
      kind: 'tabular',
      reader: readerLabel(sig),
      filename,
      sheets,
    };
  }

  /**
   * DOCX reader — extract every table in the doc. `mammoth` converts to
   * a simplified HTML which we parse with a small regex-based extractor.
   * Each table becomes one "sheet" so downstream stages treat it exactly
   * like a spreadsheet tab.
   */
  private async readDocx(buffer: Buffer, filename?: string): Promise<TriageResult> {
    const result = await mammoth.convertToHtml({ buffer });
    const tables = extractHtmlTables(result.value);
    if (tables.length === 0) {
      // No tables → surface as a triage-level reject with a specific reason
      // (Stage 5 can still show the plain text if we ever wire it, but
      // for now the wizard is table-shaped).
      return reject(
        'this Word document contains no tables — the wizard cannot extract contacts from plain paragraphs (send an .xlsx or paste into one)',
      );
    }
    return {
      kind: 'docx-tables',
      filename,
      reader: 'docx',
      sheets: tables.map((rows, i) => ({ name: `Table ${i + 1}`, rows })),
    };
  }

  /**
   * PDF reader — best-effort text extraction. Hebrew RTL runs come back
   * in visual order (i.e. reversed) from pdf-parse; we detect Hebrew
   * lines and reverse their characters/tokens so downstream searchers
   * see the logical order.
   *
   * We don't try to reconstruct the table structure from PDF geometry
   * — the confidence score reflects that. The extracted lines get
   * exposed as a single-sheet 1-column grid; Stage 5 (per §3 of the
   * methodology) routes low-confidence PDFs to the manual/conflict
   * lane rather than the auto-map path.
   */
  private async readPdf(buffer: Buffer, filename?: string): Promise<TriageResult> {
    const parsed = await pdfParse(buffer);
    const rawLines = (parsed.text || '').split(/\r?\n/);
    // Reverse Hebrew RTL characters per line so email tokens are
    // recognizable to Stage 4's validators. Non-Hebrew lines are left
    // as-is.
    const fixedLines = rawLines.map(reverseHebrewInLine);

    // Confidence proxy — number of email-shaped tokens + number of
    // multi-word lines. Anything below 5 emails ends up manual.
    const emailHits = fixedLines
      .join('\n')
      .match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi);
    const confidence = Math.min(1, (emailHits?.length ?? 0) / 20);

    return {
      kind: 'pdf',
      filename,
      reader: 'pdf',
      confidence,
      pages: parsed.numpages ?? 0,
      // Expose the extracted lines as a single-sheet, single-column
      // grid so Stage 2's per-sheet loop can still run. Real column
      // splitting for PDFs is a v2 problem.
      sheets: [{ name: 'PDF Extract', rows: fixedLines.map((l) => [l]) }],
    };
  }
}

// ─── Types ─────────────────────────────────────────────────────────────

export type TabularReader = 'xlsx' | 'xls' | 'csv' | 'html-xlsx';

export interface ExtractedSheet {
  /** Sheet / table name — surfaced to the user in header-picker fallback. */
  name: string;
  /** rows[r][c] — cell text, empty string for blank cells. */
  rows: string[][];
}

export type TriageResult =
  | {
      kind: 'tabular';
      reader: TabularReader;
      filename?: string;
      sheets: ExtractedSheet[];
    }
  | {
      kind: 'docx-tables';
      reader: 'docx';
      filename?: string;
      sheets: ExtractedSheet[];
    }
  | {
      kind: 'pdf';
      reader: 'pdf';
      filename?: string;
      /** 0..1 — how much we trust the extraction. Low = route to manual. */
      confidence: number;
      pages: number;
      sheets: ExtractedSheet[];
    }
  | {
      kind: 'reject';
      reason: string;
    };

// ─── Magic-byte sniffer ────────────────────────────────────────────────

type Sig =
  | 'xlsx'      // ZIP + `xl/` entry → real xlsx
  | 'docx'      // ZIP + `word/` entry → real docx
  | 'zip-other' // ZIP but not Office → generic archive
  | 'ole2'      // legacy Office binary (.xls, .doc, .msi, .xps, …)
  | 'html'      // HTML/XHTML doc mislabeled as xlsx
  | 'xml'       // XML (spreadsheetML, drawio has its own branch)
  | 'drawio'    // <mxfile> diagram
  | 'csv'       // heuristic — text with delimiters
  | 'pdf'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'tiff'
  | 'bmp'
  | 'exe'
  | 'elf'
  | 'macho'
  | 'unknown';

type TabularSig = 'xlsx' | 'ole2' | 'html' | 'xml' | 'csv';

/**
 * Inspect the first ~4KB of the buffer and classify by real type.
 * Deliberate order: images and diagrams before ambiguous text so a PNG
 * renamed .xlsx doesn't slip through as "unknown".
 */
export function sniffMagicBytes(buffer: Buffer): Sig {
  if (buffer.length < 4) return 'unknown';

  // ── Image formats ─────────────────────────────────────────────────
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif';
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
  ) return 'tiff';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';

  // ── Executables (rare but surfaces if someone drops a wrong file) ──
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) return 'exe';
  if (
    buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46
  ) return 'elf';
  if (
    (buffer[0] === 0xfe && buffer[1] === 0xed && buffer[2] === 0xfa && (buffer[3] === 0xce || buffer[3] === 0xcf)) ||
    (buffer[0] === 0xcf && buffer[1] === 0xfa && buffer[2] === 0xed && buffer[3] === 0xfe)
  ) return 'macho';

  // ── PDF ───────────────────────────────────────────────────────────
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'pdf';

  // ── OLE2 compound (legacy Office: .xls, .doc, .ppt binary) ────────
  if (
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 &&
    buffer[5] === 0xb1 &&
    buffer[6] === 0x1a &&
    buffer[7] === 0xe1
  ) {
    return 'ole2';
  }

  // ── ZIP (real xlsx/docx are ZIPs; also plain .zip archives) ───────
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)) {
    // Peek inside: xlsx has 'xl/' path early, docx has 'word/'. The
    // central-directory scan is expensive; a substring probe over
    // the first ~16 KB is enough (Office layouts put those entries
    // near the head).
    const head = buffer.slice(0, Math.min(buffer.length, 16 * 1024)).toString('binary');
    if (head.includes('xl/') || head.includes('[Content_Types].xml') && head.includes('Workbook')) return 'xlsx';
    if (head.includes('word/')) return 'docx';
    // Any Office pkg has [Content_Types].xml; final disambiguation by
    // an early known part name — otherwise treat as generic zip.
    if (head.includes('[Content_Types].xml')) {
      if (head.includes('workbook.xml')) return 'xlsx';
      if (head.includes('document.xml')) return 'docx';
    }
    return 'zip-other';
  }

  // ── Text-like — HTML/XML/drawio/CSV ───────────────────────────────
  // Read a preview slice and detect. UTF-8 BOM (EF BB BF) at the head
  // is common on Windows-generated CSVs.
  const bomOffset = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  const previewLen = Math.min(buffer.length - bomOffset, 4096);
  const preview = buffer.slice(bomOffset, bomOffset + previewLen).toString('utf8');
  const trimmed = preview.trimStart();

  if (/^<\?xml[\s>]/i.test(trimmed)) {
    // draw.io: <?xml ...?><mxfile ...>
    if (/<mxfile[\s>]/i.test(trimmed)) return 'drawio';
    // Excel 2003 XML SpreadsheetML: <?xml ...?><?mso-application progid="Excel.Sheet"?><Workbook>
    if (/mso-application/i.test(trimmed) || /<Workbook[\s>]/i.test(trimmed)) return 'html'; // SheetJS reads it via 'html' path
    return 'xml';
  }
  if (/^<mxfile[\s>]/i.test(trimmed)) return 'drawio';
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed) || /^<table[\s>]/i.test(trimmed)) return 'html';

  // CSV heuristic — printable text with commas/semicolons/tabs and
  // at least one newline in the preview.
  if (looksLikeCsv(preview)) return 'csv';

  return 'unknown';
}

function looksLikeText(buffer: Buffer): boolean {
  const preview = buffer.slice(0, Math.min(buffer.length, 2048)).toString('utf8');
  // Reject if too many low-control bytes or a null byte early on.
  let printable = 0;
  for (let i = 0; i < preview.length; i++) {
    const code = preview.charCodeAt(i);
    if (code === 0) return false;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 0xfffd)) printable++;
  }
  return printable / Math.max(1, preview.length) > 0.9;
}

function looksLikeCsv(preview: string): boolean {
  if (!preview.includes('\n')) return false;
  const line = preview.split(/\r?\n/, 1)[0] ?? '';
  const commas = (line.match(/,/g) ?? []).length;
  const semis = (line.match(/;/g) ?? []).length;
  const tabs = (line.match(/\t/g) ?? []).length;
  return commas + semis + tabs >= 1;
}

function readerLabel(sig: TabularSig): TabularReader {
  if (sig === 'xlsx') return 'xlsx';
  if (sig === 'ole2') return 'xls';
  if (sig === 'csv') return 'csv';
  return 'html-xlsx';
}

// ─── Reject helper ─────────────────────────────────────────────────────

function reject(reason: string): TriageResult {
  return { kind: 'reject', reason };
}

/**
 * Translate a low-level reader error to something the user can act on.
 * We never surface a stack trace / library error message directly.
 */
function humanizeReaderError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes('bad magic') || s.includes('not a zip') || s.includes('invalid zip')) {
    return 'the file bytes do not match its extension';
  }
  if (s.includes('corrupt') || s.includes('malformed')) {
    return 'the file appears to be corrupt';
  }
  if (s.includes('password') || s.includes('encrypted')) {
    return 'the file is password-protected; remove the password and re-upload';
  }
  return 'the file could not be parsed';
}

// ─── DOCX helpers ─────────────────────────────────────────────────────

/**
 * Extract simple table structure from mammoth's HTML output. mammoth's
 * default HTML is a subset (no attributes on tables/tr/td), so a
 * lightweight regex walker is sufficient — we don't need a full DOM.
 */
function extractHtmlTables(html: string): string[][][] {
  const tables: string[][][] = [];
  const tableRe = /<table[\s>][\s\S]*?<\/table>/gi;
  const rowRe = /<tr[\s>][\s\S]*?<\/tr>/gi;
  const cellRe = /<t[dh][\s>]([\s\S]*?)<\/t[dh]>/gi;
  const tagRe = /<[^>]+>/g;
  const wsRe = /\s+/g;

  const tableMatches = html.match(tableRe) ?? [];
  for (const t of tableMatches) {
    const rows: string[][] = [];
    const rowMatches = t.match(rowRe) ?? [];
    for (const r of rowMatches) {
      const cells: string[] = [];
      let m: RegExpExecArray | null;
      cellRe.lastIndex = 0;
      while ((m = cellRe.exec(r)) !== null) {
        const raw = m[1] ?? '';
        const text = decodeHtmlEntities(raw.replace(tagRe, ' ').replace(wsRe, ' ').trim());
        cells.push(text);
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// ─── PDF helpers ───────────────────────────────────────────────────────

const HEBREW_LETTER = /[֐-׿]/;

/**
 * pdf-parse returns text in visual (drawn) order. Hebrew lines are
 * drawn right-to-left, so a line like "יונתן כהן" arrives as "ןהכ ןתנוי"
 * — reversed both characters AND word order. Detect Hebrew presence
 * and reverse the line's tokens; ASCII-only lines are left alone.
 *
 * This is deliberately a best-effort pass. PDFs are hostile enough that
 * Stage 5 keeps a low `confidence` score and forces manual review; this
 * just makes the extracted text HUMAN-readable so the user can decide.
 */
function reverseHebrewInLine(line: string): string {
  if (!HEBREW_LETTER.test(line)) return line;
  // Split by whitespace, reverse each token, then reverse the token list.
  // This handles the common case of mixed Hebrew-Latin words in one line.
  const tokens = line.split(/(\s+)/); // keep separators
  const flipped = tokens.map((t) => {
    if (/^\s+$/.test(t)) return t;
    if (HEBREW_LETTER.test(t)) return t.split('').reverse().join('');
    return t;
  });
  return flipped.reverse().join('');
}
