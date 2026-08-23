import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, Home, Building2, Clock, Pencil, Trash2 } from 'lucide-react';
import { TaskDrawer } from '@/features/tasks/task-drawer';
import { useDrawerRoute } from '@/components/nav/use-drawer-route';
import { PageHeader } from '@/components/shared/page-header';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { timeApi, type TimeEntryPayload } from '@/api/time.api';
import { useClockStatus, useClockIn, useClockOut, useWeeklyGrid, useDeleteTimeEntry } from '@/hooks/use-time';
import { useOverlapConfirm } from './overlap-confirm';
import { invalidateAfterTimeEntry } from './invalidate-after-time-entry';
import { format, addDays, startOfWeek } from '@/lib/date-utils';
import { minutesToDisplay } from '@/types';
import client from '@/api/client';
import { useAuthStore } from '@/stores/auth.store';
import { useConfirm } from '@/components/shared/confirm-dialog';

// Default visible band — 07:00 – 19:00. The WeekView expands the band
// (both directions) when any entry for the visible week starts/ends
// outside it, so entries that would previously have been dropped from
// the grid always get an hour row of their own.
const DEFAULT_MIN_HOUR = 7;
const DEFAULT_MAX_HOUR = 19; // inclusive: rows are DEFAULT_MIN..=DEFAULT_MAX
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
  { value: 'not_started', label: 'To Do', bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-600 dark:text-slate-300' },
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
  // Task being edited in the drawer. The "+ Quick Task" button creates a
  // task; this lets the user open the SELECTED task to edit it properly
  // (name, due date, assignees, etc.) without leaving the timesheet.
  // Drawer ID in ?task=N so back/refresh/outbound-return restores it.
  const { drawerId: editingTaskId, openDrawer: setEditingTaskId, closeDrawer: closeEditing } = useDrawerRoute('task');
  // Bypass the blanket useCreateTimeEntry hook and drive the request
  // directly so we can intercept the CROSS_TASK_OVERLAP error and show
  // the Save-anyway confirmation. The hook always toasts on error,
  // which is why the user saw the warning without an action button —
  // V11 in the bug list.
  const overlap = useOverlapConfirm();
  const [submitting, setSubmitting] = useState(false);
  const queryClient = useQueryClient();
  // Needed for quick-task creation so we can assign the new task to the
  // current user — otherwise /tasks/mine wouldn't return it and the
  // dropdown couldn't pre-select it after creation.
  const currentUserId = useAuthStore((s) => s.user?.id);

  // Fetch projects the current user can report time on — leader OR
  // active member. Client feedback 2026-08-02: time-reporting should
  // only surface the user's own projects (and their team's), not the
  // full company-wide project catalog.
  const { data: projectsData } = useQuery({
    queryKey: ['projects', 'active', 'mine', currentUserId],
    enabled: !!currentUserId,
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/projects', { params: { status: 'active', memberId: currentUserId, perPage: 100 } }).then((r) => {
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

  // Save a time entry. Accepts an override taskId so the Quick-Task path
  // can pass the just-created task's id without waiting for setState to
  // settle (state updates are async — reading `taskId` here in the same
  // tick we just called setTaskId would still see the previous value).
  const doSubmit = async (overrideTaskId?: string) => {
    if (totalMinutes <= 0) { notify.warning('End time must be after start time'); return; }

    const effectiveTaskId = overrideTaskId ?? taskId;

    // Update task status if a task is selected. Full invalidation runs
    // after the time-entry save below (see onSuccess); here we still
    // refresh tasks + planning immediately because the status change
    // itself needs to render even if the time entry is later cancelled
    // by the overlap dialog.
    if (effectiveTaskId && taskStatus) {
      try {
        await client.patch(`/tasks/${effectiveTaskId}`, { status: taskStatus });
        queryClient.invalidateQueries({ queryKey: ['tasks'] });
        queryClient.invalidateQueries({ queryKey: ['planning'] });
      } catch { /* ignore status update failure */ }
    }

    const payloadBase: TimeEntryPayload = {
      projectId: projectId ? Number(projectId) : undefined,
      taskId: effectiveTaskId ? Number(effectiveTaskId) : undefined,
      date,
      startTime: start,
      endTime: end,
      minutes: totalMinutes,
      note: note.trim() || undefined,
      isBillable,
      location,
    };

    setSubmitting(true);
    await overlap.withConfirm(
      (confirmOverlap) => timeApi.createEntry({ ...payloadBase, confirmOverlap }),
      {
        onSuccess: () => {
          notify.success('Time entry created', { code: 'TIME-CREATE-200' });
          // Shared invalidator so project Hours / task Actual ₪ /
          // completion % refresh in every screen without a manual
          // reload. Previously only ['time'] was invalidated here,
          // which is why logging from this popup sometimes-refreshed
          // the tree and never refreshed the project KPIs.
          invalidateAfterTimeEntry(queryClient, {
            projectId: payloadBase.projectId ?? null,
            taskId: payloadBase.taskId ?? null,
          });
          onSaved();
          onClose();
        },
      },
    );
    setSubmitting(false);
  };

  const handleSubmit = () => doSubmit();

  // Quick-Task: create a task in the project's first zone, ASSIGN the
  // current user to it (so /tasks/mine includes it and the dropdown can
  // pre-select it), then immediately log the time entry in one click.
  // Previously this was a two-step flow (Create task → Save time entry)
  // where the new task didn't show up in the dropdown because the user
  // wasn't an assignee, leaving the user stuck on "— Select task —" and
  // accidentally submitting with no task at all.
  const handleCreateQuickTaskAndLog = async () => {
    if (!quickTaskName.trim() || !projectId) return;
    if (totalMinutes <= 0) { notify.warning('End time must be after start time'); return; }

    setSubmitting(true);
    try {
      // 1. Resolve a zone to attach the task to — the project's first.
      const planRes = await client.get(`/projects/${projectId}/planning-data`);
      const pd = planRes.data?.data ?? planRes.data;
      const zones = pd?.zones ?? [];
      const firstZoneId = zones[0]?.id;
      if (!firstZoneId) {
        notify.warning('Project has no zones — create one first');
        return;
      }

      // 2. Create the task.
      const taskRes = await client.post('/tasks', {
        zoneId: firstZoneId,
        code: `QT-${Date.now().toString(36).toUpperCase()}`,
        name: quickTaskName.trim(),
      });
      const newTask = taskRes.data?.data ?? taskRes.data;
      if (!newTask?.id) {
        notify.warning('Task could not be created');
        return;
      }

      // 3. Assign current user — non-fatal if it fails (the task still
      //    exists; the user can re-assign manually). Without this, the
      //    user can't see the task in /tasks/mine later.
      if (currentUserId) {
        try {
          await client.post(`/tasks/${newTask.id}/assignees`, { userId: currentUserId });
        } catch { /* non-fatal */ }
      }

      // 4. Optimistically inject the new task into the local /tasks/mine
      //    cache so the dropdown finds the option NOW (the invalidate
      //    below schedules a refetch but it won't have landed yet).
      queryClient.setQueryData<any[]>(['tasks', 'mine'], (prev) => {
        const list = Array.isArray(prev) ? prev : [];
        if (list.some((t) => t?.id === newTask.id)) return list;
        return [
          ...list,
          { ...newTask, projectId: Number(projectId) },
        ];
      });
      setTaskId(String(newTask.id));
      setTaskStatus(newTask.status || 'in_progress');
      setShowQuickTask(false);
      setQuickTaskName('');
      // Refresh /tasks/mine so the new task shows in the dropdown; the
      // full time-entry invalidation runs inside doSubmit below.
      queryClient.invalidateQueries({ queryKey: ['tasks'] });

      // 5. Log the time entry immediately, passing the new task id
      //    directly (don't rely on the setTaskId above having landed).
      await doSubmit(String(newTask.id));
    } catch (err: any) {
      notify.apiError(err, 'Failed to create task');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-lg rounded-[14px] bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 px-5 py-4">
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Add Timesheet Entry</h3>
            <p className="text-[11px] text-slate-400 dark:text-slate-500">{new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          </div>
          <div className="flex items-center gap-1">
            {/* Location toggle */}
            <button onClick={() => setLocation('home')} className={cn('flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-semibold', location === 'home' ? 'bg-blue-100 text-blue-700' : 'text-slate-400 dark:text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50')}>
              <Home className="h-3.5 w-3.5" /> Home
            </button>
            <button onClick={() => setLocation('office')} className={cn('flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-semibold', location === 'office' ? 'bg-blue-100 text-blue-700' : 'text-slate-400 dark:text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50')}>
              <Building2 className="h-3.5 w-3.5" /> Office
            </button>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {/* Project selector */}
          <div>
            <label className="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1 block">Project</label>
            <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setTaskId(''); }}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
              <option value="">— Select project —</option>
              {projects.map((p: any) => <option key={p.id} value={p.id}>{p.number ? `${p.number} - ` : ''}{p.name}</option>)}
            </select>
          </div>

          {/* Task selector + Quick Task */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[12px] font-semibold text-slate-600 dark:text-slate-300">Task</label>
              <div className="flex items-center gap-2">
                {/* Edit the currently selected task — opens the task drawer
                    so users can rename / set due date / assignees on a Quick
                    Task they just created (or any task already selected). */}
                {taskId && (
                  <button
                    type="button"
                    onClick={() => setEditingTaskId(Number(taskId))}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400 hover:text-blue-700"
                    title="Edit selected task"
                  >
                    <Pencil className="h-3 w-3" />
                    Edit
                  </button>
                )}
                {projectId && (
                  <button type="button" onClick={() => setShowQuickTask(!showQuickTask)}
                    className="text-[11px] font-semibold text-blue-600 hover:text-blue-700">
                    + Quick Task
                  </button>
                )}
              </div>
            </div>
            {showQuickTask ? (
              <div className="flex gap-2">
                <input type="text" value={quickTaskName} onChange={(e) => setQuickTaskName(e.target.value)}
                  placeholder="New task name..." autoFocus
                  className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                {/* One-click flow: creates the task, assigns it to the
                    current user, sets it as the selected task, and saves
                    the time entry — all in one go. Replaces the previous
                    two-step path where the new task wasn't selectable
                    afterwards because /tasks/mine didn't include it,
                    leading to users submitting "no task" by accident. */}
                <button type="button" onClick={handleCreateQuickTaskAndLog} disabled={!quickTaskName.trim() || submitting}
                  className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                  {submitting ? 'Saving…' : 'Create task & log time'}
                </button>
                <button type="button" onClick={() => setShowQuickTask(false)}
                  className="text-sm text-slate-400 dark:text-slate-500 px-2">Cancel</button>
              </div>
            ) : (
              <select value={taskId} onChange={(e) => { setTaskId(e.target.value); const t = filteredTasks.find((tk: any) => String(tk.id) === e.target.value); if (t) setTaskStatus(t.status || 'in_progress'); }}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                <option value="">— Select task —</option>
                {filteredTasks.map((t: any) => {
                  // Suffix the option label with a context hint so the user
                  // can tell what bucket the task lives in. Priority:
                  //   1. zone name (zoned task)
                  //   2. phase / serviceType name (root task with a phase)
                  //   3. "Project Root" (zoneId=null, no phase either)
                  // Without this fallback, root tasks rendered as just
                  // "code - name" and were hard to distinguish.
                  const suffix = t.zone?.name
                    ? ` (${t.zone.name})`
                    : t.phase?.name
                      ? ` · ${t.phase.name}`
                      : t.serviceType?.name
                        ? ` · ${t.serviceType.name}`
                        : ' · Project Root';
                  return (
                    <option key={t.id} value={t.id}>
                      {t.code ? `${t.code} - ` : ''}{t.name}{suffix}
                    </option>
                  );
                })}
              </select>
            )}
          </div>

          {/* Time range */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1 block">Start Time</label>
              <select value={start} onChange={(e) => setStart(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
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
              <label className="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1 block">End Time</label>
              <select value={end} onChange={(e) => setEnd(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
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
              <label className="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1 block">Total Hours</label>
              <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                {totalHours}h
              </div>
            </div>
          </div>

          {/* Task Status (Kanban stages) */}
          {taskId && (
            <div>
              <label className="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1 block">Task Status</label>
              <div className="flex items-center gap-1">
                {KANBAN_STATUSES.map((s) => (
                  <button key={s.value} type="button" onClick={() => setTaskStatus(s.value)}
                    className={cn('rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors',
                      taskStatus === s.value ? `${s.bg} ${s.text} ring-2 ring-offset-1 ring-blue-400` : 'bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800')}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Billable toggle hidden per user feedback 2026-06-22 — state
              stays wired so the API call keeps defaulting to true. */}

          <div>
            <label className="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1 block">Description</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
              placeholder="What did you work on?"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none resize-none" />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 dark:border-slate-700 px-5 py-4">
          <button onClick={onClose} className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={submitting || totalMinutes <= 0}
            className="rounded-lg bg-blue-600 px-5 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {submitting ? 'Saving…' : 'Save time entry'}
          </button>
        </div>
      </div>
      {/* Save-anyway dialog for cross-task time overlaps. Renders only
          when overlap.withConfirm caught a CROSS_TASK_OVERLAP from the
          backend; otherwise it's null. */}
      {overlap.dialog}

      {/* Task drawer for editing the selected task — opened by the pencil
          icon next to the Task selector. Reuses the standard TaskDrawer so
          edits propagate everywhere through React Query invalidation. */}
      {editingTaskId !== null && (
        <TaskDrawer taskId={editingTaskId} onClose={closeEditing} />
      )}
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
    : 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200';

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
  const confirm = useConfirm();
  const [weekOffset, setWeekOffset] = useState(0);
  const [showEntryForm, setShowEntryForm] = useState<{ date: string; startTime: string; endTime: string } | null>(null);
  // Drag-select state. `anchor` is the hour the pointer went down on;
  // `pointer` follows the pointer (mouse OR touch) and can be BELOW
  // `anchor` — supports upward drag by normalising min/max on commit.
  const [selection, setSelection] = useState<{ dayIdx: number; anchor: number; pointer: number } | null>(null);
  // Ref to the scrollable grid — used by touch handlers to translate a
  // Touch clientX/clientY back to a specific (dayIdx, hour) cell via
  // document.elementFromPoint (a touch that starts on one cell may move
  // off it, so the initial target isn't sufficient).
  const gridRef = useRef<HTMLDivElement | null>(null);
  // Delete-entry mutation: toasts + 'time' query invalidation are wired
  // inside the hook (see useDeleteTimeEntry in @/hooks/use-time).
  const deleteEntry = useDeleteTimeEntry();
  const handleDeleteEntry = async (e: React.MouseEvent, entry: { id: number; startTime?: string; endTime?: string; minutes?: number; project?: { name?: string }; task?: { name?: string } }) => {
    e.stopPropagation();
    const label = `${entry.startTime ?? ''}–${entry.endTime ?? ''} · ${entry.project?.name ?? 'no project'}${entry.task?.name ? ' / ' + entry.task.name : ''}`;
    if (await confirm(`Delete this time entry?\n\n${label}`)) {
      deleteEntry.mutate(entry.id);
    }
  };

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
  const { data: breakdownRaw, error: weeklyError } = useWeeklyGrid({ weekStart: weekStartStr });

  // Normalize data - handle both wrapped and unwrapped API responses
  const breakdownData = useMemo(() => {
    const raw = breakdownRaw as any;
    if (!raw) return null;
    // If the response is already the grid structure
    if (raw.rows) return raw;
    // If it was double-wrapped: { data: { rows: ... } }
    if (raw.data?.rows) return raw.data;
    // If it came as { success, data: { rows } }
    if (raw.success && raw.data?.rows) return raw.data;
    return raw;
  }, [breakdownRaw]);

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

  // ─── Untimed vs timed split ────────────────────────────────────────
  // Untimed entries (no startTime) were previously all dumped onto the
  // 09:00 cell with absolute positioning that stacked them on top of
  // each other. Extract them here so we can render them in a dedicated
  // all-day row (side-by-side per day) instead — no data ever hidden.
  const { timedByDay, untimedByDay } = useMemo(() => {
    const timed = new Map<string, any[]>();
    const untimed = new Map<string, any[]>();
    for (const [date, entries] of entriesByDay.entries()) {
      const t: any[] = [];
      const u: any[] = [];
      for (const e of entries) {
        if (e.startTime) t.push(e);
        else u.push(e);
      }
      if (t.length) timed.set(date, t);
      if (u.length) untimed.set(date, u);
    }
    return { timedByDay: timed, untimedByDay: untimed };
  }, [entriesByDay]);

  // ─── Dynamic HOURS axis ────────────────────────────────────────────
  // Base band is DEFAULT_MIN..=DEFAULT_MAX (07:00–19:00). Expand both
  // ends so any entry that starts BEFORE the min or ends AFTER the max
  // gets a real row. Previously a 06:00 or 21:00 entry was silently
  // dropped from the grid (survived only in the list below).
  const HOURS = useMemo(() => {
    let min = DEFAULT_MIN_HOUR;
    let max = DEFAULT_MAX_HOUR;
    for (const entries of timedByDay.values()) {
      for (const e of entries) {
        const startH = e.startTime ? parseInt(e.startTime.split(':')[0], 10) : NaN;
        // The row an entry OCCUPIES is [startH, ceil(endMins/60)-1]. Use
        // ceil so a 21:00–21:30 entry pushes max to 21 (row 21 exists)
        // and a 21:00–22:00 entry pushes max to 21 too — anything larger
        // is only rendered as extra pixel height on the 21:00 row.
        if (!Number.isNaN(startH)) min = Math.min(min, startH);
        const endMins = e.endTime
          ? timeToMinutes(e.endTime)
          : (e.startTime ? timeToMinutes(e.startTime) : 0) + (e.minutes ?? 0);
        // Last row the visual block occupies. Row H covers [H*60, H*60+60).
        // For a 21:00–22:00 entry endMins=1320 → ceil(1320/60)-1 = 21.
        // For a 21:00–22:30 entry endMins=1350 → ceil(1350/60)-1 = 22.
        const lastHour = Math.max(startH, Math.ceil(endMins / 60) - 1);
        if (Number.isFinite(lastHour)) max = Math.max(max, lastHour);
      }
    }
    // Guard rails — clamp to 0..23 so a corrupt entry can't blow up the axis.
    min = Math.max(0, Math.min(min, DEFAULT_MIN_HOUR));
    max = Math.min(23, Math.max(max, DEFAULT_MAX_HOUR));
    return Array.from({ length: max - min + 1 }, (_, i) => i + min);
  }, [timedByDay]);

  // Selection commit — normalises anchor/pointer so upward drag works.
  const commitSelection = useCallback(() => {
    if (!selection) return;
    const { dayIdx, anchor, pointer } = selection;
    const lo = Math.min(anchor, pointer);
    const hi = Math.max(anchor, pointer) + 1;
    const date = format(weekDays[dayIdx], 'yyyy-MM-dd');
    const startTime = `${String(lo).padStart(2, '0')}:00`;
    const endTime = `${String(hi).padStart(2, '0')}:00`;
    setShowEntryForm({ date, startTime, endTime });
    setSelection(null);
  }, [selection, weekDays]);

  // ─── Mouse handlers ────────────────────────────────────────────────
  const handleMouseDown = (dayIdx: number, hour: number) => {
    setSelection({ dayIdx, anchor: hour, pointer: hour });
  };

  const handleMouseMove = (hour: number) => {
    setSelection((s) => (s ? { ...s, pointer: hour } : s));
  };

  const handleMouseUp = () => {
    commitSelection();
  };

  // ─── Touch handlers ────────────────────────────────────────────────
  // Touch events need a document.elementFromPoint lookup: the touch that
  // started on cell A can move over cell B while the event target stays
  // on A. We stamp each cell with data-day-idx / data-hour so we can
  // recover (dayIdx, hour) from any touched element inside the grid.
  const cellFromPoint = useCallback((x: number, y: number): { dayIdx: number; hour: number } | null => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    // The child block sits inside the td — walk up until we find the td
    // that carries the data attrs. Stop at the grid root.
    const cell = (el as HTMLElement).closest?.('[data-day-idx][data-hour]');
    if (!cell) return null;
    const dayIdx = Number(cell.getAttribute('data-day-idx'));
    const hour = Number(cell.getAttribute('data-hour'));
    if (Number.isNaN(dayIdx) || Number.isNaN(hour)) return null;
    return { dayIdx, hour };
  }, []);

  const handleTouchStart = (e: React.TouchEvent, dayIdx: number, hour: number) => {
    // Prevent the browser from also firing synthetic mouse events (which
    // would double-start the selection) and from scrolling the grid.
    e.preventDefault();
    setSelection({ dayIdx, anchor: hour, pointer: hour });
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!selection) return;
    e.preventDefault();
    const t = e.touches[0];
    if (!t) return;
    const at = cellFromPoint(t.clientX, t.clientY);
    if (!at || at.dayIdx !== selection.dayIdx) return;
    setSelection((s) => (s ? { ...s, pointer: at.hour } : s));
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!selection) return;
    e.preventDefault();
    commitSelection();
  };

  // Document-level mouseup catches the release even if the pointer leaves
  // the grid — replaces the old onMouseLeave-clears behaviour that was
  // destroying in-progress selections when the mouse briefly left the box.
  useEffect(() => {
    if (!selection) return;
    const up = () => commitSelection();
    document.addEventListener('mouseup', up);
    return () => document.removeEventListener('mouseup', up);
  }, [selection, commitSelection]);

  // TimeEntryFormPopup already runs the shared invalidator on save; this
  // callback is a legacy no-op kept for backwards compat with the
  // {onSaved} prop shape. Extra invalidations here would double-fetch.
  const invalidate = () => {};

  return (
    <div className="space-y-4">
      {/* Quick actions */}
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={() => clockStatus?.isClockedIn ? clockOut.mutate(undefined) : clockIn.mutate(undefined)}
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
      <div className="flex items-center justify-between rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-5 py-3">
        <button onClick={() => setWeekOffset((o) => o - 1)} className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"><ChevronLeft className="h-5 w-5" /></button>
        <div className="text-center">
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{format(weekDays[0], 'MMM d')} — {format(weekDays[6], 'MMM d, yyyy')}</p>
          <p className="text-[11px] text-slate-400 dark:text-slate-500">
            Week total: <span className="font-semibold text-slate-700 dark:text-slate-200">{minutesToDisplay(weekTotal)}</span>
            {' · '}<span className="font-semibold text-slate-600 dark:text-slate-300">{weekWorkingDays}</span> working days
            {weekOffset === 0 && ' · This week'}
          </p>
        </div>
        <button onClick={() => setWeekOffset((o) => o + 1)} disabled={weekOffset >= 0} className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"><ChevronRight className="h-5 w-5" /></button>
      </div>

      {/* API error indicator */}
      {weeklyError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-[12px] text-red-700">
          Failed to load timesheet data: {(weeklyError as any)?.message ?? 'Unknown error'}
        </div>
      )}

      {/* Calendar Grid */}
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
        {/* Day headers */}
        <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
          <div className="px-2 py-3 text-[10px] font-semibold text-slate-400 dark:text-slate-500" />
          {weekDays.map((day, i) => {
            const dateKey = format(day, 'yyyy-MM-dd');
            const isToday = dateKey === todayKey;
            const isWeekend = day.getDay() === 5 || day.getDay() === 6;
            const isHoliday = holidayDates.has(dateKey);
            const holidayName = isHoliday ? calendarDays.find((h: any) => (typeof h.date === 'string' ? h.date.split('T')[0] : new Date(h.date).toISOString().split('T')[0]) === dateKey)?.name : null;
            const total = dailyTotals[dateKey] ?? 0;
            return (
              <div key={i} className={cn('px-2 py-3 text-center border-l border-slate-200 dark:border-slate-700', isWeekend && 'bg-slate-100/50 dark:bg-slate-800/50', isHoliday && 'bg-red-50/50')}>
                <p className={cn('text-[11px] font-semibold', isToday ? 'text-blue-600' : 'text-slate-500 dark:text-slate-400')}>
                  {format(day, 'EEE')}
                </p>
                <p className={cn('text-[13px] font-bold', isToday ? 'text-blue-600' : 'text-slate-700 dark:text-slate-200')}>
                  {isToday ? (
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-white">{day.getDate()}</span>
                  ) : day.getDate()}
                </p>
                {total > 0 && (
                  <p className="text-[10px] font-medium text-slate-400 dark:text-slate-500 mt-0.5">{minutesToDisplay(total)}</p>
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
        <div
          ref={gridRef}
          className="overflow-y-auto"
          style={{ maxHeight: '600px' }}
          onMouseUp={handleMouseUp}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
        >
          {/* All-day row — untimed entries per day, side-by-side.
              Prevents the previous 09:00-stacking bug where multiple
              untimed entries were absolute-positioned on top of each
              other and only the topmost was visible. */}
          {untimedByDay.size > 0 && (
            <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-slate-100 dark:border-slate-800 bg-amber-50/40 dark:bg-amber-900/10">
              <div className="px-2 py-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400 text-right pr-2 align-top">
                All-day
              </div>
              {weekDays.map((day, dayIdx) => {
                const dateKey = format(day, 'yyyy-MM-dd');
                const untimed = untimedByDay.get(dateKey) ?? [];
                if (untimed.length === 0) return <div key={dayIdx} className="border-l border-slate-100 dark:border-slate-800 min-h-[36px]" />;
                return (
                  <div key={dayIdx} className="border-l border-slate-100 dark:border-slate-800 p-1 min-h-[36px]">
                    <div className="flex flex-wrap gap-1">
                      {untimed.map((entry: any) => {
                        const projectName = entry.project?.name ?? '';
                        const taskName = entry.task?.name ?? '';
                        return (
                          <div
                            key={entry.id}
                            className="group relative rounded-md bg-amber-500/90 hover:bg-amber-600 text-white px-1.5 py-0.5 text-[10px] flex-1 min-w-[80px] max-w-full overflow-hidden shadow-sm cursor-pointer"
                            title={`Untimed · ${minutesToDisplay(entry.minutes ?? 0)}\n${projectName}\n${taskName}`}
                          >
                            <button
                              type="button"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => handleDeleteEntry(e, entry)}
                              disabled={deleteEntry.isPending}
                              className="absolute top-0 right-0 rounded p-0.5 text-white/80 hover:text-white hover:bg-amber-700/40 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity disabled:opacity-50"
                              title="Delete this time entry"
                              aria-label="Delete untimed entry"
                            >
                              <Trash2 className="h-2.5 w-2.5" aria-hidden="true" />
                            </button>
                            <p className="font-semibold truncate">{minutesToDisplay(entry.minutes ?? 0)}</p>
                            <p className="truncate opacity-90">{projectName || 'No project'}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <table className="w-full" style={{ tableLayout: 'fixed', borderCollapse: 'collapse' }}>
            <colgroup>
              <col style={{ width: '60px' }} />
              {weekDays.map((_, i) => <col key={i} />)}
            </colgroup>
            <tbody>
              {HOURS.map((hour) => (
                <tr key={hour}>
                  <td className="border-b border-r border-slate-100 dark:border-slate-800 text-[10px] text-slate-400 dark:text-slate-500 text-right pr-2 pt-1 align-top"
                    style={{ height: `${HOUR_HEIGHT}px` }}>
                    {String(hour).padStart(2, '0')}:00
                  </td>
                  {weekDays.map((day, dayIdx) => {
                    const isWeekend = day.getDay() === 5 || day.getDay() === 6;
                    // Highlight EVERY row between anchor and pointer,
                    // inclusive — works whether the user drags up OR down.
                    const isSelecting =
                      selection?.dayIdx === dayIdx
                      && hour >= Math.min(selection.anchor, selection.pointer)
                      && hour <= Math.max(selection.anchor, selection.pointer);
                    const dateKey = format(day, 'yyyy-MM-dd');
                    const dayIsHoliday = holidayDates.has(dateKey);
                    const isNonWorking = isWeekend || dayIsHoliday;
                    // Only timed entries live in the hourly grid — untimed
                    // ones are rendered in the all-day row above.
                    const entries = timedByDay.get(dateKey) ?? [];

                    // Find entries that START in this hour
                    const hourEntries = entries.filter((e: any) => {
                      const startH = parseInt(e.startTime.split(':')[0], 10);
                      return startH === hour;
                    });

                    return (
                      <td key={dayIdx}
                        data-day-idx={dayIdx}
                        data-hour={hour}
                        className={cn('border-b border-l border-slate-100 dark:border-slate-800 cursor-crosshair hover:bg-blue-50/20 relative p-0',
                          isNonWorking && 'bg-slate-200/40 dark:bg-slate-700/40',
                          isSelecting && 'bg-blue-100/50 dark:bg-blue-900/30')}
                        // touch-action: none on the cell only — the outer
                        // scroll wrapper can still scroll normally (via the
                        // header column / gaps), but a touch that STARTS on
                        // a cell is a drag-select, not a page scroll.
                        style={{ height: `${HOUR_HEIGHT}px`, touchAction: 'none' }}
                        onMouseDown={() => handleMouseDown(dayIdx, hour)}
                        onMouseMove={() => handleMouseMove(hour)}
                        onTouchStart={(e) => handleTouchStart(e, dayIdx, hour)}>
                        {/* Entries that start in this hour cell */}
                        {hourEntries.map((entry: any) => {
                          const startMins = timeToMinutes(entry.startTime);
                          const endMins = entry.endTime ? timeToMinutes(entry.endTime) : startMins + (entry.minutes ?? 60);
                          const offsetInCell = ((startMins % 60) / 60) * HOUR_HEIGHT;
                          const durationHours = (endMins - startMins) / 60;
                          const blockHeight = Math.max(durationHours * HOUR_HEIGHT, 36);
                          const projectName = entry.project?.name ?? '';
                          const taskName = entry.task?.name ?? '';
                          const timeLabel = `${entry.startTime ?? '?'} – ${entry.endTime ?? '?'}`;
                          return (
                            <div key={entry.id}
                              className="group absolute left-0.5 right-0.5 rounded-md bg-blue-600 text-white px-2 py-1 overflow-hidden z-10 cursor-pointer hover:bg-blue-700 shadow-sm"
                              style={{ top: `${offsetInCell}px`, height: `${blockHeight}px` }}
                              title={`${timeLabel}\n${projectName}\n${taskName}\n${durationHours.toFixed(2)} hrs`}>
                              {/* Delete affordance — hover-reveals top-right; click prompts
                                  confirm + invalidates the time query. Stops the parent
                                  mousedown from starting a fresh cell-drag selection. */}
                              <button
                                type="button"
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => handleDeleteEntry(e, entry)}
                                disabled={deleteEntry.isPending}
                                className="absolute top-0.5 right-0.5 rounded p-0.5 text-white/70 hover:text-white hover:bg-blue-800/40 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                                title="Delete this time entry"
                                aria-label="Delete time entry"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                              <p className="text-[10px] font-medium opacity-90">{timeLabel}</p>
                              <p className="text-[11px] font-bold truncate">{projectName || 'No project'}</p>
                              {blockHeight > 50 && taskName && <p className="text-[10px] truncate opacity-80">{taskName}</p>}
                              <p className="text-[10px] font-semibold mt-0.5">{durationHours.toFixed(2)} hrs</p>
                            </div>
                          );
                        })}

                        {/* Selection indicator — shows on the TOP row of the
                            selection (min of anchor/pointer) so upward drags
                            get a label at the visual top of the highlight. */}
                        {isSelecting && selection && hour === Math.min(selection.anchor, selection.pointer) && (
                          <div className="absolute inset-0 flex items-start justify-center pt-1 pointer-events-none z-20">
                            <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 rounded px-1">
                              {String(Math.min(selection.anchor, selection.pointer)).padStart(2, '0')}:00-{String(Math.max(selection.anchor, selection.pointer) + 1).padStart(2, '0')}:00
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
          <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
            <h3 className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-2">Entries this week ({allEntries.length})</h3>
            <div className="space-y-1">
              {allEntries.map((e: any) => (
                <div key={e.id} className="group flex items-center gap-3 rounded-md bg-slate-50 dark:bg-slate-800/50 px-3 py-2 text-[12px]">
                  <span className="text-slate-500 dark:text-slate-400 w-20">{e._date}</span>
                  <span className="text-slate-500 dark:text-slate-400 w-16">{e.startTime ?? '-'} - {e.endTime ?? '-'}</span>
                  <span className="font-medium text-slate-700 dark:text-slate-200">{minutesToDisplay(e.minutes)}</span>
                  <span className="text-slate-600 dark:text-slate-300 flex-1 truncate">{e.project?.name ?? ''} {e.task?.name ? `/ ${e.task.name}` : ''}</span>
                  {e.location && <span className="text-[10px] text-slate-400 dark:text-slate-500">{e.location === 'home' ? '🏠' : '🏢'}</span>}
                  {/* Same delete affordance on the list view — hover-revealed
                      so the row stays clean unless the user actively wants
                      to act on it. */}
                  <button
                    type="button"
                    onClick={(ev) => handleDeleteEntry(ev, e)}
                    disabled={deleteEntry.isPending}
                    className="opacity-0 group-hover:opacity-100 transition-opacity rounded p-1 text-slate-400 dark:text-slate-500 hover:text-red-600 hover:bg-red-50 disabled:opacity-30"
                    title="Delete this time entry"
                    aria-label="Delete time entry"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
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
  const firstDow = (() => { const d = new Date(viewYear, viewMonth, 1).getDay() - 1; return d < 0 ? 6 : d; })();
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-5 py-3">
        <button onClick={() => setMonthOffset((o) => o - 1)} className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"><ChevronLeft className="h-5 w-5" /></button>
        <div className="text-center">
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{monthName}</p>
          <p className="text-[11px] text-slate-400 dark:text-slate-500"><span className="font-semibold text-slate-700 dark:text-slate-200">{workingDays.working}</span> working days{workingDays.holidays > 0 && <span> · <span className="text-red-500">{workingDays.holidays} holidays</span></span>}</p>
        </div>
        <button onClick={() => setMonthOffset((o) => o + 1)} className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"><ChevronRight className="h-5 w-5" /></button>
      </div>
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="grid grid-cols-7 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
          {DAY_NAMES.map((d) => (<div key={d} className="px-2 py-2.5 text-center text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase">{d}</div>))}
        </div>
        <div className="grid grid-cols-7">
          {Array.from({ length: firstDow }).map((_, i) => (<div key={`pad-${i}`} className="min-h-[80px] border-b border-r border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-800/30" />))}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const d = i + 1;
            const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const dow = new Date(viewYear, viewMonth, d).getDay();
            const isWeekend = dow === 5 || dow === 6;
            const isHoliday = holidayDates.has(dateStr);
            const isToday = dateStr === format(today, 'yyyy-MM-dd');
            const holiday = calendarDays.find((h: any) => (typeof h.date === 'string' ? h.date.split('T')[0] : new Date(h.date).toISOString().split('T')[0]) === dateStr);
            return (
              <div key={d} className={cn('min-h-[80px] border-b border-r border-slate-100 dark:border-slate-800 p-1.5', isWeekend && 'bg-slate-50/50 dark:bg-slate-800/50', isHoliday && 'bg-red-50/30')}>
                <span className={cn('text-[13px] font-medium', isToday ? 'text-white bg-blue-600 rounded-full w-7 h-7 inline-flex items-center justify-center' : 'text-slate-700 dark:text-slate-200', isWeekend && !isToday && 'text-slate-400 dark:text-slate-500')}>{d}</span>
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
      <div className="flex items-center justify-between rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-5 py-3">
        <button onClick={() => setYearOffset((o) => o - 1)} className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"><ChevronLeft className="h-5 w-5" /></button>
        <div className="text-center">
          <p className="text-lg font-bold text-slate-900 dark:text-slate-100">{viewYear}</p>
          <p className="text-[11px] text-slate-400 dark:text-slate-500"><span className="font-semibold text-slate-700 dark:text-slate-200">{totalWorking}</span> working days · <span className="text-red-500">{totalHolidays} holidays</span></p>
        </div>
        <button onClick={() => setYearOffset((o) => o + 1)} className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"><ChevronRight className="h-5 w-5" /></button>
      </div>
      <div className="grid grid-cols-3 lg:grid-cols-4 gap-3">
        {MONTHS.map((m) => {
          const isCurrent = viewYear === today.getFullYear() && m.index === today.getMonth();
          return (
            <div key={m.index} className={cn('rounded-[14px] border bg-white dark:bg-slate-900 p-4', isCurrent ? 'border-blue-300 ring-2 ring-blue-100' : 'border-slate-200 dark:border-slate-700')}>
              <h3 className={cn('text-sm font-semibold', isCurrent ? 'text-blue-600' : 'text-slate-900 dark:text-slate-100')}>{m.name}</h3>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div><p className="text-lg font-bold text-slate-700 dark:text-slate-200">{m.working}</p><p className="text-[9px] text-slate-400 dark:text-slate-500">Working</p></div>
                <div><p className={cn('text-lg font-bold', m.holidays > 0 ? 'text-red-600' : 'text-slate-300 dark:text-slate-600')}>{m.holidays}</p><p className="text-[9px] text-slate-400 dark:text-slate-500">Holidays</p></div>
                <div><p className="text-lg font-bold text-slate-400 dark:text-slate-500">{m.total}</p><p className="text-[9px] text-slate-400 dark:text-slate-500">Total</p></div>
              </div>
              <div className="mt-2 w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
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
        <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
          {(['day', 'week', 'month', 'year'] as ViewMode[]).map((v) => (
            <button key={v} onClick={() => setViewMode(v)}
              className={cn('px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors capitalize',
                viewMode === v ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}>
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
