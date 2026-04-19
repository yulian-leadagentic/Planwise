import { useAuthStore } from '@/stores/auth.store';

type PermAction = 'read' | 'write' | 'delete' | 'approve' | 'export';

export function usePermissions() {
  const user = useAuthStore((s) => s.user) as any;
  const roleModules: any[] = user?.roleModules ?? user?.role?.roleModules ?? [];

  const can = (module: string, action: PermAction): boolean => {
    if (!roleModules.length) return true;

    const rm = roleModules.find((m: any) => {
      const route = m.module?.route || '';
      const name = m.module?.name?.toLowerCase() || '';
      return route === module || route === `/${module}` || name === module;
    });

    if (!rm) return false;

    switch (action) {
      case 'read': return !!rm.canRead;
      case 'write': return !!rm.canWrite;
      case 'delete': return !!rm.canDelete;
      case 'approve': return !!rm.canApprove;
      case 'export': return !!rm.canExport;
      default: return false;
    }
  };

  const isAdmin = user?.role?.name === 'Admin' || user?.roleName === 'Admin';

  return { can, isAdmin, user };
}
