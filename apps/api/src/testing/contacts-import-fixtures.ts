/**
 * BM2-28 (QA6) · Synthetic fixtures for the contacts import specs.
 *
 * Every fixture is generated in memory with made-up people ("Test Person
 * 1", example.com addresses). Real client files are never copied into
 * the repository; they are only read locally by an out-of-tree harness.
 */
import * as XLSX from 'xlsx';

export const PEOPLE = [
  ['Test Person 1', 'Example Ltd', 'test1@example.com', '0501234567'],
  ['Test Person 2', 'Example Ltd', 'test2@example.com', '0527654321'],
  ['Test Person 3', 'Sample Co', 'test3@example.com', '03-1234567'],
];

export const HEBREW_HEADER = ['שם', 'חברה', 'מייל', 'טלפון'];

/** A workbook in any SheetJS-writable format, one sheet of contacts. */
export function workbookBuffer(bookType: XLSX.BookType, rows: string[][] = [HEBREW_HEADER, ...PEOPLE]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Contacts');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType }));
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A stored (uncompressed) ZIP whose entries are written exactly in the
 * given order, for tests that depend on the byte layout.
 */
export function storedZipBuffer(entries: Array<[string, Buffer | string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of entries) {
    const data = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** A ZIP with the given entries, written by SheetJS' cfb (which may reorder them). */
export function zipBuffer(entries: Array<[string, Buffer | string]>): Buffer {
  const zip = XLSX.CFB.utils.cfb_new();
  for (const [name, content] of entries) {
    XLSX.CFB.utils.cfb_add(zip, name, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  }
  return Buffer.from(XLSX.CFB.write(zip, { fileType: 'zip', type: 'buffer' }));
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Minimal .docx: optional table (rows of cells) plus loose paragraphs. */
export function docxBuffer(opts: { table?: string[][]; paragraphs?: string[] }): Buffer {
  const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(t)}</w:t></w:r></w:p>`;
  const table = opts.table
    ? `<w:tbl>${opts.table
        .map((r) => `<w:tr>${r.map((c) => `<w:tc>${p(c)}</w:tc>`).join('')}</w:tr>`)
        .join('')}</w:tbl>`
    : '';
  const body = (opts.paragraphs ?? []).map(p).join('') + table;
  return zipBuffer([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ],
  ]);
}

/** Minimal OpenDocument text with one table. */
export function odtBuffer(table: string[][]): Buffer {
  const rows = table
    .map(
      (r) =>
        `<table:table-row>${r
          .map((c) =>
            c
              ? `<table:table-cell office:value-type="string"><text:p>${xmlEscape(c)}</text:p></table:table-cell>`
              : '<table:table-cell/>',
          )
          .join('')}<table:table-cell table:number-columns-repeated="1000"/></table:table-row>`,
    )
    .join('');
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>Project contacts</text:p><table:table table:name="T1">${rows}</table:table></office:text></office:body></office:document-content>`;
  return zipBuffer([
    ['mimetype', 'application/vnd.oasis.opendocument.text'],
    ['content.xml', content],
    ['META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>'],
  ]);
}

/**
 * A Word 97-2003 binary document (MS-DOC), built byte by byte: a FIB, one
 * uncompressed UTF-16 text piece, and one PAPX FKP page that marks the
 * table cell paragraphs (sprmPFInTable) and the row-end marks
 * (sprmPFTtp). Each entry of `layout` is one paragraph:
 *   { text, kind: 'para' | 'cell' | 'cellPara' | 'row' }
 * 'cell' ends with a cell mark (0x07), 'row' is the row-end mark (0x07,
 * TTP), 'para' / 'cellPara' end with 0x0D (outside / inside a table).
 */
export type DocPara = { text: string; kind: 'para' | 'cell' | 'cellPara' | 'row' };

export function legacyDocBuffer(layout: DocPara[], opts: { encrypted?: boolean; withParagraphProps?: boolean } = {}): Buffer {
  const withProps = opts.withParagraphProps !== false;
  const TEXT_FC = 0x400;
  let text = '';
  const paraBounds: Array<{ start: number; end: number; kind: DocPara['kind'] }> = [];
  for (const p of layout) {
    const start = text.length;
    text += p.text + (p.kind === 'cell' || p.kind === 'row' ? '\x07' : '\r');
    paraBounds.push({ start, end: text.length, kind: p.kind });
  }
  if (paraBounds.length > 20) throw new Error('fixture supports up to 20 paragraphs');
  const textBytes = Buffer.from(text, 'utf16le');
  const fkpOffset = Math.ceil((TEXT_FC + textBytes.length) / 512) * 512;
  const wd = Buffer.alloc(fkpOffset + 512);

  // ── FIB ──
  wd.writeUInt16LE(0xa5ec, 0x00); // wIdent
  wd.writeUInt16LE(0x00c1, 0x02); // nFib (Word 97)
  wd.writeUInt16LE(0x0200 | (opts.encrypted ? 0x0100 : 0), 0x0a); // fWhichTblStm → 1Table
  wd.writeUInt16LE(14, 0x20); // csw
  wd.writeUInt16LE(22, 0x3e); // cslw
  wd.writeInt32LE(text.length, 0x40 + 12); // ccpText
  wd.writeUInt16LE(93, 0x98); // cbRgFcLcb
  const fcLcb = (index: number, fc: number, lcb: number) => {
    wd.writeUInt32LE(fc, 0x9a + index * 8);
    wd.writeUInt32LE(lcb, 0x9a + index * 8 + 4);
  };
  textBytes.copy(wd, TEXT_FC);

  // ── Table stream: Clx (one piece) + PlcBtePapx (one FKP) ──
  const clx = Buffer.alloc(1 + 4 + 16);
  clx[0] = 0x02;
  clx.writeUInt32LE(16, 1);
  clx.writeUInt32LE(0, 5); // CP 0
  clx.writeUInt32LE(text.length, 9); // CP end
  clx.writeUInt16LE(0, 13); // PCD flags
  clx.writeUInt32LE(TEXT_FC, 15); // fc, uncompressed
  clx.writeUInt16LE(0, 19); // prm
  const bte = Buffer.alloc(12);
  bte.writeUInt32LE(TEXT_FC, 0);
  bte.writeUInt32LE(TEXT_FC + textBytes.length, 4);
  bte.writeUInt32LE(fkpOffset / 512, 8);
  const tbl = Buffer.concat([clx, bte]);
  fcLcb(33, 0, clx.length);
  fcLcb(13, withProps ? clx.length : 0, withProps ? bte.length : 0);

  // ── PAPX FKP page ──
  const crun = paraBounds.length;
  const page = wd.subarray(fkpOffset, fkpOffset + 512);
  paraBounds.forEach((p, j) => page.writeUInt32LE(TEXT_FC + 2 * p.start, j * 4));
  page.writeUInt32LE(TEXT_FC + 2 * paraBounds[crun - 1].end, crun * 4);
  // In-table PAPX at 0x1C0: cb=3 → 5 bytes: istd(2) + sprmPFInTable(3).
  Buffer.from([3, 0, 0, 0x16, 0x24, 1]).copy(page, 0x1c0);
  // TTP PAPX at 0x1D0: cb=0, cb'=4 → 8 bytes: istd + InTable + Ttp.
  Buffer.from([0, 4, 0, 0, 0x16, 0x24, 1, 0x17, 0x24, 1]).copy(page, 0x1d0);
  paraBounds.forEach((p, j) => {
    const bx = (crun + 1) * 4 + j * 13;
    page[bx] = p.kind === 'para' ? 0 : p.kind === 'row' ? 0x1d0 / 2 : 0x1c0 / 2;
  });
  page[511] = crun;

  const cfb = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(cfb, 'WordDocument', wd);
  XLSX.CFB.utils.cfb_add(cfb, '1Table', tbl);
  return Buffer.from(XLSX.CFB.write(cfb, { type: 'buffer' }));
}

/** Build the layout for a simple table: header row + data rows. */
export function docTableLayout(rows: string[][]): DocPara[] {
  const out: DocPara[] = [];
  for (const r of rows) {
    for (const c of r) out.push({ text: c, kind: 'cell' });
    out.push({ text: '', kind: 'row' });
  }
  return out;
}
