import { Injectable, Logger } from '@nestjs/common';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';

import { decodeMimeWords, decodePreview, decodeText } from './text-decoding';
import { parseDelimitedText } from './csv-reader';
import { LegacyDocError, oleStreamNames, readLegacyDoc } from './legacy-doc-reader';
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
 *   • xlsx / xls / ods / csv / html-mislabeled-as-xlsx → SheetJS `xlsx`.
 *     Binary workbooks go in as bytes; text formats are decoded first
 *     (BOM, UTF-8, UTF-16, Windows-1255; see `text-decoding.ts`) and go
 *     in as a string, with value parsing off so a phone like 0501234567
 *     keeps its leading zero.
 *   • docx (Word tables) → `mammoth` extracts the doc's tables; each
 *     table becomes one "sheet" so header detection can run against it.
 *   • doc (legacy Word 97-2003, often renamed .docx) → `legacy-doc-reader`.
 *   • odt (LibreOffice text) → tables read from `content.xml`.
 *   • Word / ODT without tables → the document's lines as a one-column
 *     sheet, when the text holds an email address or a phone number.
 *   • raw email (.eml text saved under a spreadsheet name) → the
 *     To / Cc / From recipients as a Name / Email sheet.
 *   • pdf → `pdf-parse` best-effort text-layer. Comes back with a low
 *     `confidence`; Stage 5 forces these into the manual/conflict lane
 *     rather than silently trusting.
 *
 * Reject path — surfaced with a human-readable reason (§9 target,
 * "triage never shows a stack trace"): images, diagrams, archives,
 * executables, password-protected files, PowerPoint, unknown binary.
 *
 * BM2-28 (QA6) — every file in the client's real folders was run through
 * this service; the readers above were added or fixed for the failures
 * found there (forced UTF-8 code page mangling BOM CSVs, UTF-16 exports
 * rejected, Office files whose zip entries sit past the first 16 KB,
 * ODF files, legacy .doc, empty 16k-column ranges).
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
      return reject('The file is empty (0 bytes).');
    }

    const sig = sniffMagicBytes(buffer);

    // ─── Reject — true non-data ──────────────────────────────────────
    if (sig === 'png' || sig === 'jpeg' || sig === 'gif' || sig === 'tiff' || sig === 'bmp' || sig === 'ico') {
      return reject(
        `This file is an image (${sig.toUpperCase()}), not a contact list. Check the file name, or ask for the original spreadsheet.`,
      );
    }
    if (sig === 'drawio') {
      return reject(
        'This file is a draw.io diagram, not a contact list. Export the data behind it as .xlsx or .csv.',
      );
    }
    if (sig === 'exe' || sig === 'elf' || sig === 'macho') {
      return reject('This file is a program, not a contact list.');
    }
    if (sig === 'zip-other') {
      // A ZIP that is neither Office (.xlsx/.docx) nor OpenDocument —
      // e.g. a bare .zip of files.
      return reject('This is a ZIP archive. Extract the contact spreadsheet from it and upload that file.');
    }
    if (sig === 'ole-encrypted') {
      return reject('This file is password-protected. Remove the password in Excel or Word, save, and upload again.');
    }
    if (sig === 'ppt' || sig === 'pptx') {
      return reject('This is a PowerPoint presentation, not a contact list. Copy the contacts into Excel and upload that file.');
    }
    if (sig === 'ole-other') {
      return reject('This is an old Office file of a type the wizard cannot read. Open it and save it as .xlsx or .docx.');
    }

    // ─── Accept — dispatch to a tolerant reader ─────────────────────
    try {
      if (
        sig === 'xlsx' ||
        sig === 'ole2' ||
        sig === 'ods' ||
        sig === 'html' ||
        sig === 'xml' ||
        sig === 'csv'
      ) {
        return await this.readTabular(buffer, sig, filename);
      }
      if (sig === 'docx') {
        return await this.readDocx(buffer, filename);
      }
      if (sig === 'doc') {
        return this.readDoc(buffer, filename);
      }
      if (sig === 'odt') {
        return this.readOdt(buffer, filename);
      }
      if (sig === 'eml') {
        return this.readEmail(buffer, filename);
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
      return reject(`Could not read this file. ${humanizeReaderError(message)}`);
    }

    return reject(
      'Could not tell what kind of file this is. Supported: .xlsx, .xls, .csv, .docx, .doc, .ods, .odt or .pdf.',
    );
  }

  // ─── Readers ────────────────────────────────────────────────────────

  /**
   * Tabular reader — handles xlsx, legacy xls (OLE2), ods, csv, and
   * HTML/XML-as-xlsx in one shot via SheetJS. Every sheet returns a 2D
   * string array (`rows[r][c]`); numbers/dates are stringified so
   * downstream Stage 2 header detection can score cells against the
   * header dictionary.
   *
   * Note on `raw: false` (sheet_to_json): SheetJS formats dates +
   * numbers by cell type rather than returning JS Date objects. This
   * preserves what the human saw in Excel (e.g. "2026-03-05" instead of
   * a numeric serial 46091) and keeps everything as string, which is
   * what Stage 2/4 want.
   */
  private async readTabular(
    buffer: Buffer,
    sig: TabularSig,
    filename?: string,
  ): Promise<TriageResult> {
    if (sig === 'csv') {
      // Decode ourselves (BOM / UTF-8 / UTF-16 / Windows-1255) and parse
      // every cell as text, so "0501234567" keeps its leading zero.
      const rows = parseDelimitedText(decodeText(buffer).text);
      return {
        kind: 'tabular',
        reader: 'csv',
        filename,
        sheets: [{ name: 'Sheet1', rows }],
      };
    }
    const isText = sig === 'html' || sig === 'xml';
    const text = isText ? decodeText(buffer).text : '';
    if (isText && /<frameset[\s>]/i.test(text)) {
      // Excel "Web Page" export of a multi-sheet workbook: this file is
      // only the frame around the tabs; the cells live in a separate
      // "_files" folder that was not sent.
      return reject(
        'This is the cover page of an Excel "Web Page" export. The contacts are in a separate folder that was not uploaded. Open the file in Excel, save it as .xlsx, and upload that.',
      );
    }
    const wb = isText
      ? // HTML / XML exports: decode ourselves and hand SheetJS a
        // string. `raw: true` turns off value parsing.
        XLSX.read(text, { type: 'string', raw: true, cellDates: false })
      : // Binary workbooks carry their own code page; never force one
        // (the old forced UTF-8 code page is what broke BOM CSVs).
        XLSX.read(buffer, { type: 'buffer', cellDates: false, cellText: false, raw: false });
    if (!wb.SheetNames || wb.SheetNames.length === 0) {
      return reject('The file opened, but it has no worksheets.');
    }
    const sheets: ExtractedSheet[] = wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      if (!ws || !tightenRange(ws)) return { name, rows: [] };
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
   * like a spreadsheet tab. A document without tables falls back to its
   * lines when they hold contact details.
   */
  private async readDocx(buffer: Buffer, filename?: string): Promise<TriageResult> {
    const result = await mammoth.convertToHtml({ buffer });
    const tables = extractHtmlTables(result.value);
    if (tables.length > 0) {
      return {
        kind: 'docx-tables',
        filename,
        reader: 'docx',
        sheets: tables.map((rows, i) => ({ name: `Table ${i + 1}`, rows })),
      };
    }
    const raw = await mammoth.extractRawText({ buffer });
    return documentLinesResult(raw.value.split(/\r?\n/), 'docx', filename);
  }

  /** Legacy Word 97-2003 (.doc), usually renamed to .docx by the sender. */
  private readDoc(buffer: Buffer, filename?: string): TriageResult {
    let content;
    try {
      content = readLegacyDoc(buffer);
    } catch (err) {
      if (err instanceof LegacyDocError && err.code === 'encrypted') {
        return reject('This Word file is password-protected. Remove the password in Word, save, and upload again.');
      }
      if (err instanceof LegacyDocError) {
        return reject(
          'This is an old Word file (Word 97-2003) that could not be read. Open it in Word, save it as .docx, and upload again.',
        );
      }
      throw err;
    }
    if (content.tables.length > 0) {
      return {
        kind: 'docx-tables',
        filename,
        reader: 'doc',
        sheets: content.tables.map((rows, i) => ({ name: `Table ${i + 1}`, rows })),
      };
    }
    return documentLinesResult(content.paragraphs, 'doc', filename);
  }

  /** OpenDocument text (LibreOffice / Google Docs export) — tables from content.xml. */
  private readOdt(buffer: Buffer, filename?: string): TriageResult {
    const zip = XLSX.CFB.read(buffer, { type: 'buffer' });
    const entry = XLSX.CFB.find(zip, 'content.xml');
    if (!entry || !entry.content) {
      return reject('This OpenDocument file has no readable content. Open it and save it as .docx or .xlsx.');
    }
    const xml = Buffer.from(entry.content as Uint8Array).toString('utf8');
    const tables = extractOdfTables(xml);
    if (tables.length > 0) {
      return {
        kind: 'docx-tables',
        filename,
        reader: 'odt',
        sheets: tables.map((rows, i) => ({ name: `Table ${i + 1}`, rows })),
      };
    }
    return documentLinesResult(extractOdfParagraphs(xml), 'odt', filename);
  }

  /**
   * A raw email message (RFC 822 text) saved under a spreadsheet name.
   * The contacts are the people in its To / Cc / From headers.
   */
  private readEmail(buffer: Buffer, filename?: string): TriageResult {
    const { text } = decodeText(buffer);
    const headerBlock = text.split(/\r?\n\r?\n/, 1)[0] ?? '';
    const unfolded: string[] = [];
    for (const line of headerBlock.split(/\r?\n/)) {
      if (/^[ \t]/.test(line) && unfolded.length > 0) {
        unfolded[unfolded.length - 1] += ' ' + line.trim();
      } else {
        unfolded.push(line);
      }
    }
    const recipientLines = unfolded
      .filter((l) => /^(to|cc|bcc|from|reply-to)\s*:/i.test(l))
      .map((l) => decodeMimeWords(l));
    const rows = extractGmailRecipientRows(recipientLines);
    if (rows.length === 0) {
      return reject(
        'This file is an email message, but its headers have no recipients with email addresses. Upload the contact list itself.',
      );
    }
    return {
      kind: 'tabular',
      reader: 'eml',
      filename,
      sheets: [{ name: 'Email recipients', rows: [['Name', 'Email'], ...rows] }],
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
        'This PDF has no text the wizard can read (it looks scanned). Export the source data as .xlsx or .csv, or run OCR on the PDF first.',
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

export type TabularReader = 'xlsx' | 'xls' | 'ods' | 'csv' | 'html-xlsx' | 'eml';
export type DocumentReader = 'docx' | 'doc' | 'odt';

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
      reader: DocumentReader;
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
  | 'xlsx'          // ZIP + `xl/` entry → real xlsx
  | 'docx'          // ZIP + `word/` entry → real docx
  | 'pptx'          // ZIP + `ppt/` entry → PowerPoint
  | 'ods'           // OpenDocument spreadsheet (LibreOffice)
  | 'odt'           // OpenDocument text
  | 'zip-other'     // ZIP but not Office / ODF → generic archive
  | 'ole2'          // legacy Excel binary (.xls)
  | 'doc'           // legacy Word binary (.doc)
  | 'ppt'           // legacy PowerPoint binary
  | 'ole-encrypted' // password-protected Office file
  | 'ole-other'     // some other OLE2 compound file
  | 'html'          // HTML/XHTML doc mislabeled as xlsx
  | 'xml'           // XML (spreadsheetML, drawio has its own branch)
  | 'drawio'        // <mxfile> diagram
  | 'eml'           // raw email message (RFC 822)
  | 'csv'           // heuristic — text with delimiters
  | 'pdf'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'tiff'
  | 'bmp'
  | 'ico'
  | 'exe'
  | 'elf'
  | 'macho'
  | 'unknown';

type TabularSig = 'xlsx' | 'ole2' | 'ods' | 'html' | 'xml' | 'csv';

/**
 * Inspect the head of the buffer (and, for ZIP / OLE2 containers, their
 * directory) and classify by real type. Deliberate order: images and
 * diagrams before ambiguous text so a PNG renamed .xlsx doesn't slip
 * through as "unknown".
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
  // Windows icon: reserved 0, type 1, at least one image.
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00 &&
    buffer.readUInt16LE(4) > 0
  ) return 'ico';

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
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 &&
    buffer[5] === 0xb1 &&
    buffer[6] === 0x1a &&
    buffer[7] === 0xe1
  ) {
    return classifyOle(buffer);
  }

  // ── ZIP (real xlsx/docx/ods/odt are ZIPs; also plain .zip archives) ──
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)) {
    return classifyZip(buffer);
  }

  // ── Text-like — HTML/XML/drawio/email/CSV ─────────────────────────
  // Decoded leniently (UTF-8 / UTF-16 BOM aware) so a UTF-16 "web page"
  // export from Excel is recognised as HTML instead of unknown binary.
  const preview = decodePreview(buffer);
  const trimmed = preview.replace(/^﻿/, '').trimStart();

  if (/^<\?xml[\s>]/i.test(trimmed)) {
    // draw.io: <?xml ...?><mxfile ...>
    if (/<mxfile[\s>]/i.test(trimmed)) return 'drawio';
    // Excel 2003 XML SpreadsheetML: <?xml ...?><?mso-application progid="Excel.Sheet"?><Workbook>
    if (/mso-application/i.test(trimmed) || /<Workbook[\s>]/i.test(trimmed)) return 'html'; // SheetJS reads it via 'html' path
    return 'xml';
  }
  if (/^<mxfile[\s>]/i.test(trimmed)) return 'drawio';
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed) || /^<table[\s>]/i.test(trimmed)) return 'html';
  if (looksLikeEmailMessage(trimmed)) return 'eml';

  // CSV heuristic — printable text with commas/semicolons/tabs and
  // at least one newline in the preview.
  if (looksLikeCsv(trimmed)) return 'csv';

  return 'unknown';
}

/** OLE2: tell Excel from Word / PowerPoint / encrypted OOXML by stream names. */
function classifyOle(buffer: Buffer): Sig {
  let names: string[];
  try {
    names = oleStreamNames(buffer);
  } catch {
    // Damaged directory — let SheetJS try (it gives a readable error).
    return 'ole2';
  }
  const has = (n: string) => names.some((x) => x === n || x.endsWith('/' + n));
  if (has('EncryptionInfo') || has('EncryptedPackage')) return 'ole-encrypted';
  if (has('Workbook') || has('Book')) return 'ole2';
  if (has('WordDocument')) return 'doc';
  if (has('PowerPoint Document')) return 'ppt';
  return 'ole-other';
}

/**
 * ZIP: decide by the entry names in the central directory (at the END
 * of the file). The old probe only looked at the first 16 KB, so an
 * xlsx whose first entry is a large image was rejected as a "generic
 * ZIP archive".
 */
function classifyZip(buffer: Buffer): Sig {
  const head = buffer.subarray(0, Math.min(buffer.length, 16 * 1024)).toString('binary');
  // OpenDocument: the first entry is an uncompressed `mimetype` file.
  if (head.includes('mimetypeapplication/vnd.oasis.opendocument.spreadsheet')) return 'ods';
  if (head.includes('mimetypeapplication/vnd.oasis.opendocument.text')) return 'odt';
  const entries = zipEntryNames(buffer);
  if (entries) {
    if (entries.some((e) => e.startsWith('xl/'))) return 'xlsx';
    if (entries.some((e) => e.startsWith('word/'))) return 'docx';
    if (entries.some((e) => e.startsWith('ppt/'))) return 'pptx';
    if (entries.includes('content.xml') && entries.includes('mimetype')) {
      // ODF whose mimetype entry was not first (re-zipped by hand).
      const mimetype = readZipEntryText(buffer, 'mimetype');
      if (mimetype.includes('opendocument.spreadsheet')) return 'ods';
      if (mimetype.includes('opendocument.text')) return 'odt';
    }
    return 'zip-other';
  }
  // No readable central directory (truncated file) — old head probe.
  if (head.includes('xl/') || (head.includes('[Content_Types].xml') && head.includes('Workbook'))) return 'xlsx';
  if (head.includes('word/')) return 'docx';
  if (head.includes('[Content_Types].xml')) {
    if (head.includes('workbook.xml')) return 'xlsx';
    if (head.includes('document.xml')) return 'docx';
  }
  return 'zip-other';
}

function readZipEntryText(buffer: Buffer, name: string): string {
  try {
    const zip = XLSX.CFB.read(buffer, { type: 'buffer' });
    const entry = XLSX.CFB.find(zip, name);
    return entry?.content ? Buffer.from(entry.content as Uint8Array).toString('utf8') : '';
  } catch {
    return '';
  }
}

/** Entry names from the ZIP central directory, or null when unreadable. */
export function zipEntryNames(buffer: Buffer): string[] | null {
  const minEocd = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= minEocd; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  let off = buffer.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buffer.length || buffer.readUInt32LE(off) !== 0x02014b50) return names.length ? names : null;
    const nameLen = buffer.readUInt16LE(off + 28);
    const extraLen = buffer.readUInt16LE(off + 30);
    const commentLen = buffer.readUInt16LE(off + 32);
    names.push(buffer.subarray(off + 46, off + 46 + nameLen).toString('utf8'));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function looksLikeText(buffer: Buffer): boolean {
  const preview = decodePreview(buffer, 2048);
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

/**
 * RFC 822 message: the first lines are `Header-Name: value`. (Gmail puts
 * dozens of Received / ARC / DKIM lines before To and From, so only the
 * shape of the head is checked here.)
 */
function looksLikeEmailMessage(preview: string): boolean {
  const lines = preview.split(/\r?\n/, 40);
  const first = lines[0] ?? '';
  if (!/^(delivered-to|received|return-path|from|to|subject|date|message-id|mime-version|arc-seal|x-[\w-]+)\s*:/i.test(first)) {
    return false;
  }
  const headerish = lines.filter((l) => /^[A-Za-z][\w-]*\s*:/.test(l)).length;
  return headerish >= 3;
}

function readerLabel(sig: TabularSig): TabularReader {
  if (sig === 'xlsx') return 'xlsx';
  if (sig === 'ole2') return 'xls';
  if (sig === 'ods') return 'ods';
  if (sig === 'csv') return 'csv';
  return 'html-xlsx';
}

/**
 * Shrink a worksheet's range to the cells that hold a value. Excel often
 * records a used range far past the data (formatting dragged to column
 * XFD): one real file came back as 37 rows x 16,379 columns, a 1.8 MB
 * grid of empty strings. The range start is kept so row numbering stays
 * as before. Returns false when the sheet has no values at all.
 */
function tightenRange(ws: XLSX.WorkSheet): boolean {
  let maxR = -1;
  let maxC = -1;
  for (const key of Object.keys(ws)) {
    if (key.charCodeAt(0) === 33 /* '!' */) continue;
    const cell = ws[key] as XLSX.CellObject | undefined;
    if (!cell || cell.t === 'z' || cell.v == null || cell.v === '') continue;
    const { r, c } = XLSX.utils.decode_cell(key);
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  if (maxR < 0) return false;
  const start = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s : { r: 0, c: 0 };
  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: Math.min(start.r, maxR), c: Math.min(start.c, maxC) },
    e: { r: maxR, c: maxC },
  });
  return true;
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
  if (s.includes('bad magic') || s.includes('not a zip') || s.includes('invalid zip') || s.includes('unsupported file')) {
    return 'The file contents do not match its extension. Open it and save it again as .xlsx.';
  }
  if (s.includes('password') || s.includes('encrypt')) {
    return 'The file is password-protected. Remove the password and upload again.';
  }
  if (s.includes('corrupt') || s.includes('malformed') || s.includes('end of') || s.includes('invalid')) {
    return 'The file appears to be damaged. Open it, save it again, and upload the new copy.';
  }
  return 'Open it, save it again as .xlsx, and upload the new copy.';
}

// ─── Document helpers (docx / doc / odt) ──────────────────────────────

const CONTACT_SIGNAL_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i;
const CONTACT_SIGNAL_PHONE = /(?:\+?972[-\s]?|\b0)(?:[2-9]|5\d)[-\s]?\d{3}[-\s]?\d{4}\b/;

/**
 * A document without tables: hand its lines over as a one-column sheet
 * when they hold contact details (the classifier and the Preview edit
 * box do the rest); otherwise say clearly that there is nothing to
 * import.
 */
function documentLinesResult(
  rawLines: string[],
  reader: DocumentReader,
  filename?: string,
): TriageResult {
  const lines = rawLines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const hasContactSignal = lines.some((l) => CONTACT_SIGNAL_EMAIL.test(l) || CONTACT_SIGNAL_PHONE.test(l));
  if (!hasContactSignal) {
    return reject(
      'This document has no tables and no email addresses or phone numbers, so there are no contacts to import.',
    );
  }
  return {
    kind: 'docx-tables',
    filename,
    reader,
    sheets: [{ name: 'Document text', rows: lines.map((l) => [l]) }],
  };
}

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
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** ODF cell / paragraph inner XML → plain text. */
function odfText(xml: string): string {
  return decodeHtmlEntities(
    xml
      .replace(/<text:s\b[^>]*?text:c="(\d+)"[^>]*\/>/g, (_m, n: string) => ' '.repeat(Math.min(Number(n), 50)))
      .replace(/<text:(s|tab|line-break)\b[^>]*\/>/g, ' ')
      .replace(/<\/text:(p|h)>/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/**
 * Tables from an ODF `content.xml`. Repeated rows / cells are expanded,
 * with a cap so the "repeat this empty cell 1,000 times" padding that
 * LibreOffice writes does not blow up the grid.
 */
export function extractOdfTables(xml: string): string[][][] {
  const tables: string[][][] = [];
  const tableRe = /<table:table\b[^>]*>([\s\S]*?)<\/table:table>/g;
  const rowRe = /<table:table-row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g;
  const cellRe = /<table:(table-cell|covered-table-cell)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:\1>)/g;
  const repeat = (attrs: string, name: string): number => {
    const m = attrs.match(new RegExp(`table:${name}="(\\d+)"`));
    return m ? Math.max(1, Number(m[1])) : 1;
  };
  let t: RegExpExecArray | null;
  while ((t = tableRe.exec(xml)) !== null) {
    const rows: string[][] = [];
    let r: RegExpExecArray | null;
    rowRe.lastIndex = 0;
    while ((r = rowRe.exec(t[1])) !== null) {
      const cells: string[] = [];
      let c: RegExpExecArray | null;
      cellRe.lastIndex = 0;
      while ((c = cellRe.exec(r[2] ?? '')) !== null) {
        const text = odfText(c[3] ?? '');
        const n = Math.min(repeat(c[2], 'number-columns-repeated'), 64);
        for (let k = 0; k < n; k++) cells.push(text);
      }
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      if (cells.length === 0) continue;
      const times = Math.min(repeat(r[1], 'number-rows-repeated'), 50);
      for (let k = 0; k < times; k++) rows.push([...cells]);
    }
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}

/** Paragraphs and headings of an ODF document, tables removed. */
export function extractOdfParagraphs(xml: string): string[] {
  const body = xml.replace(/<table:table\b[\s\S]*?<\/table:table>/g, '');
  const out: string[] = [];
  const re = /<text:(p|h)\b[^>]*?(?:\/>|>([\s\S]*?)<\/text:\1>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const text = odfText(m[2] ?? '');
    if (text) out.push(text);
  }
  return out;
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
