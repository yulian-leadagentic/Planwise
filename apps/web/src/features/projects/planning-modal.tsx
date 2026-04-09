import { useState, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, ArrowLeft, Trash2, Search, ChevronRight, ChevronDown, Copy, X } from 'lucide-react';
import { notify } from '@/lib/notify';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { planningApi, zonesApi, templatesApi } from '@/api/zones.api';
import { tasksApi } from '@/api/tasks.api';
import client from '@/api/client';

// ─── Template Picker Dialog ──────────────────────────────────────────────────

function TemplatePickerDialog({ projectId, onClose, onApplied }: { projectId: number; onClose: () => void; onApplied: () => void }) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [zoneName, setZoneName] = useState('');
  const [sortBy, setSortBy] = useState('usage');

  const { data: raw = [] } = useQuery({
    queryKey: ['templates', 'zone'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=zone').then((r) => r.data.data ?? r.data),
  });

  const templates = useMemo(() => {
    let list = Array.isArray(raw) ? raw : [];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((t: any) => t.name?.toLowerCase().includes(q) || t.code?.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q));
    }
    if (sortBy === 'usage') list.sort((a: any, b: any) => (b.usageCount ?? 0) - (a.usageCount ?? 0));
    else if (sortBy === 'name') list.sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
    return list;
  }, [raw, search, sortBy]);

  const selected = templates.find((t: any) => t.id === selectedId);

  const applyMutation = useMutation({
    mutationFn: async () => {
      if (!selected || !zoneName.trim()) return;
      // Apply template then rename the root zones
      const result = await planningApi.applyProjectTemplate(projectId, selected.id);
      // Rename: the first root zone created gets the user's name
      const created = (result as any)?.data ?? result;
      if (Array.isArray(created) && created.length > 0) {
        await zonesApi.update(created[0].id, { name: zoneName.trim() });
      }
    },
    onSuccess: () => {
      notify.success('Zone added from template', { code: 'TPL-APPLY-200' });
      onApplied();
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to apply template'),
  });

  return (
    <div className="bg-white rounded-[14px] border border-slate-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <h3 className="text-[15px] font-bold text-slate-900">Add Zone from Template</h3>
        <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Zone name — ALWAYS visible at top */}
      <div className="px-5 py-4 border-b border-slate-100 bg-blue-50/20">
        <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Zone Name for This Project *</label>
        <div className="flex items-center gap-3">
          <input value={zoneName} onChange={(e) => setZoneName(e.target.value)} placeholder="e.g. Tower A - Ground Floor"
            className="flex-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" autoFocus />
          {selected && (
            <button onClick={() => applyMutation.mutate()} disabled={applyMutation.isPending || !zoneName.trim()}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50 whitespace-nowrap">
              {applyMutation.isPending ? 'Adding...' : 'Add to Project'}
            </button>
          )}
        </div>
        {selected && <p className="text-[11px] text-slate-400 mt-1.5">Selected: <strong className="text-slate-700">{selected.name}</strong> — {selected._count?.templateTasks ?? 0} tasks will be created</p>}
        {!selected && <p className="text-[11px] text-slate-400 mt-1.5">Enter a name, then select a template below</p>}
      </div>

      {/* Search + Sort */}
      <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates..." className="w-full pl-9 px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" autoFocus />
        </div>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none">
          <option value="usage">Most Used</option>
          <option value="name">Name A-Z</option>
        </select>
      </div>
      <div className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[300px] overflow-y-auto">
        {templates.map((t: any) => {
          const isSelected = t.id === selectedId;
          const svcCount = new Set((t.templateTasks ?? []).map((tk: any) => tk.description?.match(/^\[SERVICE:(.+)\]$/)?.[1]).filter(Boolean)).size;
          return (
            <div key={t.id} onClick={() => { setSelectedId(isSelected ? null : t.id); if (!isSelected) setZoneName(t.name); }}
              className={cn('rounded-[14px] p-4 cursor-pointer transition-all duration-150',
                isSelected ? 'border-2 border-blue-500 bg-blue-50/40 shadow-sm' : 'border border-slate-200 hover:border-blue-300 hover:bg-blue-50/30')}>
              <div className="flex items-center gap-2 mb-2">
                <h4 className={cn('text-[13px] font-semibold flex-1', isSelected ? 'text-blue-700' : 'text-slate-900')}>{t.name}</h4>
                {isSelected && <span className="rounded-[5px] bg-blue-600 text-white text-[11px] font-bold px-2 py-0.5">Selected</span>}
              </div>
              {t.description && <p className={cn('text-[12px] mb-2 line-clamp-2', isSelected ? 'text-blue-600/70' : 'text-slate-500')}>{t.description}</p>}
              <div className={cn('text-[11px] font-medium', isSelected ? 'text-blue-400' : 'text-slate-400')}>
                {t._count?.templateZones ?? 0} zones · {svcCount} services · {t._count?.templateTasks ?? 0} tasks · Used {t.usageCount ?? 0}x
              </div>
            </div>
          );
        })}
        {templates.length === 0 && <p className="col-span-3 py-8 text-center text-[13px] text-slate-400">No zone templates available.</p>}
      </div>
    </div>
  );
}

// ─── Add Zone Manually Dialog ────────────────────────────────────────────────

function AddZoneManuallyDialog({ projectId, onClose, onCreated }: { projectId: number; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [zoneType, setZoneType] = useState('zone');
  const ZONE_TYPES = ['site', 'building', 'level', 'zone', 'area', 'section', 'wing', 'floor'];

  const createZone = useMutation({
    mutationFn: () => zonesApi.create({ projectId, name: name.trim(), zoneType }),
    onSuccess: () => { notify.success('Zone created', { code: 'ZONE-CREATE-200' }); onCreated(); onClose(); },
    onError: (err: any) => notify.apiError(err, 'Failed to create zone'),
  });

  return (
    <div className="bg-white rounded-[14px] border border-slate-200 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-bold text-slate-900">Add Zone Manually</h3>
        <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400"><X className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Zone Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tower A - Ground Floor" autoFocus
            className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
        </div>
        <div>
          <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Zone Type</label>
          <select value={zoneType} onChange={(e) => setZoneType(e.target.value)} className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none">
            {ZONE_TYPES.map(zt => <option key={zt} value={zt}>{zt.charAt(0).toUpperCase() + zt.slice(1)}</option>)}
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
        <button onClick={() => createZone.mutate()} disabled={createZone.isPending || !name.trim()} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
          {createZone.isPending ? 'Creating...' : 'Create Zone'}
        </button>
      </div>
    </div>
  );
}

// ─── Zone Group (collapsible) with task table ────────────────────────────────

function ZoneGroup({ zone, tasks, members, projectId, onUpdate, onDeleteTask, onDeleteZone, thClass, handleSort, sortIcon }: any) {
  const [collapsed, setCollapsed] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [showTaskMenu, setShowTaskMenu] = useState(false);
  const [showCatalogPicker, setShowCatalogPicker] = useState(false);
  const [newTask, setNewTask] = useState({ code: '', name: '', budgetHours: '', budgetAmount: '' });
  const queryClient = useQueryClient();

  const createTask = useMutation({
    mutationFn: (data: any) => tasksApi.create(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['planning', projectId] }); setShowAddTask(false); setNewTask({ code: '', name: '', budgetHours: '', budgetAmount: '' }); notify.success('Task created', { code: 'TASK-CREATE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to create task'),
  });

  const hours = tasks.reduce((s: number, t: any) => s + Number(t.budgetHours || 0), 0);
  const amount = tasks.reduce((s: number, t: any) => s + Number(t.budgetAmount || 0), 0);

  return (
    <div className="border-b border-slate-100 last:border-0">
      <div className="flex items-center gap-2.5 px-5 py-2.5 bg-[#FAFBFC] cursor-pointer" onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? <ChevronRight className="w-3 h-3 text-slate-400" /> : <ChevronDown className="w-3 h-3 text-slate-400" />}
        <span className="text-[13px] font-semibold text-slate-900">{zone.name}</span>
        <span className="rounded-[5px] bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-400">{zone.zoneType}</span>
        <span className="ml-auto text-[11px] font-medium text-slate-400">{tasks.length} tasks · {hours}h · ₪{amount.toLocaleString()}</span>
        <div className="relative" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => setShowTaskMenu(!showTaskMenu)} className="bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-semibold px-2.5 py-1 rounded-md flex items-center gap-1">
            <Plus className="w-3 h-3" /> Add Task
          </button>
          {showTaskMenu && (
            <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.12)] border border-black/5 bg-white p-1.5">
              <button onClick={() => { setShowCatalogPicker(true); setShowTaskMenu(false); setCollapsed(false); }} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-medium text-slate-700 hover:bg-slate-50">From Catalog</button>
              <button onClick={() => { setShowAddTask(true); setShowTaskMenu(false); setCollapsed(false); }} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-medium text-slate-700 hover:bg-slate-50">Create New Task</button>
            </div>
          )}
        </div>
        <button onClick={(e) => { e.stopPropagation(); if (confirm(`Delete zone "${zone.name}" and all its tasks?`)) onDeleteZone(zone.id); }}
          className="w-[22px] h-[22px] rounded-[5px] hover:bg-red-50 flex items-center justify-center text-slate-300 hover:text-red-600">
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {!collapsed && (
        <>
          {showAddTask && (
            <div className="px-5 py-2 bg-blue-50/20 flex items-center gap-2 border-b border-slate-50">
              <input value={newTask.code} onChange={(e) => setNewTask(f => ({ ...f, code: e.target.value }))} placeholder="Code *" className="w-20 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" autoFocus />
              <input value={newTask.name} onChange={(e) => setNewTask(f => ({ ...f, name: e.target.value }))} placeholder="Task name *" className="flex-1 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
              <input value={newTask.budgetHours} onChange={(e) => setNewTask(f => ({ ...f, budgetHours: e.target.value }))} placeholder="Hours" type="number" className="w-16 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
              <input value={newTask.budgetAmount} onChange={(e) => setNewTask(f => ({ ...f, budgetAmount: e.target.value }))} placeholder="Amount" type="number" className="w-20 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
              <button onClick={() => { if (!newTask.code.trim() || !newTask.name.trim()) { notify.warning('Code and Name required'); return; } createTask.mutate({ zoneId: zone.id, code: newTask.code.trim(), name: newTask.name.trim(), budgetHours: newTask.budgetHours ? Number(newTask.budgetHours) : undefined, budgetAmount: newTask.budgetAmount ? Number(newTask.budgetAmount) : undefined }); }}
                disabled={createTask.isPending} className="bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-semibold px-3 py-1.5 rounded-md disabled:opacity-50">Save</button>
              <button onClick={() => setShowAddTask(false)} className="text-[11px] text-slate-400 hover:text-slate-600 px-2 py-1.5">Cancel</button>
            </div>
          )}
          <table className="w-full">
            <thead>
              <tr className="bg-white border-b border-slate-50">
                <th className={cn(thClass, 'w-20 pl-5')} onClick={() => handleSort('code')}>Code{sortIcon('code')}</th>
                <th className={thClass} onClick={() => handleSort('name')}>Task Name{sortIcon('name')}</th>
                <th className={cn(thClass, 'w-28')} onClick={() => handleSort('zone')}>Zone{sortIcon('zone')}</th>
                <th className={cn(thClass, 'w-28')} onClick={() => handleSort('service')}>Service{sortIcon('service')}</th>
                <th className={cn(thClass, 'w-20')} onClick={() => handleSort('phase')}>Phase{sortIcon('phase')}</th>
                <th className={cn(thClass, 'w-14 text-right')} onClick={() => handleSort('hours')}>Hours{sortIcon('hours')}</th>
                <th className={cn(thClass, 'w-14 text-right')}>Logged</th>
                <th className={cn(thClass, 'w-20 text-right')} onClick={() => handleSort('amount')}>Amount{sortIcon('amount')}</th>
                <th className={cn(thClass, 'w-28')}>Assignee</th>
                <th className={cn(thClass, 'w-24')}>Status</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody className="text-[13px]">
              {tasks.map((task: any) => {
                const assignee = task.assignees?.[0]?.user;
                const statusMap: Record<string, { dot: string; text: string }> = { not_started: { dot: 'bg-slate-400', text: 'text-slate-500' }, in_progress: { dot: 'bg-blue-500', text: 'text-blue-600' }, in_review: { dot: 'bg-violet-500', text: 'text-violet-600' }, completed: { dot: 'bg-emerald-500', text: 'text-emerald-600' }, on_hold: { dot: 'bg-amber-500', text: 'text-amber-600' }, cancelled: { dot: 'bg-red-500', text: 'text-red-600' } };
                const st = statusMap[task.status] || statusMap.not_started;
                return (
                  <tr key={task.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50 group">
                    <td className="px-3 py-2 pl-5 font-mono text-xs font-medium text-slate-500">{task.code}</td>
                    <td className="px-3 py-2 font-medium text-slate-900">{task.name}</td>
                    <td className="px-3 py-2 text-[12px] text-slate-500">{task.zone?.name || '-'}</td>
                    <td className="px-3 py-2">{task.serviceType ? <span className="rounded-[5px] px-1.5 py-0.5 text-[11px] font-bold" style={{ backgroundColor: `${task.serviceType.color || '#3B82F6'}15`, color: task.serviceType.color || '#3B82F6' }}>{task.serviceType.name}</span> : <span className="text-slate-300">-</span>}</td>
                    <td className="px-3 py-2 text-[12px] text-slate-500">{task.phase?.name || '-'}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs font-medium text-slate-700">{task.budgetHours ? Number(task.budgetHours) : '-'}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{task.loggedMinutes > 0 ? <span className={cn('font-medium', task.budgetHours && (task.loggedMinutes / 60) > Number(task.budgetHours) ? 'text-red-600' : 'text-blue-600')}>{Math.round(task.loggedMinutes / 60 * 10) / 10}h</span> : <span className="text-slate-300">-</span>}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs font-semibold text-slate-700">{task.budgetAmount ? `₪${Number(task.budgetAmount).toLocaleString()}` : '-'}</td>
                    <td className="px-3 py-2">
                      {assignee ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-5 h-5 rounded-full bg-violet-100 text-violet-600 text-[9px] font-semibold flex items-center justify-center">{assignee.firstName?.[0]}{assignee.lastName?.[0]}</span>
                          <span className="text-[12px] text-slate-700">{assignee.firstName}</span>
                        </span>
                      ) : (
                        <select className="text-[12px] text-slate-400 bg-transparent border-none cursor-pointer focus:outline-none" value=""
                          onChange={(e) => { if (e.target.value) { tasksApi.addAssignee(task.id, { userId: Number(e.target.value) }); onUpdate(); } }}>
                          <option value="">+ assign</option>
                          {members.map((m: any) => <option key={m.user?.id ?? m.id} value={m.user?.id ?? m.id}>{m.user?.firstName ?? m.firstName} {m.user?.lastName ?? m.lastName}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1"><span className={cn('w-1.5 h-1.5 rounded-full', st.dot)} /><span className={cn('text-[12px]', st.text)}>{(task.status || 'not_started').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}</span></span>
                    </td>
                    <td className="px-3 py-2">
                      <button onClick={() => onDeleteTask(task.id)} className="opacity-0 group-hover:opacity-100 w-[22px] h-[22px] rounded-[5px] hover:bg-red-50 flex items-center justify-center text-slate-300 hover:text-red-600 transition-all duration-150">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {tasks.length === 0 && !showAddTask && (
                <tr><td colSpan={10} className="px-5 py-6 text-center text-[13px] text-slate-400">No tasks. Click "Add Task" to create one.</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}


// ─── Hierarchical Zone Group — flat tree style with colored borders ──────────

function HierarchicalZoneGroup({ zone, allTasks, members, projectId, onUpdate, onDeleteTask, onDeleteZone, onDuplicateZone, thClass, handleSort, sortIcon, depth }: any) {
  const [collapsed, setCollapsed] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [newTask, setNewTask] = useState({ code: '', name: '', budgetHours: '', budgetAmount: '' });
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [duplicateName, setDuplicateName] = useState('');
  const [showTaskMenu, setShowTaskMenu] = useState(false);
  const [saveToCatalog, setSaveToCatalog] = useState(true);
  const queryClient = useQueryClient();

  const createTask = useMutation({
    mutationFn: (data: any) => tasksApi.create(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['planning', projectId] }); setShowAddTask(false); setNewTask({ code: '', name: '', budgetHours: '', budgetAmount: '' }); notify.success('Task created', { code: 'TASK-CREATE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to create task'),
  });

  const directTasks = allTasks.filter((t: any) => t.zoneId === zone.id);
  const allZoneIds = new Set<number>();
  function collectIds(z: any) { allZoneIds.add(z.id); (z.children || []).forEach(collectIds); }
  collectIds(zone);
  const allZoneTasks = allTasks.filter((t: any) => allZoneIds.has(t.zoneId));
  const totalHours = allZoneTasks.reduce((s: number, t: any) => s + Number(t.budgetHours || 0), 0);
  const totalAmount = allZoneTasks.reduce((s: number, t: any) => s + Number(t.budgetAmount || 0), 0);
  const hasChildren = zone.children?.length > 0;

  // Zone type colors from design system
  const zoneColors: Record<string, { border: string; bg: string; text: string }> = {
    site: { border: 'border-l-indigo-400', bg: 'bg-indigo-50', text: 'text-indigo-700' },
    building: { border: 'border-l-amber-500', bg: 'bg-amber-50', text: 'text-amber-700' },
    level: { border: 'border-l-teal-400', bg: 'bg-teal-50', text: 'text-teal-700' },
    zone: { border: 'border-l-amber-400', bg: 'bg-amber-50', text: 'text-amber-600' },
    area: { border: 'border-l-purple-400', bg: 'bg-purple-50', text: 'text-purple-700' },
    floor: { border: 'border-l-blue-400', bg: 'bg-blue-50', text: 'text-blue-700' },
    section: { border: 'border-l-teal-400', bg: 'bg-teal-50', text: 'text-teal-700' },
    wing: { border: 'border-l-pink-400', bg: 'bg-pink-50', text: 'text-pink-700' },
  };
  const zc = zoneColors[zone.zoneType] || zoneColors.zone;

  return (
    <div style={{ marginLeft: depth > 0 ? depth * 28 : 0 }}>
      {/* Zone row — full width with colored left border */}
      <div className={cn('flex items-center gap-2.5 py-3 px-4 border-l-[3px] cursor-pointer hover:bg-slate-50/80 group transition-colors duration-100', zc.border, 'border-b border-slate-100')}
        onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
        <span className={cn('rounded-[5px] px-2 py-0.5 text-[11px] font-bold tracking-wide shrink-0', zc.bg, zc.text)}>{zone.zoneType}</span>
        <span className={cn('font-semibold', depth === 0 ? 'text-[15px] text-slate-900' : 'text-[13px] text-slate-800')}>{zone.name}</span>
        {hasChildren && <span className="text-[11px] text-slate-400">({zone.children.length} sub-zones)</span>}
        <span className="ml-auto text-[11px] font-medium text-slate-400 shrink-0">{allZoneTasks.length} tasks · {totalHours}h · ₪{totalAmount.toLocaleString()}</span>

        <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <div className="relative">
            <button onClick={() => setShowTaskMenu(!showTaskMenu)} className="bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-semibold px-2 py-1 rounded-md flex items-center gap-1">
              <Plus className="w-3 h-3" /> Task
            </button>
            {showTaskMenu && (
              <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.12)] border border-black/5 bg-white p-1.5">
                <button onClick={() => { setShowAddTask(true); setShowTaskMenu(false); setCollapsed(false); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-slate-700 hover:bg-slate-50">Create New</button>
                <button onClick={() => { setShowTaskMenu(false); setCollapsed(false); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-slate-700 hover:bg-slate-50">From Catalog</button>
              </div>
            )}
          </div>
          {depth === 0 && onDuplicateZone && (
            <button onClick={() => { setDuplicateName(`${zone.name} (copy)`); setShowDuplicateModal(true); }}
              className="text-slate-400 hover:text-blue-600 text-[11px] font-medium px-2 py-1 rounded-md hover:bg-blue-50 flex items-center gap-1">
              <Copy className="w-3 h-3" /> Dup
            </button>
          )}
          <button onClick={() => { if (confirm(`Delete "${zone.name}"?`)) onDeleteZone(zone.id); }}
            className="w-[22px] h-[22px] rounded-[5px] hover:bg-red-50 flex items-center justify-center text-slate-300 hover:text-red-600">
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {showAddTask && (
            <div style={{ marginLeft: 28 }} className="flex items-center gap-2 py-2 px-4 border-b border-slate-50 bg-blue-50/20">
              <input value={newTask.code} onChange={(e) => setNewTask(f => ({ ...f, code: e.target.value }))} placeholder="Code *" className="w-20 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" autoFocus />
              <input value={newTask.name} onChange={(e) => setNewTask(f => ({ ...f, name: e.target.value }))} placeholder="Task name *" className="flex-1 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
              <input value={newTask.budgetHours} onChange={(e) => setNewTask(f => ({ ...f, budgetHours: e.target.value }))} placeholder="Hrs" type="number" className="w-14 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
              <input value={newTask.budgetAmount} onChange={(e) => setNewTask(f => ({ ...f, budgetAmount: e.target.value }))} placeholder="Amt" type="number" className="w-16 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
              <button onClick={async () => {
                if (!newTask.code.trim() || !newTask.name.trim()) { notify.warning('Code and Name required'); return; }
                const payload = { code: newTask.code.trim(), name: newTask.name.trim(), budgetHours: newTask.budgetHours ? Number(newTask.budgetHours) : undefined, budgetAmount: newTask.budgetAmount ? Number(newTask.budgetAmount) : undefined };
                if (saveToCatalog) { try { const cats = await client.get('/templates?type=task_list').then(r => r.data.data ?? r.data); const cat = (Array.isArray(cats) ? cats : []).find((t: any) => t.code === '__TASK_CATALOG__'); if (cat) await client.post(`/templates/${cat.id}/tasks`, { ...payload, defaultBudgetHours: payload.budgetHours, defaultBudgetAmount: payload.budgetAmount }); } catch {} }
                createTask.mutate({ zoneId: zone.id, ...payload });
              }} disabled={createTask.isPending} className="bg-blue-600 text-white text-[11px] font-semibold px-3 py-1.5 rounded-md disabled:opacity-50">Save</button>
              <label className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer whitespace-nowrap"><input type="checkbox" checked={saveToCatalog} onChange={(e) => setSaveToCatalog(e.target.checked)} className="h-3 w-3 rounded" />Catalog</label>
              <button onClick={() => setShowAddTask(false)} className="text-[11px] text-slate-400 px-1">✕</button>
            </div>
          )}

          {directTasks.map((task: any) => {
            const assignee = task.assignees?.[0]?.user;
            const stColor: Record<string, string> = { not_started: 'text-slate-400', in_progress: 'text-blue-600', completed: 'text-emerald-600', on_hold: 'text-amber-600', in_review: 'text-violet-600', cancelled: 'text-red-500' };
            return (
              <div key={task.id} style={{ marginLeft: 28 }} className="flex items-center gap-3 py-2.5 px-4 border-b border-slate-50 hover:bg-slate-50/50 group text-[13px]">
                <span className="font-mono text-xs font-medium text-slate-400 w-24 shrink-0">{task.code}</span>
                <span className="font-medium text-slate-900 flex-1 min-w-0 truncate">{task.name}</span>
                {task.serviceType ? <span className="rounded-[5px] px-1.5 py-0.5 text-[11px] font-bold shrink-0" style={{ backgroundColor: `${task.serviceType.color || '#3B82F6'}15`, color: task.serviceType.color || '#3B82F6' }}>{task.serviceType.name}</span> : null}
                {task.phase ? <span className="text-[11px] text-slate-400 shrink-0">{task.phase.name}</span> : null}
                <span className="font-mono text-xs text-slate-500 w-10 text-right shrink-0">{task.budgetHours ? Number(task.budgetHours) : '-'}</span>
                <span className="font-mono text-xs w-12 text-right shrink-0">{task.loggedMinutes > 0 ? <span className={cn('font-medium', task.budgetHours && (task.loggedMinutes / 60) > Number(task.budgetHours) ? 'text-red-600' : 'text-blue-600')}>{Math.round(task.loggedMinutes / 60 * 10) / 10}h</span> : <span className="text-slate-300">-</span>}</span>
                <span className="font-mono text-xs font-semibold text-slate-700 w-16 text-right shrink-0">{task.budgetAmount ? `₪${Number(task.budgetAmount).toLocaleString()}` : '-'}</span>
                <span className="w-20 shrink-0">
                  {assignee ? (
                    <span className="inline-flex items-center gap-1"><span className="w-5 h-5 rounded-full bg-violet-100 text-violet-600 text-[9px] font-semibold flex items-center justify-center">{assignee.firstName?.[0]}{assignee.lastName?.[0]}</span><span className="text-[11px]">{assignee.firstName}</span></span>
                  ) : (
                    <select className="text-[11px] text-slate-400 bg-transparent border-none cursor-pointer focus:outline-none w-full" value="" onChange={(e) => { if (e.target.value) { tasksApi.addAssignee(task.id, { userId: Number(e.target.value) }); onUpdate(); } }}>
                      <option value="">+assign</option>
                      {members.map((m: any) => <option key={m.user?.id ?? m.id} value={m.user?.id ?? m.id}>{m.user?.firstName} {m.user?.lastName}</option>)}
                    </select>
                  )}
                </span>
                <span className={cn('text-[11px] font-medium w-20 shrink-0', stColor[task.status as string] || 'text-slate-400')}>{(task.status || 'not_started').replace(/_/g, ' ')}</span>
                <button onClick={() => onDeleteTask(task.id)} className="w-[18px] h-[18px] rounded hover:bg-red-50 flex items-center justify-center text-slate-300 hover:text-red-500"><Trash2 className="w-3 h-3" /></button>
              </div>
            );
          })}

          {hasChildren && zone.children.map((child: any) => (
            <HierarchicalZoneGroup key={child.id} zone={child} allTasks={allTasks} members={members} projectId={projectId}
              onUpdate={onUpdate} onDeleteTask={onDeleteTask} onDeleteZone={onDeleteZone} onDuplicateZone={onDuplicateZone}
              thClass={thClass} handleSort={handleSort} sortIcon={sortIcon} depth={depth + 1} />
          ))}
        </>
      )}

      {showDuplicateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={() => setShowDuplicateModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[440px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-900">Duplicate Zone</h3>
              <p className="text-[13px] text-slate-400 mt-0.5">Copy "{zone.name}" with all tasks and sub-zones</p>
            </div>
            <div className="p-5">
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">New Zone Name *</label>
              <input value={duplicateName} onChange={(e) => setDuplicateName(e.target.value)} autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter' && duplicateName.trim()) { onDuplicateZone(zone.id, duplicateName.trim()); setShowDuplicateModal(false); } }}
                className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
            </div>
            <div className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">
              <button onClick={() => setShowDuplicateModal(false)} className="bg-white border border-slate-200 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
              <button onClick={() => { if (duplicateName.trim()) { onDuplicateZone(zone.id, duplicateName.trim()); setShowDuplicateModal(false); } }}
                disabled={!duplicateName.trim()} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">Duplicate</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
// ─── Main Planning View ──────────────────────────────────────────────────────

function PlanningView({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showManualZone, setShowManualZone] = useState(false);
  const [groupBy, setGroupBy] = useState<'zone' | 'service' | 'phase' | 'none'>('zone');
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const { data: planningData, isLoading } = useQuery({
    queryKey: ['planning', projectId],
    queryFn: () => planningApi.getData(projectId),
    enabled: !!projectId,
  });

  const pd = (planningData as any)?.data ?? planningData;
  const zones = pd?.zones ?? [];
  const tasks = pd?.tasks ?? [];
  const members = pd?.members ?? [];
  const budget = pd?.budgetSummary;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['planning', projectId] });

  const duplicateZone = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => zonesApi.duplicate(id, name),
    onSuccess: () => { invalidate(); notify.success('Zone duplicated', { code: 'ZONE-DUP-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to duplicate zone'),
  });

  const deleteTask = useMutation({
    mutationFn: (id: number) => tasksApi.delete(id),
    onSuccess: () => { invalidate(); notify.success('Task deleted', { code: 'TASK-DELETE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to delete task'),
  });

  const deleteZone = useMutation({
    mutationFn: (id: number) => zonesApi.remove(id),
    onSuccess: () => { invalidate(); notify.success('Zone deleted', { code: 'ZONE-DELETE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to delete zone'),
  });

  // Filter
  const filtered = useMemo(() => {
    if (!search.trim()) return tasks;
    const q = search.toLowerCase();
    return tasks.filter((t: any) => t.code?.toLowerCase().includes(q) || t.name?.toLowerCase().includes(q) || t.zone?.name?.toLowerCase().includes(q) || t.serviceType?.name?.toLowerCase().includes(q));
  }, [tasks, search]);

  // Sort
  const sorted = useMemo(() => {
    if (!sortCol) return filtered;
    return [...filtered].sort((a: any, b: any) => {
      let va: any, vb: any;
      switch (sortCol) {
        case 'code': va = a.code || ''; vb = b.code || ''; break;
        case 'name': va = a.name || ''; vb = b.name || ''; break;
        case 'service': va = a.serviceType?.name || ''; vb = b.serviceType?.name || ''; break;
        case 'phase': va = a.phase?.name || ''; vb = b.phase?.name || ''; break;
        case 'hours': va = Number(a.budgetHours) || 0; vb = Number(b.budgetHours) || 0; break;
        case 'amount': va = Number(a.budgetAmount) || 0; vb = Number(b.budgetAmount) || 0; break;
        default: return 0;
      }
      if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb as string).toLowerCase(); }
      return va < vb ? (sortDir === 'asc' ? -1 : 1) : va > vb ? (sortDir === 'asc' ? 1 : -1) : 0;
    });
  }, [filtered, sortCol, sortDir]);

  const handleSort = (col: string) => { if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortCol(col); setSortDir('asc'); } };
  const sortIcon = (col: string) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  const thClass = "px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em] cursor-pointer select-none hover:text-slate-600";

  // Group tasks
  const flatZones = useMemo(() => { const r: any[] = []; function walk(z: any[]) { for (const n of z) { r.push(n); if (n.children) walk(n.children); } } walk(zones); return r; }, [zones]);

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', zone: null, tasks: sorted }];
    if (groupBy === 'zone') {
      return flatZones.map((z: any) => ({ key: z.id, zone: z, tasks: sorted.filter((t: any) => t.zoneId === z.id) })).filter((g: any) => g.tasks.length > 0);
    }
    const map = new Map<string, { key: string; zone: null; tasks: any[] }>();
    for (const t of sorted) {
      let key = '';
      if (groupBy === 'service') {
        // Try serviceType first, then extract from description tag [SERVICE:name]
        key = t.serviceType?.name || t.description?.match(/^\[SERVICE:(.+)\]$/)?.[1] || 'No Service';
      } else {
        key = t.phase?.name || 'No Phase/Milestone';
      }
      if (!map.has(key)) map.set(key, { key, zone: null, tasks: [] });
      map.get(key)!.tasks.push(t);
    }
    return Array.from(map.values());
  }, [sorted, groupBy, flatZones]);

  const totalHours = sorted.reduce((s: number, t: any) => s + Number(t.budgetHours || 0), 0);
  const totalAmount = sorted.reduce((s: number, t: any) => s + Number(t.budgetAmount || 0), 0);
  const totalLoggedMinutes = sorted.reduce((s: number, t: any) => s + (t.loggedMinutes || 0), 0);
  const totalLoggedHours = Math.round(totalLoggedMinutes / 60 * 10) / 10;

  if (isLoading) return <div className="flex h-96 items-center justify-center text-[13px] text-slate-400">Loading...</div>;

  return (
    <div className="space-y-5">
      {/* Template picker / manual zone dialogs */}
      {showTemplatePicker && <TemplatePickerDialog projectId={projectId} onClose={() => setShowTemplatePicker(false)} onApplied={invalidate} />}
      {showManualZone && <AddZoneManuallyDialog projectId={projectId} onClose={() => setShowManualZone(false)} onCreated={invalidate} />}

      {/* Action bar */}
      {!showTemplatePicker && !showManualZone && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={() => setShowTemplatePicker(true)} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Add Zone from Template
            </button>
            <button onClick={() => setShowManualZone(true)} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Add Zone Manually
            </button>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold text-slate-400">Group:</span>
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as any)} className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-[13px] text-slate-700 focus:border-blue-500 focus:outline-none">
                <option value="zone">Zone</option>
                <option value="service">Service</option>
                <option value="phase">Phase/Milestone</option>
                <option value="none">No Grouping</option>
              </select>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter tasks..." className="w-48 pl-8 px-2.5 py-1.5 rounded-lg border border-slate-200 text-[13px] text-slate-700 focus:border-blue-500 focus:outline-none" />
            </div>
          </div>
        </div>
      )}

      {/* Task table — full width */}
      {sorted.length > 0 || flatZones.length > 0 ? (
        <div>
          <div className="flex items-center justify-between py-3 border-b border-slate-200">
            <div>
              <h3 className="text-[15px] font-bold text-slate-900">Project Tasks</h3>
              <span className="text-[11px] font-medium text-slate-400">{sorted.length} tasks · {totalHours}h budget{totalLoggedHours > 0 ? ` · ${totalLoggedHours}h logged` : ''} · ₪{totalAmount.toLocaleString()}</span>
            </div>
          </div>

          {/* Column header for non-zone grouping */}
          {groupBy !== 'zone' && (
            <div className="flex items-center gap-3 py-1.5 px-4 border-b border-slate-100 bg-[#FAFBFC] text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">
              <span className="w-24 shrink-0">Code</span>
              <span className="flex-1">Task Name</span>
              <span className="w-28 shrink-0">Zone</span>
              <span className="w-24 shrink-0">Service</span>
              <span className="w-24 shrink-0">Phase/Milestone</span>
              <span className="w-10 text-right shrink-0">Hours</span>
              <span className="w-12 text-right shrink-0">Logged</span>
              <span className="w-16 text-right shrink-0">Amount</span>
              <span className="w-20 shrink-0">Assignee</span>
              <span className="w-20 shrink-0">Status</span>
              <span className="w-5 shrink-0"></span>
            </div>
          )}

          {groupBy === 'zone' ? (
            zones.map((z: any) => (
              <HierarchicalZoneGroup key={z.id} zone={z} allTasks={sorted} members={members} projectId={projectId}
                onUpdate={invalidate} onDeleteTask={(id: number) => { if (confirm('Delete this task?')) deleteTask.mutate(id); }}
                onDeleteZone={(id: number) => deleteZone.mutate(id)} onDuplicateZone={(id: number, name: string) => duplicateZone.mutate({ id, name })}
                thClass={thClass} handleSort={handleSort} sortIcon={sortIcon} depth={0} />
            ))
          ) : (
            groups.map((g: any) => (
              <ZoneGroup key={g.key} zone={{ id: 0, name: g.key, zoneType: groupBy }} tasks={g.tasks} members={members} projectId={projectId}
                onUpdate={invalidate} onDeleteTask={(id: number) => { if (confirm('Delete this task?')) deleteTask.mutate(id); }}
                onDeleteZone={() => {}} thClass={thClass} handleSort={handleSort} sortIcon={sortIcon} />
            ))
          )}

          <div className="flex items-center gap-6 px-4 py-2.5 border-t border-slate-200 bg-[#FAFBFC] text-[12px]">
            <div><span className="text-slate-400">Total:</span> <span className="font-mono text-xs font-semibold text-slate-900 ml-1">{sorted.length} tasks · {totalHours}h · ₪{totalAmount.toLocaleString()}</span></div>
            {totalLoggedHours > 0 && (
              <>
                <span className="text-slate-300">│</span>
                <div><span className="text-slate-400">Logged:</span> <span className={cn('font-mono text-xs font-semibold ml-1', totalLoggedHours > totalHours && totalHours > 0 ? 'text-red-600' : 'text-blue-600')}>{totalLoggedHours}h</span>{totalHours > 0 && <span className="text-slate-400 ml-1">/ {totalHours}h ({Math.round(totalLoggedHours / totalHours * 100)}%)</span>}</div>
              </>
            )}
            {budget?.projectBudget > 0 && (
              <>
                <span className="text-slate-300">│</span>
                <div><span className="text-slate-400">Budget:</span> <span className="font-mono text-xs font-semibold text-slate-900 ml-1">₪{Number(budget.projectBudget).toLocaleString()}</span></div>
                <div><span className="text-slate-400">Remaining:</span> <span className={cn('font-mono text-xs font-semibold ml-1', budget.remaining >= 0 ? 'text-emerald-600' : 'text-red-600')}>₪{Number(budget.remaining).toLocaleString()}</span></div>
                <div className="flex-1 max-w-[200px]"><div className="w-full h-1 bg-slate-200 rounded-full overflow-hidden"><div className="h-full bg-blue-500 rounded-full transition-all duration-400" style={{ width: `${Math.min(100, 100 - (budget.remainingPct || 0))}%` }} /></div></div>
              </>
            )}
          </div>
        </div>
      ) : !showTemplatePicker && !showManualZone ? (
        <div className="bg-white rounded-[14px] border border-slate-200 p-12 text-center">
          <p className="text-[15px] font-bold text-slate-900 mb-2">No zones or tasks yet</p>
          <p className="text-[13px] text-slate-400 mb-4">Start by adding a zone from a template or create one manually</p>
        </div>
      ) : null}
    </div>
  );
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export function PlanningPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  return (
    <div className="px-4 py-5 space-y-4">
      <button onClick={() => navigate(`/projects/${Number(id)}`)} className="flex items-center gap-1.5 text-[13px] text-slate-400 hover:text-slate-600"><ArrowLeft className="h-4 w-4" /> Back to Project</button>
      <PlanningView projectId={Number(id)} />
    </div>
  );
}

export function PlanningTab({ projectId }: { projectId: number }) {
  return <PlanningView projectId={projectId} />;
}

export default PlanningPage;
