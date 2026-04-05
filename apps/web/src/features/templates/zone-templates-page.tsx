import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft, Trash2, Layers, ChevronRight, ChevronDown, Link, X, Search, BookOpen } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { toast } from 'sonner';

const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
const btnPrimary = 'flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50';
const btnSecondary = 'rounded-md border border-border px-4 py-2 text-sm hover:bg-accent';

const ZONE_TYPES = ['site', 'building', 'level', 'zone', 'area', 'section', 'wing', 'floor'] as const;

const ZONE_DISPLAY: Record<string, { color: string; label: string }> = {
  site: { color: '#6B7280', label: 'Site' },
  building: { color: '#3B82F6', label: 'Building' },
  level: { color: '#10B981', label: 'Level' },
  zone: { color: '#F59E0B', label: 'Zone' },
  area: { color: '#8B5CF6', label: 'Area' },
  section: { color: '#14B8A6', label: 'Section' },
  wing: { color: '#EC4899', label: 'Wing' },
  floor: { color: '#6B7280', label: 'Floor' },
};

// ---------------------------------------------------------------------------
// Zone Type Badge
// ---------------------------------------------------------------------------

function ZoneTypeBadge({ zoneType }: { zoneType: string }) {
  const display = ZONE_DISPLAY[zoneType] ?? { color: '#6B7280', label: zoneType };
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium text-white"
      style={{ backgroundColor: display.color }}
    >
      {display.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Add Zone Form (inline)
// ---------------------------------------------------------------------------

function AddZoneForm({
  templateId,
  parentId,
  onDone,
}: {
  templateId: number;
  parentId: number | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [zoneType, setZoneType] = useState<string>('zone');
  const [isTypical, setIsTypical] = useState(false);
  const [typicalCount, setTypicalCount] = useState('');

  const addMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      client.post(`/templates/${templateId}/zones`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'zone'] });
      toast.success('Zone added');
      onDone();
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to add zone'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    addMutation.mutate({
      name: name.trim(),
      code: code.trim() || undefined,
      zoneType,
      parentId: parentId ?? undefined,
      isTypical: isTypical || undefined,
      typicalCount: isTypical && typicalCount ? Number(typicalCount) : undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="mt-2 rounded-md border border-border bg-muted/30 p-3 space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div>
          <label className="block text-xs font-medium mb-1">Zone Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Level 01" className={inputClass} autoFocus />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Code</label>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. L01" className={inputClass} />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Zone Type</label>
          <select value={zoneType} onChange={(e) => setZoneType(e.target.value)} className={inputClass}>
            {ZONE_TYPES.map((zt) => (
              <option key={zt} value={zt}>{ZONE_DISPLAY[zt].label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Typical</label>
          <div className="flex items-center gap-2 mt-1">
            <input type="checkbox" checked={isTypical} onChange={(e) => setIsTypical(e.target.checked)} className="h-4 w-4 rounded border-input" />
            {isTypical && (
              <input
                type="number"
                min="1"
                value={typicalCount}
                onChange={(e) => setTypicalCount(e.target.value)}
                placeholder="Count"
                className={`${inputClass} w-20`}
              />
            )}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={addMutation.isPending} className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {addMutation.isPending ? 'Adding...' : 'Add Zone'}
        </button>
        <button type="button" onClick={onDone} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent">
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Add Zone Task Form (inline)
// ---------------------------------------------------------------------------

function AddZoneTaskForm({
  zoneId,
  templateId,
  phases,
  onDone,
}: {
  zoneId: number;
  templateId: number;
  phases: any[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [hours, setHours] = useState('');
  const [amount, setAmount] = useState('');
  const [phaseId, setPhaseId] = useState('');

  const addMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      client.post(`/templates/zones/${zoneId}/tasks`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      toast.success('Task added to zone');
      onDone();
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to add task'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !name.trim()) return;
    addMutation.mutate({
      code: code.trim(),
      name: name.trim(),
      defaultBudgetHours: hours ? Number(hours) : undefined,
      defaultBudgetAmount: amount ? Number(amount) : undefined,
      phaseId: phaseId ? Number(phaseId) : undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="mt-1 rounded-md border border-border bg-muted/30 p-2 space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
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
        <div>
          <label className="block text-xs font-medium mb-0.5">Phase</label>
          <select value={phaseId} onChange={(e) => setPhaseId(e.target.value)} className={inputClass}>
            <option value="">-- None --</option>
            {phases.map((p: any) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={addMutation.isPending} className="rounded-md bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {addMutation.isPending ? 'Adding...' : 'Add Task'}
        </button>
        <button type="button" onClick={onDone} className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent">
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Zone Catalog Picker Modal
// ---------------------------------------------------------------------------

function ZoneCatalogPickerModal({
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
  const [sortField, setSortField] = useState<'code' | 'name' | 'hours' | 'amount' | 'phase'>('name');
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
        case 'phase': valA = (a.phase?.name ?? '').toLowerCase(); valB = (b.phase?.name ?? '').toLowerCase(); break;
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
          phaseId: ct.phaseId,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      toast.success(`Added ${tasksToAdd.length} task${tasksToAdd.length !== 1 ? 's' : ''} to zone`);
      onClose();
    } catch (err: any) {
      toast.error(err?.response?.data?.error?.message || 'Failed to add tasks');
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
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-accent">
            <X className="h-5 w-5" />
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
                  <th className="px-3 py-2 text-left font-medium cursor-pointer select-none" onClick={() => handleSort('phase')}>Phase{sortIcon('phase')}</th>
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
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={alreadyExists}
                          onChange={() => toggleTask(task.id)}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{task.code || '-'}</td>
                      <td className="px-3 py-2 font-medium">{task.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{task.defaultBudgetHours != null ? Number(task.defaultBudgetHours).toFixed(0) : '-'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{task.defaultBudgetAmount != null ? Number(task.defaultBudgetAmount).toLocaleString() : '-'}</td>
                      <td className="px-3 py-2 text-muted-foreground">{task.phase?.name ?? '-'}</td>
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

// ---------------------------------------------------------------------------
// Zone Tasks Table (compact, displayed under zone node)
// ---------------------------------------------------------------------------

function ZoneTasksTable({
  tasks,
  templateId,
}: {
  tasks: any[];
  templateId: number;
}) {
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/templates/zone-tasks/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      toast.success('Task removed');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to delete task'),
  });

  if (tasks.length === 0) return null;

  return (
    <div className="mt-1 mb-1 ml-7">
      <div className="text-xs font-medium text-muted-foreground mb-0.5">Tasks:</div>
      <table className="w-full text-xs border border-border rounded-md overflow-hidden">
        <thead>
          <tr className="bg-muted/50 border-b border-border">
            <th className="px-2 py-1 text-left font-medium">Code</th>
            <th className="px-2 py-1 text-left font-medium">Name</th>
            <th className="px-2 py-1 text-right font-medium">Hours</th>
            <th className="px-2 py-1 text-right font-medium">Amount</th>
            <th className="px-2 py-1 text-left font-medium">Phase</th>
            <th className="px-2 py-1 text-center font-medium w-8"></th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task: any) => (
            <tr key={task.id} className="border-b border-border last:border-0 hover:bg-muted/30">
              <td className="px-2 py-1 font-mono text-muted-foreground">{task.code || '-'}</td>
              <td className="px-2 py-1 font-medium">{task.name}</td>
              <td className="px-2 py-1 text-right tabular-nums">
                {task.defaultBudgetHours != null ? `${Number(task.defaultBudgetHours).toFixed(0)}h` : '-'}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">
                {task.defaultBudgetAmount != null ? `\u20AA${Number(task.defaultBudgetAmount).toLocaleString()}` : '-'}
              </td>
              <td className="px-2 py-1 text-muted-foreground">{task.phase?.name ?? '-'}</td>
              <td className="px-2 py-1 text-center">
                <button
                  onClick={() => { if (confirm(`Remove task "${task.name}"?`)) deleteMutation.mutate(task.id); }}
                  className="rounded p-0.5 text-muted-foreground hover:bg-red-100 hover:text-red-600"
                  title="Remove task"
                >
                  <X className="h-3 w-3" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zone Tree Node (recursive)
// ---------------------------------------------------------------------------

function ZoneTreeNode({
  zone,
  templateId,
  taskTemplates,
  phases,
  depth,
}: {
  zone: any;
  templateId: number;
  taskTemplates: any[];
  phases: any[];
  depth: number;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(true);
  const [showAddChild, setShowAddChild] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [showCatalogPicker, setShowCatalogPicker] = useState(false);

  const children: any[] = zone.children ?? [];
  const zoneTasks: any[] = zone.templateZoneTasks ?? [];
  const hasChildren = children.length > 0;
  const hasContent = hasChildren || zoneTasks.length > 0;

  const existingTaskCodes = useMemo(
    () => new Set(zoneTasks.map((t: any) => t.code).filter(Boolean)),
    [zoneTasks],
  );

  const deleteMutation = useMutation({
    mutationFn: () => client.delete(`/templates/zones/${zone.id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'zone'] });
      toast.success('Zone deleted');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to delete zone'),
  });

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      client.patch(`/templates/zones/${zone.id}`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      toast.success('Zone updated');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to update zone'),
  });

  const handleLinkChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    updateMutation.mutate({ linkedTaskTemplateId: val ? Number(val) : null });
  };

  return (
    <div style={{ marginLeft: depth > 0 ? 20 : 0 }}>
      {/* Node row */}
      <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40">
        {/* Expand/collapse toggle */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          style={{ visibility: hasContent || showAddChild || showAddTask ? 'visible' : 'hidden' }}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        {/* Zone info */}
        <ZoneTypeBadge zoneType={zone.zoneType} />
        <span className="text-sm font-medium">{zone.name}</span>
        {zone.code && <span className="text-xs text-muted-foreground">({zone.code})</span>}
        {zone.isTypical && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
            Typical{zone.typicalCount ? ` x${zone.typicalCount}` : ''}
          </span>
        )}

        {/* Linked template badge */}
        {zone.linkedTaskTemplate && (
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
            <Link className="h-3 w-3" />
            {zone.linkedTaskTemplate.name}
          </span>
        )}

        {/* Actions (visible on hover) */}
        <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {/* Link service template dropdown */}
          <select
            value={zone.linkedTaskTemplate?.id ?? zone.linkedTaskTemplateId ?? ''}
            onChange={handleLinkChange}
            className="h-7 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            title="Link Service Template"
          >
            <option value="">-- Link Template --</option>
            {taskTemplates.map((tt: any) => (
              <option key={tt.id} value={tt.id}>{tt.name}</option>
            ))}
          </select>

          <button
            onClick={() => { setShowAddTask(true); setExpanded(true); }}
            className="rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Add task to zone"
          >
            + Add Task
          </button>

          <button
            onClick={() => setShowCatalogPicker(true)}
            className="rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Pick tasks from catalog"
          >
            <BookOpen className="inline h-3 w-3 mr-0.5" />
            Pick Catalog
          </button>

          <button
            onClick={() => setShowAddChild(true)}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Add child zone"
          >
            <Plus className="h-4 w-4" />
          </button>

          <button
            onClick={() => { if (confirm(`Delete zone "${zone.name}" and all its children?`)) deleteMutation.mutate(); }}
            className="rounded-md p-1 text-muted-foreground hover:bg-red-100 hover:text-red-600"
            title="Delete zone"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Zone tasks table */}
      {expanded && <ZoneTasksTable tasks={zoneTasks} templateId={templateId} />}

      {/* Inline add task form */}
      {expanded && showAddTask && (
        <div className="ml-7">
          <AddZoneTaskForm
            zoneId={zone.id}
            templateId={templateId}
            phases={phases}
            onDone={() => setShowAddTask(false)}
          />
        </div>
      )}

      {/* Children */}
      {expanded && (
        <>
          {children.map((child: any) => (
            <ZoneTreeNode
              key={child.id}
              zone={child}
              templateId={templateId}
              taskTemplates={taskTemplates}
              phases={phases}
              depth={depth + 1}
            />
          ))}
          {showAddChild && (
            <div style={{ marginLeft: 20 }}>
              <AddZoneForm templateId={templateId} parentId={zone.id} onDone={() => setShowAddChild(false)} />
            </div>
          )}
        </>
      )}

      {/* Catalog picker modal */}
      {showCatalogPicker && (
        <ZoneCatalogPickerModal
          zoneId={zone.id}
          templateId={templateId}
          existingTaskCodes={existingTaskCodes}
          onClose={() => setShowCatalogPicker(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor View
// ---------------------------------------------------------------------------

function EditorView({
  templateId,
  onBack,
}: {
  templateId: number;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [showAddRoot, setShowAddRoot] = useState(false);

  // ---- fetch template detail ----
  const { data: template, isLoading } = useQuery({
    queryKey: ['templates', templateId],
    queryFn: () => client.get(`/templates/${templateId}`).then((r) => r.data.data ?? r.data),
  });

  // ---- fetch service templates for linking (exclude task catalog) ----
  const { data: rawTaskTemplates = [] } = useQuery({
    queryKey: ['templates', 'task_list'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/templates?type=task_list').then((r) => r.data.data ?? r.data),
  });
  const taskTemplates = Array.isArray(rawTaskTemplates)
    ? rawTaskTemplates.filter((t: any) => t.code !== '__TASK_CATALOG__')
    : [];

  // ---- fetch phases for task form dropdown ----
  const { data: phases = [] } = useQuery({
    queryKey: ['phases'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/phases').then((r) => r.data.data ?? r.data),
  });

  // ---- header editing ----
  const [editingHeader, setEditingHeader] = useState(false);
  const [headerForm, setHeaderForm] = useState({ name: '', code: '', description: '' });

  const updateTemplateMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      client.patch(`/templates/${templateId}`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'zone'] });
      toast.success('Template updated');
      setEditingHeader(false);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to update template'),
  });

  const handleSaveHeader = (e: React.FormEvent) => {
    e.preventDefault();
    if (!headerForm.name.trim()) return;
    updateTemplateMutation.mutate({
      name: headerForm.name.trim(),
      code: headerForm.code.trim() || undefined,
      description: headerForm.description.trim() || undefined,
    });
  };

  const startEditingHeader = () => {
    if (!template) return;
    setHeaderForm({
      name: template.name ?? '',
      code: template.code ?? '',
      description: template.description ?? '',
    });
    setEditingHeader(true);
  };

  if (isLoading) return <TableSkeleton rows={5} cols={4} />;
  if (!template) return <div className="p-8 text-center text-muted-foreground">Template not found.</div>;

  const zones: any[] = template.templateZones ?? [];

  // Count all zones recursively
  function countZones(nodes: any[]): number {
    let count = 0;
    for (const n of nodes) {
      count += 1;
      if (n.children) count += countZones(n.children);
    }
    return count;
  }
  const totalZones = countZones(zones);

  return (
    <div className="space-y-6">
      {/* Back button */}
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to templates
      </button>

      {/* Template header */}
      {editingHeader ? (
        <form onSubmit={handleSaveHeader} className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Name *</label>
              <input value={headerForm.name} onChange={(e) => setHeaderForm((p) => ({ ...p, name: e.target.value }))} className={inputClass} autoFocus />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Code</label>
              <input value={headerForm.code} onChange={(e) => setHeaderForm((p) => ({ ...p, code: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <input value={headerForm.description} onChange={(e) => setHeaderForm((p) => ({ ...p, description: e.target.value }))} className={inputClass} />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={updateTemplateMutation.isPending} className={btnPrimary}>
              {updateTemplateMutation.isPending ? 'Saving...' : 'Save'}
            </button>
            <button type="button" onClick={() => setEditingHeader(false)} className={btnSecondary}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5 text-green-600" />
                <h2 className="text-lg font-semibold">{template.name}</h2>
                {template.code && <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">{template.code}</span>}
              </div>
              {template.description && <p className="mt-1 text-sm text-muted-foreground">{template.description}</p>}
              <p className="mt-1 text-xs text-muted-foreground">
                {totalZones} zone{totalZones !== 1 ? 's' : ''} &middot; Used {template.usageCount ?? 0} time{(template.usageCount ?? 0) !== 1 ? 's' : ''}
              </p>
            </div>
            <button onClick={startEditingHeader} className={btnSecondary}>Edit</button>
          </div>
        </div>
      )}

      {/* Zone tree editor */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Zone Tree</h3>
          {!showAddRoot && (
            <button onClick={() => setShowAddRoot(true)} className={btnPrimary}>
              <Plus className="h-4 w-4" /> Add Root Zone
            </button>
          )}
        </div>

        <div className="rounded-lg border border-border bg-background p-4">
          {zones.length === 0 && !showAddRoot ? (
            <div className="py-8 text-center">
              <Layers className="mx-auto h-10 w-10 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">No zones yet. Click "Add Root Zone" to start building the zone hierarchy.</p>
              <button onClick={() => setShowAddRoot(true)} className="mt-3 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
                <span className="flex items-center gap-2"><Plus className="h-4 w-4" /> Add Root Zone</span>
              </button>
            </div>
          ) : (
            <div className="space-y-0.5">
              {zones.map((z: any) => (
                <ZoneTreeNode
                  key={z.id}
                  zone={z}
                  templateId={templateId}
                  taskTemplates={taskTemplates as any[]}
                  phases={phases as any[]}
                  depth={0}
                />
              ))}
            </div>
          )}

          {showAddRoot && (
            <AddZoneForm templateId={templateId} parentId={null} onDone={() => setShowAddRoot(false)} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page (List View)
// ---------------------------------------------------------------------------

export function ZoneTemplatesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');

  const { data: templates, isLoading } = useQuery({
    queryKey: ['templates', 'zone'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=zone').then((r) => r.data.data ?? r.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; code?: string; description?: string; type: string }) =>
      client.post('/templates', data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', 'zone'] });
      toast.success('Zone template created');
      setShowForm(false);
      setName('');
      setCode('');
      setDescription('');
      setCategory('');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to create'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/templates/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', 'zone'] });
      toast.success('Template deleted');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to delete'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      code: code.trim() || undefined,
      description: description.trim() || undefined,
      type: 'zone',
    });
  };

  // ---- Editor View ----
  if (selectedTemplateId !== null) {
    return <EditorView templateId={selectedTemplateId} onBack={() => setSelectedTemplateId(null)} />;
  }

  // ---- List View ----
  const templateList = (templates ?? []) as any[];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/templates')} className="rounded-md p-1.5 hover:bg-accent">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <PageHeader
          title="Zone Templates"
          description="Reusable zone structures for projects"
          actions={
            <button onClick={() => setShowForm(!showForm)} className={btnPrimary}>
              <Plus className="h-4 w-4" /> New Template
            </button>
          }
        />
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Template Name *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Office Tower Standard" className={inputClass} autoFocus />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Code</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. ZT.OT.1" className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Brief description" className={inputClass} />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={createMutation.isPending} className={btnPrimary}>
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className={btnSecondary}>Cancel</button>
          </div>
        </form>
      )}

      {isLoading ? (
        <TableSkeleton rows={3} cols={4} />
      ) : templateList.length === 0 ? (
        <div className="rounded-lg border border-border bg-background p-8 text-center">
          <Layers className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-medium">No zone templates</h3>
          <p className="mt-1 text-sm text-muted-foreground">Create a template to save and reuse zone structures across projects.</p>
          <button onClick={() => setShowForm(true)} className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Create Template</button>
        </div>
      ) : (
        <div className="space-y-2">
          {templateList.map((t: any) => (
            <div
              key={t.id}
              className="flex items-center justify-between rounded-lg border border-border bg-background p-4 hover:bg-muted/30 cursor-pointer"
              onClick={() => setSelectedTemplateId(t.id)}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4 flex-shrink-0 text-green-600" />
                  <span className="text-sm font-medium">{t.name}</span>
                  {t.code && <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">{t.code}</span>}
                </div>
                {t.description && <p className="mt-1 text-sm text-muted-foreground">{t.description}</p>}
                <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{t._count?.templateZones ?? 0} zone{(t._count?.templateZones ?? 0) !== 1 ? 's' : ''}</span>
                  <span>&middot;</span>
                  <span>Used {t.usageCount ?? 0} time{(t.usageCount ?? 0) !== 1 ? 's' : ''}</span>
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${t.name}"?`)) deleteMutation.mutate(t.id);
                }}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-red-100 hover:text-red-600"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
