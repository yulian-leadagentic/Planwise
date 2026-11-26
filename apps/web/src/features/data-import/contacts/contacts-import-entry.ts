/**
 * BM2-28 (QA6) · One definition of how the app reaches the contacts
 * import wizard, shared by every entry point:
 *   • Contacts page › "Import contacts"
 *   • Organizations (BP admin) › "Import contacts"
 *   • Admin › Data Import › "Customer Contacts"
 *   • Project › Team › "Import contacts (Excel)" (same wizard in a modal)
 *
 * Permission rule (mirrors the API): the wizard's routes need WRITE on
 * `data-import/contacts`, falling back to the parent `data-import` row,
 * and data-import is in the API guard's NO_ADMIN_BYPASS list. So an
 * Admin without the grant must NOT see the button: before this file the
 * pages showed it to every Admin (`isAdmin || can(...)`), and the upload
 * then failed with "You don't have permission".
 *
 * File rule (mirrors `import-limits.ts` + the triage readers): checked in
 * the browser before upload, so a wrong type or an oversized file gets a
 * clear message instead of a failed request.
 */

export const CONTACTS_IMPORT_MODULE = 'data-import/contacts';

/** The wizard lives on the Data Import page, contacts branch preselected. */
export function contactsImportHref(projectId?: number | null): string {
  const params = new URLSearchParams({ target: 'contacts' });
  if (projectId != null) params.set('projectId', String(projectId));
  return `/admin/data-import?${params.toString()}`;
}

type CanFn = (module: string, action: 'read' | 'write') => boolean;

/**
 * May this user run the contacts import? `can` is `usePermissions().can`,
 * which already walks from `data-import/contacts` up to `data-import`
 * exactly like the API's `userHasModulePermission`. No admin bypass.
 */
export function canImportContacts(can: CanFn): boolean {
  return can(CONTACTS_IMPORT_MODULE, 'write');
}

/** Same number as CONTACTS_IMPORT_MAX_FILE_BYTES on the API. */
export const CONTACTS_IMPORT_MAX_BYTES = 25 * 1024 * 1024;
export const CONTACTS_IMPORT_MAX_LABEL = '25 MB';

/** Extensions the server can read (it sniffs the real type, not the name). */
export const CONTACTS_IMPORT_EXTENSIONS = [
  '.xlsx',
  '.xls',
  '.csv',
  '.ods',
  '.docx',
  '.doc',
  '.odt',
  '.pdf',
] as const;

/** Value for the file input's `accept` attribute. */
export const CONTACTS_IMPORT_ACCEPT = [
  ...CONTACTS_IMPORT_EXTENSIONS,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.oasis.opendocument.text',
  'application/pdf',
].join(',');

export const CONTACTS_IMPORT_FORMATS_LABEL = 'Excel (.xlsx, .xls), CSV, Word (.docx, .doc), PDF, or LibreOffice (.ods, .odt)';

/**
 * Why this file cannot be uploaded, in words for the upload step; null
 * when it may go. Drag-and-drop ignores the input's `accept`, so this
 * check is the real gate on the client.
 */
export function contactsImportFileProblem(file: { name: string; size: number }): string | null {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  if (!(CONTACTS_IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
    return `"${file.name}" is not a supported file type. Upload ${CONTACTS_IMPORT_FORMATS_LABEL}.`;
  }
  if (file.size === 0) {
    return `"${file.name}" is empty (0 bytes).`;
  }
  if (file.size > CONTACTS_IMPORT_MAX_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return `"${file.name}" is ${mb} MB. The limit is ${CONTACTS_IMPORT_MAX_LABEL}: remove images or split the list, then upload again.`;
  }
  return null;
}

/**
 * Turn a failed upload request into one sentence for the upload step
 * (the toast still shows the server's own message). `status` is the HTTP
 * status, `serverMessage` the API envelope's `error.message`.
 */
export function contactsUploadErrorMessage(status: number | undefined, serverMessage?: string): string {
  if (status === 403) {
    return "You don't have permission to import contacts. Ask an administrator to give your role the \"Import Contacts\" permission.";
  }
  if (status === 413) {
    return `The file is too large for the server. The limit is ${CONTACTS_IMPORT_MAX_LABEL}.`;
  }
  if (status === 408 || status === 504) {
    return 'The server took too long to read this file. Try again, or upload a smaller file.';
  }
  if (status === undefined) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  return serverMessage ? `The upload failed: ${serverMessage}` : `The upload failed (error ${status}). Try again.`;
}
