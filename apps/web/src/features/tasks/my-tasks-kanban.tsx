import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, User as UserIcon, GripVertical, CalendarClock, ListChecks, Columns3, Play, Check } from 'lucide-react';
import { DndContext, DragOverlay, closestCorners, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent, useDraggable, useDroppable } from '@dnd-kit/core';
import { PageHeader } from '@/components/shared/page-header';
import { TaskDrawer } from './task-drawer';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { tasksApi } from '@/api/tasks.api';
import { timeApi } from '@/api/time.api';

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

function QuickTimeLog({ taskId, taskName }: { taskId: number; taskName: string }) {
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const queryClient = useQueryClient();

  const logTime = useMutation({
    mutationFn: () => timeApi.createEntry({
      taskId, date: new Date().toISOString().split('T')[0],
      minutes: Math.round(Number(hours) * 60), note: note.trim() || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['time'] });
      notify.success(`Logged ${hours}h`, { code: 'TIME-LOG-200' });
      setOpen(false); setHours(''); setNote('');
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
      <div className="flex gap-1.5">
        <input type="number" step="0.25" min="0.25" max="24" value={hours} onChange={(e) => setHours(e.target.value)}
          placeholder="Hours" className="w-16 px-1.5 py-1 rounded border border-slate-200 text-[11px] focus:border-blue-400 focus:outline-none" autoFocus />
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Note..." className="flex-1 px-1.5 py-1 rounded border border-slate-200 text-[11px] focus:border-blue-400 focus:outline-none" />
      </div>
      <div className="flex gap-1">
        <button onClick={() => { if (hours && Number(hours) > 0) logTime.mutate(); }}
          disabled={!hours || Number(hours) <= 0 || logTime.isPending}
          className="rounded bg-blue-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
          {logTime.isPending ? 'Saving...' : 'Save'}
        </button>
        <button onClick={() => setOpen(false)} className="text-[10px] text-slate-400 px-1">Cancel</button>
      </div>
    </div>
  );
}

function DraggableTaskCard({ task, onOpenDrawer }: { task: any; onOpenDrawer: (id: number) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `task-${task.id}` });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  const zoneType = task.zone?.zoneType || 'zone';
  const projectName = task.project?.name || task.label?.projectName || '';
  const zoneName = task.zone?.name || task.label?.name || '';
  const startBy = getStartByDate(task);
  const now = new Date();
  const isOverdue = task.endDate && new Date(task.endDate) < now && task.status !== 'completed';
  const startByDate = startBy ? new Date(task.endDate) : null;
  const startByPassed = startByDate ? (() => {
    const hours = Number(task.budgetHours || 0);
    const workDays = Math.ceil(hours / 8);
    const d = new Date(task.endDate);
    let counted = 0;
    while (counted < workDays) { d.setDate(d.getDate() - 1); if (d.getDay() !== 5 && d.getDay() !== 6) counted++; }
    return d < now;
  })() : false;

  return (
    <div ref={setNodeRef} style={style} {...attributes}
      className={cn(
        'rounded-lg border border-slate-200 bg-white shadow-sm hover:shadow-md transition-all border-l-[3px]',
        zoneBorderColors[zoneType] || 'border-l-slate-300',
        isDragging && 'opacity-40 shadow-lg ring-2 ring-blue-300 z-50',
      )}>
      {/* Drag handle */}
      <div {...listeners} className="flex items-center gap-1.5 px-3 pt-2 cursor-grab active:cursor-grabbing">
        <GripVertical className="h-3 w-3 text-slate-300" />
        {projectName && (
          <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 rounded px-1.5 py-0.5 truncate max-w-[140px]">{projectName}</span>
        )}
      </div>

      {/* Clickable area → open drawer */}
      <div className="px-3 pb-3 pt-1 cursor-pointer" onClick={() => onOpenDrawer(task.id)}>
        {task.code && <span className="text-[9px] font-mono text-slate-400">{task.code}</span>}
        <p className="text-[13px] font-medium text-slate-800 line-clamp-2">{task.name}</p>
        {zoneName && <p className="text-[10px] text-slate-400 mt-0.5 truncate">{zoneName}</p>}

        <div className="mt-2 flex items-center gap-1.5 text-[10px] flex-wrap">
          {task.priority === 'critical' && <span className="rounded bg-red-100 px-1 py-0.5 font-bold text-red-600">Critical</span>}
          {task.priority === 'high' && <span className="rounded bg-amber-100 px-1 py-0.5 font-bold text-amber-600">High</span>}
          {task.budgetHours != null && Number(task.budgetHours) > 0 && <span className="text-slate-500">{Number(task.budgetHours)}h est.</span>}
          {isOverdue && <span className="rounded bg-red-100 px-1 py-0.5 font-bold text-red-600">Overdue</span>}
        </div>

        {/* Dates row */}
        <div className="mt-1.5 space-y-0.5">
          {task.endDate && (
            <div className="flex items-center gap-1 text-[10px]">
              <span className="text-slate-400">Due:</span>
              <span className={cn('font-medium', isOverdue ? 'text-red-600' : 'text-slate-600')}>
                {new Date(task.endDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
              </span>
            </div>
          )}
          {startBy && (
            <div className="flex items-center gap-1 text-[10px]">
              <CalendarClock className="h-3 w-3 text-amber-500" />
              <span className="text-slate-400">Start by:</span>
              <span className={cn('font-medium', startByPassed ? 'text-red-600' : 'text-amber-600')}>{startBy}</span>
            </div>
          )}
        </div>

        {/* Progress */}
        {task.completionPct > 0 && (
          <div className="mt-1.5 flex items-center gap-1">
            <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full" style={{ width: `${task.completionPct}%` }} />
            </div>
            <span className="text-[10px] text-blue-600 font-medium shrink-0">{task.completionPct}%</span>
          </div>
        )}

        <div className="mt-2">
          <QuickTimeLog taskId={task.id} taskName={task.name} />
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
  const [activeTab, setActiveTab] = useState<TabMode>('time');
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [drawerTaskId, setDrawerTaskId] = useState<number | null>(null);
  const [timeLogTask, setTimeLogTask] = useState<{ id: number; name: string; targetStatus: string } | null>(null);
  const [timeLogHours, setTimeLogHours] = useState('');
  const [timeLogNote, setTimeLogNote] = useState('');

  const { data: tasksData, isLoading } = useQuery({
    queryKey: ['tasks', 'mine'],
    queryFn: () => tasksApi.mine().then((r: any) => {
      const d = r?.data ?? r;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
  });

  const tasks: any[] = Array.isArray(tasksData) ? tasksData : [];

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

      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-400">Loading your tasks...</div>
      ) : activeTab === 'time' ? (
        <TimeReportingTab tasks={tasks} />
      ) : tasks.length === 0 ? (
        <div className="py-12 text-center">
          <UserIcon className="mx-auto h-12 w-12 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">No tasks assigned to you</p>
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
