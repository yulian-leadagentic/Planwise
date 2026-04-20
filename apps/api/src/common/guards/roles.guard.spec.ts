import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY, OWN_DATA_KEY } from '../decorators/roles.decorator';

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
