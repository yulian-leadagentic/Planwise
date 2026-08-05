import { getTaskHealth } from '@/lib/task-health';
import { STATUS_DOT, STATUS_LABEL } from '@/lib/task-constants';
import { cn } from '@/lib/utils';
import { STATUS_ADVANCE } from './constants';

/**
 * One Task Board cell — the status of a task for a project. When the task has
 * multiple zone instances, shows the WORST (least-advanced) status plus a
 * done/total count, and colors by the worst health (overdue/at-risk) across
 * instances. Clicking opens the worst instance's drawer.
 */
export function TaskStatusCell({ tasks, onOpenTask }: { tasks: any[]; onOpenTask: (id: number) => void }) {
  if (tasks.length === 0) return <span className="text-slate-300 dark:text-slate-600">—</span>;

  // Worst (least-advanced) instance for the displayed status + drawer target.
  let worst = tasks[0];
  for (const t of tasks) {
    if ((STATUS_ADVANCE[t.status] ?? 0) < (STATUS_ADVANCE[worst.status] ?? 0)) worst = t;
  }
  const done = tasks.filter((t) => t.status === 'completed').length;
  const allDone = done === tasks.length;
  const displayStatus = allDone ? 'completed' : worst.status;

  const anyCritical = tasks.some((t) => getTaskHealth(t).level === 'critical');
  const anyWarning = tasks.some((t) => getTaskHealth(t).level === 'warning');
  const tone = anyCritical ? 'bg-red-100 text-red-700 border-red-300 hover:bg-red-200'
    : anyWarning ? 'bg-amber-100 text-amber-700 border-amber-300 hover:bg-amber-200'
    : displayStatus === 'completed' ? 'bg-emerald-100 text-emerald-700 border-emerald-300 hover:bg-emerald-200'
    : displayStatus === 'in_progress' ? 'bg-blue-100 text-blue-700 border-blue-300 hover:bg-blue-200'
    : displayStatus === 'in_review' ? 'bg-violet-100 text-violet-700 border-violet-300 hover:bg-violet-200'
    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-700';

  const title = tasks.length > 1
    ? `${tasks.length} instances across zones — ${done}/${tasks.length} completed`
    : (worst.zone?.name ? `Zone: ${worst.zone.name}` : 'Project Root');

  return (
    <button
      type="button"
      onClick={() => onOpenTask(worst.id)}
      title={title}
      className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors', tone)}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', STATUS_DOT[displayStatus] ?? 'bg-slate-400 dark:bg-slate-500')} />
      <span>{STATUS_LABEL[displayStatus] ?? displayStatus}</span>
      {tasks.length > 1 && (
        <span className="font-normal normal-case opacity-70 tabular-nums">· {done}/{tasks.length}</span>
      )}
    </button>
  );
}
