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

export interface ImportRowRecord {
  id: number;
  importId: number;
  rowIndex: number;
  outcome: RowOutcome;
  entityId: number | null;
  errorMessage: string | null;
  afterJson: Record<string, any> | null;
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
      .post<ValidationResponse>(`/data-import/validate/${target}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data);
  },

  /** Upload + actually persist. Caller passes the validated payload's
   * file again so the server re-validates (insulating from races). */
  commit: (target: ImportTarget, file: File, mode: ImportMode, notes?: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('mode', mode);
    if (notes) form.append('notes', notes);
    return client
      .post<{ import: ImportRecord; summary: { createdCount: number; updatedCount: number; skippedCount: number; errorCount: number } }>(
        `/data-import/commit/${target}`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      )
      .then((r) => r.data);
  },

  history: (target?: ImportTarget) =>
    client
      .get<ImportRecord[]>('/data-import/history', { params: target ? { target } : {} })
      .then((r) => r.data),

  historyRows: (importId: number) =>
    client
      .get<ImportRowRecord[]>(`/data-import/history/${importId}/rows`)
      .then((r) => r.data),

  rollback: (importId: number) =>
    client
      .post<{ import: { id: number; status: ImportStatus }; deletedCount: number; restoredCount: number }>(
        `/data-import/history/${importId}/rollback`,
      )
      .then((r) => r.data),
};
