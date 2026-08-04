import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, User as UserIcon, GripVertical, CalendarClock, ListChecks, Columns3, Play, Check, AlertCircle, AlertTriangle, Calendar, Plus, X } from 'lucide-react';
import { DndContext, DragOverlay, closestCorners, PointerSensor, KeyboardSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent, useDraggable, useDroppable } from '@dnd-kit/core';
import { PageHeader } from '@/components/shared/page-header';
import { TaskDrawer } from './task-drawer';
import { useDrawerRoute } from '@/components/nav/use-drawer-route';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { tasksApi } from '@/api/tasks.api';
import { timeApi } from '@/api/time.api';
import client from '@/api/client';
import { getTaskHealth } from '@/lib/task-health';
import { STATUS_PILL, STATUS_LABEL, ZONE_BORDER_COLORS, formatShortDate } from '@/lib/task-constants';
import { queryKeys } from '@/lib/query-keys';
import { useAllowedTransitions } from '@/hooks/use-allowed-transitions';
import { useOverlapConfirm } from '@/features/time/overlap-confirm';

type TabMode = 'time' | 'kanban' | 'upcoming';

const columns = [
  { id: 'not_started', label: 'To Do', color: 'border-t-slate-400', bg: 'bg-slate-50/50' },
  { id: 'in_progress', label: 'In Progress', color: 'border-t-blue-500', bg: 'bg-blue-50/30' },
  { id: 'in_review', label: 'In Review', color: 'border-t-violet-500', bg: 'bg-violet-50/30' },
  { id: 'completed', label: 'Done', color: 'border-t-emerald-500', bg: 'bg-emerald-50/30' },
];

// zoneBorderColors imported from '@/lib/task-constants' as ZONE_BORDER_COLORS

function getTaskScore(task: any): number {
  let score = 0;
  const now = Date.now();
  if (task.endDate) {
    const daysUntilDue = (new Date(task.endDate).getTime() - now) / 86400000;
    if (daysUntilDue < 0) score += 1000;
    else if (daysUntilDue < 3) score += 500;
    else if (daysUntilDue < 7) score += 200;
    else if (daysUntilDue < 14) score += 100;
    else score += 50;
  }
  if (task.priority === 'critical') score += 400;
  else if (task.priority === 'high') score += 200;
  else if (task.priority === 'medium') score += 50;
  if (task.budgetHours && Number(task.budgetHours) > 0) score += 20;
  return score;
}

// Calculate "Start no later than" = dueDate - estimatedHours (in working days)
function getStartByDate(task: any): string | null {
  if (!task.endDate || !task.budgetHours) return null;
  const hours = Number(task.budgetHours);
  if (hours <= 0) return null;
  const workingDays = Math.ceil(hours / 8); // 8h per day
  const due = new Date(task.endDate);
  let d = new Date(due);
  let counted = 0;
  while (counted < workingDays) {
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 5 && dow !== 6) counted++; // Skip Fri+Sat
  }
  return formatShortDate(d);
}

/**
 * Time dropdown — 15-minute slots from 06:00 to 22:00, same options
 * the Add Timesheet Entry modal uses. Extracted so QuickTimeLog and
 * the My Tasks list-view row share the same control shape (V10
 * unification: every time-entry UI in the app reads the same).
 */
const TIME_SLOTS: string[] = (() => {
  const slots: string[] = [];
  for (let h = 6; h <= 22; h++) {
    for (const m of [0, 15, 30, 45]) {
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return slots;
})();

function TimeDropdown({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-1.5 rounded-md border border-slate-200 text-[12px] focus:border-blue-400 focus:outline-none bg-white"
    >
      {/* Allow whatever the current value is, even if off-grid (e.g.
          legacy 09:07). Keeps the rendered <option> identifiable. */}
      {!TIME_SLOTS.includes(value) && value && <option value={value}>{value}</option>}
      {TIME_SLOTS.map((t) => (
        <option key={t} value={t}>{t}</option>
      ))}
    </select>
  );
}

/**
 * Inline time-logging panel embedded inside a task card.
 *
 * UI notes:
 *   • Renders as a white, neutral-bordered panel so it doesn't fight the
 *     parent card's red/amber background when the task is overdue/at-risk.
 *     (The previous blue-on-blue panel clashed badly on red cards.)
 *   • Surfaces the user's prior reporting on the task at the top — users
 *     were complaining that they only saw the NEW-entry form and had no
 *     visibility into what they'd already logged. The full history list
 *     lives on the task drawer; this is a compact "last 5" view inline.
 *   • Time controls match the Add Timesheet Entry modal: Start Time /
 *     End Time dropdowns + Total Hours readout in 3 columns. Same look
 *     as the weekly timesheet.
 *   • The whole panel stopsPropagation so clicks inside (date/time inputs,
 *     the history list) don't bubble up and open the task drawer.
 */
function QuickTimeLog({ taskId, taskProjectId }: { taskId: number; taskProjectId?: number | null }) {
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().split('T')[0];
  const [date, setDate] = useState(today);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('10:00');
  const [note, setNote] = useState('');
  const queryClient = useQueryClient();

  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const totalMinutes = Math.max(0, (eh * 60 + em) - (sh * 60 + sm));
  const totalHours = (totalMinutes / 60).toFixed(2);

  // Pull history only when the panel is open — keeps the dashboard cheap
  // when the user just glances at the kanban. The endpoint is scoped
  // server-side to the caller's userId, so this returns only THIS user's
  // prior reporting on this task.
  const { data: historyRaw } = useQuery({
    queryKey: queryKeys.time.entriesByTask(taskId),
    queryFn: () => timeApi.listEntries({ taskId }),
    enabled: open,
    staleTime: 30 * 1000,
  });
  const history: any[] = (() => {
    const raw = historyRaw as any;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (raw.data && Array.isArray(raw.data)) return raw.data;
    return [];
  })();
  const historyTotalMin = history.reduce((s, e) => s + (e.minutes ?? 0), 0);

  const overlap = useOverlapConfirm();
  const [saving, setSaving] = useState(false);

  // Cross-task overlap → confirm dialog, then retry with confirmOverlap.
  // Same-task overlap → backend rejects, notify.apiError surfaces it.
  const handleLog = () => {
    if (totalMinutes <= 0) return;
    setSaving(true);
    overlap.withConfirm(
      (confirmOverlap) => timeApi.createEntry({
        taskId,
        projectId: taskProjectId ?? undefined,
        date,
        startTime: start,
        endTime: end,
        minutes: totalMinutes,
        note: note.trim() || undefined,
        isBillable: true,
        confirmOverlap,
      }),
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: queryKeys.time.all });
          queryClient.invalidateQueries({ queryKey: queryKeys.tasks.mine() });
          queryClient.invalidateQueries({ queryKey: queryKeys.time.entriesByTask(taskId) });
          notify.success(`Logged ${totalHours}h`, { code: 'TIME-LOG-200' });
          setNote('');
        },
      },
    ).finally(() => setSaving(false));
  };

  if (!open) {
    return (
      <button onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-600 hover:bg-blue-100">
        <Clock className="h-3 w-3" /> Log Time
      </button>
    );
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="mt-2 rounded-md border border-slate-200 bg-white shadow-sm overflow-hidden"
    >
      {overlap.dialog}
      {/* History header — totals + count, with collapse toggle for the
          panel itself. Neutral palette so it stays readable on top of any
          parent-card border (red/amber for at-risk, white for OK). */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-slate-100 bg-slate-50">
        <div className="flex items-center gap-1.5 text-[10px] text-slate-600 min-w-0">
          <Clock className="h-3 w-3 text-slate-400 shrink-0" />
          <span className="font-semibold">Your time</span>
          {history.length > 0 ? (
            <span className="tabular-nums truncate">
              · {(historyTotalMin / 60).toFixed(2)}h across {history.length}
            </span>
          ) : (
            <span className="text-slate-400 italic">no entries yet</span>
          )}
        </div>
        <button
          onClick={() => setOpen(false)}
          className="text-[12px] leading-none text-slate-400 hover:text-slate-600 shrink-0 px-1"
          aria-label="Close time log panel"
        >
          ×
        </button>
      </div>

      {/* Past entries (capped to 5 inline; deeper history lives on the
          task drawer's Time tab via "open task for full history"). */}
      {history.length > 0 && (
        <div className="max-h-28 overflow-y-auto border-b border-slate-100 divide-y divide-slate-50">
          {history.slice(0, 5).map((e: any) => (
            <div key={e.id} className="flex items-center gap-2 px-2 py-1 text-[10px]">
              <span className="text-slate-500 tabular-nums w-[52px] shrink-0">
                {e.date ? formatShortDate(e.date) : '—'}
              </span>
              <span className="text-slate-400 tabular-nums w-[78px] shrink-0">
                {e.startTime && e.endTime ? `${e.startTime}–${e.endTime}` : ''}
              </span>
              <span className="font-semibold text-slate-700 tabular-nums w-[36px] shrink-0">
                {((e.minutes ?? 0) / 60).toFixed(2)}h
              </span>
              {e.note && (
                <span className="text-slate-500 truncate flex-1" title={e.note}>{e.note}</span>
              )}
            </div>
          ))}
          {history.length > 5 && (
            <div className="px-2 py-1 text-[10px] text-slate-400 text-center">
              + {history.length - 5} more — open task for full history
            </div>
          )}
        </div>
      )}

      {/* New-entry form — matches the Add Timesheet Entry visual
          language: Start Time / End Time / Total Hours triplet with
          dropdowns + grey readout. V10 unification. */}
      <div className="px-3 py-2 space-y-2 border-l-2 border-blue-400/40">
        <div>
          <label className="text-[10px] font-semibold text-slate-600 mb-1 block">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="w-full px-2 py-1.5 rounded-md border border-slate-200 text-[12px] focus:border-blue-400 focus:outline-none" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[10px] font-semibold text-slate-600 mb-1 block">Start Time</label>
            <TimeDropdown value={start} onChange={setStart} />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-slate-600 mb-1 block">End Time</label>
            <TimeDropdown value={end} onChange={setEnd} />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-slate-600 mb-1 block">Total Hours</label>
            <div className="w-full px-2 py-1.5 rounded-md border border-slate-200 bg-slate-50 text-[12px] text-slate-600 tabular-nums">
              {totalHours}h
            </div>
          </div>
        </div>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Description (optional)…"
          className="w-full px-2 py-1.5 rounded-md border border-slate-200 text-[12px] focus:border-blue-400 focus:outline-none" />
        <div className="flex justify-end gap-1.5 pt-1">
          <button onClick={() => setOpen(false)} className="rounded-md border border-slate-200 px-3 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
            Cancel
          </button>
          <button onClick={handleLog}
            disabled={totalMinutes <= 0 || saving}
            className="rounded-md bg-blue-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {saving ? 'Saving...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DraggableTaskCard({ task, onOpenDrawer, onStatusChange }: { task: any; onOpenDrawer: (id: number) => void; onStatusChange: (taskId: number, status: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `task-${task.id}` });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  const zoneType = task.zone?.zoneType || 'zone';
  const projectName = task.project?.name || task.label?.projectName || '';
  const zoneName = task.zone?.name || task.label?.name || '';
  const health = getTaskHealth(task);

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
    : 'border-slate-200';

  return (
    // Card redesign (T-fix Tier A #11, 2026-06-30) — matches the mockup:
    // structured labeled field rows, red due-date pill, blue Log Time
    // CTA. Drag handle sits on the left edge; the card body opens the
    // drawer on click; status change is still accessible via the status
    // pill in the header.
    <div ref={setNodeRef} style={style} {...attributes}
      className={cn(
        'rounded-[14px] border bg-white shadow-sm hover:shadow-md transition-shadow duration-100 border-l-[3px] overflow-hidden',
        cardBorder,
        ZONE_BORDER_COLORS[zoneType] || 'border-l-slate-300',
        isDragging && 'opacity-40 shadow-lg ring-2 ring-blue-300 z-50',
      )}
    >
      {/* Header — drag handle, project name, assignee pill on the right. */}
      <div {...listeners} className="flex items-center gap-2 px-3.5 pt-3 pb-1.5 cursor-grab active:cursor-grabbing">
        <GripVertical className="h-3.5 w-3.5 text-slate-300 shrink-0" />
        {projectName && (
          <span className="text-[13px] font-bold text-slate-900 truncate flex-1" title={projectName}>{projectName}</span>
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
      </div>

      {/* Body — clickable to open drawer. Fields laid out as labeled rows. */}
      <div className="px-3.5 pb-3 pt-1 cursor-pointer" onClick={() => onOpenDrawer(task.id)}>
        {/* Task name (subtitle to the project). */}
        <p className="text-[13px] font-semibold text-slate-800 leading-tight break-words mb-2.5">
          {task.name}
        </p>

        {/* Labeled field grid — ZONE / SERVICE / DELIVERABLE / BIM LEADER.
            Each row: 10px uppercase slate-400 label + slate-700 value. */}
        <dl className="text-[12px] space-y-1 mb-3">
          <div className="flex items-baseline gap-2">
            <dt className="w-[74px] shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Zone</dt>
            <dd className="text-slate-700 truncate min-w-0" title={zoneName || 'Project Root'}>
              {zoneName || <span className="text-slate-400 italic">Project Root</span>}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="w-[74px] shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Service</dt>
            <dd className="text-slate-700 truncate min-w-0" title={task.phase?.name ?? ''}>
              {task.phase?.name || <span className="text-slate-300">—</span>}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="w-[74px] shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Deliverable</dt>
            <dd className="text-slate-700 truncate min-w-0" title={task.deliverableTemplate?.name ?? task.serviceType?.name ?? ''}>
              {task.deliverableTemplate?.name || task.serviceType?.name || <span className="text-slate-300">—</span>}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="w-[74px] shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400">BIM Leader</dt>
            <dd className="text-slate-700 truncate min-w-0" title={bimLeader}>
              {bimLeader || <span className="text-slate-300">—</span>}
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
                : 'bg-slate-50 border-slate-200 text-slate-700',
            )}>
              <Calendar className="h-3 w-3" />
              {formatShortDate(task.endDate)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-slate-200 px-2 py-1.5 text-[11px] text-slate-400">
              <Calendar className="h-3 w-3" />
              No date
            </span>
          )}
          <div className="ml-auto">
            <QuickTimeLog taskId={task.id} taskProjectId={task.projectId} />
          </div>
        </div>

        {/* Status change — still reachable but demoted below the CTA
            row. Full-width select so it's obvious it's actionable
            without competing with the primary Log Time button. */}
        <div className="pt-2" onClick={(e) => e.stopPropagation()}>
          <KanbanStatusSelect
            status={task.status}
            requiresReview={task.requiresReview !== false}
            onStatusChange={(s) => onStatusChange(task.id, s)}
          />
        </div>
      </div>
    </div>
  );
}

function KanbanStatusSelect({ status, requiresReview = true, onStatusChange }: { status: string; requiresReview?: boolean; onStatusChange: (s: string) => void }) {
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
      className="flex-1 rounded border border-slate-200 bg-white px-1.5 py-1 text-[10px] focus:border-blue-400 focus:outline-none"
    >
      {opts.filter((c) => allowedStatuses.includes(c.id)).map((c) => (
        <option key={c.id} value={c.id}>{c.label}</option>
      ))}
    </select>
  );
}

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
function RowStatusSelect({ taskId, status }: { taskId: number; status: string }) {
  const queryClient = useQueryClient();
  const { allowedStatuses } = useAllowedTransitions(status);
  const statusColor = status === 'completed'
    ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
    : status === 'in_progress'
      ? 'bg-blue-100 text-blue-700 border-blue-200'
      : status === 'in_review'
        ? 'bg-violet-100 text-violet-700 border-violet-200'
        : 'bg-slate-100 text-slate-600 border-slate-200';

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

function DroppableColumn({ column, tasks, onOpenDrawer, onStatusChange }: { column: typeof columns[0]; tasks: any[]; onOpenDrawer: (id: number) => void; onStatusChange: (taskId: number, status: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  // Default the "To Do" column to collapsed when it has many cards so
  // the user sees their active work first. Other columns start expanded.
  // The collapse state is per-column, persisted in localStorage so it
  // sticks across page reloads (kanban is a long-lived view people
  // anchor on; resetting it on every reload was annoying).
  const lsKey = `kanban.collapsed.${column.id}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(lsKey);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch {}
    // Default: collapse "To Do" only when it has more than 10 tasks.
    return column.id === 'not_started' && tasks.length > 10;
  });
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(lsKey, next ? '1' : '0'); } catch {}
      return next;
    });
  };

  return (
    <div ref={setNodeRef}
      className={cn('flex flex-col rounded-[14px] border-t-[3px] transition-all', column.color,
        collapsed ? 'min-h-[80px]' : 'min-h-[400px]',
        isOver ? 'bg-blue-50/60 border-blue-300 border-2 shadow-inner' : `border border-slate-200 ${column.bg}`)}>
      <div className="flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? `Expand ${column.label}` : `Collapse ${column.label}`}
          aria-expanded={!collapsed}
          className="flex items-center gap-2 group"
        >
          <span className={cn('text-slate-400 group-hover:text-slate-600 transition-transform', collapsed ? '-rotate-90' : '')}>
            ▾
          </span>
          <h3 className="text-[13px] font-semibold text-slate-700">{column.label}</h3>
          <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">{tasks.length}</span>
        </button>
      </div>
      {!collapsed && (
      <div className="flex-1 space-y-2 px-3 pb-3">
        {tasks.map((task: any) => (
          <DraggableTaskCard key={task.id} task={task} onOpenDrawer={onOpenDrawer} onStatusChange={onStatusChange} />
        ))}
        {tasks.length === 0 && (
          <div className={cn('py-8 text-center text-[11px] rounded-lg border-2 border-dashed', isOver ? 'border-blue-400 text-blue-500' : 'border-slate-200 text-slate-400')}>
            {isOver ? 'Drop here' : 'No tasks'}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

// ─── Time Reporting Tab ────────────────────────────────────────────────────

function TimeReportingRow({ task, onOpenDrawer }: { task: any; onOpenDrawer: (id: number) => void }) {
  const queryClient = useQueryClient();
  const today = new Date().toISOString().split('T')[0];
  const [date, setDate] = useState(today);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('10:00');
  const [note, setNote] = useState('');
  // Expanding the row reveals BOTH the note input AND the user's prior
  // reporting on the task — users complained they could only see the new
  // entry form, not what they'd already logged. We fetch lazily when the
  // row is expanded so collapsed rows stay free.
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data: historyRaw } = useQuery({
    queryKey: queryKeys.time.entriesByTask(task.id),
    queryFn: () => timeApi.listEntries({ taskId: task.id }),
    enabled: expanded,
    staleTime: 30 * 1000,
  });
  const history: any[] = (() => {
    const raw = historyRaw as any;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (raw.data && Array.isArray(raw.data)) return raw.data;
    return [];
  })();
  const historyTotalMin = history.reduce((s, e) => s + (e.minutes ?? 0), 0);

  const overlap = useOverlapConfirm();

  const projectName = task.project?.name || task.label?.projectName || '';
  const zoneName = task.zone?.name || task.label?.name || '';

  // Due date in DD-MMM format (app-canonical). Overdue is anything with
  // endDate < today and the task isn't already done — same threshold the
  // kanban uses so both views agree about "late".
  const dueLabel = task.endDate ? formatShortDate(task.endDate) : null;
  const isOverdue = (() => {
    if (!task.endDate || task.status === 'completed') return false;
    return new Date(task.endDate).getTime() < new Date(today).getTime();
  })();

  const startMins = (() => { const [h, m] = start.split(':').map(Number); return h * 60 + m; })();
  const endMins = (() => { const [h, m] = end.split(':').map(Number); return h * 60 + m; })();
  const totalMinutes = Math.max(0, endMins - startMins);
  const totalHours = (totalMinutes / 60).toFixed(2);

  const handleLog = () => {
    if (totalMinutes <= 0) { notify.warning('End time must be after start time'); return; }
    setSaving(true);
    overlap.withConfirm(
      (confirmOverlap) => timeApi.createEntry({
        taskId: task.id,
        projectId: task.projectId || undefined,
        date,
        startTime: start,
        endTime: end,
        minutes: totalMinutes,
        note: note.trim() || undefined,
        isBillable: true,
        confirmOverlap,
      }),
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: queryKeys.time.all });
          queryClient.invalidateQueries({ queryKey: queryKeys.tasks.mine() });
          // Force the per-task history below to refresh with the new entry
          queryClient.invalidateQueries({ queryKey: queryKeys.time.entriesByTask(task.id) });
          notify.success(`Logged ${totalHours}h for ${task.name}`);
          setNote('');
        },
      },
    ).finally(() => setSaving(false));
  };

  // TIME_OPTIONS removed — both selects now use the shared
  // TimeDropdown component which reads from module-level TIME_SLOTS.

  // Status pill label / color are now rendered inside RowStatusSelect
  // (clickable inline select). Routes through STATUS_LABEL there so wording
  // stays in sync with every other status pill in the app.

  return (
    <div className="border-b border-slate-100 last:border-b-0">
      {overlap.dialog}
      <div className="flex items-center gap-2 px-4 py-2.5 hover:bg-blue-50/30 transition-colors">
        {/* Task info — name + zone clickable to open the drawer. The status
            select sits ALONGSIDE the clickable region (not nested) because
            <select> can't live inside <button>. The status select stops
            its own propagation so picking a status doesn't also open the
            drawer underneath. */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {projectName && <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 rounded px-1.5 py-0.5 shrink-0">{projectName}</span>}
            <RowStatusSelect taskId={task.id} status={task.status} />
            {/* Assignee avatars — T1.4 also applies to the Time Reporting
                row, not only the Kanban card. Shows up to 4 mini-circles
                so the user sees who else is on the task without opening
                the drawer. Hidden when the row has no assignees so the
                status pill stays flush. */}
            {Array.isArray(task.assignees) && task.assignees.length > 0 && (
              <div className="flex items-center gap-0.5 shrink-0">
                {(task.assignees as any[]).slice(0, 4).map((a) => {
                  const initials = `${a.user?.firstName?.[0] ?? ''}${a.user?.lastName?.[0] ?? ''}` || '?';
                  return (
                    <span
                      key={a.id}
                      className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-[9px] font-extrabold ring-2 ring-white -ml-1 first:ml-0 shadow-sm"
                      title={`${a.user?.firstName ?? ''} ${a.user?.lastName ?? ''}`.trim()}
                    >
                      {initials}
                    </span>
                  );
                })}
                {task.assignees.length > 4 && (
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-slate-200 text-slate-700 text-[9px] font-bold ring-2 ring-white -ml-1 shadow-sm">
                    +{task.assignees.length - 4}
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => onOpenDrawer(task.id)}
            className="block w-full text-left cursor-pointer rounded hover:bg-slate-50 -mx-1 px-1 py-0.5 mt-0.5"
            title="Open task details"
          >
            <p className="text-[13px] font-medium text-slate-800 truncate">{task.name}</p>
            {/* Context line: zone if present, else "Project Root" + phase so
                the row isn't silently bucket-less. Same convention as the
                kanban card and the timesheet picker. */}
            {zoneName ? (
              <p className="text-[10px] text-slate-500 truncate">{zoneName}</p>
            ) : (
              <p className="text-[10px] text-slate-400 italic truncate">
                Project Root
                {task.phase?.name ? ` · ${task.phase.name}` : task.serviceType?.name ? ` · ${task.serviceType.name}` : ''}
              </p>
            )}
          </button>
        </div>

        {/* Due date column — emphasized per user feedback 2026-06-22.
            Bigger font + colored pill so the deadline reads at a glance:
            overdue = red, due within 3 days = amber, future = slate. */}
        <div className="w-[96px] text-center shrink-0">
          {dueLabel ? (() => {
            const days = Math.floor(
              (new Date(task.endDate as string).getTime() - new Date(today).getTime()) / 86400000,
            );
            const tone = isOverdue
              ? 'bg-red-100 text-red-700 border-red-200'
              : days <= 3
                ? 'bg-amber-100 text-amber-700 border-amber-200'
                : 'bg-slate-100 text-slate-700 border-slate-200';
            return (
              <span className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] font-bold tabular-nums',
                tone,
              )}>
                <Calendar className="h-3.5 w-3.5" />
                {dueLabel}
              </span>
            );
          })() : (
            <span className="text-[11px] text-slate-300">—</span>
          )}
        </div>

        {/* Date */}
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="w-[130px] rounded-md border border-slate-200 px-2 py-1.5 text-[12px] focus:border-blue-400 focus:outline-none shrink-0" />

        {/* Start / End / Total — same shape as Add Timesheet Entry modal
            (V10 unification). Dropdown style, no arrow separator,
            grey readout for total. The row-level layout keeps them
            inline since this is a per-task list, not a single-task
            modal — but the visual treatment matches. */}
        <div className="w-[80px] shrink-0">
          <TimeDropdown value={start} onChange={setStart} />
        </div>
        <div className="w-[80px] shrink-0">
          <TimeDropdown value={end} onChange={setEnd} />
        </div>
        <div className="w-[58px] shrink-0">
          <div className="px-2 py-1.5 rounded-md border border-slate-200 bg-slate-50 text-[12px] text-center tabular-nums text-slate-600">
            {totalHours}h
          </div>
        </div>

        {/* Expand toggle — opens a panel with the user's prior entries on
            this task plus a note field for the new entry. Renamed from
            "+ Note" since the panel now does more than just notes. */}
        <button onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-slate-400 hover:text-slate-600 shrink-0 w-14 text-center">
          {expanded ? 'Hide' : 'Details'}
        </button>

        {/* Log button */}
        <button onClick={handleLog} disabled={saving || totalMinutes <= 0}
          className="flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50 shrink-0">
          {saving ? <Clock className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          Log
        </button>
      </div>

      {/* Expanded panel — note input + this user's reporting history on
          the task. Listing history here addresses the "I only see the
          new entry, not what I've already logged" feedback. */}
      {expanded && (
        <div className="px-4 pb-3 pl-8 bg-slate-50/60 border-t border-slate-100 space-y-2 pt-2">
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="What did you work on? (optional)"
            className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[12px] focus:border-blue-400 focus:outline-none" />

          {/* History list — same column convention as the QuickTimeLog
              panel on the kanban card for consistency. */}
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 mb-1 px-0.5">
              <span className="font-semibold uppercase tracking-wider">Your reporting on this task</span>
              {history.length > 0 ? (
                <span className="tabular-nums">
                  {(historyTotalMin / 60).toFixed(2)}h · {history.length}{' '}
                  {history.length === 1 ? 'entry' : 'entries'}
                </span>
              ) : null}
            </div>
            {history.length === 0 ? (
              <p className="text-[11px] text-slate-400 italic px-0.5">No entries yet — log your first above.</p>
            ) : (
              <div className="rounded-md border border-slate-200 bg-white divide-y divide-slate-100 max-h-40 overflow-y-auto">
                {history.slice(0, 10).map((e: any) => (
                  <div key={e.id} className="flex items-center gap-3 px-3 py-1.5 text-[11px]">
                    <span className="text-slate-600 tabular-nums w-[60px] shrink-0">
                      {e.date ? formatShortDate(e.date) : '—'}
                    </span>
                    <span className="text-slate-400 tabular-nums w-[90px] shrink-0">
                      {e.startTime && e.endTime ? `${e.startTime}–${e.endTime}` : ''}
                    </span>
                    <span className="font-semibold text-slate-700 tabular-nums w-[42px] shrink-0">
                      {((e.minutes ?? 0) / 60).toFixed(2)}h
                    </span>
                    {e.note && (
                      <span className="text-slate-500 truncate flex-1" title={e.note}>{e.note}</span>
                    )}
                  </div>
                ))}
                {history.length > 10 && (
                  <div className="px-3 py-1.5 text-[10px] text-slate-400 text-center">
                    + {history.length - 10} more entries — open task for full history
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Upcoming-view buckets — derived from each task's endDate vs. today.
 * Order matters: the UI renders sections in this order, so the most
 * urgent rolls to the top.
 */
type DueBucket = 'overdue' | 'today' | 'this_week' | 'next_week' | 'later' | 'no_date';
const DUE_BUCKETS: { key: DueBucket; label: string; tone: string }[] = [
  { key: 'overdue',   label: 'Overdue',     tone: 'border-red-200 bg-red-50/40 text-red-700' },
  { key: 'today',     label: 'Due Today',   tone: 'border-amber-200 bg-amber-50/40 text-amber-700' },
  { key: 'this_week', label: 'This Week',   tone: 'border-blue-200 bg-blue-50/40 text-blue-700' },
  { key: 'next_week', label: 'Next Week',   tone: 'border-violet-200 bg-violet-50/40 text-violet-700' },
  { key: 'later',     label: 'Later',       tone: 'border-slate-200 bg-slate-50/60 text-slate-600' },
  { key: 'no_date',   label: 'No Due Date', tone: 'border-slate-200 bg-slate-50/60 text-slate-500' },
];

/**
 * Decide which Upcoming bucket a task belongs to.
 *
 * Buckets reflect what the user needs to ACT on this week — not just
 * "when is the deadline?". A 2-month task that started last week and
 * is due next month still belongs in "This Week", because the user is
 * actively working on it now. The old version only looked at endDate,
 * so multi-week tasks slid into "Later" and disappeared from the
 * actionable view.
 *
 * Priority (first match wins):
 *   1. completed/cancelled → 'later' (out of focus)
 *   2. endDate in the past → 'overdue' (must catch up)
 *   3. endDate == today → 'today'
 *   4. [startDate, endDate] overlaps [today, today+7d] → 'this_week'
 *      (covers: starts/ends this week, AND active multi-week tasks
 *       whose start is already in the past)
 *   5. starts or ends in days 8–14 → 'next_week'
 *   6. else → 'later'
 *   7. no startDate AND no endDate → 'no_date'
 */
function bucketForTask(task: any, todayMs: number): DueBucket {
  if (task.status === 'completed' || task.status === 'cancelled') return 'later';

  const dayMs = 86_400_000;
  const startMs = task.startDate ? new Date(task.startDate).getTime() : null;
  const endMs = task.endDate ? new Date(task.endDate).getTime() : null;

  if (startMs == null && endMs == null) return 'no_date';

  // Overdue — endDate in the past
  if (endMs != null && endMs < todayMs) return 'overdue';

  // Due today — endDate is exactly today
  if (endMs != null) {
    const dueDay = Math.floor((endMs - todayMs) / dayMs);
    if (dueDay === 0) return 'today';
  }

  const weekEndMs = todayMs + 7 * dayMs;
  // "Active this week" — the task's [startDate, endDate] window overlaps
  // the next 7 days. A null endDate is treated as open-ended (still
  // ongoing). A null startDate falls back to the endDate-only check so
  // deadline-only tasks still slot in.
  const startsByEndOfWeek = startMs != null && startMs <= weekEndMs;
  const stillOpenOrLater = endMs == null || endMs >= todayMs;
  const endsThisWeek = endMs != null && endMs <= weekEndMs;
  if ((startsByEndOfWeek && stillOpenOrLater) || endsThisWeek) {
    return 'this_week';
  }

  const twoWeeksMs = todayMs + 14 * dayMs;
  const startsNextWeek = startMs != null && startMs > weekEndMs && startMs <= twoWeeksMs;
  const endsNextWeek = endMs != null && endMs > weekEndMs && endMs <= twoWeeksMs;
  if (startsNextWeek || endsNextWeek) return 'next_week';

  return 'later';
}

/**
 * "Upcoming" view — same row component as the time-reporting list, but
 * grouped by due-date proximity. Buckets are rendered in urgency order
 * (Overdue first), and empty buckets are skipped so the page stays
 * focused on actionable work.
 */
function UpcomingTab({ tasks, onOpenDrawer }: { tasks: any[]; onOpenDrawer: (id: number) => void }) {
  const todayMs = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t.getTime();
  }, []);

  const grouped = useMemo(() => {
    const m = new Map<DueBucket, any[]>();
    for (const b of DUE_BUCKETS) m.set(b.key, []);
    for (const t of tasks) m.get(bucketForTask(t, todayMs))!.push(t);
    // Within each bucket, sort by endDate ascending (sooner first; tasks
    // without a date go to the end), with task id as tie-breaker.
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        const aT = a.endDate ? new Date(a.endDate).getTime() : Number.POSITIVE_INFINITY;
        const bT = b.endDate ? new Date(b.endDate).getTime() : Number.POSITIVE_INFINITY;
        return (aT - bT) || (a.id ?? 0) - (b.id ?? 0);
      });
    }
    return m;
  }, [tasks, todayMs]);

  return (
    <div className="space-y-4">
      {DUE_BUCKETS.map((b) => {
        const list = grouped.get(b.key) ?? [];
        if (list.length === 0) return null;
        return (
          <div key={b.key} className={cn('rounded-[14px] border bg-white overflow-hidden', b.tone)}>
            <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between bg-white/60">
              <div className="flex items-center gap-2">
                <h3 className="text-[13px] font-semibold">{b.label}</h3>
                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">{list.length}</span>
              </div>
            </div>
            {list.map((task: any) => (
              <TimeReportingRow key={task.id} task={task} onOpenDrawer={onOpenDrawer} />
            ))}
          </div>
        );
      })}
      {/* Empty state when zero tasks across all buckets (shouldn't happen
          when the list is non-empty above, but defensive for stale data) */}
      {tasks.length === 0 && (
        <div className="py-12 text-center">
          <CalendarClock className="mx-auto h-12 w-12 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">Nothing on your plate right now.</p>
        </div>
      )}
    </div>
  );
}

type SortField = 'task' | 'project' | 'status' | 'due';
type SortDir = 'asc' | 'desc';

/** Pure comparator — keeps task IDs stable when sort keys collide. */
function compareTasks(a: any, b: any, field: SortField, dir: SortDir): number {
  const sign = dir === 'asc' ? 1 : -1;
  const tieBreak = (a.id ?? 0) - (b.id ?? 0);
  switch (field) {
    case 'task':
      return sign * String(a.name ?? '').localeCompare(String(b.name ?? '')) || tieBreak;
    case 'project':
      return sign * String(a.project?.name ?? '').localeCompare(String(b.project?.name ?? '')) || tieBreak;
    case 'status': {
      // Order by workflow stage so "Not started → In progress → In review →
      // Done" is the natural ascending order, regardless of the string
      // alphabet.
      const rank: Record<string, number> = { not_started: 0, in_progress: 1, in_review: 2, completed: 3, on_hold: 4, cancelled: 5 };
      return sign * ((rank[a.status] ?? 99) - (rank[b.status] ?? 99)) || tieBreak;
    }
    case 'due': {
      const aT = a.endDate ? new Date(a.endDate).getTime() : Number.POSITIVE_INFINITY;
      const bT = b.endDate ? new Date(b.endDate).getTime() : Number.POSITIVE_INFINITY;
      return sign * (aT - bT) || tieBreak;
    }
  }
}

function TimeReportingTab({ tasks, onOpenDrawer }: { tasks: any[]; onOpenDrawer: (id: number) => void }) {
  // Column sort state per user request 2026-06-22. Default: no sort
  // (null) preserves the existing relevance-based order from the parent.
  // Clicking a header toggles asc → desc → off; clicking a different
  // header resets dir to asc.
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const onHeaderClick = (field: SortField) => {
    if (sortField !== field) { setSortField(field); setSortDir('asc'); return; }
    if (sortDir === 'asc') { setSortDir('desc'); return; }
    setSortField(null);
    setSortDir('asc');
  };

  const sortedTasks = useMemo(() => {
    if (!sortField) return tasks;
    return [...tasks].sort((a, b) => compareTasks(a, b, sortField, sortDir));
  }, [tasks, sortField, sortDir]);

  const activeTasks = sortedTasks.filter((t) => t.status !== 'completed');
  const completedTasks = sortedTasks.filter((t) => t.status === 'completed');

  // Fetch recent time entries for today
  const today = new Date().toISOString().split('T')[0];
  const { data: recentEntriesData } = useQuery({
    queryKey: queryKeys.time.entries({ date: today }),
    queryFn: () => timeApi.listEntries({ date: today }),
    staleTime: 30 * 1000,
  });
  const recentEntries = (() => {
    const raw = recentEntriesData as any;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (raw.data && Array.isArray(raw.data)) return raw.data;
    if (raw.entries && Array.isArray(raw.entries)) return raw.entries;
    return [];
  })();

  const todayTotal = recentEntries.reduce((s: number, e: any) => s + (e.minutes ?? 0), 0);

  return (
    <div className="space-y-4">
      {/* Today's summary */}
      {todayTotal > 0 && (
        <div className="rounded-[14px] border border-green-200 bg-green-50 px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-green-600" />
            <span className="text-[13px] font-semibold text-green-800">Today's total</span>
          </div>
          <span className="text-lg font-bold text-green-700">{(todayTotal / 60).toFixed(2)}h</span>
        </div>
      )}

      {/* Sort-by chip row — separate from the in-row header below so
          users can sort by columns that DON'T have a corresponding
          input on each row (project, status). The label flips between
          "▲" / "▼" / unset and the field clears on a third click. */}
      <div className="flex items-center gap-2 text-[11px] text-slate-500">
        <span className="font-semibold uppercase tracking-wider">Sort by</span>
        {([
          { field: 'project' as const, label: 'Project' },
          { field: 'task' as const, label: 'Task' },
          { field: 'status' as const, label: 'Status' },
          { field: 'due' as const, label: 'Due Date' },
        ]).map((c) => {
          const active = sortField === c.field;
          return (
            <button
              key={c.field}
              type="button"
              onClick={() => onHeaderClick(c.field)}
              className={cn(
                'rounded-md border px-2 py-0.5 font-medium transition-colors',
                active
                  ? 'border-blue-300 bg-blue-50 text-blue-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
              )}
            >
              {c.label}
              {active && <span className="ml-1">{sortDir === 'asc' ? '▲' : '▼'}</span>}
            </button>
          );
        })}
      </div>

      {/* Active tasks */}
      {activeTasks.length > 0 && (
        <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
          <div className="bg-slate-50 px-4 py-2.5 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-[13px] font-semibold text-slate-700">Active Tasks</h3>
              <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-600">{activeTasks.length}</span>
            </div>
            {/* Header labels — widths MUST match TimeReportingRow's column
                widths exactly so columns line up. Source-of-truth for the
                row widths is at TimeReportingRow above: w-[96px] Due,
                w-[130px] Date, w-[80px] Start/End, w-[58px] Total, w-14
                Details button, ~w-[68px] Log button. */}
            <div className="flex items-center gap-2 text-[10px] font-semibold text-slate-400 uppercase tracking-wider pr-1">
              <span className="w-[96px] text-center">Due</span>
              <span className="w-[130px] text-center">Date</span>
              <span className="w-[80px] text-center">Start Time</span>
              <span className="w-[80px] text-center">End Time</span>
              <span className="w-[58px] text-center">Total Hours</span>
              <span className="w-14" />
              <span className="w-[68px]" />
            </div>
          </div>
          {activeTasks.map((task: any) => <TimeReportingRow key={task.id} task={task} onOpenDrawer={onOpenDrawer} />)}
        </div>
      )}

      {/* Completed tasks (collapsed) */}
      {completedTasks.length > 0 && (
        <details className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
          <summary className="bg-slate-50 px-4 py-2.5 border-b border-slate-200 cursor-pointer">
            <span className="text-[13px] font-semibold text-slate-500">Completed Tasks</span>
            <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">{completedTasks.length}</span>
          </summary>
          {completedTasks.map((task: any) => <TimeReportingRow key={task.id} task={task} onOpenDrawer={onOpenDrawer} />)}
        </details>
      )}

      {/* Recent entries today */}
      {recentEntries.length > 0 && (
        <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
          <div className="bg-slate-50 px-4 py-2.5 border-b border-slate-200">
            <h3 className="text-[13px] font-semibold text-slate-700">Today's Entries ({recentEntries.length})</h3>
          </div>
          <div className="divide-y divide-slate-100">
            {recentEntries.map((e: any) => (
              <div key={e.id} className="flex items-center gap-3 px-4 py-2 text-[12px]">
                <span className="text-slate-500 w-28">{e.startTime ?? '-'} – {e.endTime ?? '-'}</span>
                <span className="font-semibold text-slate-700 w-14">{((e.minutes ?? 0) / 60).toFixed(2)}h</span>
                <span className="text-blue-600 font-medium">{e.project?.name ?? ''}</span>
                <span className="text-slate-500 flex-1 truncate">{e.task?.name ?? ''}</span>
                {e.note && <span className="text-slate-600 truncate max-w-[200px]">{e.note}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {tasks.length === 0 && (
        <div className="py-12 text-center">
          <UserIcon className="mx-auto h-12 w-12 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">No tasks assigned to you</p>
        </div>
      )}
    </div>
  );
}

// ─── Kanban Board ──────────────────────────────────────────────────────────

export function MyTasksKanbanPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabMode>('kanban');
  const [showPersonalTaskDialog, setShowPersonalTaskDialog] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // Drawer ID lives in ?task=N so browser-back and outbound-link returns
  // restore the open task automatically. See useDrawerRoute docs.
  const { drawerId: drawerTaskId, openDrawer: setDrawerTaskId, closeDrawer } = useDrawerRoute('task');

  // Filters
  const [filterProjectId, setFilterProjectId] = useState<number | null>(null);
  const [filterServiceId, setFilterServiceId] = useState<number | null>(null);
  const [filterPhaseName, setFilterPhaseName] = useState<string | null>(null);
  // M3 — match the Tasks list filter set. Priority + Due-date filters
  // join the existing Project / Service / Deliverable filters so users
  // working off the Kanban have the same cuts the tasks page provides.
  // We deliberately skip an Assignee filter since /my-tasks is already
  // scoped to the caller.
  const [filterPriority, setFilterPriority] = useState<string>('');
  const [filterDueFrom, setFilterDueFrom] = useState<string>('');
  const [filterDueTo, setFilterDueTo] = useState<string>('');
  // Tier D #1 (personal-tasks) + #6a+b filters — personal task cut and
  // has-due-date cut. Both default to 'any' so the initial view is
  // unfiltered.
  const [filterKind, setFilterKind] = useState<'' | 'personal' | 'project'>('');
  const [filterHasDue, setFilterHasDue] = useState<'' | 'yes' | 'no'>('');
  // "Upcoming/future tasks" toggle (client feedback 2026-08-02 item
  // 5). By default the Kanban hides tasks whose estStart is more
  // than a week away (server sends `isReady=false` for those). Users
  // can opt back in to see the full pipeline.
  const [showFutureTasks, setShowFutureTasks] = useState(false);

  const { data: tasksData, isLoading } = useQuery({
    queryKey: queryKeys.tasks.mine(),
    queryFn: () => tasksApi.mine().then((r: any) => {
      const d = r?.data ?? r;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
  });

  const allTasks: any[] = Array.isArray(tasksData) ? tasksData : [];

  // Fetch service (Phase DB model) lookups for filter dropdown
  const { data: servicesData } = useQuery({
    queryKey: queryKeys.phases.all,
    queryFn: () => client.get('/phases').then((r) => r.data?.data ?? r.data),
    staleTime: 10 * 60 * 1000,
  });
  const services: any[] = Array.isArray(servicesData) ? servicesData : [];

  // Derive unique project options from tasks
  const projectOptions = useMemo(() => {
    const map = new Map<number, { id: number; name: string }>();
    for (const t of allTasks) {
      if (t.project?.id && !map.has(t.project.id)) map.set(t.project.id, { id: t.project.id, name: t.project.name });
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [allTasks]);

  // Derive unique phase (template) names used across tasks
  const phaseOptions = useMemo(() => {
    const names = new Set<string>();
    for (const t of allTasks) {
      // Phase-name resolution matches execution-board getTaskPhaseName:
      // serviceType -> [SERVICE:...] marker -> task.phase.name. Without the
      // phase.name fallback, root tasks (which usually have only a phase
      // set, no serviceType) wouldn't expose their phase in this filter.
      const name = t.serviceType?.name || t.description?.match(/^\[SERVICE:(.+)\]$/)?.[1] || t.phase?.name;
      if (name) names.add(name);
    }
    return Array.from(names).sort();
  }, [allTasks]);

  // Apply filters. Kanban view enforces "must have due date" as a
  // hard rule (client feedback 2026-08-02 item 7 — kanban should
  // only show tasks that have a DUE DATE; other task-display
  // surfaces follow the same rule except the Planning grid which
  // stays exhaustive so PMs can still see uncommitted work).
  const tasks = useMemo(() => {
    return allTasks.filter((t) => {
      if (filterProjectId && t.project?.id !== filterProjectId) return false;
      if (filterServiceId && t.phaseId !== filterServiceId) return false;
      if (filterPhaseName) {
        const n = t.serviceType?.name || t.description?.match(/^\[SERVICE:(.+)\]$/)?.[1] || t.phase?.name;
        if (n !== filterPhaseName) return false;
      }
      if (filterPriority && t.priority !== filterPriority) return false;
      if (filterDueFrom || filterDueTo) {
        if (!t.endDate) return false;
        const d = String(t.endDate).slice(0, 10);
        if (filterDueFrom && d < filterDueFrom) return false;
        if (filterDueTo && d > filterDueTo) return false;
      }
      // Personal-task cut (Tier D #1).
      if (filterKind === 'personal' && !t.isPersonal) return false;
      if (filterKind === 'project' && t.isPersonal) return false;
      // Has-due-date cut (Tier D #6b) — user-controlled tri-state.
      if (filterHasDue === 'yes' && !t.endDate) return false;
      if (filterHasDue === 'no' && t.endDate) return false;
      // Kanban view: MANDATORY due-date guard on top of the filter —
      // a task without a due date has nowhere real to sit on a
      // deadline-ordered board (2026-08-02 item 7).
      if (activeTab === 'kanban' && !t.endDate) return false;
      // Kanban view: default-hide future-start tasks unless the user
      // opts in (2026-08-02 item 5). `isReady` is server-computed
      // from estimatedStartDate + a 7-day lead window.
      if (activeTab === 'kanban' && !showFutureTasks && t.isReady === false) return false;
      return true;
    });
  }, [allTasks, filterProjectId, filterServiceId, filterPhaseName, filterPriority, filterDueFrom, filterDueTo, filterKind, filterHasDue, activeTab, showFutureTasks]);

  const hasActiveFilter = !!(filterProjectId || filterServiceId || filterPhaseName || filterPriority || filterDueFrom || filterDueTo || filterKind || filterHasDue);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const columnTasks = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const col of columns) map[col.id] = [];
    // Cutoff for the "Done" column — only show tasks marked completed
    // (proxy: updatedAt) within the last 7 days so the column doesn't
    // become an ever-growing archive. Older completions are still in
    // the DB and reachable via reports; the kanban is for current work.
    const oneWeekAgo = Date.now() - 7 * 86_400_000;
    for (const task of tasks) {
      const status = task.status || 'not_started';
      if (status === 'completed') {
        const upd = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
        if (upd < oneWeekAgo) continue; // hide stale completions
      }
      if (map[status]) map[status].push(task);
      else map.not_started.push(task);
    }
    map.not_started.sort((a, b) => getTaskScore(b) - getTaskScore(a));
    map.in_progress.sort((a, b) => {
      if (!a.endDate && !b.endDate) return 0;
      if (!a.endDate) return 1;
      if (!b.endDate) return -1;
      return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
    });
    // Newest completions first in the Done column so the freshest
    // finishes float to the top.
    map.completed.sort((a, b) => {
      const au = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bu = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bu - au;
    });
    return map;
  }, [tasks]);

  const moveTask = async (taskId: number, targetStatus: string) => {
    // Optimistic update
    queryClient.setQueryData(['tasks', 'mine'], (old: any) => {
      if (!Array.isArray(old)) return old;
      return old.map((t: any) => t.id === taskId ? { ...t, status: targetStatus } : t);
    });
    try {
      await tasksApi.update(taskId, { status: targetStatus });
      // Sync project planning views
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.planning.all });
    } catch (err: any) {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.mine() });
      notify.apiError(err, 'Failed to update status');
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;

    const taskId = Number(String(active.id).replace('task-', ''));
    const targetColumnId = String(over.id);
    const targetCol = columns.find((c) => c.id === targetColumnId);
    if (!targetCol) return;

    const task = tasks.find((t: any) => t.id === taskId);
    if (!task || task.status === targetCol.id) return;

    // Drag to any column (including Done) moves the task immediately.
    // Logging time is decoupled — users can log it separately on the task
    // card or detail view if/when they want to. We deliberately don't
    // force a hours-log modal on drop here.
    await moveTask(taskId, targetCol.id);
  };

  const draggedTask = activeDragId ? tasks.find((t: any) => `task-${t.id}` === activeDragId) : null;

  return (
    <div className="space-y-6">
      {/* Personal-task modal — created lazily so the form only mounts on click. */}
      {showPersonalTaskDialog && (
        <PersonalTaskDialog
          onClose={() => setShowPersonalTaskDialog(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: queryKeys.tasks.mine() });
            setShowPersonalTaskDialog(false);
          }}
        />
      )}
      <div className="flex items-center justify-between gap-3">
        <PageHeader title="My Tasks" description={activeTab === 'time' ? 'List of your tasks with quick time reporting' : 'Drag to change status, click card to view details'} />
        <button
          type="button"
          onClick={() => setShowPersonalTaskDialog(true)}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 shrink-0"
          title="Create a personal task for yourself (no project needed)"
        >
          <Plus className="h-3.5 w-3.5" />
          New personal task
        </button>
        <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">
          <button onClick={() => setActiveTab('time')}
            className={cn('flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors',
              activeTab === 'time' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
            <ListChecks className="h-3.5 w-3.5" /> List view
          </button>
          <button onClick={() => setActiveTab('kanban')}
            className={cn('flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors',
              activeTab === 'kanban' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
            <Columns3 className="h-3.5 w-3.5" /> Kanban
          </button>
          <button onClick={() => setActiveTab('upcoming')}
            className={cn('flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors',
              activeTab === 'upcoming' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
            <CalendarClock className="h-3.5 w-3.5" /> Upcoming
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={filterProjectId ?? ''}
          onChange={(e) => setFilterProjectId(e.target.value ? +e.target.value : null)}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] hover:border-slate-300 focus:outline-none focus:border-blue-400"
        >
          <option value="">All Projects</option>
          {projectOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select
          value={filterServiceId ?? ''}
          onChange={(e) => setFilterServiceId(e.target.value ? +e.target.value : null)}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] hover:border-slate-300 focus:outline-none focus:border-blue-400"
        >
          <option value="">All Services</option>
          {services.map((s: any) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select
          value={filterPhaseName ?? ''}
          onChange={(e) => setFilterPhaseName(e.target.value || null)}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] hover:border-slate-300 focus:outline-none focus:border-blue-400"
        >
          <option value="">All Deliverables</option>
          {phaseOptions.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        {/* Priority filter — mirrors the Tasks list page. Short labels
            so the row stays a single line on common viewports. */}
        <select
          value={filterPriority}
          onChange={(e) => setFilterPriority(e.target.value)}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] hover:border-slate-300 focus:outline-none focus:border-blue-400"
        >
          <option value="">Any Priority</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        {/* Personal-task cut (Tier D #1) + has-due-date cut (#6b). */}
        <select
          value={filterKind}
          onChange={(e) => setFilterKind(e.target.value as '' | 'personal' | 'project')}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] hover:border-slate-300 focus:outline-none focus:border-blue-400"
          title="Personal-task filter"
        >
          <option value="">Any kind</option>
          <option value="personal">Personal only</option>
          <option value="project">Project only</option>
        </select>
        <select
          value={filterHasDue}
          onChange={(e) => setFilterHasDue(e.target.value as '' | 'yes' | 'no')}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] hover:border-slate-300 focus:outline-none focus:border-blue-400"
          title="Has due date"
        >
          <option value="">Due date: any</option>
          <option value="yes">Has due date</option>
          <option value="no">Missing due date</option>
        </select>
        {/* Show future-start tasks on the Kanban (client 2026-08-02
            item 5). Off by default — Kanban shows what to work on
            NOW; tasks whose estStart is >7 days out live in the
            underlying pipeline until they get close. */}
        {activeTab === 'kanban' && (
          <label className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] text-slate-600 hover:border-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={showFutureTasks}
              onChange={(e) => setShowFutureTasks(e.target.checked)}
              className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            Include future tasks
          </label>
        )}
        {/* Due-date range — same control set as the Execution board's
            date filter. Either side optional. */}
        <div className="flex items-center gap-1 text-[12px] text-slate-500">
          <span className="text-[11px]">Due:</span>
          <input
            type="date"
            value={filterDueFrom}
            onChange={(e) => setFilterDueFrom(e.target.value)}
            className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12px] hover:border-slate-300 focus:outline-none focus:border-blue-400"
            aria-label="Due date from"
          />
          <span className="text-slate-400">→</span>
          <input
            type="date"
            value={filterDueTo}
            onChange={(e) => setFilterDueTo(e.target.value)}
            className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12px] hover:border-slate-300 focus:outline-none focus:border-blue-400"
            aria-label="Due date to"
          />
        </div>
        {hasActiveFilter && (
          <button
            onClick={() => {
              setFilterProjectId(null);
              setFilterServiceId(null);
              setFilterPhaseName(null);
              setFilterPriority('');
              setFilterDueFrom('');
              setFilterDueTo('');
              setFilterKind('');
              setFilterHasDue('');
            }}
            className="text-[12px] text-slate-500 hover:text-slate-700 underline"
          >
            Clear filters
          </button>
        )}
        <span className="ml-auto text-[11px] text-slate-600 tabular-nums">
          {tasks.length} of {allTasks.length} tasks
        </span>
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-600">Loading your tasks...</div>
      ) : activeTab === 'time' ? (
        <TimeReportingTab tasks={tasks} onOpenDrawer={(id) => setDrawerTaskId(id)} />
      ) : activeTab === 'upcoming' ? (
        <UpcomingTab tasks={tasks} onOpenDrawer={(id) => setDrawerTaskId(id)} />
      ) : tasks.length === 0 ? (
        <div className="py-12 text-center">
          <UserIcon className="mx-auto h-12 w-12 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">
            {hasActiveFilter ? 'No tasks match the active filters' : 'No tasks assigned to you'}
          </p>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCorners}
          onDragStart={(e: DragStartEvent) => setActiveDragId(String(e.active.id))}
          onDragEnd={handleDragEnd}>
          <div className="grid grid-cols-4 gap-3">
            {columns.map((col) => (
              <DroppableColumn key={col.id} column={col} tasks={columnTasks[col.id] ?? []}
                onOpenDrawer={(id) => setDrawerTaskId(id)}
                onStatusChange={(taskId, status) => moveTask(taskId, status)} />
            ))}
          </div>
          <DragOverlay>
            {draggedTask && (
              <div className="rounded-lg border-2 border-blue-400 bg-white p-3 shadow-2xl w-60">
                {draggedTask.project?.name && <span className="text-[10px] font-semibold text-blue-600">{draggedTask.project.name}</span>}
                <p className="text-[13px] font-medium text-slate-800">{draggedTask.name}</p>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {drawerTaskId && (
        <TaskDrawer taskId={drawerTaskId} onClose={closeDrawer} />
      )}

    </div>
  );
}

/**
 * Personal-task creation dialog (Tier D #1, 2026-06-30).
 *
 * Personal tasks belong to the individual employee — not any project,
 * zone, service, or deliverable. This modal is the entry point on the
 * My Tasks page and is intentionally lean: name (required), optional
 * description + due date + est. hours + review flag. The backend's
 * create() path already relaxes the project-required validation when
 * isPersonal=true; we just POST /tasks with that flag.
 */
function PersonalTaskDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [endDate, setEndDate] = useState('');
  const [budgetHours, setBudgetHours] = useState('');
  // Optional project context — cascading pickers. Personal tasks don't
  // REQUIRE a project link; if the user picks one, zones + deliverables
  // filter to that project. (Client feedback 2026-08-02.)
  const [projectId, setProjectId] = useState<number | ''>('');
  const [zoneId, setZoneId] = useState<number | ''>('');
  const [projectDeliverableId, setProjectDeliverableId] = useState<number | ''>('');
  // Personal tasks default to NO review — per client spec.
  const [saving, setSaving] = useState(false);

  // Projects the user can pick from. Same source the Time-log dialog uses.
  const { data: projectsResp } = useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: () => client.get('/projects', { params: { perPage: 200 } }).then((r) => r.data),
  });
  const projects: any[] = Array.isArray(projectsResp?.data) ? projectsResp.data : [];

  // Zones for the currently-picked project (cascading).
  const { data: zonesResp } = useQuery({
    queryKey: ['project-zones', projectId],
    enabled: !!projectId,
    queryFn: () => client.get(`/projects/${projectId}/planning-data`).then((r) => r.data?.data ?? r.data),
  });
  const zones: any[] = Array.isArray(zonesResp?.zones) ? zonesResp.zones : [];

  // Deliverables for the currently-picked project.
  const { data: deliverablesResp } = useQuery({
    queryKey: ['project-deliverables', projectId],
    enabled: !!projectId,
    queryFn: () => client.get('/project-deliverables', { params: { projectId } }).then((r) => r.data?.data ?? r.data),
  });
  const deliverables: any[] = Array.isArray(deliverablesResp) ? deliverablesResp : [];

  // Due date is required for personal tasks (client feedback).
  const canSave = name.trim().length > 0 && !!endDate && !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await tasksApi.create({
        code: `PERSONAL-${Date.now().toString(36).toUpperCase()}`,
        name: name.trim(),
        description: description.trim() || undefined,
        endDate,
        budgetHours: budgetHours ? Number(budgetHours) : undefined,
        projectId: projectId || undefined,
        zoneId: zoneId || undefined,
        projectDeliverableId: projectDeliverableId || undefined,
        isPersonal: true,
        // Personal tasks skip the review step by default.
        requiresReview: false,
      } as any);
      notify.success('Personal task created', { code: 'TASK-CREATE-200' });
      onCreated();
    } catch (err: any) {
      notify.apiError(err, 'Failed to create personal task');
      setSaving(false);
    }
  };

  // Clear cascading pickers when project changes.
  const handleProjectChange = (v: string) => {
    setProjectId(v ? Number(v) : '');
    setZoneId('');
    setProjectDeliverableId('');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-[500px] max-w-[92vw] max-h-[85vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div>
            <h2 className="text-base font-bold text-slate-900">New personal task</h2>
            <p className="text-[12px] text-slate-500 mt-0.5">Just for you. Project / zone / deliverable are optional; Due date is required.</p>
          </div>
          <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); submit(); }}
          className="p-5 space-y-4"
        >
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">
              Task name <span className="text-red-500">*</span>
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Review latest drawings"
              className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Optional details…"
              className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none resize-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">
                Due date <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Est. hours</label>
              <input
                type="number"
                min="0"
                step="0.25"
                value={budgetHours}
                onChange={(e) => setBudgetHours(e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
          {/* Optional project context — cascading. Zone + Deliverable
              pickers are disabled until a project is chosen. */}
          <div className="border-t border-slate-100 pt-4 space-y-3">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Optional project context
            </div>
            <div>
              <label className="text-[12px] text-slate-600 mb-1 block">Project</label>
              <select
                value={projectId}
                onChange={(e) => handleProjectChange(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
              >
                <option value="">— None —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.number ? ` (${p.number})` : ''}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[12px] text-slate-600 mb-1 block">Zone</label>
                <select
                  value={zoneId}
                  disabled={!projectId}
                  onChange={(e) => setZoneId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <option value="">— None —</option>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>{z.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[12px] text-slate-600 mb-1 block">Deliverable</label>
                <select
                  value={projectDeliverableId}
                  disabled={!projectId}
                  onChange={(e) => setProjectDeliverableId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <option value="">— None —</option>
                  {deliverables.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-[13px] font-semibold px-4 py-2 rounded-lg"
            >
              {saving ? 'Creating…' : 'Create task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
