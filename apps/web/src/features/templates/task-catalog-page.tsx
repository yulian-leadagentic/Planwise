import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2, Pencil, BookOpen } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { notify } from '@/lib/notify';

const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
const btnPrimary = 'flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50';

type SortField = 'code' | 'name' | 'defaultBudgetHours' | 'defaultBudgetAmount';
type SortDir = 'asc' | 'desc';

const emptyTask = {
  code: '',
  name: '',
  description: '',
  defaultBudgetHours: '',
  defaultBudgetAmount: '',
};

type TaskForm = typeof emptyTask;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getOrCreateCatalog() {
  const res = await client.get('/templates?type=task_list');
  const templates = res.data.data ?? res.data;
  const catalog = (Array.isArray(templates) ? templates : []).find((t: any) => t.code === '__TASK_CATALOG__');
  if (catalog) return catalog;
  const created = await client.post('/templates', { code: '__TASK_CATALOG__', name: 'Task Catalog', type: 'task_list' });
  return created.data.data ?? created.data;
}

function compareTasks(a: any, b: any, field: SortField, dir: SortDir): number {
  let valA: any;
  let valB: any;

  switch (field) {
    case 'code':
    case 'name':
      valA = (a[field] ?? '').toLowerCase();
      valB = (b[field] ?? '').toLowerCase();
      break;
    case 'defaultBudgetHours':
    case 'defaultBudgetAmount':
      valA = Number(a[field]) || 0;
      valB = Number(b[field]) || 0;
      break;
  }

  if (valA < valB) return dir === 'asc' ? -1 : 1;
  if (valA > valB) return dir === 'asc' ? 1 : -1;
  return 0;
}

// ---------------------------------------------------------------------------
// TaskCatalogPage
// ---------------------------------------------------------------------------

export function TaskCatalogPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // ---- state ----
  const [showAddTask, setShowAddTask] = useState(false);
  const [newTask, setNewTask] = useState<TaskForm>({ ...emptyTask });
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<TaskForm>({ ...emptyTask });
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // ---- find or create the catalog template ----
  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: ['task-catalog-meta'],
    staleTime: 10 * 60 * 1000,
    queryFn: getOrCreateCatalog,
  });

  const catalogId: number | undefined = catalog?.id;

  // ---- fetch catalog detail (tasks) ----
  const { data: catalogDetail, isLoading: detailLoading } = useQuery({
    queryKey: ['templates', catalogId],
    enabled: !!catalogId,
    queryFn: () => client.get(`/templates/${catalogId}`).then((r) => r.data.data ?? r.data),
  });

  // ---- mutations ----
  const invalidateCatalog = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['templates', catalogId] });
    queryClient.invalidateQueries({ queryKey: ['task-catalog-meta'] });
  }, [queryClient, catalogId]);

  const addTaskMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      client.post(`/templates/${catalogId}/tasks`, data).then((r) => r.data),
    onSuccess: () => {
      invalidateCatalog();
      notify.success('Task added to catalog', { code: 'TASK-ADD-200' });
      setNewTask({ ...emptyTask });
      setShowAddTask(false);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add task'),
  });

  const updateTaskMutation = useMutation({
    mutationFn: ({ taskId, data }: { taskId: number; data: Record<string, any> }) =>
      client.patch(`/templates/tasks/${taskId}`, data).then((r) => r.data),
    onSuccess: () => {
      invalidateCatalog();
      notify.success('Task updated', { code: 'TASK-UPDATE-200' });
      setEditingTaskId(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update task'),
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: number) =>
      client.delete(`/templates/tasks/${taskId}`).then((r) => r.data),
    onSuccess: () => {
      invalidateCatalog();
      notify.success('Task deleted', { code: 'TASK-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete task'),
  });

  // ---- derived data ----
  const allTasks: any[] = catalogDetail?.templateTasks ?? [];

  const filteredTasks = useMemo(() => {
    const q = search.toLowerCase().trim();
    let result = allTasks;
    if (q) {
      result = allTasks.filter(
        (t: any) =>
          (t.code ?? '').toLowerCase().includes(q) ||
          (t.name ?? '').toLowerCase().includes(q),
      );
    }
    return [...result].sort((a, b) => compareTasks(a, b, sortField, sortDir));
  }, [allTasks, search, sortField, sortDir]);

  const totals = useMemo(() => {
    let hours = 0;
    let amount = 0;
    for (const t of filteredTasks) {
      hours += Number(t.defaultBudgetHours) || 0;
      amount += Number(t.defaultBudgetAmount) || 0;
    }
    return { count: filteredTasks.length, hours, amount };
  }, [filteredTasks]);

  // ---- handlers ----
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const buildPayload = (form: TaskForm) => ({
    code: form.code.trim() || undefined,
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    defaultBudgetHours: form.defaultBudgetHours ? Number(form.defaultBudgetHours) : undefined,
    defaultBudgetAmount: form.defaultBudgetAmount ? Number(form.defaultBudgetAmount) : undefined,
  });

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.name.trim()) return;
    addTaskMutation.mutate(buildPayload(newTask));
  };

  const handleUpdateTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTaskId || !editForm.name.trim()) return;
    updateTaskMutation.mutate({ taskId: editingTaskId, data: buildPayload(editForm) });
  };

  const startEditing = (task: any) => {
    setEditingTaskId(task.id);
    setEditForm({
      code: task.code ?? '',
      name: task.name ?? '',
      description: task.description ?? '',
      defaultBudgetHours: task.defaultBudgetHours != null ? String(task.defaultBudgetHours) : '',
      defaultBudgetAmount: task.defaultBudgetAmount != null ? String(task.defaultBudgetAmount) : '',
    });
  };

  const cancelEditing = () => {
    setEditingTaskId(null);
    setEditForm({ ...emptyTask });
  };

  // ---- sort indicator ----
  const sortIcon = (field: SortField) => {
    if (sortField !== field) return null;
    return <span className="ml-1 text-xs">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>;
  };

  // ---- render helpers ----
  const renderFormRow = (
    form: TaskForm,
    setForm: React.Dispatch<React.SetStateAction<TaskForm>>,
    onSubmit: (e: React.FormEvent) => void,
    onCancel: () => void,
    isPending: boolean,
    submitLabel: string,
    pendingLabel: string,
  ) => (
    <tr className="border-b border-border bg-brand-50/40">
      <td className="px-3 py-2">
        <input value={form.code} onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))} placeholder="Code" className={inputClass} />
      </td>
      <td className="px-3 py-2">
        <input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="Task name *" className={inputClass} autoFocus />
      </td>
      <td className="px-3 py-2">
        <input type="number" step="any" min="0" value={form.defaultBudgetHours} onChange={(e) => setForm((p) => ({ ...p, defaultBudgetHours: e.target.value }))} placeholder="0" className={`${inputClass} text-right`} />
      </td>
      <td className="px-3 py-2">
        <input type="number" step="any" min="0" value={form.defaultBudgetAmount} onChange={(e) => setForm((p) => ({ ...p, defaultBudgetAmount: e.target.value }))} placeholder="0" className={`${inputClass} text-right`} />
      </td>
      <td className="px-3 py-2 text-center">
        <div className="flex items-center justify-center gap-1">
          <button onClick={onSubmit} disabled={isPending} className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
            {isPending ? pendingLabel : submitLabel}
          </button>
          <button onClick={onCancel} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent">Cancel</button>
        </div>
      </td>
    </tr>
  );

  // ---- loading state ----
  const isLoading = catalogLoading || detailLoading;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/templates')} className="rounded-md p-1.5 hover:bg-accent">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <PageHeader
          title="Task Catalog"
          description="Standalone task library — all reusable task definitions"
          actions={
            !showAddTask ? (
              <button onClick={() => setShowAddTask(true)} className={btnPrimary}>
                <Plus className="h-4 w-4" /> Add Task
              </button>
            ) : undefined
          }
        />
      </div>

      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or code..."
            className={inputClass}
          />
        </div>
        <span className="text-sm text-muted-foreground">
          {filteredTasks.length} task{filteredTasks.length !== 1 ? 's' : ''}
          {search && ` matching "${search}"`}
        </span>
      </div>

      {/* Table */}
      {isLoading ? (
        <TableSkeleton rows={5} cols={5} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-3 py-2 text-left font-medium cursor-pointer select-none" onClick={() => handleSort('code')}>
                  Code{sortIcon('code')}
                </th>
                <th className="px-3 py-2 text-left font-medium cursor-pointer select-none" onClick={() => handleSort('name')}>
                  Name{sortIcon('name')}
                </th>
                <th className="px-3 py-2 text-right font-medium cursor-pointer select-none" onClick={() => handleSort('defaultBudgetHours')}>
                  Hours{sortIcon('defaultBudgetHours')}
                </th>
                <th className="px-3 py-2 text-right font-medium cursor-pointer select-none" onClick={() => handleSort('defaultBudgetAmount')}>
                  Amount{sortIcon('defaultBudgetAmount')}
                </th>
                <th className="px-3 py-2 text-center font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {/* Add task row */}
              {showAddTask &&
                renderFormRow(
                  newTask,
                  setNewTask,
                  handleAddTask,
                  () => { setShowAddTask(false); setNewTask({ ...emptyTask }); },
                  addTaskMutation.isPending,
                  'Save',
                  'Saving...',
                )}

              {/* Empty state */}
              {filteredTasks.length === 0 && !showAddTask && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    <BookOpen className="mx-auto h-10 w-10 text-muted-foreground/50" />
                    <p className="mt-2">
                      {search ? 'No tasks match your search.' : 'No tasks in the catalog yet. Click "Add Task" to get started.'}
                    </p>
                  </td>
                </tr>
              )}

              {/* Task rows */}
              {filteredTasks.map((task: any) =>
                editingTaskId === task.id ? (
                  renderFormRow(
                    editForm,
                    setEditForm,
                    handleUpdateTask,
                    cancelEditing,
                    updateTaskMutation.isPending,
                    'Update',
                    'Updating...',
                  )
                ) : (
                  <tr key={task.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-2 text-muted-foreground">{task.code || '-'}</td>
                    <td className="px-3 py-2 font-medium">
                      {task.name}
                      {task.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground font-normal truncate max-w-xs">{task.description}</p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{task.defaultBudgetHours != null ? Number(task.defaultBudgetHours).toFixed(1) : '-'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{task.defaultBudgetAmount != null ? Number(task.defaultBudgetAmount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}</td>
                    <td className="px-3 py-2 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => startEditing(task)}
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-blue-100 hover:text-blue-600"
                          title="Edit task"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => { if (confirm(`Delete task "${task.name}"?`)) deleteTaskMutation.mutate(task.id); }}
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-red-100 hover:text-red-600"
                          title="Delete task"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ),
              )}

              {/* Totals row */}
              {filteredTasks.length > 0 && (
                <tr className="border-t-2 border-border bg-muted/50 font-semibold">
                  <td className="px-3 py-2">{totals.count} task{totals.count !== 1 ? 's' : ''}</td>
                  <td className="px-3 py-2 text-right">Totals</td>
                  <td className="px-3 py-2 text-right tabular-nums">{totals.hours.toFixed(1)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{totals.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td className="px-3 py-2" />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
