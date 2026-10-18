import { useAuthStore } from '@/stores/auth.store';

type PermAction = 'read' | 'write' | 'delete' | 'approve' | 'export';

export function usePermissions() {
  const user = useAuthStore((s) => s.user) as any;
  // §14 RBAC multi-role (2026-10-18) — `/auth/me` already returns the
  // OR-union across every granted role as `roleModules` (merged by
  // `attachMergedPermissions` in jwt.strategy.ts); legacy fallbacks
  // kept for cached-user compatibility during the deploy handover
  // window.
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

  // §14 — Admin check:
  //   1. Prefer the server-computed flag (`user.isAdmin`), which is
  //      the OR union across granted roles.
  //   2. Fallback: any of the `roles` chip list is named Admin.
  //   3. Fallback (pre-handover window): legacy role.name / role.id.
  // The order is `isAdmin` → `roles` → legacy so the moment the server
  // sends the new shape the client stops honouring the stale
  // single-role chip.
  const rolesList: Array<{ id: number; name: string }> = Array.isArray(user?.roles) ? user.roles : [];
  const roleName = String(user?.role?.name ?? user?.roleName ?? '').toLowerCase();
  const isAdmin =
    user?.isAdmin === true ||
    rolesList.some((r) => String(r.name).toLowerCase() === 'admin') ||
    user?.roleId === 1 ||
    user?.role?.id === 1 ||
    roleName === 'admin' ||
    roleName === 'administrator';

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
