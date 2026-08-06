import { useState } from 'react';
import { X, Calendar, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/date-utils';
import { usePermissions } from '@/hooks/use-permissions';

/**
 * Inline-editable due-date chip. Click to edit when the user has
 * permission (admin OR tasks:write OR tasks:edit-due-date); otherwise
 * it's a read-only span. Saves on blur or Enter, cancels on Escape.
 *
 * The "tasks:edit-due-date" check is the requested fine-grained
 * authorization hook — an admin can grant exactly this without giving
 * the full tasks:write power. Falls back to tasks:write so existing
 * roles keep working unchanged.
 */
export function DueDateChip({ task, onUpdate }: { task: any; onUpdate: (value: string | null) => void }) {
  const { can, isAdmin } = usePermissions();
  const canEdit = isAdmin || can('tasks', 'write') || can('tasks/edit-due-date', 'write');
  const [editing, setEditing] = useState(false);
  const dueDateValue = task.endDate ? String(task.endDate).slice(0, 10) : '';

  if (!task.endDate && !canEdit) return null;

  if (editing && canEdit) {
    return (
      <input
        type="date"
        autoFocus
        defaultValue={dueDateValue}
        onBlur={(e) => {
          // Browsers return "" from <input type=date> when the typed value
          // didn't parse to a valid YYYY-MM-DD (e.g. user typed "17/06/26"
          // or any non-ISO format). Treating that empty as "user wants to
          // clear" silently destroyed the existing due date — see #52.
          // Now: only commit a value that LOOKS valid; if the field went
          // empty but we had a date, ignore the blur and keep what we had.
          // Explicit clearing happens via the ✕ button on the chip below.
          const v = e.target.value;
          const isValid = /^\d{4}-\d{2}-\d{2}$/.test(v);
          if (isValid && v !== dueDateValue) onUpdate(v);
          // empty string + had a date → assume parse failure, ignore.
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.currentTarget.value = dueDateValue; setEditing(false); }
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        }}
        className="rounded border border-blue-300 bg-white dark:bg-slate-900 px-1.5 py-0.5 text-[11px] focus:outline-none focus:border-blue-500"
      />
    );
  }

  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => canEdit && setEditing(true)}
        disabled={!canEdit}
        className={cn(
          'inline-flex items-center gap-1 rounded px-1 py-0.5',
          canEdit ? 'hover:bg-white/60 dark:hover:bg-slate-900/60 cursor-pointer' : 'cursor-default',
        )}
        title={canEdit ? 'Click to change due date' : ''}
      >
        <Calendar className="h-3 w-3" />
        {task.endDate ? formatDate(task.endDate.split('T')[0]) : (
          <span className="italic text-slate-400 dark:text-slate-500">set due date</span>
        )}
        {/* Pencil affordance — shows the field is editable. #53. Permission-
            gated via canEdit above (button is disabled when not allowed). */}
        {canEdit && (
          <Pencil className="h-2.5 w-2.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
        )}
      </button>
      {/* Explicit clear button — replaces the "blur with empty value clears
          the date" path that was silently wiping data on bad input. Only
          shown when there IS a date to clear and the user has permission. */}
      {canEdit && task.endDate && (
        <button
          type="button"
          onClick={async () => {
            if (await confirm('Clear due date?')) onUpdate(null);
          }}
          className="p-0.5 rounded text-slate-300 dark:text-slate-600 hover:text-red-500 hover:bg-red-50"
          title="Clear due date"
          aria-label="Clear due date"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}
