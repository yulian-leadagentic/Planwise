/**
 * Who may add / edit / remove people, and which user fields are
 * protected (permissions round 1, 2026-11-20).
 *
 * Owner decisions:
 *   • only Admin and HR may add and remove employees;
 *   • password and access role (`roleId`, or anything else that changes
 *     roles) — Admin only;
 *   • email and active state — Admin or HR;
 *   • home org unit (`orgUnitId`, which widens project access) — Admin,
 *     HR or `org:write` (same bar as `PATCH /users/:id/org-unit`);
 *   • nobody changes their own role / active state / org unit unless
 *     Admin, and nobody deletes themselves.
 *
 * Permissions round 2 (2026-11-20) — money on a person:
 *   • `salaryHourly` (pay rate) and `seniorityLevelId` (the labor
 *     category = cost tier the cost engine prices hours at) change only
 *     with `finance:write` — on create (any non-empty value) and on
 *     update (a value different from the stored one; sending the stored
 *     value back passes). Same bar as the seniority-history routes.
 *
 * "Admin" is `isAdminUser` (the RolesGuard's multi-role definition).
 * "HR" is `hr:write` through `userHasModulePermission` — HR roles on
 * staging hold `hr` but not `partners`, so these checks are manual
 * instead of `@RequirePermissions` (whose entries are ANDed, and `hr`
 * is in NO_ADMIN_BYPASS so the decorator would also lock Admins out).
 */
import { isAdminUser, userHasModulePermission } from '../../common/guards/roles.guard';

/**
 * User fields whose change needs `finance:write` (checked with
 * `assertFinanceFieldWrites` in UsersService.create / update).
 */
export const USER_FINANCE_FIELDS = ['salaryHourly', 'seniorityLevelId'] as const;

/** Admin or HR (`hr:write`) — may add and remove employees. */
export function canManageEmployees(actor: any): boolean {
  return isAdminUser(actor) || userHasModulePermission(actor, 'hr', 'write');
}

/** Admin, `partners:write` or `hr:write` — may open `PATCH /users/:id`. */
export function canEditPeople(actor: any): boolean {
  return (
    isAdminUser(actor) ||
    userHasModulePermission(actor, 'partners', 'write') ||
    userHasModulePermission(actor, 'hr', 'write')
  );
}

export interface RoleForPolicy {
  name?: string | null;
  roleModules?: Array<{
    canRead?: boolean | null;
    canWrite?: boolean | null;
    canDelete?: boolean | null;
    canApprove?: boolean | null;
    canExport?: boolean | null;
    module?: { route?: string | null; name?: string | null } | null;
  }> | null;
}

/**
 * Admin-level role: named "Admin", or holds ANY flag on the top-level
 * `/admin` module. Sub-modules such as `admin/activity-log` or
 * `admin/clock-dashboard` do not count — only the parent row, which the
 * guard's parent fallback turns into access to every `/admin/*` page.
 */
export function isAdminLevelRole(role: RoleForPolicy | null | undefined): boolean {
  if (!role) return false;
  if (String(role.name ?? '').trim().toLowerCase() === 'admin') return true;
  return (role.roleModules ?? []).some((rm) => {
    const route = String(rm.module?.route ?? '').trim().toLowerCase();
    const isTopLevelAdmin = route === '/admin' || route === 'admin';
    if (!isTopLevelAdmin) return false;
    return !!(rm.canRead || rm.canWrite || rm.canDelete || rm.canApprove || rm.canExport);
  });
}
