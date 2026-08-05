import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { tasksApi } from '@/api/tasks.api';
import { STATUS_LABEL } from '@/lib/task-constants';
import { queryKeys } from '@/lib/query-keys';
import { useAllowedTransitions } from '@/hooks/use-allowed-transitions';
import { columns } from './constants';

/**
 * Row-level inline status select for the My Tasks list rows. Same color
 * convention as the previous read-only badge so the row reads the same
 * at-a-glance, but clicking it opens a native select with the allowed
 * transitions (gates illegal jumps the same way the kanban drag does).
 *
 * Behavior:
 *   - PATCHes /tasks/:id with the new status, invalidates the My Tasks +
 *     planning + execution-board caches so every surface re-fetches.
 *   - Wrapping span stops click propagation so picking a status doesn't
 *     also fire the row's open-drawer handler underneath.
 */
export function RowStatusSelect({ taskId, status }: { taskId: number; status: string }) {
  const queryClient = useQueryClient();
  const { allowedStatuses } = useAllowedTransitions(status);
  const statusColor = status === 'completed'
    ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
    : status === 'in_progress'
      ? 'bg-blue-100 text-blue-700 border-blue-200'
      : status === 'in_review'
        ? 'bg-violet-100 text-violet-700 border-violet-200'
        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700';

  const handleChange = async (newStatus: string) => {
    try {
      await tasksApi.update(taskId, { status: newStatus });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.mine() });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.planning.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionBoard.all });
      notify.success(`Status changed to ${STATUS_LABEL[newStatus] ?? newStatus}`);
    } catch (e: any) {
      notify.apiError(e, 'Failed to change status');
    }
  };

  return (
    <span
      className="inline-flex shrink-0"
      onClick={(e) => e.stopPropagation()}
    >
      <select
        aria-label="Change task status"
        value={status}
        onChange={(e) => handleChange(e.target.value)}
        className={cn(
          'rounded border px-1.5 py-0.5 text-[10px] font-semibold appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-200',
          statusColor,
        )}
        title="Click to change status"
      >
        {/* Always include the CURRENT status so the select can render it,
            even if it's not in the allowed-transition set (defensive — e.g.
            statuses that locked themselves due to time-entry rules). */}
        {!allowedStatuses.includes(status) && (
          <option value={status}>{STATUS_LABEL[status] ?? status}</option>
        )}
        {columns.filter((c) => allowedStatuses.includes(c.id)).map((c) => (
          <option key={c.id} value={c.id}>{c.label}</option>
        ))}
      </select>
    </span>
  );
}
