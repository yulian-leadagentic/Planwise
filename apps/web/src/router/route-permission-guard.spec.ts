/**
 * QA6 P7 (PR-056) — Operations is its own permission module: the route
 * and the sidebar / mobile-nav item need `operations:read`. A
 * Professonal (projects:read, no operations) neither sees the item nor
 * reaches /operations; a BIM leader with the grant does; Admin always.
 */
import { describe, it, expect } from 'vitest';
import { isRouteAllowed } from './route-permission-guard';
import { isNavItemVisible, NAV_MODULE_MAP } from '@/lib/nav-permissions';
import { NAV_ITEMS } from '@/lib/constants';

/** Same lookup as usePermissions().can — route or name, most specific first. */
function canFrom(roleModules: Array<{ module: { route: string; name: string }; canRead: boolean }>) {
  return (module: string) => {
    const key = module.toLowerCase();
    const row = roleModules.find((m) => m.module.route === module || m.module.route === `/${module}` || m.module.name.toLowerCase() === key);
    return !!row?.canRead;
  };
}

const PROJECTS = { module: { route: '/projects', name: 'Projects' }, canRead: true };
const TASKS = { module: { route: '/tasks', name: 'Tasks' }, canRead: true };
const OPERATIONS = { module: { route: '/operations', name: 'Operations' }, canRead: true };

const professional = canFrom([PROJECTS, TASKS]);
const bimLeader = canFrom([PROJECTS, TASKS, OPERATIONS]);
const revoked = canFrom([PROJECTS, TASKS, { ...OPERATIONS, canRead: false }]);

describe('Operations route + menu item need operations:read', () => {
  it('the nav and the route map Operations to the operations module (not projects)', () => {
    expect(NAV_MODULE_MAP['/operations']).toBe('operations');
    expect(NAV_ITEMS.some((i) => i.href === '/operations')).toBe(true);
  });

  it('Professonal (projects:read only): no menu item, /operations bounces', () => {
    expect(isNavItemVisible('/operations', professional, false)).toBe(false);
    expect(isRouteAllowed('/operations', professional, false)).toBe(false);
    expect(isRouteAllowed('/dashboard/workload', professional, false)).toBe(false);
    // the rest of his menu is untouched
    expect(isNavItemVisible('/projects', professional, false)).toBe(true);
    expect(isRouteAllowed('/projects/12', professional, false)).toBe(true);
  });

  it('BIM leader with the grant sees and reaches it; an unticked row hides it again', () => {
    expect(isNavItemVisible('/operations', bimLeader, false)).toBe(true);
    expect(isRouteAllowed('/operations', bimLeader, false)).toBe(true);
    expect(isNavItemVisible('/operations', revoked, false)).toBe(false);
    expect(isRouteAllowed('/operations', revoked, false)).toBe(false);
  });

  it('Admin passes (same bypass as the API guard)', () => {
    expect(isNavItemVisible('/operations', professional, true)).toBe(true);
    expect(isRouteAllowed('/operations', professional, true)).toBe(true);
  });
});
