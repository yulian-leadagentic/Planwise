import { useState, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, Search } from 'lucide-react';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { inputClass, btnPrimary, btnSecondary } from './constants';

// ---------------------------------------------------------------------------
// Service Picker Modal
// ---------------------------------------------------------------------------

export function ServicePickerModal({
  zoneId,
  templateId,
  templates,
  onClose,
}: {
  zoneId: number;
  templateId: number;
  templates: any[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);

  const filtered = useMemo(() => {
    if (!search.trim()) return templates;
    const q = search.toLowerCase();
    return templates.filter((t: any) => t.name?.toLowerCase().includes(q) || t.code?.toLowerCase().includes(q));
  }, [templates, search]);

  const toggleTemplate = (id: number) => {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const handleAdd = async () => {
    const toAdd = templates.filter((t: any) => selected.has(t.id));
    if (toAdd.length === 0) return;
    setAdding(true);
    try {
      for (const svc of toAdd) {
        // Fetch service detail to get its tasks
        const detail = await client.get(`/templates/${svc.id}`).then((r) => r.data.data ?? r.data);
        const tasks = detail?.templateTasks ?? [];
        // Copy each task tagged with the service name
        for (const task of tasks) {
          await client.post(`/templates/zones/${zoneId}/tasks`, {
            code: task.code,
            name: task.name,
            description: `[SERVICE:${svc.name}]`,
            defaultBudgetHours: task.defaultBudgetHours,
            defaultBudgetAmount: task.defaultBudgetAmount,
          });
        }
      }
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      notify.success(`Added ${toAdd.length} deliverable template${toAdd.length > 1 ? 's' : ''}`, { code: 'SVC-ADD-200' });
      onClose();
    } catch (err: any) {
      notify.apiError(err, 'Failed to add deliverable');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="mx-4 flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-background shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold">Select Deliverable Templates</h2>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-accent" aria-label="Close"><X className="h-5 w-5"  aria-hidden="true" /></button>
        </div>
        <div className="border-b border-border px-5 py-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search deliverable templates..." className={`${inputClass} pl-9`} autoFocus />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{search ? 'No templates match.' : 'No deliverable templates available.'}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-xs">
                  <th className="px-3 py-2 w-10"></th>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-left font-medium">Code</th>
                  <th className="px-3 py-2 text-left font-medium">Service</th>
                  <th className="px-3 py-2 text-right font-medium">Tasks</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t: any) => {
                  const isSelected = selected.has(t.id);
                  return (
                    <tr key={t.id} className={`border-b border-border cursor-pointer ${isSelected ? 'bg-brand-50' : 'hover:bg-muted/30'}`} onClick={() => toggleTemplate(t.id)}>
                      <td className="px-3 py-2"><input type="checkbox" checked={isSelected} onChange={() => {}} className="h-4 w-4" /></td>
                      <td className="px-3 py-2 font-medium">{t.name}</td>
                      <td className="px-3 py-2 text-muted-foreground">{t.code || '-'}</td>
                      <td className="px-3 py-2">
                        {t.phase ? (
                          <span className="rounded-full bg-cyan-100 px-1.5 py-0.5 text-[11px] font-medium text-cyan-700">{t.phase.name}</span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">{t._count?.templateTasks ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border px-5 py-4">
          <span className="text-xs text-muted-foreground">{filtered.length} templates</span>
          <div className="flex gap-3">
            <button onClick={onClose} className={btnSecondary}>Cancel</button>
            <button onClick={handleAdd} disabled={selected.size === 0 || adding} className={btnPrimary}>
              {adding ? 'Adding...' : `Add ${selected.size} Service${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
