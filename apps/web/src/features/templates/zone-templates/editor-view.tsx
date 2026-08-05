import { useState, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft, Layers, CheckSquare, X, Copy } from 'lucide-react';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { inputClass, btnPrimary, btnSecondary } from './constants';
import { ServiceGroupItem } from './service-group-item';
import { ZoneTreeNode } from './zone-tree-node';
import { ZoneTemplatePicker } from './zone-template-picker';
import { RootManualTaskForm } from './root-manual-task-form';
import { RootServicePickerModal } from './root-service-picker-modal';
import { RootCatalogPickerModal } from './root-catalog-picker-modal';

// ---------------------------------------------------------------------------
// Editor View
// ---------------------------------------------------------------------------

export function EditorView({
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

  // Lookup: service name → phase (for displaying phase on service groups)
  const servicePhaseMap = useMemo(() => {
    const map = new Map<string, { name: string; code?: string | null }>();
    for (const t of taskTemplates) {
      if (t.phase) map.set(t.name, { name: t.phase.name, code: t.phase.code });
    }
    return map;
  }, [taskTemplates]);

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

  const deleteRootTaskMutation = useMutation({
    mutationFn: (taskId: number) => client.delete(`/templates/tasks/${taskId}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      notify.success('Task removed', { code: 'TASK-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove task'),
  });

  if (isLoading) return <TableSkeleton rows={5} cols={4} />;
  if (!template) return <div className="p-8 text-center text-muted-foreground">Template not found.</div>;

  const zones: any[] = template.templateZones ?? [];
  const rootTasks: any[] = template.templateTasks ?? [];

  // Group root tasks by service tag
  const rootServiceGroups = new Map<string, any[]>();
  const rootUngroupedTasks: any[] = [];
  for (const task of rootTasks) {
    const match = task.description?.match(/^\[SERVICE:(.+)\]$/);
    if (match) {
      const svcName = match[1];
      if (!rootServiceGroups.has(svcName)) rootServiceGroups.set(svcName, []);
      rootServiceGroups.get(svcName)!.push(task);
    } else {
      rootUngroupedTasks.push(task);
    }
  }

  // Effective zone count = sum of instanceCount across child zones, NOT just
  // the row count. A "Floor ×3" entry counts as 3 zones because it'll spawn
  // 3 zones at apply time. Mirrors the API's findAll override.
  const expandedZoneCount = zones.reduce(
    (sum: number, z: any) => sum + Math.max(1, Number(z.instanceCount) || 1),
    0,
  );
  const totalItems = expandedZoneCount + rootTasks.length;

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
                {totalItems} item{totalItems !== 1 ? 's' : ''} &middot; Used {template.usageCount ?? 0} time{(template.usageCount ?? 0) !== 1 ? 's' : ''}
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
                  <Copy className="h-3.5 w-3.5 text-blue-600" /> Deliverable
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

        <div className="rounded-lg border border-border bg-background p-4 space-y-1">
          {totalItems === 0 && !showAddRoot && !showRootManualTask ? (
            <div className="py-8 text-center">
              <Layers className="mx-auto h-10 w-10 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">No items yet. Click [+ Add] to add zones, phases/milestones, or tasks.</p>
            </div>
          ) : (
            <>
              {/* Root-level service groups */}
              {Array.from(rootServiceGroups.entries()).map(([svcName, svcTasks]) => (
                <ServiceGroupItem key={`svc-${svcName}`} serviceName={svcName} tasks={svcTasks} templateId={templateId} servicePhase={servicePhaseMap.get(svcName) || null} onDeleteAll={async () => {
                  if (await confirm(`Remove service "${svcName}" and all its ${svcTasks.length} tasks?`)) {
                    Promise.all(svcTasks.map((t: any) => client.delete(`/templates/tasks/${t.id}`))).then(() => {
                      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
                      notify.success(`Removed deliverable: ${svcName}`, { code: 'SVC-DELETE-200' });
                    });
                  }
                }} />
              ))}

              {/* Root-level ungrouped tasks */}
              {rootUngroupedTasks.map((task: any) => (
                <div key={`task-${task.id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-green-50">
                  <CheckSquare className="h-3.5 w-3.5 shrink-0 text-green-600" />
                  <span className="font-mono text-xs text-muted-foreground w-16">{task.code || '-'}</span>
                  <span className="text-sm">{task.name}</span>
                  {task.defaultBudgetHours != null && <span className="text-xs text-muted-foreground">{Number(task.defaultBudgetHours)}h</span>}
                  {task.defaultBudgetAmount != null && <span className="text-xs text-muted-foreground">{'\u20AA'}{Number(task.defaultBudgetAmount).toLocaleString()}</span>}
                  <button
                    onClick={async () => { if (await confirm(`Remove task "${task.name}"?`)) deleteRootTaskMutation.mutate(task.id); }}
                    className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-red-100 hover:text-red-600"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}

              {/* Zone children */}
              {zones.map((z: any) => (
                <ZoneTreeNode
                  key={z.id}
                  zone={z}
                  templateId={templateId}
                  taskTemplates={taskTemplates as any[]}
                  phases={phases as any[]}
                  depth={0}
                  servicePhaseMap={servicePhaseMap}
                />
              ))}
            </>
          )}

          {showAddRoot && (
            <ZoneTemplatePicker templateId={templateId} parentId={null} onDone={() => setShowAddRoot(false)} />
          )}

          {showRootManualTask && (
            <RootManualTaskForm templateId={templateId} phases={phases as any[]} onDone={() => setShowRootManualTask(false)} />
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
