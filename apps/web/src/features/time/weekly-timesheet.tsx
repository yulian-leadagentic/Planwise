import { useState, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, X, Home, Building2, Clock } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { timeApi, type TimeEntryPayload } from '@/api/time.api';
import { useClockStatus, useClockIn, useClockOut, useWeeklyGrid, useCreateTimeEntry } from '@/hooks/use-time';
import { format, addDays, startOfWeek } from '@/lib/date-utils';
import { minutesToDisplay } from '@/types';
import client from '@/api/client';

const HOURS = Array.from({ length: 13 }, (_, i) => i + 7); // 7:00 - 19:00
const HOUR_HEIGHT = 48; // px per hour row

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ─── Time Entry Form Popup ──────────────────────────────────────────────────

const KANBAN_STATUSES = [
  { value: 'not_started', label: 'To Do', bg: 'bg-slate-100', text: 'text-slate-600' },
  { value: 'in_progress', label: 'In Progress', bg: 'bg-blue-100', text: 'text-blue-700' },
  { value: 'in_review', label: 'In Review', bg: 'bg-violet-100', text: 'text-violet-700' },
  { value: 'completed', label: 'Done', bg: 'bg-emerald-100', text: 'text-emerald-700' },
];

function TimeEntryFormPopup({ date, startTime, endTime, onClose, onSaved }: {
  date: string; startTime: string; endTime: string; onClose: () => void; onSaved: () => void;
}) {
  const [projectId, setProjectId] = useState<string>('');
  const [taskId, setTaskId] = useState<string>('');
  const [start, setStart] = useState(startTime);
  const [end, setEnd] = useState(endTime);
  const [location, setLocation] = useState<'office' | 'home'>('office');
  const [note, setNote] = useState('');
  const [isBillable, setIsBillable] = useState(true);
  const [taskStatus, setTaskStatus] = useState<string>('in_progress');
  const [showQuickTask, setShowQuickTask] = useState(false);
  const [quickTaskName, setQuickTaskName] = useState('');
  const createEntry = useCreateTimeEntry();
  const queryClient = useQueryClient();

  // Fetch user's projects
  const { data: projectsData } = useQuery({
    queryKey: ['projects', 'active'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/projects?status=active&perPage=100').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
  });
  const projects = projectsData ?? [];

  // Fetch tasks for selected project
  const { data: tasksData } = useQuery({
    queryKey: ['tasks', 'mine'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/tasks/mine').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
  });
  const allTasks = tasksData ?? [];
  const filteredTasks = projectId ? allTasks.filter((t: any) => String(t.projectId) === projectId) : allTasks;

  const totalMinutes = Math.max(0, timeToMinutes(end) - timeToMinutes(start));
  const totalHours = (totalMinutes / 60).toFixed(2);

  const handleCreateQuickTask = async () => {
    if (!quickTaskName.trim() || !projectId) return;
    try {
      // Get first zone of the project to attach the task
      const planRes = await client.get(`/projects/${projectId}/planning-data`);
      const pd = planRes.data?.data ?? planRes.data;
      const zones = pd?.zones ?? [];
      const firstZoneId = zones[0]?.id;
      if (!firstZoneId) { notify.warning('Project has no zones — create one first'); return; }

      const taskRes = await client.post('/tasks', {
        zoneId: firstZoneId,
        code: `QT-${Date.now().toString(36).toUpperCase()}`,
        name: quickTaskName.trim(),
      });
      const newTask = taskRes.data?.data ?? taskRes.data;
      if (newTask?.id) {
        setTaskId(String(newTask.id));
        queryClient.invalidateQueries({ queryKey: ['tasks'] });
        notify.success(`Task "${quickTaskName.trim()}" created`);
      }
      setShowQuickTask(false);
      setQuickTaskName('');
    } catch (err: any) {
      notify.apiError(err, 'Failed to create task');
    }
  };

  const handleSubmit = async () => {
    if (totalMinutes <= 0) { notify.warning('End time must be after start time'); return; }

    // Update task status if a task is selected
    if (taskId && taskStatus) {
      try {
        await client.patch(`/tasks/${taskId}`, { status: taskStatus });
        queryClient.invalidateQueries({ queryKey: ['tasks'] });
        queryClient.invalidateQueries({ queryKey: ['planning'] });
      } catch { /* ignore status update failure */ }
    }

    createEntry.mutate({
      projectId: projectId ? Number(projectId) : undefined,
      taskId: taskId ? Number(taskId) : undefined,
      date,
      startTime: start,
      endTime: end,
      minutes: totalMinutes,
      note: note.trim() || undefined,
      isBillable,
      location,
    }, {
      onSuccess: () => {
        onSaved();
        onClose();
      },
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-lg rounded-[14px] bg-white shadow-2xl border border-slate-200" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Add Timesheet Entry</h3>
            <p className="text-[11px] text-slate-400">{new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          </div>
          <div className="flex items-center gap-1">
            {/* Location toggle */}
            <button onClick={() => setLocation('home')} className={cn('flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-semibold', location === 'home' ? 'bg-blue-100 text-blue-700' : 'text-slate-400 hover:bg-slate-50')}>
              <Home className="h-3.5 w-3.5" /> Home
            </button>
            <button onClick={() => setLocation('office')} className={cn('flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-semibold', location === 'office' ? 'bg-blue-100 text-blue-700' : 'text-slate-400 hover:bg-slate-50')}>
              <Building2 className="h-3.5 w-3.5" /> Office
            </button>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {/* Project selector */}
          <div>
            <label className="text-[12px] font-semibold text-slate-600 mb-1 block">Project</label>
            <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setTaskId(''); }}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
              <option value="">— Select project —</option>
              {projects.map((p: any) => <option key={p.id} value={p.id}>{p.number ? `${p.number} - ` : ''}{p.name}</option>)}
            </select>
          </div>

          {/* Task selector + Quick Task */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[12px] font-semibold text-slate-600">Task</label>
              {projectId && (
                <button type="button" onClick={() => setShowQuickTask(!showQuickTask)}
                  className="text-[11px] font-semibold text-blue-600 hover:text-blue-700">
                  + Quick Task
                </button>
              )}
            </div>
            {showQuickTask ? (
              <div className="flex gap-2">
                <input type="text" value={quickTaskName} onChange={(e) => setQuickTaskName(e.target.value)}
                  placeholder="New task name..." autoFocus
                  className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                <button type="button" onClick={handleCreateQuickTask} disabled={!quickTaskName.trim()}
                  className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">Create</button>
                <button type="button" onClick={() => setShowQuickTask(false)}
                  className="text-sm text-slate-400 px-2">Cancel</button>
              </div>
            ) : (
              <select value={taskId} onChange={(e) => { setTaskId(e.target.value); const t = filteredTasks.find((tk: any) => String(tk.id) === e.target.value); if (t) setTaskStatus(t.status || 'in_progress'); }}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                <option value="">— Select task —</option>
                {filteredTasks.map((t: any) => (
                  <option key={t.id} value={t.id}>
                    {t.code ? `${t.code} - ` : ''}{t.name}
                    {t.zone?.name ? ` (${t.zone.name})` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Time range */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-[12px] font-semibold text-slate-600 mb-1 block">Start Time</label>
              <select value={start} onChange={(e) => setStart(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                {Array.from({ length: 48 }, (_, i) => {
                  const h = Math.floor(i / 4) + 7;
                  const m = (i % 4) * 15;
                  if (h > 19) return null;
                  const val = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                  return <option key={val} value={val}>{val}</option>;
                })}
              </select>
            </div>
            <div>
              <label className="text-[12px] font-semibold text-slate-600 mb-1 block">End Time</label>
              <select value={end} onChange={(e) => setEnd(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                {Array.from({ length: 48 }, (_, i) => {
                  const h = Math.floor(i / 4) + 7;
                  const m = (i % 4) * 15;
                  if (h > 19) return null;
                  const val = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                  return <option key={val} value={val}>{val}</option>;
                })}
              </select>
            </div>
            <div>
              <label className="text-[12px] font-semibold text-slate-600 mb-1 block">Total Hours</label>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700">
                {totalHours}h
              </div>
            </div>
          </div>

          {/* Task Status (Kanban stages) */}
          {taskId && (
            <div>
              <label className="text-[12px] font-semibold text-slate-600 mb-1 block">Task Status</label>
              <div className="flex items-center gap-1">
                {KANBAN_STATUSES.map((s) => (
                  <button key={s.value} type="button" onClick={() => setTaskStatus(s.value)}
                    className={cn('rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors',
                      taskStatus === s.value ? `${s.bg} ${s.text} ring-2 ring-offset-1 ring-blue-400` : 'bg-slate-50 text-slate-500 hover:bg-slate-100')}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Billable + Note */}
          <div className="flex items-start gap-4">
            <label className="flex items-center gap-2 cursor-pointer text-[12px]">
              <input type="checkbox" checked={isBillable} onChange={(e) => setIsBillable(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600" />
              <span className="font-medium text-slate-600">Billable</span>
            </label>
          </div>

          <div>
            <label className="text-[12px] font-semibold text-slate-600 mb-1 block">Description</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
              placeholder="What did you work on?"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none resize-none" />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2 text-[13px] font-semibold text-slate-700 hover:bg-slate-50">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={createEntry.isPending || totalMinutes <= 0}
            className="rounded-lg bg-blue-600 px-5 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {createEntry.isPending ? 'Saving...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Time Block (visual entry on the calendar) ─────────────────────────────

function TimeBlock({ entry }: { entry: any }) {
  const startMins = entry.startTime ? timeToMinutes(entry.startTime) : 0;
  const endMins = entry.endTime ? timeToMinutes(entry.endTime) : startMins + (entry.minutes ?? 60);
  const top = ((startMins - 7 * 60) / 60) * HOUR_HEIGHT;
  const height = Math.max(((endMins - startMins) / 60) * HOUR_HEIGHT, 20);

  const projectName = entry.project?.name ?? entry.task?.project?.name ?? '';
  const taskName = entry.task?.name ?? '';

  const colors = entry.isBillable
    ? 'bg-blue-100 border-blue-300 text-blue-800'
    : 'bg-slate-100 border-slate-300 text-slate-700';

  return (
    <div
      className={cn('absolute left-1 right-1 rounded-md border px-1.5 py-0.5 overflow-hidden cursor-pointer hover:shadow-md transition-shadow text-[10px]', colors)}
      style={{ top: `${top}px`, height: `${height}px` }}
      title={`${entry.startTime ?? ''} - ${entry.endTime ?? ''}\n${projectName}\n${taskName}`}
    >
      <p className="font-semibold truncate">{entry.startTime} - {entry.endTime}</p>
      {height > 30 && <p className="truncate opacity-80">{projectName}</p>}
      {height > 45 && <p className="truncate opacity-60">{taskName}</p>}
      {entry.location && (
        <span className="inline-flex items-center gap-0.5 mt-0.5">
          {entry.location === 'home' ? <Home className="h-2.5 w-2.5" /> : <Building2 className="h-2.5 w-2.5" />}
        </span>
      )}
    </div>
  );
}

// ─── View Mode Types ─────────────────────────────────────────────────────────

type ViewMode = 'day' | 'week' | 'month' | 'year';

// ─── Working Days Calculator ─────────────────────────────────────────────────

function countWorkingDays(year: number, month: number, holidays: Set<string>): { total: number; working: number; holidays: number } {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let working = 0;
  let holidayCount = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const dow = date.getDay();
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (dow === 5 || dow === 6) continue; // Fri+Sat weekend
    if (holidays.has(dateStr)) { holidayCount++; continue; }
    working++;
  }
  return { total: daysInMonth, working, holidays: holidayCount };
}

// ─── Israeli Holidays (common preset) ────────────────────────────────────────

const ISRAELI_HOLIDAYS_2026 = [
  { date: '2026-03-17', name: 'Purim' },
  { date: '2026-04-02', name: 'Pesach (1st day)' },
  { date: '2026-04-03', name: 'Pesach (2nd day)' },
  { date: '2026-04-08', name: 'Pesach (7th day)' },
  { date: '2026-04-16', name: 'Yom HaShoah' },
  { date: '2026-04-23', name: 'Yom HaZikaron' },
  { date: '2026-04-24', name: 'Yom HaAtzmaut' },
  { date: '2026-05-22', name: 'Shavuot' },
  { date: '2026-09-12', name: 'Rosh Hashana (1st)' },
  { date: '2026-09-13', name: 'Rosh Hashana (2nd)' },
  { date: '2026-09-21', name: 'Yom Kippur' },
  { date: '2026-09-26', name: 'Sukkot (1st)' },
  { date: '2026-10-03', name: 'Simchat Torah' },
];

// ─── Weekly Timesheet Calendar ──────────────────────────────────────────────

function WeekView() {
  const queryClient = useQueryClient();
  const [weekOffset, setWeekOffset] = useState(0);
  const [showEntryForm, setShowEntryForm] = useState<{ date: string; startTime: string; endTime: string } | null>(null);
  const [selecting, setSelecting] = useState<{ dayIdx: number; startHour: number } | null>(null);
  const [selectEnd, setSelectEnd] = useState<number | null>(null);

  const weekStart = useMemo(() => {
    const today = new Date();
    const start = startOfWeek(today, { weekStartsOn: 1 });
    return addDays(start, weekOffset * 7);
  }, [weekOffset]);

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const weekStartStr = format(weekStart, 'yyyy-MM-dd');

  const { data: clockStatus } = useClockStatus();
  const clockIn = useClockIn();
  const clockOut = useClockOut();

  // Fetch holidays for working day calculation
  const { data: calendarDays = [] } = useQuery({
    queryKey: ['admin', 'calendar'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/calendar').then((r) => { const d = r.data?.data ?? r.data; return Array.isArray(d) ? d : []; }),
  });
  const holidayDates = useMemo(() => {
    const set = new Set<string>();
    for (const d of calendarDays) { if (d.date) set.add(typeof d.date === 'string' ? d.date.split('T')[0] : new Date(d.date).toISOString().split('T')[0]); }
    return set;
  }, [calendarDays]);

  // Count working days this week
  const weekWorkingDays = useMemo(() => {
    let count = 0;
    for (let i = 0; i < 7; i++) {
      const day = addDays(weekStart, i);
      const dow = day.getDay();
      const dateStr = format(day, 'yyyy-MM-dd');
      if (dow !== 5 && dow !== 6 && !holidayDates.has(dateStr)) count++;
    }
    return count;
  }, [weekStart, holidayDates]);

  // Fetch entries for the week via the weekly grid endpoint
  const { data: breakdownData } = useWeeklyGrid({ weekStart: weekStartStr });

  // Extract flat entries per day from the grid format
  const entriesByDay = useMemo(() => {
    const map = new Map<string, any[]>();
    const raw = breakdownData as any;

    if (!raw) return map;

    // Handle weekly grid format: { rows: [{ days: { "2026-04-14": { entries: [...] } } }] }
    if (raw.rows && Array.isArray(raw.rows)) {
      for (const row of raw.rows) {
        for (const [dateKey, dayData] of Object.entries(row.days ?? {})) {
          if (!map.has(dateKey)) map.set(dateKey, []);
          const entries = (dayData as any)?.entries ?? [];
          map.get(dateKey)!.push(...entries);
        }
      }
    }
    // Handle array of daily breakdowns: [{ date, entries }]
    else if (Array.isArray(raw)) {
      for (const day of raw) {
        map.set(day.date, day.entries ?? []);
      }
    }

    return map;
  }, [breakdownData]);

  // Calculate daily totals — use grid dailyTotals if available, else sum from entries
  const dailyTotals = useMemo(() => {
    const raw = breakdownData as any;
    if (raw?.dailyTotals) return raw.dailyTotals as Record<string, number>;
    const totals: Record<string, number> = {};
    for (const [date, entries] of entriesByDay.entries()) {
      totals[date] = entries.reduce((s: number, e: any) => s + (e.minutes ?? 0), 0);
    }
    return totals;
  }, [breakdownData, entriesByDay]);

  const weekTotal = (breakdownData as any)?.weeklyTotal ?? Object.values(dailyTotals).reduce((s, m) => s + (typeof m === 'number' ? m : 0), 0);
  const todayKey = format(new Date(), 'yyyy-MM-dd');

  // Mouse handlers for time selection
  const handleMouseDown = (dayIdx: number, hour: number) => {
    setSelecting({ dayIdx, startHour: hour });
    setSelectEnd(hour + 1);
  };

  const handleMouseMove = (hour: number) => {
    if (selecting) setSelectEnd(Math.max(selecting.startHour + 1, hour + 1));
  };

  const handleMouseUp = () => {
    if (selecting && selectEnd) {
      const date = format(weekDays[selecting.dayIdx], 'yyyy-MM-dd');
      const startTime = `${String(selecting.startHour).padStart(2, '0')}:00`;
      const endTime = `${String(selectEnd).padStart(2, '0')}:00`;
      setShowEntryForm({ date, startTime, endTime });
    }
    setSelecting(null);
    setSelectEnd(null);
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['time'] });
  };

  return (
    <div className="space-y-4">
      {/* Quick actions */}
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={() => clockStatus?.isClockedIn ? clockOut.mutate() : clockIn.mutate()}
          disabled={clockIn.isPending || clockOut.isPending}
          className={cn('flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50',
            clockStatus?.isClockedIn ? 'border border-red-200 bg-red-50 text-red-700 hover:bg-red-100' : 'border border-green-200 bg-green-50 text-green-700 hover:bg-green-100')}>
          <Clock className="h-4 w-4" />
          {clockStatus?.isClockedIn ? 'Clock Out' : 'Clock In'}
        </button>
        <button onClick={() => setShowEntryForm({ date: todayKey, startTime: '09:00', endTime: '10:00' })}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
          <Plus className="h-4 w-4" /> Add Entry
        </button>
      </div>

      {/* Week navigation + summary */}
      <div className="flex items-center justify-between rounded-[14px] border border-slate-200 bg-white px-5 py-3">
        <button onClick={() => setWeekOffset((o) => o - 1)} className="rounded-md p-1.5 hover:bg-slate-100"><ChevronLeft className="h-5 w-5" /></button>
        <div className="text-center">
          <p className="text-sm font-semibold text-slate-700">{format(weekDays[0], 'MMM d')} — {format(weekDays[6], 'MMM d, yyyy')}</p>
          <p className="text-[11px] text-slate-400">
            Week total: <span className="font-semibold text-slate-700">{minutesToDisplay(weekTotal)}</span>
            {' · '}<span className="font-semibold text-slate-600">{weekWorkingDays}</span> working days
            {weekOffset === 0 && ' · This week'}
          </p>
        </div>
        <button onClick={() => setWeekOffset((o) => o + 1)} disabled={weekOffset >= 0} className="rounded-md p-1.5 hover:bg-slate-100 disabled:opacity-50"><ChevronRight className="h-5 w-5" /></button>
      </div>

      {/* Calendar Grid */}
      <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
        {/* Day headers */}
        <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-slate-200 bg-slate-50">
          <div className="px-2 py-3 text-[10px] font-semibold text-slate-400" />
          {weekDays.map((day, i) => {
            const dateKey = format(day, 'yyyy-MM-dd');
            const isToday = dateKey === todayKey;
            const isWeekend = day.getDay() === 5 || day.getDay() === 6;
            const isHoliday = holidayDates.has(dateKey);
            const holidayName = isHoliday ? calendarDays.find((h: any) => (typeof h.date === 'string' ? h.date.split('T')[0] : new Date(h.date).toISOString().split('T')[0]) === dateKey)?.name : null;
            const total = dailyTotals[dateKey] ?? 0;
            return (
              <div key={i} className={cn('px-2 py-3 text-center border-l border-slate-200', isWeekend && 'bg-slate-100/50', isHoliday && 'bg-red-50/50')}>
                <p className={cn('text-[11px] font-semibold', isToday ? 'text-blue-600' : 'text-slate-500')}>
                  {format(day, 'EEE')}
                </p>
                <p className={cn('text-[13px] font-bold', isToday ? 'text-blue-600' : 'text-slate-700')}>
                  {isToday ? (
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-white">{day.getDate()}</span>
                  ) : day.getDate()}
                </p>
                {total > 0 && (
                  <p className="text-[10px] font-medium text-slate-400 mt-0.5">{minutesToDisplay(total)}</p>
                )}
                {isHoliday && holidayName && (
                  <p className="text-[8px] font-medium text-red-500 mt-0.5 truncate" title={holidayName}>{holidayName}</p>
                )}
                {/* Green daily total bar */}
                {typeof total === 'number' && total > 0 && (
                  <div className="mt-1.5 rounded-sm bg-green-500 text-white text-[10px] font-bold text-center py-0.5">
                    {(total / 60).toFixed(2)} hrs
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Time grid — single table for perfect alignment */}
        <div className="overflow-y-auto" style={{ maxHeight: '600px' }}
          onMouseUp={handleMouseUp} onMouseLeave={() => { setSelecting(null); setSelectEnd(null); }}>
          <table className="w-full" style={{ tableLayout: 'fixed', borderCollapse: 'collapse' }}>
            <colgroup>
              <col style={{ width: '60px' }} />
              {weekDays.map((_, i) => <col key={i} />)}
            </colgroup>
            <tbody>
              {HOURS.map((hour) => (
                <tr key={hour}>
                  <td className="border-b border-r border-slate-100 text-[10px] text-slate-400 text-right pr-2 pt-1 align-top"
                    style={{ height: `${HOUR_HEIGHT}px` }}>
                    {String(hour).padStart(2, '0')}:00
                  </td>
                  {weekDays.map((day, dayIdx) => {
                    const isWeekend = day.getDay() === 5 || day.getDay() === 6;
                    const isSelecting = selecting?.dayIdx === dayIdx && selectEnd != null && hour >= selecting!.startHour && hour < selectEnd;
                    const dateKey = format(day, 'yyyy-MM-dd');
                    const dayIsHoliday = holidayDates.has(dateKey);
                    const isNonWorking = isWeekend || dayIsHoliday;
                    const entries = entriesByDay.get(dateKey) ?? [];

                    // Find entries that START in this hour
                    const hourEntries = entries.filter((e: any) => {
                      if (!e.startTime) return hour === 9;
                      const startH = parseInt(e.startTime.split(':')[0], 10);
                      return startH === hour;
                    });

                    return (
                      <td key={dayIdx}
                        className={cn('border-b border-l border-slate-100 cursor-crosshair hover:bg-blue-50/20 relative p-0',
                          isNonWorking && 'bg-slate-200/40',
                          isSelecting && 'bg-blue-100/50')}
                        style={{ height: `${HOUR_HEIGHT}px` }}
                        onMouseDown={() => handleMouseDown(dayIdx, hour)}
                        onMouseMove={() => handleMouseMove(hour)}>
                        {/* Entries that start in this hour cell */}
                        {hourEntries.map((entry: any) => {
                          const startMins = entry.startTime ? timeToMinutes(entry.startTime) : 9 * 60;
                          const endMins = entry.endTime ? timeToMinutes(entry.endTime) : startMins + (entry.minutes ?? 60);
                          const offsetInCell = ((startMins % 60) / 60) * HOUR_HEIGHT;
                          const durationHours = (endMins - startMins) / 60;
                          const blockHeight = Math.max(durationHours * HOUR_HEIGHT, 36);
                          const projectName = entry.project?.name ?? '';
                          const taskName = entry.task?.name ?? '';
                          const timeLabel = `${entry.startTime ?? '?'} – ${entry.endTime ?? '?'}`;
                          return (
                            <div key={entry.id}
                              className="absolute left-0.5 right-0.5 rounded-md bg-blue-600 text-white px-2 py-1 overflow-hidden z-10 cursor-pointer hover:bg-blue-700 shadow-sm"
                              style={{ top: `${offsetInCell}px`, height: `${blockHeight}px` }}
                              title={`${timeLabel}\n${projectName}\n${taskName}\n${durationHours.toFixed(2)} hrs`}>
                              <p className="text-[10px] font-medium opacity-90">{timeLabel}</p>
                              <p className="text-[11px] font-bold truncate">{projectName || 'No project'}</p>
                              {blockHeight > 50 && taskName && <p className="text-[10px] truncate opacity-80">{taskName}</p>}
                              <p className="text-[10px] font-semibold mt-0.5">{durationHours.toFixed(2)} hrs</p>
                            </div>
                          );
                        })}

                        {/* Selection indicator */}
                        {isSelecting && hour === selecting!.startHour && (
                          <div className="absolute inset-0 flex items-start justify-center pt-1 pointer-events-none z-20">
                            <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 rounded px-1">
                              {String(selecting!.startHour).padStart(2, '0')}:00-{String(selectEnd).padStart(2, '0')}:00
                            </span>
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Entries list (fallback view for all entries this week) */}
      {(() => {
        const allEntries: any[] = [];
        for (const [date, entries] of entriesByDay.entries()) {
          for (const e of entries) allEntries.push({ ...e, _date: date });
        }
        if (allEntries.length === 0) return null;
        return (
          <div className="rounded-[14px] border border-slate-200 bg-white p-4">
            <h3 className="text-[13px] font-semibold text-slate-700 mb-2">Entries this week ({allEntries.length})</h3>
            <div className="space-y-1">
              {allEntries.map((e: any) => (
                <div key={e.id} className="flex items-center gap-3 rounded-md bg-slate-50 px-3 py-2 text-[12px]">
                  <span className="text-slate-500 w-20">{e._date}</span>
                  <span className="text-slate-500 w-16">{e.startTime ?? '-'} - {e.endTime ?? '-'}</span>
                  <span className="font-medium text-slate-700">{minutesToDisplay(e.minutes)}</span>
                  <span className="text-slate-600 flex-1 truncate">{e.project?.name ?? ''} {e.task?.name ? `/ ${e.task.name}` : ''}</span>
                  {e.location && <span className="text-[10px] text-slate-400">{e.location === 'home' ? '🏠' : '🏢'}</span>}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Entry Form Popup */}
      {showEntryForm && (
        <TimeEntryFormPopup
          date={showEntryForm.date}
          startTime={showEntryForm.startTime}
          endTime={showEntryForm.endTime}
          onClose={() => setShowEntryForm(null)}
          onSaved={invalidate}
        />
      )}
    </div>
  );
}

// ─── Month View ─────────────────────────────────────────────────────────────

function MonthView() {
  const [monthOffset, setMonthOffset] = useState(0);
  const today = new Date();
  const viewYear = today.getFullYear() + Math.floor((today.getMonth() + monthOffset) / 12);
  const viewMonth = ((today.getMonth() + monthOffset) % 12 + 12) % 12;
  const monthName = new Date(viewYear, viewMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const { data: calendarDays = [] } = useQuery({
    queryKey: ['admin', 'calendar'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/calendar').then((r) => { const d = r.data?.data ?? r.data; return Array.isArray(d) ? d : []; }),
  });

  const holidayDates = useMemo(() => {
    const set = new Set<string>();
    for (const d of calendarDays) { if (d.date) set.add(typeof d.date === 'string' ? d.date.split('T')[0] : new Date(d.date).toISOString().split('T')[0]); }
    return set;
  }, [calendarDays]);

  const workingDays = countWorkingDays(viewYear, viewMonth, holidayDates);
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDow = (() => { let d = new Date(viewYear, viewMonth, 1).getDay() - 1; return d < 0 ? 6 : d; })();
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-[14px] border border-slate-200 bg-white px-5 py-3">
        <button onClick={() => setMonthOffset((o) => o - 1)} className="rounded-md p-1.5 hover:bg-slate-100"><ChevronLeft className="h-5 w-5" /></button>
        <div className="text-center">
          <p className="text-sm font-semibold text-slate-700">{monthName}</p>
          <p className="text-[11px] text-slate-400"><span className="font-semibold text-slate-700">{workingDays.working}</span> working days{workingDays.holidays > 0 && <span> · <span className="text-red-500">{workingDays.holidays} holidays</span></span>}</p>
        </div>
        <button onClick={() => setMonthOffset((o) => o + 1)} className="rounded-md p-1.5 hover:bg-slate-100"><ChevronRight className="h-5 w-5" /></button>
      </div>
      <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
          {DAY_NAMES.map((d) => (<div key={d} className="px-2 py-2.5 text-center text-[11px] font-semibold text-slate-500 uppercase">{d}</div>))}
        </div>
        <div className="grid grid-cols-7">
          {Array.from({ length: firstDow }).map((_, i) => (<div key={`pad-${i}`} className="min-h-[80px] border-b border-r border-slate-100 bg-slate-50/30" />))}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const d = i + 1;
            const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const dow = new Date(viewYear, viewMonth, d).getDay();
            const isWeekend = dow === 5 || dow === 6;
            const isHoliday = holidayDates.has(dateStr);
            const isToday = dateStr === format(today, 'yyyy-MM-dd');
            const holiday = calendarDays.find((h: any) => (typeof h.date === 'string' ? h.date.split('T')[0] : new Date(h.date).toISOString().split('T')[0]) === dateStr);
            return (
              <div key={d} className={cn('min-h-[80px] border-b border-r border-slate-100 p-1.5', isWeekend && 'bg-slate-50/50', isHoliday && 'bg-red-50/30')}>
                <span className={cn('text-[13px] font-medium', isToday ? 'text-white bg-blue-600 rounded-full w-7 h-7 inline-flex items-center justify-center' : 'text-slate-700', isWeekend && !isToday && 'text-slate-400')}>{d}</span>
                {isHoliday && holiday && <div className="mt-1 rounded px-1 py-0.5 bg-red-100 text-[9px] font-medium text-red-700 truncate">{holiday.name}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Year View ──────────────────────────────────────────────────────────────

function YearView() {
  const [yearOffset, setYearOffset] = useState(0);
  const today = new Date();
  const viewYear = today.getFullYear() + yearOffset;

  const { data: calendarDays = [] } = useQuery({
    queryKey: ['admin', 'calendar'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/calendar').then((r) => { const d = r.data?.data ?? r.data; return Array.isArray(d) ? d : []; }),
  });

  const holidayDates = useMemo(() => {
    const set = new Set<string>();
    for (const d of calendarDays) { if (d.date) set.add(typeof d.date === 'string' ? d.date.split('T')[0] : new Date(d.date).toISOString().split('T')[0]); }
    return set;
  }, [calendarDays]);

  const MONTHS = Array.from({ length: 12 }, (_, i) => {
    const name = new Date(viewYear, i).toLocaleDateString('en-US', { month: 'long' });
    const wd = countWorkingDays(viewYear, i, holidayDates);
    return { index: i, name, ...wd };
  });

  const totalWorking = MONTHS.reduce((s, m) => s + m.working, 0);
  const totalHolidays = MONTHS.reduce((s, m) => s + m.holidays, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-[14px] border border-slate-200 bg-white px-5 py-3">
        <button onClick={() => setYearOffset((o) => o - 1)} className="rounded-md p-1.5 hover:bg-slate-100"><ChevronLeft className="h-5 w-5" /></button>
        <div className="text-center">
          <p className="text-lg font-bold text-slate-900">{viewYear}</p>
          <p className="text-[11px] text-slate-400"><span className="font-semibold text-slate-700">{totalWorking}</span> working days · <span className="text-red-500">{totalHolidays} holidays</span></p>
        </div>
        <button onClick={() => setYearOffset((o) => o + 1)} className="rounded-md p-1.5 hover:bg-slate-100"><ChevronRight className="h-5 w-5" /></button>
      </div>
      <div className="grid grid-cols-3 lg:grid-cols-4 gap-3">
        {MONTHS.map((m) => {
          const isCurrent = viewYear === today.getFullYear() && m.index === today.getMonth();
          return (
            <div key={m.index} className={cn('rounded-[14px] border bg-white p-4', isCurrent ? 'border-blue-300 ring-2 ring-blue-100' : 'border-slate-200')}>
              <h3 className={cn('text-sm font-semibold', isCurrent ? 'text-blue-600' : 'text-slate-900')}>{m.name}</h3>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div><p className="text-lg font-bold text-slate-700">{m.working}</p><p className="text-[9px] text-slate-400">Working</p></div>
                <div><p className={cn('text-lg font-bold', m.holidays > 0 ? 'text-red-600' : 'text-slate-300')}>{m.holidays}</p><p className="text-[9px] text-slate-400">Holidays</p></div>
                <div><p className="text-lg font-bold text-slate-400">{m.total}</p><p className="text-[9px] text-slate-400">Total</p></div>
              </div>
              <div className="mt-2 w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full" style={{ width: `${(m.working / m.total) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Timesheet Page ────────────────────────────────────────────────────

export function WeeklyTimesheetPage() {
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <PageHeader title="Timesheet" description="Time reporting and calendar" />
        <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">
          {(['day', 'week', 'month', 'year'] as ViewMode[]).map((v) => (
            <button key={v} onClick={() => setViewMode(v)}
              className={cn('px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors capitalize',
                viewMode === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
              {v}
            </button>
          ))}
        </div>
      </div>
      {viewMode === 'week' && <WeekView />}
      {viewMode === 'day' && <WeekView />}
      {viewMode === 'month' && <MonthView />}
      {viewMode === 'year' && <YearView />}
    </div>
  );
}
