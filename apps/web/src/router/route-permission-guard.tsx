import { Navigate, useLocation, Outlet } from 'react-router-dom';
import { usePermissions } from '@/hooks/use-permissions';

/**
 * Maps URL path prefixes to the module permission required to access them.
 * Same map as the sidebar uses. A route not listed here is unrestricted
 * (just needs authentication, handled by PrivateRoute).
 */
const ROUTE_MODULE_MAP: Record<string, string> = {
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

/**
 * Wraps protected routes and redirects to / when the user's role doesn't
 * have read permission on the matching module. Without this, a user who
 * knows the URL can navigate directly to /admin even though the sidebar
 * hides the link.
 *
 * Usage in app-router.tsx — wrap the <Route element> around <AppShell>:
 *   <Route element={<PrivateRoute><RoutePermissionGuard><AppShell /></RoutePermissionGuard></PrivateRoute>}>
 *
 * Or nest it inside the layout:
 *   <Route element={<PrivateRoute><AppShell /></PrivateRoute>}>
 *     <Route element={<RoutePermissionGuard />}>
 *       <Route path="admin" ... />
 *     </Route>
 *   </Route>
 */
export function RoutePermissionGuard({ children }: { children?: React.ReactNode }) {
  const location = useLocation();
  const { can, isAdmin } = usePermissions();

  if (!isAdmin) {
    for (const [prefix, mod] of Object.entries(ROUTE_MODULE_MAP)) {
      if (location.pathname === prefix || location.pathname.startsWith(prefix + '/')) {
        if (!can(mod, 'read')) {
          return <Navigate to="/" replace />;
        }
        break;
      }
    }
  }

  return children ? <>{children}</> : <Outlet />;
}
