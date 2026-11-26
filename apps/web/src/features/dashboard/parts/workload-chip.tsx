import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import type { WorkloadTaskEntry } from '../workload-contract';

/**
 * QA6 P4 (PR-063): one task chip on the Workload board (a lane cell or
 * the tray). Code and hours in mono, the name RTL-safe, ⏱ when hours are
 * already logged on the task, and "APPROVAL" while a move waits for a
 * decision. A masked chip (a project the viewer can't open, someone
 * else's personal task) is grey and never moves.
 */

export type ChipView = {
  code: string | null;
  name: string;
  hours: number;
  masked?: boolean;
  pending?: boolean;
  overdue?: boolean;
  logged?: boolean;
  /** Small muted text before the hours (e.g. the assignee of an overdue tray chip). */
  meta?: string | null;
};

export type TaskChipProps = ChipView & {
  /** 'stack' (lane cells, narrow): code + badges + hours on top, the name below. 'inline' (tray): one line. */
  layout?: 'inline' | 'stack';
  draggable?: boolean;
  /** Another chip of the task being dragged. */
  sibling?: boolean;
  /** The chip being dragged (left in place, faded). */
  ghost?: boolean;
  /** The floating copy under the pointer. */
  overlay?: boolean;
} & HTMLAttributes<HTMLDivElement>;

const fmtHours = (h: number) => `${Math.round(h * 100) / 100}h`;

export const TaskChip = forwardRef<HTMLDivElement, TaskChipProps>(function TaskChip(
  { code, name, hours, masked, pending, overdue, logged, meta, layout = 'inline', draggable, sibling, ghost, overlay, className, ...rest },
  ref,
) {
  const nameEl = (
    <span dir="auto" className={cn('min-w-0 truncate', layout === 'inline' && 'flex-1', masked ? 'italic' : 'text-slate-700 dark:text-slate-200')}>
      {name}
    </span>
  );
  const badge = pending ? (
    <span className="shrink-0 self-start rounded-[5px] bg-violet-600 px-1 text-[9px] font-bold tracking-wide text-white">APPROVAL</span>
  ) : null;
  const marks = (
    <>
      {logged && (
        <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400" aria-label="Hours already logged">
          ⏱
        </span>
      )}
      {layout === 'inline' && badge}
      {meta && <span className="shrink-0 truncate text-[10px] text-slate-400 dark:text-slate-500 max-w-[80px]">{meta}</span>}
      <span className="shrink-0 font-mono text-[10px] font-medium text-slate-600 dark:text-slate-300">{fmtHours(hours)}</span>
    </>
  );
  const codeEl = code ? <span className={cn('font-mono text-[10px] font-medium text-slate-500 dark:text-slate-400', layout === 'stack' ? 'min-w-0 truncate' : 'shrink-0')}>{code}</span> : null;
  return (
    <div
      ref={ref}
      {...rest}
      className={cn(
        'flex min-w-0 rounded-[7px] border px-1.5 py-1 text-[11px] leading-tight select-none transition-all duration-150',
        layout === 'stack' ? 'flex-col gap-0.5' : 'items-center gap-1.5',
        masked
          ? 'border-slate-200 bg-slate-100 text-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-500'
          : pending
            ? 'border-dashed border-violet-300 bg-violet-50 dark:border-violet-500/40 dark:bg-violet-500/10'
            : overdue
              ? 'border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10'
              : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900',
        draggable && 'cursor-grab hover:border-blue-400 dark:hover:border-blue-500 active:cursor-grabbing focus:border-blue-500 focus:outline-none',
        sibling && 'border-blue-400 bg-blue-50 dark:border-blue-500 dark:bg-blue-500/10',
        ghost && 'opacity-40',
        overlay && 'cursor-grabbing border-blue-500 bg-white shadow-[0_12px_40px_rgba(0,0,0,0.12)] dark:bg-slate-900',
        className,
      )}
    >
      {layout === 'stack' ? (
        <>
          <span className="flex min-w-0 items-center gap-1">
            {codeEl}
            <span className="flex-1" />
            {marks}
          </span>
          {nameEl}
          {badge}
        </>
      ) : (
        <>
          {codeEl}
          {nameEl}
          {marks}
        </>
      )}
    </div>
  );
});

/** The chip's hover text: code, name, project, service, logged hours and the pending move. */
export function chipTitle(task: WorkloadTaskEntry | null | undefined, opts: { personId?: number | null; hours?: number } = {}): string | undefined {
  if (!task) return undefined;
  const lines: string[] = [[task.code, task.name].filter(Boolean).join(' · ')];
  const where = [task.projectName, task.service?.name].filter(Boolean).join(' · ');
  if (where) lines.push(where);
  if (task.estimatedStartDate || task.endDate) lines.push(`Dates: ${task.estimatedStartDate ?? task.startDate ?? '?'} to ${task.endDate ?? '?'}`);
  if (task.loggedUserIds.length > 0) {
    const mine = opts.personId != null ? task.loggedHoursByUser?.[String(opts.personId)] : undefined;
    lines.push(mine != null ? `⏱ ${mine}h already logged by this person (they stay with them)` : '⏱ Hours already logged on this task');
  }
  if (task.pending) {
    const approver = task.pending.approver?.name ?? 'an Admin';
    lines.push(`Waiting for approval: to ${task.pending.toName ?? 'another person'} (decided by ${approver})`);
  }
  return lines.join('\n');
}
