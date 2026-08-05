import { AlertCircle, AlertTriangle, Calendar, Clock } from 'lucide-react';
import { type TaskHealth } from '@/lib/task-health';
import { STATUS_DOT, STATUS_PILL, STATUS_LABEL, formatShortDate } from '@/lib/task-constants';
import { cn } from '@/lib/utils';
import type { Task } from './types';

export function TaskCard({ task, health, onClick }: { task: Task; health: TaskHealth; onClick: () => void }) {
  // Status-driven card styling per spec:
  //  - TODO ('not_started') WITH a due date → light blue card, full detail
  //  - TODO without a due date            → grey, just the title with "-"
  //  - IN PROGRESS                        → darker blue
  //  - other statuses inherit risk-level styling as before.
  const isTodo = task.status === 'not_started';
  const isInProgress = task.status === 'in_progress';
  const hasDue = !!task.endDate;
  const isBareTodo = isTodo && !hasDue;        // grey, title-only
  const isBlueTodo = isTodo && hasDue;         // light-blue, full detail
  const showDetails = !isBareTodo;

  const baseBorder =
    health.level === 'critical'
      ? 'border-red-300 bg-red-50 ring-1 ring-red-200'
      : health.level === 'warning'
        ? 'border-amber-300 bg-amber-50/60'
        : isInProgress
          ? 'border-blue-400 bg-blue-100/70'
          : isBlueTodo
            ? 'border-sky-300 bg-sky-50'
            : isBareTodo
              ? 'border-slate-200 dark:border-slate-700 bg-slate-100/60 dark:bg-slate-800/60'
              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900';

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full rounded-md border px-2 py-2 text-left shadow-sm transition-all hover:shadow-md',
        showDetails ? 'space-y-1.5' : 'space-y-0',
        baseBorder,
      )}
      title={health.reasons.length > 0 ? health.reasons.join(' • ') : undefined}
    >
      {/* Line 1: task name + risk icon. Bare-TODO cards add an inline "-"
          marker per spec ("title with '-' no other details, in grey"). */}
      <div className="flex items-start gap-1.5">
        {/* Status dot — color-only signal, so pair with a text label
            for AT + hover-title for sighted users (WCAG 1.4.1). */}
        <span
          role="img"
          aria-label={`Status: ${STATUS_LABEL[task.status] ?? task.status}`}
          title={STATUS_LABEL[task.status] ?? task.status}
          className={cn('h-2 w-2 mt-1 shrink-0 rounded-full', STATUS_DOT[task.status] ?? 'bg-slate-400 dark:bg-slate-500')}
        />
        <span className={cn(
          'flex-1 text-[12px] leading-tight break-words',
          isBareTodo ? 'text-slate-500 dark:text-slate-400 font-medium' : 'font-semibold text-slate-800 dark:text-slate-100',
        )}>
          {task.name}{isBareTodo && <span className="text-slate-400 dark:text-slate-500 ml-1">—</span>}
        </span>
        {health.level === 'critical' && <AlertCircle className="h-3.5 w-3.5 text-red-600 shrink-0" />}
        {health.level === 'warning' && <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
      </div>

      {showDetails && (
        <div className="flex items-center gap-1.5">
          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider', STATUS_PILL[task.status] ?? STATUS_PILL.not_started)}>
            {STATUS_LABEL[task.status] ?? task.status}
          </span>
        </div>
      )}

      {/* Hours + due date — hidden on bare-TODO cards, per spec. */}
      {showDetails && (
        <div className="flex items-center gap-1 text-[10px] text-slate-600 dark:text-slate-300">
          <Clock className="h-2.5 w-2.5 shrink-0" />
          <span className="tabular-nums font-medium">
            {health.loggedHours}h {health.estimatedHours > 0 ? `/ ${health.estimatedHours}h est.` : 'logged'}
          </span>
        </div>
      )}

      {/* Due date — only when we're showing details (i.e. not a bare TODO). */}
      {showDetails && task.endDate && (
        <div className="flex items-center gap-1 text-[10px]">
          <Calendar className={cn('h-2.5 w-2.5 shrink-0', health.isOverdue ? 'text-red-600' : 'text-slate-400 dark:text-slate-500')} />
          <span className={cn(
            'tabular-nums',
            health.isOverdue ? 'text-red-600 font-bold' : 'text-slate-500 dark:text-slate-400 font-medium',
          )}>
            Due {formatShortDate(task.endDate)}
            {health.isOverdue && ' (overdue)'}
          </span>
        </div>
      )}

      {showDetails && task.assignees.length > 0 && (
        <div className="flex -space-x-1.5 pt-0.5">
          {task.assignees.slice(0, 3).map((a) => (
            <div
              key={a.user.id}
              className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-[9px] font-bold text-white ring-1 ring-white"
              title={`${a.user.firstName} ${a.user.lastName}`}
            >
              {(a.user.firstName?.[0] ?? '')}{(a.user.lastName?.[0] ?? '')}
            </div>
          ))}
          {task.assignees.length > 3 && (
            <div className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-300 dark:bg-slate-600 text-[9px] font-bold text-slate-600 dark:text-slate-300 ring-1 ring-white">
              +{task.assignees.length - 3}
            </div>
          )}
        </div>
      )}
    </button>
  );
}
