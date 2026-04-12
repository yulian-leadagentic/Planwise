import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, ChevronDown, ChevronRight, Plus, Trash2, Pencil } from 'lucide-react';
import { useState, useMemo } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
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

  const handleToggle = (rm: any, field: 'canRead' | 'canWrite' | 'canDelete') => {
    togglePermission.mutate({
      moduleId: rm.moduleId,
      canRead: field === 'canRead' ? !rm.canRead : rm.canRead,
      canWrite: field === 'canWrite' ? !rm.canWrite : rm.canWrite,
      canDelete: field === 'canDelete' ? !rm.canDelete : rm.canDelete,
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
                  <th className="px-4 py-2 text-center font-semibold w-20">Read</th>
                  <th className="px-4 py-2 text-center font-semibold w-20">Write</th>
                  <th className="px-4 py-2 text-center font-semibold w-20">Delete</th>
                  <th className="px-4 py-2 text-center font-semibold w-16"></th>
                </tr>
              </thead>
              <tbody>
                {modules.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-sm text-slate-400">
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
        </div>
      )}
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
