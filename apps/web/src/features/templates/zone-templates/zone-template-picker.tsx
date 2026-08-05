import { useState, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Search } from 'lucide-react';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { inputClass, btnPrimary, btnSecondary } from './constants';

// ---------------------------------------------------------------------------
// Zone Template Picker (pick from existing zone templates)
// ---------------------------------------------------------------------------

export function ZoneTemplatePicker({
  templateId,
  parentId,
  onDone,
}: {
  templateId: number;
  parentId: number | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);

  // Fetch all zone templates
  const { data: allZoneTemplates = [] } = useQuery({
    queryKey: ['templates', 'zone'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=zone').then((r) => r.data.data ?? r.data),
  });

  // Collect all referenced template IDs in the current template to prevent circular refs
  const { data: currentTemplate } = useQuery({
    queryKey: ['templates', templateId],
    queryFn: () => client.get(`/templates/${templateId}`).then((r) => r.data.data ?? r.data),
  });

  // Build set of IDs that would cause circular reference
  const blockedIds = useMemo(() => {
    // The only thing we strictly need to block is the template referencing
    // itself. Adding the same child template MULTIPLE times is the whole
    // point of the composition feature (e.g. add Floor template ×4 to a
    // Building template), so we deliberately don't block already-referenced
    // template ids. Real multi-hop cycles (A→B→A) are rare and the server
    // will reject them if they ever cause issues.
    const blocked = new Set<number>();
    blocked.add(templateId);
    return blocked;
  }, [templateId]);

  const available = useMemo(() => {
    const templates = (Array.isArray(allZoneTemplates) ? allZoneTemplates : [])
      .filter((t: any) => !blockedIds.has(t.id));
    if (!search.trim()) return templates;
    const q = search.toLowerCase();
    return templates.filter((t: any) => t.name?.toLowerCase().includes(q) || t.code?.toLowerCase().includes(q));
  }, [allZoneTemplates, blockedIds, search]);

  const addMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      client.post(`/templates/${templateId}/zones`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'zone'] });
      notify.success('Zone reference added', { code: 'ZONE-CREATE-200' });
      onDone();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add zone reference'),
  });

  const [selected, setSelected] = useState<Set<number>>(new Set());

  const handleSelect = async () => {
    const toAdd = available.filter((t: any) => selected.has(t.id));
    if (toAdd.length === 0) return;
    setAdding(true);
    try {
      for (const tpl of toAdd) {
        if (blockedIds.has(tpl.id)) continue;
        await client.post(`/templates/${templateId}/zones`, {
          name: tpl.name,
          code: tpl.code || undefined,
          zoneType: 'zone',
          parentId: parentId ?? undefined,
          referencedTemplateId: tpl.id,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'zone'] });
      notify.success(`Added ${toAdd.length} zone${toAdd.length > 1 ? 's' : ''}`, { code: 'ZONE-CREATE-200' });
      onDone();
    } catch (err: any) {
      notify.apiError(err, 'Failed to add zone');
    } finally {
      setAdding(false);
    }
  };

  const toggleZone = (id: number) => {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  return (
    <div className="mt-2 rounded-md border border-border bg-background p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Select Zone Templates</span>
        <button type="button" onClick={onDone} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">Cancel</button>
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search zone templates..." className={`${inputClass} pl-9`} autoFocus />
      </div>
      {available.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">
          {search ? 'No matching zone templates.' : 'No other zone templates available. Create one first.'}
        </p>
      ) : (
        <div className="max-h-64 overflow-y-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-xs">
                <th className="px-3 py-2 w-10"></th>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">Code</th>
                <th className="px-3 py-2 text-right font-medium">Zones</th>
                <th className="px-3 py-2 text-right font-medium">Services</th>
                <th className="px-3 py-2 text-right font-medium">Tasks</th>
              </tr>
            </thead>
            <tbody>
              {available.map((tpl: any) => {
                const isSelected = selected.has(tpl.id);
                return (
                  <tr
                    key={tpl.id}
                    className={`border-b border-border last:border-0 cursor-pointer ${isSelected ? 'bg-brand-50' : 'hover:bg-muted/30'}`}
                    onClick={() => toggleZone(tpl.id)}
                  >
                    <td className="px-3 py-2"><input type="checkbox" checked={isSelected} onChange={() => {}} className="h-4 w-4" /></td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <Layers className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                        <span className="font-medium">{tpl.name}</span>
                      </div>
                      {tpl.description && <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-xs">{tpl.description}</p>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{tpl.code || '-'}</td>
                    <td className="px-3 py-2 text-right">{tpl._count?.templateZones ?? 0}</td>
                    <td className="px-3 py-2 text-right">{new Set((tpl.templateTasks ?? []).map((tk: any) => tk.description?.match(/^\[SERVICE:(.+)\]$/)?.[1]).filter(Boolean)).size}</td>
                    <td className="px-3 py-2 text-right">{tpl._count?.templateTasks ?? tpl.templateTasks?.length ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center justify-between pt-1">
        <span className="text-xs text-muted-foreground">{available.length} available</span>
        <div className="flex gap-2">
          <button type="button" onClick={onDone} className={btnSecondary + ' text-xs'}>Cancel</button>
          <button type="button" onClick={handleSelect} disabled={selected.size === 0 || adding} className={btnPrimary + ' text-xs'}>
            {adding ? 'Adding...' : `Add ${selected.size} Zone${selected.size !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
