import { useState } from 'react';
import { Clock } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { timeApi } from '@/api/time.api';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useOverlapConfirm } from './overlap-confirm';
import { invalidateAfterTimeEntry } from './invalidate-after-time-entry';

interface TimeEntryFormProps {
  taskId: number;
  projectId?: number | null;
  /** Compact variant used on kanban cards (smaller text, tight spacing). */
  variant?: 'compact' | 'full';
  /** Optional success callback — e.g., to close a modal after logging. */
  onLogged?: () => void;
  /** Initial form values. */
  initialDate?: string;
  initialStart?: string;
  initialEnd?: string;
}

/**
 * Shared time-logging form. Previously duplicated across task-drawer,
 * my-tasks-kanban (QuickTimeLog), and the drag-to-Done modal with
 * inconsistent fields (hours only vs. start/end, billable default, etc.).
 *
 * Always captures date + startTime + endTime so entries are interoperable
 * with the TimeReportingTab layout.
 */
export function TimeEntryForm({
  taskId,
  projectId,
  variant = 'full',
  onLogged,
  initialDate,
  initialStart = '09:00',
  initialEnd = '10:00',
}: TimeEntryFormProps) {
  const today = new Date().toISOString().split('T')[0];
  const [date, setDate] = useState(initialDate ?? today);
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [note, setNote] = useState('');
  const queryClient = useQueryClient();

  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const totalMinutes = Math.max(0, (eh * 60 + em) - (sh * 60 + sm));
  const totalHours = (totalMinutes / 60).toFixed(2);

  const overlap = useOverlapConfirm();
  const [submitting, setSubmitting] = useState(false);

  // Wrapped save: tries with confirmOverlap=false first; if the backend
  // returns CROSS_TASK_OVERLAP, the hook shows the confirm dialog and
  // retries with confirmOverlap=true on user approval. Same-task overlap
  // is a hard error and falls through to notify.apiError.
  const handleLog = () => {
    if (totalMinutes <= 0) return;
    setSubmitting(true);
    overlap.withConfirm(
      (confirmOverlap) =>
        timeApi.createEntry({
          taskId,
          projectId: projectId ?? undefined,
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
          // Shared invalidator — covers time / tasks / progress /
          // feasibility / planning / execution-board / project detail,
          // scoped to this project + task. Fixes PR-004/005/006: before,
          // this form invalidated only ['time'] + ['tasks', 'mine'] +
          // ['tasks', taskId] + ['execution-board'], so the project
          // screen's Hours / Actual ₪ / % stayed stale after logging.
          invalidateAfterTimeEntry(queryClient, { projectId: projectId ?? null, taskId });
          notify.success(`Logged ${totalHours}h`, { code: 'TIME-LOG-200' });
          setNote('');
          onLogged?.();
        },
      },
    ).finally(() => setSubmitting(false));
  };

  const compact = variant === 'compact';
  const inputCls = compact
    ? 'rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1 text-[11px] focus:border-blue-400 focus:outline-none bg-white dark:bg-slate-900'
    : 'rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none bg-white dark:bg-slate-900';

  const canSubmit = totalMinutes > 0 && !submitting;

  // 15-minute slot catalog 06:00–22:00 — same as Add Timesheet Entry
  // modal + the my-tasks QuickTimeLog. Inline here to avoid pulling in
  // a new shared module just for one helper used in 3 places.
  const TIME_SLOTS: string[] = [];
  for (let h = 6; h <= 22; h++) {
    for (const m of [0, 15, 30, 45]) {
      TIME_SLOTS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  const renderTimeSelect = (val: string, onChange: (v: string) => void, label: string) => (
    <select
      value={val}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className={cn(inputCls, 'w-full appearance-auto')}
    >
      {!TIME_SLOTS.includes(val) && val && <option value={val}>{val}</option>}
      {TIME_SLOTS.map((t) => (
        <option key={t} value={t}>{t}</option>
      ))}
    </select>
  );

  // W1 — unify the drawer time form with Add Timesheet Entry. Three
  // labeled columns (Start Time / End Time / Total Hours) + dropdowns
  // + grey total readout. Same visual treatment everywhere.
  return (
    <div
      className={cn(compact ? 'space-y-1.5' : 'space-y-3', 'rounded-md border border-slate-200 dark:border-slate-700 bg-blue-50/30 p-3')}
      onClick={(e) => e.stopPropagation()}
    >
      {overlap.dialog}

      <div>
        <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider block mb-1">Date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date"
          className={cn(inputCls, 'w-full')} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider block mb-1">Start Time</label>
          {renderTimeSelect(start, setStart, 'Start time')}
        </div>
        <div>
          <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider block mb-1">End Time</label>
          {renderTimeSelect(end, setEnd, 'End time')}
        </div>
        <div>
          <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider block mb-1">Total Hours</label>
          <div className={cn(inputCls, 'w-full text-center tabular-nums bg-slate-50 dark:bg-slate-800/50 text-blue-600 font-semibold')}>
            {totalHours}h
          </div>
        </div>
      </div>

      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)…"
        aria-label="Note"
        className={cn(inputCls, 'w-full')}
      />

      <div className="flex justify-end">
        <button
          onClick={() => { if (canSubmit) handleLog(); }}
          disabled={!canSubmit}
          className={cn(
            'rounded-md bg-blue-600 font-semibold text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5',
            compact ? 'px-3 py-1 text-[11px]' : 'px-4 py-2 text-sm',
          )}
        >
          {submitting ? <Clock className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
          {submitting ? 'Saving…' : 'Log'}
        </button>
      </div>
    </div>
  );
}
