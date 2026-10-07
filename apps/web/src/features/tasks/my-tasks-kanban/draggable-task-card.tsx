import { User as UserIcon, GripVertical, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { useDraggable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { getTaskHealth } from '@/lib/task-health';
import { ZONE_BORDER_COLORS } from '@/lib/task-constants';
import { TaskCardBody } from '@/components/shared/task-card-body';
import { QuickTimeLog } from './quick-time-log';

export function DraggableTaskCard({ task, onOpenDrawer }: { task: any; onOpenDrawer: (id: number) => void; onStatusChange?: (taskId: number, status: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `task-${task.id}` });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  const zoneType = task.zone?.zoneType || 'zone';
  const projectName = task.project?.name || task.label?.projectName || '';
  const health = getTaskHealth(task);
  const note = typeof task.description === 'string' ? task.description.trim() : '';

  const assignees: any[] = Array.isArray(task.assignees) ? task.assignees : [];
  // QA5 UI-5: the person-icon + count chip only reads useful when there
  // are 2+ assignees — a single assignee needs no counter. Hidden for
  // 0/1 so the header doesn't carry noise.
  const showAssigneeCount = assignees.length >= 2;

  const cardBorder =
    health.level === 'critical' ? 'border-red-300 ring-1 ring-red-200'
    : health.level === 'warning' ? 'border-amber-300'
    : 'border-slate-200 dark:border-slate-700';

  // QA5 UI-1: the former standalone red "Due in Xd, not started" banner
  // moves into a tooltip on the due-date pill (via TaskCardBody). We
  // compute the "at risk" signal and the reason here, then hand both to
  // the shared body.
  const dueHighlighted = health.level === 'critical' || health.isOverdue;
  const dueReason = health.reasons[0];

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
        {showAssigneeCount && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 shrink-0 dark:bg-amber-500/15 dark:border-amber-500/40 dark:text-amber-300"
            title={assignees.map(a => `${a.user?.firstName ?? ''} ${a.user?.lastName ?? ''}`.trim()).join(', ')}
          >
            <UserIcon className="h-3 w-3" />
            {assignees.length}
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

      {/* Body — clickable to open drawer. Delegates to the shared
          TaskCardBody so every QA5 UI-1..5 change applies here and on
          every other task-display surface at the same time. */}
      <div className="cursor-pointer" onClick={() => onOpenDrawer(task.id)}>
        <TaskCardBody
          task={task}
          isOverdue={health.isOverdue}
          isAtRisk={dueHighlighted}
          dueReason={dueReason}
          hideProject
          actionSlot={
            <div onClick={(e) => e.stopPropagation()}>
              <QuickTimeLog taskId={task.id} taskProjectId={task.projectId} />
            </div>
          }
        />

        {/* MT-1 (QA4 · 2026-09-29): the per-card status <select> was
            removed — status changes by dragging the card between
            columns, which is the primary Kanban gesture. Removing the
            select declutters the card and matches the target mockup.
            QA5 UI-1: the former standalone red "Due in …, not started"
            banner was also removed from here — the signal now lives in
            the due-date pill's red + "!" + tooltip inside TaskCardBody. */}
      </div>
    </div>
  );
}
