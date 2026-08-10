import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

import { PrismaService } from '../../prisma/prisma.service';

function requireSecret(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value || value.length < 32) {
    throw new Error(`${key} must be set and at least 32 characters long`);
  }
  return value;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async validateUser(email: string, password: string): Promise<any> {
    // First: lightweight credential check (no JOINs). We also pull the
    // `allowPasswordLogin` toggle here so we can gate the password path
    // AFTER the hash check succeeds (never before — leaking "SSO-only"
    // as a distinct error against a wrong password would let an
    // attacker enumerate accounts).
    const user = await this.prisma.user.findFirst({
      where: { email, isActive: true },
      select: { id: true, password: true, allowPasswordLogin: true },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // SSO-only rows have password=null — no bcrypt.compare (which
    // would throw on a non-string), just a friendly "use SSO" message
    // BEFORE any timing signal that could hint at account existence.
    // We accept this small enumeration surface because the message is
    // more helpful than a generic "invalid credentials" the user then
    // spends ten minutes debugging.
    if (user.password === null) {
      throw new UnauthorizedException(
        'This account uses single sign-on. Please sign in with your organization identity provider.',
      );
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Password matched — before minting a token, apply the SSO gate.
    // When ANY OrgAuthConfig has ssoOnly=true AND this user has
    // allowPasswordLogin=false, the password path is closed even for
    // a valid hash. The org-wide toggle makes the per-user flag
    // enforceable; without it a user with the flag set could still
    // be blocked only if we hard-coded it, and we don't want that.
    if (!user.allowPasswordLogin) {
      const enforced = await this.prisma.orgAuthConfig.findFirst({
        where: { enabled: true, ssoOnly: true },
        select: { id: true },
      });
      if (enforced) {
        throw new UnauthorizedException(
          'Your organization requires SSO — please sign in with your organization identity provider.',
        );
      }
    }

    // Only load full role graph after successful password check
    const fullUser = await this.prisma.user.findFirst({
      where: { id: user.id },
      include: {
        role: {
          include: {
            roleModules: { include: { module: true } },
          },
        },
      },
    });

    const { password: _, ...result } = fullUser!;
    return result;
  }

  async login(user: any) {
    const payload = { sub: user.id, email: user.email, roleId: user.roleId };
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(payload, {
      secret: requireSecret(this.configService, 'JWT_REFRESH_SECRET'),
      expiresIn: '7d',
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: user.avatarUrl,
        roleName: user.role?.name,
        roleId: user.roleId,
        role: user.role,
        userType: user.userType,
      },
    };
  }

  async refreshTokens(user: any) {
    const payload = { sub: user.id, email: user.email, roleId: user.roleId };
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(payload, {
      secret: requireSecret(this.configService, 'JWT_REFRESH_SECRET'),
      expiresIn: '7d',
    });

    return { accessToken, refreshToken };
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findFirst({ where: { email, isActive: true } });
    if (!user) return; // Silent fail for security

    const otpCode = crypto.randomInt(100000, 1000000).toString();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await this.prisma.user.update({
      where: { id: user.id },
      data: { otpCode, otpExpiresAt, otpAttempts: 0 },
    });

    // TODO: Send email with OTP via mailer service
  }

  async verifyOtp(email: string, code: string) {
    const user = await this.prisma.user.findFirst({
      where: { email, isActive: true },
    });

    if (!user || !user.otpCode || !user.otpExpiresAt) {
      throw new BadRequestException('Invalid OTP request');
    }

    if (user.otpAttempts >= 5) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { otpCode: null, otpExpiresAt: null, otpAttempts: 0 },
      });
      throw new BadRequestException('Maximum OTP attempts exceeded. Please request a new code.');
    }

    if (new Date() > user.otpExpiresAt) {
      throw new BadRequestException('OTP has expired');
    }

    if (user.otpCode !== code) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { otpAttempts: { increment: 1 } },
      });
      throw new BadRequestException('Invalid OTP code');
    }

    // Clear OTP and generate reset token
    const resetToken = uuidv4();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        otpCode: resetToken, // Reuse field to store reset token
        otpExpiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
        otpAttempts: 0,
      },
    });

    return { resetToken };
  }

  async resetPassword(resetToken: string, newPassword: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        otpCode: resetToken,
        otpExpiresAt: { gt: new Date() },
        isActive: true,
      },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        otpCode: null,
        otpExpiresAt: null,
        otpAttempts: 0,
      },
    });
  }

  async getProfile(userId: number) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatarUrl: true,
        userType: true,
        position: true,
        department: true,
        companyName: true,
        role: {
          include: {
            roleModules: { include: { module: true } },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async updateProfile(userId: number, data: any) {
    const allowedFields = ['firstName', 'lastName', 'phone', 'position', 'department'];
    const updateData: Record<string, any> = {};
    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        updateData[field] = data[field];
      }
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        position: true,
        department: true,
        avatarUrl: true,
      },
    });
  }

  async changePassword(userId: number, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findFirst({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // SSO-only users don't have a local password to change. Direct
    // them at the IdP rather than silently succeeding — bcrypt.compare
    // on null throws with a misleading message.
    if (user.password === null) {
      throw new BadRequestException(
        'This account uses single sign-on. Password changes are managed by your organization identity provider.',
      );
    }

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });
  }

  async updateAvatar(userId: number, file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // In production, upload to cloud storage; here we save locally
    const avatarUrl = `/uploads/avatars/${userId}-${Date.now()}.${file.originalname.split('.').pop()}`;

    return this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
      select: { id: true, avatarUrl: true },
    });
  }

  async impersonate(admin: any, userId: number) {
    // Only super-admin (role id 1) can impersonate
    if (admin.roleId !== 1) {
      throw new ForbiddenException('Only administrators can impersonate users');
    }

    const targetUser = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      include: {
        role: {
          include: {
            roleModules: { include: { module: true } },
          },
        },
      },
    });

    if (!targetUser) {
      throw new NotFoundException('Target user not found');
    }

    const payload = { sub: targetUser.id, email: targetUser.email, roleId: targetUser.roleId, impersonatedBy: admin.id };
    const accessToken = this.jwtService.sign(payload, { expiresIn: '1h' });

    return {
      accessToken,
      user: {
        id: targetUser.id,
        email: targetUser.email,
        firstName: targetUser.firstName,
        lastName: targetUser.lastName,
        role: targetUser.role,
      },
    };
  }
}
