import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, User as UserIcon, GripVertical, CalendarClock, ListChecks, Columns3, Play, Check, AlertCircle, AlertTriangle, Calendar } from 'lucide-react';
import { DndContext, DragOverlay, closestCorners, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent, useDraggable, useDroppable } from '@dnd-kit/core';
import { PageHeader } from '@/components/shared/page-header';
import { TaskDrawer } from './task-drawer';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { tasksApi } from '@/api/tasks.api';
import { timeApi } from '@/api/time.api';
import client from '@/api/client';
import { getTaskHealth } from '@/lib/task-health';

type TabMode = 'time' | 'kanban';

const columns = [
  { id: 'not_started', label: 'To Do', color: 'border-t-slate-400', bg: 'bg-slate-50/50' },
  { id: 'in_progress', label: 'In Progress', color: 'border-t-blue-500', bg: 'bg-blue-50/30' },
  { id: 'in_review', label: 'In Review', color: 'border-t-violet-500', bg: 'bg-violet-50/30' },
  { id: 'completed', label: 'Done', color: 'border-t-emerald-500', bg: 'bg-emerald-50/30' },
];

const zoneBorderColors: Record<string, string> = {
  site: 'border-l-indigo-400', building: 'border-l-amber-500', level: 'border-l-teal-400',
  zone: 'border-l-amber-400', area: 'border-l-purple-400', floor: 'border-l-blue-400',
  section: 'border-l-teal-400', wing: 'border-l-pink-400',
};

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
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

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

  const logTime = useMutation({
    mutationFn: () => timeApi.createEntry({
      taskId,
      projectId: taskProjectId ?? undefined,
      date,
      startTime: start,
      endTime: end,
      minutes: totalMinutes,
      note: note.trim() || undefined,
      isBillable: true,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['time'] });
      queryClient.invalidateQueries({ queryKey: ['tasks', 'mine'] });
      notify.success(`Logged ${totalHours}h`, { code: 'TIME-LOG-200' });
      setOpen(false);
      setNote('');
    },
    onError: (err: any) => notify.apiError(err, 'Failed'),
  });

  if (!open) {
    return (
      <button onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-600 hover:bg-blue-100">
        <Clock className="h-3 w-3" /> Log Time
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-blue-200 bg-blue-50/50 p-2 space-y-1.5" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1">
        <label className="text-[9px] font-semibold text-slate-500 uppercase w-10">Date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="flex-1 px-1.5 py-1 rounded border border-slate-200 text-[11px] focus:border-blue-400 focus:outline-none" />
      </div>
      <div className="flex items-center gap-1">
        <label className="text-[9px] font-semibold text-slate-500 uppercase w-10">Time</label>
        <input type="time" value={start} onChange={(e) => setStart(e.target.value)} step="300"
          className="w-[78px] px-1.5 py-1 rounded border border-slate-200 text-[11px] focus:border-blue-400 focus:outline-none" />
        <span className="text-[10px] text-slate-400">→</span>
        <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} step="300"
          className="w-[78px] px-1.5 py-1 rounded border border-slate-200 text-[11px] focus:border-blue-400 focus:outline-none" />
        <span className="ml-auto text-[11px] font-bold text-blue-600 tabular-nums">{totalHours}h</span>
      </div>
      <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)…" className="w-full px-1.5 py-1 rounded border border-slate-200 text-[11px] focus:border-blue-400 focus:outline-none" />
      <div className="flex gap-1">
        <button onClick={() => { if (totalMinutes > 0) logTime.mutate(); }}
          disabled={totalMinutes <= 0 || logTime.isPending}
          className="rounded bg-blue-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
          {logTime.isPending ? 'Saving...' : 'Save'}
        </button>
        <button onClick={() => setOpen(false)} className="text-[10px] text-slate-400 px-1">Cancel</button>
      </div>
    </div>
  );
}

const STATUS_PILL: Record<string, string> = {
  not_started: 'bg-slate-100 text-slate-600',
  in_progress: 'bg-blue-100 text-blue-700',
  in_review: 'bg-violet-100 text-violet-700',
  completed: 'bg-emerald-100 text-emerald-700',
  on_hold: 'bg-amber-100 text-amber-700',
  cancelled: 'bg-red-100 text-red-700',
};

const STATUS_LABEL_MAP: Record<string, string> = {
  not_started: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  completed: 'Done',
  on_hold: 'On Hold',
  cancelled: 'Cancelled',
};

function formatShortDate(iso: string): string {
  const d = new Date(iso.split('T')[0]);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function DraggableTaskCard({ task, onOpenDrawer }: { task: any; onOpenDrawer: (id: number) => void }) {
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

  const pctColor =
    health.computedPct >= 100 ? 'bg-emerald-500' :
    health.computedPct >= 60 ? 'bg-blue-500' :
    health.computedPct >= 30 ? 'bg-amber-500' : 'bg-slate-300';

  return (
    <div ref={setNodeRef} style={style} {...attributes}
      className={cn(
        'rounded-lg border shadow-sm hover:shadow-md transition-all border-l-[3px]',
        borderCls,
        zoneBorderColors[zoneType] || 'border-l-slate-300',
        isDragging && 'opacity-40 shadow-lg ring-2 ring-blue-300 z-50',
      )}
      title={health.reasons.length > 0 ? health.reasons.join(' • ') : undefined}
    >
      {/* Drag handle + project */}
      <div {...listeners} className="flex items-center gap-1.5 px-3 pt-2 cursor-grab active:cursor-grabbing">
        <GripVertical className="h-3 w-3 text-slate-300" />
        {projectName && (
          <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 rounded px-1.5 py-0.5 truncate max-w-[140px]">{projectName}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {health.level === 'critical' && <AlertCircle className="h-3.5 w-3.5 text-red-600" />}
          {health.level === 'warning' && <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
        </div>
      </div>

      {/* Clickable area → open drawer */}
      <div className="px-3 pb-3 pt-1 cursor-pointer space-y-1.5" onClick={() => onOpenDrawer(task.id)}>
        {task.code && <span className="text-[9px] font-mono text-slate-400">{task.code}</span>}
        <p className="text-[13px] font-semibold text-slate-800 leading-tight break-words">{task.name}</p>
        {zoneName && <p className="text-[10px] text-slate-400 truncate">{zoneName}</p>}

        {/* Kanban stage pill */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider', STATUS_PILL[task.status] ?? STATUS_PILL.not_started)}>
            {STATUS_LABEL_MAP[task.status] ?? task.status}
          </span>
          {task.priority === 'critical' && <span className="rounded bg-red-100 px-1 py-0.5 text-[10px] font-bold text-red-600">Critical</span>}
          {task.priority === 'high' && <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-bold text-amber-600">High</span>}
        </div>

        {/* Completion bar */}
        <div className="flex items-center gap-1.5">
          <div className="flex-1 h-[4px] bg-slate-200 rounded-full overflow-hidden">
            <div className={cn('h-full rounded-full', pctColor)} style={{ width: `${Math.min(health.computedPct, 100)}%` }} />
          </div>
          <span className="text-[10px] font-bold tabular-nums text-slate-700 min-w-[28px] text-right">{health.computedPct}%</span>
        </div>

        {/* Hours */}
        <div className="flex items-center gap-1 text-[10px] text-slate-600">
          <Clock className="h-2.5 w-2.5 shrink-0" />
          <span className="tabular-nums font-medium">
            {health.loggedHours}h {health.estimatedHours > 0 ? `/ ${health.estimatedHours}h est.` : 'logged'}
          </span>
        </div>

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

        <div className="pt-1">
          <QuickTimeLog taskId={task.id} taskProjectId={task.projectId} />
        </div>
      </div>
    </div>
  );
}

function DroppableColumn({ column, tasks, onOpenDrawer }: { column: typeof columns[0]; tasks: any[]; onOpenDrawer: (id: number) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <div ref={setNodeRef}
      className={cn('flex flex-col rounded-[14px] border-t-[3px] min-h-[400px] transition-all', column.color,
        isOver ? 'bg-blue-50/60 border-blue-300 border-2 shadow-inner' : `border border-slate-200 ${column.bg}`)}>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-slate-700">{column.label}</h3>
          <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">{tasks.length}</span>
        </div>
      </div>
      <div className="flex-1 space-y-2 px-3 pb-3">
        {tasks.map((task: any) => (
          <DraggableTaskCard key={task.id} task={task} onOpenDrawer={onOpenDrawer} />
        ))}
        {tasks.length === 0 && (
          <div className={cn('py-8 text-center text-[11px] rounded-lg border-2 border-dashed', isOver ? 'border-blue-400 text-blue-500' : 'border-slate-200 text-slate-400')}>
            {isOver ? 'Drop here' : 'No tasks'}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Time Reporting Tab ────────────────────────────────────────────────────

function TimeReportingRow({ task }: { task: any }) {
  const queryClient = useQueryClient();
  const today = new Date().toISOString().split('T')[0];
  const [date, setDate] = useState(today);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('10:00');
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);

  const projectName = task.project?.name || task.label?.projectName || '';
  const zoneName = task.zone?.name || task.label?.name || '';

  const startMins = (() => { const [h, m] = start.split(':').map(Number); return h * 60 + m; })();
  const endMins = (() => { const [h, m] = end.split(':').map(Number); return h * 60 + m; })();
  const totalMinutes = Math.max(0, endMins - startMins);
  const totalHours = (totalMinutes / 60).toFixed(2);

  const handleLog = async () => {
    if (totalMinutes <= 0) { notify.warning('End time must be after start time'); return; }
    setSaving(true);
    try {
      await timeApi.createEntry({
        taskId: task.id,
        projectId: task.projectId || undefined,
        date,
        startTime: start,
        endTime: end,
        minutes: totalMinutes,
        note: note.trim() || undefined,
        isBillable: true,
      });
      queryClient.invalidateQueries({ queryKey: ['time'] });
      notify.success(`Logged ${totalHours}h for ${task.name}`);
      setNote('');
    } catch (err: any) {
      notify.apiError(err, 'Failed to log time');
    } finally {
      setSaving(false);
    }
  };

  const TIME_OPTIONS = useMemo(() => {
    const opts: string[] = [];
    for (let h = 6; h <= 22; h++) {
      for (const m of [0, 15, 30, 45]) {
        opts.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
      }
    }
    return opts;
  }, []);

  const statusLabel = task.status === 'completed' ? 'Done' : task.status === 'in_review' ? 'Review' : task.status === 'in_progress' ? 'Active' : 'To Do';
  const statusColor = task.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : task.status === 'in_progress' ? 'bg-blue-100 text-blue-700' : task.status === 'in_review' ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-600';

  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <div className="flex items-center gap-2 px-4 py-2.5 hover:bg-blue-50/30 transition-colors">
        {/* Task info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {projectName && <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 rounded px-1.5 py-0.5 shrink-0">{projectName}</span>}
            <span className={cn('text-[10px] font-semibold rounded px-1.5 py-0.5 shrink-0', statusColor)}>{statusLabel}</span>
          </div>
          <p className="text-[13px] font-medium text-slate-800 truncate mt-0.5">{task.name}</p>
          {zoneName && <p className="text-[10px] text-slate-400 truncate">{zoneName}</p>}
        </div>

        {/* Date */}
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="w-[130px] rounded-md border border-slate-200 px-2 py-1.5 text-[12px] focus:border-blue-400 focus:outline-none shrink-0" />

        {/* Start time */}
        <select value={start} onChange={(e) => setStart(e.target.value)}
          className="w-[80px] rounded-md border border-slate-200 px-1.5 py-1.5 text-[12px] focus:border-blue-400 focus:outline-none shrink-0">
          {TIME_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        <span className="text-[11px] text-slate-300 shrink-0">→</span>

        {/* End time */}
        <select value={end} onChange={(e) => setEnd(e.target.value)}
          className="w-[80px] rounded-md border border-slate-200 px-1.5 py-1.5 text-[12px] focus:border-blue-400 focus:outline-none shrink-0">
          {TIME_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        {/* Total */}
        <div className="w-[52px] text-center shrink-0">
          <span className={cn('text-[13px] font-bold', totalMinutes > 0 ? 'text-slate-700' : 'text-slate-300')}>{totalHours}h</span>
        </div>

        {/* Note toggle */}
        <button onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-slate-400 hover:text-slate-600 shrink-0 w-12 text-center">
          {expanded ? 'Hide' : '+ Note'}
        </button>

        {/* Log button */}
        <button onClick={handleLog} disabled={saving || totalMinutes <= 0}
          className="flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50 shrink-0">
          {saving ? <Clock className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          Log
        </button>
      </div>

      {/* Note row */}
      {expanded && (
        <div className="px-4 pb-2.5 pl-8">
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="What did you work on? (optional)"
            className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[12px] focus:border-blue-400 focus:outline-none" />
        </div>
      )}
    </div>
  );
}

function TimeReportingTab({ tasks }: { tasks: any[] }) {
  const activeTasks = tasks.filter((t) => t.status !== 'completed');
  const completedTasks = tasks.filter((t) => t.status === 'completed');

  // Fetch recent time entries for today
  const today = new Date().toISOString().split('T')[0];
  const { data: recentEntriesData } = useQuery({
    queryKey: ['time', 'entries', { date: today }],
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
            <div className="flex items-center gap-6 text-[10px] font-semibold text-slate-400 uppercase tracking-wider pr-1">
              <span className="w-[130px] text-center">Date</span>
              <span className="w-[170px] text-center">Start → End</span>
              <span className="w-[52px] text-center">Hours</span>
              <span className="w-[72px]" />
            </div>
          </div>
          {activeTasks.map((task: any) => <TimeReportingRow key={task.id} task={task} />)}
        </div>
      )}

      {/* Completed tasks (collapsed) */}
      {completedTasks.length > 0 && (
        <details className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
          <summary className="bg-slate-50 px-4 py-2.5 border-b border-slate-200 cursor-pointer">
            <span className="text-[13px] font-semibold text-slate-500">Completed Tasks</span>
            <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">{completedTasks.length}</span>
          </summary>
          {completedTasks.map((task: any) => <TimeReportingRow key={task.id} task={task} />)}
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
                {e.note && <span className="text-slate-400 truncate max-w-[200px]">{e.note}</span>}
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
  const [timeLogTask, setTimeLogTask] = useState<{ id: number; name: string; targetStatus: string } | null>(null);
  const [timeLogHours, setTimeLogHours] = useState('');
  const [timeLogNote, setTimeLogNote] = useState('');

  // Filters
  const [filterProjectId, setFilterProjectId] = useState<number | null>(null);
  const [filterServiceId, setFilterServiceId] = useState<number | null>(null);
  const [filterPhaseName, setFilterPhaseName] = useState<string | null>(null);

  const { data: tasksData, isLoading } = useQuery({
    queryKey: ['tasks', 'mine'],
    queryFn: () => tasksApi.mine().then((r: any) => {
      const d = r?.data ?? r;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
  });

  const allTasks: any[] = Array.isArray(tasksData) ? tasksData : [];

  // Fetch service (Phase DB model) lookups for filter dropdown
  const { data: servicesData } = useQuery({
    queryKey: ['phases'],
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
      const name = t.serviceType?.name || t.description?.match(/^\[SERVICE:(.+)\]$/)?.[1];
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
        const n = t.serviceType?.name || t.description?.match(/^\[SERVICE:(.+)\]$/)?.[1];
        if (n !== filterPhaseName) return false;
      }
      return true;
    });
  }, [allTasks, filterProjectId, filterServiceId, filterPhaseName]);

  const hasActiveFilter = filterProjectId || filterServiceId || filterPhaseName;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

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
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['planning'] });
    } catch (err: any) {
      queryClient.invalidateQueries({ queryKey: ['tasks', 'mine'] });
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

    // If moving to "completed", require time log first
    if (targetCol.id === 'completed') {
      setTimeLogTask({ id: taskId, name: task.name, targetStatus: 'completed' });
      return;
    }

    await moveTask(taskId, targetCol.id);
  };

  const handleTimeLogAndComplete = async () => {
    if (!timeLogTask || !timeLogHours || Number(timeLogHours) <= 0) return;
    try {
      // Log time first
      await timeApi.createEntry({
        taskId: timeLogTask.id,
        date: new Date().toISOString().split('T')[0],
        minutes: Math.round(Number(timeLogHours) * 60),
        note: timeLogNote.trim() || undefined,
      });
      // Then move to completed
      await moveTask(timeLogTask.id, timeLogTask.targetStatus);
      queryClient.invalidateQueries({ queryKey: ['time'] });
      setTimeLogTask(null);
      setTimeLogHours('');
      setTimeLogNote('');
    } catch (err: any) {
      notify.apiError(err, 'Failed to complete task');
    }
  };

  const draggedTask = activeDragId ? tasks.find((t: any) => `task-${t.id}` === activeDragId) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader title="My Tasks" description={activeTab === 'time' ? 'Quick time reporting for your tasks' : 'Drag to change status, click card to view details'} />
        <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">
          <button onClick={() => setActiveTab('time')}
            className={cn('flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors',
              activeTab === 'time' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
            <Clock className="h-3.5 w-3.5" /> Time Report
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
        {hasActiveFilter && (
          <button
            onClick={() => { setFilterProjectId(null); setFilterServiceId(null); setFilterPhaseName(null); }}
            className="text-[12px] text-slate-500 hover:text-slate-700 underline"
          >
            Clear filters
          </button>
        )}
        <span className="ml-auto text-[11px] text-slate-400 tabular-nums">
          {tasks.length} of {allTasks.length} tasks
        </span>
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-400">Loading your tasks...</div>
      ) : activeTab === 'time' ? (
        <TimeReportingTab tasks={tasks} />
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
                onOpenDrawer={(id) => setDrawerTaskId(id)} />
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

      {/* Time Log Required for Done — Modal */}
      {timeLogTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-[14px] bg-white shadow-2xl border border-slate-200 p-5">
            <h3 className="text-sm font-bold text-slate-900 mb-1">Log Time to Complete</h3>
            <p className="text-[12px] text-slate-500 mb-4">
              Please log hours worked on "<strong>{timeLogTask.name}</strong>" before marking as Done.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-[11px] font-semibold text-slate-600 mb-1 block">Hours worked *</label>
                <input type="number" step="0.25" min="0.25" value={timeLogHours} onChange={(e) => setTimeLogHours(e.target.value)}
                  placeholder="e.g. 4.5" autoFocus
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
              </div>
              <div>
                <label className="text-[11px] font-semibold text-slate-600 mb-1 block">Note (optional)</label>
                <input type="text" value={timeLogNote} onChange={(e) => setTimeLogNote(e.target.value)}
                  placeholder="What was done..."
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => { setTimeLogTask(null); setTimeLogHours(''); setTimeLogNote(''); }}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-semibold text-slate-700 hover:bg-slate-50">
                  Cancel
                </button>
                <button onClick={handleTimeLogAndComplete}
                  disabled={!timeLogHours || Number(timeLogHours) <= 0}
                  className="rounded-lg bg-emerald-600 px-4 py-1.5 text-[13px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                  Log & Complete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
