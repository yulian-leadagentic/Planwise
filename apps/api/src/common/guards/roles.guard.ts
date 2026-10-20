import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, OWN_DATA_KEY, RequiredPermission } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<RequiredPermission[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const isOwnData = this.reflector.getAllAndOverride<boolean>(OWN_DATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    if (!user || !user.roleModules) {
      if (isOwnData) return true;
      throw new ForbiddenException('Insufficient permissions');
    }

    // Admin role short-circuit — admins bypass the standard permission
    // checks so they can never lock themselves out of a sub-module by
    // adding a restrictive explicit entry alongside the parent grant.
    //
    // Exception: modules in NO_ADMIN_BYPASS are intentionally NOT
    // bypassed — even admins must hold the explicit grant. Used today
    // for:
    //   • 'finance'           — restrict cost/budget visibility
    //   • 'data-import/*'     — bulk imports can corrupt thousands of
    //                           rows; permission must be deliberately
    //                           granted, not inherited from Admin
    //   • 'hr'                — HR Phase A (2026-10-15). Employee
    //                           personal/medical data lives behind the
    //                           HR module; even system admins must hold
    //                           the explicit HR grant to see it. The
    //                           seed grants HR Manager/HR Clerk by name.
    // Admins can deny themselves access just by unchecking the row in
    // /admin/roles.
    const NO_ADMIN_BYPASS = new Set([
      'finance',
      'hr',
      'data-import',
      'data-import/users',
      'data-import/partners',
      'data-import/contacts',
    ]);
    const allBypassable = requiredPermissions.every((p) => !NO_ADMIN_BYPASS.has(p.module));
    // §14 RBAC multi-role (2026-10-18) — `isAdminUser` reads
    // `user.isAdmin` (set in jwt.strategy.ts' attachMergedPermissions);
    // falls back to the legacy name check when upstream hasn't
    // populated it, so a request minted from an older code path still
    // works during the deploy handover window.
    if (allBypassable && isAdminUser(user)) {
      return true;
    }

    const findEntry = (key: string) => {
      const lc = key.toLowerCase();
      return user.roleModules.find((rm: any) => {
        const route = rm.module?.route || '';
        const name = rm.module?.name?.toLowerCase() || '';
        return route === key || route === `/${key}` || name === lc;
      });
    };

    const hasPermission = requiredPermissions.every((required) => {
      // Most-specific match first; fall back to parent path so a role with
      // permission on /admin still satisfies /admin/roles unless an explicit
      // /admin/roles entry exists and denies it.
      for (const candidate of expandModule(required.module)) {
        const userModule = findEntry(candidate);
        if (!userModule) continue;
        switch (required.action) {
          case 'read': return userModule.canRead;
          case 'write': return userModule.canWrite;
          case 'delete': return userModule.canDelete;
          case 'approve': return userModule.canApprove;
          case 'export': return userModule.canExport;
          default: return false;
        }
      }
      return false;
    });

    if (!hasPermission) {
      if (isOwnData) return true;
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}

/**
 * Expand a module path into [most-specific, …, parent] candidates for
 * permission lookup. Used by the guard above AND, since Phase 1 RBAC
 * Hardening (2026-10-20 WORKORDER — B3), by the data-import
 * controllers' assertCanImport so a grant on the parent `data-import`
 * route satisfies the child `data-import/<target>` the same way the
 * guard does. Any controller that gates a nested path manually MUST
 * use this helper instead of exact-match route comparisons so the
 * matrix stays consistent.
 */
export function expandModule(module: string): string[] {
  const candidates = [module];
  const path = module.startsWith('/') ? module : `/${module}`;
  const parts = path.split('/').filter(Boolean);
  for (let i = parts.length - 1; i > 0; i--) {
    candidates.push(parts.slice(0, i).join('/'));
  }
  return candidates;
}

/**
 * Does the user's merged roleModules grant `action` on `module`, with
 * the same parent-fallback semantics as the main guard? True iff some
 * row for the module (or any parent path) has the action flag set.
 *
 * Carved out of `canActivate` so controllers that gate dynamic paths
 * (today: the data-import importers' assertCanImport) can share the
 * exact same lookup. Keeps the matrix UI, the guard, and the
 * controllers from drifting apart.
 */
export function userHasModulePermission(
  user: any,
  module: string,
  action: 'read' | 'write' | 'delete' | 'approve' | 'export',
): boolean {
  const roleModules: any[] = user?.roleModules ?? [];
  if (roleModules.length === 0) return false;
  const findEntry = (key: string) => {
    const lc = key.toLowerCase();
    return roleModules.find((rm: any) => {
      const route = rm.module?.route || '';
      const name = rm.module?.name?.toLowerCase() || '';
      return route === key || route === `/${key}` || name === lc;
    });
  };
  for (const candidate of expandModule(module)) {
    const rm = findEntry(candidate);
    if (!rm) continue;
    switch (action) {
      case 'read':    return !!rm.canRead;
      case 'write':   return !!rm.canWrite;
      case 'delete':  return !!rm.canDelete;
      case 'approve': return !!rm.canApprove;
      case 'export':  return !!rm.canExport;
      default:        return false;
    }
  }
  return false;
}

/**
 * §14 RBAC multi-role (2026-10-18) — single source of truth for the
 * "is this request's user an Admin?" check. Prefers the precomputed
 * `user.isAdmin` set by `jwt.strategy.ts` (OR-union across granted
 * roles; falls back to legacy `user.role.name` when `user_roles` is
 * empty). Still accepts the legacy shape so a caller that forgot to
 * run the merge (test fixtures, older code paths) keeps working.
 *
 * Exported so controllers that need an admin bypass (currently
 * `templates.controller` + `data-import.controller`) can use the same
 * rule the guard uses, instead of re-implementing `role?.name ===
 * 'Admin'` with the user_roles short-circuit missing.
 */
export function isAdminUser(user: any): boolean {
  if (user?.isAdmin === true) return true;
  if (user?.isAdmin === false) return false;
  // Legacy fallback — a request that never flowed through
  // attachMergedPermissions still gets the pre-§14 behavior.
  return user?.role?.name === 'Admin' || user?.roleName === 'Admin';
}
