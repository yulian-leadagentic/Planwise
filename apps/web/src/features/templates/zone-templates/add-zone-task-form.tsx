import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { inputClass } from './constants';

// ---------------------------------------------------------------------------
// Add Zone Task Form (inline)
// ---------------------------------------------------------------------------

export function AddZoneTaskForm({
  zoneId,
  templateId,
  onDone,
}: {
  zoneId: number;
  templateId: number;
  phases?: any[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [hours, setHours] = useState('');
  const [amount, setAmount] = useState('');
  const [saveToCatalog, setSaveToCatalog] = useState(true);

  const addMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      client.post(`/templates/zones/${zoneId}/tasks`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      notify.success('Task added to zone', { code: 'TASK-ADD-200' });
      onDone();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add task'),
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !name.trim()) {
      notify.warning('Code and Name are required', { code: 'TASK-ADD-400' });
      return;
    }
    const payload = {
      code: code.trim(),
      name: name.trim(),
      defaultBudgetHours: hours ? Number(hours) : undefined,
      defaultBudgetAmount: amount ? Number(amount) : undefined,
    };
    // Also save to catalog if checked
    if (saveToCatalog) {
      try {
        const allTpls = await client.get('/templates?type=task_list').then((r) => r.data.data ?? r.data);
        const catalog = (Array.isArray(allTpls) ? allTpls : []).find((t: any) => t.code === '__TASK_CATALOG__');
        if (catalog) {
          await client.post(`/templates/${catalog.id}/tasks`, payload);
          queryClient.invalidateQueries({ queryKey: ['templates', catalog.id] });
        }
      } catch {
        // The zone task itself is still added below — but don't let the
        // catalog copy fail silently while the user sees a success toast.
        notify.warning('Task added to the zone, but saving a copy to the catalog failed.', { code: 'TASK-CATALOG-207' });
      }
    }
    addMutation.mutate(payload);
  };

  return (
    <form onSubmit={handleSubmit} className="mt-1 rounded-md border border-border bg-muted/30 p-2 space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div>
          <label className="block text-xs font-medium mb-0.5">Code *</label>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. BIM-CD" className={inputClass} autoFocus />
        </div>
        <div>
          <label className="block text-xs font-medium mb-0.5">Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Clash Detection" className={inputClass} />
        </div>
        <div>
          <label className="block text-xs font-medium mb-0.5">Hours</label>
          <input type="number" min="0" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="0" className={inputClass} />
        </div>
        <div>
          <label className="block text-xs font-medium mb-0.5">Amount</label>
          <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" className={inputClass} />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex gap-2">
          <button type="submit" disabled={addMutation.isPending} className="rounded-md bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
            {addMutation.isPending ? 'Adding...' : 'Add Task'}
          </button>
          <button type="button" onClick={onDone} className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent">
            Cancel
          </button>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={saveToCatalog} onChange={(e) => setSaveToCatalog(e.target.checked)} className="h-3 w-3 rounded border-input" />
          Also save to catalog
        </label>
      </div>
    </form>
  );
}
