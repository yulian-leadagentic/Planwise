import { useState, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ChevronRight, ChevronDown, Plus, Layers, ArrowLeft, Copy, Trash2, Search,
} from 'lucide-react';
import { notify } from '@/lib/notify';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { planningApi, zonesApi, templatesApi } from '@/api/zones.api';
import { tasksApi } from '@/api/tasks.api';
import client from '@/api/client';

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

// ─── Template Picker ─────────────────────────────────────────────────────────

function TemplatePicker({ projectId, onApplied }: { projectId: number; onApplied: () => void }) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState('usage');

  const { data: rawTemplates = [] } = useQuery({
    queryKey: ['templates', 'zone'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=zone').then((r) => r.data.data ?? r.data),
  });

  const templates = useMemo(() => {
    let list = Array.isArray(rawTemplates) ? rawTemplates : [];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((t: any) => t.name?.toLowerCase().includes(q) || t.code?.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q));
    }
    if (sortBy === 'usage') list.sort((a: any, b: any) => (b.usageCount ?? 0) - (a.usageCount ?? 0));
    else if (sortBy === 'name') list.sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
    else if (sortBy === 'zones') list.sort((a: any, b: any) => (b._count?.templateZones ?? 0) - (a._count?.templateZones ?? 0));
    return list;
  }, [rawTemplates, search, sortBy]);

  const selected = templates.find((t: any) => t.id === selectedId);

  const applyMutation = useMutation({
    mutationFn: (templateId: number) => planningApi.applyProjectTemplate(projectId, templateId),
    onSuccess: () => { notify.success('Template applied to project', { code: 'TPL-APPLY-200' }); onApplied(); },
    onError: (err: any) => notify.apiError(err, 'Failed to apply template'),
  });

  if (templates.length === 0 && !search) return null;

  return (
    <div className="bg-white rounded-[14px] border border-slate-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <h3 className="text-[15px] font-bold text-slate-900">Start from Template</h3>
        <p className="text-[13px] text-slate-400 mt-0.5">Select a zone template to pre-populate your project structure</p>
      </div>
      <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates..." className="w-full pl-9 px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
        </div>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none">
          <option value="usage">Sort: Most Used</option>
          <option value="name">Sort: Name A-Z</option>
          <option value="zones">Sort: Most Zones</option>
        </select>
      </div>
      <div className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[400px] overflow-y-auto">
        {templates.map((t: any) => {
          const isSelected = t.id === selectedId;
          const svcCount = new Set((t.templateTasks ?? []).map((tk: any) => tk.description?.match(/^\[SERVICE:(.+)\]$/)?.[1]).filter(Boolean)).size;
          return (
            <div key={t.id} onClick={() => setSelectedId(isSelected ? null : t.id)}
              className={cn('rounded-[14px] p-4 cursor-pointer transition-all duration-150',
                isSelected ? 'border-2 border-blue-500 bg-blue-50/40 shadow-sm' : 'border border-slate-200 hover:border-blue-300 hover:bg-blue-50/30'
              )}>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-[28px] h-[28px] rounded-[7px] bg-amber-50 flex items-center justify-center">
                  <Layers className="w-3.5 h-3.5 text-amber-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className={cn('text-[13px] font-semibold truncate', isSelected ? 'text-blue-700' : 'text-slate-900')}>{t.name}</h4>
                  {t.code && <span className={cn('font-mono text-[11px]', isSelected ? 'text-blue-400' : 'text-slate-400')}>{t.code}</span>}
                </div>
                {isSelected && <span className="rounded-[5px] bg-blue-600 text-white text-[11px] font-bold px-2 py-0.5">Selected</span>}
              </div>
              {t.description && <p className={cn('text-[12px] mb-3 line-clamp-2', isSelected ? 'text-blue-600/70' : 'text-slate-500')}>{t.description}</p>}
              <div className={cn('flex items-center gap-3 text-[11px] font-medium', isSelected ? 'text-blue-400' : 'text-slate-400')}>
                <span>{t._count?.templateZones ?? 0} zones</span><span>·</span>
                <span>{svcCount} services</span><span>·</span>
                <span>{t._count?.templateTasks ?? 0} tasks</span><span>·</span>
                <span className={isSelected ? '' : 'text-blue-500'}>Used {t.usageCount ?? 0}x</span>
              </div>
            </div>
          );
        })}
        {templates.length === 0 && <p className="col-span-3 py-8 text-center text-[13px] text-slate-400">{search ? 'No templates match your search.' : 'No zone templates available.'}</p>}
      </div>
      {selected && (
        <div className="px-5 py-3 border-t border-slate-100 bg-[#FAFBFC] flex items-center justify-between rounded-b-[14px]">
          <span className="text-[13px] text-slate-400">Selected: <strong className="text-slate-700">{selected.name}</strong></span>
          <button onClick={() => applyMutation.mutate(selected.id)} disabled={applyMutation.isPending}
            className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
            {applyMutation.isPending ? 'Applying...' : 'Apply Template to Project'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Task Table with Flexible Grouping ────────────────────────────────────────

function TaskTable({ tasks, projectId, members, selectedZone }: { tasks: any[]; projectId: number; members: any[]; selectedZone: any }) {
  const queryClient = useQueryClient();
  const [groupBy, setGroupBy] = useState<'zone' | 'service' | 'phase' | 'none'>('zone');
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<string>('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [showAddTask, setShowAddTask] = useState(false);
  const [newTask, setNewTask] = useState({ code: '', name: '', budgetHours: '', budgetAmount: '' });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['planning', projectId] });

  const createTask = useMutation({
    mutationFn: (data: any) => tasksApi.create(data),
    onSuccess: () => { invalidate(); setShowAddTask(false); setNewTask({ code: '', name: '', budgetHours: '', budgetAmount: '' }); notify.success('Task created', { code: 'TASK-CREATE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to create task'),
  });

  const updateTask = useMutation({
    mutationFn: ({ id, ...data }: { id: number } & Record<string, any>) => tasksApi.update(id, data),
    onSuccess: invalidate,
    onError: (err: any) => notify.apiError(err, 'Failed to update task'),
  });

  const deleteTask = useMutation({
    mutationFn: (id: number) => tasksApi.delete(id),
    onSuccess: () => { invalidate(); notify.success('Task deleted', { code: 'TASK-DELETE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to delete task'),
  });

  // Filter
  const filtered = useMemo(() => {
    if (!search.trim()) return tasks;
    const q = search.toLowerCase();
    return tasks.filter((t: any) =>
      t.code?.toLowerCase().includes(q) || t.name?.toLowerCase().includes(q) ||
      t.zone?.name?.toLowerCase().includes(q) || t.serviceType?.name?.toLowerCase().includes(q) ||
      t.phase?.name?.toLowerCase().includes(q)
    );
  }, [tasks, search]);

  // Sort
  const sorted = useMemo(() => {
    if (!sortCol) return filtered;
    return [...filtered].sort((a: any, b: any) => {
      let va: any, vb: any;
      switch (sortCol) {
        case 'code': va = a.code || ''; vb = b.code || ''; break;
        case 'name': va = a.name || ''; vb = b.name || ''; break;
        case 'zone': va = a.zone?.name || ''; vb = b.zone?.name || ''; break;
        case 'service': va = a.serviceType?.name || ''; vb = b.serviceType?.name || ''; break;
        case 'phase': va = a.phase?.name || ''; vb = b.phase?.name || ''; break;
        case 'hours': va = Number(a.budgetHours) || 0; vb = Number(b.budgetHours) || 0; break;
        case 'amount': va = Number(a.budgetAmount) || 0; vb = Number(b.budgetAmount) || 0; break;
        default: return 0;
      }
      if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb as string).toLowerCase(); }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filtered, sortCol, sortDir]);

  // Group
  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', label: 'All Tasks', tasks: sorted }];
    const map = new Map<string, { label: string; tasks: any[] }>();
    for (const t of sorted) {
      let key = '', label = '';
      if (groupBy === 'zone') { key = t.zone?.name || 'Unassigned'; label = key; }
      else if (groupBy === 'service') { key = t.serviceType?.name || 'No Service'; label = key; }
      else if (groupBy === 'phase') { key = t.phase?.name || 'No Phase'; label = key; }
      if (!map.has(key)) map.set(key, { label, tasks: [] });
      map.get(key)!.tasks.push(t);
    }
    return Array.from(map.values());
  }, [sorted, groupBy]);

  const totalHours = sorted.reduce((s: number, t: any) => s + Number(t.budgetHours || 0), 0);
  const totalAmount = sorted.reduce((s: number, t: any) => s + Number(t.budgetAmount || 0), 0);

  const handleSort = (col: string) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };
  const sortIcon = (col: string) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const thClass = "px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em] cursor-pointer select-none hover:text-slate-600";

  return (
    <div className="bg-white rounded-[14px] border border-slate-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h3 className="text-[15px] font-bold text-slate-900">Project Tasks</h3>
          <span className="text-[11px] font-medium text-slate-400">{sorted.length} tasks · {totalHours}h · ₪{totalAmount.toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-2">
          {selectedZone && (
            <button onClick={() => setShowAddTask(true)} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3.5 py-1.5 rounded-lg flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Add Task
            </button>
          )}
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold text-slate-400">Group:</span>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as any)} className="px-2 py-1.5 rounded-lg border border-slate-200 text-[13px] text-slate-700 focus:border-blue-500 focus:outline-none">
              <option value="zone">Zone</option>
              <option value="service">Service</option>
              <option value="phase">Phase</option>
              <option value="none">None</option>
            </select>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter..." className="w-36 pl-8 px-2.5 py-1.5 rounded-lg border border-slate-200 text-[13px] text-slate-700 focus:border-blue-500 focus:outline-none" />
          </div>
        </div>
      </div>

      {/* Add Task inline form */}
      {showAddTask && selectedZone && (
        <div className="px-5 py-3 border-b border-slate-100 bg-blue-50/20 flex items-center gap-2">
          <input value={newTask.code} onChange={(e) => setNewTask(f => ({ ...f, code: e.target.value }))} placeholder="Code *" className="w-20 px-2 py-1.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" autoFocus />
          <input value={newTask.name} onChange={(e) => setNewTask(f => ({ ...f, name: e.target.value }))} placeholder="Task name *" className="flex-1 px-2 py-1.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
          <input value={newTask.budgetHours} onChange={(e) => setNewTask(f => ({ ...f, budgetHours: e.target.value }))} placeholder="Hours" type="number" className="w-16 px-2 py-1.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
          <input value={newTask.budgetAmount} onChange={(e) => setNewTask(f => ({ ...f, budgetAmount: e.target.value }))} placeholder="Amount" type="number" className="w-20 px-2 py-1.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
          <button onClick={() => {
            if (!newTask.code.trim() || !newTask.name.trim()) { notify.warning('Code and Name required', { code: 'TASK-CREATE-400' }); return; }
            createTask.mutate({ zoneId: selectedZone.id, code: newTask.code.trim(), name: newTask.name.trim(), budgetHours: newTask.budgetHours ? Number(newTask.budgetHours) : undefined, budgetAmount: newTask.budgetAmount ? Number(newTask.budgetAmount) : undefined });
          }} disabled={createTask.isPending} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50">Save</button>
          <button onClick={() => setShowAddTask(false)} className="bg-white border border-slate-200 text-slate-700 text-[13px] font-semibold px-3 py-1.5 rounded-lg">Cancel</button>
        </div>
      )}

      {groups.map((group) => (
        <GroupSection key={group.label} label={group.label} tasks={group.tasks} groupBy={groupBy}
          thClass={thClass} handleSort={handleSort} sortIcon={sortIcon}
          members={members} onUpdate={(id, data) => updateTask.mutate({ id, ...data })}
          onDelete={(id) => { if (confirm('Delete this task?')) deleteTask.mutate(id); }} />
      ))}

      <div className="flex items-center gap-6 px-6 py-2.5 border-t border-slate-100 bg-[#FAFBFC] rounded-b-[14px] text-[12px]">
        <div><span className="text-slate-400">Total:</span> <span className="font-mono text-xs font-semibold text-slate-900 ml-1">{sorted.length} tasks · {totalHours}h · ₪{totalAmount.toLocaleString()}</span></div>
      </div>
    </div>
  );
}

function GroupSection({ label, tasks, groupBy, thClass, handleSort, sortIcon, members, onUpdate, onDelete }: any) {
  const [collapsed, setCollapsed] = useState(false);
  const hours = tasks.reduce((s: number, t: any) => s + Number(t.budgetHours || 0), 0);
  const amount = tasks.reduce((s: number, t: any) => s + Number(t.budgetAmount || 0), 0);

  return (
    <div className="border-b border-slate-100 last:border-0">
      {groupBy !== 'none' && (
        <div className="flex items-center gap-2.5 px-5 py-2.5 bg-[#FAFBFC] cursor-pointer hover:bg-slate-100" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <ChevronRight className="w-3 h-3 text-slate-400" /> : <ChevronDown className="w-3 h-3 text-slate-400" />}
          <span className="text-[13px] font-semibold text-slate-900">{label}</span>
          <span className="ml-auto text-[11px] font-medium text-slate-400">{tasks.length} tasks · {hours}h · ₪{amount.toLocaleString()}</span>
        </div>
      )}
      {!collapsed && (
        <table className="w-full">
          <thead>
            <tr className="bg-white border-b border-slate-50">
              <th className={cn(thClass, 'w-20 pl-5')} onClick={() => handleSort('code')}>Code{sortIcon('code')}</th>
              <th className={thClass} onClick={() => handleSort('name')}>Task{sortIcon('name')}</th>
              <th className={cn(thClass, 'w-28')} onClick={() => handleSort('zone')}>Zone{sortIcon('zone')}</th>
              <th className={cn(thClass, 'w-28')} onClick={() => handleSort('service')}>Service{sortIcon('service')}</th>
              <th className={cn(thClass, 'w-20')} onClick={() => handleSort('phase')}>Phase{sortIcon('phase')}</th>
              <th className={cn(thClass, 'w-14 text-right')} onClick={() => handleSort('hours')}>Hours{sortIcon('hours')}</th>
              <th className={cn(thClass, 'w-20 text-right')} onClick={() => handleSort('amount')}>Amount{sortIcon('amount')}</th>
              <th className={cn(thClass, 'w-28')}>Assignee</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody className="text-[13px]">
            {tasks.map((task: any) => {
              const assignee = task.assignees?.[0]?.user;
              return (
                <tr key={task.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50 group">
                  <td className="px-3 py-2 pl-5 font-mono text-xs font-medium text-slate-500">{task.code}</td>
                  <td className="px-3 py-2 font-medium text-slate-900">{task.name}</td>
                  <td className="px-3 py-2 text-[12px] text-slate-500">{task.zone?.name || '-'}</td>
                  <td className="px-3 py-2">{task.serviceType ? <span className="rounded-[5px] bg-blue-50 px-1.5 py-0.5 text-[11px] font-bold text-blue-600">{task.serviceType.name}</span> : <span className="text-slate-300">-</span>}</td>
                  <td className="px-3 py-2 text-[12px] text-slate-500">{task.phase?.name || '-'}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs font-medium text-slate-700">{task.budgetHours ? Number(task.budgetHours) : '-'}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs font-semibold text-slate-700">{task.budgetAmount ? `₪${Number(task.budgetAmount).toLocaleString()}` : '-'}</td>
                  <td className="px-3 py-2">
                    {assignee ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-5 h-5 rounded-full bg-violet-100 text-violet-600 text-[9px] font-semibold flex items-center justify-center">{assignee.firstName?.[0]}{assignee.lastName?.[0]}</span>
                        <span className="text-[12px] text-slate-700">{assignee.firstName}</span>
                      </span>
                    ) : (
                      <select className="text-[12px] text-slate-400 bg-transparent border-none cursor-pointer hover:text-slate-600 focus:outline-none" value=""
                        onChange={(e) => { if (e.target.value) { tasksApi.addAssignee(task.id, { userId: Number(e.target.value) }); onUpdate(task.id, {}); } }}>
                        <option value="">+ assign</option>
                        {members.map((m: any) => <option key={m.user?.id ?? m.id} value={m.user?.id ?? m.id}>{m.user?.firstName ?? m.firstName} {m.user?.lastName ?? m.lastName}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <button onClick={() => onDelete(task.id)} className="opacity-0 group-hover:opacity-100 w-[22px] h-[22px] rounded-[5px] hover:bg-red-50 flex items-center justify-center text-slate-300 hover:text-red-600 transition-all duration-150">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {tasks.length === 0 && <tr><td colSpan={9} className="px-5 py-8 text-center text-[13px] text-slate-400">No tasks yet. Select a zone and click "Add Task", or apply a template with pre-built tasks.</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Zone Panel ──────────────────────────────────────────────────────────────

function ZonePanel({ zones, selectedZone, onSelectZone, projectId, onInvalidate }: any) {
  const [addingZone, setAddingZone] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('zone');
  const [newParentId, setNewParentId] = useState<string>('');

  const createZone = useMutation({
    mutationFn: (data: any) => zonesApi.create(data),
    onSuccess: () => { onInvalidate(); setNewName(''); setAddingZone(false); notify.success('Zone created', { code: 'ZONE-CREATE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to create zone'),
  });

  const deleteZone = useMutation({
    mutationFn: (id: number) => zonesApi.remove(id),
    onSuccess: () => { onInvalidate(); notify.success('Zone deleted', { code: 'ZONE-DELETE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to delete zone'),
  });

  const duplicateZone = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => zonesApi.duplicate(id, name),
    onSuccess: () => { onInvalidate(); notify.success('Zone duplicated', { code: 'ZONE-DUP-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to duplicate zone'),
  });

  const flatZones = useMemo(() => {
    const result: any[] = [];
    function walk(nodes: any[], depth = 0) { for (const n of nodes) { result.push({ ...n, _depth: depth }); if (n.children) walk(n.children, depth + 1); } }
    walk(zones);
    return result;
  }, [zones]);

  return (
    <div className="w-[300px] shrink-0 border-r border-slate-200 flex flex-col bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h3 className="text-[15px] font-bold text-slate-900">Zone Structure</h3>
        <button onClick={() => setAddingZone(!addingZone)} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1.5">
          <Plus className="h-3.5 w-3.5" /> Add Zone
        </button>
      </div>

      {addingZone && (
        <div className="border-b border-slate-100 p-4 space-y-3 bg-blue-50/20">
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Zone Name *</label>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Tower A - Ground Floor" autoFocus
              className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
          </div>
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Zone Type</label>
            <select value={newType} onChange={(e) => setNewType(e.target.value)} className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none">
              {Object.entries(ZONE_DISPLAY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          {flatZones.length > 0 && (
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Parent Zone</label>
              <select value={newParentId} onChange={(e) => setNewParentId(e.target.value)} className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none">
                <option value="">— Root level —</option>
                {flatZones.map((z: any) => <option key={z.id} value={z.id}>{'  '.repeat(z._depth)}{z.name}</option>)}
              </select>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setAddingZone(false)} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
            <button onClick={() => { if (!newName.trim()) return; createZone.mutate({ projectId, name: newName.trim(), zoneType: newType, parentId: newParentId ? Number(newParentId) : null }); }}
              disabled={createZone.isPending || !newName.trim()} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">Add Zone</button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {zones.map((zone: any) => (
          <ZoneNode key={zone.id} zone={zone} selectedId={selectedZone?.id} onSelect={onSelectZone} onDelete={(id: number) => { if (confirm('Delete this zone and all its tasks?')) deleteZone.mutate(id); }} depth={0} />
        ))}
        {zones.length === 0 && !addingZone && <p className="px-3 py-8 text-center text-[13px] text-slate-400">No zones yet. Click "Add Zone" or apply a template above.</p>}
      </div>

      {selectedZone && (
        <div className="border-t border-slate-100 p-3">
          <button onClick={() => { const name = prompt('New zone name:', `${selectedZone.name} (copy)`); if (name) duplicateZone.mutate({ id: selectedZone.id, name }); }}
            className="w-full border border-dashed border-slate-300 hover:border-blue-500 bg-transparent hover:bg-blue-50 text-slate-500 hover:text-blue-600 text-[13px] font-semibold px-3 py-2 rounded-[7px] flex items-center justify-center gap-2 transition-all duration-150">
            <Copy className="w-3.5 h-3.5" /> Duplicate Zone
          </button>
        </div>
      )}
    </div>
  );
}

function ZoneNode({ zone, selectedId, onSelect, onDelete, depth }: any) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = zone.children?.length > 0;
  const isSelected = zone.id === selectedId;
  const display = ZONE_DISPLAY[zone.zoneType] || ZONE_DISPLAY.zone;

  return (
    <div>
      <div className={cn('group flex items-center gap-1.5 px-2.5 py-[7px] rounded-lg cursor-pointer transition-all duration-150',
        isSelected ? 'bg-blue-50 border border-blue-200' : 'hover:bg-slate-50'
      )} style={{ paddingLeft: `${depth * 20 + 10}px` }} onClick={() => onSelect(zone)}>
        {hasChildren ? (
          <button onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }} className="w-3 h-3 text-slate-400">
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        ) : <span className="w-3" />}
        <span className={cn('text-[13px] flex-1', isSelected ? 'font-semibold text-blue-700' : 'font-medium text-slate-700')}>{zone.name}</span>
        <span className="rounded-[5px] px-1.5 py-0.5 text-[11px] font-bold tracking-wide" style={{ backgroundColor: `${display.color}15`, color: display.color }}>{display.label}</span>
        <button onClick={(e) => { e.stopPropagation(); onDelete(zone.id); }}
          className="opacity-0 group-hover:opacity-100 w-[22px] h-[22px] rounded-[5px] hover:bg-red-50 flex items-center justify-center text-slate-300 hover:text-red-600 transition-all duration-150">
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
      {hasChildren && expanded && zone.children.map((child: any) => (
        <ZoneNode key={child.id} zone={child} selectedId={selectedId} onSelect={onSelect} onDelete={onDelete} depth={depth + 1} />
      ))}
    </div>
  );
}

// ─── Main Planning View ──────────────────────────────────────────────────────

function PlanningView({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const [selectedZone, setSelectedZone] = useState<any>(null);

  const { data: planningData, isLoading } = useQuery({
    queryKey: ['planning', projectId],
    queryFn: () => planningApi.getData(projectId),
    enabled: !!projectId,
  });

  const pd = (planningData as any)?.data ?? planningData;
  const zones = pd?.zones ?? [];
  const tasks = pd?.tasks ?? [];
  const members = pd?.members ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['planning', projectId] });

  // Filter tasks by selected zone
  const visibleTasks = useMemo(() => {
    if (!selectedZone) return tasks;
    const zoneIds = new Set<number>();
    function collectIds(z: any) { zoneIds.add(z.id); (z.children || []).forEach(collectIds); }
    collectIds(selectedZone);
    return tasks.filter((t: any) => zoneIds.has(t.zoneId));
  }, [tasks, selectedZone]);

  if (isLoading) return <div className="flex h-96 items-center justify-center text-[13px] text-slate-400">Loading planning data...</div>;

  const hasTasks = tasks.length > 0;
  const hasZones = zones.length > 0;

  return (
    <div className="space-y-6">
      {/* Template picker (show when no zones yet) */}
      {!hasZones && <TemplatePicker projectId={projectId} onApplied={invalidate} />}

      {/* "or build manually" divider (when no zones) */}
      {!hasZones && (
        <>
          <div className="flex items-center gap-4 py-2">
            <div className="flex-1 h-px bg-slate-200" /><span className="text-[13px] font-semibold text-slate-400">or build manually</span><div className="flex-1 h-px bg-slate-200" />
          </div>
        </>
      )}

      {/* Split panel: zones + tasks */}
      {(hasZones || hasTasks) ? (
        <div className="flex rounded-[14px] border border-slate-200 bg-white" style={{ height: 'calc(100vh - 300px)', minHeight: 400 }}>
          <ZonePanel zones={zones} selectedZone={selectedZone} onSelectZone={setSelectedZone} projectId={projectId} onInvalidate={invalidate} />
          <div className="flex-1 flex flex-col min-w-0 bg-slate-50 p-5 overflow-y-auto">
            <TaskTable tasks={visibleTasks} projectId={projectId} members={members} selectedZone={selectedZone} />
          </div>
        </div>
      ) : (
        <div className="text-center py-4">
          <p className="text-[13px] text-slate-400 mb-3">No zones yet. Apply a template above or add zones manually.</p>
        </div>
      )}
    </div>
  );
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export function PlanningPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const projectId = Number(id);

  return (
    <div className="space-y-4 px-7 py-5">
      <button onClick={() => navigate(`/projects/${projectId}`)} className="flex items-center gap-1.5 text-[13px] text-slate-400 hover:text-slate-600">
        <ArrowLeft className="h-4 w-4" /> Back to Project
      </button>
      <PlanningView projectId={projectId} />
    </div>
  );
}

export function PlanningTab({ projectId }: { projectId: number }) {
  return <PlanningView projectId={projectId} />;
}

export default PlanningPage;
