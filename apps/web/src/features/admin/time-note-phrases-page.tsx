import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';

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
  const queryClient = useQueryClient();
  const scrollRef = useStickyHScroll();
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
          className="flex-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm focus:border-blue-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => newText.trim() && create.mutate(newText.trim())}
          disabled={!newText.trim() || create.isPending}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </div>

      <div ref={scrollRef} className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[#FAFBFC] border-b border-slate-100 dark:border-slate-800">
            <tr className="text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
              <th className="px-4 py-2 text-left font-semibold">Phrase</th>
              <th className="px-4 py-2 text-right font-semibold w-[100px]">Order</th>
              <th className="px-4 py-2 text-center font-semibold w-[110px]">Status</th>
              <th className="px-4 py-2 text-right font-semibold w-[110px]">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {isLoading && (
              <tr><td colSpan={4} className="text-center py-10 text-slate-400 dark:text-slate-500">Loading…</td></tr>
            )}
            {!isLoading && phrases.length === 0 && (
              <tr><td colSpan={4} className="text-center py-10 text-slate-400 dark:text-slate-500 italic">No phrases yet — add one above.</td></tr>
            )}
            {phrases.map((p) => (
              <tr key={p.id} className={cn('group hover:bg-slate-50/50 dark:hover:bg-slate-800/50', !p.isActive && 'opacity-60')}>
                <td className="px-4 py-2 text-slate-700 dark:text-slate-200">
                  {editingId === p.id ? (
                    <input
                      autoFocus
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && editingText.trim()) update.mutate({ id: p.id, patch: { text: editingText.trim() } });
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      className="w-full px-2 py-1 rounded border border-blue-300 text-sm focus:border-blue-500 focus:outline-none"
                    />
                  ) : (
                    p.text
                  )}
                </td>
                <td className="px-4 py-2 text-right text-slate-500 dark:text-slate-400 font-mono tabular-nums">{p.sortOrder}</td>
                <td className="px-4 py-2 text-center">
                  <button
                    type="button"
                    onClick={() => update.mutate({ id: p.id, patch: { isActive: !p.isActive } })}
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-bold',
                      p.isActive ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700',
                    )}
                    title={p.isActive ? 'Click to disable' : 'Click to enable'}
                  >
                    {p.isActive ? 'Active' : 'Disabled'}
                  </button>
                </td>
                <td className="px-4 py-2 text-right">
                  <div className="inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {editingId === p.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => update.mutate({ id: p.id, patch: { text: editingText.trim() } })}
                          className="p-1.5 rounded text-emerald-600 hover:bg-emerald-50"
                          title="Save"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="p-1.5 rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                          title="Cancel"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => { setEditingId(p.id); setEditingText(p.text); }}
                          className="p-1.5 rounded text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800"
                          title="Edit"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => { if (confirm(`Remove "${p.text}"?`)) remove.mutate(p.id); }}
                          className="p-1.5 rounded text-slate-400 dark:text-slate-500 hover:text-red-600 hover:bg-red-50"
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
