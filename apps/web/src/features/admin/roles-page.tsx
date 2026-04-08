import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, ChevronDown, ChevronRight, Check, X, Plus } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';

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
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Coordinator" autoFocus
                className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Description</label>
              <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Brief description"
                className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
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
      ) : (
        <div className="space-y-3">
          {roles.map((role: any) => (
            <RoleCard key={role.id} role={role} />
          ))}
        </div>
      )}
    </div>
  );
}

function RoleCard({ role }: { role: any }) {
  const [expanded, setExpanded] = useState(false);
  const modules = role.roleModules ?? [];

  return (
    <div className="rounded-lg border border-border bg-background">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/50"
      >
        <Shield className="h-5 w-5 text-brand-600" />
        <div className="flex-1">
          <p className="font-medium">{role.name}</p>
          {role.description && (
            <p className="text-sm text-muted-foreground">{role.description}</p>
          )}
        </div>
        <span className="text-xs text-muted-foreground">{modules.length} modules</span>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {expanded && modules.length > 0 && (
        <div className="border-t border-border px-4 pb-4 pt-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="pb-2 font-medium">Module</th>
                <th className="pb-2 text-center font-medium">Read</th>
                <th className="pb-2 text-center font-medium">Write</th>
                <th className="pb-2 text-center font-medium">Delete</th>
              </tr>
            </thead>
            <tbody>
              {modules.map((rm: any) => (
                <tr key={rm.id} className="border-t border-border">
                  <td className="py-2">{rm.module?.name ?? `Module ${rm.moduleId}`}</td>
                  <td className="py-2 text-center">
                    <PermIcon value={rm.canRead} />
                  </td>
                  <td className="py-2 text-center">
                    <PermIcon value={rm.canWrite} />
                  </td>
                  <td className="py-2 text-center">
                    <PermIcon value={rm.canDelete} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PermIcon({ value }: { value: boolean }) {
  return value ? (
    <Check className="mx-auto h-4 w-4 text-green-600" />
  ) : (
    <X className="mx-auto h-4 w-4 text-gray-300" />
  );
}
