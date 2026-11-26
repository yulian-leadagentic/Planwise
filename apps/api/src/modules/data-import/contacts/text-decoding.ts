/**
 * BM2-28 (QA6) · Text decoding for the contacts import wizard.
 *
 * Plain-text uploads (csv, html "web page" exports, xml, raw email) reach
 * us in whatever encoding the client's tool used. The real folder has:
 *   • UTF-8 with a BOM (Excel "CSV UTF-8") — most of the Hebrew CSVs;
 *   • UTF-8 without a BOM;
 *   • UTF-16LE with a BOM (Excel "Unicode text" / "Web page" exports);
 * and older Israeli tools still write Windows-1255.
 *
 * Previously every text file was handed to SheetJS with a forced UTF-8
 * code page, which turned a UTF-8 CSV *with* a BOM into replacement
 * characters (all Hebrew lost) and made UTF-16 files unreadable. Here we
 * decode to a JS string ourselves: BOM first, then strict UTF-8, then
 * Windows-1255 as the Hebrew legacy fallback.
 */

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1255';

export interface DecodedText {
  text: string;
  encoding: TextEncodingName;
}

export function hasUtf16Bom(buf: Buffer): 'le' | 'be' | null {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'be';
  return null;
}

/** UTF-16 without a BOM: mostly-ASCII text leaves every other byte 0. */
function looksLikeBomlessUtf16(buf: Buffer): 'le' | 'be' | null {
  const n = Math.min(buf.length - (buf.length % 2), 2048);
  if (n < 8) return null;
  let zeroOdd = 0;
  let zeroEven = 0;
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) zeroEven++;
    if (buf[i + 1] === 0) zeroOdd++;
  }
  const pairs = n / 2;
  if (zeroOdd / pairs > 0.6 && zeroEven / pairs < 0.05) return 'le';
  if (zeroEven / pairs > 0.6 && zeroOdd / pairs < 0.05) return 'be';
  return null;
}

function decodeUtf16(buf: Buffer, endian: 'le' | 'be'): string {
  const even = buf.length % 2 === 0 ? buf : buf.subarray(0, buf.length - 1);
  if (endian === 'le') return even.toString('utf16le');
  const swapped = Buffer.from(even);
  swapped.swap16();
  return swapped.toString('utf16le');
}

/** Windows-1255 (Hebrew). Node ships the WHATWG decoder with full ICU. */
export function decodeWindows1255(buf: Buffer): string {
  try {
    return new TextDecoder('windows-1255').decode(buf);
  } catch {
    // Small-ICU runtime: fall back to the code page table SheetJS bundles.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cptable = require('xlsx/dist/cpexcel.js');
    return cptable.utils.decode(1255, buf);
  }
}

/**
 * Decode a whole text upload. The BOM (if any) is stripped from the
 * returned text so the first header cell matches the dictionary.
 */
export function decodeText(buf: Buffer): DecodedText {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8' };
  }
  const bom16 = hasUtf16Bom(buf);
  if (bom16) {
    return { text: decodeUtf16(buf.subarray(2), bom16), encoding: bom16 === 'le' ? 'utf-16le' : 'utf-16be' };
  }
  const bomless16 = looksLikeBomlessUtf16(buf);
  if (bomless16) {
    return { text: decodeUtf16(buf, bomless16), encoding: bomless16 === 'le' ? 'utf-16le' : 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    return { text: decodeWindows1255(buf), encoding: 'windows-1255' };
  }
}

/**
 * Lenient decode of the first bytes, for file-type sniffing only (a
 * slice can cut a UTF-8 sequence in half, so no strict check here).
 */
export function decodePreview(buf: Buffer, maxBytes = 4096): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3, 3 + maxBytes).toString('utf8');
  }
  const bom16 = hasUtf16Bom(buf);
  if (bom16) return decodeUtf16(buf.subarray(2, 2 + maxBytes), bom16);
  const bomless16 = looksLikeBomlessUtf16(buf);
  if (bomless16) return decodeUtf16(buf.subarray(0, maxBytes), bomless16);
  return buf.subarray(0, maxBytes).toString('utf8');
}

/**
 * RFC 2047 encoded words (`=?UTF-8?B?...?=`) as found in raw email
 * headers. Adjacent encoded words are joined without the whitespace
 * between them, per the RFC.
 */
export function decodeMimeWords(value: string): string {
  const joined = value.replace(/\?=\s+=\?/g, '?==?');
  return joined.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, data: string) => {
    let bytes: Buffer;
    if (enc.toUpperCase() === 'B') {
      bytes = Buffer.from(data, 'base64');
    } else {
      const q = data.replace(/_/g, ' ');
      const out: number[] = [];
      for (let i = 0; i < q.length; i++) {
        if (q[i] === '=' && /^[0-9a-fA-F]{2}$/.test(q.slice(i + 1, i + 3))) {
          out.push(parseInt(q.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          out.push(q.charCodeAt(i) & 0xff);
        }
      }
      bytes = Buffer.from(out);
    }
    const cs = charset.toLowerCase().replace(/\*.*$/, '');
    if (cs === 'utf-8' || cs === 'utf8') return bytes.toString('utf8');
    if (cs === 'windows-1255' || cs === 'cp1255' || cs.startsWith('iso-8859-8')) {
      try {
        return new TextDecoder(cs.startsWith('iso-8859-8') ? 'iso-8859-8' : 'windows-1255').decode(bytes);
      } catch {
        return decodeWindows1255(bytes);
      }
    }
    try {
      return new TextDecoder(cs).decode(bytes);
    } catch {
      return bytes.toString('latin1');
    }
  });
}
