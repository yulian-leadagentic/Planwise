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
 *   • Task name (with " (Personal)" suffix for personal tasks — UI-2)
 *   • Priority badge (right of the task name — UI-3)
 *   • Comment indicator (bubble + count, next to priority — UI-4)
 *   • Labeled rows — Zone / Service / Deliverable / BIM Leader
 *   • Due-date pill (red + "!" + tooltip when overdue/at-risk — UI-1)
 *   • Optional Log Time CTA slot on the bottom-right
 */

import { Calendar, AlertCircle, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatShortDate } from '@/lib/date-utils';

// Priority chip palette (QA5 UI-3 — moved from the My Tasks card). The
// badge styling matches the project Kanban's existing priority chip:
// muted border + tinted background, full dark variants for parity.
const PRIORITY_STYLE: Record<string, string> = {
  critical: 'bg-red-50 border-red-200 text-red-700 dark:bg-red-500/15 dark:border-red-500/40 dark:text-red-300',
  high:     'bg-orange-50 border-orange-200 text-orange-700 dark:bg-orange-500/15 dark:border-orange-500/40 dark:text-orange-300',
  medium:   'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-500/15 dark:border-amber-500/40 dark:text-amber-300',
  low:      'bg-slate-100 border-slate-200 text-slate-600 dark:bg-slate-700/50 dark:border-slate-600 dark:text-slate-300',
};

export interface TaskCardBodyProps {
  task: any;
  /** When true, task overdue → red pill. Consumers pass their own
   *  policy (health.isOverdue on the My Tasks Kanban, endDate<now on
   *  simpler surfaces). Defaults to naive endDate<today. */
  isOverdue?: boolean;
  /** When true, we also color the date pill red + "!" even if the
   *  task isn't technically overdue — covers "at-risk / due now".
   *  Consumers pass health.level === 'critical' or similar. */
  isAtRisk?: boolean;
  /** Reason text (first line of health.reasons) — rendered as a
   *  tooltip on the date pill when overdue/at-risk (UI-1 replaces
   *  the old standalone red banner). */
  dueReason?: string;
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

export function TaskCardBody({ task, isOverdue, isAtRisk, dueReason, actionSlot, compact = false, hideProject = false }: TaskCardBodyProps) {
  const projectName = task.project?.name ?? task.label?.projectName ?? '';
  const zoneName = task.zone?.name ?? task.label?.name ?? '';
  const service = task.phase?.name ?? '';
  const deliverable = task.deliverableTemplate?.name ?? task.projectDeliverable?.name ?? task.serviceType?.name ?? '';
  const bimLeader = task.project?.bimLeader
    ? `${task.project.bimLeader.firstName ?? ''} ${task.project.bimLeader.lastName ?? ''}`.trim()
    : '';
  const overdue = isOverdue ?? (task.endDate ? new Date(task.endDate) < new Date() && task.status !== 'completed' && task.status !== 'done' : false);
  // UI-1: a task is "due-highlighted" (red date + "!" + tooltip) when
  // the parent passes either overdue or at-risk. Mirrors the former
  // standalone red banner's trigger.
  const dueHighlighted = overdue || !!isAtRisk;

  // UI-2: personal-task suffix. Rendered as muted text so the name
  // stays the primary focus; the suffix is a cue, not a label.
  const isPersonal = !!task.isPersonal;

  // UI-3: priority badge key.
  const priority = typeof task.priority === 'string' ? task.priority.toLowerCase() : '';
  const priorityCls = PRIORITY_STYLE[priority];

  // UI-4: comment indicator. Prefer the explicit commentCount surfaced
  // by the API; fall back to _count.comments (direct Prisma shape) so
  // this stays safe on any payload that already includes _count.
  const commentCount = Number(task.commentCount ?? task._count?.comments ?? 0);

  return (
    <div className="px-3.5 pb-3 pt-1">
      {!hideProject && projectName && (
        <p className="text-[13px] font-bold text-slate-900 dark:text-slate-100 truncate mb-0.5" title={projectName}>
          {projectName}
        </p>
      )}

      {/* UI-2 + UI-3 + UI-4: task name row — name on the left,
          priority badge + comment indicator pulled to the right.
          `flex items-start` keeps the badges top-aligned with multi-
          line task names. */}
      <div className="flex items-start gap-2 mb-2.5">
        <p className="flex-1 min-w-0 text-[13px] font-semibold text-slate-800 dark:text-slate-100 leading-tight break-words">
          {task.name}
          {isPersonal && (
            <span className="ml-1 text-slate-400 dark:text-slate-500 font-normal">(Personal)</span>
          )}
        </p>
        {priorityCls && (
          <span
            className={cn(
              'shrink-0 inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-bold capitalize',
              priorityCls,
            )}
            title={`Priority: ${priority}`}
          >
            {priority}
          </span>
        )}
        {commentCount > 0 && (
          <span
            className="shrink-0 inline-flex items-center gap-0.5 text-green-600 dark:text-green-400"
            aria-label={`${commentCount} comment${commentCount === 1 ? '' : 's'}`}
            title={`${commentCount} comment${commentCount === 1 ? '' : 's'}`}
          >
            <MessageSquare className="h-3 w-3" />
            <span className="text-[10px] font-bold tabular-nums leading-none">{commentCount}</span>
          </span>
        )}
      </div>

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
          // UI-1: due-date pill. When overdue/at-risk, color the pill
          // red, add an inline "!" indicator and attach the former
          // red-banner text as a tooltip on the pill (keyboard-reachable
          // via tabIndex=0; the "!" carries the meaning so this is not
          // color-only).
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] font-semibold tabular-nums',
              'focus:outline-none focus:ring-2 focus:ring-red-300 dark:focus:ring-red-500/50',
              dueHighlighted
                ? 'bg-red-50 border-red-200 text-red-700 dark:bg-red-500/15 dark:border-red-500/40 dark:text-red-300'
                : 'bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200',
            )}
            tabIndex={dueHighlighted && dueReason ? 0 : undefined}
            title={dueHighlighted ? (dueReason || 'Due soon') : undefined}
            aria-label={dueHighlighted ? (dueReason ? `Due ${formatShortDate(task.endDate)} — ${dueReason}` : `Due ${formatShortDate(task.endDate)}`) : undefined}
          >
            <Calendar className="h-3 w-3" />
            {formatShortDate(task.endDate)}
            {dueHighlighted && (
              <AlertCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" aria-hidden="true" />
            )}
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
