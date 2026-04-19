import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft, Trash2, Copy, Search, X, BookOpen } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { notify } from '@/lib/notify';

const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
const btnPrimary = 'flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50';
const btnSecondary = 'rounded-md border border-border px-4 py-2 text-sm hover:bg-accent';

// ---------------------------------------------------------------------------
// Catalog Picker Modal
// ---------------------------------------------------------------------------

function CatalogPickerModal({
  templateId,
  existingTaskCodes,
  onClose,
}: {
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
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  };

  const sortIcon = (field: typeof sortField) => sortField === field ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

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
        await client.post(`/templates/${templateId}/tasks`, {
          code: ct.code,
          name: ct.name,
          defaultBudgetHours: ct.defaultBudgetHours,
          defaultBudgetAmount: ct.defaultBudgetAmount,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'task_list'] });
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
  const [showCatalogPicker, setShowCatalogPicker] = useState(false);

  const { data: template, isLoading } = useQuery({
    queryKey: ['templates', templateId],
    queryFn: () => client.get(`/templates/${templateId}`).then((r) => r.data.data ?? r.data),
  });

  const { data: phases = [] } = useQuery({
    queryKey: ['phases'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/phases').then((r) => r.data.data ?? r.data),
  });

  // ---- header editing ----
  const [editingHeader, setEditingHeader] = useState(false);
  const [headerForm, setHeaderForm] = useState({ name: '', code: '', description: '', phaseId: '' });

  const updateTemplateMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      client.patch(`/templates/${templateId}`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'task_list'] });
      notify.success('Template updated', { code: 'TPL-UPDATE-200' });
      setEditingHeader(false);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update template'),
  });

  // ---- add task form ----
  const [showAddTask, setShowAddTask] = useState(false);
  const [addToCatalog, setAddToCatalog] = useState(true);
  const emptyTask = { code: '', name: '', defaultBudgetHours: '', defaultBudgetAmount: '' };
  const [newTask, setNewTask] = useState(emptyTask);

  const addTaskMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      client.post(`/templates/${templateId}/tasks`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'task_list'] });
      notify.success('Task added', { code: 'TASK-ADD-200' });
      setNewTask(emptyTask);
      setShowAddTask(false);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add task'),
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: number) =>
      client.delete(`/templates/tasks/${taskId}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'task_list'] });
      notify.success('Task deleted', { code: 'TASK-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete task'),
  });

  // ---- totals ----
  const tasks: any[] = template?.templateTasks ?? [];
  const totals = useMemo(() => {
    let hours = 0;
    let amount = 0;
    for (const t of tasks) {
      hours += Number(t.defaultBudgetHours) || 0;
      amount += Number(t.defaultBudgetAmount) || 0;
    }
    return { hours, amount };
  }, [tasks]);

  const existingTaskCodes = useMemo(
    () => new Set(tasks.map((t: any) => t.code).filter(Boolean)),
    [tasks],
  );

  // ---- handlers ----
  const handleAddTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.name.trim()) return;
    const payload = {
      code: newTask.code.trim() || undefined,
      name: newTask.name.trim(),
      defaultBudgetHours: newTask.defaultBudgetHours ? Number(newTask.defaultBudgetHours) : undefined,
      defaultBudgetAmount: newTask.defaultBudgetAmount ? Number(newTask.defaultBudgetAmount) : undefined,
    };
    // Also add to catalog if checkbox is checked
    if (addToCatalog) {
      try {
        const allTpls = await client.get('/templates?type=task_list').then((r) => r.data.data ?? r.data);
        const catalog = (Array.isArray(allTpls) ? allTpls : []).find((t: any) => t.code === '__TASK_CATALOG__');
        if (catalog) {
          await client.post(`/templates/${catalog.id}/tasks`, payload);
          queryClient.invalidateQueries({ queryKey: ['templates', catalog.id] });
        }
      } catch { /* ignore catalog errors */ }
    }
    addTaskMutation.mutate(payload);
  };

  const handleSaveHeader = (e: React.FormEvent) => {
    e.preventDefault();
    if (!headerForm.name.trim()) return;
    updateTemplateMutation.mutate({
      name: headerForm.name.trim(),
      code: headerForm.code.trim() || undefined,
      description: headerForm.description.trim() || undefined,
      phaseId: headerForm.phaseId ? Number(headerForm.phaseId) : null,
    });
  };

  const startEditingHeader = () => {
    if (!template) return;
    setHeaderForm({
      name: template.name ?? '',
      code: template.code ?? '',
      description: template.description ?? '',
      phaseId: template.phaseId ? String(template.phaseId) : '',
    });
    setEditingHeader(true);
  };

  if (isLoading) return <TableSkeleton rows={5} cols={5} />;
  if (!template) return <div className="p-8 text-center text-muted-foreground">Template not found.</div>;

  return (
    <div className="space-y-6">
      {/* Back button */}
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to phase/milestone templates
      </button>

      {/* Template header */}
      {editingHeader ? (
        <form onSubmit={handleSaveHeader} className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Name *</label>
              <input value={headerForm.name} onChange={(e) => setHeaderForm((p) => ({ ...p, name: e.target.value }))} className={inputClass} autoFocus />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Code</label>
              <input value={headerForm.code} onChange={(e) => setHeaderForm((p) => ({ ...p, code: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Service</label>
              <select value={headerForm.phaseId} onChange={(e) => setHeaderForm((p) => ({ ...p, phaseId: e.target.value }))} className={inputClass}>
                <option value="">-- none --</option>
                {(phases as any[]).map((ph: any) => (
                  <option key={ph.id} value={ph.id}>{ph.name}{ph.code ? ` (${ph.code})` : ''}</option>
                ))}
              </select>
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
                <Copy className="h-5 w-5 text-brand-600" />
                <h2 className="text-lg font-semibold">{template.name}</h2>
                {template.code && <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">{template.code}</span>}
                {template.phase && <span className="rounded-full bg-cyan-100 px-2 py-0.5 text-xs font-medium text-cyan-700">{template.phase.name}</span>}
              </div>
              {template.description && <p className="mt-1 text-sm text-muted-foreground">{template.description}</p>}
              <p className="mt-1 text-xs text-muted-foreground">{tasks.length} task{tasks.length !== 1 ? 's' : ''} &middot; Used {template.usageCount ?? 0} time{(template.usageCount ?? 0) !== 1 ? 's' : ''}</p>
            </div>
            <button onClick={startEditingHeader} className={btnSecondary}>Edit</button>
          </div>
        </div>
      )}

      {/* Tasks table — phase column removed (phase is now at template level) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Template Tasks</h3>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowCatalogPicker(true)} className={btnSecondary + ' flex items-center gap-2'}>
              <BookOpen className="h-4 w-4" /> Pick from Catalog
            </button>
            {!showAddTask && (
              <button onClick={() => setShowAddTask(true)} className={btnPrimary}>
                <Plus className="h-4 w-4" /> Add Task
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-3 py-2 text-left font-medium">Code</th>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-right font-medium">Hours</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 text-center font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {/* Add task row */}
              {showAddTask && (
                <tr className="border-b border-border bg-brand-50/40">
                  <td className="px-3 py-2">
                    <input value={newTask.code} onChange={(e) => setNewTask((p) => ({ ...p, code: e.target.value }))} placeholder="Code" className={inputClass} />
                  </td>
                  <td className="px-3 py-2">
                    <input value={newTask.name} onChange={(e) => setNewTask((p) => ({ ...p, name: e.target.value }))} placeholder="Task name *" className={inputClass} autoFocus />
                  </td>
                  <td className="px-3 py-2">
                    <input type="number" step="any" min="0" value={newTask.defaultBudgetHours} onChange={(e) => setNewTask((p) => ({ ...p, defaultBudgetHours: e.target.value }))} placeholder="0" className={`${inputClass} text-right`} />
                  </td>
                  <td className="px-3 py-2">
                    <input type="number" step="any" min="0" value={newTask.defaultBudgetAmount} onChange={(e) => setNewTask((p) => ({ ...p, defaultBudgetAmount: e.target.value }))} placeholder="0" className={`${inputClass} text-right`} />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="flex flex-col items-center gap-1.5">
                      <div className="flex items-center gap-1">
                        <button onClick={handleAddTask} disabled={addTaskMutation.isPending} className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
                          {addTaskMutation.isPending ? 'Saving...' : 'Save'}
                        </button>
                        <button onClick={() => { setShowAddTask(false); setNewTask(emptyTask); }} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent">Cancel</button>
                      </div>
                      <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer">
                        <input type="checkbox" checked={addToCatalog} onChange={(e) => setAddToCatalog(e.target.checked)} className="h-3 w-3 rounded border-input" />
                        Also add to catalog
                      </label>
                    </div>
                  </td>
                </tr>
              )}

              {/* Existing tasks */}
              {tasks.length === 0 && !showAddTask && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    No tasks yet. Click "Add Task" or "Pick from Catalog" to get started.
                  </td>
                </tr>
              )}

              {tasks.map((task: any) => (
                <tr key={task.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-2 text-muted-foreground">{task.code || '-'}</td>
                  <td className="px-3 py-2 font-medium">{task.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{task.defaultBudgetHours != null ? Number(task.defaultBudgetHours).toFixed(1) : '-'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{task.defaultBudgetAmount != null ? Number(task.defaultBudgetAmount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}</td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => { if (confirm(`Delete task "${task.name}"?`)) deleteTaskMutation.mutate(task.id); }}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-red-100 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}

              {/* Totals row */}
              {tasks.length > 0 && (
                <tr className="border-t-2 border-border bg-muted/50 font-semibold">
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-right">Totals</td>
                  <td className="px-3 py-2 text-right tabular-nums">{totals.hours.toFixed(1)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{totals.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td className="px-3 py-2" />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Catalog picker modal */}
      {showCatalogPicker && (
        <CatalogPickerModal
          templateId={templateId}
          existingTaskCodes={existingTaskCodes}
          onClose={() => setShowCatalogPicker(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function ServiceTemplatesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [phaseId, setPhaseId] = useState('');

  const { data: templates, isLoading } = useQuery({
    queryKey: ['templates', 'task_list'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=task_list').then((r) => r.data.data ?? r.data),
  });

  const { data: phases = [] } = useQuery({
    queryKey: ['phases'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/phases').then((r) => r.data.data ?? r.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; code?: string; description?: string; phaseId?: number; type: string }) =>
      client.post('/templates', data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', 'task_list'] });
      notify.success('Phase/Milestone template created', { code: 'TPL-CREATE-200' });
      setShowForm(false);
      setName('');
      setCode('');
      setDescription('');
      setPhaseId('');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/templates/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', 'task_list'] });
      notify.success('Phase/Milestone template deleted', { code: 'TPL-DELETE-200' });
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
      phaseId: phaseId ? Number(phaseId) : undefined,
      type: 'task_list',
    });
  };

  if (selectedTemplateId !== null) {
    return <EditorView templateId={selectedTemplateId} onBack={() => setSelectedTemplateId(null)} />;
  }

  const templateList = ((templates ?? []) as any[]).filter((t: any) => t.code !== '__TASK_CATALOG__');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/templates')} className="rounded-md p-1.5 hover:bg-accent">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <PageHeader
          title="Phase/Milestone Templates"
          description="Groups of tasks from the catalog assigned to a phase or milestone"
          actions={
            <button onClick={() => setShowForm(!showForm)} className={btnPrimary}>
              <Plus className="h-4 w-4" /> New Phase/Milestone Template
            </button>
          }
        />
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Template Name *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. BIM Coordination Standard" className={inputClass} autoFocus />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Code</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. BC.S.1" className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Service</label>
              <select value={phaseId} onChange={(e) => setPhaseId(e.target.value)} className={inputClass}>
                <option value="">-- none --</option>
                {(phases as any[]).map((ph: any) => (
                  <option key={ph.id} value={ph.id}>{ph.name}{ph.code ? ` (${ph.code})` : ''}</option>
                ))}
              </select>
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
        <TableSkeleton rows={3} cols={3} />
      ) : templateList.length === 0 ? (
        <div className="rounded-lg border border-border bg-background p-8 text-center">
          <Copy className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-medium">No phase/milestone templates</h3>
          <p className="mt-1 text-sm text-muted-foreground">Create a phase/milestone template to group tasks from the catalog.</p>
          <button onClick={() => setShowForm(true)} className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Create Phase/Milestone Template</button>
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
                  <Copy className="h-4 w-4 flex-shrink-0 text-brand-600" />
                  <span className="text-sm font-medium">{t.name}</span>
                  {t.code && <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">{t.code}</span>}
                  {t.phase && <span className="rounded-full bg-cyan-100 px-2 py-0.5 text-xs font-medium text-cyan-700">{t.phase.name}</span>}
                </div>
                {t.description && <p className="mt-1 text-sm text-muted-foreground">{t.description}</p>}
                <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{t._count?.templateTasks ?? 0} task{(t._count?.templateTasks ?? 0) !== 1 ? 's' : ''}</span>
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
