import * as XLSX from 'xlsx';

import { CONTACTS_IMPORT_MAX_DOC_PIECES } from './import-limits';

/**
 * BM2-28 (QA6) · Legacy Word 97-2003 (.doc) reader for the contacts
 * import wizard.
 *
 * Five files in the client's real `projects_contacts` folder are old
 * binary Word documents saved with a `.docx` name. `mammoth` only reads
 * the modern zip format, so these used to fail with "the file could not
 * be parsed". This reader pulls the text and the table structure out of
 * the binary format in-process (no LibreOffice, no external converter).
 *
 * How the format is read (MS-DOC):
 *   • The file is an OLE2 compound file. SheetJS ships the `cfb` reader
 *     (`XLSX.CFB`), which gives us the `WordDocument` stream and the
 *     table stream (`0Table` / `1Table`).
 *   • The FIB at the head of `WordDocument` points at the piece table
 *     (`fcClx`), which maps character positions to byte ranges. A piece
 *     is either 8-bit (cp1252) or UTF-16LE text; Hebrew is always UTF-16.
 *   • Table structure is not in the text itself. A table cell ends with a
 *     0x07 mark, and a row ends with a second 0x07 whose paragraph carries
 *     the "table terminating paragraph" property (sprmPFTtp). Paragraph
 *     properties live in PAPX FKP pages listed by `fcPlcfBtePapx`, so we
 *     walk those to tell a cell end from a row end.
 *
 * Only the main document text is read (headers, footnotes, comments are
 * skipped). Field instructions (e.g. `HYPERLINK "mailto:..."`) are
 * dropped and the visible field result is kept.
 */

export interface LegacyDocContent {
  /** One entry per table: rows of cell strings (trimmed). */
  tables: string[][][];
  /** Non-empty paragraphs outside any table. */
  paragraphs: string[];
}

export type LegacyDocErrorCode = 'not-word' | 'encrypted' | 'corrupt';

export class LegacyDocError extends Error {
  constructor(
    message: string,
    readonly code: LegacyDocErrorCode,
  ) {
    super(message);
    this.name = 'LegacyDocError';
  }
}

interface Piece {
  cpStart: number;
  cpEnd: number;
  compressed: boolean;
  byteStart: number;
}

interface ParaProps {
  inTable: boolean;
  ttp: boolean;
  innerTtp: boolean;
  itap: number;
}

interface ParaRun extends ParaProps {
  fcStart: number;
  fcEnd: number;
}

const NO_PROPS: ParaProps = { inTable: false, ttp: false, innerTtp: false, itap: 0 };

// sprm codes we care about (MS-DOC 2.6.2).
const SPRM_P_F_IN_TABLE = 0x2416;
const SPRM_P_F_TTP = 0x2417;
const SPRM_P_F_INNER_TTP = 0x244c;
const SPRM_P_ITAP = 0x6649;
const SPRM_T_DEF_TABLE = 0xd608;
const SPRM_T_DEF_TABLE10 = 0xd606;
const SPRM_P_CHG_TABS = 0xc615;

/** cp1252 code points for 0x80..0x9F (the rest map 1:1 to Latin-1). */
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

function toBuffer(content: unknown): Buffer {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  if (Array.isArray(content)) return Buffer.from(content as number[]);
  return Buffer.alloc(0);
}

function corrupt(detail: string): LegacyDocError {
  return new LegacyDocError(`the Word file is damaged (${detail})`, 'corrupt');
}

/** Does this OLE2 container hold a Word document? Cheap check for triage. */
export function oleStreamNames(buffer: Buffer): string[] {
  const cfb = XLSX.CFB.read(buffer, { type: 'buffer' });
  return (cfb.FullPaths as string[])
    .map((p) => p.replace(/^Root Entry\//, '').replace(/\/$/, ''))
    .filter(Boolean);
}

export function readLegacyDoc(buffer: Buffer): LegacyDocContent {
  let cfb: any;
  try {
    cfb = XLSX.CFB.read(buffer, { type: 'buffer' });
  } catch {
    throw corrupt('compound file');
  }
  const wdEntry = XLSX.CFB.find(cfb, 'WordDocument');
  if (!wdEntry || !wdEntry.content) {
    throw new LegacyDocError('this Office file is not a Word document', 'not-word');
  }
  const wd = toBuffer(wdEntry.content);
  if (wd.length < 0x200 || wd.readUInt16LE(0) !== 0xa5ec) throw corrupt('header');

  const flags = wd.readUInt16LE(0x0a);
  if (flags & 0x0100) {
    throw new LegacyDocError('the Word file is password-protected', 'encrypted');
  }
  const tblEntry = XLSX.CFB.find(cfb, flags & 0x0200 ? '1Table' : '0Table');
  if (!tblEntry || !tblEntry.content) throw corrupt('table stream');
  const tbl = toBuffer(tblEntry.content);

  // ── FIB: walk the variable-length blocks to the fc/lcb pairs ────────
  let pos = 0x20;
  const csw = wd.readUInt16LE(pos);
  pos += 2 + csw * 2;
  const cslw = wd.readUInt16LE(pos);
  pos += 2;
  const lwStart = pos;
  pos += cslw * 4;
  if (pos + 2 > wd.length) throw corrupt('FIB');
  const ccpTextRaw = cslw > 3 ? wd.readInt32LE(lwStart + 12) : 0;
  const cbRgFcLcb = wd.readUInt16LE(pos);
  pos += 2;
  const fcLcbStart = pos;
  const fcLcb = (index: number): { fc: number; lcb: number } => {
    const at = fcLcbStart + index * 8;
    if (index >= cbRgFcLcb || at + 8 > wd.length) return { fc: 0, lcb: 0 };
    return { fc: wd.readUInt32LE(at), lcb: wd.readUInt32LE(at + 4) };
  };
  const clx = fcLcb(33);
  const btePapx = fcLcb(13);
  if (!clx.lcb || clx.fc + clx.lcb > tbl.length) throw corrupt('piece table');

  const pieces = readPieces(tbl, clx.fc, clx.lcb, wd.length);
  const totalCp = pieces.reduce((m, p) => Math.max(m, p.cpEnd), 0);
  const ccpText = ccpTextRaw > 0 && ccpTextRaw <= totalCp ? ccpTextRaw : totalCp;

  // ── Text + the file offset of every character ───────────────────────
  const codes: number[] = [];
  const fcs: number[] = [];
  for (const pc of pieces) {
    const from = Math.max(pc.cpStart, 0);
    const to = Math.min(pc.cpEnd, ccpText);
    for (let cp = from; cp < to; cp++) {
      const k = cp - pc.cpStart;
      if (pc.compressed) {
        const off = pc.byteStart + k;
        if (off >= wd.length) break;
        const b = wd[off];
        codes.push(CP1252_HIGH[b] ?? b);
        fcs.push(off);
      } else {
        const off = pc.byteStart + 2 * k;
        if (off + 2 > wd.length) break;
        codes.push(wd.readUInt16LE(off));
        fcs.push(off);
      }
    }
  }

  const runs = btePapx.lcb && btePapx.fc + btePapx.lcb <= tbl.length
    ? readParagraphRuns(wd, tbl, btePapx.fc, btePapx.lcb)
    : [];
  const hasTtp = runs.some((r) => r.ttp);
  const propsAt = (fc: number): ParaProps => findRun(runs, fc) ?? NO_PROPS;

  return hasTtp || !codes.includes(0x07)
    ? assemble(codes, fcs, propsAt)
    : assembleWithoutProps(codes);
}

/**
 * The piece table (PlcPcd) inside the Clx.
 *
 * Review 2 (B1) · Each piece is read character by character into the
 * text, so a crafted table could make the reader go over the stream
 * again and again (pieces that all point at the whole stream, or CPs out
 * of order): n_pieces x stream size. The table is refused as damaged
 * unless the CPs strictly increase, every piece's bytes lie inside the
 * WordDocument stream, no two pieces share bytes, and there are at most
 * CONTACTS_IMPORT_MAX_DOC_PIECES pieces. The text read is then never
 * longer than the stream.
 */
function readPieces(tbl: Buffer, fc: number, lcb: number, streamLength: number): Piece[] {
  let p = fc;
  const end = fc + lcb;
  while (p < end) {
    const type = tbl[p];
    if (type === 0x01) {
      // Prc: property modifiers used by complex (fast-saved) files.
      if (p + 3 > end) break;
      p += 3 + tbl.readUInt16LE(p + 1);
      continue;
    }
    if (type !== 0x02 || p + 5 > end) break;
    const len = tbl.readUInt32LE(p + 1);
    const start = p + 5;
    if (start + len > tbl.length) break;
    const n = Math.floor((len - 4) / 12);
    if (n <= 0) break;
    if (n > CONTACTS_IMPORT_MAX_DOC_PIECES) throw corrupt('piece table');
    const pieces: Piece[] = [];
    for (let i = 0; i < n; i++) {
      const cpStart = tbl.readUInt32LE(start + i * 4);
      const cpEnd = tbl.readUInt32LE(start + (i + 1) * 4);
      if (cpEnd <= cpStart) throw corrupt('piece table');
      const pcd = start + (n + 1) * 4 + i * 8;
      const fcRaw = tbl.readUInt32LE(pcd + 2);
      const compressed = (fcRaw & 0x40000000) !== 0;
      const fcValue = fcRaw & 0x3fffffff;
      const byteStart = compressed ? Math.floor(fcValue / 2) : fcValue;
      if (byteStart + (cpEnd - cpStart) * (compressed ? 1 : 2) > streamLength) throw corrupt('piece table');
      pieces.push({ cpStart, cpEnd, compressed, byteStart });
    }
    const byBytes = [...pieces].sort((a, b) => a.byteStart - b.byteStart);
    for (let i = 1; i < byBytes.length; i++) {
      const prev = byBytes[i - 1];
      if (prev.byteStart + (prev.cpEnd - prev.cpStart) * (prev.compressed ? 1 : 2) > byBytes[i].byteStart) {
        throw corrupt('piece table');
      }
    }
    return pieces;
  }
  throw corrupt('piece table');
}

/** PAPX FKP pages → paragraph property runs keyed by file offset. */
function readParagraphRuns(wd: Buffer, tbl: Buffer, fc: number, lcb: number): ParaRun[] {
  const n = Math.floor((lcb - 4) / 8);
  const runs: ParaRun[] = [];
  // Review 2 (B1) · each FKP page is read once: a table listing the same
  // page millions of times would otherwise multiply its runs.
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const pn = tbl.readUInt32LE(fc + (n + 1) * 4 + i * 4) & 0x3fffff;
    if (seen.has(pn)) continue;
    seen.add(pn);
    const page = pn * 512;
    if (page + 512 > wd.length) continue;
    const crun = wd[page + 511];
    if (!crun || (crun + 1) * 4 + crun * 13 > 511) continue;
    for (let j = 0; j < crun; j++) {
      const fcStart = wd.readUInt32LE(page + j * 4);
      const fcEnd = wd.readUInt32LE(page + (j + 1) * 4);
      const bOffset = wd[page + (crun + 1) * 4 + j * 13];
      const props: ParaProps = { ...NO_PROPS };
      if (bOffset !== 0) {
        let p = page + bOffset * 2;
        let len: number;
        const cb = wd[p];
        if (cb !== 0) {
          len = 2 * cb - 1;
          p += 1;
        } else {
          len = 2 * wd[p + 1];
          p += 2;
        }
        const end = Math.min(p + len, page + 511);
        parseSprms(wd, p + 2 /* istd */, end, props);
      }
      runs.push({ fcStart, fcEnd, ...props });
    }
  }
  return runs.sort((a, b) => a.fcStart - b.fcStart);
}

function parseSprms(buf: Buffer, start: number, end: number, props: ParaProps): void {
  let p = start;
  while (p + 2 <= end) {
    const sprm = buf.readUInt16LE(p);
    p += 2;
    let size: number;
    switch (sprm >> 13) {
      case 0:
      case 1:
        size = 1;
        break;
      case 2:
      case 4:
      case 5:
        size = 2;
        break;
      case 3:
        size = 4;
        break;
      case 7:
        size = 3;
        break;
      default: {
        // spra 6 — variable length operand.
        if (p >= end) return;
        if (sprm === SPRM_T_DEF_TABLE || sprm === SPRM_T_DEF_TABLE10) {
          if (p + 2 > end) return;
          size = buf.readUInt16LE(p) + 1;
        } else if (sprm === SPRM_P_CHG_TABS && buf[p] === 255) {
          return; // rare long form; nothing we need follows reliably
        } else {
          size = buf[p] + 1;
        }
      }
    }
    if (p + size > end) return;
    if (sprm === SPRM_P_F_IN_TABLE) props.inTable = buf[p] !== 0;
    else if (sprm === SPRM_P_F_TTP) props.ttp = buf[p] !== 0;
    else if (sprm === SPRM_P_F_INNER_TTP) props.innerTtp = buf[p] !== 0;
    else if (sprm === SPRM_P_ITAP) props.itap = buf.readInt32LE(p);
    p += size;
  }
}

function findRun(runs: ParaRun[], fc: number): ParaRun | null {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = runs[mid];
    if (fc < r.fcStart) hi = mid - 1;
    else if (fc >= r.fcEnd) lo = mid + 1;
    else return r;
  }
  return null;
}

/**
 * Walk the character stream and build tables + loose paragraphs.
 * `propsAt(fc)` returns the paragraph properties of the paragraph whose
 * mark sits at file offset `fc`.
 */
function assemble(
  codes: number[],
  fcs: number[],
  propsAt: (fc: number) => ParaProps,
): LegacyDocContent {
  const tables: string[][][] = [];
  const paragraphs: string[] = [];
  let table: string[][] | null = null;
  let row: string[] = [];
  let cellParts: string[] = [];
  let para = '';
  const fieldStack: Array<'instr' | 'result'> = [];
  // How many open fields are still in their instruction part (kept as a
  // count: `fieldStack.includes` per character is quadratic on a crafted
  // run of unclosed field marks).
  let openInstr = 0;

  const closeTable = () => {
    if (row.length > 0) {
      table = table ?? [];
      table.push(row);
    }
    row = [];
    if (table && table.length > 0) tables.push(table);
    table = null;
  };

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    // Fields: 0x13 begin · 0x14 separator · 0x15 end. Drop the
    // instruction part, keep the visible result.
    if (code === 0x13) {
      fieldStack.push('instr');
      openInstr++;
      continue;
    }
    if (code === 0x14) {
      if (fieldStack.length && fieldStack[fieldStack.length - 1] === 'instr') {
        fieldStack[fieldStack.length - 1] = 'result';
        openInstr--;
      }
      continue;
    }
    if (code === 0x15) {
      if (fieldStack.pop() === 'instr') openInstr--;
      continue;
    }
    if (openInstr > 0) continue;

    if (code !== 0x0d && code !== 0x07) {
      para += charFor(code);
      continue;
    }

    const props = propsAt(fcs[i]);
    const depth = props.itap > 0 ? props.itap : props.inTable || props.ttp ? 1 : 0;

    if (depth >= 2) {
      // Nested table content folds into the enclosing cell.
      para += ' ';
      continue;
    }
    if (code === 0x07 && props.ttp) {
      // Row end. Any stray text on the row mark itself is ignored.
      para = '';
      if (cellParts.length > 0) {
        row.push(cleanCell(cellParts.join(' ')));
        cellParts = [];
      }
      if (row.length > 0) {
        table = table ?? [];
        table.push(row);
      }
      row = [];
      continue;
    }
    if (code === 0x07) {
      cellParts.push(para);
      para = '';
      row.push(cleanCell(cellParts.join(' ')));
      cellParts = [];
      continue;
    }
    // 0x0D paragraph mark.
    if (depth === 1) {
      cellParts.push(para);
      para = '';
      continue;
    }
    if (table || row.length > 0) closeTable();
    const text = cleanCell(para);
    if (text) paragraphs.push(text);
    para = '';
  }
  if (table || row.length > 0) closeTable();
  const tail = cleanCell(para);
  if (tail) paragraphs.push(tail);
  return { tables: tables.map(dropEmptyRows).filter((t) => t.length > 0), paragraphs };
}

/**
 * Fallback when the paragraph properties could not be read: infer rows
 * from the cell marks alone. A row of N cells is N cell marks followed
 * by an empty row mark, so inside one run of table text every (N+1)-th
 * segment is empty. Pick the smallest N for which that holds.
 */
function assembleWithoutProps(codes: number[]): LegacyDocContent {
  const text = codes
    .filter((c) => c !== 0x13 && c !== 0x14 && c !== 0x15)
    .map((c) => (c === 0x0d || c === 0x07 ? String.fromCharCode(c) : charFor(c)))
    .join('');
  const tables: string[][][] = [];
  const paragraphs: string[] = [];
  // Split into blocks: a table block is a maximal stretch containing 0x07.
  const segments = text.split(/(\x07|\r)/);
  let block: string[] = [];
  let current = '';
  const flushBlock = () => {
    if (block.length === 0) return;
    const rows = rowsFromCells(block);
    if (rows.length > 0) tables.push(rows);
    block = [];
  };
  for (const s of segments) {
    if (s === '\x07') {
      block.push(current);
      current = '';
    } else if (s === '\r') {
      if (block.length > 0 && current === '') continue;
      flushBlock();
      const t = cleanCell(current);
      if (t) paragraphs.push(t);
      current = '';
    } else {
      current += s;
    }
  }
  if (block.length > 0) {
    if (current) block.push(current);
    flushBlock();
  } else if (cleanCell(current)) {
    paragraphs.push(cleanCell(current));
  }
  return { tables, paragraphs };
}

function rowsFromCells(segments: string[]): string[][] {
  for (let n = 1; n < Math.min(segments.length, 64); n++) {
    if (segments.length % (n + 1) !== 0) continue;
    let ok = true;
    for (let k = n; k < segments.length; k += n + 1) {
      if (cleanCell(segments[k]) !== '') {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const rows: string[][] = [];
    for (let s = 0; s < segments.length; s += n + 1) {
      rows.push(segments.slice(s, s + n).map(cleanCell));
    }
    return dropEmptyRows(rows);
  }
  return dropEmptyRows(segments.map((s) => [cleanCell(s)]));
}

function dropEmptyRows(rows: string[][]): string[][] {
  return rows.filter((r) => r.some((c) => c !== ''));
}

function charFor(code: number): string {
  switch (code) {
    case 0x01: // picture anchor
    case 0x02: // footnote reference
    case 0x05: // annotation reference
    case 0x08: // drawn object anchor
    case 0x1f: // optional hyphen
      return '';
    case 0x09: // tab
    case 0x0b: // line break
    case 0x0c: // page / section break
    case 0xa0: // no-break space
      return ' ';
    case 0x1e: // non-breaking hyphen
      return '-';
    default:
      return code < 0x20 ? '' : String.fromCharCode(code);
  }
}

function cleanCell(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
