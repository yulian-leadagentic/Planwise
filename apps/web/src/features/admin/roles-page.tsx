import { useQuery } from '@tanstack/react-query';
import { Shield, ChevronDown, ChevronRight, Check, X } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { LoadingSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { cn } from '@/lib/utils';

export function RolesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: () => client.get('/admin/roles').then((r) => r.data.data),
  });

  const roles = data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Roles & Permissions" description="Manage user roles and module access" />

      {isLoading ? (
        <LoadingSkeleton lines={5} />
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
