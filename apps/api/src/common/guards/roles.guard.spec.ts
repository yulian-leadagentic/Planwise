import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY, OWN_DATA_KEY } from '../decorators/roles.decorator';
import { PERMISSION_DENIED, PermissionDeniedException } from '../errors/permission-denied';

function makeCtx(user: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function makeReflector(permissions: any, ownData: boolean): Reflector {
  return {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === ROLES_KEY) return permissions;
      if (key === OWN_DATA_KEY) return ownData;
      return undefined;
    }),
  } as unknown as Reflector;
}

describe('RolesGuard', () => {
  it('allows routes with no @RequirePermissions', () => {
    const guard = new RolesGuard(makeReflector(undefined, false));
    expect(guard.canActivate(makeCtx({ id: 1 }))).toBe(true);
  });

  it('allows routes with empty permission array', () => {
    const guard = new RolesGuard(makeReflector([], false));
    expect(guard.canActivate(makeCtx({ id: 1 }))).toBe(true);
  });

  it('throws ForbiddenException when user has no role modules', () => {
    const guard = new RolesGuard(makeReflector([{ module: 'tasks', action: 'read' }], false));
    expect(() => guard.canActivate(makeCtx({ id: 1 }))).toThrow(ForbiddenException);
  });

  it('allows access when user has the required permission', () => {
    const guard = new RolesGuard(makeReflector([{ module: 'tasks', action: 'read' }], false));
    const user = {
      id: 1,
      roleModules: [
        { module: { route: 'tasks', name: 'Tasks' }, canRead: true, canWrite: false },
      ],
    };
    expect(guard.canActivate(makeCtx(user))).toBe(true);
  });

  it('rejects when user lacks the required permission', () => {
    const guard = new RolesGuard(makeReflector([{ module: 'tasks', action: 'write' }], false));
    const user = {
      id: 1,
      roleModules: [
        { module: { route: 'tasks', name: 'Tasks' }, canRead: true, canWrite: false },
      ],
    };
    expect(() => guard.canActivate(makeCtx(user))).toThrow(ForbiddenException);
  });

  it('rejects when the module is not in user.roleModules at all', () => {
    const guard = new RolesGuard(makeReflector([{ module: 'admin', action: 'read' }], false));
    const user = {
      id: 1,
      roleModules: [
        { module: { route: 'tasks', name: 'Tasks' }, canRead: true },
      ],
    };
    expect(() => guard.canActivate(makeCtx(user))).toThrow(ForbiddenException);
  });

  it('matches module by name (case-insensitive) as well as route', () => {
    const guard = new RolesGuard(makeReflector([{ module: 'tasks', action: 'read' }], false));
    const user = {
      id: 1,
      roleModules: [
        { module: { route: '', name: 'Tasks' }, canRead: true },
      ],
    };
    expect(guard.canActivate(makeCtx(user))).toBe(true);
  });

  it('checks all required permissions (AND semantics)', () => {
    const guard = new RolesGuard(makeReflector(
      [
        { module: 'tasks', action: 'read' },
        { module: 'tasks', action: 'delete' },
      ],
      false,
    ));
    const user = {
      id: 1,
      roleModules: [
        { module: { route: 'tasks' }, canRead: true, canDelete: false },
      ],
    };
    expect(() => guard.canActivate(makeCtx(user))).toThrow(ForbiddenException);
  });

  it('honors @OwnData() override — lets user through even without module permission', () => {
    const guard = new RolesGuard(makeReflector([{ module: 'time', action: 'read' }], true));
    const user = { id: 1, roleModules: [] };
    expect(guard.canActivate(makeCtx(user))).toBe(true);
  });

  it('rejects unknown action keys safely', () => {
    const guard = new RolesGuard(makeReflector([{ module: 'tasks', action: 'bogus' as any }], false));
    const user = {
      id: 1,
      roleModules: [{ module: { route: 'tasks' }, canRead: true }],
    };
    expect(() => guard.canActivate(makeCtx(user))).toThrow(ForbiddenException);
  });
});

/**
 * Permission messages (2026-11-20) — the 403 says, in plain words, what
 * is missing, and carries PERMISSION_DENIED + { module, action }.
 */
describe('RolesGuard — clear permission-denied answer', () => {
  function denial(permissions: any[], user: any): PermissionDeniedException {
    const guard = new RolesGuard(makeReflector(permissions, false));
    try {
      guard.canActivate(makeCtx(user));
    } catch (e) {
      return e as PermissionDeniedException;
    }
    throw new Error('expected the guard to refuse');
  }
  const TASK_READER = { id: 1, roleModules: [{ module: { route: '/tasks', name: 'Tasks' }, canRead: true }] };

  it('names the area and the verb, and points to the administrator', () => {
    const err = denial([{ module: 'tasks', action: 'write' }], TASK_READER);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getStatus()).toBe(403);
    expect(err.message).toBe("You don't have permission to change tasks. Ask your administrator for access.");
    expect(err.getResponse()).toMatchObject({
      code: PERMISSION_DENIED,
      details: { module: 'tasks', action: 'write' },
    });
  });

  it.each([
    ['finance', 'read', 'view financial data'],
    ['finance', 'write', 'change financial data'],
    ['finance', 'approve', 'approve billings'],
    ['hr', 'read', 'view HR data'],
    ['partners', 'delete', 'delete people & contacts'],
    ['admin/roles', 'write', 'change roles and permissions'],
    ['reports', 'export', 'export reports'],
    ['projects', 'approve', 'approve projects'],
    ['data-import/contacts', 'write', 'import contacts'],
    ['admin/label-types', 'read', 'view label types'], // unknown key → prettified last segment
  ])('%s:%s → "%s"', (module, action, phrase) => {
    const err = denial([{ module, action }], TASK_READER);
    expect(err.message).toBe(`You don't have permission to ${phrase}. Ask your administrator for access.`);
    expect(err.message).not.toMatch(/[a-z]+:(read|write|delete|approve|export)/);
    expect((err.getResponse() as any).details).toEqual({ module, action });
  });

  it('with several required permissions, names the first one the user lacks', () => {
    const err = denial(
      [
        { module: 'tasks', action: 'read' },
        { module: 'tasks', action: 'delete' },
        { module: 'finance', action: 'read' },
      ],
      TASK_READER,
    );
    expect((err.getResponse() as any).details).toEqual({ module: 'tasks', action: 'delete' });
    expect(err.message).toContain('delete tasks');
  });

  it('an Admin without the explicit finance grant is told about financial data', () => {
    const err = denial([{ module: 'finance', action: 'read' }], { id: 1, isAdmin: true, roleModules: [] });
    expect(err.message).toContain('view financial data');
  });

  it('a user without any role modules gets the same clear message', () => {
    const err = denial([{ module: 'hr', action: 'write' }], { id: 1 });
    expect(err.message).toBe("You don't have permission to change HR data. Ask your administrator for access.");
    expect((err.getResponse() as any).code).toBe(PERMISSION_DENIED);
  });
});
