import { Navigate, useLocation, Outlet } from 'react-router-dom';
import { usePermissions } from '@/hooks/use-permissions';

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
  '/admin/sso': 'org',
  '/admin/organization': 'org',
  '/admin/activity-log': 'admin/activity-log',
  '/admin/work-schedules': 'admin/work-schedules',
  '/admin/calendar': 'admin/calendar',
  '/admin/notification-settings': 'admin/notification-settings',
  '/admin/clock-dashboard': 'admin/clock-dashboard',
  '/admin/partner-types': 'admin/partner-types',
  // SSO + Drive both live under the `org` module — the Access &
  // Security group. Matches the admin-layout entry so the sub-nav
  // gate and route gate agree.
  '/admin/sso': 'org',
  '/admin/drive': 'org',

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
  '/people': 'partners',
  '/admin/employees': 'partners',
  // Was defined twice — an earlier "Business Partners (uses existing
  // 'people' permission)" entry mapped '/partners' → 'people', and
  // the later '/partners' → 'partners' below silently overrode it
  // (which was ALSO what the runtime wanted, matching the /people
  // and /admin/employees mappings above). tsc surfaced the collision
  // via TS1117. Keeping the intended one.
  '/partners': 'partners',
  // Operations dashboard is a read-only aggregation and is NOT its own
  // grantable module (see apps/api/prisma/seed.ts). Everyone with
  // projects:read may view it; the API endpoints enforce the same. The
  // frontend gate mirrors this so a role that can read projects can
  // reach /operations even when no 'operations' module row exists in
  // their role_modules. (feat/ops-complete, 2026-08.)
  '/operations': 'projects',
};

const SORTED_PREFIXES = Object.keys(ROUTE_MODULE_MAP).sort((a, b) => b.length - a.length);

export function RoutePermissionGuard({ children }: { children?: React.ReactNode }) {
  const location = useLocation();
  const { can, isAdmin } = usePermissions();

  if (!isAdmin) {
    for (const prefix of SORTED_PREFIXES) {
      if (location.pathname === prefix || location.pathname.startsWith(prefix + '/')) {
        const mod = ROUTE_MODULE_MAP[prefix];
        if (!can(mod, 'read')) {
          return <Navigate to="/" replace />;
        }
        break;
      }
    }
  }

  return children ? <>{children}</> : <Outlet />;
}
