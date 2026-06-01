import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, User as UserIcon, GripVertical, CalendarClock, ListChecks, Columns3, Play, Check, AlertCircle, AlertTriangle, Calendar } from 'lucide-react';
import { DndContext, DragOverlay, closestCorners, PointerSensor, KeyboardSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent, useDraggable, useDroppable } from '@dnd-kit/core';
import { PageHeader } from '@/components/shared/page-header';
import { TaskDrawer } from './task-drawer';
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

type TabMode = 'time' | 'kanban';

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

  const borderCls =
    health.level === 'critical'
      ? 'border-red-300 bg-red-50 ring-1 ring-red-200'
      : health.level === 'warning'
        ? 'border-amber-300 bg-amber-50/50'
        : 'border-slate-200 bg-white';

  return (
    // Hover effect: fast shadow lift on hover. The native browser
    // `title` tooltip used to be on the card root for the at-risk
    // reasons, which gave a ~500ms delay before any feedback —
    // exactly the "hover delay" the user flagged. We dropped it
    // because the same information is already rendered inline below
    // (the reasons banner near the bottom of the card), so the tooltip
    // was redundant. Transitions are explicitly bound to shadow only,
    // so layout-affecting properties don't animate.
    <div ref={setNodeRef} style={style} {...attributes}
      className={cn(
        'rounded-lg border shadow-sm hover:shadow-md transition-shadow duration-100 border-l-[3px]',
        borderCls,
        ZONE_BORDER_COLORS[zoneType] || 'border-l-slate-300',
        isDragging && 'opacity-40 shadow-lg ring-2 ring-blue-300 z-50',
      )}
    >
      {/* Drag handle + project — bumped project name to a more legible size
          per spec ("project name font should be larger"). */}
      <div {...listeners} className="flex items-center gap-1.5 px-3 pt-2 cursor-grab active:cursor-grabbing">
        <GripVertical className="h-3.5 w-3.5 text-slate-300" />
        {projectName && (
          <span className="text-[13px] font-bold text-blue-700 truncate max-w-[180px]">{projectName}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {health.level === 'critical' && <AlertCircle className="h-3.5 w-3.5 text-red-600" />}
          {health.level === 'warning' && <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
        </div>
      </div>

      {/* Clickable area → open drawer */}
      <div className="px-3 pb-3 pt-1 cursor-pointer space-y-1.5" onClick={() => onOpenDrawer(task.id)}>
        {task.code && <span className="text-[9px] font-mono text-slate-500">{task.code}</span>}
        <p className="text-[13px] font-semibold text-slate-800 leading-tight break-words">{task.name}</p>

        {/* Zone breadcrumb — walks the zone tree. Falls back to just the
            leaf zone name when the breadcrumb hasn't been computed yet
            (older API responses or transitional state). For root tasks
            (no zone) we surface "Project Root" + phase so the card isn't
            silently context-less. */}
        {Array.isArray((task as any).zoneBreadcrumb) && (task as any).zoneBreadcrumb.length > 0 ? (
          <p className="text-[10px] text-slate-500 truncate" title={(task as any).zoneBreadcrumb.join(' > ')}>
            {(task as any).zoneBreadcrumb.join(' › ')}
          </p>
        ) : zoneName ? (
          <p className="text-[10px] text-slate-500 truncate">{zoneName}</p>
        ) : (
          <p className="text-[10px] text-slate-400 italic truncate">
            Project Root
            {task.phase?.name ? ` · ${task.phase.name}` : task.serviceType?.name ? ` · ${task.serviceType.name}` : ''}
          </p>
        )}

        {/* Service + Deliverable chips — same data the Tasks list page
            surfaces, so the Kanban card now carries equal context. The
            user asked for "all relevant data on the card including
            breadcrumbs"; phase (Service) and serviceType (Deliverable)
            were missing. Render in muted slate so they don't compete
            with the status pill. */}
        {(task.phase?.name || task.serviceType?.name) && (
          <div className="flex items-center gap-1 flex-wrap text-[10px]">
            {task.phase?.name && (
              <span className="rounded bg-violet-50 px-1.5 py-0.5 text-violet-700 font-medium">
                {task.phase.name}
              </span>
            )}
            {task.serviceType?.name && (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
                {task.serviceType.name}
              </span>
            )}
          </div>
        )}

        {/* Kanban stage pill — progress bar removed per spec ("the progress
            bar on the card is unnecessary"). */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider', STATUS_PILL[task.status] ?? STATUS_PILL.not_started)}>
            {STATUS_LABEL[task.status] ?? task.status}
          </span>
          {task.priority === 'critical' && <span className="rounded bg-red-100 px-1 py-0.5 text-[10px] font-bold text-red-600">Critical</span>}
          {task.priority === 'high' && <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-bold text-amber-600">High</span>}
        </div>

        {/* Hours — YOUR own logged time on this task. The findMine endpoint
            scopes time-entries by userId so this card shows what *you*
            reported, not the team's combined hours.

            Visibility upgrade: rendered as a colored pill so the
            "X.XXh / Yh" reading pops on the card. Color tracks budget
            usage so over-budget tasks scream red without needing the
            "Over budget" risk reason. */}
        {(() => {
          const logged = health.loggedHours;
          const est = health.estimatedHours;
          const pct = est > 0 ? (logged / est) * 100 : 0;
          // Bucket the color: green under 80%, amber 80–100%, red over.
          // Always uses the loggedHours value direct from health, which
          // recomputes from the freshly-invalidated tasks.mine query.
          const tone = est <= 0
            ? 'bg-slate-100 text-slate-600 border-slate-200'
            : pct >= 100
              ? 'bg-red-100 text-red-700 border-red-200'
              : pct >= 80
                ? 'bg-amber-100 text-amber-700 border-amber-200'
                : 'bg-emerald-100 text-emerald-700 border-emerald-200';
          return (
            <div className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-bold tabular-nums',
              tone,
            )}>
              <Clock className="h-3 w-3 shrink-0" />
              <span>{logged}h</span>
              {est > 0 && (
                <>
                  <span className="opacity-60">/</span>
                  <span>{est}h</span>
                  <span className="opacity-70 font-semibold">· {Math.round(pct)}%</span>
                </>
              )}
            </div>
          );
        })()}

        {/* Due date */}
        {task.endDate && (
          <div className="flex items-center gap-1 text-[10px]">
            <Calendar className={cn('h-2.5 w-2.5 shrink-0', health.isOverdue ? 'text-red-600' : 'text-slate-400')} />
            <span className={cn(
              'tabular-nums',
              health.isOverdue ? 'text-red-600 font-bold' : 'text-slate-500 font-medium',
            )}>
              Due {formatShortDate(task.endDate)}
              {health.isOverdue && ' (overdue)'}
            </span>
          </div>
        )}

        {/* Risk reasons (visible) */}
        {health.reasons.length > 0 && (
          <div className={cn(
            'rounded px-1.5 py-1 text-[10px]',
            health.level === 'critical' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700',
          )}>
            {health.reasons[0]}
          </div>
        )}

        {/* Assignee avatars — stack of up to 4 with overflow count. The
            Kanban already scopes to /tasks/mine so the caller sees their
            own tasks, but tasks can be assigned to multiple people and
            seeing teammates inline avoids a click into the drawer just
            to learn "who else is on this". */}
        {Array.isArray((task as any).assignees) && (task as any).assignees.length > 0 && (
          <div className="flex items-center gap-0.5">
            {((task as any).assignees as any[]).slice(0, 4).map((a) => {
              const initials = `${a.user?.firstName?.[0] ?? ''}${a.user?.lastName?.[0] ?? ''}` || '?';
              return (
                <span
                  key={a.id}
                  className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-[8px] font-bold border border-white -ml-1 first:ml-0"
                  title={`${a.user?.firstName ?? ''} ${a.user?.lastName ?? ''}`.trim()}
                >
                  {initials}
                </span>
              );
            })}
            {(task as any).assignees.length > 4 && (
              <span className="text-[9px] text-slate-500 ml-1">+{(task as any).assignees.length - 4}</span>
            )}
          </div>
        )}

        {/* Keyboard-accessible status change (WCAG 2.5.7 Dragging Movements alternative) */}
        <div className="pt-1 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <KanbanStatusSelect status={task.status} onStatusChange={(s) => onStatusChange(task.id, s)} />
          <QuickTimeLog taskId={task.id} taskProjectId={task.projectId} />
        </div>
      </div>
    </div>
  );
}

function KanbanStatusSelect({ status, onStatusChange }: { status: string; onStatusChange: (s: string) => void }) {
  const { allowedStatuses } = useAllowedTransitions(status);
  return (
    <select
      aria-label="Change task status"
      value={status}
      onChange={(e) => onStatusChange(e.target.value)}
      className="flex-1 rounded border border-slate-200 bg-white px-1.5 py-1 text-[10px] focus:border-blue-400 focus:outline-none"
    >
      {columns.filter((c) => allowedStatuses.includes(c.id)).map((c) => (
        <option key={c.id} value={c.id}>{c.label}</option>
      ))}
    </select>
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

  // Route through STATUS_LABEL so this badge uses the same wording as every
  // other status pill in the app ("Done" / "In Review" / "In Progress" /
  // "To Do" / "On Hold" / "Cancelled"). Previously had local "Review" /
  // "Active" overrides that drifted from the rest of the UI.
  const statusLabel = STATUS_LABEL[task.status] ?? task.status;
  const statusColor = task.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : task.status === 'in_progress' ? 'bg-blue-100 text-blue-700' : task.status === 'in_review' ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-600';

  return (
    <div className="border-b border-slate-100 last:border-b-0">
      {overlap.dialog}
      <div className="flex items-center gap-2 px-4 py-2.5 hover:bg-blue-50/30 transition-colors">
        {/* Task info — clickable to open the task sidebar. The form
            controls below have their own click/change handlers, so clicks
            inside those don't bubble up to the drawer-open handler. */}
        <button
          type="button"
          onClick={() => onOpenDrawer(task.id)}
          className="flex-1 min-w-0 text-left cursor-pointer rounded hover:bg-slate-50 -mx-1 px-1 py-0.5"
          title="Open task details"
        >
          <div className="flex items-center gap-2">
            {projectName && <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 rounded px-1.5 py-0.5 shrink-0">{projectName}</span>}
            <span className={cn('text-[10px] font-semibold rounded px-1.5 py-0.5 shrink-0', statusColor)}>{statusLabel}</span>
          </div>
          <p className="text-[13px] font-medium text-slate-800 truncate mt-0.5">{task.name}</p>
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

        {/* Due date column */}
        <div className="w-[80px] text-center shrink-0">
          {dueLabel ? (
            <span className={cn(
              'inline-flex items-center gap-1 text-[11px] font-medium tabular-nums',
              isOverdue ? 'text-red-600 font-bold' : 'text-slate-600',
            )}>
              <Calendar className="h-3 w-3" />
              {dueLabel}
            </span>
          ) : (
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

function TimeReportingTab({ tasks, onOpenDrawer }: { tasks: any[]; onOpenDrawer: (id: number) => void }) {
  const activeTasks = tasks.filter((t) => t.status !== 'completed');
  const completedTasks = tasks.filter((t) => t.status === 'completed');

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

      {/* Active tasks */}
      {activeTasks.length > 0 && (
        <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
          <div className="bg-slate-50 px-4 py-2.5 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-[13px] font-semibold text-slate-700">Active Tasks</h3>
              <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-600">{activeTasks.length}</span>
            </div>
            {/* Header labels — matched to the Add Timesheet Entry
                modal's labels ("Start Time" + "End Time" + "Total Hours"). */}
            <div className="flex items-center gap-2 text-[10px] font-semibold text-slate-400 uppercase tracking-wider pr-1">
              <span className="w-[80px] text-center">Due</span>
              <span className="w-[130px] text-center">Date</span>
              <span className="w-[80px] text-center">Start Time</span>
              <span className="w-[80px] text-center">End Time</span>
              <span className="w-[58px] text-center">Total Hours</span>
              <span className="w-[72px]" />
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
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [drawerTaskId, setDrawerTaskId] = useState<number | null>(null);

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

  // Apply filters
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
      return true;
    });
  }, [allTasks, filterProjectId, filterServiceId, filterPhaseName, filterPriority, filterDueFrom, filterDueTo]);

  const hasActiveFilter = !!(filterProjectId || filterServiceId || filterPhaseName || filterPriority || filterDueFrom || filterDueTo);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const columnTasks = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const col of columns) map[col.id] = [];
    for (const task of tasks) {
      const status = task.status || 'not_started';
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
      <div className="flex items-center justify-between">
        <PageHeader title="My Tasks" description={activeTab === 'time' ? 'List of your tasks with quick time reporting' : 'Drag to change status, click card to view details'} />
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
        <TaskDrawer taskId={drawerTaskId} onClose={() => setDrawerTaskId(null)} />
      )}

    </div>
  );
}
