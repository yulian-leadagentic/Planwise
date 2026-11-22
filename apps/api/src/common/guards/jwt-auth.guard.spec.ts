import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

import {
  JwtAuthGuard,
  PASSWORD_CHANGE_REQUIRED,
  ALLOW_WHILE_PASSWORD_CHANGE_REQUIRED,
} from './jwt-auth.guard';
import { AuthController } from '../../modules/auth/auth.controller';
import { UsersController } from '../../modules/users/users.controller';
import { HrController } from '../../modules/hr/hr.controller';
import { WsAuthService } from '../services/ws-auth.service';

/**
 * Permissions round 3 (2026-11-22) — while `mustChangePassword` is set,
 * every JWT route answers 403 PASSWORD_CHANGE_REQUIRED except the
 * self-service ones the user needs to change it (GET /auth/me, PATCH
 * /auth/me/password, POST /auth/logout).
 *
 * `handleRequest` is the hook passport calls with the validated user;
 * testing it directly covers every route that uses JwtAuthGuard.
 */

function ctx(cls: any, method: string): any {
  return {
    getHandler: () => cls.prototype[method],
    getClass: () => cls,
  };
}

const FORCED = { id: 5, mustChangePassword: true };
const NORMAL = { id: 6, mustChangePassword: false };

describe('JwtAuthGuard — PASSWORD_CHANGE_REQUIRED', () => {
  const guard = new JwtAuthGuard();

  it.each([
    ['GET /auth/me', AuthController, 'getProfile'],
    ['PATCH /auth/me/password', AuthController, 'changePassword'],
    ['POST /auth/logout', AuthController, 'logout'],
  ])('lets a user with mustChangePassword call %s', (_label, cls, method) => {
    expect(guard.handleRequest(null, FORCED, null, ctx(cls, method))).toBe(FORCED);
  });

  it.each([
    ['PATCH /auth/me (profile)', AuthController, 'updateProfile'],
    ['PATCH /auth/me/avatar', AuthController, 'uploadAvatar'],
    ['GET /users', UsersController, 'findAll'],
    ['GET /hr/audit', HrController, 'listAudit'],
  ])('blocks %s with 403 PASSWORD_CHANGE_REQUIRED', (_label, cls, method) => {
    let err: any;
    try {
      guard.handleRequest(null, FORCED, null, ctx(cls, method));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ code: PASSWORD_CHANGE_REQUIRED });
  });

  it('does nothing for a user without the flag', () => {
    expect(guard.handleRequest(null, NORMAL, null, ctx(UsersController, 'findAll'))).toBe(NORMAL);
  });

  it('still answers 401 when there is no user', () => {
    expect(() => guard.handleRequest(null, false, null, ctx(UsersController, 'findAll'))).toThrow(UnauthorizedException);
  });

  it('only the three self-service routes carry the exemption', () => {
    const exempt = Object.getOwnPropertyNames(AuthController.prototype).filter(
      (m) => m !== 'constructor' && Reflect.getMetadata(ALLOW_WHILE_PASSWORD_CHANGE_REQUIRED, (AuthController.prototype as any)[m]),
    );
    expect(exempt.sort()).toEqual(['changePassword', 'getProfile', 'logout']);
  });
});

describe('WsAuthService — no live channel while a password change is pending', () => {
  it('refuses the handshake for a user with mustChangePassword', async () => {
    const jwt: any = { verifyAsync: jest.fn(async () => ({ sub: 5 })) };
    const prisma: any = {
      user: { findFirst: jest.fn(async () => ({ id: 5, mustChangePassword: true, role: null, userRoles: [] })) },
    };
    const config: any = { get: () => 'x'.repeat(32) };
    const svc = new WsAuthService(jwt, prisma, config);
    await expect(svc.authenticate({ handshake: { auth: { token: 't' }, headers: {} } } as any)).resolves.toBeNull();

    prisma.user.findFirst.mockResolvedValue({ id: 6, mustChangePassword: false, role: null, userRoles: [] });
    await expect(svc.authenticate({ handshake: { auth: { token: 't' }, headers: {} } } as any)).resolves.toMatchObject({ id: 6 });
  });
});
