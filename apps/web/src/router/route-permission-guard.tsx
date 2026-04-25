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
  '/admin/activity-log': 'admin/activity-log',
  '/admin/work-schedules': 'admin/work-schedules',
  '/admin/calendar': 'admin/calendar',
  '/admin/notification-settings': 'admin/notification-settings',
  '/admin/clock-dashboard': 'admin/clock-dashboard',

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
  '/people': 'people',
  '/operations': 'operations',
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
