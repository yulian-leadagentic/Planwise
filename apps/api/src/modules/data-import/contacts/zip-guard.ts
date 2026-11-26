import { inflateRawSync } from 'zlib';

import {
  CONTACTS_IMPORT_MAX_UNZIPPED_BYTES,
  CONTACTS_IMPORT_MAX_ZIP_ENTRIES,
  CONTACTS_IMPORT_MAX_ZIP_RATIO,
  CONTACTS_IMPORT_ZIP_RATIO_FLOOR_BYTES,
  formatMegabytes,
} from './import-limits';

/**
 * Review 2 (B3) · ZIP bomb guard for the contacts import.
 *
 * xlsx, docx, ods and odt files are ZIP archives. SheetJS (`XLSX.read`,
 * `XLSX.CFB.read`) and mammoth inflate every entry whole, and the upload
 * cap is 25 MB, so a crafted archive could unpack to gigabytes. This
 * module reads the central directory itself and rejects, before any
 * reader runs:
 *   • more than 5,000 entries, ZIP64 markers, a directory that does not
 *     add up (what SheetJS and JSZip would read differs from what we
 *     checked);
 *   • a declared unpacked total over 100 MB, or over 100 times the
 *     packed size;
 *   • an entry whose deflate stream unpacks to more than its header
 *     says. The declared sizes are not trusted: SheetJS sizes its output
 *     buffer from the local header and keeps inflating past it, JSZip
 *     inflates first and compares later. Each stream is inflated once
 *     here with `maxOutputLength` set to the declared size, so this check
 *     costs at most the declared total.
 */

const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** Encryption flags: SheetJS and JSZip refuse these entries before inflating. */
const FLAGS_ENCRYPTED = 0x2041;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  /** Start of the entry's data after its local header; -1 when the local header is unreadable. */
  dataStart: number;
  localCompressedSize: number;
  localUncompressedSize: number;
  zip64: boolean;
}

export interface ZipDirectory {
  entries: ZipEntry[];
  /** Offset of the end record we read, and of the last end signature anywhere in the file. */
  eocdOffset: number;
  lastSignatureOffset: number;
  /** Entry count in the end record (SheetJS reads the "this disk" count, JSZip the total). */
  declaredCount: number;
  declaredCountThisDisk: number;
  /** Every declared entry had a valid central header. */
  complete: boolean;
  zip64: boolean;
}

/**
 * The central directory, or null when there is no end record. The end
 * record is the LAST signature that fits in the file, the one SheetJS and
 * JSZip pick too.
 */
export function readZipDirectory(buffer: Buffer): ZipDirectory | null {
  if (buffer.length < 22) return null;
  const eocd = buffer.lastIndexOf(EOCD_SIG, buffer.length - 22);
  if (eocd < 0) return null;
  const declaredCountThisDisk = buffer.readUInt16LE(eocd + 8);
  const declaredCount = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  let zip64 =
    declaredCount === 0xffff ||
    declaredCountThisDisk === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff ||
    (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG);

  const entries: ZipEntry[] = [];
  let complete = true;
  let off = cdOffset;
  for (let i = 0; i < declaredCount; i++) {
    if (off + 46 > buffer.length || buffer.readUInt32LE(off) !== CENTRAL_SIG) {
      complete = false;
      break;
    }
    const nameLen = buffer.readUInt16LE(off + 28);
    const extraLen = buffer.readUInt16LE(off + 30);
    const commentLen = buffer.readUInt16LE(off + 32);
    if (off + 46 + nameLen + extraLen > buffer.length) {
      complete = false;
      break;
    }
    const compressedSize = buffer.readUInt32LE(off + 20);
    const uncompressedSize = buffer.readUInt32LE(off + 24);
    const localOffset = buffer.readUInt32LE(off + 42);
    const entryZip64 =
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      hasExtraField(buffer, off + 46 + nameLen, extraLen, 0x0001);
    if (entryZip64) zip64 = true;

    let dataStart = -1;
    let localCompressedSize = -1;
    let localUncompressedSize = -1;
    if (localOffset + 30 <= buffer.length && buffer.readUInt32LE(localOffset) === LOCAL_SIG) {
      localCompressedSize = buffer.readUInt32LE(localOffset + 18);
      localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
      const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      if (start <= buffer.length) dataStart = start;
    }
    entries.push({
      name: buffer.subarray(off + 46, off + 46 + nameLen).toString('utf8'),
      flags: buffer.readUInt16LE(off + 8),
      method: buffer.readUInt16LE(off + 10),
      compressedSize,
      uncompressedSize,
      localOffset,
      dataStart,
      localCompressedSize,
      localUncompressedSize,
      zip64: entryZip64,
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return {
    entries,
    eocdOffset: eocd,
    lastSignatureOffset: buffer.lastIndexOf(EOCD_SIG),
    declaredCount,
    declaredCountThisDisk,
    complete,
    zip64,
  };
}

function hasExtraField(buffer: Buffer, start: number, length: number, id: number): boolean {
  let p = start;
  const end = start + length;
  while (p + 4 <= end) {
    if (buffer.readUInt16LE(p) === id) return true;
    p += 4 + buffer.readUInt16LE(p + 2);
  }
  return false;
}

/** Entry names from the ZIP central directory, or null when unreadable. */
export function zipEntryNames(buffer: Buffer): string[] | null {
  const dir = readZipDirectory(buffer);
  if (!dir) return null;
  if (!dir.complete && dir.entries.length === 0) return null;
  return dir.entries.map((e) => e.name);
}

/**
 * One entry's bytes, unpacked, or null when it is missing, unreadable or
 * would unpack to more than `maxBytes`. Never trusts the header further
 * than `maxBytes`.
 */
export function readZipEntry(buffer: Buffer, dir: ZipDirectory, name: string, maxBytes: number): Buffer | null {
  const entry = dir.entries.find((e) => e.name === name);
  if (!entry || entry.dataStart < 0 || entry.uncompressedSize > maxBytes) return null;
  if (entry.method === METHOD_STORED) {
    const end = entry.dataStart + entry.compressedSize;
    return end <= buffer.length ? buffer.subarray(entry.dataStart, end) : null;
  }
  if (entry.method !== METHOD_DEFLATE) return null;
  try {
    return inflateRawSync(buffer.subarray(entry.dataStart), { maxOutputLength: Math.max(1, maxBytes) });
  } catch {
    return null;
  }
}

export const ZIP_DAMAGED_MESSAGE =
  'Could not read this file. The file appears to be damaged. Open it, save it again, and upload the new copy.';

export type ZipInspection =
  | { ok: true; directory: ZipDirectory; read: (name: string, maxBytes: number) => Buffer | null }
  | { ok: false; reason: string };

/**
 * Check an archive before any reader opens it. On success, `read(name)`
 * gives an entry's bytes (bounded) for the extra format checks.
 * `onEntry` sees every entry's verified, unpacked bytes once (used to
 * count cell tags without unpacking twice); return a reason to reject.
 */
export function inspectZipArchive(
  buffer: Buffer,
  onEntry?: (entry: ZipEntry, data: Buffer) => string | null,
): ZipInspection {
  const dir = readZipDirectory(buffer);
  if (!dir) return { ok: false, reason: ZIP_DAMAGED_MESSAGE };
  if (dir.zip64) {
    return {
      ok: false,
      reason: 'This file uses a ZIP64 archive, which the wizard does not read. Open it, save it again as .xlsx or .docx, and upload the new copy.',
    };
  }
  if (dir.declaredCount > CONTACTS_IMPORT_MAX_ZIP_ENTRIES) {
    return {
      ok: false,
      reason: `This file holds more than ${CONTACTS_IMPORT_MAX_ZIP_ENTRIES.toLocaleString('en-US')} parts inside it, which is more than the wizard reads. Open it, save it again, and upload the new copy.`,
    };
  }
  // SheetJS loops over the "this disk" count from the last signature in
  // the file; JSZip uses the total. Both must be the directory we check.
  if (!dir.complete || dir.declaredCountThisDisk !== dir.declaredCount || dir.lastSignatureOffset !== dir.eocdOffset) {
    return { ok: false, reason: ZIP_DAMAGED_MESSAGE };
  }

  let packed = 0;
  let unpacked = 0;
  for (const e of dir.entries) {
    packed += e.compressedSize;
    unpacked += e.uncompressedSize;
  }
  if (unpacked > CONTACTS_IMPORT_MAX_UNZIPPED_BYTES) {
    return {
      ok: false,
      reason: `This file unpacks to more than ${formatMegabytes(CONTACTS_IMPORT_MAX_UNZIPPED_BYTES)}, which is more than the wizard can read. Remove images or split the list, then upload again.`,
    };
  }
  if (unpacked >= CONTACTS_IMPORT_ZIP_RATIO_FLOOR_BYTES && unpacked > CONTACTS_IMPORT_MAX_ZIP_RATIO * Math.max(1, packed)) {
    return {
      ok: false,
      reason: `This file unpacks to more than ${CONTACTS_IMPORT_MAX_ZIP_RATIO} times its size, so the wizard will not open it. Open it, save it again, and upload the new copy.`,
    };
  }

  for (const e of dir.entries) {
    if (e.dataStart < 0) return { ok: false, reason: ZIP_DAMAGED_MESSAGE };
    // SheetJS sizes its inflate buffer from the LOCAL header: it must be
    // 0 (data descriptor) or agree with the central directory we checked.
    const localSizesAgree =
      (e.localUncompressedSize === e.uncompressedSize || e.localUncompressedSize === 0) &&
      (e.localCompressedSize === e.compressedSize || e.localCompressedSize === 0);
    if (!localSizesAgree) return { ok: false, reason: ZIP_DAMAGED_MESSAGE };
    // Encrypted entries are refused by the readers before they inflate
    // anything (with their own "password-protected" message).
    if (e.flags & FLAGS_ENCRYPTED) continue;

    let data: Buffer | null = null;
    if (e.method === METHOD_STORED) {
      if (e.compressedSize !== e.uncompressedSize || e.dataStart + e.compressedSize > buffer.length) {
        return { ok: false, reason: ZIP_DAMAGED_MESSAGE };
      }
      data = buffer.subarray(e.dataStart, e.dataStart + e.compressedSize);
    } else if (e.method === METHOD_DEFLATE) {
      try {
        // The stream runs until its own end marker (the readers ignore the
        // declared packed size too), so inflate from the data start on.
        data = inflateRawSync(buffer.subarray(e.dataStart), { maxOutputLength: Math.max(1, e.uncompressedSize) });
      } catch {
        // ERR_BUFFER_TOO_LARGE (unpacks to more than declared) or a broken stream.
        return { ok: false, reason: ZIP_DAMAGED_MESSAGE };
      }
      if (data.length !== e.uncompressedSize) return { ok: false, reason: ZIP_DAMAGED_MESSAGE };
    }
    // Other methods: the readers reject them with their own error.
    if (data && onEntry) {
      const problem = onEntry(e, data);
      if (problem) return { ok: false, reason: problem };
    }
  }

  return {
    ok: true,
    directory: dir,
    read: (name: string, maxBytes: number) => readZipEntry(buffer, dir, name, maxBytes),
  };
}
