import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft, Trash2, Layers, ChevronRight, ChevronDown, Link, X, Search, BookOpen, Copy, CheckSquare } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { notify } from '@/lib/notify';

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
      notify.success('Zone added', { code: 'ZONE-CREATE-200' });
      onDone();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add zone'),
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
    if (!code.trim() || !name.trim()) return;
    const payload = {
      code: code.trim(),
      name: name.trim(),
      defaultBudgetHours: hours ? Number(hours) : undefined,
      defaultBudgetAmount: amount ? Number(amount) : undefined,
      phaseId: phaseId ? Number(phaseId) : undefined,
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
      } catch { /* ignore catalog errors */ }
    }
    addMutation.mutate(payload);
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
      notify.success('Task removed', { code: 'TASK-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete task'),
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
// Service Picker Modal
// ---------------------------------------------------------------------------

function ServicePickerModal({
  templates,
  currentLinkedId,
  onSelect,
  onClose,
}: {
  templates: any[];
  currentLinkedId?: number | null;
  onSelect: (serviceId: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="mx-4 w-full max-w-md rounded-lg border border-border bg-background shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold">Select Service Template</h2>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-3">
          {templates.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No service templates available. Create one first.</p>
          ) : (
            <div className="space-y-1">
              {templates.map((t: any) => (
                <button
                  key={t.id}
                  onClick={() => onSelect(t.id)}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors ${t.id === currentLinkedId ? 'bg-blue-50 ring-1 ring-blue-200' : 'hover:bg-muted/50'}`}
                >
                  <Copy className="h-4 w-4 shrink-0 text-blue-600" />
                  <div className="flex-1">
                    <span className="font-medium">{t.name}</span>
                    {t.code && <span className="ml-2 text-xs text-muted-foreground">({t.code})</span>}
                    <p className="text-xs text-muted-foreground">{t._count?.templateTasks ?? 0} tasks</p>
                  </div>
                  {t.id === currentLinkedId && <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">current</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
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
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showServicePicker, setShowServicePicker] = useState(false);

  const children: any[] = zone.children ?? [];
  const zoneTasks: any[] = zone.templateZoneTasks ?? [];
  const linkedService = zone.linkedTaskTemplate;

  const existingTaskCodes = useMemo(
    () => new Set(zoneTasks.map((t: any) => t.code).filter(Boolean)),
    [zoneTasks],
  );

  const deleteTaskMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/templates/zone-tasks/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      notify.success('Task removed', { code: 'TASK-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove task'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => client.delete(`/templates/zones/${zone.id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'zone'] });
      notify.success('Zone deleted', { code: 'ZONE-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete zone'),
  });

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      client.patch(`/templates/zones/${zone.id}`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      notify.success('Zone updated', { code: 'ZONE-UPDATE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update zone'),
  });

  const handleLinkChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    updateMutation.mutate({ linkedTaskTemplateId: val ? Number(val) : null });
  };

  return (
    <div style={{ marginLeft: depth > 0 ? 24 : 0 }}>
      {/* Zone header row */}
      <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 mb-1">
        <button onClick={() => setExpanded(!expanded)} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <ZoneTypeBadge zoneType={zone.zoneType} />
        <span className="text-sm font-semibold">{zone.name}</span>
        {zone.code && <span className="text-xs text-muted-foreground">({zone.code})</span>}
        {zone.isTypical && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
            Typical{zone.typicalCount ? ` x${zone.typicalCount}` : ''}
          </span>
        )}

        {/* [+ Add] dropdown */}
        <div className="relative ml-auto">
          <button
            onClick={() => setShowAddMenu(!showAddMenu)}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
          {showAddMenu && (
            <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-md border border-border bg-background shadow-lg">
              <button onClick={() => { setShowAddChild(true); setShowAddMenu(false); setExpanded(true); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left">
                <Layers className="h-3.5 w-3.5 text-amber-600" /> Zone
              </button>
              <button onClick={() => { setShowServicePicker(true); setShowAddMenu(false); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left">
                <Copy className="h-3.5 w-3.5 text-blue-600" /> Service Template
              </button>
              <button onClick={() => { setShowCatalogPicker(true); setShowAddMenu(false); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left">
                <CheckSquare className="h-3.5 w-3.5 text-green-600" /> Task from Catalog
              </button>
              <button onClick={() => { setShowAddTask(true); setShowAddMenu(false); setExpanded(true); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left border-t border-border">
                <Plus className="h-3.5 w-3.5 text-muted-foreground" /> Manual Task
              </button>
            </div>
          )}
        </div>

        <button
          onClick={() => { if (confirm(`Delete zone "${zone.name}" and all its children?`)) deleteMutation.mutate(); }}
          className="rounded-md p-1 text-muted-foreground hover:bg-red-100 hover:text-red-600"
          title="Delete zone"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Tree items (expanded) */}
      {expanded && (
        <div className="ml-6 border-l-2 border-border pl-3 space-y-0.5 mb-2">
          {/* Service template item */}
          {linkedService && (
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-blue-50">
              <Copy className="h-3.5 w-3.5 shrink-0 text-blue-600" />
              <span className="text-sm text-blue-700 font-medium">Service: {linkedService.name}</span>
              {linkedService.code && <span className="text-xs text-blue-500">({linkedService.code})</span>}
              <button
                onClick={() => updateMutation.mutate({ linkedTaskTemplateId: null })}
                className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-red-100 hover:text-red-600"
                title="Unlink service template"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* Task items */}
          {zoneTasks.map((task: any) => (
            <div key={task.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-green-50">
              <CheckSquare className="h-3.5 w-3.5 shrink-0 text-green-600" />
              <span className="font-mono text-xs text-muted-foreground w-16">{task.code || '-'}</span>
              <span className="text-sm">{task.name}</span>
              {task.defaultBudgetHours != null && <span className="text-xs text-muted-foreground">{Number(task.defaultBudgetHours)}h</span>}
              {task.defaultBudgetAmount != null && <span className="text-xs text-muted-foreground">{'\u20AA'}{Number(task.defaultBudgetAmount).toLocaleString()}</span>}
              {task.phase?.name && <span className="text-xs text-muted-foreground">({task.phase.name})</span>}
              <button
                onClick={() => { if (confirm(`Remove task "${task.name}"?`)) deleteTaskMutation.mutate(task.id); }}
                className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-red-100 hover:text-red-600"
                title="Remove task"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}

          {/* Child zones (recursive) */}
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

          {/* Inline add zone form */}
          {showAddChild && (
            <div className="mt-1">
              <AddZoneForm templateId={templateId} parentId={zone.id} onDone={() => setShowAddChild(false)} />
            </div>
          )}

          {/* Inline add task form */}
          {showAddTask && (
            <div className="mt-1">
              <AddZoneTaskForm zoneId={zone.id} templateId={templateId} phases={phases} onDone={() => setShowAddTask(false)} />
            </div>
          )}

          {/* Empty state */}
          {!linkedService && zoneTasks.length === 0 && children.length === 0 && !showAddChild && !showAddTask && (
            <p className="py-2 text-xs text-muted-foreground italic">No items. Click [+ Add] to add zones, services, or tasks.</p>
          )}
        </div>
      )}

      {/* Service picker modal */}
      {showServicePicker && (
        <ServicePickerModal
          templates={taskTemplates}
          currentLinkedId={zone.linkedTaskTemplate?.id ?? zone.linkedTaskTemplateId}
          onSelect={(serviceId) => {
            updateMutation.mutate({ linkedTaskTemplateId: serviceId });
            setShowServicePicker(false);
          }}
          onClose={() => setShowServicePicker(false)}
        />
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
// Root-level Service Picker (creates zone + links service)
// ---------------------------------------------------------------------------

function RootServicePickerModal({
  templateId,
  templates,
  onClose,
}: {
  templateId: number;
  templates: any[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  const handleSelect = async (serviceTemplate: any) => {
    setAdding(true);
    try {
      // Create a root zone named after the service template and link it
      await client.post(`/templates/${templateId}/zones`, {
        name: serviceTemplate.name,
        zoneType: 'zone',
        linkedTaskTemplateId: serviceTemplate.id,
      });
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      notify.success(`Added service: ${serviceTemplate.name}`, { code: 'ZONE-CREATE-200' });
      onClose();
    } catch (err: any) {
      notify.apiError(err, 'Failed to add service');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="mx-4 w-full max-w-md rounded-lg border border-border bg-background shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold">Add Service Template</h2>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-3">
          {templates.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No service templates available.</p>
          ) : (
            <div className="space-y-1">
              {templates.map((t: any) => (
                <button
                  key={t.id}
                  onClick={() => handleSelect(t)}
                  disabled={adding}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-muted/50 disabled:opacity-50"
                >
                  <Copy className="h-4 w-4 shrink-0 text-blue-600" />
                  <div className="flex-1">
                    <span className="font-medium">{t.name}</span>
                    {t.code && <span className="ml-2 text-xs text-muted-foreground">({t.code})</span>}
                    <p className="text-xs text-muted-foreground">{t._count?.templateTasks ?? 0} tasks</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root-level Catalog Picker (creates zone + adds tasks)
// ---------------------------------------------------------------------------

function RootCatalogPickerModal({
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
  const [zoneName, setZoneName] = useState('');

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
    if (!zoneName.trim()) { notify.warning('Enter a zone name', { code: 'ZONE-CREATE-400' }); return; }
    const tasksToAdd = catalogTasks.filter((t: any) => selected.has(t.id));
    if (tasksToAdd.length === 0) return;
    setAdding(true);
    try {
      // Create a zone to hold the tasks
      const zoneRes = await client.post(`/templates/${templateId}/zones`, {
        name: zoneName.trim(),
        zoneType: 'zone',
      });
      const newZone = zoneRes.data.data ?? zoneRes.data;
      // Add tasks to the zone
      for (const t of tasksToAdd) {
        await client.post(`/templates/zones/${newZone.id}/tasks`, {
          code: t.code,
          name: t.name,
          defaultBudgetHours: t.defaultBudgetHours,
          defaultBudgetAmount: t.defaultBudgetAmount,
          phaseId: t.phaseId,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      notify.success(`Added ${tasksToAdd.length} tasks to zone "${zoneName.trim()}"`, { code: 'TASK-ADD-200' });
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
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>
        <div className="border-b border-border px-5 py-3 space-y-2">
          <div>
            <label className="block text-xs font-medium mb-1">Zone Name * (tasks will be placed in this zone)</label>
            <input value={zoneName} onChange={(e) => setZoneName(e.target.value)} placeholder="e.g. General Tasks" className={inputClass} />
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks..." className={`${inputClass} pl-9`} />
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
          <button onClick={handleAddSelected} disabled={selected.size === 0 || !zoneName.trim() || adding} className={btnPrimary}>
            {adding ? 'Adding...' : `Add ${selected.size} Task${selected.size !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
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
  const [showRootAddMenu, setShowRootAddMenu] = useState(false);
  const [showRootServicePicker, setShowRootServicePicker] = useState(false);
  const [showRootCatalogPicker, setShowRootCatalogPicker] = useState(false);
  const [showRootManualTask, setShowRootManualTask] = useState(false);

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
      notify.success('Template updated', { code: 'TPL-UPDATE-200' });
      setEditingHeader(false);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update template'),
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
          <h3 className="text-sm font-semibold">Template Items</h3>
          <div className="relative">
            <button onClick={() => setShowRootAddMenu(!showRootAddMenu)} className={btnPrimary}>
              <Plus className="h-4 w-4" /> Add
            </button>
            {showRootAddMenu && (
              <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-border bg-background shadow-lg">
                <button onClick={() => { setShowAddRoot(true); setShowRootAddMenu(false); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left">
                  <Layers className="h-3.5 w-3.5 text-amber-600" /> Zone
                </button>
                <button onClick={() => { setShowRootServicePicker(true); setShowRootAddMenu(false); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left">
                  <Copy className="h-3.5 w-3.5 text-blue-600" /> Service Template
                </button>
                <button onClick={() => { setShowRootCatalogPicker(true); setShowRootAddMenu(false); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left">
                  <CheckSquare className="h-3.5 w-3.5 text-green-600" /> Task from Catalog
                </button>
                <button onClick={() => { setShowRootManualTask(true); setShowRootAddMenu(false); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left border-t border-border">
                  <Plus className="h-3.5 w-3.5 text-muted-foreground" /> Manual Task
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-background p-4">
          {/* Root-level service templates (zones with linkedTaskTemplate that are auto-created) */}
          {zones.length === 0 && !showAddRoot && !showRootManualTask ? (
            <div className="py-8 text-center">
              <Layers className="mx-auto h-10 w-10 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">No items yet. Click [+ Add] to add zones, service templates, or tasks.</p>
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

          {showRootManualTask && zones.length > 0 && (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-3">
              <p className="text-xs text-amber-700 mb-2">Tasks must belong to a zone. Select a zone above and use its [+ Add] button, or create a zone first.</p>
              <button onClick={() => setShowRootManualTask(false)} className={btnSecondary + ' text-xs'}>OK</button>
            </div>
          )}
          {showRootManualTask && zones.length === 0 && (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-3">
              <p className="text-xs text-amber-700 mb-2">Create a zone first, then add tasks to it.</p>
              <button onClick={() => { setShowRootManualTask(false); setShowAddRoot(true); }} className={btnPrimary + ' text-xs'}>
                <Plus className="h-3 w-3" /> Create Zone
              </button>
              <button onClick={() => setShowRootManualTask(false)} className={btnSecondary + ' text-xs ml-2'}>Cancel</button>
            </div>
          )}
        </div>
      </div>

      {/* Root-level Service Picker */}
      {showRootServicePicker && (
        <RootServicePickerModal
          templateId={templateId}
          templates={taskTemplates as any[]}
          onClose={() => setShowRootServicePicker(false)}
        />
      )}

      {/* Root-level Catalog Picker */}
      {showRootCatalogPicker && (
        <RootCatalogPickerModal
          templateId={templateId}
          onClose={() => setShowRootCatalogPicker(false)}
        />
      )}
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
      notify.success('Zone template created', { code: 'TPL-CREATE-200' });
      setShowForm(false);
      setName('');
      setCode('');
      setDescription('');
      setCategory('');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/templates/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', 'zone'] });
      notify.success('Template deleted', { code: 'TPL-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete'),
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
