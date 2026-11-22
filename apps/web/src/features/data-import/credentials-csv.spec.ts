import { describe, expect, it } from 'vitest';
import { credentialsCsv, csvCell } from './credentials-csv';

describe('credentialsCsv (permissions round 3 — initial passwords download)', () => {
  it('writes a header and one quoted row per account, CRLF-separated', () => {
    const csv = credentialsCsv([
      { email: 'dana@amec.co.il', firstName: 'Dana', lastName: 'Levi', password: 'Ab3dEf7hJk9m' },
      { email: 'yossi@amec.co.il', firstName: 'יוסי', lastName: 'כהן', password: 'Zx8cVb2nMq4w' },
    ]);
    expect(csv.split('\r\n')).toEqual([
      '"Email","First Name","Last Name","Initial Password"',
      '"dana@amec.co.il","Dana","Levi","Ab3dEf7hJk9m"',
      '"yossi@amec.co.il","יוסי","כהן","Zx8cVb2nMq4w"',
    ]);
  });

  it('doubles inner quotes', () => {
    expect(csvCell('O"Brien')).toBe('"O""Brien"');
  });

  it('defuses spreadsheet formulas (CSV injection) from names in the uploaded file', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('+1')).toBe('"\'+1"');
    expect(csvCell('-2')).toBe('"\'-2"');
    expect(csvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(csvCell('plain')).toBe('"plain"');
  });
});
