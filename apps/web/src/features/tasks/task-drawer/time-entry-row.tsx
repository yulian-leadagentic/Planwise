import { useState } from 'react';
import { Trash2, Pencil } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { notify } from '@/lib/notify';
import { timeApi } from '@/api/time.api';
import { formatDate } from '@/lib/date-utils';
import { invalidateAfterTimeEntry } from '@/features/time/invalidate-after-time-entry';

/**
 * Single time-entry row with inline edit + delete. Edit replaces the
 * read-only display with date/start/end/note inputs and a save button.
 * Delete asks for confirmation (we don't want a single misclick to
 * wipe an hour of reported work).
 */
export function TimeEntryRow({ entry, taskId }: { entry: any; taskId: number }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [date, setDate] = useState((entry.date ?? '').split('T')[0]);
  const [start, setStart] = useState(entry.startTime ?? '09:00');
  const [end, setEnd] = useState(entry.endTime ?? '10:00');
  const [note, setNote] = useState(entry.note ?? '');

  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const editingMinutes = Math.max(0, (eh * 60 + em) - (sh * 60 + sm));

  // The entry carries its projectId (loaded with the row); pass it to
  // the shared invalidator so per-project rollups (/progress /feasibility
  // /projects/:id) refetch scoped instead of prefix-flushing.
  const projectId: number | null = entry.projectId ?? entry.project?.id ?? null;

  const updateMutation = useMutation({
    mutationFn: () => timeApi.updateEntry(entry.id, {
      date,
      startTime: start,
      endTime: end,
      minutes: editingMinutes,
      note: note.trim() || undefined,
    }),
    onSuccess: () => {
      // Shared invalidator: time / tasks / progress / feasibility /
      // planning / execution-board / project detail. Fixes the
      // "editing a time entry doesn't refresh the project KPIs"
      // half of PR-004/005/006.
      invalidateAfterTimeEntry(queryClient, { projectId, taskId });
      notify.success('Entry updated', { code: 'TIME-EDIT-200' });
      setEditing(false);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update entry'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => timeApi.deleteEntry(entry.id),
    onSuccess: () => {
      invalidateAfterTimeEntry(queryClient, { projectId, taskId });
      notify.success('Entry deleted', { code: 'TIME-DEL-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete entry'),
  });

  if (editing) {
    return (
      <div className="px-3 py-2 bg-blue-50/40 space-y-1.5">
        <div className="flex items-center gap-2">
          <input type="date" value={date} onChange={(ev) => setDate(ev.target.value)}
            className="rounded border border-slate-200 dark:border-slate-700 px-1.5 py-1 text-[11px] focus:border-blue-400 focus:outline-none" />
          <input type="time" step="300" value={start} onChange={(ev) => setStart(ev.target.value)}
            className="w-[82px] rounded border border-slate-200 dark:border-slate-700 px-1.5 py-1 text-[11px] focus:border-blue-400 focus:outline-none" />
          <span className="text-slate-400 dark:text-slate-500 text-[10px]">→</span>
          <input type="time" step="300" value={end} onChange={(ev) => setEnd(ev.target.value)}
            className="w-[82px] rounded border border-slate-200 dark:border-slate-700 px-1.5 py-1 text-[11px] focus:border-blue-400 focus:outline-none" />
          <span className="ml-auto text-[11px] font-bold text-blue-600 tabular-nums">
            {(editingMinutes / 60).toFixed(2)}h
          </span>
        </div>
        <input type="text" value={note} onChange={(ev) => setNote(ev.target.value)}
          placeholder="Note (optional)…"
          className="w-full rounded border border-slate-200 dark:border-slate-700 px-1.5 py-1 text-[11px] focus:border-blue-400 focus:outline-none" />
        <div className="flex items-center gap-1.5">
          <button onClick={() => updateMutation.mutate()}
            disabled={editingMinutes <= 0 || updateMutation.isPending}
            className="rounded bg-blue-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {updateMutation.isPending ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => setEditing(false)}
            disabled={updateMutation.isPending}
            className="rounded px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-3 px-3 py-2 text-[12px] hover:bg-slate-50/60 dark:hover:bg-slate-800/60">
      <span className="text-slate-600 dark:text-slate-300 tabular-nums w-[78px] shrink-0">
        {entry.date ? formatDate(entry.date.split('T')[0]) : '—'}
      </span>
      <span className="text-slate-500 dark:text-slate-400 tabular-nums w-[90px] shrink-0">
        {entry.startTime && entry.endTime ? `${entry.startTime} – ${entry.endTime}` : ''}
      </span>
      <span className="font-semibold text-slate-700 dark:text-slate-200 tabular-nums w-[42px] shrink-0">
        {((entry.minutes ?? 0) / 60).toFixed(2)}h
      </span>
      {entry.note && (
        <span className="text-slate-600 dark:text-slate-300 truncate flex-1" title={entry.note}>
          {entry.note}
        </span>
      )}
      {!entry.note && <span className="flex-1" />}
      {confirmingDelete ? (
        <span className="flex items-center gap-1.5">
          <button
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            className="rounded bg-red-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-700 disabled:opacity-50"
            aria-label="Confirm delete entry"
          >
            {deleteMutation.isPending ? '…' : 'Delete'}
          </button>
          <button
            onClick={() => setConfirmingDelete(false)}
            disabled={deleteMutation.isPending}
            className="text-[10px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100"
          >
            Cancel
          </button>
        </span>
      ) : (
        <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => setEditing(true)}
            className="rounded p-1 text-slate-400 dark:text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-100"
            aria-label="Edit entry"
            title="Edit"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            onClick={() => setConfirmingDelete(true)}
            className="rounded p-1 text-slate-400 dark:text-slate-500 hover:bg-red-100 hover:text-red-600"
            aria-label="Delete entry"
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </span>
      )}
    </div>
  );
}
