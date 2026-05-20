/**
 * Overlap-confirmation dialog for cross-task time-entry overlaps.
 *
 * Why this exists:
 *   Backend rejects cross-task overlaps with HTTP 409 and
 *   `code: 'CROSS_TASK_OVERLAP'`. The client retries the same payload
 *   with `confirmOverlap: true` once the user acknowledges the conflict.
 *
 *   Same-task overlaps are NEVER bypassed — the backend always rejects
 *   them and the UI just surfaces the error via notify.apiError. This
 *   component is only for the cross-task case.
 *
 * Usage:
 *   const overlap = useOverlapConfirm();
 *
 *   const onSave = () =>
 *     overlap.withConfirm(
 *       (confirmOverlap) => timeApi.createEntry({ ...payload, confirmOverlap }),
 *       { onSuccess: ... },
 *     );
 *
 *   {overlap.dialog}
 */
import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { notify } from '@/lib/notify';

interface Conflict {
  id: number;
  startTime: string;
  endTime: string;
  taskName?: string | null;
  taskCode?: string | null;
}

interface OverlapState {
  conflicts: Conflict[];
  date: string;
  attempted: { startTime?: string; endTime?: string };
  retry: () => Promise<void>;
}

/**
 * Pulls the structured CROSS_TASK_OVERLAP payload out of an axios error.
 * Returns null for any other error shape so callers can fall through to
 * a normal error toast.
 */
export function extractCrossTaskOverlap(err: any): {
  conflicts: Conflict[];
  date: string;
  attempted: { startTime?: string; endTime?: string };
} | null {
  const body = err?.response?.data;
  // Nest's HttpException pipes through as { message: { code, message, details } }
  // when the exception was constructed with an object. The status code is 409.
  const payload = body?.message && typeof body.message === 'object' ? body.message : body;
  if (!payload || payload.code !== 'CROSS_TASK_OVERLAP') return null;
  const details = payload.details ?? {};
  return {
    conflicts: Array.isArray(details.conflicts) ? details.conflicts : [],
    date: details.date ?? '',
    attempted: details.attempted ?? {},
  };
}

/**
 * Wraps a save call with cross-task overlap handling. When the call
 * fails with CROSS_TASK_OVERLAP, opens a confirm dialog. If the user
 * accepts, retries with `confirmOverlap=true`.
 */
export function useOverlapConfirm() {
  const [state, setState] = useState<OverlapState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const withConfirm = async (
    run: (confirmOverlap: boolean) => Promise<any>,
    opts: {
      onSuccess?: () => void;
      onError?: (err: any) => void;
    } = {},
  ) => {
    try {
      await run(false);
      opts.onSuccess?.();
    } catch (err: any) {
      const conflict = extractCrossTaskOverlap(err);
      if (conflict) {
        // Stash the retry closure — the dialog "Confirm" button calls it.
        setState({
          ...conflict,
          retry: async () => {
            setSubmitting(true);
            try {
              await run(true);
              setState(null);
              opts.onSuccess?.();
            } catch (e: any) {
              setState(null);
              opts.onError?.(e);
              notify.apiError(e, 'Failed to log time');
            } finally {
              setSubmitting(false);
            }
          },
        });
        return;
      }
      opts.onError?.(err);
      notify.apiError(err, 'Failed to log time');
    }
  };

  const dialog = state ? (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={() => !submitting && setState(null)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="overlap-dialog-title"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg bg-white shadow-2xl overflow-hidden"
      >
        <div className="flex items-start gap-3 px-5 py-4 bg-amber-50 border-b border-amber-200">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <h2 id="overlap-dialog-title" className="text-sm font-bold text-amber-900">
              Time overlaps with another task
            </h2>
            <p className="mt-0.5 text-[12px] text-amber-800">
              You're trying to log {state.attempted.startTime ?? '?'}–{state.attempted.endTime ?? '?'} on{' '}
              {state.date}, but this time is already booked on the task{state.conflicts.length === 1 ? '' : 's'} below.
            </p>
          </div>
        </div>
        <div className="px-5 py-3 space-y-1.5 max-h-60 overflow-y-auto">
          {state.conflicts.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12px]"
            >
              <div className="min-w-0">
                {c.taskCode && <span className="font-mono text-[10px] text-slate-400 mr-1.5">{c.taskCode}</span>}
                <span className="font-medium text-slate-700 truncate">{c.taskName ?? `Task #${c.id}`}</span>
              </div>
              <span className="text-slate-600 tabular-nums shrink-0">
                {c.startTime}–{c.endTime}
              </span>
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button
            onClick={() => setState(null)}
            disabled={submitting}
            className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-slate-600 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => state.retry()}
            disabled={submitting}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save anyway'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { withConfirm, dialog };
}
