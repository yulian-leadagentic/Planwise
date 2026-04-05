import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft, Trash2, Copy } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { toast } from 'sonner';

const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
const btnPrimary = 'flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50';
const btnSecondary = 'rounded-md border border-border px-4 py-2 text-sm hover:bg-accent';

const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical'] as const;

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

  // ---- fetch template detail ----
  const { data: template, isLoading } = useQuery({
    queryKey: ['templates', templateId],
    queryFn: () => client.get(`/templates/${templateId}`).then((r) => r.data.data ?? r.data),
  });

  // ---- lookups ----
  const { data: serviceTypes = [] } = useQuery({
    queryKey: ['service-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/service-types').then((r) => r.data.data ?? r.data),
  });

  const { data: phases = [] } = useQuery({
    queryKey: ['phases'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/phases').then((r) => r.data.data ?? r.data),
  });

  // ---- header editing ----
  const [editingHeader, setEditingHeader] = useState(false);
  const [headerForm, setHeaderForm] = useState({ name: '', code: '', category: '', description: '' });

  const updateTemplateMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      client.patch(`/templates/${templateId}`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'task_list'] });
      toast.success('Template updated');
      setEditingHeader(false);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to update template'),
  });

  // ---- catalog picker ----
  const [showCatalogPicker, setShowCatalogPicker] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [selectedCatalogTasks, setSelectedCatalogTasks] = useState<Set<number>>(new Set());

  const { data: catalogRaw } = useQuery({
    queryKey: ['templates', 'task_list'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=task_list').then((r) => r.data.data ?? r.data),
    enabled: showCatalogPicker,
  });

  const catalogTemplate = (Array.isArray(catalogRaw) ? catalogRaw : []).find((t: any) => t.code === '__TASK_CATALOG__');

  const { data: catalogDetail } = useQuery({
    queryKey: ['templates', catalogTemplate?.id],
    queryFn: () => client.get(`/templates/${catalogTemplate.id}`).then((r) => r.data.data ?? r.data),
    enabled: !!catalogTemplate?.id && showCatalogPicker,
  });

  const catalogTasks: any[] = catalogDetail?.templateTasks ?? [];
  const filteredCatalogTasks = catalogSearch
    ? catalogTasks.filter((t: any) => t.name.toLowerCase().includes(catalogSearch.toLowerCase()) || t.code?.toLowerCase().includes(catalogSearch.toLowerCase()))
    : catalogTasks;

  const handlePickFromCatalog = async () => {
    const tasksToAdd = catalogTasks.filter((t: any) => selectedCatalogTasks.has(t.id));
    for (const t of tasksToAdd) {
      await addTaskMutation.mutateAsync({
        code: t.code,
        name: t.name,
        defaultBudgetHours: t.defaultBudgetHours ? Number(t.defaultBudgetHours) : undefined,
        defaultBudgetAmount: t.defaultBudgetAmount ? Number(t.defaultBudgetAmount) : undefined,
        serviceTypeId: t.serviceTypeId || undefined,
        phaseId: t.phaseId || undefined,
        defaultPriority: t.defaultPriority || undefined,
      });
    }
    setShowCatalogPicker(false);
    setSelectedCatalogTasks(new Set());
    setCatalogSearch('');
  };

  // ---- add task form ----
  const [showAddTask, setShowAddTask] = useState(false);
  const emptyTask = {
    code: '',
    name: '',
    defaultBudgetHours: '',
    defaultBudgetAmount: '',
    serviceTypeId: '',
    phaseId: '',
    defaultPriority: 'medium' as string,
  };
  const [newTask, setNewTask] = useState(emptyTask);

  const addTaskMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      client.post(`/templates/${templateId}/tasks`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'task_list'] });
      toast.success('Task added');
      setNewTask(emptyTask);
      setShowAddTask(false);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to add task'),
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: number) =>
      client.delete(`/templates/tasks/${taskId}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'task_list'] });
      toast.success('Task deleted');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to delete task'),
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

  // ---- handlers ----
  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.name.trim()) return;
    addTaskMutation.mutate({
      code: newTask.code.trim() || undefined,
      name: newTask.name.trim(),
      defaultBudgetHours: newTask.defaultBudgetHours ? Number(newTask.defaultBudgetHours) : undefined,
      defaultBudgetAmount: newTask.defaultBudgetAmount ? Number(newTask.defaultBudgetAmount) : undefined,
      serviceTypeId: newTask.serviceTypeId ? Number(newTask.serviceTypeId) : undefined,
      phaseId: newTask.phaseId ? Number(newTask.phaseId) : undefined,
      defaultPriority: newTask.defaultPriority || undefined,
    });
  };

  const handleSaveHeader = (e: React.FormEvent) => {
    e.preventDefault();
    if (!headerForm.name.trim()) return;
    updateTemplateMutation.mutate({
      name: headerForm.name.trim(),
      code: headerForm.code.trim() || undefined,
      category: headerForm.category.trim() || undefined,
      description: headerForm.description.trim() || undefined,
    });
  };

  const startEditingHeader = () => {
    if (!template) return;
    setHeaderForm({
      name: template.name ?? '',
      code: template.code ?? '',
      category: template.category ?? '',
      description: template.description ?? '',
    });
    setEditingHeader(true);
  };

  if (isLoading) return <TableSkeleton rows={5} cols={7} />;
  if (!template) return <div className="p-8 text-center text-muted-foreground">Template not found.</div>;

  return (
    <div className="space-y-6">
      {/* Back button */}
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to templates
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
              <label className="block text-sm font-medium mb-1">Category</label>
              <input value={headerForm.category} onChange={(e) => setHeaderForm((p) => ({ ...p, category: e.target.value }))} className={inputClass} />
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
                {template.category && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{template.category}</span>}
              </div>
              {template.description && <p className="mt-1 text-sm text-muted-foreground">{template.description}</p>}
              <p className="mt-1 text-xs text-muted-foreground">{tasks.length} task{tasks.length !== 1 ? 's' : ''} &middot; Used {template.usageCount ?? 0} time{(template.usageCount ?? 0) !== 1 ? 's' : ''}</p>
            </div>
            <button onClick={startEditingHeader} className={btnSecondary}>Edit</button>
          </div>
        </div>
      )}

      {/* Tasks table */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Template Tasks</h3>
          <div className="flex items-center gap-2">
            {!showAddTask && (
              <>
                <button onClick={() => setShowCatalogPicker(true)} className={btnSecondary}>
                  Pick from Catalog
                </button>
                <button onClick={() => setShowAddTask(true)} className={btnPrimary}>
                  <Plus className="h-4 w-4" /> Add Task
                </button>
              </>
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
                <th className="px-3 py-2 text-left font-medium">Service Type</th>
                <th className="px-3 py-2 text-left font-medium">Phase</th>
                <th className="px-3 py-2 text-left font-medium">Priority</th>
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
                  <td className="px-3 py-2">
                    <select value={newTask.serviceTypeId} onChange={(e) => setNewTask((p) => ({ ...p, serviceTypeId: e.target.value }))} className={inputClass}>
                      <option value="">-- none --</option>
                      {(serviceTypes as any[]).map((st: any) => (
                        <option key={st.id} value={st.id}>{st.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select value={newTask.phaseId} onChange={(e) => setNewTask((p) => ({ ...p, phaseId: e.target.value }))} className={inputClass}>
                      <option value="">-- none --</option>
                      {(phases as any[]).map((ph: any) => (
                        <option key={ph.id} value={ph.id}>{ph.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select value={newTask.defaultPriority} onChange={(e) => setNewTask((p) => ({ ...p, defaultPriority: e.target.value }))} className={inputClass}>
                      {PRIORITY_OPTIONS.map((p) => (
                        <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={handleAddTask} disabled={addTaskMutation.isPending} className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
                        {addTaskMutation.isPending ? 'Saving...' : 'Save'}
                      </button>
                      <button onClick={() => { setShowAddTask(false); setNewTask(emptyTask); }} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent">Cancel</button>
                    </div>
                  </td>
                </tr>
              )}

              {/* Existing tasks */}
              {tasks.length === 0 && !showAddTask && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                    No tasks yet. Click "Add Task" to get started.
                  </td>
                </tr>
              )}

              {tasks.map((task: any) => (
                <tr key={task.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-2 text-muted-foreground">{task.code || '-'}</td>
                  <td className="px-3 py-2 font-medium">{task.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{task.defaultBudgetHours != null ? Number(task.defaultBudgetHours).toFixed(1) : '-'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{task.defaultBudgetAmount != null ? Number(task.defaultBudgetAmount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}</td>
                  <td className="px-3 py-2">
                    {task.serviceType ? (
                      <span className="inline-flex items-center gap-1">
                        {task.serviceType.color && <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: task.serviceType.color }} />}
                        {task.serviceType.name}
                      </span>
                    ) : '-'}
                  </td>
                  <td className="px-3 py-2">{task.phase?.name ?? '-'}</td>
                  <td className="px-3 py-2">
                    {task.defaultPriority ? (
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                        task.defaultPriority === 'critical' ? 'bg-red-100 text-red-700' :
                        task.defaultPriority === 'high' ? 'bg-orange-100 text-orange-700' :
                        task.defaultPriority === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                        'bg-green-100 text-green-700'
                      }`}>
                        {task.defaultPriority.charAt(0).toUpperCase() + task.defaultPriority.slice(1)}
                      </span>
                    ) : '-'}
                  </td>
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
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2" />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Catalog Picker Modal */}
      {showCatalogPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[600px] max-h-[80vh] flex flex-col rounded-lg bg-background shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold">Pick Tasks from Catalog</h3>
              <button onClick={() => { setShowCatalogPicker(false); setSelectedCatalogTasks(new Set()); setCatalogSearch(''); }} className="text-muted-foreground hover:text-foreground">&times;</button>
            </div>
            <div className="px-4 py-2">
              <input value={catalogSearch} onChange={(e) => setCatalogSearch(e.target.value)} placeholder="Search tasks..." className={inputClass} />
            </div>
            <div className="flex-1 overflow-y-auto px-4">
              {filteredCatalogTasks.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{catalogTasks.length === 0 ? 'No tasks in catalog. Add tasks in the Task Catalog first.' : 'No tasks match your search.'}</p>
              ) : (
                filteredCatalogTasks.map((t: any) => (
                  <label key={t.id} className="flex items-center gap-3 py-2 border-b border-border last:border-0 cursor-pointer hover:bg-muted/30 px-1 rounded">
                    <input
                      type="checkbox"
                      checked={selectedCatalogTasks.has(t.id)}
                      onChange={() => {
                        const next = new Set(selectedCatalogTasks);
                        next.has(t.id) ? next.delete(t.id) : next.add(t.id);
                        setSelectedCatalogTasks(next);
                      }}
                      className="h-4 w-4 rounded border-input"
                    />
                    <span className="font-mono text-xs text-muted-foreground w-16">{t.code}</span>
                    <span className="flex-1 text-sm">{t.name}</span>
                    <span className="text-xs text-muted-foreground">{t.defaultBudgetHours ? `${Number(t.defaultBudgetHours)}h` : ''}</span>
                    <span className="text-xs text-muted-foreground">{t.defaultBudgetAmount ? `${Number(t.defaultBudgetAmount).toLocaleString()}` : ''}</span>
                  </label>
                ))
              )}
            </div>
            <div className="border-t border-border px-4 py-3 flex justify-end gap-2">
              <button onClick={() => { setShowCatalogPicker(false); setSelectedCatalogTasks(new Set()); }} className={btnSecondary}>Cancel</button>
              <button
                onClick={handlePickFromCatalog}
                disabled={selectedCatalogTasks.size === 0 || addTaskMutation.isPending}
                className={btnPrimary}
              >
                {addTaskMutation.isPending ? 'Adding...' : `Add ${selectedCatalogTasks.size} Selected Task${selectedCatalogTasks.size !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </div>
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
  const [category, setCategory] = useState('');

  // ---- list query ----
  const { data: templates, isLoading } = useQuery({
    queryKey: ['templates', 'task_list'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=task_list').then((r) => r.data.data ?? r.data),
  });

  // ---- create ----
  const createMutation = useMutation({
    mutationFn: (data: { name: string; code?: string; description?: string; category?: string; type: string }) =>
      client.post('/templates', data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', 'task_list'] });
      toast.success('Template created');
      setShowForm(false);
      setName('');
      setCode('');
      setDescription('');
      setCategory('');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to create'),
  });

  // ---- delete ----
  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/templates/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', 'task_list'] });
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
      category: category.trim() || undefined,
      type: 'task_list',
    });
  };

  // ---- Editor View ----
  if (selectedTemplateId !== null) {
    return <EditorView templateId={selectedTemplateId} onBack={() => setSelectedTemplateId(null)} />;
  }

  // ---- List View ----
  const templateList = ((templates ?? []) as any[]).filter((t: any) => t.code !== '__TASK_CATALOG__');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/templates')} className="rounded-md p-1.5 hover:bg-accent">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <PageHeader
          title="Service Templates"
          description="Groups of tasks from the catalog assigned to a service"
          actions={
            <button onClick={() => setShowForm(!showForm)} className={btnPrimary}>
              <Plus className="h-4 w-4" /> New Template
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
              <label className="block text-sm font-medium mb-1">Category</label>
              <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. BIM, MEP" className={inputClass} />
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
          <Copy className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-medium">No service templates</h3>
          <p className="mt-1 text-sm text-muted-foreground">Create a service template with tasks from the catalog.</p>
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
                  <Copy className="h-4 w-4 flex-shrink-0 text-brand-600" />
                  <span className="text-sm font-medium">{t.name}</span>
                  {t.code && <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">{t.code}</span>}
                  {t.category && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t.category}</span>}
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
