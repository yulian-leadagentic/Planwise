import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Pencil, Check, X, MessageSquare } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';

/**
 * Admin CRUD for the time-log preset phrase pool.
 * Tier C #9b, 2026-06-30. Users pick from this pool inside the
 * time-entry form so end-of-day reporting takes seconds not minutes.
 */
interface Phrase {
  id: number;
  text: string;
  sortOrder: number;
  isActive: boolean;
}

export function TimeNotePhrasesPage() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [newText, setNewText] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState('');

  const { data: phrases = [], isLoading } = useQuery<Phrase[]>({
    queryKey: ['admin', 'time-note-phrases'],
    queryFn: () =>
      client.get('/admin/config/time-note-phrases').then((r) => {
        const d = r.data?.data ?? r.data ?? [];
        return Array.isArray(d) ? d : [];
      }),
  });

  const create = useMutation({
    mutationFn: (text: string) =>
      client
        .post('/admin/config/time-note-phrases', { text, sortOrder: (phrases.length + 1) * 10, isActive: true })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'time-note-phrases'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'time-note-phrases', 'active'] });
      setNewText('');
      notify.success('Phrase added');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add phrase'),
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<Phrase> }) =>
      client.patch(`/admin/config/time-note-phrases/${id}`, patch).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'time-note-phrases'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'time-note-phrases', 'active'] });
      notify.success('Phrase updated');
      setEditingId(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update phrase'),
  });

  const remove = useMutation({
    mutationFn: (id: number) => client.delete(`/admin/config/time-note-phrases/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'time-note-phrases'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'time-note-phrases', 'active'] });
      notify.success('Phrase removed');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove phrase'),
  });

  // Actions column always shows its buttons (DataTable rows don't
  // carry the `group` class the old layout relied on). Small
  // low-contrast icons keep the row visually calm.
  const columns = useMemo<ColumnDef<Phrase, unknown>[]>(() => [
    { accessorKey: 'text', header: 'Phrase', enableSorting: false,
      cell: ({ row }) => {
        const p = row.original;
        if (editingId === p.id) {
          return (
            <input
              autoFocus
              value={editingText}
              onChange={(e) => setEditingText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && editingText.trim()) update.mutate({ id: p.id, patch: { text: editingText.trim() } });
                if (e.key === 'Escape') setEditingId(null);
              }}
              className="w-full px-2 py-1 rounded border border-blue-300 dark:border-blue-500 bg-background text-sm focus:border-blue-500 focus:outline-none"
            />
          );
        }
        return <span className={cn('text-slate-700 dark:text-slate-200', !p.isActive && 'opacity-60')}>{p.text}</span>;
      } },
    { accessorKey: 'sortOrder', header: 'Order', enableSorting: false, size: 100,
      cell: ({ row }) => (
        <span className="text-right text-slate-500 dark:text-slate-400 font-mono tabular-nums">{row.original.sortOrder}</span>
      ) },
    { accessorKey: 'isActive', header: 'Status', enableSorting: false, size: 110,
      cell: ({ row }) => {
        const p = row.original;
        return (
          <button
            type="button"
            onClick={() => update.mutate({ id: p.id, patch: { isActive: !p.isActive } })}
            className={cn(
              'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border',
              p.isActive
                ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-700'
                : 'bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-300 border-slate-200 dark:border-slate-700',
            )}
            title={p.isActive ? 'Click to disable' : 'Click to enable'}
            aria-label={p.isActive ? `Disable phrase ${p.text}` : `Enable phrase ${p.text}`}
          >
            {p.isActive ? 'Active' : 'Disabled'}
          </button>
        );
      } },
    { id: 'actions', header: 'Actions', enableSorting: false, size: 110,
      cell: ({ row }) => {
        const p = row.original;
        if (editingId === p.id) {
          return (
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => update.mutate({ id: p.id, patch: { text: editingText.trim() } })}
                className="p-1.5 rounded text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
                aria-label={`Save phrase ${p.text}`}
                title="Save"
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setEditingId(null)}
                className="p-1.5 rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Cancel edit"
                title="Cancel"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          );
        }
        return (
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={() => { setEditingId(p.id); setEditingText(p.text); }}
              className="p-1.5 rounded text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label={`Edit phrase ${p.text}`}
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={async () => { if (await confirm(`Remove "${p.text}"?`)) remove.mutate(p.id); }}
              className="p-1.5 rounded text-slate-400 dark:text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
              aria-label={`Delete phrase ${p.text}`}
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      } },
  ], [editingId, editingText, update, remove, confirm]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Time-log Phrases"
        description="Curated snippets employees can pick when logging time. Keeps end-of-day reporting fast."
      />

      <div className="flex items-center gap-2 max-w-2xl">
        <input
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newText.trim()) create.mutate(newText.trim());
          }}
          placeholder="Add a new phrase (e.g. 'Working on drawings')"
          className="flex-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-background text-sm focus:border-blue-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => newText.trim() && create.mutate(newText.trim())}
          disabled={!newText.trim() || create.isPending}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add
        </button>
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-slate-400 dark:text-slate-500">Loading…</div>
      ) : phrases.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No phrases yet"
          description="Add one above to build out the pool."
        />
      ) : (
        <DataTable columns={columns} data={phrases} pageSize={1000} />
      )}
    </div>
  );
}
