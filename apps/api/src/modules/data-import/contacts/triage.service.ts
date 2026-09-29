import { Injectable, Logger } from '@nestjs/common';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
// pdf-parse v2 exports a PDFParse class rather than the v1 callable
// default. The old wrapper (`require('pdf-parse')` as a function) was
// silently broken on this version; QA4 R2 IMP-11 (2026-09-29) moves
// to the v2 API so the PDF path actually returns text.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParseModule = require('pdf-parse');
type PdfParseCtor = new (opts: { data: Buffer | Uint8Array }) => {
  getText: () => Promise<{ text: string; total: number; pages?: unknown }>;
};
const PDFParse: PdfParseCtor = pdfParseModule.PDFParse ?? pdfParseModule.default ?? pdfParseModule;

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
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    const rawText = parsed.text ?? '';
    const pages = parsed.total ?? 0;

    // QA4 R2 IMP-11 — reject a truly non-contact PDF (a scan or a
    // pure diagram) before we hand back a useless empty sheet. A
    // "no text layer" PDF returns either an empty string or a few
    // stray glyphs.
    const printable = rawText.replace(/\s/g, '');
    if (printable.length < 8) {
      return reject(
        'this PDF has no extractable text (looks scanned) — export the source data as .xlsx or .csv, or OCR the PDF first',
      );
    }

    // Note: pdf-parse v2 already emits text in LOGICAL order (RTL
    // scripts are unreversed), so we do NOT run the v1-era
    // reverseHebrewInLine pass — that would flip the string back to
    // visual order and break the email + name recognizers.
    const lines = rawText.split(/\r?\n/);

    // QA4 R2 IMP-11 — detect an email-printout PDF (Gmail thread etc.)
    // and pull out the To:/Cc: recipient list as one contact per row.
    // Gmail's export splits long recipient lists across several lines
    // (address + newline + rest of local-part), so we glue the header
    // continuations first.
    const stitched = stitchHeaderContinuations(lines);
    const gmailRows = extractGmailRecipientRows(stitched);
    if (gmailRows.length > 0) {
      return {
        kind: 'pdf',
        filename,
        reader: 'pdf',
        confidence: Math.min(1, 0.5 + gmailRows.length / 40),
        pages,
        sheets: [
          {
            name: 'Recipients',
            rows: [
              ['Name', 'Email'],
              ...gmailRows,
            ],
          },
        ],
      };
    }

    // QA4 R2 IMP-11 — tabular PDF path. pdf-parse v2 emits table rows
    // as TAB-separated text lines when the source PDF carries a real
    // table (matches `210007-Contacts.pdf`). Split every line on `\t`,
    // drop rows that are purely blank, and hand the resulting 2D grid
    // to Stage 2's header-detection like any spreadsheet source.
    // When no tab-separated shape is present, fall back to the
    // single-column extract so the classifier can still mine tokens
    // per line and the PM can inline-edit low-confidence rows.
    const tabularRows = extractTabularRows(lines);
    const emailCount = (rawText.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi) ?? []).length;
    if (tabularRows.length > 1 && tabularRows.some((r) => r.length >= 3)) {
      const confidence = Math.min(1, 0.4 + emailCount / 30);
      return {
        kind: 'pdf',
        filename,
        reader: 'pdf',
        confidence,
        pages,
        sheets: [{ name: 'PDF Table', rows: tabularRows }],
      };
    }

    // Single-column fallback. Confidence stays low so Stage 5 forces
    // manual review; the classifier still runs against each line and
    // Preview lets the PM inline-edit low-confidence rows (QA4 R2
    // IMP-11 known limitation for structure-less PDFs).
    const confidence = Math.min(1, emailCount / 20);
    return {
      kind: 'pdf',
      filename,
      reader: 'pdf',
      confidence,
      pages,
      sheets: [{ name: 'PDF Extract', rows: lines.map((l) => [l]) }],
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

/**
 * QA4 R2 IMP-11 — Gmail's PDF export wraps long To:/Cc: recipient
 * lists across several lines. A continuation line looks like the
 * tail of a URL / email local part on its own, e.g. line N ends
 * `<shimon@peer-` and line N+1 begins `eng.com>, יאיר...`. Stitch
 * continuations so the recipient regex sees each `Name <email>` pair
 * whole. A line is a continuation when it does NOT start with a
 * new header token (To:/Cc:/…) AND the prior line ended mid-token
 * (no closing `>` on the last address seen, or a trailing `-`
 * inside an address).
 */
function stitchHeaderContinuations(lines: string[]): string[] {
  const HEADER_START = /^\s*(to|cc|bcc|from|reply-to|אל|עותק|עותק נסתר|מאת)\s*:/i;
  const out: string[] = [];
  let carry: string | null = null;
  let carryIsHeader = false;
  const flush = () => {
    if (carry != null) out.push(carry);
    carry = null;
    carryIsHeader = false;
  };
  for (const line of lines) {
    const isHeader = HEADER_START.test(line);
    if (isHeader) {
      flush();
      carry = line;
      carryIsHeader = true;
      continue;
    }
    if (carryIsHeader && carry != null) {
      // Continuation heuristic: previous carry ends with a hyphen
      // inside what looks like an email (`<foo@peer-`) or with `,`
      // (mid-list). Otherwise treat this line as an unrelated
      // paragraph and flush.
      const trimmed = carry.trimEnd();
      const looksContinuing =
        /[<,]\s*$/.test(trimmed) || /-\s*$/.test(trimmed) || !/>/.test(trimmed.slice(-40));
      if (looksContinuing) {
        carry = trimmed + line.trim();
        continue;
      }
      flush();
    }
    out.push(line);
  }
  flush();
  return out;
}

/**
 * QA4 R2 IMP-11 — split tab-separated PDF text into a 2D grid.
 * pdf-parse v2 emits `\t` between the cells of a recognised PDF
 * table (matches the shape produced by `210007-Contacts.pdf`).
 * Skip fully blank lines and trim each cell; drop leading/trailing
 * blank columns per row.
 */
function extractTabularRows(lines: string[]): string[][] {
  const rows: string[][] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!line.includes('\t')) {
      // A non-tabular line (page header, url, footer) sits inline
      // in the PDF text output. Preserve as a 1-cell row so the
      // caller can still see it if the shape is only partly tabular;
      // Stage 2's header detection filters it out.
      rows.push([line.trim()]);
      continue;
    }
    const cells = line.split('\t').map((c) => c.trim());
    // Drop the trailing empty cell that a hard tab at line end leaves.
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length === 0) continue;
    rows.push(cells);
  }
  return rows;
}

/**
 * QA4 R2 IMP-11 — pull recipient contacts out of an email-printout
 * PDF (Gmail thread, `180051-Contacts.pdf` shape). Handles the common
 * layouts:
 *   • header line prefixed `To:` / `Cc:` / `Bcc:` (or `אל:` / `עותק:`
 *     for Hebrew mail clients) followed by a comma-separated list of
 *     `Name <email>` pairs;
 *   • body text where the same `Name <email>` pattern appears inline;
 *   • bare `<email>` addresses (no name) — pass through as email-only
 *     rows for the classifier / Preview to fill in.
 *
 * Returns `[[name, email], ...]` with duplicates collapsed on
 * lower-cased email. When the pattern doesn't fire at all, returns
 * an empty array so the caller falls through to the single-column
 * fallback. Never throws.
 */
function extractGmailRecipientRows(lines: string[]): string[][] {
  // Email domain allows dots inside so multi-part TLDs like co.il /
  // ac.uk / com.au parse correctly (regressed on the earlier
  // `[\w-]+\.[a-z]{2,}` shape which only matched single-part TLDs).
  const NAME_EMAIL_RE = /(?:"([^"]+)"|([^,<;]+?))\s*<([\w.+-]+@[\w.-]+\.[a-z]{2,})>/gi;
  const BARE_EMAIL_RE = /(^|[\s,;])([\w.+-]+@[\w.-]+\.[a-z]{2,})(?=$|[\s,;])/gi;
  const HEADER_LINE_RE = /^\s*(to|cc|bcc|from|reply-to|אל|עותק|עותק נסתר|מאת)\s*:/i;
  // Strip the header prefix ("To: ", "Cc: ", "אל: " …) from the
  // first name we capture on a header line so it doesn't stick to
  // the recipient's display name.
  const HEADER_PREFIX_RE = /^\s*(to|cc|bcc|from|reply-to|אל|עותק|עותק נסתר|מאת)\s*:\s*/i;

  const seen = new Set<string>();
  const rows: string[][] = [];
  const pushPair = (name: string, email: string) => {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) return;
    if (seen.has(cleanEmail)) return;
    seen.add(cleanEmail);
    const cleanName = name
      .trim()
      .replace(HEADER_PREFIX_RE, '')
      .replace(/^["']|["']$/g, '')
      .trim();
    rows.push([cleanName, cleanEmail]);
  };

  let sawHeader = false;
  for (const line of lines) {
    const isHeader = HEADER_LINE_RE.test(line);
    if (isHeader) sawHeader = true;
    NAME_EMAIL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let hitInLine = false;
    while ((m = NAME_EMAIL_RE.exec(line)) !== null) {
      hitInLine = true;
      const name = (m[1] ?? m[2] ?? '').trim();
      pushPair(name, m[3]);
    }
    // Only mine bare emails from HEADER lines — the body can carry
    // stray addresses (footers, disclaimers) that aren't contacts.
    if (isHeader && !hitInLine) {
      BARE_EMAIL_RE.lastIndex = 0;
      let e: RegExpExecArray | null;
      while ((e = BARE_EMAIL_RE.exec(line)) !== null) {
        pushPair('', e[2]);
      }
    }
  }

  // Guard: if we NEVER saw a To:/Cc: header AND fewer than two
  // name<email> pairs, this probably isn't a Gmail thread. Fall
  // through to the per-line grid so the classifier gets a chance.
  if (!sawHeader && rows.length < 2) return [];
  return rows;
}

// QA4 R2 IMP-11 (2026-09-29) — the earlier `reverseHebrewInLine`
// helper (pdf-parse v1 visual-order compensation) was removed. v2's
// `getText()` emits Hebrew in logical order already; running the flip
// on top would turn every Hebrew string BACK to visual (RTL) order
// and break email + name recognition.
