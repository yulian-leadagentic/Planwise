import { Navigate, useLocation, Outlet } from 'react-router-dom';
import { usePermissions } from '@/hooks/use-permissions';

/** Read on any of these opens /admin/data-import (and its history page). */
export const DATA_IMPORT_ROUTE_MODULES =
  'data-import|data-import/contacts|data-import/users|data-import/partners';

/**
 * Maps URL prefixes to permission module keys. Longer (more specific) prefixes
 * are evaluated first so a sub-module like "/templates/zone" wins over the
 * parent "/templates". The permission hook walks back up to the parent if the
 * exact entry doesn't exist, preserving access for roles granted at parent level.
 */
const ROUTE_MODULE_MAP: Record<string, string> = {
  // Templates sub-modules
  '/templates/task-catalog': 'templates/task-catalog',
  '/templates/deliverables': 'templates/deliverables',
  '/templates/zone': 'templates/zone',
  '/templates/team': 'templates/team',
  '/templates/services': 'templates/services',
  '/templates/types': 'templates/types',

  // Admin sub-modules
  '/admin/roles': 'admin/roles',
  '/admin/organization': 'org',
  '/admin/activity-log': 'admin/activity-log',
  '/admin/work-schedules': 'admin/work-schedules',
  // HR F2 (2026-10-19) — '/admin/calendar' is now a pass-through
  // redirect to '/hr/calendar' (bookmarks). Keep an entry here so
  // the longer-prefix match in SORTED_PREFIXES wins over the generic
  // '/admin' → 'admin' mapping: mapping it to 'hr' means an HR
  // Manager (hr:read, no admin) still reaches the redirect, and the
  // /hr guard on the destination enforces the real permission.
  '/admin/calendar': 'hr',
  '/admin/notification-settings': 'admin/notification-settings',
  '/admin/clock-dashboard': 'admin/clock-dashboard',
  '/admin/partner-types': 'admin/partner-types',
  // SSO + Drive both live under the `org` module — the Access &
  // Security group. Matches the admin-layout entry so the sub-nav
  // gate and route gate agree. (Was defined twice — the earlier
  // '/admin/sso': 'org' at the top of this block was left over from
  // the SSO hotfix and got redefined here when Drive shipped; tsc
  // surfaced the collision via TS1117.)
  '/admin/sso': 'org',
  '/admin/drive': 'org',
  // BM2-28 (QA6) — Data Import is its own permission family. A role
  // with "Import Contacts" (or Employees / Partners) but no admin:read
  // was bounced to "/" when it clicked "Import contacts" on the
  // Contacts / Organizations page: a dead button. Any import grant
  // opens the page; the page and the API check the specific target.
  '/admin/data-import': DATA_IMPORT_ROUTE_MODULES,
  // The history list is read on the parent module only (API:
  // GET /data-import/history needs data-import:read).
  '/admin/data-import/history': 'data-import',

  // Reports sub-modules — fully-financial reports require finance:read even
  // though the Reports hub only needs reports:read. SORTED_PREFIXES below
  // orders longest-first, so these two override the generic '/reports' →
  // 'reports' mapping and a user with reports:read but not finance:read is
  // redirected to '/' when they hit these URLs directly. Timesheet stays on
  // the 'reports' module — it has legitimate hours content and gates its ₪
  // columns in-page. (FG-1, finance-gate-cost-report.md, 2026-09-28.)
  '/reports/cost': 'finance',
  '/reports/billing-forecast': 'finance',

  // Top-level modules
  '/admin': 'admin',
  '/contracts': 'contracts',
  '/reports': 'reports',
  '/templates': 'templates',
  '/projects': 'projects',
  '/execution-board': 'projects',
  '/tasks': 'tasks',
  '/my-tasks': 'tasks',
  '/time': 'time',
  '/inbox': 'tasks',
  '/messages': 'tasks',
  '/people': 'partners|hr', // round 3: partners:read OR hr:read (as GET /users)
  '/admin/employees': 'partners|hr',
  // HR Phase A4 (2026-10-15) — the whole /hr/* subtree checks `hr:read`.
  // RolesGuard's NO_ADMIN_BYPASS (A1) blocks the admin shortcut on the
  // API side; this guard mirrors the same rule on the client so a role
  // without the HR grant gets bounced to the dashboard instead of a
  // 403 drawer.
  '/hr': 'hr',
  // Was defined twice — an earlier "Business Partners (uses existing
  // 'people' permission)" entry mapped '/partners' → 'people', and
  // the later '/partners' → 'partners' below silently overrode it
  // (which was ALSO what the runtime wanted, matching the /people
  // and /admin/employees mappings above). tsc surfaced the collision
  // via TS1117. Keeping the intended one.
  '/partners': 'partners',
  // QA6 P7 (PR-056, owner's decision 25.11) — Operations is its own
  // permission module; the API gates every dashboard/operations* and
  // workload/* route on operations:read. (It rode on projects:read from
  // feat/ops-complete until then.) The legacy /dashboard/workload
  // redirect lands here too.
  '/operations': 'operations',
  '/dashboard/workload': 'operations',
};

const SORTED_PREFIXES = Object.keys(ROUTE_MODULE_MAP).sort((a, b) => b.length - a.length);

/**
 * Permissions round 3 (2026-11-22) — routes whose module the API checks
 * WITHOUT the admin bypass, so the client must not wave an Admin through
 * either. `/hr/audit`: HR audit rows are visible to hr:read holders only
 * — not to an Admin without the HR grant (owner's decision). The rest of
 * `/hr/*` keeps today's behaviour.
 */
const NO_ADMIN_BYPASS_ROUTES: Record<string, string> = {
  '/hr/audit': 'hr',
};

/**
 * May this user open `pathname`? Pure — the guard below and its spec
 * share it. The longest matching prefix decides.
 */
export function isRouteAllowed(
  pathname: string,
  can: (module: string, action: 'read') => boolean,
  isAdmin: boolean,
): boolean {
  for (const [prefix, mod] of Object.entries(NO_ADMIN_BYPASS_ROUTES)) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      if (!can(mod, 'read')) return false;
    }
  }

  if (!isAdmin) {
    for (const prefix of SORTED_PREFIXES) {
      if (pathname === prefix || pathname.startsWith(prefix + '/')) {
        const mod = ROUTE_MODULE_MAP[prefix];
        return mod.split('|').some((m) => can(m, 'read')); // 'a|b' = read on a OR b
      }
    }
  }
  return true;
}

export function RoutePermissionGuard({ children }: { children?: React.ReactNode }) {
  const location = useLocation();
  const { can, isAdmin } = usePermissions();

  if (!isRouteAllowed(location.pathname, can, isAdmin)) return <Navigate to="/" replace />;

  return children ? <>{children}</> : <Outlet />;
}
