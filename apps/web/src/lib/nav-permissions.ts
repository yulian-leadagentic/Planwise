/**
 * Which permission module each sidebar / mobile-nav destination needs
 * (`read`). Shared by sidebar.tsx and mobile-nav.tsx so the two can't
 * drift; the route itself is guarded by RoutePermissionGuard
 * (router/route-permission-guard.tsx) with the same keys.
 */
export const NAV_MODULE_MAP: Record<string, string> = {
  '/': 'dashboard',
  // QA6 P7 (PR-056, owner's decision 25.11) — Operations is its own
  // permission module; it used to ride on projects:read, so every
  // employee saw it. Matches the API's OPERATIONS_READ gate.
  '/operations': 'operations',
  '/execution-board': 'projects',
  '/status-board': 'projects',
  '/projects': 'projects',
  '/my-tasks': 'tasks',
  '/inbox': 'tasks',
  '/time': 'time',
  '/contracts': 'contracts',
  '/partners': 'partners',
  '/contacts': 'partners',
  // HR Phase A4 (2026-10-15) — the HR module hides personal / medical /
  // payroll data; `hr` is the matching permission key (see
  // ROUTE_MODULE_MAP in route-permission-guard.tsx + the Phase A2 seed).
  '/hr': 'hr',
  '/reports': 'reports',
  '/templates': 'templates',
  '/admin': 'admin',
};

type Can = (module: string, action: 'read') => boolean;

/** Admins see everything; an item without a mapped module is always shown. */
export function isNavItemVisible(href: string, can: Can, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  const mod = NAV_MODULE_MAP[href];
  if (!mod) return true;
  return can(mod, 'read');
}
