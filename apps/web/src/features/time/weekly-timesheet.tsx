import { useState, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, X, Home, Building2, Clock } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { timeApi, type TimeEntryPayload } from '@/api/time.api';
import { useClockStatus, useClockIn, useClockOut, useDailyBreakdown, useCreateTimeEntry } from '@/hooks/use-time';
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
  const [completionPct, setCompletionPct] = useState<number | null>(null);
  const createEntry = useCreateTimeEntry();

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

  const handleSubmit = () => {
    if (totalMinutes <= 0) { notify.warning('End time must be after start time'); return; }

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
      completionPct: completionPct ?? undefined,
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

          {/* Task selector */}
          <div>
            <label className="text-[12px] font-semibold text-slate-600 mb-1 block">Task</label>
            <select value={taskId} onChange={(e) => setTaskId(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
              <option value="">— Select task —</option>
              {filteredTasks.map((t: any) => (
                <option key={t.id} value={t.id}>
                  {t.code ? `${t.code} - ` : ''}{t.name}
                  {t.zone?.name ? ` (${t.zone.name})` : ''}
                </option>
              ))}
            </select>
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

          {/* Completion percentage */}
          <div>
            <label className="text-[12px] font-semibold text-slate-600 mb-1 block">Task Completion</label>
            <div className="flex items-center gap-1">
              {[0, 25, 50, 75, 100].map((pct) => (
                <button key={pct} onClick={() => setCompletionPct(pct)}
                  className={cn('rounded-lg px-3 py-1.5 text-[12px] font-semibold', completionPct === pct ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}>
                  {pct}%
                </button>
              ))}
            </div>
          </div>

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

// ─── Weekly Timesheet Calendar ──────────────────────────────────────────────

export function WeeklyTimesheetPage() {
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

  // Fetch entries for the week — the API returns weekly grid format
  const { data: breakdownData } = useDailyBreakdown(weekStartStr);

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
      <PageHeader
        title="Timesheet"
        description="Weekly time reporting — click and drag on the calendar to log time"
        actions={
          <div className="flex items-center gap-2">
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
        }
      />

      {/* Week navigation + summary */}
      <div className="flex items-center justify-between rounded-[14px] border border-slate-200 bg-white px-5 py-3">
        <button onClick={() => setWeekOffset((o) => o - 1)} className="rounded-md p-1.5 hover:bg-slate-100"><ChevronLeft className="h-5 w-5" /></button>
        <div className="text-center">
          <p className="text-sm font-semibold text-slate-700">{format(weekDays[0], 'MMM d')} — {format(weekDays[6], 'MMM d, yyyy')}</p>
          <p className="text-[11px] text-slate-400">
            Week total: <span className="font-semibold text-slate-700">{minutesToDisplay(weekTotal)}</span>
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
            const total = dailyTotals[dateKey] ?? 0;
            return (
              <div key={i} className={cn('px-2 py-3 text-center border-l border-slate-200', isWeekend && 'bg-slate-100/50')}>
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
              </div>
            );
          })}
        </div>

        {/* Time grid */}
        <div className="grid grid-cols-[60px_repeat(7,1fr)] overflow-y-auto" style={{ maxHeight: '600px' }}
          onMouseUp={handleMouseUp} onMouseLeave={() => { setSelecting(null); setSelectEnd(null); }}>
          {/* Hour labels */}
          <div>
            {HOURS.map((hour) => (
              <div key={hour} className="border-b border-slate-100 text-[10px] text-slate-400 text-right pr-2 pt-1" style={{ height: HOUR_HEIGHT }}>
                {String(hour).padStart(2, '0')}:00
              </div>
            ))}
          </div>

          {/* Day columns */}
          {weekDays.map((day, dayIdx) => {
            const dateKey = format(day, 'yyyy-MM-dd');
            const entries = entriesByDay.get(dateKey) ?? [];
            const isWeekend = day.getDay() === 5 || day.getDay() === 6;

            return (
              <div key={dayIdx} className={cn('relative border-l border-slate-200', isWeekend && 'bg-slate-50/50')}>
                {/* Hour grid lines */}
                {HOURS.map((hour) => (
                  <div key={hour}
                    className={cn('border-b border-slate-100 cursor-crosshair hover:bg-blue-50/30',
                      selecting?.dayIdx === dayIdx && selectEnd && hour >= selecting.startHour && hour < selectEnd && 'bg-blue-100/50')}
                    style={{ height: HOUR_HEIGHT }}
                    onMouseDown={() => handleMouseDown(dayIdx, hour)}
                    onMouseMove={() => handleMouseMove(hour)}
                  />
                ))}

                {/* Selection overlay */}
                {selecting?.dayIdx === dayIdx && selectEnd && (
                  <div className="absolute left-1 right-1 bg-blue-200/40 border-2 border-dashed border-blue-400 rounded-md pointer-events-none"
                    style={{
                      top: `${(selecting.startHour - 7) * HOUR_HEIGHT}px`,
                      height: `${(selectEnd - selecting.startHour) * HOUR_HEIGHT}px`,
                    }}>
                    <span className="absolute top-1 left-1 text-[10px] font-semibold text-blue-600">
                      {String(selecting.startHour).padStart(2, '0')}:00 - {String(selectEnd).padStart(2, '0')}:00
                    </span>
                  </div>
                )}

                {/* Existing time entries */}
                {entries.map((entry: any) => (
                  <TimeBlock key={entry.id} entry={entry} />
                ))}
              </div>
            );
          })}
        </div>
      </div>

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
