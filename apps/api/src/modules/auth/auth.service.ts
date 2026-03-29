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
import { v4 as uuidv4 } from 'uuid';

import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async validateUser(email: string, password: string): Promise<any> {
    const user = await this.prisma.user.findFirst({
      where: { email, isActive: true },
      include: {
        role: {
          include: {
            roleModules: { include: { module: true } },
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const { password: _, ...result } = user;
    return result;
  }

  async login(user: any) {
    const payload = { sub: user.id, email: user.email, roleId: user.roleId };
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get('JWT_REFRESH_SECRET', 'amec-refresh-secret'),
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
      secret: this.configService.get('JWT_REFRESH_SECRET', 'amec-refresh-secret'),
      expiresIn: '7d',
    });

    return { accessToken, refreshToken };
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findFirst({ where: { email, isActive: true } });
    if (!user) return; // Silent fail for security

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
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
