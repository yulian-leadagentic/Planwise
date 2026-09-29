import { User as UserIcon, GripVertical, AlertCircle, AlertTriangle, Calendar, Info } from 'lucide-react';
import { useDraggable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { getTaskHealth } from '@/lib/task-health';
import { ZONE_BORDER_COLORS, formatShortDate } from '@/lib/task-constants';
import { QuickTimeLog } from './quick-time-log';

// Priority chip palette — QA4 · MT-4 (2026-09-29). Restores the chip
// missing vs the target mockup. Muted borders + tinted background;
// full `dark:` variants for parity with the rest of the card.
const PRIORITY_STYLE: Record<string, string> = {
  critical: 'bg-red-50 border-red-200 text-red-700 dark:bg-red-500/15 dark:border-red-500/40 dark:text-red-300',
  high:     'bg-orange-50 border-orange-200 text-orange-700 dark:bg-orange-500/15 dark:border-orange-500/40 dark:text-orange-300',
  medium:   'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-500/15 dark:border-amber-500/40 dark:text-amber-300',
  low:      'bg-slate-100 border-slate-200 text-slate-600 dark:bg-slate-700/50 dark:border-slate-600 dark:text-slate-300',
};

export function DraggableTaskCard({ task, onOpenDrawer }: { task: any; onOpenDrawer: (id: number) => void; onStatusChange?: (taskId: number, status: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `task-${task.id}` });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  const zoneType = task.zone?.zoneType || 'zone';
  const projectName = task.project?.name || task.label?.projectName || '';
  const zoneName = task.zone?.name || task.label?.name || '';
  const health = getTaskHealth(task);
  const priority = typeof task.priority === 'string' ? task.priority.toLowerCase() : '';
  const priorityCls = PRIORITY_STYLE[priority];
  const note = typeof task.description === 'string' ? task.description.trim() : '';

  // BIM Leader is enriched onto the task's project by /projects/:id/findOne;
  // /my-tasks doesn't include it, but we surface whatever's on the payload
  // and fall back to em-dash so the row keeps its shape.
  const bimLeader = task.project?.bimLeader
    ? `${task.project.bimLeader.firstName ?? ''} ${task.project.bimLeader.lastName ?? ''}`.trim()
    : '';

  const assignees: any[] = Array.isArray(task.assignees) ? task.assignees : [];
  const extraAssignees = Math.max(0, assignees.length - 1);

  const cardBorder =
    health.level === 'critical' ? 'border-red-300 ring-1 ring-red-200'
    : health.level === 'warning' ? 'border-amber-300'
    : 'border-slate-200 dark:border-slate-700';

  return (
    // Card redesign (T-fix Tier A #11, 2026-06-30) — matches the mockup:
    // structured labeled field rows, red due-date pill, blue Log Time
    // CTA. Drag handle sits on the left edge; the card body opens the
    // drawer on click; status change is still accessible via the status
    // pill in the header.
    <div ref={setNodeRef} style={style} {...attributes}
      className={cn(
        'rounded-[14px] border bg-white dark:bg-slate-900 shadow-sm hover:shadow-md transition-shadow duration-100 border-l-[3px] overflow-hidden',
        cardBorder,
        ZONE_BORDER_COLORS[zoneType] || 'border-l-slate-300',
        isDragging && 'opacity-40 shadow-lg ring-2 ring-blue-300 z-50',
      )}
    >
      {/* Header — drag handle, project name, assignee pill on the right. */}
      <div {...listeners} className="flex items-center gap-2 px-3.5 pt-3 pb-1.5 cursor-grab active:cursor-grabbing">
        <GripVertical className="h-3.5 w-3.5 text-slate-300 dark:text-slate-600 shrink-0" />
        {projectName && (
          <span className="text-[13px] font-bold text-slate-900 dark:text-slate-100 truncate flex-1" title={projectName}>{projectName}</span>
        )}
        {assignees.length > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 shrink-0"
            title={assignees.map(a => `${a.user?.firstName ?? ''} ${a.user?.lastName ?? ''}`.trim()).join(', ')}
          >
            <UserIcon className="h-3 w-3" />
            {extraAssignees > 0 ? `+${extraAssignees}` : '1'}
          </span>
        )}
        {health.level === 'critical' && <AlertCircle className="h-3.5 w-3.5 text-red-600 shrink-0" />}
        {health.level === 'warning' && <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
        {/* MT-2 (QA4 · 2026-09-29): task-notes affordance. When the
            task has a description, show a small (i) icon top-right;
            hover reveals the text via title. Click-safe — swallows
            the event so it doesn't open the drawer or start a drag.
            No icon when the note is empty. */}
        {note && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); }}
            onMouseDown={(e) => e.stopPropagation()}
            className="shrink-0 flex items-center text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 cursor-help"
            title={note}
            aria-label="Task notes"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Body — clickable to open drawer. Fields laid out as labeled rows. */}
      <div className="px-3.5 pb-3 pt-1 cursor-pointer" onClick={() => onOpenDrawer(task.id)}>
        {/* Task name (subtitle to the project). */}
        <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 leading-tight break-words mb-2.5">
          {task.name}
        </p>

        {/* MT-4 (QA4 · 2026-09-29): priority chip restored — missing
            vs the locked mockup. Only renders when task.priority is a
            known key. `task.priority` already ships on /my-tasks. */}
        {priorityCls && (
          <div className="mb-2.5">
            <span
              className={cn(
                'inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-bold capitalize',
                priorityCls,
              )}
            >
              {priority}
            </span>
          </div>
        )}

        {/* Labeled field grid — ZONE / SERVICE / DELIVERABLE / BIM LEADER.
            Each row: 10px uppercase slate-400 label + slate-700 value. */}
        <dl className="text-[12px] space-y-1 mb-3">
          <div className="flex items-baseline gap-2">
            <dt className="w-[74px] shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">Zone</dt>
            <dd className="text-slate-700 dark:text-slate-200 truncate min-w-0" title={zoneName || 'Project Root'}>
              {zoneName || <span className="text-slate-400 dark:text-slate-500 italic">Project Root</span>}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="w-[74px] shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">Service</dt>
            <dd className="text-slate-700 dark:text-slate-200 truncate min-w-0" title={task.phase?.name ?? ''}>
              {task.phase?.name || <span className="text-slate-300 dark:text-slate-600">—</span>}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="w-[74px] shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">Deliverable</dt>
            <dd className="text-slate-700 dark:text-slate-200 truncate min-w-0" title={task.deliverableTemplate?.name ?? task.serviceType?.name ?? ''}>
              {task.deliverableTemplate?.name || task.serviceType?.name || <span className="text-slate-300 dark:text-slate-600">—</span>}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="w-[74px] shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">BIM Leader</dt>
            <dd className="text-slate-700 dark:text-slate-200 truncate min-w-0" title={bimLeader}>
              {bimLeader || <span className="text-slate-300 dark:text-slate-600">—</span>}
            </dd>
          </div>
        </dl>

        {/* Risk banner — kept subtle, right above the CTA row. */}
        {health.reasons.length > 0 && (
          <div className={cn(
            'rounded-md px-2 py-1 text-[10px] mb-2 font-medium',
            health.level === 'critical' ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-amber-50 text-amber-700 border border-amber-200',
          )}>
            {health.reasons[0]}
          </div>
        )}

        {/* Bottom row — due-date pill on the left, Log Time CTA on the
            right. The date pill is red when overdue, slate otherwise. */}
        <div className="flex items-center gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
          {task.endDate ? (
            <span className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] font-semibold tabular-nums',
              health.isOverdue
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
          <div className="ml-auto">
            <QuickTimeLog taskId={task.id} taskProjectId={task.projectId} />
          </div>
        </div>

        {/* MT-1 (QA4 · 2026-09-29): the per-card status <select> was
            removed — status changes by dragging the card between
            columns, which is the primary Kanban gesture. Removing the
            select declutters the card and matches the target mockup. */}
      </div>
    </div>
  );
}
