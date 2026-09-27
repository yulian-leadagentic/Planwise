import { useState, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { Modal } from '@/components/shared/modal';
import { inputClass, btnPrimary, btnSecondary } from './constants';

// ---------------------------------------------------------------------------
// Root-level Service Picker (adds as TemplateTask with service tag)
// ---------------------------------------------------------------------------

export function RootServicePickerModal({
  templateId,
  templates,
  onClose,
}: {
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

  const handleAdd = async () => {
    const toAdd = templates.filter((t: any) => selected.has(t.id));
    if (toAdd.length === 0) return;
    setAdding(true);
    try {
      for (const svc of toAdd) {
        // Fetch service tasks and copy them as TemplateTask entries with service tag
        const detail = await client.get(`/templates/${svc.id}`).then((r) => r.data.data ?? r.data);
        for (const task of (detail?.templateTasks ?? [])) {
          await client.post(`/templates/${templateId}/tasks`, {
            code: task.code, name: task.name, description: `[SERVICE:${svc.name}]`,
            defaultBudgetHours: task.defaultBudgetHours, defaultBudgetAmount: task.defaultBudgetAmount,
          });
        }
      }
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      notify.success(`Added ${toAdd.length} service${toAdd.length > 1 ? 's' : ''}`, { code: 'SVC-ADD-200' });
      onClose();
    } catch (err: any) {
      notify.apiError(err, 'Failed to add deliverable');
    } finally {
      setAdding(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Select Deliverable Templates"
      widthClass="mx-4 w-full max-w-2xl"
      className="max-h-[80vh]"
      isDirty={selected.size > 0}
      bodyClassName="p-0 flex flex-col"
      footer={
        <>
          <button type="button" onClick={onClose} className={btnSecondary}>Cancel</button>
          <button type="button" onClick={handleAdd} disabled={selected.size === 0 || adding} className={btnPrimary}>
            {adding ? 'Adding...' : `Add ${selected.size} Service${selected.size !== 1 ? 's' : ''}`}
          </button>
        </>
      }
    >
      <div className="border-b border-border px-5 py-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." className={`${inputClass} pl-9`} autoFocus />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No deliverable templates available.</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border bg-muted/50 text-xs">
              <th className="px-3 py-2 w-10"></th>
              <th className="px-3 py-2 text-left font-medium">Name</th>
              <th className="px-3 py-2 text-left font-medium">Code</th>
              <th className="px-3 py-2 text-left font-medium">Service</th>
              <th className="px-3 py-2 text-right font-medium">Tasks</th>
            </tr></thead>
            <tbody>
              {filtered.map((t: any) => (
                <tr key={t.id} className={`border-b border-border cursor-pointer ${selected.has(t.id) ? 'bg-brand-50 dark:bg-blue-900/30' : 'hover:bg-muted/30'}`} onClick={() => { const n = new Set(selected); n.has(t.id) ? n.delete(t.id) : n.add(t.id); setSelected(n); }}>
                  <td className="px-3 py-2"><input type="checkbox" checked={selected.has(t.id)} onChange={() => {}} className="h-4 w-4" /></td>
                  <td className="px-3 py-2 font-medium">{t.name}</td>
                  <td className="px-3 py-2 text-muted-foreground">{t.code || '-'}</td>
                  <td className="px-3 py-2">
                    {t.phase ? (
                      <span className="rounded-full bg-cyan-100 dark:bg-cyan-900/40 px-1.5 py-0.5 text-[11px] font-medium text-cyan-700 dark:text-cyan-300">{t.phase.name}</span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">{t._count?.templateTasks ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}
