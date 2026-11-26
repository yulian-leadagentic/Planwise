import { json } from 'express';
import type { RequestHandler } from 'express';

/**
 * BM2-28 (QA6) · Size limits for the contacts import wizard, in one place
 * so the controller, the body parser and the error messages agree.
 *
 * Upload cap: the client's real folder has contact PDFs of up to ~24 MB
 * (scanned or image-heavy exports). The old 5 MB cap rejected ten real
 * files before they were even opened. 25 MB covers every file in the
 * set; the wizard checks the same number before uploading.
 */
export const CONTACTS_IMPORT_MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Multer options for the wizard's upload routes. The cap stops Multer
 * from buffering an oversized file in memory (it used to accept any
 * size and only then reject); the controller still answers in words.
 */
export const CONTACTS_UPLOAD_OPTIONS = {
  limits: { fileSize: CONTACTS_IMPORT_MAX_FILE_BYTES, files: 1 },
};

/**
 * JSON cap for the later wizard steps. The pipeline is stateless: the
 * Preview and Commit calls send the whole extracted sheet back to the
 * server. Express's default JSON limit is 100 KB, so any sheet bigger
 * than that (7 of the real files) failed at Preview with
 * "413 request entity too large" after a successful upload.
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

export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
