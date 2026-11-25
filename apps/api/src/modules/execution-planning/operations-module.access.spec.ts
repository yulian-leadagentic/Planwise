/**
 * QA6 P7 (PR-056, owner's decision 25.11) — Operations is its own
 * permission module. Runs the REAL RolesGuard against the REAL route
 * metadata of ExecutionPlanningController:
 *
 *   • every `dashboard/operations*` and `workload/*` route needs
 *     operations:read — except `workload/me` (own data);
 *   • Professonal (projects:read, no operations) → 403;
 *   • BIM leader with the grant → through;
 *   • Admin → through (bypass; operations is not in NO_ADMIN_BYPASS);
 *   • the per-project panel (`projects/:id/workload`) stays on projects:read.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';

import { RolesGuard } from '../../common/guards/roles.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { ExecutionPlanningController, OPERATIONS_READ } from './execution-planning.controller';

const proto = ExecutionPlanningController.prototype as any;
const handlers = Object.getOwnPropertyNames(proto)
  .filter((k) => k !== 'constructor' && typeof proto[k] === 'function')
  .map((k) => ({ key: k, fn: proto[k], path: String(Reflect.getMetadata(PATH_METADATA, proto[k]) ?? '') }));
const byPath = (path: string) => handlers.find((h) => h.path === path)!;

function ctx(handler: Function, user: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => ExecutionPlanningController,
  } as unknown as ExecutionContext;
}
const guard = new RolesGuard(new Reflector());
const passes = (path: string, user: any) => {
  try {
    return guard.canActivate(ctx(byPath(path).fn, user));
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
};

const row = (route: string, name: string, flags: Partial<Record<'canRead' | 'canWrite', boolean>> = { canRead: true }) => ({
  module: { route, name },
  canRead: false, canWrite: false, canDelete: false, canApprove: false, canExport: false,
  ...flags,
});
const PROFESSIONAL = { id: 40, isAdmin: false, roleModules: [row('/projects', 'Projects', { canRead: true, canWrite: true }), row('/tasks', 'Tasks')] };
const BIM_LEADER = { id: 41, isAdmin: false, roleModules: [...PROFESSIONAL.roleModules, row('/operations', 'Operations')] };
const ADMIN = { id: 1, isAdmin: true, roleModules: [row('/projects', 'Projects')] };

const OPS_PATHS = handlers
  .map((h) => h.path)
  .filter((p) => (p.startsWith('dashboard/operations') || p.startsWith('workload/')) && p !== 'workload/me');

describe('Operations permission module — route gates', () => {
  it('covers the expected routes', () => {
    expect(OPS_PATHS.sort()).toEqual([
      'dashboard/operations',
      'dashboard/operations/active-projects',
      'dashboard/operations/bim-leaders',
      'dashboard/operations/executive-review',
      'dashboard/operations/tasks/:taskId/ops-note',
      'workload/team',
      'workload/user/:userId',
    ]);
  });

  it('every dashboard/operations* and workload/* route requires operations:read (workload/me excepted)', () => {
    for (const p of OPS_PATHS) {
      expect(Reflect.getMetadata(ROLES_KEY, byPath(p).fn)).toContainEqual(OPERATIONS_READ);
    }
    expect(Reflect.getMetadata(ROLES_KEY, byPath('workload/me').fn)).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, byPath('projects/:id/workload').fn)).toEqual([{ module: 'projects', action: 'read' }]);
  });

  it('Professonal → 403 on dashboard/operations and workload/team (and every other ops route)', () => {
    expect(() => guard.canActivate(ctx(byPath('dashboard/operations').fn, PROFESSIONAL))).toThrow(ForbiddenException);
    try {
      guard.canActivate(ctx(byPath('workload/team').fn, PROFESSIONAL));
      throw new Error('expected 403');
    } catch (e: any) {
      expect(e).toBeInstanceOf(ForbiddenException);
      expect(e.getStatus()).toBe(403);
      expect(e.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    for (const p of OPS_PATHS) expect(passes(p, PROFESSIONAL)).toBe(false);
  });

  it('Professonal keeps workload/me and the per-project workload panel', () => {
    expect(passes('workload/me', PROFESSIONAL)).toBe(true);
    expect(passes('projects/:id/workload', PROFESSIONAL)).toBe(true);
  });

  it('BIM leader with operations:read → through (200)', () => {
    for (const p of OPS_PATHS) expect(passes(p, BIM_LEADER)).toBe(true);
  });

  it('the ops note also still needs projects:write', () => {
    const readOnly = { ...BIM_LEADER, roleModules: [row('/projects', 'Projects'), row('/operations', 'Operations')] };
    expect(passes('dashboard/operations/tasks/:taskId/ops-note', readOnly)).toBe(false);
    expect(passes('dashboard/operations', readOnly)).toBe(true);
  });

  it('Admin passes without an explicit row (bypass — operations is not in NO_ADMIN_BYPASS)', () => {
    for (const p of OPS_PATHS) expect(passes(p, ADMIN)).toBe(true);
  });
});
