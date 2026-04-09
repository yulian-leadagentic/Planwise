import { useState } from 'react';
import { ChevronDown, ChevronRight, Clock, AlertTriangle, Check, Plus, Pencil, Trash2 } from 'lucide-react';
import { formatDayHeader, formatTime } from '@/lib/date-utils';
import { minutesToDisplay } from '@/types';
import { MinutesInput } from '@/components/shared/minutes-input';
import { useUpdateTimeEntry, useDeleteTimeEntry } from '@/hooks/use-time';
import { cn } from '@/lib/utils';
import type { DailyBreakdown } from '@/types';

interface DailyBreakdownComponentProps {
  day: DailyBreakdown;
  onLogTime?: () => void;
}

export function DailyBreakdownComponent({ day, onLogTime }: DailyBreakdownComponentProps) {
  const [expanded, setExpanded] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editMinutes, setEditMinutes] = useState(0);
  const [editNote, setEditNote] = useState('');

  const updateEntry = useUpdateTimeEntry();
  const deleteEntry = useDeleteTimeEntry();

  const isToday = new Date().toISOString().split('T')[0] === day.date;

  const startEdit = (entry: { id: number; minutes: number; note: string | null }) => {
    setEditingId(entry.id);
    setEditMinutes(entry.minutes);
    setEditNote(entry.note ?? '');
  };

  const saveEdit = () => {
    if (!editingId || editMinutes <= 0) return;
    updateEntry.mutate(
      { id: editingId, minutes: editMinutes, note: editNote.trim() || undefined },
      { onSuccess: () => setEditingId(null) },
    );
  };

  const handleDelete = (id: number, name: string) => {
    if (confirm(`Delete time entry "${name}"?`)) {
      deleteEntry.mutate(id);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-background">
      {/* Day header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted/50"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}

        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className={cn('text-sm font-medium', isToday && 'text-brand-600')}>
              {formatDayHeader(day.date)}
            </span>
            {isToday && (
              <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-600">
                Today
              </span>
            )}
          </div>
          {day.clock && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              <Clock className="mr-1 inline-block h-3 w-3" />
              {formatTime(day.clock.clockIn)}
              {day.clock.clockOut && ` - ${formatTime(day.clock.clockOut)}`}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">{minutesToDisplay(day.totalLogged)}</span>

          {day.difference != null && (
            <span
              className={cn(
                'text-xs',
                day.isBalanced
                  ? 'text-green-600'
                  : day.difference > 0
                    ? 'text-orange-500'
                    : 'text-red-500',
              )}
            >
              {day.isBalanced ? (
                <Check className="inline-block h-3.5 w-3.5" />
              ) : day.difference > 0 ? (
                `+${minutesToDisplay(day.difference)}`
              ) : (
                <>
                  <AlertTriangle className="mr-0.5 inline-block h-3 w-3" />
                  {minutesToDisplay(Math.abs(day.difference))}
                </>
              )}
            </span>
          )}
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-border px-4 py-3">
          {/* Expected schedule */}
          {day.expected && (
            <div className="mb-3 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
              Expected: {day.expected.shiftStart} - {day.expected.shiftEnd}
              {day.expected.breakMinutes > 0 && ` (${day.expected.breakMinutes}m break)`}
              {' = '}
              {minutesToDisplay(day.expected.expectedMinutes)}
            </div>
          )}

          {/* Time entries */}
          {day.entries.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No time entries</p>
          ) : (
            <div className="space-y-2">
              {day.entries.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-md border border-border p-2"
                >
                  {editingId === entry.id ? (
                    /* Edit mode */
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                          {entry.task?.name ?? entry.project?.name ?? 'General'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <MinutesInput
                          value={editMinutes}
                          onChange={setEditMinutes}
                          className="w-28 text-xs"
                        />
                        <input
                          type="text"
                          value={editNote}
                          onChange={(e) => setEditNote(e.target.value)}
                          placeholder="Note..."
                          className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        <button
                          onClick={saveEdit}
                          disabled={updateEntry.isPending}
                          className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* View mode */
                    <div className="flex items-center justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {entry.task?.name ?? entry.project?.name ?? 'General'}
                        </p>
                        {entry.task?.label && (
                          <p className="truncate text-xs text-muted-foreground">
                            {entry.task.label.projectName} / {entry.task.label.name}
                          </p>
                        )}
                        {entry.note && (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {entry.note}
                          </p>
                        )}
                      </div>
                      <div className="ml-3 flex items-center gap-2">
                        {entry.isBillable && (
                          <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
                            $
                          </span>
                        )}
                        <span className="text-sm font-medium">{minutesToDisplay(entry.minutes)}</span>
                        <button
                          onClick={() => startEdit(entry)}
                          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                          title="Edit entry"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(entry.id, entry.task?.name ?? entry.project?.name ?? 'entry')}
                          className="rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                          title="Delete entry"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Add time button */}
          {onLogTime && (
            <button
              onClick={onLogTime}
              className="mt-2 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-brand-600 hover:bg-brand-50"
            >
              <Plus className="h-3.5 w-3.5" />
              Add time entry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
