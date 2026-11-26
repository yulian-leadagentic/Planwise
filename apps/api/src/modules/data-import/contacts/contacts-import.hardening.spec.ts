/**
 * Review 2 of BM2-28 · the contacts import against crafted uploads.
 * Every input is synthetic and built here (no client data in the repo).
 *
 *   B1  one cell budget for every reader: a far-away xlsx cell, ODS
 *       repeat attributes, a wide CSV row, ODT repeats, a bad .doc piece
 *       table. Each is refused quickly with a clear reason.
 *   B2  email matching is linear: a 200k-character cell or line takes
 *       well under 50 ms, and the matches equal the old patterns'.
 *   B3  ZIP bombs are refused before SheetJS or mammoth unpack anything.
 */
import { deflateRawSync } from 'zlib';
import * as XLSX from 'xlsx';

import { ContactsTriageService, TriageResult } from './triage.service';
import { ContactsHeaderDetectionService } from './header-detection.service';
import { LegacyDocError, readLegacyDoc } from './legacy-doc-reader';
import { classifyCell } from './recognizers/classifier';
import { splitEmailCell } from './split-merge.service';
import { BARE_EMAIL_RE, EMAIL_DOMAIN, containsEmail, extractEmails, findEmails, findNamedEmails } from './email-scan';
import { inspectZipArchive } from './zip-guard';
import { isLinearSafeXml } from './markup-guard';
import { parseDelimitedText } from './csv-reader';
import { ContactsImportLimitError } from './import-limits';
import {
  HEBREW_HEADER,
  PEOPLE,
  docTableLayout,
  docxBuffer,
  legacyDocBuffer,
  odtBuffer,
  storedZipBuffer,
  workbookBuffer,
} from '../../../testing/contacts-import-fixtures';

let mockPdfText = '';
jest.mock('pdf-parse', () => ({
  PDFParse: class {
    async getText() {
      return { text: mockPdfText, total: 1 };
    }
  },
}));

const triage = new ContactsTriageService();
(triage as any).logger = { warn() {}, log() {}, error() {} };
const headers = new ContactsHeaderDetectionService();

const timings: Array<[string, number]> = [];
afterAll(() => {
  // REVIEW2_TIMINGS=1 prints the measured times (used for the review report).
  if (process.env.REVIEW2_TIMINGS) {
    console.log(timings.map(([label, ms]) => `${ms.toFixed(1).padStart(8)} ms  ${label}`).join('\n'));
  }
});

async function timed<T>(label: string, fn: () => T | Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  timings.push([label, ms]);
  return { result, ms };
}

function reasonOf(r: TriageResult): string {
  if (r.kind !== 'reject') throw new Error(`expected a reject, got ${r.kind}`);
  expect(r.reason).not.toMatch(/[–—]/);
  return r.reason;
}

const ROWS_REASON = /has more than 20,000 rows, which is more than the wizard can read\. Split the list/;
const COLUMNS_REASON = /has data past column 200 \(column GR\), which is more than the wizard can read/;
const CELLS_REASON = /This file has more than 2,000,000 cells, which is more than the wizard can read/;
const DAMAGED_REASON = 'Could not read this file. The file appears to be damaged. Open it, save it again, and upload the new copy.';
const OLD_DOC_REASON =
  'This is an old Word file (Word 97-2003) that could not be read. Open it in Word, save it as .docx, and upload again.';

/**
 * A minimal xlsx holding only the given cells (A1 notation), written by
 * hand: SheetJS's own writer would walk the whole range to build it.
 */
function sparseXlsx(cells: Record<string, string>): Buffer {
  let maxR = 0;
  let maxC = 0;
  const byRow = new Map<number, string[]>();
  for (const [addr, v] of Object.entries(cells)) {
    const { r, c } = XLSX.utils.decode_cell(addr);
    maxR = Math.max(maxR, r);
    maxC = Math.max(maxC, c);
    byRow.set(r, [...(byRow.get(r) ?? []), `<c r="${addr}" t="inlineStr"><is><t>${v}</t></is></c>`]);
  }
  const rows = [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([r, cs]) => `<row r="${r + 1}">${cs.join('')}</row>`)
    .join('');
  const ref = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return storedZipBuffer([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook ${ns} xmlns:r="${rel}"><sheets><sheet name="Contacts" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}><dimension ref="${ref}"/><sheetData>${rows}</sheetData></worksheet>`],
  ]);
}

const cell = (r: number, c: number) => XLSX.utils.encode_cell({ r, c });

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';

function odfBuffer(kind: 'text' | 'spreadsheet', body: string): Buffer {
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NS}><office:body><office:${kind}>${body}</office:${kind}></office:body></office:document-content>`;
  return storedZipBuffer([
    ['mimetype', `application/vnd.oasis.opendocument.${kind}`],
    ['content.xml', content],
  ]);
}

const textCell = (text: string, repeat?: number) =>
  `<table:table-cell office:value-type="string"${repeat ? ` table:number-columns-repeated="${repeat}"` : ''}><text:p>${text}</text:p></table:table-cell>`;

// ─── B1 · cell budget ──────────────────────────────────────────────────

describe('B1 · xlsx: the furthest filled cell no longer decides the work', () => {
  it('one cell at row 20,001 / column 2,001 of a tiny xlsx (was 47 s and 640 MB) is refused at once', async () => {
    const buf = sparseXlsx({ A1: 'Name', [cell(20000, 2000)]: 'x' });
    expect(buf.length).toBeLessThan(20 * 1024);
    const { result, ms } = await timed('xlsx cell at row 20,001 / col 2,001', () => triage.triage(buf, 'far.xlsx'));
    expect(reasonOf(result)).toMatch(ROWS_REASON);
    expect(reasonOf(result)).toMatch(/^"Contacts" has more than/);
    expect(ms).toBeLessThan(2000);
  });

  it('a cell past column 200 is refused (the range is clamped to 200 columns as well)', async () => {
    const { result, ms } = await timed('xlsx cell at row 2 / col 2,001', () =>
      triage.triage(sparseXlsx({ A1: 'Name', [cell(1, 2000)]: 'x' }), 'wide.xlsx'),
    );
    expect(reasonOf(result)).toMatch(COLUMNS_REASON);
    expect(ms).toBeLessThan(2000);
  });

  it('rows x columns past 2,000,000 cells is refused (10,001 rows x 200 columns)', async () => {
    const { result } = await timed('xlsx 10,001 x 200 range', () =>
      triage.triage(sparseXlsx({ A1: 'Name', [cell(10000, 199)]: 'x' }), 'area.xlsx'),
    );
    expect(reasonOf(result)).toMatch(CELLS_REASON);
  });

  it('exactly 20,000 rows is still read', async () => {
    const r = await triage.triage(sparseXlsx({ A1: 'Name', [cell(19999, 0)]: 'last' }), 'edge.xlsx');
    if (r.kind === 'reject') throw new Error(r.reason);
    expect(r.sheets[0].rows).toEqual([['Name'], ['last']]);
  });

  it('a workbook XML with more than 2,000,000 filled cells is refused before SheetJS parses it', async () => {
    const readSpy = jest.spyOn(require('xlsx'), 'read');
    const xml = `<worksheet><sheetData><row r="1">${'<c>1</c>'.repeat(2_000_001)}</row></sheetData></worksheet>`;
    const buf = storedZipBuffer([['xl/worksheets/sheet1.xml', xml]]);
    const { result, ms } = await timed('xlsx XML with 2,000,001 filled cells', () => triage.triage(buf, 'dense.xlsx'));
    expect(reasonOf(result)).toMatch(CELLS_REASON);
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
    expect(ms).toBeLessThan(3000);
  });

  it('more than 4,000,000 cell tags, empty formatted ones included, is refused too', async () => {
    const xml = `<worksheet><sheetData><row r="1">${'<c/>'.repeat(4_000_001)}</row></sheetData></worksheet>`;
    const r = await triage.triage(storedZipBuffer([['xl/worksheets/sheet1.xml', xml]]), 'stubs.xlsx');
    expect(reasonOf(r)).toMatch(/more than 4,000,000 cells, counting empty formatted ones/);
  });
});

describe('B1 · ODS: repeat attributes cannot multiply one cell into millions', () => {
  it('a row repeated 20,000 times holding a cell repeated 1,000 times (20 million cells in SheetJS) is refused first', async () => {
    const readSpy = jest.spyOn(require('xlsx'), 'read');
    const buf = odfBuffer(
      'spreadsheet',
      `<table:table table:name="S"><table:table-row table:number-rows-repeated="20000">${textCell('x', 1000)}</table:table-row></table:table>`,
    );
    const { result, ms } = await timed('ods row x20,000 / cell x1,000', () => triage.triage(buf, 'repeat.ods'));
    expect(reasonOf(result)).toMatch(CELLS_REASON);
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
    expect(ms).toBeLessThan(1000);
  });

  it('the trailing empty padding LibreOffice writes is fine', async () => {
    const r = await triage.triage(workbookBuffer('ods'), 'contacts.ods');
    if (r.kind === 'reject') throw new Error(r.reason);
    expect(r.sheets[0].rows[0]).toEqual(HEBREW_HEADER);
  });
});

describe('B1 · CSV: rows are metered while they are built', () => {
  const csv = (text: string) => Buffer.from(text, 'utf8');

  it('a value after a million delimiters is refused before the row is built', async () => {
    const { result, ms } = await timed('csv value after 1,000,000 commas', () =>
      triage.triage(csv(`Name,Email\nTest Person 1,${','.repeat(1_000_000)}x\n`), 'wide.csv'),
    );
    expect(reasonOf(result)).toMatch(COLUMNS_REASON);
    expect(reasonOf(result)).toMatch(/^"Sheet1"/);
    expect(ms).toBeLessThan(1000);
  });

  it('a million trailing delimiters cost nothing and are trimmed as before', async () => {
    const r = await triage.triage(csv(`Name,Email\nTest Person 1,test1@example.com${','.repeat(1_000_000)}\n`), 'trailing.csv');
    if (r.kind === 'reject') throw new Error(r.reason);
    expect(r.sheets[0].rows).toEqual([
      ['Name', 'Email'],
      ['Test Person 1', 'test1@example.com'],
    ]);
  });

  it('201 values in a row, 20,001 rows, or 10,001 rows padded to 200 columns are refused', async () => {
    const values = Array.from({ length: 201 }, (_, i) => `v${i}`).join(',');
    expect(reasonOf(await triage.triage(csv(`Name,Email\n${values}\n`), 'a.csv'))).toMatch(COLUMNS_REASON);
    const tall = 'Name,Email\n' + 'Test Person,test@example.com\n'.repeat(20_000);
    expect(reasonOf(await triage.triage(csv(tall), 'b.csv'))).toMatch(ROWS_REASON);
    const area = 'Name,Email\n' + 'x\n'.repeat(9_999) + Array.from({ length: 200 }, () => 'y').join(',') + '\n';
    expect(reasonOf(await triage.triage(csv(area), 'c.csv'))).toMatch(CELLS_REASON);
  });

  it('parseDelimitedText enforces the budget on its own too', () => {
    expect(() => parseDelimitedText(Array.from({ length: 201 }, () => 'x').join(','))).toThrow(ContactsImportLimitError);
    expect(parseDelimitedText('A,,B,,\n,C\n')).toEqual([
      ['A', '', 'B'],
      ['', 'C', ''],
    ]);
  });
});

describe('B1 · ODT: repeats and broken markup', () => {
  it('cells repeated past 200 columns are refused', async () => {
    const row = `<table:table-row>${textCell('a', 64)}${textCell('b', 64)}${textCell('c', 64)}${textCell('d', 64)}</table:table-row>`;
    const { result } = await timed('odt 4 cells x64 repeats', () =>
      triage.triage(odfBuffer('text', `<table:table table:name="T">${row}</table:table>`), 'wide.odt'),
    );
    expect(reasonOf(result)).toMatch(/^"Table 1" has data past column 200/);
  });

  it('rows repeated past 20,000 rows are refused (401 rows x 50 repeats)', async () => {
    const row = `<table:table-row table:number-rows-repeated="1000000">${textCell('Test Person')}</table:table-row>`;
    const { result, ms } = await timed('odt 401 rows x50 repeats', () =>
      triage.triage(odfBuffer('text', `<table:table table:name="T">${row.repeat(401)}</table:table>`), 'tall.odt'),
    );
    expect(reasonOf(result)).toMatch(ROWS_REASON);
    expect(ms).toBeLessThan(1000);
  });

  it('50,000 unclosed paragraphs (each rescanned the rest of the text) are refused as damaged, fast', async () => {
    const { result, ms } = await timed('odt 50,000 unclosed <text:p>', () =>
      triage.triage(odfBuffer('text', `${'<text:p>x'.repeat(50_000)}`), 'broken.odt'),
    );
    expect(reasonOf(result)).toBe(DAMAGED_REASON);
    expect(ms).toBeLessThan(1000);
  });

  it('the fixture ODT (with its 1,000-cell padding) still reads', async () => {
    const r = await triage.triage(odtBuffer([HEBREW_HEADER, ...PEOPLE]), 'contacts.odt');
    if (r.kind === 'reject') throw new Error(r.reason);
    expect(r.sheets[0].rows).toEqual([HEBREW_HEADER, ...PEOPLE]);
  });

  it('isLinearSafeXml: nesting must close in order, tables at most 4 deep', () => {
    expect(isLinearSafeXml('<a><b/><c>t</c></a>')).toBe(true);
    expect(isLinearSafeXml('<a><b></a></b>')).toBe(false);
    expect(isLinearSafeXml('<a>x < y</a>')).toBe(false);
    expect(isLinearSafeXml('<a><!-- open')).toBe(false);
    expect(isLinearSafeXml('<table:table>'.repeat(5) + '</table:table>'.repeat(5))).toBe(false);
    expect(isLinearSafeXml('<table:table>'.repeat(4) + '</table:table>'.repeat(4))).toBe(true);
  });
});

describe('B1 · legacy .doc: the piece table must be sane', () => {
  const TEXT_FC = 0x400; // where legacyDocBuffer writes its UTF-16 text
  const doc = legacyDocBuffer(docTableLayout([['Name', 'Email'], ['Test Person 1', 'test1@example.com']]));

  /** The fixture document with its piece table replaced: cps has one more entry than fcs. */
  function withPieceTable(cps: number[], fcs: number[]): Buffer {
    const cfb = XLSX.CFB.read(doc, { type: 'buffer' });
    const wdEntry = XLSX.CFB.find(cfb, 'WordDocument')!;
    const tblEntry = XLSX.CFB.find(cfb, '1Table')!;
    const wd = Buffer.from(wdEntry.content as Uint8Array);
    const bte = Buffer.from(tblEntry.content as Uint8Array).subarray(21, 33);
    const n = fcs.length;
    const plc = Buffer.alloc((n + 1) * 4 + n * 8);
    cps.forEach((cp, i) => plc.writeUInt32LE(cp, i * 4));
    fcs.forEach((fc, i) => plc.writeUInt32LE(fc, (n + 1) * 4 + i * 8 + 2));
    const head = Buffer.alloc(5);
    head[0] = 0x02;
    head.writeUInt32LE(plc.length, 1);
    const clx = Buffer.concat([head, plc]);
    wd.writeUInt32LE(clx.length, 0x9a + 33 * 8 + 4); // lcbClx
    wd.writeUInt32LE(clx.length, 0x9a + 13 * 8); // fcPlcfBtePapx follows the Clx
    const tbl = Buffer.concat([clx, bte]);
    Object.assign(wdEntry, { content: wd, size: wd.length });
    Object.assign(tblEntry, { content: tbl, size: tbl.length });
    return Buffer.from(XLSX.CFB.write(cfb, { type: 'buffer' }));
  }

  it('the fixture reads, and so does a rebuilt table of two honest, adjacent pieces', () => {
    expect(readLegacyDoc(doc).tables[0][1]).toEqual(['Test Person 1', 'test1@example.com']);
    // 45 characters of UTF-16 text at TEXT_FC, split at character 10.
    const split = readLegacyDoc(withPieceTable([0, 10, 45], [TEXT_FC, TEXT_FC + 20]));
    expect(split.tables[0][1]).toEqual(['Test Person 1', 'test1@example.com']);
  });

  it.each([
    ['CPs out of order', [0, 20, 10], [TEXT_FC, TEXT_FC + 40]],
    ['an empty piece (CP not increasing)', [0, 10, 10], [TEXT_FC, TEXT_FC + 20]],
    ['two pieces over the same bytes', [0, 10, 20], [TEXT_FC, TEXT_FC]],
    ['a piece past the end of the stream', [0, 10, 0x7fffff], [TEXT_FC, TEXT_FC + 20]],
  ])('%s: refused as damaged', async (_label, cps, fcs) => {
    const buf = withPieceTable(cps as number[], fcs as number[]);
    expect(() => readLegacyDoc(buf)).toThrow(LegacyDocError);
    expect(reasonOf(await triage.triage(buf, 'bad.doc'))).toBe(OLD_DOC_REASON);
  });

  it('10,001 pieces all reading the whole text (n_pieces x stream size) is refused at once', async () => {
    const n = 10_001;
    const cps = Array.from({ length: n + 1 }, (_, i) => i * 40);
    const fcs = Array.from({ length: n }, () => TEXT_FC);
    const buf = withPieceTable(cps, fcs);
    const { result, ms } = await timed('doc 10,001 overlapping pieces', () => triage.triage(buf, 'pieces.doc'));
    expect(reasonOf(result)).toBe(OLD_DOC_REASON);
    expect(ms).toBeLessThan(1000);
  });

  it('9,000 pieces over the same bytes (under the count cap) are refused by the overlap rule', async () => {
    const n = 9_000;
    const buf = withPieceTable(
      Array.from({ length: n + 1 }, (_, i) => i * 40),
      Array.from({ length: n }, () => TEXT_FC),
    );
    const { result, ms } = await timed('doc 9,000 overlapping pieces', () => triage.triage(buf, 'pieces.doc'));
    expect(reasonOf(result)).toBe(OLD_DOC_REASON);
    expect(ms).toBeLessThan(1000);
  });
});

// ─── B2 · linear email matching ────────────────────────────────────────

const N = 200_000;
const ADVERSARIAL: Record<string, string> = {
  'word run': 'a'.repeat(N),
  'word run + @': 'a'.repeat(N) + '@',
  'word run + <@': 'a'.repeat(N) + ' <@',
  'dotted domain': 'a@' + 'b.'.repeat(N / 2) + '!',
  '@ run': '@'.repeat(N),
  '63 chars + @': ('a'.repeat(63) + '@').repeat(N / 64),
  '63 chars + @b': ('a'.repeat(63) + '@b').repeat(Math.floor(N / 65)),
  'name <x@': 'aaaaaa <x@'.repeat(N / 10),
  'quotes': '"'.repeat(N) + '<a@b.co>',
  'spaces then <': 'a' + ' '.repeat(N) + '<a@b.co',
  'name runs <': ('b'.repeat(127) + '<').repeat(N / 128) + '@',
  'commas': ','.repeat(N) + '<a@b.co>',
  'unclosed quote': '"' + 'x'.repeat(N) + '@<',
};

const OLD = {
  inside: /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i,
  extract: /[\w.+-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+/gi,
  count: /[\w.+-]+@[\w-]+\.[a-z]{2,}/gi,
  nameEmail: /(?:"([^"]+)"|([^,<;]+?))\s*<([\w.+-]+@[\w.-]+\.[a-z]{2,})>/gi,
  bare: /(^|[\s,;])([\w.+-]+@[\w.-]+\.[a-z]{2,})(?=$|[\s,;])/gi,
};

/** Deterministic pseudo-random short strings over an alphabet full of edge cases. */
function fuzz(count: number, alphabet: string, maxLen: number): string[] {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = 1 + Math.floor(rnd() * maxLen);
    let s = '';
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    out.push(s);
  }
  return out;
}

describe('B2 · same matches as the old patterns (short text, where those patterns are fast)', () => {
  const crafted = [
    'Test Person 1 <test1@example.com>',
    'To: "Person, Test" <test2@example.co.il>, Other <o@ex-ample.com>; x@y.org',
    '<a@b.com>, <c@d.com>',
    'mail: first.last+tag@sub.example.ac.uk and second@example.com.',
    'a@b.c.com b@c.d e@f.gh',
    'x <bad@> y <ok@fine.io>',
    '"Doe <x@y.com> John" <a@b.com>',
    'name  <spaced@example.com>',
  ];
  const TOKENS = ['Test', ' ', '  ', '"', '<', '>', ',', ';', '@', '.', 'ab', 'a@b.co', '<a@b.co>', 'x.y+z@ex-ample.com', '"P, Q"', '<bad@>', 'To: '];
  let seed = 777;
  const pick = () => TOKENS[(seed = (seed * 1103515245 + 12345) % 2147483648) % TOKENS.length];
  const tokenLines = Array.from({ length: 4000 }, (_, i) => Array.from({ length: 1 + (i % 12) }, pick).join(''));
  const lines = [
    ...crafted,
    ...tokenLines,
    ...fuzz(4000, 'ab.-_+@<>",; x.co', 40),
    ...fuzz(2000, 'a"<> ,@b.cd', 24),
  ];

  it('the token lines exercise real matches', () => {
    expect(tokenLines.filter((s) => findNamedEmails(s).length > 0).length).toBeGreaterThan(500);
  });

  it('containsEmail ≡ the old "address inside" test', () => {
    for (const s of lines) expect([s, containsEmail(s)]).toEqual([s, OLD.inside.test(s)]);
  });

  it('extractEmails (Stage 4) ≡ the old extraction', () => {
    for (const s of lines) expect([s, extractEmails(s, EMAIL_DOMAIN.hostname)]).toEqual([s, s.match(OLD.extract) ?? []]);
  });

  it('the PDF address count ≡ the old count', () => {
    for (const s of lines) expect([s, findEmails(s, EMAIL_DOMAIN.single).length]).toEqual([s, (s.match(OLD.count) ?? []).length]);
  });

  it('findNamedEmails ≡ the old `Name <email>` pattern', () => {
    for (const s of lines) {
      const old: Array<[string, string]> = [];
      OLD.nameEmail.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = OLD.nameEmail.exec(s)) !== null) old.push([(m[1] ?? m[2] ?? '').trim(), m[3]]);
      expect([s, findNamedEmails(s).map((p) => [p.name.trim(), p.email])]).toEqual([s, old]);
    }
  });

  it('the bare-address pattern ≡ the old one', () => {
    const all = (re: RegExp, s: string) => {
      re.lastIndex = 0;
      const out: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)) !== null) out.push(m[2]);
      return out;
    };
    for (const s of lines) expect([s, all(BARE_EMAIL_RE, s)]).toEqual([s, all(OLD.bare, s)]);
  });
});

describe('B2 · a 200k-character cell or line takes well under 50 ms', () => {
  it.each(Object.keys(ADVERSARIAL))('%s', async (name) => {
    const s = ADVERSARIAL[name];
    const checks: Array<[string, () => unknown]> = [
      ['containsEmail', () => containsEmail(s)],
      ['findEmails dotted', () => findEmails(s, EMAIL_DOMAIN.dotted)],
      ['findEmails single (PDF count)', () => findEmails(s, EMAIL_DOMAIN.single)],
      ['extractEmails hostname (Stage 4)', () => extractEmails(s, EMAIL_DOMAIN.hostname)],
      ['findNamedEmails', () => findNamedEmails(s)],
      [
        'bare addresses',
        () => {
          BARE_EMAIL_RE.lastIndex = 0;
          while (BARE_EMAIL_RE.exec(s) !== null);
        },
      ],
      ['splitEmailCell', () => splitEmailCell(s)],
      ['classifyCell', () => classifyCell(s)],
      ['header detection (grade)', () => headers.grade([{ name: 'S', rows: [['a'], ['b'], ['c'], [s], ['d']] }])],
    ];
    for (const [label, fn] of checks) {
      // One untimed call first (Jest's VM sandbox runs cold code far more
      // slowly than node does; plain node takes 1 to 5 ms cold for these
      // inputs), then the best of three, so a GC pause from the previous
      // check does not count.
      fn();
      let best = Number.POSITIVE_INFINITY;
      for (let k = 0; k < 3; k++) {
        const t0 = process.hrtime.bigint();
        fn();
        best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
      }
      timings.push([`${label} · ${name}`, best]);
      expect([label, best < 50]).toEqual([label, true]);
    }
  });

  it('whitespace runs in a cell (the classifier\'s dash patterns were quadratic too)', async () => {
    const s = 'Test' + ' '.repeat(N) + 'Person - תל אביב' + ' '.repeat(N) + 'x';
    const { ms } = await timed('classifyCell · 400k spaces', () => classifyCell(s));
    expect(ms).toBeLessThan(50);
  });

  it('an .eml whose To: header is 200k characters long', async () => {
    const header = `To: ${'Test Person <test1@example.com>, '.repeat(6000)}${'a'.repeat(N)}`;
    const eml = Buffer.from(`Received: x\r\nFrom: Sender <sender@example.com>\r\nSubject: s\r\n${header}\r\n\r\nbody\r\n`, 'utf8');
    const { result, ms } = await timed('triage .eml with a 400k-char To: line', () => triage.triage(eml, 'mail.xlsx'));
    expect(result.kind).toBe('tabular');
    expect(ms).toBeLessThan(200);
    // the header-line work itself
    const { ms: lineMs } = await timed('findNamedEmails · 200k To: line', () => findNamedEmails(header));
    expect(lineMs).toBeLessThan(50);
  });

  it('a PDF whose text is one 200k-character line', async () => {
    mockPdfText = `To: Test Person <test1@example.com>\n${'a'.repeat(N)}@\n`;
    const { result, ms } = await timed('triage PDF with a 200k-char line', () => triage.triage(Buffer.from('%PDF-1.4\n'), 'x.pdf'));
    expect(result.kind).toBe('pdf');
    expect(ms).toBeLessThan(200);
  });

  it('Gmail continuation lines are stitched without rescanning the growing line', async () => {
    mockPdfText = 'To: ' + Array.from({ length: 19_000 }, (_, i) => `Test Person ${i} <t${i}@example.com>,`).join('\n') + '\nend';
    const { result, ms } = await timed('triage PDF with 19,000 stitched recipient lines', () =>
      triage.triage(Buffer.from('%PDF-1.4\n'), 'x.pdf'),
    );
    if (result.kind === 'reject') throw new Error(result.reason);
    expect(result.sheets[0].rows.length).toBe(19_001);
    expect(result.sheets[0].rows[1]).toEqual(['Test Person 0', 't0@example.com']);
    expect(ms).toBeLessThan(1000);
  });
});

// ─── B3 · ZIP bombs ────────────────────────────────────────────────────

interface CraftedEntry {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  /** Sizes written in the headers (default: the real ones). */
  declaredUncompressed?: number;
  localUncompressed?: number;
}

/** A ZIP written byte by byte, so its headers can lie. */
function craftedZip(entries: CraftedEntry[], opts: { eocdCount?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const packed = method === 8 ? deflateRawSync(e.data) : e.data;
    const usz = e.declaredUncompressed ?? e.data.length;
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(e.localUncompressed ?? usz, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(usz, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.eocdCount ?? entries.length, 8);
  eocd.writeUInt16LE(opts.eocdCount ?? entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const sheetXml = Buffer.from('<worksheet><sheetData/></worksheet>');

describe('B3 · ZIP bombs are refused before any reader unpacks them', () => {
  let readSpy: jest.SpyInstance;
  let mammothSpy: jest.SpyInstance;
  beforeEach(() => {
    readSpy = jest.spyOn(require('xlsx'), 'read');
    mammothSpy = jest.spyOn(require('mammoth'), 'convertToHtml');
  });
  afterEach(() => {
    readSpy.mockRestore();
    mammothSpy.mockRestore();
  });

  it('headers that claim a 3 GB entry', async () => {
    const buf = craftedZip([{ name: 'xl/worksheets/sheet1.xml', data: sheetXml, declaredUncompressed: 3_000_000_000 }]);
    const { result, ms } = await timed('zip claiming 3 GB unpacked', () => triage.triage(buf, 'bomb.xlsx'));
    expect(reasonOf(result)).toBe(
      'This file unpacks to more than 100 MB, which is more than the wizard can read. Remove images or split the list, then upload again.',
    );
    expect(readSpy).not.toHaveBeenCalled();
    expect(ms).toBeLessThan(200);
  });

  it('an honest entry 1,000 times smaller packed than unpacked (ratio over 100)', async () => {
    const buf = craftedZip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(8 * 1024 * 1024, 0x20) }]);
    expect(buf.length).toBeLessThan(80 * 1024);
    const r = await triage.triage(buf, 'ratio.xlsx');
    expect(reasonOf(r)).toBe(
      'This file unpacks to more than 100 times its size, so the wizard will not open it. Open it, save it again, and upload the new copy.',
    );
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('an entry that unpacks to more than its header says (the readers would trust the stream)', async () => {
    const buf = craftedZip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(8 * 1024 * 1024, 0x20), declaredUncompressed: 1000 }]);
    const { result, ms } = await timed('zip entry lying about its size', () => triage.triage(buf, 'liar.xlsx'));
    expect(reasonOf(result)).toBe(DAMAGED_REASON);
    expect(readSpy).not.toHaveBeenCalled();
    expect(ms).toBeLessThan(200);
  });

  it('a local header that disagrees with the central directory (SheetJS sizes its buffer from it)', async () => {
    const buf = craftedZip([{ name: 'xl/worksheets/sheet1.xml', data: sheetXml, localUncompressed: 0x7fffffff }]);
    expect(reasonOf(await triage.triage(buf, 'local.xlsx'))).toBe(DAMAGED_REASON);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('more than 5,000 entries', async () => {
    const entries = Array.from({ length: 5001 }, (_, i) => ({ name: `xl/p${i}.xml`, data: sheetXml, method: 0 as const }));
    const r = await triage.triage(craftedZip(entries), 'many.xlsx');
    expect(reasonOf(r)).toMatch(/more than 5,000 parts inside it/);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('ZIP64 markers', async () => {
    const buf = craftedZip([{ name: 'xl/worksheets/sheet1.xml', data: sheetXml }], { eocdCount: 0xffff });
    expect(reasonOf(await triage.triage(buf, 'z64.xlsx'))).toMatch(/ZIP64 archive, which the wizard does not read/);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('a Word part over 5 MB (mammoth would build a tree of it) is refused before mammoth runs', async () => {
    const big = Buffer.from(`<w:document><w:body><w:p><w:r><w:t>${'x'.repeat(5 * 1024 * 1024)}</w:t></w:r></w:p></w:body></w:document>`);
    const r = await triage.triage(craftedZip([{ name: 'word/document.xml', data: big, method: 0 }]), 'big.docx');
    expect(reasonOf(r)).toMatch(/more than 5 MB of document content/);
    expect(mammothSpy).not.toHaveBeenCalled();
  });

  it('real-shaped archives pass the check', () => {
    for (const buf of [workbookBuffer('xlsx'), docxBuffer({ table: [HEBREW_HEADER, ...PEOPLE] }), odtBuffer([HEBREW_HEADER]), workbookBuffer('ods')]) {
      expect(inspectZipArchive(buf).ok).toBe(true);
    }
  });
});
