import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Search } from 'lucide-react';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { inputClass, btnPrimary, btnSecondary } from './constants';

// ---------------------------------------------------------------------------
// Root-level Catalog Picker (creates zone + adds tasks)
// ---------------------------------------------------------------------------

export function RootCatalogPickerModal({
  templateId,
  onClose,
}: {
  templateId: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);

  const { data: allTemplates = [] } = useQuery({
    queryKey: ['templates', 'task_list'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=task_list').then((r) => r.data.data ?? r.data),
  });

  const catalogEntry = (allTemplates as any[]).find((t: any) => t.code === '__TASK_CATALOG__');

  const { data: catalog, isLoading } = useQuery({
    queryKey: ['templates', catalogEntry?.id],
    enabled: !!catalogEntry?.id,
    queryFn: () => client.get(`/templates/${catalogEntry.id}`).then((r) => r.data.data ?? r.data),
  });

  const catalogTasks: any[] = catalog?.templateTasks ?? [];
  const filtered = search.trim()
    ? catalogTasks.filter((t: any) => t.name?.toLowerCase().includes(search.toLowerCase()) || t.code?.toLowerCase().includes(search.toLowerCase()))
    : catalogTasks;

  const handleAddSelected = async () => {
    const tasksToAdd = catalogTasks.filter((t: any) => selected.has(t.id));
    if (tasksToAdd.length === 0) return;
    setAdding(true);
    try {
      // Add tasks directly to the template (root level)
      for (const t of tasksToAdd) {
        await client.post(`/templates/${templateId}/tasks`, {
          code: t.code,
          name: t.name,
          defaultBudgetHours: t.defaultBudgetHours,
          defaultBudgetAmount: t.defaultBudgetAmount,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      notify.success(`Added ${tasksToAdd.length} task${tasksToAdd.length !== 1 ? 's' : ''}`, { code: 'TASK-ADD-200' });
      onClose();
    } catch (err: any) {
      notify.apiError(err, 'Failed to add tasks');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="mx-4 flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-background shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold">Add Tasks from Catalog</h2>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-accent" aria-label="Close"><X className="h-5 w-5"  aria-hidden="true" /></button>
        </div>
        <div className="border-b border-border px-5 py-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks..." className={`${inputClass} pl-9`} autoFocus />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading catalog...</p>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{search ? 'No tasks match.' : 'No tasks in catalog.'}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-xs">
                  <th className="px-3 py-2 w-10"></th>
                  <th className="px-3 py-2 text-left font-medium">Code</th>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-right font-medium">Hours</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t: any) => (
                  <tr key={t.id} className={`border-b border-border cursor-pointer ${selected.has(t.id) ? 'bg-brand-50' : 'hover:bg-muted/30'}`} onClick={() => { const n = new Set(selected); n.has(t.id) ? n.delete(t.id) : n.add(t.id); setSelected(n); }}>
                    <td className="px-3 py-2"><input type="checkbox" checked={selected.has(t.id)} onChange={() => {}} className="h-4 w-4" /></td>
                    <td className="px-3 py-2 font-mono text-xs">{t.code || '-'}</td>
                    <td className="px-3 py-2">{t.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.defaultBudgetHours ? `${Number(t.defaultBudgetHours)}` : '-'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.defaultBudgetAmount ? Number(t.defaultBudgetAmount).toLocaleString() : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
          <button onClick={onClose} className={btnSecondary}>Cancel</button>
          <button onClick={handleAddSelected} disabled={selected.size === 0 || adding} className={btnPrimary}>
            {adding ? 'Adding...' : `Add ${selected.size} Task${selected.size !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
