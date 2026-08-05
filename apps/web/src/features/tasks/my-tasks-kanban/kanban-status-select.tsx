import { useAllowedTransitions } from '@/hooks/use-allowed-transitions';
import { columns } from './constants';

export function KanbanStatusSelect({ status, requiresReview = true, onStatusChange }: { status: string; requiresReview?: boolean; onStatusChange: (s: string) => void }) {
  const { allowedStatuses } = useAllowedTransitions(status);
  // Optional Review step (Tier D #2). When the task doesn't require
  // review, hide the "In Review" option from the picker so users go
  // In Progress → Done directly. Doesn't affect the column itself on
  // the Kanban board — that stays visible for tasks that DO need it.
  const opts = requiresReview
    ? columns
    : columns.filter((c) => c.id !== 'in_review');
  return (
    <select
      aria-label="Change task status"
      value={status}
      onChange={(e) => onStatusChange(e.target.value)}
      className="flex-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-1 text-[10px] focus:border-blue-400 focus:outline-none"
    >
      {opts.filter((c) => allowedStatuses.includes(c.id)).map((c) => (
        <option key={c.id} value={c.id}>{c.label}</option>
      ))}
    </select>
  );
}
