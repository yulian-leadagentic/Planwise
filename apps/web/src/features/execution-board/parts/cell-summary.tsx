import { ChevronRight } from 'lucide-react';
import { aggregateHealth, type TaskHealth } from '@/lib/task-health';
import { rollupCompletion } from '@/lib/completion-rollup';
import { cn } from '@/lib/utils';
import { HealthBadge } from './health-badge';
import type { Task } from './types';

export function CellSummary({
  tasks,
  healths,
  isAggregate,
  expanded,
  onToggle,
  /**
   * Whether to render the visual progress bar. Only the top-level zones in
   * the execution board do — sub-zones show just `% + health` so the eye
   * isn't pulled away from the parent zone's overall progress.
   */
  showBar = true,
}: { tasks: Task[]; healths: TaskHealth[]; isAggregate: boolean; expanded: boolean; onToggle: () => void; showBar?: boolean }) {
  if (tasks.length === 0) return null;

  // Canonical completion rollup shared with the Planning tree — see
  // `@/lib/completion-rollup`. Uses the status-aware per-task
  // `completionPct` (100 for completed/cancelled, 90 for in_review, else
  // capped time-based partial credit) and rolls up as a budget-hours-
  // weighted average with a simple-mean fallback when the bucket's total
  // budget = 0. This replaces the old exec-board-only binary calc
  // (Σ hours of tasks with status==='completed' / Σ hours) so the two
  // surfaces agree on a single number.
  let totalHours = 0;
  let doneCount = 0;
  for (const task of tasks) {
    totalHours += Number(task.budgetHours) || 0;
    if (task.status === 'completed') doneCount++;
  }
  const pct = rollupCompletion(tasks);

  const agg = aggregateHealth(healths);
  const color =
    pct >= 100 ? 'bg-emerald-500' : pct >= 60 ? 'bg-blue-500' : pct >= 30 ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-600';
  const textColor =
    pct >= 100 ? 'text-emerald-600' : pct >= 60 ? 'text-blue-600' : pct >= 30 ? 'text-amber-600' : 'text-slate-500 dark:text-slate-400';

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'w-full text-left px-1 py-0.5 rounded hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors',
        isAggregate ? '' : 'mb-1',
      )}
      aria-expanded={expanded}
      aria-label={`${pct}% complete, ${tasks.length} tasks. Click to ${expanded ? 'collapse' : 'expand'}.`}
    >
      <div className="flex items-center gap-1.5">
        <ChevronRight
          className={cn(
            'h-3 w-3 text-slate-400 dark:text-slate-500 shrink-0 transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        {showBar ? (
          <div className="flex-1 h-[4px] bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
            <div className={cn('h-full rounded-full', color)} style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
        ) : (
          // Sub-zones: spacer keeps the % + health badge pushed right, in
          // visual line with their parent's bar — but no bar of their own.
          <div className="flex-1" />
        )}
        <span className={cn('text-[10px] font-bold tabular-nums shrink-0', textColor)}>{pct}%</span>
        <HealthBadge agg={agg} />
      </div>
      <div className="flex items-center gap-2 text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 pl-4">
        <span>{doneCount}/{tasks.length} done</span>
        {totalHours > 0 && <span>· {totalHours}h est.</span>}
      </div>
    </button>
  );
}
