import { useState } from 'react';
import { Send, Check, RotateCcw } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { queryKeys } from '@/lib/query-keys';

/**
 * ReviewActions (Tier D #2a, 2026-06-30)
 *
 * Contextual review controls shown right below the drawer's status
 * pill. Renders different buttons depending on where the task sits
 * in its review lifecycle:
 *   - not_started / in_progress + requiresReview  → "Submit for review"
 *   - in_review                                    → "Approve" + "Return with reason"
 *   - anything else                                → nothing
 *
 * Each click POSTs /tasks/:id/review; the server flips the status +
 * appends a task_review_events row. On success we invalidate the task
 * + review-history queries so the drawer re-renders with the new
 * status and the history section below picks up the new event.
 */
export function ReviewActions({ task }: { task: any }) {
  const queryClient = useQueryClient();
  const [showReturn, setShowReturn] = useState(false);
  const [reason, setReason] = useState('');
  const requiresReview = task?.requiresReview !== false;

  const recordReview = useMutation({
    mutationFn: (body: { action: 'submit' | 'approve' | 'return'; reason?: string }) =>
      client.post(`/tasks/${task.id}/review`, body).then((r) => r.data),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['task', task.id] });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.mine() });
      queryClient.invalidateQueries({ queryKey: ['task-reviews', task.id] });
      const labels: Record<string, string> = {
        submit: 'Task submitted for review',
        approve: 'Task approved',
        return: 'Task returned for revisions',
      };
      notify.success(labels[vars.action] ?? 'Review recorded');
      setShowReturn(false);
      setReason('');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to record review'),
  });

  const status = task?.status;
  // Compute which buttons to show — the API also validates, so this
  // is purely UX (hide illegal actions rather than let the user click
  // and get a red toast).
  const canSubmit = requiresReview && (status === 'not_started' || status === 'in_progress');
  const canDecide = status === 'in_review';

  if (!canSubmit && !canDecide) return null;

  return (
    <div className="px-5 py-2.5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/60 flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mr-1">Review</span>
      {canSubmit && (
        <button
          type="button"
          onClick={() => recordReview.mutate({ action: 'submit' })}
          disabled={recordReview.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-[12px] font-semibold"
          title="Move to In Review — a lead will approve or return it"
        >
          <Send className="h-3 w-3" />
          Submit for review
        </button>
      )}
      {canDecide && !showReturn && (
        <>
          <button
            type="button"
            onClick={() => recordReview.mutate({ action: 'approve' })}
            disabled={recordReview.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-[12px] font-semibold"
          >
            <Check className="h-3 w-3" />
            Approve
          </button>
          <button
            type="button"
            onClick={() => setShowReturn(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-amber-300 text-amber-700 hover:bg-amber-50 text-[12px] font-semibold"
          >
            <RotateCcw className="h-3 w-3" />
            Return for revisions
          </button>
        </>
      )}
      {canDecide && showReturn && (
        <div className="flex-1 flex items-center gap-1.5">
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is it being returned? (required)"
            className="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-[12px] focus:border-blue-500 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && reason.trim()) recordReview.mutate({ action: 'return', reason: reason.trim() });
              if (e.key === 'Escape') { setShowReturn(false); setReason(''); }
            }}
          />
          <button
            type="button"
            onClick={() => reason.trim() && recordReview.mutate({ action: 'return', reason: reason.trim() })}
            disabled={!reason.trim() || recordReview.isPending}
            className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-[12px] font-semibold"
          >
            Return
          </button>
          <button
            type="button"
            onClick={() => { setShowReturn(false); setReason(''); }}
            className="px-2 py-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 text-[12px]"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
