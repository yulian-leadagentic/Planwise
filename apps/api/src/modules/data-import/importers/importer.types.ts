/**
 * Contract shared by all per-entity importers (users, partners,
 * contacts). The controller orchestrates parse → validate → commit
 * against this interface, so adding a new importer in a later phase
 * means implementing this and registering it in the module — no
 * controller changes.
 */

import { DataImportMode, DataImportTarget } from '@prisma/client';

/**
 * Outcome of validating a single source-file row, BEFORE we hit the
 * database. `data` is the normalized, ready-to-write shape (FK lookups
 * already resolved, dates parsed, etc.). `errors` is a list of human
 * messages keyed to the column when possible — the wizard highlights
 * the exact cell.
 */
export interface ValidatedRow<TData = unknown> {
  /** 1-based row index in the spreadsheet (excluding header). */
  rowIndex: number;
  /** Normalized data ready for create/update, or null if validation failed. */
  data: TData | null;
  /** True if this row's unique key matches an existing record. */
  conflictsWithExisting: boolean;
  errors: Array<{
    /** The header (or field name) the error is about, when known. */
    field?: string;
    message: string;
  }>;
}

export interface ValidationContext {
  /** When false, the importer strips finance-only columns like hourlyRate. */
  canSeeFinance: boolean;
}

export interface CommitResult {
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
}

export interface EntityImporter<TData = unknown> {
  readonly target: DataImportTarget;
  /** Headers that appear in the downloadable template, in order. */
  readonly templateColumns: string[];
  /**
   * Build a downloadable .xlsx with headers + one example row +
   * column-level dropdowns when applicable (role names, seniority
   * names, etc.).
   */
  generateTemplate(): Promise<Buffer>;
  /**
   * Validate every source row. The result includes per-row outcomes so
   * the wizard can render a full preview WITHOUT writing anything to
   * the DB. Idempotent.
   */
  validateRows(
    rows: Array<Record<string, string>>,
    ctx: ValidationContext,
  ): Promise<Array<ValidatedRow<TData>>>;
  /**
   * Persist the validated rows inside a single transaction. Tags every
   * created entity with `importId` for later rollback. Skipped/failed
   * rows are recorded in data_import_rows but don't break the txn.
   */
  commit(args: {
    importId: number;
    rows: Array<ValidatedRow<TData>>;
    mode: DataImportMode;
    userId: number;
  }): Promise<CommitResult>;
  /**
   * Reverse an import. For insert-only mode, deletes every entity row
   * tagged with this importId. For upsert (M2+), also restores
   * beforeJson for updated rows.
   */
  rollback(importId: number): Promise<{ deletedCount: number; restoredCount: number }>;
}
