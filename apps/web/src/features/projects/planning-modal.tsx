import { useState, useMemo, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ChevronRight,
  ChevronDown,
  Plus,
  Layers,
  ArrowLeft,
  Copy,
  Trash2,
} from 'lucide-react';
import { notify } from '@/lib/notify';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { planningApi, zonesApi, templatesApi } from '@/api/zones.api';
import { tasksApi } from '@/api/tasks.api';
import type { CreateTaskPayload } from '@/api/tasks.api';

// ─── Zone display config ─────────────────────────────────────────────────────

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

// ─── Zone Tree Node ──────────────────────────────────────────────────────────

function ZoneNode({ zone, selectedZoneId, onSelect, depth = 0 }: {
  zone: any;
  selectedZoneId: number | null;
  onSelect: (zone: any) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = zone.children && zone.children.length > 0;
  const display = ZONE_DISPLAY[zone.zoneType] || ZONE_DISPLAY.zone;

  return (
    <div>
      <button
        onClick={() => onSelect(selectedZoneId === zone.id ? null : zone)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
          selectedZoneId === zone.id
            ? 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300'
            : 'text-foreground hover:bg-muted',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="shrink-0 rounded p-0.5 hover:bg-accent"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}
        <span className="truncate flex-1">{zone.name}</span>
        <span className="flex shrink-0 items-center gap-1">
          <span
            className="rounded px-1 py-0.5 text-[10px] font-medium"
            style={{ backgroundColor: `${display.color}20`, color: display.color }}
          >
            {display.label}
          </span>
          {zone.isTypical && zone.typicalCount > 1 && (
            <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-700">
              &times;{zone.typicalCount}
            </span>
          )}
        </span>
      </button>
      {hasChildren && expanded && (
        <div>
          {zone.children.map((child: any) => (
            <ZoneNode key={child.id} zone={child} selectedZoneId={selectedZoneId} onSelect={onSelect} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Add Task Form ───────────────────────────────────────────────────────────

function AddTaskForm({ zoneId, serviceTypes, phases, onSave, onCancel, isPending }: {
  zoneId: number;
  serviceTypes: any[];
  phases: any[];
  onSave: (data: CreateTaskPayload) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [budgetHours, setBudgetHours] = useState('');
  const [budgetAmount, setBudgetAmount] = useState('');
  const [serviceTypeId, setServiceTypeId] = useState('');
  const [phaseId, setPhaseId] = useState('');
  const [priority, setPriority] = useState('medium');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !name.trim()) {
      notify.error('Code and name are required');
      return;
    }
    onSave({
      zoneId,
      code: code.trim(),
      name: name.trim(),
      budgetHours: budgetHours ? Number(budgetHours) : undefined,
      budgetAmount: budgetAmount ? Number(budgetAmount) : undefined,
      serviceTypeId: serviceTypeId ? Number(serviceTypeId) : undefined,
      phaseId: phaseId ? Number(phaseId) : undefined,
      priority,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="border border-border rounded-md p-3 bg-muted/20 space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code *" className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" autoFocus />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name *" className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" />
        <input value={budgetHours} onChange={(e) => setBudgetHours(e.target.value)} placeholder="Hours" type="number" className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" />
        <input value={budgetAmount} onChange={(e) => setBudgetAmount(e.target.value)} placeholder="Amount" type="number" className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" />
        <select value={serviceTypeId} onChange={(e) => setServiceTypeId(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5 text-sm">
          <option value="">Service Type</option>
          {serviceTypes.map((st: any) => <option key={st.id} value={st.id}>{st.name}</option>)}
        </select>
        <select value={phaseId} onChange={(e) => setPhaseId(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5 text-sm">
          <option value="">Phase</option>
          {phases.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5 text-sm">
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={isPending} className="rounded bg-brand-600 px-3 py-1 text-xs text-white hover:bg-brand-700 disabled:opacity-50">
          {isPending ? 'Saving...' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className="rounded border border-border px-3 py-1 text-xs hover:bg-accent">Cancel</button>
      </div>
    </form>
  );
}

// ─── Tasks Panel ─────────────────────────────────────────────────────────────

function TasksPanel({ selectedZone, allTasks, serviceTypes, phases, projectId, members }: {
  selectedZone: any;
  allTasks: any[];
  serviceTypes: any[];
  phases: any[];
  projectId: number;
  members: any[];
}) {
  const queryClient = useQueryClient();
  const [showAddTask, setShowAddTask] = useState(false);
  const [showTemplateDropdown, setShowTemplateDropdown] = useState(false);

  const { data: taskTemplates } = useQuery({
    queryKey: ['templates', 'task_list'],
    queryFn: () => templatesApi.list('task_list'),
    staleTime: 5 * 60 * 1000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
  };

  const createTask = useMutation({
    mutationFn: (data: CreateTaskPayload) => tasksApi.create(data),
    onSuccess: () => { invalidate(); setShowAddTask(false); notify.success('Task created', { code: 'TASK-CREATE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to create task'),
  });

  const updateTask = useMutation({
    mutationFn: ({ id, ...data }: { id: number } & Record<string, any>) => tasksApi.update(id, data),
    onSuccess: () => invalidate(),
    onError: (err: any) => notify.apiError(err, 'Failed to update task'),
  });

  const deleteTask = useMutation({
    mutationFn: (id: number) => tasksApi.delete(id),
    onSuccess: () => { invalidate(); notify.success('Task deleted', { code: 'TASK-DELETE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to delete task'),
  });

  const applyTemplate = useMutation({
    mutationFn: (templateId: number) => zonesApi.applyTaskTemplate(selectedZone.id, templateId),
    onSuccess: () => { invalidate(); setShowTemplateDropdown(false); notify.success('Template applied', { code: 'ZONE-APPLY-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to apply template'),
  });

  // Filter tasks for selected zone
  const zoneTasks = useMemo(() => {
    if (!selectedZone) return allTasks;
    return allTasks.filter((t: any) => t.zoneId === selectedZone.id);
  }, [allTasks, selectedZone]);

  // Group tasks by service type
  const grouped = useMemo(() => {
    const map = new Map<number | null, { serviceType: any; tasks: any[] }>();
    for (const task of zoneTasks) {
      const key = task.serviceTypeId || 0;
      if (!map.has(key)) {
        map.set(key, { serviceType: task.serviceType || null, tasks: [] });
      }
      map.get(key)!.tasks.push(task);
    }
    return Array.from(map.values());
  }, [zoneTasks]);

  // Budget totals for this zone
  const zoneHours = zoneTasks.reduce((s: number, t: any) => s + Number(t.budgetHours || 0), 0);
  const zoneAmount = zoneTasks.reduce((s: number, t: any) => s + Number(t.budgetAmount || 0), 0);

  const templates = Array.isArray(taskTemplates) ? taskTemplates : (taskTemplates as any)?.data ?? [];

  if (!selectedZone) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Select a zone to view its tasks
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div>
          <h3 className="text-sm font-semibold">Tasks for: {selectedZone.name}</h3>
          <span className="text-xs text-muted-foreground">{zoneTasks.length} tasks &middot; {zoneHours}h &middot; {zoneAmount.toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 })}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setShowAddTask(true)} className="flex items-center gap-1 rounded-md bg-brand-600 px-2.5 py-1.5 text-xs text-white hover:bg-brand-700">
            <Plus className="h-3.5 w-3.5" /> Add Task
          </button>
          <div className="relative">
            <button onClick={() => setShowTemplateDropdown(!showTemplateDropdown)} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent">
              <Copy className="h-3.5 w-3.5" /> Apply Template
            </button>
            {showTemplateDropdown && (
              <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-background shadow-lg">
                {templates.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">No task templates available</p>
                ) : (
                  templates.map((t: any) => (
                    <button key={t.id} onClick={() => applyTemplate.mutate(t.id)} className="block w-full px-3 py-2 text-left text-sm hover:bg-accent">
                      {t.name}
                      {t.category && <span className="ml-2 text-xs text-muted-foreground">{t.category}</span>}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Task List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {showAddTask && (
          <AddTaskForm
            zoneId={selectedZone.id}
            serviceTypes={serviceTypes}
            phases={phases}
            onSave={(data) => createTask.mutate(data)}
            onCancel={() => setShowAddTask(false)}
            isPending={createTask.isPending}
          />
        )}

        {grouped.length === 0 && !showAddTask && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No tasks yet. Click "Add Task" or "Apply Template" to get started.
          </div>
        )}

        {grouped.map(({ serviceType, tasks }) => (
          <ServiceTypeGroup key={serviceType?.id || 'ungrouped'} serviceType={serviceType} tasks={tasks} phases={phases} onDelete={(id) => deleteTask.mutate(id)} onUpdate={(id, data) => updateTask.mutate({ id, ...data })} members={members} />
        ))}
      </div>
    </div>
  );
}

// ─── Service Type Group ──────────────────────────────────────────────────────

function ServiceTypeGroup({ serviceType, tasks, phases, onDelete, onUpdate, members }: {
  serviceType: any;
  tasks: any[];
  phases: any[];
  onDelete: (id: number) => void;
  onUpdate: (id: number, data: any) => void;
  members: any[];
}) {
  const [collapsed, setCollapsed] = useState(false);
  const groupHours = tasks.reduce((s: number, t: any) => s + Number(t.budgetHours || 0), 0);
  const groupAmount = tasks.reduce((s: number, t: any) => s + Number(t.budgetAmount || 0), 0);

  return (
    <div className="rounded-[14px] border border-slate-200 bg-white">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 rounded-t-[14px]"
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5 text-slate-400" /> : <ChevronDown className="h-3.5 w-3.5 text-slate-400" />}
        {serviceType?.color && <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: serviceType.color }} />}
        <span className="text-[13px] font-semibold text-slate-900">{serviceType?.name || 'Ungrouped'}</span>
        {serviceType?.code && <span className="rounded-[5px] bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-slate-500">{serviceType.code}</span>}
        <span className="ml-auto text-[11px] font-medium text-slate-400">{tasks.length} tasks &middot; {groupHours}h &middot; {groupAmount.toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 })}</span>
      </button>

      {!collapsed && (
        <div className="border-t border-slate-100">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-[#FAFBFC] border-b border-slate-100">
                <th className="px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">Code</th>
                <th className="px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">Name</th>
                <th className="px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">Assignee</th>
                <th className="px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">Start</th>
                <th className="px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">End</th>
                <th className="px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">Priority</th>
                <th className="px-3 py-1.5 text-right text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">Hours</th>
                <th className="px-3 py-1.5 text-right text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">Amount</th>
                <th className="px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">Status</th>
                <th className="px-3 py-1.5 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task: any) => {
                const assignee = task.assignees?.[0]?.user;
                return (
                <tr key={task.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50 group">
                  <td className="px-3 py-2 text-xs font-medium font-mono text-slate-500">{task.code}</td>
                  <td className="px-3 py-2 font-medium text-slate-900">{task.name}</td>
                  <td className="px-3 py-2">
                    {assignee ? (
                      <span className="inline-flex items-center gap-1.5 text-[13px] text-slate-700">
                        <span className="w-5 h-5 rounded-full bg-violet-100 text-violet-600 text-[9px] font-semibold flex items-center justify-center">
                          {assignee.firstName?.[0]}{assignee.lastName?.[0]}
                        </span>
                        {assignee.firstName}
                      </span>
                    ) : (
                      <select
                        className="w-full text-[12px] text-slate-400 bg-transparent border-none cursor-pointer hover:text-slate-600 focus:outline-none"
                        value=""
                        onChange={(e) => {
                          if (e.target.value) {
                            tasksApi.addAssignee(task.id, { userId: Number(e.target.value) });
                            onUpdate(task.id, {});
                          }
                        }}
                      >
                        <option value="">+ assign</option>
                        {members.map((m: any) => (
                          <option key={m.user?.id ?? m.id} value={m.user?.id ?? m.id}>
                            {m.user?.firstName ?? m.firstName} {m.user?.lastName ?? m.lastName}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="date"
                      defaultValue={task.startDate?.split('T')[0] || ''}
                      className="w-24 text-[12px] text-slate-600 bg-transparent border-none focus:outline-none cursor-pointer"
                      onChange={(e) => onUpdate(task.id, { startDate: e.target.value || null })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="date"
                      defaultValue={task.endDate?.split('T')[0] || ''}
                      className="w-24 text-[12px] text-slate-600 bg-transparent border-none focus:outline-none cursor-pointer"
                      onChange={(e) => onUpdate(task.id, { endDate: e.target.value || null })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={task.priority || 'medium'}
                      className="text-[12px] bg-transparent border-none cursor-pointer focus:outline-none"
                      onChange={(e) => onUpdate(task.id, { priority: e.target.value })}
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                  </td>
                  <td className="px-3 py-2 text-right text-xs font-medium font-mono tabular-nums text-slate-700">{task.budgetHours ? Number(task.budgetHours) : '-'}</td>
                  <td className="px-3 py-2 text-right text-xs font-semibold font-mono tabular-nums text-slate-700">{task.budgetAmount ? Number(task.budgetAmount).toLocaleString() : '-'}</td>
                  <td className="px-3 py-2">
                    <select
                      value={task.status || 'not_started'}
                      className="text-[12px] bg-transparent border-none cursor-pointer focus:outline-none"
                      onChange={(e) => onUpdate(task.id, { status: e.target.value })}
                    >
                      <option value="not_started">Not Started</option>
                      <option value="in_progress">In Progress</option>
                      <option value="in_review">In Review</option>
                      <option value="completed">Completed</option>
                      <option value="on_hold">On Hold</option>
                    </select>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button onClick={() => { if (confirm(`Delete "${task.name}"?`)) onDelete(task.id); }} className="opacity-0 group-hover:opacity-100 rounded-[7px] p-1 text-slate-300 hover:bg-red-50 hover:text-red-600 transition-all duration-150">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Budget Summary Bar ──────────────────────────────────────────────────────

function BudgetSummaryBar({ summary }: { summary: any }) {
  if (!summary) return null;
  const { totalHours, totalAmount, projectBudget, remaining, remainingPct } = summary;
  const isOver = remaining < 0;

  return (
    <div className="flex flex-wrap items-center gap-4 border-t border-border bg-muted/30 px-4 py-2.5 text-xs">
      <span>
        <span className="text-muted-foreground">Project Total: </span>
        <span className="font-semibold tabular-nums">{totalHours}h</span>
        <span className="mx-1 text-muted-foreground">&middot;</span>
        <span className="font-semibold tabular-nums">{Number(totalAmount).toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 })}</span>
      </span>
      {projectBudget > 0 && (
        <>
          <span className="text-muted-foreground">
            / {Number(projectBudget).toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 })}
            {' '}({Math.round(100 - (remainingPct || 0))}%)
          </span>
          <span className={cn('font-medium', isOver ? 'text-red-600' : 'text-green-600')}>
            Remaining: {Number(remaining).toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 })}
          </span>
        </>
      )}
    </div>
  );
}

// ─── Main Planning Page ──────────────────────────────────────────────────────

function PlanningView({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const [selectedZone, setSelectedZone] = useState<any>(null);
  const [addingZone, setAddingZone] = useState(false);
  const [newZoneName, setNewZoneName] = useState('');
  const [newZoneType, setNewZoneType] = useState('zone');
  const [duplicateModal, setDuplicateModal] = useState<any>(null);
  const [duplicateName, setDuplicateName] = useState('');
  const [showProjectTemplateMenu, setShowProjectTemplateMenu] = useState(false);

  const zoneTypeOptions = ['site', 'building', 'level', 'zone', 'area', 'section', 'wing', 'floor'];

  const { data: planningData, isLoading } = useQuery({
    queryKey: ['planning', projectId],
    queryFn: () => planningApi.getData(projectId),
    enabled: !!projectId,
  });

  const pd = (planningData as any)?.data ?? planningData;
  const zones = pd?.zones ?? [];
  const tasks = pd?.tasks ?? [];
  const serviceTypes = pd?.serviceTypes ?? [];
  const phases = pd?.phases ?? [];
  const budgetSummary = pd?.budgetSummary;

  const { data: zoneTemplatesRaw } = useQuery({
    queryKey: ['templates', 'zone'],
    queryFn: () => templatesApi.list('zone'),
    staleTime: 5 * 60 * 1000,
  });
  const { data: combinedTemplatesRaw } = useQuery({
    queryKey: ['templates', 'combined'],
    queryFn: () => templatesApi.list('combined'),
    staleTime: 5 * 60 * 1000,
  });
  const projectZoneTemplates = Array.isArray(zoneTemplatesRaw) ? zoneTemplatesRaw : (zoneTemplatesRaw as any)?.data ?? [];
  const projectCombinedTemplates = Array.isArray(combinedTemplatesRaw) ? combinedTemplatesRaw : (combinedTemplatesRaw as any)?.data ?? [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
  };

  const applyProjectTemplate = useMutation({
    mutationFn: (templateId: number) => planningApi.applyProjectTemplate(projectId, templateId),
    onSuccess: () => { invalidate(); setShowProjectTemplateMenu(false); notify.success('Template applied — zones and tasks created', { code: 'PROJECT-APPLY-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to apply template'),
  });

  const createZone = useMutation({
    mutationFn: (data: any) => zonesApi.create(data),
    onSuccess: () => { invalidate(); setNewZoneName(''); setAddingZone(false); notify.success('Zone created', { code: 'ZONE-CREATE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to create zone'),
  });

  const duplicateZone = useMutation({
    mutationFn: ({ zoneId, newName }: { zoneId: number; newName: string }) => zonesApi.duplicate(zoneId, newName),
    onSuccess: () => { invalidate(); setDuplicateModal(null); setDuplicateName(''); notify.success('Zone duplicated', { code: 'ZONE-DUPLICATE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to duplicate zone'),
  });

  const handleAddZone = () => {
    if (!newZoneName.trim()) return;
    createZone.mutate({
      projectId,
      name: newZoneName.trim(),
      zoneType: newZoneType,
      parentId: selectedZone?.id || null,
    });
  };

  if (isLoading) {
    return <div className="flex h-96 items-center justify-center text-muted-foreground">Loading planning data...</div>;
  }

  return (
    <div className="flex h-[calc(100vh-12rem)] flex-col rounded-lg border border-border">
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Zone tree */}
        <div className="w-64 shrink-0 border-r border-border flex flex-col">
          <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
            <h3 className="text-sm font-semibold">Zones</h3>
            <div className="flex items-center gap-1">
              <div className="relative">
                <button onClick={() => setShowProjectTemplateMenu(!showProjectTemplateMenu)} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="Apply zone/combined template">
                  <Copy className="h-4 w-4" />
                </button>
                {showProjectTemplateMenu && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-60 rounded-md border border-border bg-background shadow-lg">
                    {projectZoneTemplates.length > 0 && (
                      <>
                        <p className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase">Zone Templates</p>
                        {projectZoneTemplates.map((t: any) => (
                          <button key={t.id} onClick={() => applyProjectTemplate.mutate(t.id)} className="block w-full px-3 py-2 text-left text-sm hover:bg-accent">{t.name}</button>
                        ))}
                      </>
                    )}
                    {projectCombinedTemplates.length > 0 && (
                      <>
                        <p className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase border-t border-border">Combined Templates</p>
                        {projectCombinedTemplates.map((t: any) => (
                          <button key={t.id} onClick={() => applyProjectTemplate.mutate(t.id)} className="block w-full px-3 py-2 text-left text-sm hover:bg-accent">{t.name}</button>
                        ))}
                      </>
                    )}
                    {projectZoneTemplates.length === 0 && projectCombinedTemplates.length === 0 && (
                      <p className="p-3 text-xs text-muted-foreground">No zone or combined templates available. Create one in Templates.</p>
                    )}
                  </div>
                )}
              </div>
              <button onClick={() => setAddingZone(!addingZone)} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="Add zone">
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>

          {addingZone && (
            <div className="border-b border-border p-2 space-y-1.5">
              <input
                type="text" value={newZoneName}
                onChange={(e) => setNewZoneName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddZone(); if (e.key === 'Escape') setAddingZone(false); }}
                placeholder="Zone name..." autoFocus
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
              />
              <select value={newZoneType} onChange={(e) => setNewZoneType(e.target.value)} className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm">
                {zoneTypeOptions.map((zt) => <option key={zt} value={zt}>{zt.charAt(0).toUpperCase() + zt.slice(1)}</option>)}
              </select>
              <div className="flex justify-end gap-1">
                <button onClick={() => setAddingZone(false)} className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent">Cancel</button>
                <button onClick={handleAddZone} disabled={createZone.isPending || !newZoneName.trim()} className="rounded bg-brand-600 px-2 py-1 text-xs text-white hover:bg-brand-700 disabled:opacity-50">Add</button>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-1.5">
            <button
              onClick={() => setSelectedZone(null)}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                !selectedZone ? 'bg-brand-50 text-brand-700' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              <Layers className="h-3.5 w-3.5 shrink-0" /> All Zones
            </button>
            {zones.map((zone: any) => (
              <ZoneNode key={zone.id} zone={zone} selectedZoneId={selectedZone?.id ?? null} onSelect={setSelectedZone} />
            ))}
            {zones.length === 0 && <p className="px-2 py-4 text-center text-xs text-muted-foreground">No zones yet. Click + to add one.</p>}
          </div>

          {/* Duplicate zone action */}
          {selectedZone && (
            <div className="border-t border-border p-2">
              <button
                onClick={() => { setDuplicateModal(selectedZone); setDuplicateName(`${selectedZone.name} (copy)`); }}
                className="w-full rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
              >
                Duplicate Zone
              </button>
            </div>
          )}
        </div>

        {/* Right: Tasks panel */}
        <div className="flex-1 flex flex-col min-w-0">
          <TasksPanel
            selectedZone={selectedZone}
            allTasks={tasks}
            serviceTypes={serviceTypes}
            phases={phases}
            projectId={projectId}
            members={pd?.members ?? []}
          />
        </div>
      </div>

      {/* Bottom: Budget summary */}
      <BudgetSummaryBar summary={budgetSummary} />

      {/* Duplicate zone modal */}
      {duplicateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-96 rounded-lg bg-background p-6 shadow-xl space-y-4">
            <h3 className="text-sm font-semibold">Duplicate Zone: {duplicateModal.name}</h3>
            <div>
              <label className="block text-sm font-medium mb-1">New Zone Name *</label>
              <input
                value={duplicateName}
                onChange={(e) => setDuplicateName(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDuplicateModal(null)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent">Cancel</button>
              <button
                onClick={() => duplicateZone.mutate({ zoneId: duplicateModal.id, newName: duplicateName })}
                disabled={duplicateZone.isPending || !duplicateName.trim()}
                className="rounded-md bg-brand-600 px-4 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {duplicateZone.isPending ? 'Duplicating...' : 'Duplicate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Exported PlanningPage (standalone route) ────────────────────────────────

export function PlanningPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const projectId = Number(id);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(`/projects/${projectId}`)} className="rounded-md p-1.5 hover:bg-accent">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="text-lg font-semibold">Project Planning</h2>
      </div>
      <PlanningView projectId={projectId} />
    </div>
  );
}

// ─── Exported PlanningTab (embedded in project detail) ───────────────────────

export function PlanningTab({ projectId }: { projectId: number }) {
  return <PlanningView projectId={projectId} />;
}

export default PlanningPage;
