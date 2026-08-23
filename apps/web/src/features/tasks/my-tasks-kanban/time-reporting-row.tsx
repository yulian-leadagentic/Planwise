import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Play, Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { timeApi } from '@/api/time.api';
import { formatShortDate } from '@/lib/task-constants';
import { queryKeys } from '@/lib/query-keys';
import { useOverlapConfirm } from '@/features/time/overlap-confirm';
import { invalidateAfterTimeEntry } from '@/features/time/invalidate-after-time-entry';
import { TimeDropdown } from './time-dropdown';
import { RowStatusSelect } from './row-status-select';

// ─── Time Reporting Tab ────────────────────────────────────────────────────

export function TimeReportingRow({ task, onOpenDrawer }: { task: any; onOpenDrawer: (id: number) => void }) {
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
          // Shared invalidator: covers project rollups
          // (/progress /feasibility /projects/:id) that the per-task
          // narrow invalidation used to miss.
          invalidateAfterTimeEntry(queryClient, {
            projectId: task.projectId ?? null,
            taskId: task.id,
          });
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
    <div className="border-b border-slate-100 dark:border-slate-800 last:border-b-0">
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
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-[9px] font-bold ring-2 ring-white -ml-1 shadow-sm">
                    +{task.assignees.length - 4}
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => onOpenDrawer(task.id)}
            className="block w-full text-left cursor-pointer rounded hover:bg-slate-50 dark:hover:bg-slate-800/50 -mx-1 px-1 py-0.5 mt-0.5"
            title="Open task details"
          >
            <p className="text-[13px] font-medium text-slate-800 dark:text-slate-100 truncate">{task.name}</p>
            {/* Context line: zone if present, else "Project Root" + phase so
                the row isn't silently bucket-less. Same convention as the
                kanban card and the timesheet picker. */}
            {zoneName ? (
              <p className="text-[10px] text-slate-500 dark:text-slate-400 truncate">{zoneName}</p>
            ) : (
              <p className="text-[10px] text-slate-400 dark:text-slate-500 italic truncate">
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
                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700';
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
            <span className="text-[11px] text-slate-300 dark:text-slate-600">—</span>
          )}
        </div>

        {/* Date */}
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="w-[130px] rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1.5 text-[12px] focus:border-blue-400 focus:outline-none shrink-0" />

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
          <div className="px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 text-[12px] text-center tabular-nums text-slate-600 dark:text-slate-300">
            {totalHours}h
          </div>
        </div>

        {/* Expand toggle — opens a panel with the user's prior entries on
            this task plus a note field for the new entry. Renamed from
            "+ Note" since the panel now does more than just notes. */}
        <button onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 shrink-0 w-14 text-center">
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
        <div className="px-4 pb-3 pl-8 bg-slate-50/60 dark:bg-slate-800/60 border-t border-slate-100 dark:border-slate-800 space-y-2 pt-2">
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="What did you work on? (optional)"
            className="w-full rounded-md border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-[12px] focus:border-blue-400 focus:outline-none" />

          {/* History list — same column convention as the QuickTimeLog
              panel on the kanban card for consistency. */}
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 mb-1 px-0.5">
              <span className="font-semibold uppercase tracking-wider">Your reporting on this task</span>
              {history.length > 0 ? (
                <span className="tabular-nums">
                  {(historyTotalMin / 60).toFixed(2)}h · {history.length}{' '}
                  {history.length === 1 ? 'entry' : 'entries'}
                </span>
              ) : null}
            </div>
            {history.length === 0 ? (
              <p className="text-[11px] text-slate-400 dark:text-slate-500 italic px-0.5">No entries yet — log your first above.</p>
            ) : (
              <div className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 divide-y divide-slate-100 dark:divide-slate-800 max-h-40 overflow-y-auto">
                {history.slice(0, 10).map((e: any) => (
                  <div key={e.id} className="flex items-center gap-3 px-3 py-1.5 text-[11px]">
                    <span className="text-slate-600 dark:text-slate-300 tabular-nums w-[60px] shrink-0">
                      {e.date ? formatShortDate(e.date) : '—'}
                    </span>
                    <span className="text-slate-400 dark:text-slate-500 tabular-nums w-[90px] shrink-0">
                      {e.startTime && e.endTime ? `${e.startTime}–${e.endTime}` : ''}
                    </span>
                    <span className="font-semibold text-slate-700 dark:text-slate-200 tabular-nums w-[42px] shrink-0">
                      {((e.minutes ?? 0) / 60).toFixed(2)}h
                    </span>
                    {e.note && (
                      <span className="text-slate-500 dark:text-slate-400 truncate flex-1" title={e.note}>{e.note}</span>
                    )}
                  </div>
                ))}
                {history.length > 10 && (
                  <div className="px-3 py-1.5 text-[10px] text-slate-400 dark:text-slate-500 text-center">
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
