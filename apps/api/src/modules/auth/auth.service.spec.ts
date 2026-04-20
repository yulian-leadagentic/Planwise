import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: any;
  let jwtService: any;
  let configService: any;

  beforeEach(async () => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    jwtService = {
      sign: jest.fn().mockReturnValue('mock-token'),
    };
    configService = {
      get: jest.fn((key: string, def?: string) => {
        const map: Record<string, string> = {
          JWT_ACCESS_SECRET: 'a'.repeat(32),
          JWT_REFRESH_SECRET: 'b'.repeat(32),
        };
        return map[key] ?? def;
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: configService },
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
      prisma.user.findFirst.mockResolvedValueOnce({ id: 1, password: hashed });
      await expect(service.validateUser('a@b.com', 'wrong')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('returns user without password on valid credentials', async () => {
      const hashed = await bcrypt.hash('correct', 10);
      prisma.user.findFirst
        .mockResolvedValueOnce({ id: 1, password: hashed })
        .mockResolvedValueOnce({ id: 1, password: hashed, email: 'a@b.com', role: { roleModules: [] } });

      const result = await service.validateUser('a@b.com', 'correct');
      expect(result.id).toBe(1);
      expect(result).not.toHaveProperty('password');
    });
  });

  describe('forgotPassword', () => {
    it('silently returns for unknown email (no user enumeration)', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.forgotPassword('unknown@x.com')).resolves.toBeUndefined();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('generates a 6-digit OTP and stores it with expiry', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 1 });
      prisma.user.update.mockResolvedValue({});

      await service.forgotPassword('a@b.com');

      const call = prisma.user.update.mock.calls[0][0];
      expect(call.data.otpCode).toMatch(/^\d{6}$/);
      expect(call.data.otpExpiresAt).toBeInstanceOf(Date);
      expect(call.data.otpAttempts).toBe(0);
    });
  });

  describe('verifyOtp', () => {
    it('throws for expired OTP', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 1, otpCode: '123456', otpExpiresAt: new Date(Date.now() - 60000), otpAttempts: 0,
      });
      await expect(service.verifyOtp('a@b.com', '123456')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('increments otpAttempts on wrong code', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 1, otpCode: '123456', otpExpiresAt: new Date(Date.now() + 600000), otpAttempts: 0,
      });
      prisma.user.update.mockResolvedValue({});

      await expect(service.verifyOtp('a@b.com', '000000')).rejects.toThrow('Invalid OTP code');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { otpAttempts: { increment: 1 } },
      });
    });

    it('blocks after 5 failed attempts', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 1, otpCode: '123456', otpExpiresAt: new Date(Date.now() + 600000), otpAttempts: 5,
      });
      prisma.user.update.mockResolvedValue({});

      await expect(service.verifyOtp('a@b.com', '123456')).rejects.toThrow('Maximum OTP attempts');
    });

    it('returns a reset token on valid OTP', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 1, otpCode: '123456', otpExpiresAt: new Date(Date.now() + 600000), otpAttempts: 1,
      });
      prisma.user.update.mockResolvedValue({});

      const result = await service.verifyOtp('a@b.com', '123456');
      expect(result).toHaveProperty('resetToken');
      expect(typeof result.resetToken).toBe('string');
      expect(result.resetToken.length).toBeGreaterThan(10);
    });
  });

  describe('resetPassword', () => {
    it('throws for invalid/expired reset token', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.resetPassword('bad-token', 'newPass')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('hashes the new password with bcrypt', async () => {
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
  });

  describe('changePassword', () => {
    it('throws when current password is wrong', async () => {
      const hashed = await bcrypt.hash('real', 10);
      prisma.user.findFirst.mockResolvedValue({ id: 1, password: hashed });

      await expect(service.changePassword(1, 'wrong', 'new')).rejects.toThrow('Current password is incorrect');
    });
  });
});
