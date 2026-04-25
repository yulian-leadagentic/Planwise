import { useAuthStore } from '@/stores/auth.store';

type PermAction = 'read' | 'write' | 'delete' | 'approve' | 'export';

export function usePermissions() {
  const user = useAuthStore((s) => s.user) as any;
  const roleModules: any[] = user?.roleModules ?? user?.role?.roleModules ?? [];

  const findEntry = (key: string) => {
    const lc = key.toLowerCase();
    return roleModules.find((m: any) => {
      const route = m.module?.route || '';
      const name = m.module?.name?.toLowerCase() || '';
      return route === key || route === `/${key}` || name === lc;
    });
  };

  const can = (module: string, action: PermAction): boolean => {
    if (!roleModules.length) return true;

    // Most-specific match first; for nested routes like "/admin/roles" try the
    // exact entry, then walk up to parent ("/admin") so a role with parent
    // permission still satisfies child checks unless explicitly denied.
    const candidates = expand(module);

    for (const candidate of candidates) {
      const rm = findEntry(candidate);
      if (rm) {
        switch (action) {
          case 'read': return !!rm.canRead;
          case 'write': return !!rm.canWrite;
          case 'delete': return !!rm.canDelete;
          case 'approve': return !!rm.canApprove;
          case 'export': return !!rm.canExport;
          default: return false;
        }
      }
    }
    return false;
  };

  const isAdmin = user?.role?.name === 'Admin' || user?.roleName === 'Admin';

  return { can, isAdmin, user };
}

function expand(module: string): string[] {
  const candidates = [module];
  const path = module.startsWith('/') ? module : `/${module}`;
  const parts = path.split('/').filter(Boolean);
  for (let i = parts.length - 1; i > 0; i--) {
    candidates.push(parts.slice(0, i).join('/'));
  }
  return candidates;
}
