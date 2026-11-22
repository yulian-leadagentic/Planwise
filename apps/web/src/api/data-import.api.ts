/**
 * Bulk Excel import client. Mirrors the NestJS data-import controller —
 * one endpoint per wizard step (template / validate / commit), plus
 * history and rollback. Used by the wizard at /admin/data-import.
 */
import client from './client';

export type ImportTarget = 'users' | 'partners' | 'contacts';
export type ImportMode = 'insert' | 'upsert' | 'update';
export type ImportStatus = 'parsed' | 'committed' | 'partial' | 'failed' | 'rolled_back';
export type RowOutcome = 'created' | 'updated' | 'skipped' | 'failed';

export interface ValidationRow {
  rowIndex: number;
  data: Record<string, any> | null;
  conflictsWithExisting: boolean;
  errors: Array<{ field?: string; message: string }>;
}

export interface ValidationResponse {
  filename: string;
  fileHash: string;
  headers: string[];
  expectedColumns: string[];
  canSeeFinance: boolean;
  summary: {
    total: number;
    validForInsert: number;
    conflictsExisting: number;
    errors: number;
  };
  rows: ValidationRow[];
  truncated: boolean;
}

export interface ImportRecord {
  id: number;
  userId: number;
  target: ImportTarget;
  filename: string;
  fileHash: string;
  mode: ImportMode;
  rowCount: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  status: ImportStatus;
  startedAt: string;
  finishedAt: string | null;
  rolledBackAt: string | null;
  expiresAt: string | null;
  notes: string | null;
  user?: { id: number; firstName: string; lastName: string; email: string };
}

/**
 * Permissions round 3 (2026-11-22) — initial sign-in of an account the
 * users import created. Returned ONCE by the commit call and never
 * stored server-side: the wizard's Done step is the only place it can
 * be seen or downloaded.
 */
export interface ImportedCredential {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
}

export interface CommitSummary {
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
}

export interface CommitResponse {
  import: ImportRecord;
  summary: CommitSummary;
  /** Users imports only — see ImportedCredential. */
  credentials?: ImportedCredential[];
}

export interface ImportRowRecord {
  id: number;
  importId: number;
  rowIndex: number;
  outcome: RowOutcome;
  entityId: number | null;
  errorMessage: string | null;
  afterJson: Record<string, any> | null;
}

/**
 * The API's global ResponseInterceptor wraps every payload as
 * `{ success: true, data }`; axios puts that envelope on `response.data`.
 * Unwrap defensively (same helper as contacts-import.api.ts) — before
 * this, every call below returned the envelope and the wizard / history
 * pages read `undefined` fields.
 */
function unwrap<T>(res: { data: unknown }): T {
  const body = res.data;
  return (
    body && typeof body === 'object' && 'success' in body && 'data' in body ? (body as { data: unknown }).data : body
  ) as T;
}

export const dataImportApi = {
  /** Download the Excel template as a Blob (caller saves it). */
  downloadTemplate: (target: ImportTarget) =>
    client.get(`/data-import/template/${target}`, { responseType: 'blob' }).then((r) => r.data),

  /** Upload + validate, no DB write. Returns per-row diagnostics. */
  validate: (target: ImportTarget, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return client
      .post(`/data-import/validate/${target}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => unwrap<ValidationResponse>(r));
  },

  /** Upload + actually persist. Caller passes the validated payload's
   * file again so the server re-validates (insulating from races). */
  commit: (target: ImportTarget, file: File, mode: ImportMode, notes?: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('mode', mode);
    if (notes) form.append('notes', notes);
    return client
      .post(`/data-import/commit/${target}`, form, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then((r) => unwrap<CommitResponse>(r));
  },

  history: (target?: ImportTarget) =>
    client
      .get('/data-import/history', { params: target ? { target } : {} })
      .then((r) => unwrap<ImportRecord[]>(r)),

  historyRows: (importId: number) =>
    client
      .get(`/data-import/history/${importId}/rows`)
      .then((r) => unwrap<ImportRowRecord[]>(r)),

  rollback: (importId: number) =>
    client
      .post(`/data-import/history/${importId}/rollback`)
      .then((r) =>
        unwrap<{ import: { id: number; status: ImportStatus }; deletedCount: number; restoredCount: number }>(r),
      ),
};
