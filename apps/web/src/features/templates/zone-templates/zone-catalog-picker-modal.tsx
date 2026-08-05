import { useState, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Search } from 'lucide-react';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { inputClass, btnPrimary, btnSecondary } from './constants';

// ---------------------------------------------------------------------------
// Zone Catalog Picker Modal
// ---------------------------------------------------------------------------

export function ZoneCatalogPickerModal({
  zoneId,
  templateId,
  existingTaskCodes,
  onClose,
}: {
  zoneId: number;
  templateId: number;
  existingTaskCodes: Set<string>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [sortField, setSortField] = useState<'code' | 'name' | 'hours' | 'amount'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const { data: allTemplates = [] } = useQuery({
    queryKey: ['templates', 'task_list'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=task_list').then((r) => r.data.data ?? r.data),
  });

  const catalogEntry = (allTemplates as any[]).find((t: any) => t.code === '__TASK_CATALOG__');

  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: ['templates', catalogEntry?.id],
    enabled: !!catalogEntry?.id,
    queryFn: () => client.get(`/templates/${catalogEntry.id}`).then((r) => r.data.data ?? r.data),
  });

  const catalogTasks: any[] = catalog?.templateTasks ?? [];

  const filteredTasks = useMemo(() => {
    let result = catalogTasks;
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (t: any) =>
          (t.name && t.name.toLowerCase().includes(q)) ||
          (t.code && t.code.toLowerCase().includes(q)),
      );
    }
    return [...result].sort((a, b) => {
      let valA: any, valB: any;
      switch (sortField) {
        case 'code': valA = (a.code ?? '').toLowerCase(); valB = (b.code ?? '').toLowerCase(); break;
        case 'name': valA = (a.name ?? '').toLowerCase(); valB = (b.name ?? '').toLowerCase(); break;
        case 'hours': valA = Number(a.defaultBudgetHours) || 0; valB = Number(b.defaultBudgetHours) || 0; break;
        case 'amount': valA = Number(a.defaultBudgetAmount) || 0; valB = Number(b.defaultBudgetAmount) || 0; break;
      }
      if (valA < valB) return sortDir === 'asc' ? -1 : 1;
      if (valA > valB) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [catalogTasks, search, sortField, sortDir]);

  const handleSort = (field: typeof sortField) => {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDir('asc'); }
  };

  const sortIcon = (field: typeof sortField) => (sortField === field ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '');

  const toggleTask = (taskId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(taskId) ? next.delete(taskId) : next.add(taskId);
      return next;
    });
  };

  const handleAddSelected = async () => {
    const tasksToAdd = catalogTasks.filter((t: any) => selected.has(t.id));
    if (tasksToAdd.length === 0) return;
    setAdding(true);
    try {
      for (const ct of tasksToAdd) {
        await client.post(`/templates/zones/${zoneId}/tasks`, {
          code: ct.code,
          name: ct.name,
          defaultBudgetHours: ct.defaultBudgetHours,
          defaultBudgetAmount: ct.defaultBudgetAmount,
          // phaseId is set at the deliverable template level, not per-task
        });
      }
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      notify.success(`Added ${tasksToAdd.length} task${tasksToAdd.length !== 1 ? 's' : ''} to zone`, { code: 'TASK-ADD-200' });
      onClose();
    } catch (err: any) {
      notify.apiError(err, 'Failed to add tasks');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="relative mx-4 flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold">Pick Tasks from Catalog</h2>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-accent" aria-label="Close">
            <X className="h-5 w-5"  aria-hidden="true" />
          </button>
        </div>

        {/* Search */}
        <div className="border-b border-border px-5 py-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tasks by name or code..."
              className={`${inputClass} pl-9`}
              autoFocus
            />
          </div>
        </div>

        {/* Task table */}
        <div className="flex-1 overflow-y-auto">
          {catalogLoading || !catalogEntry ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {!catalogEntry && !catalogLoading
                ? 'No task catalog found. Create tasks in the Task Catalog first.'
                : 'Loading catalog...'}
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {search ? 'No tasks match your search.' : 'The catalog has no tasks yet.'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-xs">
                  <th className="px-3 py-2 text-left font-medium w-10"></th>
                  <th className="px-3 py-2 text-left font-medium cursor-pointer select-none" onClick={() => handleSort('code')}>Code{sortIcon('code')}</th>
                  <th className="px-3 py-2 text-left font-medium cursor-pointer select-none" onClick={() => handleSort('name')}>Name{sortIcon('name')}</th>
                  <th className="px-3 py-2 text-right font-medium cursor-pointer select-none" onClick={() => handleSort('hours')}>Hours{sortIcon('hours')}</th>
                  <th className="px-3 py-2 text-right font-medium cursor-pointer select-none" onClick={() => handleSort('amount')}>Amount{sortIcon('amount')}</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.map((task: any) => {
                  const alreadyExists = task.code ? existingTaskCodes.has(task.code) : false;
                  const isSelected = selected.has(task.id);
                  return (
                    <tr
                      key={task.id}
                      className={`border-b border-border last:border-0 cursor-pointer ${isSelected ? 'bg-brand-50' : 'hover:bg-muted/30'} ${alreadyExists ? 'opacity-50' : ''}`}
                      onClick={() => !alreadyExists && toggleTask(task.id)}
                    >
                      {/* Checkbox cell — stop click bubbling so the row's onClick doesn't double-toggle. */}
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={alreadyExists}
                          onChange={() => !alreadyExists && toggleTask(task.id)}
                          className="h-4 w-4 rounded border-gray-300 dark:border-slate-600"
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{task.code || '-'}</td>
                      <td className="px-3 py-2 font-medium">{task.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{task.defaultBudgetHours != null ? Number(task.defaultBudgetHours).toFixed(0) : '-'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{task.defaultBudgetAmount != null ? Number(task.defaultBudgetAmount).toLocaleString() : '-'}</td>
                      <td className="px-3 py-2">
                        {alreadyExists && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">already added</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-5 py-4">
          <span className="text-xs text-muted-foreground">{filteredTasks.length} tasks{search ? ` matching "${search}"` : ''}</span>
          <div className="flex gap-3">
            <button onClick={onClose} className={btnSecondary}>Cancel</button>
            <button onClick={handleAddSelected} disabled={selected.size === 0 || adding} className={btnPrimary}>
              {adding ? 'Adding...' : `Add ${selected.size} Selected Task${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
