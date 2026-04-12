import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, ArrowLeft, Trash2, Search, ChevronRight, ChevronDown, Copy, X, UserPlus, GripVertical, Layers } from 'lucide-react';
import { notify } from '@/lib/notify';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { planningApi, zonesApi, templatesApi } from '@/api/zones.api';
import { tasksApi } from '@/api/tasks.api';
import client from '@/api/client';

// ─── Bulk Action Bar — floating bar for operating on selected tasks ─────────

function BulkActionBar({
  selectedCount,
  selectedTaskIds,
  members,
  projectId,
  onClear,
}: {
  selectedCount: number;
  selectedTaskIds: Set<number>;
  members: any[];
  projectId: number;
  onClear: () => void;
}) {
  const [assignOpen, setAssignOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const assignRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!assignOpen && !statusOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (assignOpen && assignRef.current && !assignRef.current.contains(e.target as Node)) {
        setAssignOpen(false);
      }
      if (statusOpen && statusRef.current && !statusRef.current.contains(e.target as Node)) {
        setStatusOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [assignOpen, statusOpen]);

  const filteredMembers = useMemo(() => {
    const q = search.toLowerCase().trim();
    return members.filter((m: any) => {
      if (!q) return true;
      const u = m.user ?? m;
      const full = `${u.firstName ?? ''} ${u.lastName ?? ''}`.toLowerCase();
      return full.includes(q);
    });
  }, [members, search]);

  const handleBulkAssign = async (userId: number) => {
    if (busy || selectedTaskIds.size === 0) return;
    setBusy(true);
    const taskIds = Array.from(selectedTaskIds);
    // Parallel assignments — ignore conflicts (user already assigned to a task)
    const results = await Promise.allSettled(
      taskIds.map((taskId) => tasksApi.addAssignee(taskId, { userId })),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const alreadyAssigned = results.filter(
      (r) => r.status === 'rejected' && (r as PromiseRejectedResult).reason?.response?.status === 409,
    ).length;
    const failed = results.length - succeeded - alreadyAssigned;

    queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
    setBusy(false);
    setAssignOpen(false);
    setSearch('');

    const user = members.find((m: any) => (m.user?.id ?? m.id) === userId);
    const u = user?.user ?? user ?? {};
    const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || 'user';

    if (succeeded > 0 && failed === 0 && alreadyAssigned === 0) {
      notify.success(`Assigned ${name} to ${succeeded} task${succeeded !== 1 ? 's' : ''}`, {
        code: 'TASK-ASSIGN-200',
      });
    } else if (succeeded > 0 && alreadyAssigned > 0 && failed === 0) {
      notify.success(
        `Assigned ${name} to ${succeeded} task${succeeded !== 1 ? 's' : ''} (${alreadyAssigned} already assigned)`,
        { code: 'TASK-ASSIGN-200' },
      );
    } else if (failed > 0 && succeeded > 0) {
      notify.warning(`Assigned to ${succeeded}, ${failed} failed`, { code: 'TASK-ASSIGN-207' });
    } else if (succeeded === 0 && alreadyAssigned > 0 && failed === 0) {
      notify.info(`${name} is already assigned to all selected tasks`);
    } else {
      notify.error(`Could not assign ${name}`, { code: 'TASK-ASSIGN-500' });
    }
    onClear();
  };

  const handleBulkStatus = async (status: string) => {
    if (busy || selectedTaskIds.size === 0) return;
    setBusy(true);
    const taskIds = Array.from(selectedTaskIds);
    const results = await Promise.allSettled(
      taskIds.map((taskId) => tasksApi.update(taskId, { status })),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;

    queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
    setBusy(false);
    setStatusOpen(false);

    if (succeeded > 0 && failed === 0) {
      notify.success(`Updated status on ${succeeded} task${succeeded !== 1 ? 's' : ''}`, {
        code: 'TASK-UPDATE-200',
      });
    } else if (succeeded > 0 && failed > 0) {
      notify.warning(`Updated ${succeeded}, ${failed} failed`, { code: 'TASK-UPDATE-207' });
    } else {
      notify.error(`Could not update status`, { code: 'TASK-UPDATE-500' });
    }
    onClear();
  };

  if (selectedCount === 0) return null;

  const statusOptions = [
    { value: 'not_started', label: 'Not Started', dot: 'bg-slate-400' },
    { value: 'in_progress', label: 'In Progress', dot: 'bg-blue-500' },
    { value: 'in_review', label: 'In Review', dot: 'bg-violet-500' },
    { value: 'completed', label: 'Completed', dot: 'bg-emerald-500' },
    { value: 'on_hold', label: 'On Hold', dot: 'bg-amber-500' },
    { value: 'cancelled', label: 'Cancelled', dot: 'bg-red-500' },
  ];

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40">
      <div className="flex items-center gap-3 rounded-[14px] border border-slate-200 bg-white px-4 py-3 shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-white text-xs font-bold">
            {selectedCount}
          </span>
          <span className="text-sm font-semibold text-slate-700">
            task{selectedCount !== 1 ? 's' : ''} selected
          </span>
        </div>

        <div className="h-5 w-px bg-slate-200" />

        {/* Assign dropdown */}
        <div className="relative" ref={assignRef}>
          <button
            type="button"
            onClick={() => { setAssignOpen(!assignOpen); setStatusOpen(false); }}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3 py-1.5 disabled:opacity-50"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Assign
          </button>
          {assignOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-64 rounded-lg border border-slate-200 bg-white shadow-xl">
              <div className="border-b border-slate-100 px-3 py-2">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search members..."
                    className="w-full rounded-md border border-slate-200 bg-slate-50 pl-7 pr-2 py-1.5 text-xs text-slate-700 focus:border-blue-400 focus:outline-none"
                    autoFocus
                  />
                </div>
              </div>
              <div className="max-h-56 overflow-y-auto py-1">
                {filteredMembers.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-slate-400">
                    {members.length === 0 ? 'No project members' : 'No match'}
                  </p>
                ) : (
                  filteredMembers.map((m: any) => {
                    const u = m.user ?? m;
                    const uid = u.id;
                    const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || 'Unknown';
                    return (
                      <button
                        key={uid}
                        type="button"
                        disabled={busy}
                        onClick={() => handleBulkAssign(uid)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 disabled:opacity-50"
                      >
                        <span className="w-5 h-5 rounded-full bg-violet-100 text-violet-600 text-[9px] font-semibold flex items-center justify-center shrink-0">
                          {(u.firstName?.[0] ?? '') + (u.lastName?.[0] ?? '')}
                        </span>
                        <span className="truncate text-slate-700">{name}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* Status dropdown */}
        <div className="relative" ref={statusRef}>
          <button
            type="button"
            onClick={() => { setStatusOpen(!statusOpen); setAssignOpen(false); }}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-[13px] font-semibold px-3 py-1.5 disabled:opacity-50"
          >
            Set Status
            <ChevronDown className="h-3 w-3" />
          </button>
          {statusOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-48 rounded-lg border border-slate-200 bg-white shadow-xl py-1">
              {statusOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={busy}
                  onClick={() => handleBulkStatus(opt.value)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 disabled:opacity-50"
                >
                  <span className={cn('w-2 h-2 rounded-full', opt.dot)} />
                  <span className="text-slate-700">{opt.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="h-5 w-px bg-slate-200" />

        <button
          type="button"
          onClick={onClear}
          disabled={busy}
          className="text-[13px] font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-50"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

// ─── Assignee Picker — multi-select, add/remove assignees on a task ──────────

function AssigneePicker({
  task,
  members,
  projectId,
  onUpdate,
}: {
  task: any;
  members: any[];
  projectId: number;
  onUpdate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);

  const assignees: any[] = task.assignees ?? [];
  const assignedUserIds = new Set(
    assignees.map((a: any) => a.user?.id ?? a.userId).filter((id: any) => typeof id === 'number'),
  );

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['planning', projectId] });

  const addOne = async (userId: number) => {
    if (assignedUserIds.has(userId) || busy) return;
    setBusy(true);
    try {
      await tasksApi.addAssignee(task.id, { userId });
      invalidate();
      onUpdate();
    } catch (err: any) {
      notify.apiError(err, 'Failed to assign');
    } finally {
      setBusy(false);
    }
  };

  const removeOne = async (userId: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await tasksApi.removeAssignee(task.id, userId);
      invalidate();
      onUpdate();
    } catch (err: any) {
      notify.apiError(err, 'Failed to unassign');
    } finally {
      setBusy(false);
    }
  };

  // Filter available members — exclude ones already assigned
  const available = members.filter((m: any) => {
    const uid = m.user?.id ?? m.id;
    return typeof uid === 'number' && !assignedUserIds.has(uid);
  });

  return (
    <div ref={ref} className="relative inline-flex items-center gap-1">
      {/* Stacked avatars of current assignees */}
      {assignees.length > 0 && (
        <div className="flex -space-x-1.5">
          {assignees.slice(0, 3).map((a: any) => {
            const u = a.user ?? {};
            return (
              <button
                key={a.id ?? u.id}
                type="button"
                onClick={(e) => { e.stopPropagation(); removeOne(u.id); }}
                title={`Remove ${u.firstName ?? ''} ${u.lastName ?? ''}`}
                className="relative w-5 h-5 rounded-full bg-violet-100 text-violet-600 text-[9px] font-semibold flex items-center justify-center ring-2 ring-white hover:bg-red-100 hover:text-red-600 group/avatar"
              >
                {(u.firstName?.[0] ?? '') + (u.lastName?.[0] ?? '')}
                <X className="absolute inset-0 m-auto h-2.5 w-2.5 opacity-0 group-hover/avatar:opacity-100" />
              </button>
            );
          })}
          {assignees.length > 3 && (
            <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-500 text-[9px] font-semibold flex items-center justify-center ring-2 ring-white">
              +{assignees.length - 3}
            </span>
          )}
        </div>
      )}

      {/* Add button (only if there are available members) */}
      {available.length > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
          className="w-5 h-5 rounded-full border border-dashed border-slate-300 text-slate-400 flex items-center justify-center hover:border-blue-500 hover:text-blue-600"
          title="Assign people"
        >
          <Plus className="h-3 w-3" />
        </button>
      )}

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 w-52 rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="px-3 py-2 border-b border-slate-100 text-[11px] font-semibold text-slate-500">
            Assign People
          </div>
          <div className="max-h-48 overflow-y-auto py-1">
            {available.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-slate-400">
                {members.length === 0 ? 'No project members' : 'Everyone is already assigned'}
              </p>
            ) : (
              available.map((m: any) => {
                const u = m.user ?? m;
                const uid = u.id;
                const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || 'Unknown';
                return (
                  <button
                    key={uid}
                    type="button"
                    disabled={busy}
                    onClick={(e) => { e.stopPropagation(); addOne(uid); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 disabled:opacity-50"
                  >
                    <span className="w-5 h-5 rounded-full bg-violet-100 text-violet-600 text-[9px] font-semibold flex items-center justify-center shrink-0">
                      {(u.firstName?.[0] ?? '') + (u.lastName?.[0] ?? '')}
                    </span>
                    <span className="truncate text-slate-700">{name}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

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
      // Apply template with the user's zone name directly (no post-rename needed)
      await client.post('/zones/apply-project-template', {
        projectId,
        templateId: selected.id,
        zoneName: zoneName.trim(),
      });
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

function ZoneGroup({ zone, tasks, members, projectId, onUpdate, onDeleteTask, onDeleteZone, thClass, handleSort, sortIcon, selectedTaskIds, onToggleTask, onToggleMany }: any) {
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
                <th className="w-10 pl-5">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer"
                    checked={tasks.length > 0 && tasks.every((t: any) => selectedTaskIds?.has(t.id))}
                    ref={(el) => {
                      if (el) {
                        const someSelected = tasks.some((t: any) => selectedTaskIds?.has(t.id));
                        const allSelected = tasks.length > 0 && tasks.every((t: any) => selectedTaskIds?.has(t.id));
                        el.indeterminate = someSelected && !allSelected;
                      }
                    }}
                    onChange={(e) => onToggleMany?.(tasks.map((t: any) => t.id), e.target.checked)}
                  />
                </th>
                <th className={cn(thClass, 'w-20')} onClick={() => handleSort('code')}>Code{sortIcon('code')}</th>
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
                const statusMap: Record<string, { dot: string; text: string }> = { not_started: { dot: 'bg-slate-400', text: 'text-slate-500' }, in_progress: { dot: 'bg-blue-500', text: 'text-blue-600' }, in_review: { dot: 'bg-violet-500', text: 'text-violet-600' }, completed: { dot: 'bg-emerald-500', text: 'text-emerald-600' }, on_hold: { dot: 'bg-amber-500', text: 'text-amber-600' }, cancelled: { dot: 'bg-red-500', text: 'text-red-600' } };
                const st = statusMap[task.status] || statusMap.not_started;
                const isSelected = selectedTaskIds?.has(task.id) ?? false;
                return (
                  <tr key={task.id} className={cn('border-b border-slate-50 last:border-0 hover:bg-slate-50 group', isSelected && 'bg-blue-50/40')}>
                    <td className="pl-5">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer"
                        checked={isSelected}
                        onChange={() => onToggleTask?.(task.id)}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs font-medium text-slate-500">{task.code}</td>
                    <td className="px-3 py-2 font-medium text-slate-900">{task.name}</td>
                    <td className="px-3 py-2 text-[12px] text-slate-500">{task.zone?.name || '-'}</td>
                    <td className="px-3 py-2">{task.serviceType ? <span className="rounded-[5px] px-1.5 py-0.5 text-[11px] font-bold" style={{ backgroundColor: `${task.serviceType.color || '#3B82F6'}15`, color: task.serviceType.color || '#3B82F6' }}>{task.serviceType.name}</span> : <span className="text-slate-300">-</span>}</td>
                    <td className="px-3 py-2 text-[12px] text-slate-500">{task.phase?.name || '-'}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs font-medium text-slate-700">{task.budgetHours ? Number(task.budgetHours) : '-'}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{task.loggedMinutes > 0 ? <span className={cn('font-medium', task.budgetHours && (task.loggedMinutes / 60) > Number(task.budgetHours) ? 'text-red-600' : 'text-blue-600')}>{Math.round(task.loggedMinutes / 60 * 10) / 10}h</span> : <span className="text-slate-300">-</span>}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs font-semibold text-slate-700">{task.budgetAmount ? `₪${Number(task.budgetAmount).toLocaleString()}` : '-'}</td>
                    <td className="px-3 py-2">
                      <AssigneePicker task={task} members={members} projectId={projectId} onUpdate={onUpdate} />
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
                <tr><td colSpan={11} className="px-5 py-6 text-center text-[13px] text-slate-400">No tasks. Click "Add Task" to create one.</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}


// ─── Hierarchical Zone Group — flat tree style with colored borders ──────────

function HierarchicalZoneGroup({ zone, allTasks, members, projectId, onUpdate, onDeleteTask, onDeleteZone, onDuplicateZone, thClass, handleSort, sortIcon, depth, selectedTaskIds, onToggleTask, onToggleMany }: any) {
  const [collapsed, setCollapsed] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [showAddZone, setShowAddZone] = useState(false);
  const [newTask, setNewTask] = useState({ code: '', name: '', budgetHours: '', budgetAmount: '' });
  const [newZone, setNewZone] = useState({ name: '', zoneType: 'zone' });
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [duplicateName, setDuplicateName] = useState('');
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [saveToCatalog, setSaveToCatalog] = useState(true);
  const queryClient = useQueryClient();

  const createTask = useMutation({
    mutationFn: (data: any) => tasksApi.create(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['planning', projectId] }); setShowAddTask(false); setNewTask({ code: '', name: '', budgetHours: '', budgetAmount: '' }); notify.success('Task created', { code: 'TASK-CREATE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to create task'),
  });

  const createZoneMutation = useMutation({
    mutationFn: (data: any) => zonesApi.create(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['planning', projectId] }); setShowAddZone(false); setNewZone({ name: '', zoneType: 'zone' }); notify.success('Sub-zone created', { code: 'ZONE-CREATE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to create zone'),
  });

  const ZONE_TYPES = ['site', 'building', 'level', 'zone', 'area', 'section', 'wing', 'floor'];

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
        <input
          type="checkbox"
          className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer shrink-0"
          checked={allZoneTasks.length > 0 && allZoneTasks.every((t: any) => selectedTaskIds?.has(t.id))}
          ref={(el) => {
            if (el) {
              const someSelected = allZoneTasks.some((t: any) => selectedTaskIds?.has(t.id));
              const allSelected = allZoneTasks.length > 0 && allZoneTasks.every((t: any) => selectedTaskIds?.has(t.id));
              el.indeterminate = someSelected && !allSelected;
            }
          }}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onToggleMany?.(allZoneTasks.map((t: any) => t.id), e.target.checked)}
          title={`Select all ${allZoneTasks.length} tasks in this zone`}
        />
        <span className={cn('rounded-[5px] px-2 py-0.5 text-[11px] font-bold tracking-wide shrink-0', zc.bg, zc.text)}>{zone.zoneType}</span>
        <span className={cn('font-semibold', depth === 0 ? 'text-[15px] text-slate-900' : 'text-[13px] text-slate-800')}>{zone.name}</span>
        {hasChildren && <span className="text-[11px] text-slate-400">({zone.children.length} sub-zones)</span>}
        <span className="ml-auto text-[11px] font-medium text-slate-400 shrink-0">{allZoneTasks.length} tasks · {totalHours}h · ₪{totalAmount.toLocaleString()}</span>

        <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <div className="relative">
            <button onClick={() => setShowAddMenu(!showAddMenu)} className="bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-semibold px-2.5 py-1 rounded-md flex items-center gap-1">
              <Plus className="w-3 h-3" /> Add
            </button>
            {showAddMenu && (
              <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.12)] border border-black/5 bg-white p-1.5">
                <div className="px-2 py-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Tasks</div>
                <button onClick={() => { setShowAddTask(true); setShowAddMenu(false); setCollapsed(false); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-slate-700 hover:bg-slate-50">Create New Task</button>
                <button onClick={() => { setShowAddMenu(false); setCollapsed(false); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-slate-700 hover:bg-slate-50">Task from Catalog</button>
                <div className="my-1 border-t border-slate-100" />
                <div className="px-2 py-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Zones</div>
                <button onClick={() => { setShowAddZone(true); setShowAddMenu(false); setCollapsed(false); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-slate-700 hover:bg-slate-50">Add Sub-Zone</button>
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

          {showAddZone && (
            <div style={{ marginLeft: 28 }} className="flex items-center gap-2 py-2 px-4 border-b border-slate-50 bg-amber-50/30">
              <input value={newZone.name} onChange={(e) => setNewZone(f => ({ ...f, name: e.target.value }))} placeholder="Zone name *" autoFocus
                className="flex-1 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
              <select value={newZone.zoneType} onChange={(e) => setNewZone(f => ({ ...f, zoneType: e.target.value }))}
                className="w-28 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none">
                {ZONE_TYPES.map(zt => <option key={zt} value={zt}>{zt.charAt(0).toUpperCase() + zt.slice(1)}</option>)}
              </select>
              <button onClick={() => {
                if (!newZone.name.trim()) { notify.warning('Zone name is required'); return; }
                createZoneMutation.mutate({ projectId, parentId: zone.id, name: newZone.name.trim(), zoneType: newZone.zoneType });
              }} disabled={createZoneMutation.isPending} className="bg-amber-600 text-white text-[11px] font-semibold px-3 py-1.5 rounded-md disabled:opacity-50">
                {createZoneMutation.isPending ? 'Creating...' : 'Add Zone'}
              </button>
              <button onClick={() => setShowAddZone(false)} className="text-[11px] text-slate-400 px-1">✕</button>
            </div>
          )}

          {/* Task column header row */}
          {directTasks.length > 0 && (
            <div style={{ marginLeft: 28 }} className="flex items-center gap-3 py-1.5 px-4 bg-slate-50/70 border-b border-slate-100 text-[10px] uppercase font-semibold text-slate-400 tracking-wider">
              <span className="w-4 shrink-0" />
              <span className="w-20 shrink-0">Code</span>
              <span className="flex-1">Task Name</span>
              <span className="w-24 shrink-0">Service</span>
              <span className="w-20 shrink-0">Phase</span>
              <span className="w-12 text-right shrink-0">Budget</span>
              <span className="w-12 text-right shrink-0">Logged</span>
              <span className="w-16 text-right shrink-0">Amount</span>
              <span className="w-24 shrink-0">Assignees</span>
              <span className="w-24 shrink-0">Status</span>
              <span className="w-5 shrink-0" />
            </div>
          )}
          {directTasks.map((task: any, idx: number) => {
            const statusMap: Record<string, { bg: string; text: string; label: string }> = {
              not_started: { bg: 'bg-slate-100', text: 'text-slate-600', label: 'Not Started' },
              in_progress: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'In Progress' },
              in_review: { bg: 'bg-violet-100', text: 'text-violet-700', label: 'In Review' },
              completed: { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Completed' },
              on_hold: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'On Hold' },
              cancelled: { bg: 'bg-red-100', text: 'text-red-700', label: 'Cancelled' },
            };
            const st = statusMap[task.status] || statusMap.not_started;
            const isSelected = selectedTaskIds?.has(task.id) ?? false;
            return (
              <div key={task.id} style={{ marginLeft: 28 }} className={cn(
                'flex items-center gap-3 py-2 px-4 border-b border-slate-50 hover:bg-slate-50/60 group text-[13px] transition-colors',
                isSelected && 'bg-blue-50/50',
                idx % 2 === 1 && !isSelected && 'bg-slate-50/30',
              )}>
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer shrink-0"
                  checked={isSelected}
                  onChange={() => onToggleTask?.(task.id)}
                />
                <span className="font-mono text-[11px] font-medium text-slate-500 w-20 shrink-0 truncate">{task.code || '-'}</span>
                <span className="font-medium text-slate-900 flex-1 min-w-0 truncate">{task.name}</span>
                <span className="w-24 shrink-0">{task.serviceType ? <span className="rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold inline-block truncate max-w-full" style={{ backgroundColor: `${task.serviceType.color || '#3B82F6'}15`, color: task.serviceType.color || '#3B82F6' }}>{task.serviceType.name}</span> : <span className="text-slate-300">-</span>}</span>
                <span className="w-20 shrink-0 text-[11px] text-slate-500 truncate">{task.phase?.name || '-'}</span>
                <span className="font-mono text-[11px] text-slate-600 w-12 text-right shrink-0">{task.budgetHours ? `${Number(task.budgetHours)}h` : '-'}</span>
                <span className="font-mono text-[11px] w-12 text-right shrink-0">{task.loggedMinutes > 0 ? <span className={cn('font-medium', task.budgetHours && (task.loggedMinutes / 60) > Number(task.budgetHours) ? 'text-red-600' : 'text-blue-600')}>{Math.round(task.loggedMinutes / 60 * 10) / 10}h</span> : <span className="text-slate-300">-</span>}</span>
                <span className="font-mono text-[11px] font-semibold text-slate-700 w-16 text-right shrink-0">{task.budgetAmount ? `₪${Number(task.budgetAmount).toLocaleString()}` : '-'}</span>
                <span className="w-24 shrink-0 flex items-center">
                  <AssigneePicker task={task} members={members} projectId={projectId} onUpdate={onUpdate} />
                </span>
                <span className="w-24 shrink-0">
                  <span className={cn('inline-block rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold', st.bg, st.text)}>{st.label}</span>
                </span>
                <button onClick={() => onDeleteTask(task.id)} className="w-5 h-5 rounded hover:bg-red-50 flex items-center justify-center text-slate-300 hover:text-red-500 shrink-0"><Trash2 className="w-3 h-3" /></button>
              </div>
            );
          })}

          {hasChildren && zone.children.map((child: any) => (
            <HierarchicalZoneGroup key={child.id} zone={child} allTasks={allTasks} members={members} projectId={projectId}
              onUpdate={onUpdate} onDeleteTask={onDeleteTask} onDeleteZone={onDeleteZone} onDuplicateZone={onDuplicateZone}
              thClass={thClass} handleSort={handleSort} sortIcon={sortIcon} depth={depth + 1}
              selectedTaskIds={selectedTaskIds} onToggleTask={onToggleTask} onToggleMany={onToggleMany} />
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
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<number>>(new Set());

  const toggleTask = (taskId: number) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      next.has(taskId) ? next.delete(taskId) : next.add(taskId);
      return next;
    });
  };
  const toggleManyTasks = (taskIds: number[], selectAll: boolean) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (selectAll) taskIds.forEach((id) => next.add(id));
      else taskIds.forEach((id) => next.delete(id));
      return next;
    });
  };
  const clearSelection = () => setSelectedTaskIds(new Set());

  const { data: planningData, isLoading } = useQuery({
    queryKey: ['planning', projectId],
    queryFn: () => planningApi.getData(projectId),
    enabled: !!projectId,
  });

  // Fetch service templates to map service name → phase (for phase display/grouping)
  const { data: serviceTemplatesRaw = [] } = useQuery({
    queryKey: ['templates', 'task_list'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=task_list').then((r) => r.data.data ?? r.data),
  });
  const servicePhaseMap = useMemo(() => {
    const map = new Map<string, { id: number; name: string; code?: string | null }>();
    const list = Array.isArray(serviceTemplatesRaw) ? serviceTemplatesRaw : [];
    for (const t of list) {
      if (t?.phase) map.set(t.name, { id: t.phase.id, name: t.phase.name, code: t.phase.code });
    }
    return map;
  }, [serviceTemplatesRaw]);

  const pd = (planningData as any)?.data ?? planningData;
  const zones = pd?.zones ?? [];
  const rawTasks = pd?.tasks ?? [];

  // Enrich each task with phase from its service template (if no direct phase)
  const tasks = useMemo(() => {
    return (rawTasks as any[]).map((t) => {
      if (t.phase) return t;
      const svcMatch = t.description?.match(/^\[SERVICE:(.+)\]$/);
      if (svcMatch) {
        const svcName = svcMatch[1];
        const phase = servicePhaseMap.get(svcName);
        if (phase) return { ...t, phase, phaseId: phase.id };
      }
      return t;
    });
  }, [rawTasks, servicePhaseMap]);
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
            {sorted.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const visibleIds = sorted.map((t: any) => t.id);
                  const allSelected = visibleIds.every((id: number) => selectedTaskIds.has(id));
                  toggleManyTasks(visibleIds, !allSelected);
                }}
                className="text-[12px] font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1"
              >
                {sorted.every((t: any) => selectedTaskIds.has(t.id)) ? 'Deselect all' : `Select all (${sorted.length})`}
              </button>
            )}
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
                thClass={thClass} handleSort={handleSort} sortIcon={sortIcon} depth={0}
                selectedTaskIds={selectedTaskIds} onToggleTask={toggleTask} onToggleMany={toggleManyTasks} />
            ))
          ) : (
            groups.map((g: any) => (
              <ZoneGroup key={g.key} zone={{ id: 0, name: g.key, zoneType: groupBy }} tasks={g.tasks} members={members} projectId={projectId}
                onUpdate={invalidate} onDeleteTask={(id: number) => { if (confirm('Delete this task?')) deleteTask.mutate(id); }}
                onDeleteZone={() => {}} thClass={thClass} handleSort={handleSort} sortIcon={sortIcon}
                selectedTaskIds={selectedTaskIds} onToggleTask={toggleTask} onToggleMany={toggleManyTasks} />
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

      {/* Floating bulk action bar (only visible when tasks are selected) */}
      <BulkActionBar
        selectedCount={selectedTaskIds.size}
        selectedTaskIds={selectedTaskIds}
        members={members}
        projectId={projectId}
        onClear={clearSelection}
      />
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
