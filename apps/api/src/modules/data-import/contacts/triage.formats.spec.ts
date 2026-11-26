/**
 * BM2-28 (QA6) — every upload format the contacts wizard accepts, with
 * synthetic fixtures generated in the spec (no client data in the repo).
 *
 * The failures these cover were found by running every file of the
 * client's real `projects_contacts` folder through the parse / preview
 * code locally: UTF-8 BOM CSVs turned into replacement characters (a
 * forced UTF-8 code page), UTF-16 exports and ODF files rejected as
 * unknown or "generic ZIP", legacy Word .doc renamed .docx failing,
 * Office zips whose `xl/` entry sits past the first 16 KB, sheets whose
 * used range runs to column XFD, phones losing their leading zero.
 */
import { randomBytes } from 'crypto';
import * as XLSX from 'xlsx';

import { ContactsTriageService, ExtractedSheet, TriageResult, sniffMagicBytes } from './triage.service';
import { ContactsHeaderDetectionService, NO_HEADER_ROW } from './header-detection.service';
import { matchHeaderToField } from './header-dictionary';
import { ContactsSplitMergeService } from './split-merge.service';
import { ContactsDedupService } from './dedup.service';
import { ContactsResolveService } from './resolve.service';
import { readLegacyDoc } from './legacy-doc-reader';
import { decodeMimeWords, decodeText } from './text-decoding';
import { parseDelimitedText } from './csv-reader';
import {
  HEBREW_HEADER,
  PEOPLE,
  docTableLayout,
  docxBuffer,
  legacyDocBuffer,
  odtBuffer,
  storedZipBuffer,
  workbookBuffer,
  zipBuffer,
} from '../../../testing/contacts-import-fixtures';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cptable = require('xlsx/dist/cpexcel.js');

let mockPdfText = '';
jest.mock('pdf-parse', () => ({
  PDFParse: class {
    async getText() {
      return { text: mockPdfText, total: 1 };
    }
  },
}));

const triage = new ContactsTriageService();
const headers = new ContactsHeaderDetectionService();

function sheetsOf(r: TriageResult): ExtractedSheet[] {
  if (r.kind === 'reject') throw new Error(`unexpected reject: ${r.reason}`);
  return r.sheets;
}

const csvText = [HEBREW_HEADER, ...PEOPLE].map((r) => r.join(',')).join('\r\n') + '\r\n';

describe('spreadsheets', () => {
  it.each([
    ['xlsx', 'xlsx'],
    ['biff8', 'xls'],
    ['ods', 'ods'],
  ] as const)('%s workbook → %s reader, Hebrew header auto-mapped', async (bookType, reader) => {
    const r = await triage.triage(workbookBuffer(bookType), `contacts.${reader}`);
    expect(r).toMatchObject({ kind: 'tabular', reader });
    const [sheet] = sheetsOf(r);
    expect(sheet.rows[0]).toEqual(HEBREW_HEADER);
    expect(sheet.rows[1][0]).toBe('Test Person 1');
    const [grade] = headers.grade([sheet]);
    expect(grade.verdict).toBe('auto');
    expect(grade.mapping).toMatchObject({ contact: 0, company: 1, email: 2, phone: 3 });
  });

  it('a used range dragged to column XFD is trimmed to the cells that hold data', async () => {
    const ws: XLSX.WorkSheet = {
      '!ref': 'A1:XFD5',
      A1: { t: 's', v: 'Name' },
      B1: { t: 's', v: 'Email' },
      A2: { t: 's', v: 'Test Person 1' },
      B2: { t: 's', v: 'test1@example.com' },
    };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Wide');
    const r = await triage.triage(Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })));
    const [sheet] = sheetsOf(r);
    expect(sheet.rows).toEqual([
      ['Name', 'Email'],
      ['Test Person 1', 'test1@example.com'],
    ]);
  });

  it('an empty sheet next to a data sheet does not crash; it is graded "empty"', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Empty');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEBREW_HEADER, ...PEOPLE]), 'Data');
    const r = await triage.triage(Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })));
    const sheets = sheetsOf(r);
    expect(sheets[0]).toEqual({ name: 'Empty', rows: [] });
    const grades = headers.grade(sheets);
    expect(grades[0]).toMatchObject({ verdict: 'non-contact', reason: 'The sheet is empty.' });
    expect(grades[1].verdict).toBe('auto');
  });

  it('an xlsx whose first zip entry is a big file is still an xlsx (central directory, not a 16 KB peek)', () => {
    const noise = randomBytes(40 * 1024);
    const buf = storedZipBuffer([
      ['a-media/image1.bin', noise],
      ['[Content_Types].xml', '<Types/>'],
      ['xl/workbook.xml', '<workbook/>'],
    ]);
    // The old probe only looked at these first 16 KB.
    expect(buf.subarray(0, 16 * 1024).toString('binary').includes('xl/')).toBe(false);
    expect(sniffMagicBytes(buf)).toBe('xlsx');
  });
});

describe('CSV: encodings, delimiters, cells kept as typed', () => {
  const expectHebrewCsv = async (buf: Buffer) => {
    const r = await triage.triage(buf, 'contacts.csv');
    expect(r).toMatchObject({ kind: 'tabular', reader: 'csv' });
    const [sheet] = sheetsOf(r);
    expect(sheet.rows[0]).toEqual(HEBREW_HEADER);
    // Leading zero kept: SheetJS used to turn 0501234567 into 501234567.
    expect(sheet.rows[1]).toEqual(PEOPLE[0]);
    expect(headers.grade([sheet])[0].verdict).toBe('auto');
  };

  it('UTF-8 with BOM (Excel "CSV UTF-8") — used to come out as replacement characters', async () => {
    await expectHebrewCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csvText, 'utf8')]));
  });

  it('UTF-8 without BOM', async () => {
    await expectHebrewCsv(Buffer.from(csvText, 'utf8'));
  });

  it('UTF-16LE with BOM', async () => {
    await expectHebrewCsv(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csvText, 'utf16le')]));
  });

  it('Windows-1255 (older Israeli tools)', async () => {
    await expectHebrewCsv(Buffer.from(cptable.utils.encode(1255, csvText)));
  });

  it('semicolon, tab, the Excel "sep=" hint, quotes, and a first cell "ID" (not SYLK)', () => {
    expect(parseDelimitedText('Name;Email\nTest Person 1;test1@example.com\n')).toEqual([
      ['Name', 'Email'],
      ['Test Person 1', 'test1@example.com'],
    ]);
    expect(parseDelimitedText('Name\tPhone\nTest Person 1\t0501234567\n')[1]).toEqual(['Test Person 1', '0501234567']);
    expect(parseDelimitedText('sep=;\nName;Email\nA;a@example.com\n')).toEqual([
      ['Name', 'Email'],
      ['A', 'a@example.com'],
    ]);
    expect(parseDelimitedText('ID,Name,Note\n1,"Person, Test","line one\nline two"\n')).toEqual([
      ['ID', 'Name', 'Note'],
      ['1', 'Person, Test', 'line one\nline two'],
    ]);
  });

  it('blank lines and trailing empty columns are dropped', () => {
    expect(parseDelimitedText('Name,Email,,\n\nTest Person 1,test1@example.com,,\n')).toEqual([
      ['Name', 'Email'],
      ['Test Person 1', 'test1@example.com'],
    ]);
  });

  it('decodeText reports the encoding it used', () => {
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x41])).encoding).toBe('utf-8');
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x41, 0x00])).encoding).toBe('utf-16le');
    expect(decodeText(Buffer.from([0xf9, 0xed])).text).toBe('שם');
  });
});

describe('HTML / "Web Page" exports', () => {
  const html = `<html><body><table><tr><td>שם</td><td>מייל</td><td>טלפון</td></tr>${PEOPLE.map(
    (p) => `<tr><td>${p[0]}</td><td>${p[2]}</td><td>${p[3]}</td></tr>`,
  ).join('')}</table></body></html>`;

  it('a UTF-16 web-page export (renamed .xlsx) is read, not rejected as unknown', async () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(html, 'utf16le')]);
    expect(sniffMagicBytes(buf)).toBe('html');
    const r = await triage.triage(buf, 'contacts.xlsx');
    expect(r).toMatchObject({ kind: 'tabular', reader: 'html-xlsx' });
    const [sheet] = sheetsOf(r);
    expect(sheet.rows[0]).toEqual(['שם', 'מייל', 'טלפון']);
    expect(sheet.rows[1]).toEqual(['Test Person 1', 'test1@example.com', '0501234567']);
  });

  it('the frameset cover page of a multi-sheet export says where the data went', async () => {
    const frameset = '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><frameset rows="*,39"><frame src="x_files/sheet001.htm"></frameset></html>';
    const r = await triage.triage(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(frameset, 'utf16le')]));
    expect(r.kind).toBe('reject');
    expect((r as any).reason).toMatch(/cover page of an Excel "Web Page" export/);
  });
});

describe('Word, LibreOffice, legacy Word', () => {
  it('docx with a table → one sheet per table', async () => {
    const r = await triage.triage(docxBuffer({ table: [HEBREW_HEADER, ...PEOPLE] }), 'c.docx');
    expect(r).toMatchObject({ kind: 'docx-tables', reader: 'docx' });
    expect(sheetsOf(r)[0].rows[2]).toEqual(PEOPLE[1]);
  });

  it('docx without tables but with contact lines → the lines as one column', async () => {
    const r = await triage.triage(
      docxBuffer({ paragraphs: ['Project team', 'Test Person 1 test1@example.com 050-1234567'] }),
    );
    expect(r).toMatchObject({ kind: 'docx-tables', reader: 'docx' });
    expect(sheetsOf(r)[0]).toEqual({
      name: 'Document text',
      rows: [['Project team'], ['Test Person 1 test1@example.com 050-1234567']],
    });
  });

  it('docx with neither tables nor contact details → a clear reason', async () => {
    const r = await triage.triage(docxBuffer({ paragraphs: ['Meeting notes', 'Nothing here'] }));
    expect(r).toEqual({
      kind: 'reject',
      reason: 'This document has no tables and no email addresses or phone numbers, so there are no contacts to import.',
    });
  });

  it('odt (LibreOffice text, renamed .docx) → tables read from content.xml', async () => {
    const buf = odtBuffer([['Name', 'Email', ''], ['Test Person 1', 'test1@example.com', '']]);
    expect(sniffMagicBytes(buf)).toBe('odt');
    const r = await triage.triage(buf, 'c.docx');
    expect(r).toMatchObject({ kind: 'docx-tables', reader: 'odt' });
    expect(sheetsOf(r)[0].rows).toEqual([
      ['Name', 'Email'],
      ['Test Person 1', 'test1@example.com'],
    ]);
  });

  it('legacy Word 97-2003 (.doc renamed .docx) → table rows and cells', async () => {
    const layout = [
      { text: 'Project contacts', kind: 'para' as const },
      ...docTableLayout([['שם', 'מייל', 'טלפון']]),
      { text: 'Test Person 1', kind: 'cell' as const },
      // A hyperlink field: the instruction is dropped, the result kept.
      { text: '\x13 HYPERLINK "mailto:test1@example.com" \x14test1@example.com\x15', kind: 'cell' as const },
      { text: 'Line A', kind: 'cellPara' as const },
      { text: 'Line B', kind: 'cell' as const },
      { text: '', kind: 'row' as const },
      ...docTableLayout([['בדיקה שתיים', 'test2@example.com', '']]),
      { text: 'Footer text', kind: 'para' as const },
    ];
    const buf = legacyDocBuffer(layout);
    expect(sniffMagicBytes(buf)).toBe('doc');
    const r = await triage.triage(buf, 'c.docx');
    expect(r).toMatchObject({ kind: 'docx-tables', reader: 'doc' });
    expect(sheetsOf(r)).toEqual([
      {
        name: 'Table 1',
        rows: [
          ['שם', 'מייל', 'טלפון'],
          ['Test Person 1', 'test1@example.com', 'Line A Line B'],
          ['בדיקה שתיים', 'test2@example.com', ''],
        ],
      },
    ]);
    expect(readLegacyDoc(buf).paragraphs).toEqual(['Project contacts', 'Footer text']);
  });

  it('legacy Word without readable paragraph properties falls back to the cell marks', () => {
    const buf = legacyDocBuffer(docTableLayout([['Name', 'Email'], ['Test Person 1', 'test1@example.com']]), {
      withParagraphProps: false,
    });
    expect(readLegacyDoc(buf).tables).toEqual([
      [
        ['Name', 'Email'],
        ['Test Person 1', 'test1@example.com'],
      ],
    ]);
  });

  it('a password-protected legacy Word file is rejected in words', async () => {
    const r = await triage.triage(legacyDocBuffer(docTableLayout([['a']]), { encrypted: true }));
    expect(r).toEqual({
      kind: 'reject',
      reason: 'This Word file is password-protected. Remove the password in Word, save, and upload again.',
    });
  });
});

describe('PDF', () => {
  // pdfjs (inside pdf-parse) loads its worker with a dynamic import that
  // jest cannot run without --experimental-vm-modules, so the text layer
  // is stubbed here and these tests cover what we do with the text. The
  // real pdfjs path was exercised on every real PDF of the client's
  // folder (154 files) by the out-of-tree harness.
  const pdf = Buffer.from('%PDF-1.4\n%synthetic\n');

  it('an email-printout PDF yields its recipients as Name / Email rows', async () => {
    mockPdfText = 'Subject: Project contacts\nTo: Test Person 1 <test1@example.com>, Test Person 2 <test2@example.com>\n';
    expect(sniffMagicBytes(pdf)).toBe('pdf');
    const r = await triage.triage(pdf, 'contacts.pdf');
    expect(r).toMatchObject({ kind: 'pdf', reader: 'pdf' });
    expect(sheetsOf(r)[0].rows).toEqual([
      ['Name', 'Email'],
      ['Test Person 1', 'test1@example.com'],
      ['Test Person 2', 'test2@example.com'],
    ]);
  });

  it('a PDF table (tab-separated text layer) becomes a grid with an auto header', async () => {
    mockPdfText = ['Project contacts', 'שם\tחברה\tמייל\tטלפון', ...PEOPLE.map((p) => p.join('\t'))].join('\n');
    const r = await triage.triage(pdf, 'contacts.pdf');
    const [sheet] = sheetsOf(r);
    expect(sheet.name).toBe('PDF Table');
    expect(sheet.rows[1]).toEqual(HEBREW_HEADER);
    expect(headers.grade([sheet])[0]).toMatchObject({ verdict: 'auto', headerRowIndex: 1 });
  });

  it('a scanned PDF (no text layer) is rejected in words', async () => {
    mockPdfText = '  \n ';
    const r = await triage.triage(pdf, 'scan.pdf');
    expect(r.kind).toBe('reject');
    expect((r as any).reason).toMatch(/no text the wizard can read/);
  });
});

describe('raw email message saved as a spreadsheet', () => {
  it('reads the To / Cc / From recipients, decoding encoded Hebrew names', async () => {
    const hebrewName = `=?UTF-8?B?${Buffer.from('בדיקה אחת', 'utf8').toString('base64')}?=`;
    const eml = [
      'Delivered-To: inbox@example.com',
      // Gmail puts dozens of transport headers before From / To.
      ...Array.from({ length: 40 }, (_, i) => `X-Transport-${i}: hop ${i}\r\n\tcontinued; id=${i}`),
      'Received: by 10.0.0.1 with SMTP id x; Mon, 1 Jan 2024 10:00:00 +0000',
      'From: "Test Sender" <sender@example.com>',
      `To: ${hebrewName} <test1@example.com>,`,
      ' Test Person 2 <test2@example.com>',
      'Cc: test3@example.com',
      'Subject: Contacts',
      '',
      'Body mentions other@example.com',
    ].join('\r\n');
    const r = await triage.triage(Buffer.from(eml, 'utf8'), 'contacts.xlsx');
    expect(r).toMatchObject({ kind: 'tabular', reader: 'eml' });
    expect(sheetsOf(r)[0].rows).toEqual([
      ['Name', 'Email'],
      ['Test Sender', 'sender@example.com'],
      ['בדיקה אחת', 'test1@example.com'],
      ['Test Person 2', 'test2@example.com'],
      ['', 'test3@example.com'],
    ]);
  });

  it('decodeMimeWords handles B and Q encodings', () => {
    expect(decodeMimeWords('=?utf-8?Q?Test_Person?= <a@example.com>')).toBe('Test Person <a@example.com>');
  });
});

describe('non-data files are rejected with a reason, never a crash', () => {
  it.each([
    ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), /image \(PNG\)/],
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), /image \(JPEG\)/],
    ['ICO', Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]), /image \(ICO\)/],
    ['draw.io', Buffer.from('<mxfile host="x"><diagram/></mxfile>\n'), /draw\.io diagram/],
    ['zip archive', zipBuffer([['folder/report.pdf', Buffer.from('%PDF-1.4')]]), /ZIP archive/],
    ['pptx', zipBuffer([['[Content_Types].xml', '<Types/>'], ['ppt/presentation.xml', '<p/>']]), /PowerPoint/],
    ['empty', Buffer.alloc(0), /empty/],
  ])('%s', async (_label, buf, reason) => {
    const r = await triage.triage(buf as Buffer);
    expect(r.kind).toBe('reject');
    expect((r as any).reason).toMatch(reason as RegExp);
    expect((r as any).reason).not.toMatch(/[–—]/);
  });
});

describe('header detection', () => {
  it('reversed-word Hebrew headers from PDFs still match', () => {
    expect(matchHeaderToField('קשר איש')).toBe('contact');
    expect(matchHeaderToField('חברה שם')).toBe('company');
    expect(matchHeaderToField('משרד טלפון')).toBe('phone');
  });

  it('"כתובת מייל" is an email column, not an address', () => {
    expect(matchHeaderToField('כתובת מייל')).toBe('email');
    expect(matchHeaderToField('כתובת')).toBe('address');
  });

  it('first / last name headers name the contact column', () => {
    expect(matchHeaderToField('שם פרטי')).toBe('contact');
    expect(matchHeaderToField('שם משפחה')).toBe('contact');
  });

  it('a fallback name header ("שם היועץ") yields to a real person column, but is used when alone', () => {
    const both = headers.grade([{ name: 's', rows: [['שם היועץ', 'איש קשר', 'מייל'], ['Example Ltd', 'Test Person 1', 'test1@example.com']] }]);
    expect(both[0].mapping.contact).toBe(1);
    const alone = headers.grade([{ name: 's', rows: [['שם היועץ', 'מייל', 'טלפון'], ['Test Person 1', 'test1@example.com', '0501234567']] }]);
    expect(alone[0].mapping.contact).toBe(0);
    // "יועץ" on its own (often the consultant type) is not a name column.
    expect(matchHeaderToField('יועץ')).toBeNull();
  });
});

describe('a headerless email list goes through Preview without losing its first row', () => {
  const emptyModel = new Proxy({}, { get: (_t, op) => async () => (String(op) === 'findMany' ? [] : null) });
  const prisma: any = new Proxy({}, { get: () => emptyModel });
  const bp: any = new Proxy({}, { get: (_t, op) => (op === 'getHomeOrg' ? async () => null : async () => null) });
  const resolve = new ContactsResolveService(
    headers,
    new ContactsSplitMergeService(),
    new ContactsDedupService(prisma, bp),
    bp,
  );

  it('grade: synthetic column names, NO_HEADER_ROW, every row counted', () => {
    const rows = [
      ['Test Person 1', 'test1@example.com'],
      ['Test Person 2', 'test2@example.com'],
      ['Test Person 3', 'test3@example.com'],
    ];
    const [g] = headers.grade([{ name: 'List', rows }]);
    expect(g).toMatchObject({
      verdict: 'headerless',
      headerRowIndex: NO_HEADER_ROW,
      headerCells: ['Column A', 'Column B'],
      mapping: { email: 1 },
      dataRowCount: 3,
    });
  });

  it('preview with the wizard mapping keeps all three rows (the first used to become the header)', async () => {
    const sheet = {
      name: 'List',
      rows: [
        ['Test Person 1', 'test1@example.com'],
        ['Test Person 2', 'test2@example.com'],
        ['Test Person 3', 'test3@example.com'],
      ],
    };
    const preview = await resolve.previewSheet({
      sheet,
      mapping: { contact: 'Column A', email: 'Column B' },
      headerRowIndex: NO_HEADER_ROW,
    });
    expect(preview.resolvedRows.map((r) => r.values.email)).toEqual([
      'test1@example.com',
      'test2@example.com',
      'test3@example.com',
    ]);
    expect(preview.resolvedRows[0].sourceRowIndex).toBe(1);
    expect(preview.summary.eligible).toBe(3);
  });

  it('a ragged PDF-like grid with addresses in one column is offered as headerless, not "not a contact list"', () => {
    // Column C: only 1 of 5 cells is a bare address (the strict >= 50%
    // rule fails), but 3 of 5 contain one.
    const rows = [
      ['Project team list'],
      ['Test Person 1', 'Example Ltd', 'test1@example.com'],
      ['Test Person 2', 'Sample Co', 'Example Ltd'],
      ['Test Person 3', 'Example Ltd', 'see test3@example.com'],
      ['Test Person 4', 'Sample Co', 'test4@example.com 2'],
      ['Test Person 5', 'Sample Co', 'Sample Co'],
    ];
    const [g] = headers.grade([{ name: 'PDF Table', rows }]);
    expect(g.verdict).toBe('headerless');
    expect(g.mapping.email).toBe(2);
  });
});
