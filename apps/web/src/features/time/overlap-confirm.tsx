/**
 * Overlap dialog for time entries (informational, 2026-11-20).
 *
 * Why this exists:
 *   The backend hard-rejects every overlapping time entry with HTTP 409 —
 *   `SAME_TASK_OVERLAP` or `CROSS_TASK_OVERLAP`, both carrying
 *   `details: { date, attempted, conflicts }` (no-overlap policy,
 *   2026-06-14; no flag bypasses it). Instead of a generic error toast the
 *   user gets one read-only dialog listing the entries in the way, with a
 *   single OK. There is no retry and no "Save anyway" — the old
 *   `confirmOverlap` flag has no effect server-side.
 *
 * Usage:
 *   const overlap = useOverlapDialog();
 *
 *   const onSave = () =>
 *     overlap.withOverlapCheck(
 *       () => timeApi.createEntry(payload),
 *       { onSuccess: ... },
 *     );
 *
 *   {overlap.dialog}
 */
import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { notify, apiErrorCode, apiErrorDetails } from '@/lib/notify';
import { formatDate } from '@/lib/date-utils';

interface Conflict {
  /** The conflicting time entry's id. */
  id: number;
  startTime: string;
  endTime: string;
  /** Cross-task conflicts only — a same-task conflict is on the entry's own task. */
  taskId?: number | null;
  taskName?: string | null;
  taskCode?: string | null;
}

type OverlapCode = 'CROSS_TASK_OVERLAP' | 'SAME_TASK_OVERLAP';

export interface TimeOverlap {
  code: OverlapCode;
  /** YYYY-MM-DD of the rejected entry — every conflict is on that day. */
  date: string;
  conflicts: Conflict[];
}

/**
 * Pulls an overlap 409 out of an axios error. Both codes arrive in the API
 * envelope `{ success: false, error: { code, message, details } }`.
 * Returns null for any other error so callers fall through to the normal
 * error toast.
 */
export function extractTimeOverlap(err: unknown): TimeOverlap | null {
  const code = apiErrorCode(err);
  if (code !== 'CROSS_TASK_OVERLAP' && code !== 'SAME_TASK_OVERLAP') return null;
  const details = apiErrorDetails<{ date?: unknown; conflicts?: unknown }>(err) ?? {};
  return {
    code,
    date: typeof details.date === 'string' ? details.date : '',
    conflicts: Array.isArray(details.conflicts) ? (details.conflicts as Conflict[]) : [],
  };
}

export interface OverlapCheckOptions {
  onSuccess?: () => void;
  onError?: (err: unknown) => void;
}

/**
 * Runs the save once. An overlap 409 goes to `onOverlap` (the dialog)
 * INSTEAD of the error toast; any other failure gets notify.apiError.
 * Never retries. Exported for the spec — components use the hook.
 */
export async function runWithOverlapCheck(
  run: () => Promise<unknown>,
  onOverlap: (overlap: TimeOverlap) => void,
  opts: OverlapCheckOptions = {},
): Promise<void> {
  try {
    await run();
    opts.onSuccess?.();
  } catch (err) {
    opts.onError?.(err);
    const overlap = extractTimeOverlap(err);
    if (overlap) onOverlap(overlap);
    else notify.apiError(err, 'Failed to log time');
  }
}

/** Wraps a time-entry save; shows the read-only overlap dialog when the backend rejects an overlap. */
export function useOverlapDialog() {
  const [overlap, setOverlap] = useState<TimeOverlap | null>(null);

  const withOverlapCheck = (run: () => Promise<unknown>, opts: OverlapCheckOptions = {}) =>
    runWithOverlapCheck(run, setOverlap, opts);

  const dialog = overlap ? <OverlapDialog overlap={overlap} onClose={() => setOverlap(null)} /> : null;

  return { withOverlapCheck, dialog };
}

function conflictLabel(c: Conflict, code: OverlapCode): string {
  if (c.taskName) return c.taskName;
  if (code === 'SAME_TASK_OVERLAP') return 'Same task';
  return c.taskId != null ? `Task #${c.taskId}` : 'Another task';
}

function displayDate(date: string): string {
  if (!date) return '';
  try {
    return formatDate(date);
  } catch {
    return date; // unparseable — show it raw rather than crash the dialog
  }
}

function OverlapDialog({ overlap, onClose }: { overlap: TimeOverlap; onClose: () => void }) {
  const date = displayDate(overlap.date);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      onKeyDown={(e) => {
        // Escape closes only this dialog, not the form it sits on.
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="overlap-dialog-title"
      aria-describedby="overlap-dialog-desc"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg bg-white dark:bg-slate-900 shadow-2xl overflow-hidden"
      >
        <div className="flex items-start gap-3 px-5 py-4 bg-amber-50 border-b border-amber-200">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <h2 id="overlap-dialog-title" className="text-sm font-bold text-amber-900">
              This time overlaps another entry
            </h2>
            <p id="overlap-dialog-desc" className="mt-0.5 text-[12px] text-amber-800">
              Time entries can't overlap. Change the start/end time or edit the existing entry.
            </p>
          </div>
        </div>
        {overlap.conflicts.length > 0 && (
          <div className="px-5 py-3 space-y-1.5 max-h-60 overflow-y-auto">
            {overlap.conflicts.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-3 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2 text-[12px]"
              >
                <div className="min-w-0 truncate">
                  {c.taskCode && <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500 mr-1.5">{c.taskCode}</span>}
                  <span className="font-medium text-slate-700 dark:text-slate-200">{conflictLabel(c, overlap.code)}</span>
                </div>
                <span className="font-mono text-slate-600 dark:text-slate-300 tabular-nums shrink-0">
                  {date && `${date} · `}
                  {c.startTime}–{c.endTime}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex items-center justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-amber-700"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
