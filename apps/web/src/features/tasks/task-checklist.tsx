import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, CheckSquare } from 'lucide-react';
import { tasksApi } from '@/api/tasks.api';
import { notify } from '@/lib/notify';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';
import { formatRelative } from '@/lib/date-utils';

/**
 * Per the 2026-06-14 BM mapping meeting: the customer wanted "personal
 * tasks" to be CHECKLIST ITEMS inside a task, not separate tasks. No due
 * date, no hours, no status — just a list of things to tick off as the
 * parent task progresses. doneBy/doneAt are stamped server-side when an
 * item flips to done so the team can see who closed it.
 */
interface ChecklistItem {
  id: number;
  text: string;
  isDone: boolean;
  doneAt: string | null;
  doneByUser: { id: number; firstName: string; lastName: string; avatarUrl: string | null } | null;
  createdAt: string;
  sortOrder: number;
}

export function TaskChecklist({ taskId }: { taskId: number }) {
  const qc = useQueryClient();
  const { can, isAdmin } = usePermissions();
  const canWrite = isAdmin || can('tasks', 'write');
  const inputRef = useRef<HTMLInputElement>(null);
  const [newItemText, setNewItemText] = useState('');

  const { data: items = [], isLoading } = useQuery<ChecklistItem[]>({
    queryKey: ['tasks', taskId, 'checklist'],
    queryFn: () => tasksApi.getChecklist(taskId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tasks', taskId, 'checklist'] });

  const addItem = useMutation({
    mutationFn: (text: string) => tasksApi.addChecklistItem(taskId, text),
    onSuccess: () => {
      setNewItemText('');
      invalidate();
      inputRef.current?.focus();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add item'),
  });

  const updateItem = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: { text?: string; isDone?: boolean } }) =>
      tasksApi.updateChecklistItem(id, patch),
    onSuccess: invalidate,
    onError: (err: any) => notify.apiError(err, 'Failed to update item'),
  });

  const removeItem = useMutation({
    mutationFn: (id: number) => tasksApi.removeChecklistItem(id),
    onSuccess: invalidate,
    onError: (err: any) => notify.apiError(err, 'Failed to remove item'),
  });

  // Counts for the header — drives the "x/y done" badge so users can see
  // progress without expanding every item.
  const doneCount = items.filter((i) => i.isDone).length;
  const totalCount = items.length;

  const submit = () => {
    const text = newItemText.trim();
    if (!text) return;
    addItem.mutate(text);
  };

  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
      <header className="flex items-center justify-between px-3 py-2 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <CheckSquare className="h-4 w-4 text-slate-500 dark:text-slate-400" />
          <span className="text-[12px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">Checklist</span>
          {totalCount > 0 && (
            <span className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
              {doneCount}/{totalCount} done
            </span>
          )}
        </div>
      </header>

      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {isLoading ? (
          <li className="px-3 py-2 text-[12px] text-slate-400 dark:text-slate-500 italic">Loading…</li>
        ) : items.length === 0 ? (
          <li className="px-3 py-3 text-[12px] text-slate-400 dark:text-slate-500 italic">
            No items yet. Add one below.
          </li>
        ) : (
          items.map((item) => (
            <ChecklistRow
              key={item.id}
              item={item}
              canWrite={canWrite}
              onToggle={(isDone) => updateItem.mutate({ id: item.id, patch: { isDone } })}
              onEdit={(text) => updateItem.mutate({ id: item.id, patch: { text } })}
              onRemove={() => {
                if (confirm(`Remove "${item.text}"?`)) removeItem.mutate(item.id);
              }}
            />
          ))
        )}
      </ul>

      {canWrite && (
        // Add-row redesigned per user feedback (#54):
        //   1. The previous bg-slate-50/50 dark:bg-slate-800/50 + bg-transparent input read as
        //      pure greyed-out chrome — users didn't realize they could
        //      type into it.
        //   2. The Plus icon was a passive decoration; clicking it did
        //      nothing. Users intuitively reached for it to "start a new
        //      task" and got no response.
        // Fix:
        //   • Wrap the input in a real white field with a visible border so
        //     it looks like an input.
        //   • Make the leading + icon a real button: click it to focus the
        //     input (= "initiate a new item"). Same effect as Tab-into.
        //   • Show the "Add" button always; disable when empty instead of
        //     hiding, so users see what their next action is.
        <div className="flex items-center gap-2 px-3 py-2 border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900">
          <button
            type="button"
            onClick={() => inputRef.current?.focus()}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-600 hover:bg-blue-100 hover:text-blue-700"
            title="Add a new item"
            aria-label="Start typing a new checklist item"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
          <input
            ref={inputRef}
            type="text"
            value={newItemText}
            onChange={(e) => setNewItemText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Add a checklist item…"
            maxLength={500}
            className="flex-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-[13px] text-slate-700 dark:text-slate-200 focus:border-blue-400 focus:outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500 disabled:bg-slate-50"
            disabled={addItem.isPending}
          />
          <button
            type="button"
            onClick={submit}
            disabled={addItem.isPending || !newItemText.trim()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}

function ChecklistRow({
  item,
  canWrite,
  onToggle,
  onEdit,
  onRemove,
}: {
  item: ChecklistItem;
  canWrite: boolean;
  onToggle: (isDone: boolean) => void;
  onEdit: (text: string) => void;
  onRemove: () => void;
}) {
  // Local edit state — clicking the text turns it into an input. Save on
  // blur or Enter; cancel on Escape. Kept local rather than lifting so a
  // sibling click can't clobber an in-flight edit.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);

  const commit = () => {
    const next = draft.trim();
    if (!next || next === item.text) {
      setEditing(false);
      setDraft(item.text);
      return;
    }
    onEdit(next);
    setEditing(false);
  };

  return (
    <li className="group flex items-start gap-2 px-3 py-2 hover:bg-slate-50/40 dark:hover:bg-slate-800/40">
      <button
        type="button"
        onClick={() => onToggle(!item.isDone)}
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0 rounded border flex items-center justify-center transition-colors',
          item.isDone
            ? 'bg-emerald-500 border-emerald-500 text-white'
            : 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-600 hover:border-slate-500 dark:hover:border-slate-400',
        )}
        aria-label={item.isDone ? 'Mark as not done' : 'Mark as done'}
      >
        {item.isDone && (
          <svg className="h-2.5 w-2.5" viewBox="0 0 16 16" fill="none">
            <path d="M3 8L7 12L13 4" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-0">
        {editing && canWrite ? (
          <input
            type="text"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { setEditing(false); setDraft(item.text); }
            }}
            maxLength={500}
            className="w-full text-[13px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-400"
          />
        ) : (
          <button
            type="button"
            onClick={() => canWrite && setEditing(true)}
            disabled={!canWrite}
            className={cn(
              'text-[13px] text-left block w-full break-words',
              item.isDone && 'line-through text-slate-400 dark:text-slate-500',
              canWrite ? 'cursor-text hover:text-slate-600 dark:hover:text-slate-200' : 'cursor-default',
            )}
            title={canWrite ? 'Click to edit' : ''}
          >
            {item.text}
          </button>
        )}
        {item.isDone && item.doneByUser && item.doneAt && (
          <p className="text-[10.5px] text-slate-400 dark:text-slate-500 mt-0.5">
            {item.doneByUser.firstName} {item.doneByUser.lastName} · {formatRelative(item.doneAt)}
          </p>
        )}
      </div>
      {canWrite && (
        <button
          type="button"
          onClick={onRemove}
          className="opacity-0 group-hover:opacity-100 p-1 rounded text-slate-300 dark:text-slate-600 hover:text-red-500 hover:bg-red-50 transition-opacity"
          aria-label={`Remove "${item.text}"`}
          title="Remove item"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );
}
