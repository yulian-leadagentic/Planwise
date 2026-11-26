import { useAuthStore } from '@/stores/auth.store';

export type PermAction = 'read' | 'write' | 'delete' | 'approve' | 'export';

export function usePermissions() {
  const user = useAuthStore((s) => s.user) as any;
  // §14 RBAC multi-role (2026-10-18) — `/auth/me` already returns the
  // OR-union across every granted role as `roleModules` (merged by
  // `attachMergedPermissions` in jwt.strategy.ts); legacy fallbacks
  // kept for cached-user compatibility during the deploy handover
  // window.
  const roleModules: any[] = user?.roleModules ?? user?.role?.roleModules ?? [];

  const can = (module: string, action: PermAction): boolean => canWith(roleModules, module, action);

  // §14 — Admin check:
  //   1. Prefer the server-computed flag (`user.isAdmin`), which is
  //      the OR union across granted roles.
  //   2. Fallback: any of the `roles` chip list is named Admin.
  //   3. Fallback (pre-handover window): legacy role.name.
  // The order is `isAdmin` → `roles` → legacy so the moment the server
  // sends the new shape the client stops honouring the stale
  // single-role chip.
  //
  // Permissions round 1 (2026-11-20) — when the server sent the flag
  // (always, from /auth/me), it is the ONLY answer: the server no longer
  // treats `roleId === 1` as admin, so the UI must not either (otherwise
  // it would offer Admin-only controls the API then rejects).
  const rolesList: Array<{ id: number; name: string }> = Array.isArray(user?.roles) ? user.roles : [];
  const roleName = String(user?.role?.name ?? user?.roleName ?? '').toLowerCase();
  const isAdmin =
    typeof user?.isAdmin === 'boolean'
      ? user.isAdmin
      : rolesList.some((r) => String(r.name).toLowerCase() === 'admin') ||
        roleName === 'admin' ||
        roleName === 'administrator';

  return { can, isAdmin, user };
}

/**
 * The `can` rule on a plain role-module list, so specs can exercise the
 * exact lookup the hook uses (BM2-28 permission-consistency specs).
 */
export function canWith(roleModules: any[], module: string, action: PermAction): boolean {
  // Empty list (stale cache / partial login) = fail OPEN for ordinary
  // modules (the API still decides), but fail CLOSED for finance
  // (permissions round 2, B-20): no money surface is ever shown
  // without an explicit finance grant.
  if (!roleModules.length) return !isFinanceModule(module);

  const findEntry = (key: string) => {
    const lc = key.toLowerCase();
    return roleModules.find((m: any) => {
      const route = m.module?.route || '';
      const name = m.module?.name?.toLowerCase() || '';
      return route === key || route === `/${key}` || name === lc;
    });
  };

  // Most-specific match first; for nested routes like "/admin/roles" try the
  // exact entry, then walk up to parent ("/admin") so a role with parent
  // permission still satisfies child checks unless explicitly denied.
  for (const candidate of expand(module)) {
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
}

function isFinanceModule(module: string): boolean {
  const key = module.replace(/^\//, '').toLowerCase();
  return key === 'finance' || key.startsWith('finance/');
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
