import { json } from 'express';
import type { RequestHandler } from 'express';

/**
 * BM2-28 (QA6) · Size limits for the contacts import wizard, in one place
 * so the controller, the body parser, the readers and the error messages
 * agree.
 *
 * Upload cap: the client's real folder has contact PDFs of up to ~24 MB
 * (scanned or image-heavy exports). The old 5 MB cap rejected ten real
 * files before they were even opened. 25 MB covers every file in the
 * set; the wizard checks the same number before uploading.
 */
export const CONTACTS_IMPORT_MAX_FILE_BYTES = 25 * 1024 * 1024;

// ─── Cell budget (every reader) ────────────────────────────────────────
//
// Review 2 (B1) · A small file can describe a huge grid: one cell at row
// 20,001 / column 2,001 of a 1 MB xlsx made `sheet_to_json` walk 40
// million empty cells (47 s of blocked event loop, 640 MB of heap). The
// same holds for a CSV row padded to the widest row, ODF repeat
// attributes and a crafted .doc piece table. Every reader therefore
// charges the grid it builds to ONE budget per uploaded file and stops
// with a clear rejection as soon as it is exceeded.
//
// The largest real file in the client's folders is 2,213 rows, 86
// columns and 39,646 cells, so these leave a wide margin.

/** Rows per sheet (or table, or document lines). */
export const CONTACTS_IMPORT_MAX_ROWS = 20_000;
/** Columns per sheet, counted to the last column that holds a value. */
export const CONTACTS_IMPORT_MAX_COLUMNS = 200;
/** Cells per uploaded file, all sheets together (rows x columns of each grid). */
export const CONTACTS_IMPORT_MAX_CELLS = 2_000_000;

// ─── Archive limits (xlsx / docx / ods / odt are ZIP files) ───────────
//
// Review 2 (B3) · SheetJS, its CFB reader and mammoth inflate every ZIP
// entry whole. These are checked (zip-guard.ts) before any of them runs.
// Real files: at most 48 entries, 19.7 MB unpacked and a 17.5x ratio.

/** Total unpacked size of all entries. */
export const CONTACTS_IMPORT_MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;
/** Unpacked / packed ratio over the whole archive. */
export const CONTACTS_IMPORT_MAX_ZIP_RATIO = 100;
/** Below this unpacked total a high ratio cannot hurt, so it is not checked. */
export const CONTACTS_IMPORT_ZIP_RATIO_FLOOR_BYTES = 1024 * 1024;
/** Entries in the archive. */
export const CONTACTS_IMPORT_MAX_ZIP_ENTRIES = 5_000;
/**
 * Unpacked size of one Word XML part (word/document.xml, styles, ...).
 * mammoth builds a full tree of the document: a 9.7 MB document.xml took
 * 3 s and about 2 GB of heap. The largest real part is 0.35 MB.
 */
export const CONTACTS_IMPORT_MAX_DOCX_XML_BYTES = 5 * 1024 * 1024;
/**
 * Cell tags in a workbook's XML, empty formatted cells included. SheetJS
 * parses every `<c>` of the first 20,001 rows before we see the grid;
 * the largest real workbook has 313,427 (almost all empty formatting).
 */
export const CONTACTS_IMPORT_MAX_CELL_TAGS = 2 * CONTACTS_IMPORT_MAX_CELLS;
/**
 * Cells x merged ranges in an HTML table: SheetJS checks every cell
 * against every merge (16,000 `colspan` cells took 0.3 s, growing as n²).
 */
export const CONTACTS_IMPORT_MAX_HTML_SPAN_WORK = 25_000_000;
/** Text pieces in a legacy Word (.doc) piece table. */
export const CONTACTS_IMPORT_MAX_DOC_PIECES = 10_000;

/** A limit was exceeded; the message is shown to the user as-is. */
export class ContactsImportLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContactsImportLimitError';
  }
}

const n = (value: number) => value.toLocaleString('en-US');

/** "A", "B", ... "Z", "AA", ... for a 0-based column index. */
export function columnLetters(index: number): string {
  let rest = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (rest % 26)) + out;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return out;
}

export function tooManyRowsError(sheet: string): ContactsImportLimitError {
  return new ContactsImportLimitError(
    `"${sheet}" has more than ${n(CONTACTS_IMPORT_MAX_ROWS)} rows, which is more than the wizard can read. Split the list into smaller files and upload again.`,
  );
}

export function tooManyColumnsError(sheet: string): ContactsImportLimitError {
  return new ContactsImportLimitError(
    `"${sheet}" has data past column ${n(CONTACTS_IMPORT_MAX_COLUMNS)} (column ${columnLetters(CONTACTS_IMPORT_MAX_COLUMNS - 1)}), which is more than the wizard can read. Delete the extra columns, or copy the contacts to a new sheet, and upload again.`,
  );
}

export function tooManyCellTagsError(): ContactsImportLimitError {
  return new ContactsImportLimitError(
    `This file has more than ${n(CONTACTS_IMPORT_MAX_CELL_TAGS)} cells, counting empty formatted ones, which is more than the wizard can read. Delete the unused rows and columns, save, and upload again.`,
  );
}

export function tooManyCellsError(): ContactsImportLimitError {
  return new ContactsImportLimitError(
    `This file has more than ${n(CONTACTS_IMPORT_MAX_CELLS)} cells, which is more than the wizard can read. Split the list into smaller files and upload again.`,
  );
}

/**
 * Meters one sheet as its rows are built: the row count, the widest row
 * and the sheet's area (rows x widest row, the padded grid) against the
 * file's shared budget.
 */
export class SheetMeter {
  private rowCount = 0;
  private widest = 0;
  private closed = false;

  constructor(
    private readonly budget: CellBudget,
    readonly sheet: string,
  ) {}

  /** Charge one more row holding `width` cells (to its last value). */
  addRow(width: number): void {
    this.rowCount++;
    if (this.rowCount > CONTACTS_IMPORT_MAX_ROWS) throw tooManyRowsError(this.sheet);
    this.widen(width);
    this.budget.ensureRoom(this.rowCount * this.widest);
  }

  /** The current row grew to `width` cells (checked before the cells are stored). */
  widen(width: number): void {
    if (width <= this.widest) return;
    if (width > CONTACTS_IMPORT_MAX_COLUMNS) throw tooManyColumnsError(this.sheet);
    this.widest = width;
    this.budget.ensureRoom(Math.max(1, this.rowCount) * this.widest);
  }

  /** Done with this sheet: its area stays charged to the file. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.budget.commit(this.rowCount * this.widest);
  }
}

/**
 * Review 2 (B1) · One cell budget per uploaded file, shared by every
 * reader. Readers either meter rows as they build them (CSV, ODF) or
 * check a finished or planned grid in one call.
 */
export class CellBudget {
  private committed = 0;

  /** Start metering one sheet. */
  meter(sheet: string): SheetMeter {
    return new SheetMeter(this, sheet);
  }

  /** Check a grid by its shape before it is built (a worksheet range). */
  checkShape(sheet: string, rows: number, columns: number): void {
    if (rows > CONTACTS_IMPORT_MAX_ROWS) throw tooManyRowsError(sheet);
    if (columns > CONTACTS_IMPORT_MAX_COLUMNS) throw tooManyColumnsError(sheet);
    this.ensureRoom(rows * columns);
    this.commit(rows * columns);
  }

  /** Check a finished grid (rows may be ragged). */
  checkRows(sheet: string, rows: readonly (readonly unknown[])[]): void {
    const meter = this.meter(sheet);
    for (const row of rows) meter.addRow(row.length);
    meter.close();
  }

  /** @internal Throw when `pending` more cells would not fit. */
  ensureRoom(pending: number): void {
    if (this.committed + pending > CONTACTS_IMPORT_MAX_CELLS) throw tooManyCellsError();
  }

  /** @internal */
  commit(cells: number): void {
    this.committed += cells;
  }
}

// ─── Upload (multipart) ────────────────────────────────────────────────

/**
 * Multer options for the wizard's upload routes. The cap stops Multer
 * from buffering an oversized file in memory (it used to accept any
 * size and only then reject). Review 2 (B5): the form carries one file
 * part (`file`) and at most the optional `filename` text field, so the
 * part, field and field-size limits are tight too.
 */
export const CONTACTS_UPLOAD_OPTIONS = {
  limits: {
    fileSize: CONTACTS_IMPORT_MAX_FILE_BYTES,
    files: 1,
    fields: 2,
    fieldSize: 1024,
    parts: 3,
  },
};

/** The 413 message for a file over the cap (the wizard toast shows it as-is). */
export const CONTACTS_FILE_TOO_LARGE_MESSAGE = `The file is larger than ${formatMegabytes(CONTACTS_IMPORT_MAX_FILE_BYTES)}. Remove images or split the list, then upload again.`;

// ─── JSON body (Preview / Commit) ──────────────────────────────────────

/**
 * JSON cap for the later wizard steps. The pipeline is stateless: the
 * Preview and Commit calls send the whole extracted sheet back to the
 * server. Express's default JSON limit is 100 KB, so any sheet bigger
 * than that (7 of the real files) failed at Preview with
 * "413 request entity too large" after a successful upload.
 *
 * Review 2 (B4) · kept at 25 MB (a sheet at the cell budget is larger
 * than any small limit), but the body is only read for a caller with a
 * valid access token: see contactsImportAuthGate.
 */
export const CONTACTS_IMPORT_MAX_JSON = '25mb';

/** Route prefix the larger JSON limit applies to (global prefix included). */
export const CONTACTS_IMPORT_ROUTE_PREFIX = '/api/v1/data-import/contacts';

/**
 * JSON body parser for the contacts import routes only. Registered in
 * main.ts BEFORE Nest's default parser: body-parser skips a request
 * whose body was already parsed, so every other route keeps the 100 KB
 * default. The wrapper has its own function name on purpose: Nest skips
 * registering its default parser when a middleware literally named
 * `jsonParser` is already mounted, which would drop JSON parsing for
 * every other route.
 */
export function contactsImportJsonParser(): RequestHandler {
  const parser = json({ limit: CONTACTS_IMPORT_MAX_JSON });
  return function contactsImportJson(req, res, next) {
    return parser(req, res, next);
  };
}

/** Same extraction as passport-jwt's `fromAuthHeaderAsBearerToken()`. */
function bearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^\s*(\S+)\s+(\S+)\s*$/.exec(header);
  return match && match[1].toLowerCase() === 'bearer' ? match[2] : null;
}

/**
 * Review 2 (B4) · Express runs body parsers before Nest's guards, so
 * without this anyone could make the API read and parse 25 MB of JSON
 * on the import routes. Mounted in main.ts right before
 * contactsImportJsonParser: a request without a valid access token gets
 * the same 401 body the JWT guard sends, and its body is never read
 * (`Connection: close` so the socket is not drained either).
 *
 * `verifyAccessToken` checks the signature and expiry with the app's
 * JWT secret (no database). The guard still runs afterwards and does
 * the full check (user active, password-change flag, permissions).
 */
export function contactsImportAuthGate(verifyAccessToken: (token: string) => unknown): RequestHandler {
  return function contactsImportAuthGate(req, res, next) {
    const token = bearerToken(req.headers.authorization);
    let valid = false;
    if (token) {
      try {
        verifyAccessToken(token);
        valid = true;
      } catch {
        valid = false;
      }
    }
    if (valid) return next();
    res.setHeader('Connection', 'close');
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized', details: null },
    });
  };
}

export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
