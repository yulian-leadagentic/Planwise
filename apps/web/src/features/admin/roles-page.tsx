import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, ChevronDown, ChevronRight, Plus, Trash2, Pencil, Users, UserMinus } from 'lucide-react';
import { useState, useMemo } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { UserAvatar } from '@/components/shared/user-avatar';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';

const inputClass = 'w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none';

export function RolesPage() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'roles'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/admin/roles').then((r) => r.data.data),
  });

  const createRole = useMutation({
    mutationFn: () => client.post('/admin/roles', { name: newName.trim(), description: newDesc.trim() || undefined }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
      notify.success('Role created', { code: 'ROLE-CREATE-200' });
      setShowCreate(false);
      setNewName('');
      setNewDesc('');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create role'),
  });

  const deleteRole = useMutation({
    mutationFn: (id: number) => client.delete(`/admin/roles/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
      notify.success('Role deleted', { code: 'ROLE-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete role'),
  });

  const roles = data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Roles & Permissions"
        description="Manage user roles and module access"
        actions={
          <button onClick={() => setShowCreate(true)} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Create Role
          </button>
        }
      />

      {showCreate && (
        <div className="bg-white rounded-[14px] border border-slate-200 p-5 space-y-3">
          <h3 className="text-[15px] font-bold text-slate-900">New Role</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Role Name *</label>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Coordinator" autoFocus className={inputClass} />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Description</label>
              <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Brief description" className={inputClass} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowCreate(false)} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
            <button onClick={() => createRole.mutate()} disabled={!newName.trim() || createRole.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
              {createRole.isPending ? 'Creating...' : 'Create Role'}
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <TableSkeleton rows={5} cols={4} />
      ) : roles.length === 0 ? (
        <div className="bg-white rounded-[14px] border border-slate-200 p-8 text-center">
          <Shield className="mx-auto h-12 w-12 text-slate-300" />
          <h3 className="mt-3 text-sm font-medium text-slate-700">No roles yet</h3>
          <p className="mt-1 text-sm text-slate-400">Create a role to start managing permissions.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {roles.map((role: any) => (
            <RoleCard
              key={role.id}
              role={role}
              onDelete={() => {
                if (confirm(`Delete role "${role.name}"? Users with this role will lose their permissions.`)) {
                  deleteRole.mutate(role.id);
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RoleCard({ role, onDelete }: { role: any; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [editingHeader, setEditingHeader] = useState(false);
  const [editName, setEditName] = useState(role.name);
  const [editDesc, setEditDesc] = useState(role.description ?? '');
  const queryClient = useQueryClient();
  const modules = role.roleModules ?? [];

  // Fetch all system modules (for adding new module permissions)
  const { data: allModules = [] } = useQuery({
    queryKey: ['admin', 'modules'],
    staleTime: 10 * 60 * 1000,
    enabled: expanded,
    queryFn: () => client.get('/admin/config/modules').then((r) => {
      const d = r.data?.data ?? r.data;
      // Flatten: include parent modules + children
      const result: any[] = [];
      const items = Array.isArray(d) ? d : [];
      for (const mod of items) {
        result.push(mod);
        if (mod.children) {
          for (const child of mod.children) result.push(child);
        }
      }
      return result;
    }),
  });

  // Modules that DON'T have permissions for this role yet
  const assignedModuleIds = new Set(modules.map((rm: any) => rm.moduleId));
  const unassignedModules = allModules.filter((m: any) => !assignedModuleIds.has(m.id));

  const updateRole = useMutation({
    mutationFn: (data: { name?: string; description?: string }) =>
      client.patch(`/admin/roles/${role.id}`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
      notify.success('Role updated', { code: 'ROLE-UPDATE-200' });
      setEditingHeader(false);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update role'),
  });

  const togglePermission = useMutation({
    mutationFn: ({ moduleId, canRead, canWrite, canDelete }: { moduleId: number; canRead: boolean; canWrite: boolean; canDelete: boolean }) =>
      client.post(`/admin/roles/${role.id}/modules`, { moduleId, canRead, canWrite, canDelete }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update permission'),
  });

  const removeModule = useMutation({
    mutationFn: (moduleId: number) =>
      client.delete(`/admin/roles/${role.id}/modules/${moduleId}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
      notify.success('Module permission removed', { code: 'PERM-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove permission'),
  });

  const handleToggle = (rm: any, field: 'canRead' | 'canWrite' | 'canDelete' | 'canApprove' | 'canExport') => {
    togglePermission.mutate({
      moduleId: rm.moduleId,
      canRead: field === 'canRead' ? !rm.canRead : rm.canRead,
      canWrite: field === 'canWrite' ? !rm.canWrite : rm.canWrite,
      canDelete: field === 'canDelete' ? !rm.canDelete : rm.canDelete,
      canApprove: field === 'canApprove' ? !rm.canApprove : (rm.canApprove ?? false),
      canExport: field === 'canExport' ? !rm.canExport : (rm.canExport ?? false),
    });
  };

  const handleAddModule = (moduleId: number) => {
    togglePermission.mutate({
      moduleId,
      canRead: true,
      canWrite: false,
      canDelete: false,
    });
  };

  return (
    <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-5 py-4 cursor-pointer hover:bg-slate-50/60"
        onClick={() => setExpanded(!expanded)}
      >
        <Shield className="h-5 w-5 text-blue-600 shrink-0" />
        <div className="flex-1 min-w-0">
          {editingHeader ? (
            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <input value={editName} onChange={(e) => setEditName(e.target.value)} className="px-2 py-1 rounded border border-slate-200 text-sm font-medium w-48 focus:border-blue-500 focus:outline-none" autoFocus />
              <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Description" className="px-2 py-1 rounded border border-slate-200 text-sm w-48 focus:border-blue-500 focus:outline-none" />
              <button onClick={() => updateRole.mutate({ name: editName.trim(), description: editDesc.trim() || undefined })} disabled={!editName.trim()} className="text-[11px] font-semibold text-blue-600 hover:text-blue-700 px-2">Save</button>
              <button onClick={() => setEditingHeader(false)} className="text-[11px] text-slate-400 hover:text-slate-600 px-1">Cancel</button>
            </div>
          ) : (
            <>
              <p className="text-sm font-semibold text-slate-900">{role.name}</p>
              {role.description && <p className="text-xs text-slate-500">{role.description}</p>}
            </>
          )}
        </div>
        <span className="text-xs text-slate-400 shrink-0">{modules.length} modules &middot; {role._count?.users ?? 0} users</span>
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setEditName(role.name); setEditDesc(role.description ?? ''); setEditingHeader(true); }}
            className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600" title="Edit role">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button onClick={onDelete} className="p-1.5 rounded hover:bg-red-50 text-slate-400 hover:text-red-600" title="Delete role">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        {expanded ? <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" /> : <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />}
      </div>

      {/* Permissions editor */}
      {expanded && (
        <div className="border-t border-slate-200 px-5 pb-5 pt-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-[13px] font-semibold text-slate-700">Module Permissions</h4>
            <p className="text-[11px] text-slate-400">Click checkboxes to toggle permissions</p>
          </div>

          <div className="rounded-lg border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-2 text-left font-semibold">Module</th>
                  <th className="px-4 py-2 text-center font-semibold w-16">Read</th>
                  <th className="px-4 py-2 text-center font-semibold w-16">Write</th>
                  <th className="px-4 py-2 text-center font-semibold w-16">Delete</th>
                  <th className="px-4 py-2 text-center font-semibold w-16">Approve</th>
                  <th className="px-4 py-2 text-center font-semibold w-16">Export</th>
                  <th className="px-4 py-2 text-center font-semibold w-12"></th>
                </tr>
              </thead>
              <tbody>
                {modules.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-center text-sm text-slate-400">
                      No modules assigned. Use the dropdown below to add module permissions.
                    </td>
                  </tr>
                )}
                {modules.map((rm: any) => (
                  <tr key={rm.id} className="border-t border-slate-100 hover:bg-slate-50/50">
                    <td className="px-4 py-2.5 font-medium text-slate-800">{rm.module?.name ?? `Module ${rm.moduleId}`}</td>
                    <td className="px-4 py-2.5 text-center">
                      <PermCheckbox checked={rm.canRead} onChange={() => handleToggle(rm, 'canRead')} disabled={togglePermission.isPending} />
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <PermCheckbox checked={rm.canWrite} onChange={() => handleToggle(rm, 'canWrite')} disabled={togglePermission.isPending} />
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <PermCheckbox checked={rm.canDelete} onChange={() => handleToggle(rm, 'canDelete')} disabled={togglePermission.isPending} />
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <PermCheckbox checked={rm.canApprove ?? false} onChange={() => handleToggle(rm, 'canApprove')} disabled={togglePermission.isPending} />
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <PermCheckbox checked={rm.canExport ?? false} onChange={() => handleToggle(rm, 'canExport')} disabled={togglePermission.isPending} />
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <button
                        onClick={() => removeModule.mutate(rm.moduleId)}
                        className="p-1 rounded hover:bg-red-50 text-slate-300 hover:text-red-500"
                        title="Remove module from role"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Add module dropdown */}
          {unassignedModules.length > 0 && (
            <div className="mt-3 flex items-center gap-2">
              <select
                id={`add-module-${role.id}`}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) {
                    handleAddModule(Number(e.target.value));
                    e.target.value = '';
                  }
                }}
                className="px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none flex-1 max-w-xs"
              >
                <option value="" disabled>+ Add module permission...</option>
                {unassignedModules.map((m: any) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          )}

          <RoleUsersSection roleId={role.id} roleName={role.name} />
          <StageTransitionEditor roleId={role.id} />
        </div>
      )}
    </div>
  );
}

function RoleUsersSection({ roleId, roleName }: { roleId: number; roleName: string }) {
  const queryClient = useQueryClient();

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['admin', 'roles', roleId, 'users'],
    queryFn: () => client.get(`/admin/roles/${roleId}/users`).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
  });

  const { data: allRoles = [] } = useQuery({
    queryKey: ['admin', 'roles'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/admin/roles').then((r) => r.data.data),
  });

  const [reassigningId, setReassigningId] = useState<number | null>(null);

  const reassign = useMutation({
    mutationFn: ({ userId, newRoleId }: { userId: number; newRoleId: number }) =>
      client.patch(`/users/${userId}`, { roleId: newRoleId }).then((r) => r.data),
    onMutate: ({ userId }) => setReassigningId(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
      notify.success('Role reassigned', { code: 'USER-ROLE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to reassign'),
    onSettled: () => setReassigningId(null),
  });

  return (
    <div className="mt-6 pt-5 border-t border-slate-200">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-[13px] font-semibold text-slate-700 flex items-center gap-2">
          <Users className="h-3.5 w-3.5" /> Users with the "{roleName}" role
        </h4>
        <p className="text-[11px] text-slate-400">{users.length} user{users.length !== 1 ? 's' : ''}</p>
      </div>

      {isLoading ? (
        <p className="text-[12px] text-slate-400 py-3 text-center">Loading…</p>
      ) : users.length === 0 ? (
        <p className="text-[12px] text-slate-400 py-3 text-center italic">No users have this role yet.</p>
      ) : (
        <div className="space-y-1.5">
          {users.map((u: any) => {
            const isSaving = reassigningId === u.id;
            return (
              <div key={u.id} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
                <UserAvatar firstName={u.firstName} lastName={u.lastName} avatarUrl={u.avatarUrl} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-slate-800 truncate">{u.firstName} {u.lastName}</p>
                  <p className="text-[11px] text-slate-500 truncate">{u.email}{u.position ? ` · ${u.position}` : ''}</p>
                </div>
                <select
                  aria-label={`Reassign ${u.firstName} to another role`}
                  value={roleId}
                  disabled={isSaving}
                  onChange={(e) => {
                    const newId = Number(e.target.value);
                    if (newId && newId !== roleId) {
                      if (confirm(`Move ${u.firstName} ${u.lastName} from "${roleName}" to this new role?`)) {
                        reassign.mutate({ userId: u.id, newRoleId: newId });
                      } else {
                        e.target.value = String(roleId);
                      }
                    }
                  }}
                  className={cn(
                    'rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] focus:border-blue-400 focus:outline-none',
                    isSaving && 'opacity-50 cursor-wait',
                  )}
                >
                  {(allRoles as any[]).map((r: any) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const ALL_STATUSES = ['not_started', 'in_progress', 'in_review', 'completed', 'on_hold', 'cancelled'];
const STATUS_NAMES: Record<string, string> = {
  not_started: 'To Do', in_progress: 'In Progress', in_review: 'In Review',
  completed: 'Done', on_hold: 'On Hold', cancelled: 'Cancelled',
};

function StageTransitionEditor({ roleId }: { roleId: number }) {
  const queryClient = useQueryClient();

  const { data: matrix = {}, isLoading } = useQuery({
    queryKey: ['admin', 'roles', roleId, 'stage-transitions'],
    queryFn: () => client.get(`/admin/roles/${roleId}/stage-transitions`).then((r) => r.data?.data ?? r.data),
  });

  const isUnrestricted = Object.keys(matrix).length === 0;

  const isAllowed = (from: string, to: string): boolean => {
    if (isUnrestricted) return true;
    return (matrix[from] ?? []).includes(to);
  };

  const saveMutation = useMutation({
    mutationFn: (transitions: { from: string; to: string }[]) =>
      client.post(`/admin/roles/${roleId}/stage-transitions`, { transitions }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles', roleId, 'stage-transitions'] });
      notify.success('Stage transitions updated', { code: 'STAGE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update'),
  });

  const toggleTransition = (from: string, to: string) => {
    // Build full list from current matrix
    const transitions: { from: string; to: string }[] = [];
    if (isUnrestricted) {
      // First click = start configuring: allow ALL except the one clicked
      for (const f of ALL_STATUSES) {
        for (const t of ALL_STATUSES) {
          if (f === t) continue;
          if (f === from && t === to) continue;
          transitions.push({ from: f, to: t });
        }
      }
    } else {
      // Copy existing, toggle the clicked one
      for (const f of ALL_STATUSES) {
        for (const t of ALL_STATUSES) {
          if (f === t) continue;
          const currently = (matrix[f] ?? []).includes(t);
          const toggled = f === from && t === to ? !currently : currently;
          if (toggled) transitions.push({ from: f, to: t });
        }
      }
    }
    saveMutation.mutate(transitions);
  };

  const resetToUnrestricted = () => {
    saveMutation.mutate([]);
  };

  if (isLoading) return <p className="text-[12px] text-slate-400 py-3 text-center">Loading…</p>;

  return (
    <div className="mt-6 pt-5 border-t border-slate-200">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-[13px] font-semibold text-slate-700">
          Kanban Stage Transitions
        </h4>
        {!isUnrestricted && (
          <button onClick={resetToUnrestricted} disabled={saveMutation.isPending}
            className="text-[11px] text-blue-600 hover:text-blue-700 font-semibold">
            Reset (allow all)
          </button>
        )}
      </div>
      {isUnrestricted && (
        <p className="text-[11px] text-slate-500 mb-2">
          No restrictions — this role can perform all transitions. Click any cell to start configuring.
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-slate-50">
              <th className="px-2 py-1.5 text-left font-semibold text-slate-500">From ↓ / To →</th>
              {ALL_STATUSES.map((s) => (
                <th key={s} className="px-2 py-1.5 text-center font-semibold text-slate-500">{STATUS_NAMES[s]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ALL_STATUSES.map((from) => (
              <tr key={from} className="border-t border-slate-100">
                <td className="px-2 py-1.5 font-medium text-slate-700">{STATUS_NAMES[from]}</td>
                {ALL_STATUSES.map((to) => {
                  if (from === to) return <td key={to} className="bg-slate-100" />;
                  const allowed = isAllowed(from, to);
                  return (
                    <td key={to} className="px-2 py-1 text-center">
                      <PermCheckbox
                        checked={allowed}
                        onChange={() => toggleTransition(from, to)}
                        disabled={saveMutation.isPending}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PermCheckbox({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      className={cn(
        'w-7 h-7 rounded-md border-2 flex items-center justify-center transition-all duration-100 mx-auto',
        checked
          ? 'border-green-500 bg-green-50 text-green-600 hover:bg-green-100'
          : 'border-slate-200 bg-white text-transparent hover:border-slate-400 hover:bg-slate-50',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      {checked && (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
          <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
        </svg>
      )}
    </button>
  );
}
