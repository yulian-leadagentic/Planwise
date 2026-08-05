import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { notify } from '@/lib/notify';
import { timeApi } from '@/api/time.api';
import { formatShortDate } from '@/lib/task-constants';
import { queryKeys } from '@/lib/query-keys';
import { useOverlapConfirm } from '@/features/time/overlap-confirm';
import { TimeDropdown } from './time-dropdown';

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
export function QuickTimeLog({ taskId, taskProjectId }: { taskId: number; taskProjectId?: number | null }) {
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
      className="mt-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm overflow-hidden"
    >
      {overlap.dialog}
      {/* History header — totals + count, with collapse toggle for the
          panel itself. Neutral palette so it stays readable on top of any
          parent-card border (red/amber for at-risk, white for OK). */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
        <div className="flex items-center gap-1.5 text-[10px] text-slate-600 dark:text-slate-300 min-w-0">
          <Clock className="h-3 w-3 text-slate-400 dark:text-slate-500 shrink-0" />
          <span className="font-semibold">Your time</span>
          {history.length > 0 ? (
            <span className="tabular-nums truncate">
              · {(historyTotalMin / 60).toFixed(2)}h across {history.length}
            </span>
          ) : (
            <span className="text-slate-400 dark:text-slate-500 italic">no entries yet</span>
          )}
        </div>
        <button
          onClick={() => setOpen(false)}
          className="text-[12px] leading-none text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 shrink-0 px-1"
          aria-label="Close time log panel"
        >
          ×
        </button>
      </div>

      {/* Past entries (capped to 5 inline; deeper history lives on the
          task drawer's Time tab via "open task for full history"). */}
      {history.length > 0 && (
        <div className="max-h-28 overflow-y-auto border-b border-slate-100 dark:border-slate-800 divide-y divide-slate-50 dark:divide-slate-800">
          {history.slice(0, 5).map((e: any) => (
            <div key={e.id} className="flex items-center gap-2 px-2 py-1 text-[10px]">
              <span className="text-slate-500 dark:text-slate-400 tabular-nums w-[52px] shrink-0">
                {e.date ? formatShortDate(e.date) : '—'}
              </span>
              <span className="text-slate-400 dark:text-slate-500 tabular-nums w-[78px] shrink-0">
                {e.startTime && e.endTime ? `${e.startTime}–${e.endTime}` : ''}
              </span>
              <span className="font-semibold text-slate-700 dark:text-slate-200 tabular-nums w-[36px] shrink-0">
                {((e.minutes ?? 0) / 60).toFixed(2)}h
              </span>
              {e.note && (
                <span className="text-slate-500 dark:text-slate-400 truncate flex-1" title={e.note}>{e.note}</span>
              )}
            </div>
          ))}
          {history.length > 5 && (
            <div className="px-2 py-1 text-[10px] text-slate-400 dark:text-slate-500 text-center">
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
          <label className="text-[10px] font-semibold text-slate-600 dark:text-slate-300 mb-1 block">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="w-full px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-[12px] focus:border-blue-400 focus:outline-none" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[10px] font-semibold text-slate-600 dark:text-slate-300 mb-1 block">Start Time</label>
            <TimeDropdown value={start} onChange={setStart} />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-slate-600 dark:text-slate-300 mb-1 block">End Time</label>
            <TimeDropdown value={end} onChange={setEnd} />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-slate-600 dark:text-slate-300 mb-1 block">Total Hours</label>
            <div className="w-full px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 text-[12px] text-slate-600 dark:text-slate-300 tabular-nums">
              {totalHours}h
            </div>
          </div>
        </div>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Description (optional)…"
          className="w-full px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-[12px] focus:border-blue-400 focus:outline-none" />
        <div className="flex justify-end gap-1.5 pt-1">
          <button onClick={() => setOpen(false)} className="rounded-md border border-slate-200 dark:border-slate-700 px-3 py-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50">
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
