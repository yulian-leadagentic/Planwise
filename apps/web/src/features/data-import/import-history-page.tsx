/**
 * Import history page — lists all imports the current user has run
 * (admins see everyone's, server-side gated). Each row links to a
 * detail drawer that shows per-row outcome + offers rollback if the
 * import is still within its 30-day reversal window.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RotateCcw, Download, ChevronRight, AlertTriangle } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/shared/page-header';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/date-utils';
import { dataImportApi, type ImportRecord, type ImportStatus } from '@/api/data-import.api';

const STATUS_PILL: Record<ImportStatus, string> = {
  parsed: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200',
  committed: 'bg-emerald-100 text-emerald-700',
  partial: 'bg-amber-100 text-amber-700',
  failed: 'bg-red-100 text-red-700',
  rolled_back: 'bg-purple-100 text-purple-700',
};

const STATUS_LABEL: Record<ImportStatus, string> = {
  parsed: 'Parsed',
  committed: 'Completed',
  partial: 'Completed with errors',
  failed: 'Failed',
  rolled_back: 'Rolled back',
};

export function ImportHistoryPage() {
  const queryClient = useQueryClient();
  const [detailId, setDetailId] = useState<number | null>(null);
  const [confirmRollback, setConfirmRollback] = useState<ImportRecord | null>(null);

  const { data: history = [], isLoading } = useQuery({
    queryKey: ['data-import', 'history'],
    queryFn: () => dataImportApi.history(),
    staleTime: 30 * 1000,
  });

  const rollbackMutation = useMutation({
    mutationFn: (importId: number) => dataImportApi.rollback(importId),
    onSuccess: (data) => {
      notify.success(`Rolled back — deleted ${data.deletedCount} records.`, { code: 'IMPORT-ROLLBACK' });
      queryClient.invalidateQueries({ queryKey: ['data-import'] });
      setConfirmRollback(null);
    },
    onError: (err: any) => notify.apiError(err, 'Rollback failed'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          to="/admin/data-import"
          className="rounded-md p-1.5 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
          aria-label="Back to import wizard"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <PageHeader
          title="Import History"
          description="Past bulk-import runs and per-row outcomes. Rollback is available for 30 days."
        />
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase text-slate-500 dark:text-slate-400">
            <tr>
              <th className="px-4 py-2 text-left">When</th>
              <th className="px-4 py-2 text-left">Target</th>
              <th className="px-4 py-2 text-left">By</th>
              <th className="px-4 py-2 text-left">File</th>
              <th className="px-4 py-2 text-right">Created</th>
              <th className="px-4 py-2 text-right">Skipped</th>
              <th className="px-4 py-2 text-right">Errors</th>
              <th className="px-4 py-2 text-center">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {isLoading && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-slate-400 dark:text-slate-500">Loading…</td>
              </tr>
            )}
            {!isLoading && history.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-slate-400 dark:text-slate-500 italic">
                  No imports yet. Run one from the wizard.
                </td>
              </tr>
            )}
            {history.map((h) => {
              const expired = h.expiresAt && new Date(h.expiresAt) < new Date();
              const canRollback =
                h.status !== 'rolled_back' && h.status !== 'failed' && !expired && h.createdCount > 0;
              return (
                <tr key={h.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
                  <td className="px-4 py-2 tabular-nums text-slate-600 dark:text-slate-300">
                    {formatDate(h.startedAt.split('T')[0])}
                  </td>
                  <td className="px-4 py-2 capitalize">{h.target}</td>
                  <td className="px-4 py-2 text-slate-600 dark:text-slate-300">
                    {h.user ? `${h.user.firstName} ${h.user.lastName}` : `User #${h.userId}`}
                  </td>
                  <td className="px-4 py-2 text-slate-600 dark:text-slate-300 truncate max-w-[180px]" title={h.filename}>
                    {h.filename}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-semibold text-emerald-700">
                    {h.createdCount}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-amber-700">
                    {h.skippedCount}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-red-700">
                    {h.errorCount}
                  </td>
                  <td className="px-4 py-2 text-center">
                    <span className={cn('rounded px-2 py-0.5 text-[10px] font-bold uppercase', STATUS_PILL[h.status])}>
                      {STATUS_LABEL[h.status]}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => setDetailId(h.id)}
                      className="text-[11px] text-blue-600 hover:underline mr-3"
                    >
                      Details
                    </button>
                    {canRollback && (
                      <button
                        onClick={() => setConfirmRollback(h)}
                        className="inline-flex items-center gap-1 text-[11px] text-red-600 hover:underline"
                        title="Roll back this import"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Rollback
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Row detail drawer */}
      {detailId != null && <DetailDrawer importId={detailId} onClose={() => setDetailId(null)} />}

      {/* Rollback confirmation */}
      {confirmRollback && (
        <RollbackDialog
          imp={confirmRollback}
          submitting={rollbackMutation.isPending}
          onCancel={() => setConfirmRollback(null)}
          onConfirm={() => rollbackMutation.mutate(confirmRollback.id)}
        />
      )}
    </div>
  );
}

function DetailDrawer({ importId, onClose }: { importId: number; onClose: () => void }) {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['data-import', 'history', importId, 'rows'],
    queryFn: () => dataImportApi.historyRows(importId),
  });

  const exportCsv = () => {
    if (rows.length === 0) return;
    const cols = ['rowIndex', 'outcome', 'entityId', 'errorMessage'];
    const allData = rows.flatMap((r) => Object.keys(r.afterJson ?? {}));
    const dataKeys = Array.from(new Set(allData)).filter((k) => !cols.includes(k));
    const header = [...cols, ...dataKeys].join(',');
    const body = rows
      .map((r) => {
        const base = [
          r.rowIndex,
          r.outcome,
          r.entityId ?? '',
          (r.errorMessage ?? '').replace(/"/g, '""'),
        ];
        const extra = dataKeys.map((k) => {
          const v = r.afterJson?.[k];
          return v == null ? '' : String(v).replace(/"/g, '""');
        });
        return [...base, ...extra].map((c) => `"${c}"`).join(',');
      })
      .join('\n');
    const blob = new Blob([header + '\n' + body], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `import-${importId}-rows.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-[640px] max-w-[90vw] bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-700 shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <h2 className="text-sm font-bold">Import #{importId} — per-row outcomes</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={exportCsv}
              disabled={rows.length === 0}
              className="flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50 disabled:opacity-50"
            >
              <Download className="h-3 w-3" />
              CSV
            </button>
            <button onClick={onClose} className="rounded p-1 text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">×</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="px-5 py-8 text-center text-[12px] text-slate-400 dark:text-slate-500">Loading…</div>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase text-slate-500 dark:text-slate-400 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left w-10">#</th>
                  <th className="px-3 py-2 text-left">Outcome</th>
                  <th className="px-3 py-2 text-left">Entity ID</th>
                  <th className="px-3 py-2 text-left">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 tabular-nums text-slate-500 dark:text-slate-400">{r.rowIndex}</td>
                    <td className="px-3 py-2">
                      <span className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase',
                        r.outcome === 'created' && 'bg-emerald-100 text-emerald-700',
                        r.outcome === 'updated' && 'bg-blue-100 text-blue-700',
                        r.outcome === 'skipped' && 'bg-amber-100 text-amber-700',
                        r.outcome === 'failed' && 'bg-red-100 text-red-700',
                      )}>{r.outcome}</span>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-slate-600 dark:text-slate-300">{r.entityId ?? '—'}</td>
                    <td className="px-3 py-2">
                      {r.errorMessage ? (
                        <span className="text-red-700">{r.errorMessage}</span>
                      ) : r.afterJson?.email ? (
                        <span className="text-slate-700 dark:text-slate-200">
                          {r.afterJson.email}
                          {r.afterJson.generatedPassword && r.outcome === 'created' && (
                            <span className="ml-2 text-amber-700 font-mono text-[10px]">
                              pwd: {r.afterJson.generatedPassword}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-slate-400 dark:text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-slate-400 dark:text-slate-500 italic">
                      No row records.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 text-[11px] text-slate-500 dark:text-slate-400">
          Generated passwords are visible here so you can distribute them to the new employees. Recipients should
          change their password on first login.
        </div>
      </div>
    </>
  );
}

function RollbackDialog({
  imp,
  submitting,
  onCancel,
  onConfirm,
}: {
  imp: ImportRecord;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={() => !submitting && onCancel()}
      role="dialog"
      aria-modal="true"
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-lg bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">
        <div className="flex items-start gap-3 px-5 py-4 bg-red-50 border-b border-red-200">
          <AlertTriangle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
          <div>
            <h2 className="text-sm font-bold text-red-900">Roll back import #{imp.id}?</h2>
            <p className="mt-1 text-[12px] text-red-800">
              This will permanently delete <strong>{imp.createdCount}</strong> {imp.target} created by this import.
              Skipped rows are not affected.
            </p>
          </div>
        </div>
        <div className="px-5 py-3 text-[12px] text-slate-700 dark:text-slate-200 space-y-2">
          <p>
            <strong>Note:</strong> any work done on the deleted records since the import (time entries, project
            memberships, etc.) will also be removed via cascade. Make sure no one is depending on this data.
          </p>
        </div>
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex items-center justify-end gap-2">
          <button onClick={onCancel} disabled={submitting} className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={submitting} className="rounded-md bg-red-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-red-700 disabled:opacity-50">
            {submitting ? 'Rolling back…' : 'Confirm rollback'}
          </button>
        </div>
      </div>
    </div>
  );
}
