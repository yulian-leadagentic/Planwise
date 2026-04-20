import { useState } from 'react';
import { Clock } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { timeApi } from '@/api/time.api';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';

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

  const logTime = useMutation({
    mutationFn: () =>
      timeApi.createEntry({
        taskId,
        projectId: projectId ?? undefined,
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
      queryClient.invalidateQueries({ queryKey: ['tasks', taskId] });
      queryClient.invalidateQueries({ queryKey: ['execution-board'] });
      notify.success(`Logged ${totalHours}h`, { code: 'TIME-LOG-200' });
      setNote('');
      onLogged?.();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to log time'),
  });

  const compact = variant === 'compact';
  const inputCls = compact
    ? 'rounded border border-slate-200 px-1.5 py-1 text-[11px] focus:border-blue-400 focus:outline-none'
    : 'rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none';

  const canSubmit = totalMinutes > 0 && !logTime.isPending;

  return (
    <div
      className={cn(compact ? 'space-y-1.5' : 'space-y-2', 'rounded-md border border-blue-200 bg-blue-50/50 p-2')}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={cn('flex items-center gap-1', compact ? 'text-[10px]' : 'text-xs')}>
        <label className="w-10 font-semibold text-slate-500 uppercase">Date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date"
          className={cn(inputCls, 'flex-1')} />
      </div>

      <div className={cn('flex items-center gap-1', compact ? 'text-[10px]' : 'text-xs')}>
        <label className="w-10 font-semibold text-slate-500 uppercase">Time</label>
        <input type="time" step="300" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start time"
          className={cn(inputCls, compact ? 'w-[78px]' : 'w-[92px]')} />
        <span className="text-slate-400">→</span>
        <input type="time" step="300" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="End time"
          className={cn(inputCls, compact ? 'w-[78px]' : 'w-[92px]')} />
        <span className={cn('ml-auto font-bold text-blue-600 tabular-nums', compact ? 'text-[11px]' : 'text-sm')}>{totalHours}h</span>
      </div>

      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)…"
        aria-label="Note"
        className={cn(inputCls, 'w-full')}
      />

      <div className="flex gap-1.5">
        <button
          onClick={() => { if (canSubmit) logTime.mutate(); }}
          disabled={!canSubmit}
          className={cn(
            'rounded bg-blue-600 font-semibold text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1',
            compact ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1 text-xs',
          )}
        >
          {logTime.isPending ? <Clock className="h-3 w-3 animate-spin" /> : <Clock className="h-3 w-3" />}
          {logTime.isPending ? 'Saving…' : 'Log'}
        </button>
      </div>
    </div>
  );
}
