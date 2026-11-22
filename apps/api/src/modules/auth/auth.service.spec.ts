import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Mirror of AuthService.hashResetSecret with the spec's refresh secret. */
const REFRESH_SECRET = 'b'.repeat(32);
const hmac = (kind: 'otp' | 'reset', value: string) =>
  crypto.createHmac('sha256', REFRESH_SECRET).update(`${kind}:${value}`).digest('hex');
const flush = () => new Promise((r) => setImmediate(r));

describe('AuthService', () => {
  let service: AuthService;
  let prisma: any;
  let jwtService: any;
  let configService: any;
  let notifications: { sendEmail: jest.Mock };

  beforeEach(async () => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
      },
      // SSO gate: validateUser now consults orgAuthConfig when the
      // user has allowPasswordLogin=false. The default mock returns
      // no enforced-SSO row so password-only tests continue to pass.
      orgAuthConfig: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    jwtService = {
      sign: jest.fn().mockReturnValue('mock-token'),
    };
    configService = {
      get: jest.fn((key: string, def?: string) => {
        const map: Record<string, string> = {
          JWT_ACCESS_SECRET: 'a'.repeat(32),
          JWT_REFRESH_SECRET: REFRESH_SECRET,
        };
        return map[key] ?? def;
      }),
    };
    notifications = { sendEmail: jest.fn(async () => true) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: configService },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('validateUser', () => {
    it('throws UnauthorizedException for unknown email', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.validateUser('bad@x.com', 'pw')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws UnauthorizedException for wrong password', async () => {
      const hashed = await bcrypt.hash('correct', 10);
      prisma.user.findFirst.mockResolvedValueOnce({ id: 1, password: hashed, allowPasswordLogin: true });
      await expect(service.validateUser('a@b.com', 'wrong')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws UnauthorizedException for SSO-only users (null password)', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: 1, password: null, allowPasswordLogin: true });
      await expect(service.validateUser('a@b.com', 'anything')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('blocks password login when ssoOnly is enforced and user has allowPasswordLogin=false', async () => {
      const hashed = await bcrypt.hash('correct', 10);
      prisma.user.findFirst.mockResolvedValueOnce({ id: 1, password: hashed, allowPasswordLogin: false });
      prisma.orgAuthConfig.findFirst.mockResolvedValueOnce({ id: 1 });
      await expect(service.validateUser('a@b.com', 'correct')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('returns user without password on valid credentials', async () => {
      const hashed = await bcrypt.hash('correct', 10);
      prisma.user.findFirst
        .mockResolvedValueOnce({ id: 1, password: hashed, allowPasswordLogin: true })
        .mockResolvedValueOnce({ id: 1, password: hashed, email: 'a@b.com', role: { roleModules: [] } });

      const result = await service.validateUser('a@b.com', 'correct');
      expect(result.id).toBe(1);
      expect(result).not.toHaveProperty('password');
    });
  });

  // Permissions round 3 (2026-11-22) — the code is e-mailed for real
  // and only its HMAC is stored; responses never reveal whether the
  // address has an account.
  describe('forgotPassword', () => {
    it('silently returns for unknown email (no user enumeration)', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.forgotPassword('unknown@x.com')).resolves.toBeUndefined();
      await flush();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(notifications.sendEmail).not.toHaveBeenCalled();
    });

    it('ignores a non-string email (no Prisma filter injection)', async () => {
      await expect(service.forgotPassword({ contains: '@' } as any)).resolves.toBeUndefined();
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('skips SSO-only accounts (no local password to reset)', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 1, email: 'a@b.com', firstName: 'Dana', password: null });
      await service.forgotPassword('a@b.com');
      await flush();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(notifications.sendEmail).not.toHaveBeenCalled();
    });

    it('stores only a hash of the 6-digit code, with expiry, and e-mails the code', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 1, email: 'a@b.com', firstName: 'Dana', password: 'x' });
      prisma.user.update.mockResolvedValue({});

      await service.forgotPassword('a@b.com');
      await flush();

      const call = prisma.user.update.mock.calls[0][0];
      expect(call.data.otpCode).toMatch(/^[0-9a-f]{64}$/);
      expect(call.data.otpCode).not.toMatch(/^\d{6}$/);
      expect(call.data.otpExpiresAt).toBeInstanceOf(Date);
      expect(call.data.otpAttempts).toBe(0);

      expect(notifications.sendEmail).toHaveBeenCalledTimes(1);
      const mail = notifications.sendEmail.mock.calls[0][0];
      expect(mail.to).toBe('a@b.com');
      const code = /\b(\d{6})\b/.exec(mail.text)?.[1];
      expect(code).toBeDefined();
      expect(mail.html).toContain(code);
      // The stored value is the HMAC of exactly the code that was sent.
      expect(call.data.otpCode).toBe(hmac('otp', code!));
    });

    it('does not wait for the e-mail (same response time with or without an account)', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 1, email: 'a@b.com', firstName: 'Dana', password: 'x' });
      prisma.user.update.mockResolvedValue({});
      notifications.sendEmail.mockImplementation(() => new Promise(() => undefined)); // never settles
      await expect(service.forgotPassword('a@b.com')).resolves.toBeUndefined();
    });
  });

  describe('verifyOtp', () => {
    const pending = (overrides: Record<string, unknown> = {}) => ({
      id: 1, otpCode: hmac('otp', '123456'), otpExpiresAt: new Date(Date.now() + 600000), otpAttempts: 0, ...overrides,
    });

    it('throws for expired OTP', async () => {
      prisma.user.findFirst.mockResolvedValue(pending({ otpExpiresAt: new Date(Date.now() - 60000) }));
      await expect(service.verifyOtp('a@b.com', '123456')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('increments otpAttempts on wrong code', async () => {
      prisma.user.findFirst.mockResolvedValue(pending());
      prisma.user.update.mockResolvedValue({});

      await expect(service.verifyOtp('a@b.com', '000000')).rejects.toThrow('The code is invalid or has expired');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { otpAttempts: { increment: 1 } },
      });
    });

    it('blocks after 5 failed attempts (and burns the code)', async () => {
      prisma.user.findFirst.mockResolvedValue(pending({ otpAttempts: 5 }));
      prisma.user.update.mockResolvedValue({});

      await expect(service.verifyOtp('a@b.com', '123456')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.update.mock.calls[0][0].data).toEqual({ otpCode: null, otpExpiresAt: null, otpAttempts: 0 });
    });

    it('gives an unknown address the same answer as a wrong code (no enumeration)', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      const unknown = await service.verifyOtp('nobody@x.com', '123456').catch((e) => e.message);
      prisma.user.findFirst.mockResolvedValue(pending());
      prisma.user.update.mockResolvedValue({});
      const wrong = await service.verifyOtp('a@b.com', '000000').catch((e) => e.message);
      expect(unknown).toBe(wrong);
    });

    it('a stored plain-text code no longer matches', async () => {
      prisma.user.findFirst.mockResolvedValue(pending({ otpCode: '123456' }));
      prisma.user.update.mockResolvedValue({});
      await expect(service.verifyOtp('a@b.com', '123456')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns a reset token on valid OTP and stores only its hash', async () => {
      prisma.user.findFirst.mockResolvedValue(pending({ otpAttempts: 1 }));
      prisma.user.update.mockResolvedValue({});

      const result = await service.verifyOtp('a@b.com', '123456');
      expect(result).toHaveProperty('resetToken');
      expect(typeof result.resetToken).toBe('string');
      expect(result.resetToken.length).toBeGreaterThan(10);
      const stored = prisma.user.update.mock.calls[0][0].data.otpCode;
      expect(stored).not.toBe(result.resetToken);
      expect(stored).toBe(hmac('reset', result.resetToken));
    });
  });

  describe('resetPassword', () => {
    it('throws for invalid/expired reset token', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.resetPassword('bad-token', 'newPass')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('looks the token up by its hash', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await service.resetPassword('tok-1', 'newPass123').catch(() => undefined);
      expect(prisma.user.findFirst.mock.calls[0][0].where.otpCode).toBe(hmac('reset', 'tok-1'));
    });

    it('hashes the new password with bcrypt and clears mustChangePassword', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 1 });
      prisma.user.update.mockResolvedValue({});

      await service.resetPassword('valid-token', 'myNewPass123');

      const call = prisma.user.update.mock.calls[0][0];
      expect(call.data.password).toBeDefined();
      // Verify it's a bcrypt hash (starts with $2b$)
      expect(call.data.password).toMatch(/^\$2[aby]\$/);
      // Verify the original password wasn't stored
      expect(call.data.password).not.toBe('myNewPass123');
      // Verify OTP fields are cleared
      expect(call.data.otpCode).toBeNull();
      expect(call.data.mustChangePassword).toBe(false);
    });
  });

  describe('login', () => {
    it('signs access + refresh tokens and updates lastLoginAt', async () => {
      prisma.user.update.mockResolvedValue({});

      const result = await service.login({
        id: 1, email: 'a@b.com', roleId: 2, firstName: 'A', lastName: 'B', role: { name: 'editor' },
      });

      expect(jwtService.sign).toHaveBeenCalledTimes(2);
      expect(result).toHaveProperty('accessToken', 'mock-token');
      expect(result).toHaveProperty('refreshToken', 'mock-token');
      expect(result.user).toHaveProperty('id', 1);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { lastLoginAt: expect.any(Date) },
      });
    });

    it('carries mustChangePassword in the login response', async () => {
      prisma.user.update.mockResolvedValue({});
      const forced = await service.login({ id: 1, email: 'a@b.com', roleId: 2, mustChangePassword: true });
      expect(forced.user.mustChangePassword).toBe(true);
      const normal = await service.login({ id: 2, email: 'c@d.com', roleId: 2 });
      expect(normal.user.mustChangePassword).toBe(false);
    });
  });

  describe('changePassword', () => {
    it('throws when current password is wrong', async () => {
      const hashed = await bcrypt.hash('real', 10);
      prisma.user.findFirst.mockResolvedValue({ id: 1, password: hashed });

      await expect(service.changePassword(1, 'wrong', 'newPassword1')).rejects.toThrow('Current password is incorrect');
    });

    it('rejects a new password shorter than 8 characters', async () => {
      await expect(service.changePassword(1, 'real', 'short')).rejects.toThrow('at least 8 characters');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects re-using the current password', async () => {
      const hashed = await bcrypt.hash('given-by-admin', 10);
      prisma.user.findFirst.mockResolvedValue({ id: 1, password: hashed });
      await expect(service.changePassword(1, 'given-by-admin', 'given-by-admin')).rejects.toThrow('different from the current one');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('clears mustChangePassword on success', async () => {
      const hashed = await bcrypt.hash('given-by-admin', 10);
      prisma.user.findFirst.mockResolvedValue({ id: 1, password: hashed });
      prisma.user.update.mockResolvedValue({});
      await service.changePassword(1, 'given-by-admin', 'myOwnSecret9');
      const call = prisma.user.update.mock.calls[0][0];
      expect(call.data.mustChangePassword).toBe(false);
      expect(await bcrypt.compare('myOwnSecret9', call.data.password)).toBe(true);
    });
  });

  describe('getProfile (GET /auth/me)', () => {
    it('selects mustChangePassword', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 1, mustChangePassword: true, role: { name: 'x', roleModules: [] }, userRoles: [] });
      const me: any = await service.getProfile(1);
      expect(prisma.user.findFirst.mock.calls[0][0].select.mustChangePassword).toBe(true);
      expect(me.mustChangePassword).toBe(true);
    });
  });

  // Permissions round 1 (2026-11-20) — P0-4: a user must not be able to
  // move themselves into another org unit (that widens project access).
  describe('updateProfile (PATCH /auth/me)', () => {
    it('ignores orgUnitId and writes only the self-service fields', async () => {
      prisma.user.update.mockResolvedValue({ id: 1 });

      await service.updateProfile(1, {
        firstName: 'Dana',
        phone: '050',
        orgUnitId: 77,
        roleId: 1,
        isActive: true,
        email: 'other@x.com',
      });

      const call = prisma.user.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 1 });
      expect(call.data).toEqual({ firstName: 'Dana', phone: '050' });
      expect(call.data).not.toHaveProperty('orgUnitId');
    });
  });

  // Permissions round 1 (2026-11-20) — decision 4: impersonation removed.
  describe('impersonation', () => {
    it('has no POST /auth/impersonate route and no service method', () => {
      expect((AuthController.prototype as any).impersonate).toBeUndefined();
      expect((AuthService.prototype as any).impersonate).toBeUndefined();

      const routePaths = Object.getOwnPropertyNames(AuthController.prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => Reflect.getMetadata('path', (AuthController.prototype as any)[name]))
        .filter((p) => p !== undefined);
      expect(routePaths.length).toBeGreaterThan(0);
      expect(routePaths).not.toContain('impersonate');
    });
  });
});
