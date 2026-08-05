/**
 * Task card body (client feedback 2026-08-02, item 2 — "propagate
 * the new task-card design everywhere a task card is shown"). This
 * is the PRESENTATIONAL layer of the My Tasks Kanban card, extracted
 * so the Project Kanban, Upcoming buckets, and any future task-list
 * surface can share the same visual language without duplicating the
 * layout code.
 *
 * Kept intentionally plain: no drag/DnD wiring, no drawer plumbing,
 * no status-change select. Consumers wrap this in their own shell
 * (draggable, clickable, etc.) and hand it a normalized task.
 *
 * Fields rendered:
 *   • Project name (bold header, optional)
 *   • Task name
 *   • Labeled rows — Zone / Service / Deliverable / BIM Leader
 *   • Due-date pill (red when overdue, dashed when missing)
 *   • Optional Log Time CTA slot on the bottom-right
 */

import { Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatShortDate } from '@/lib/date-utils';

export interface TaskCardBodyProps {
  task: any;
  /** When true, task overdue → red pill. Consumers pass their own
   *  policy (health.isOverdue on the My Tasks Kanban, endDate<now on
   *  simpler surfaces). Defaults to naive endDate<today. */
  isOverdue?: boolean;
  /** Optional slot to render on the bottom-right of the pill row —
   *  e.g. QuickTimeLog CTA on My Tasks, nothing on the Project board. */
  actionSlot?: React.ReactNode;
  /** Hide the labeled fields dl (Zone/Service/…) — some surfaces
   *  (like the Upcoming bucket rows) only want name + pill for
   *  density. Defaults to showing them. */
  compact?: boolean;
  /** Hide the project header (already visible in the parent shell). */
  hideProject?: boolean;
}

export function TaskCardBody({ task, isOverdue, actionSlot, compact = false, hideProject = false }: TaskCardBodyProps) {
  const projectName = task.project?.name ?? task.label?.projectName ?? '';
  const zoneName = task.zone?.name ?? task.label?.name ?? '';
  const service = task.phase?.name ?? '';
  const deliverable = task.deliverableTemplate?.name ?? task.projectDeliverable?.name ?? task.serviceType?.name ?? '';
  const bimLeader = task.project?.bimLeader
    ? `${task.project.bimLeader.firstName ?? ''} ${task.project.bimLeader.lastName ?? ''}`.trim()
    : '';
  const overdue = isOverdue ?? (task.endDate ? new Date(task.endDate) < new Date() && task.status !== 'completed' && task.status !== 'done' : false);

  return (
    <div className="px-3.5 pb-3 pt-1">
      {!hideProject && projectName && (
        <p className="text-[13px] font-bold text-slate-900 dark:text-slate-100 truncate mb-0.5" title={projectName}>
          {projectName}
        </p>
      )}
      <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 leading-tight break-words mb-2.5">
        {task.name}
      </p>

      {!compact && (
        <dl className="text-[12px] space-y-1 mb-3">
          <FieldRow label="Zone" value={zoneName} placeholder="Project Root" placeholderItalic />
          <FieldRow label="Service" value={service} />
          <FieldRow label="Deliverable" value={deliverable} />
          <FieldRow label="BIM Leader" value={bimLeader} />
        </dl>
      )}

      <div className="flex items-center gap-2 pt-1">
        {task.endDate ? (
          <span className={cn(
            'inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] font-semibold tabular-nums',
            overdue
              ? 'bg-red-50 border-red-200 text-red-700'
              : 'bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200',
          )}>
            <Calendar className="h-3 w-3" />
            {formatShortDate(task.endDate)}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-slate-200 dark:border-slate-700 px-2 py-1.5 text-[11px] text-slate-400 dark:text-slate-500">
            <Calendar className="h-3 w-3" />
            No date
          </span>
        )}
        {actionSlot && <div className="ml-auto">{actionSlot}</div>}
      </div>
    </div>
  );
}

function FieldRow({ label, value, placeholder, placeholderItalic }: { label: string; value: string; placeholder?: string; placeholderItalic?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-[74px] shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">{label}</dt>
      <dd className="text-slate-700 dark:text-slate-200 truncate min-w-0" title={value}>
        {value || (
          placeholder
            ? <span className={cn(placeholderItalic ? 'text-slate-400 dark:text-slate-500 italic' : 'text-slate-300 dark:text-slate-600')}>{placeholder}</span>
            : <span className="text-slate-300 dark:text-slate-600">—</span>
        )}
      </dd>
    </div>
  );
}
