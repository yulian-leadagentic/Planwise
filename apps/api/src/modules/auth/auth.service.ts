import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { attachMergedPermissions } from './strategies/jwt.strategy';
import { renderPasswordResetEmail } from './password-reset-email';

/** Forgot-password code lifetime (the e-mail says the same). */
const OTP_TTL_MINUTES = 10;
/** Reset-token lifetime after a correct code. */
const RESET_TOKEN_TTL_MINUTES = 15;
/** Wrong codes allowed before the code is burned. */
const OTP_MAX_ATTEMPTS = 5;
/** Shortest password a user may choose for himself. */
const MIN_PASSWORD_LENGTH = 8;

/**
 * One answer for every verify-otp failure (no pending code, expired,
 * wrong, too many attempts) so the endpoint can't be used to learn
 * whether an address has an account (permissions round 3).
 */
const INVALID_CODE_MESSAGE = 'The code is invalid or has expired. Check it, or request a new one.';

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
    private notifications: NotificationsService,
  ) {}

  /**
   * Permissions round 3 (2026-11-22) — forgot-password secrets (the
   * 6-digit code and the reset token) are stored as HMAC-SHA256 in
   * `users.otp_code`, never in plain text. Keyed with the refresh-token
   * secret so a leaked table can't be brute-forced offline (a 6-digit
   * code is only 10^6 guesses). The `kind` prefix keeps a code hash from
   * ever matching a reset-token lookup and vice versa.
   */
  private hashResetSecret(kind: 'otp' | 'reset', value: string): string {
    return crypto
      .createHmac('sha256', requireSecret(this.configService, 'JWT_REFRESH_SECRET'))
      .update(`${kind}:${value}`)
      .digest('hex');
  }

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

    // Only load full role graph after successful password check.
    // §14 RBAC multi-role (2026-10-18) — also load `userRoles` so the
    // response carries the OR-union `roleModules` the guard reads.
    const fullUser = await this.prisma.user.findFirst({
      where: { id: user.id },
      include: {
        role: {
          include: {
            roleModules: { include: { module: true } },
          },
        },
        userRoles: {
          include: {
            role: {
              include: {
                roleModules: { include: { module: true } },
              },
            },
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

    // §14 — merge the OR-union of every granted role's role_modules
    // onto the response so the FE's permission hook reads the same
    // shape the guard uses. `attachMergedPermissions` falls back to
    // the legacy single-role list when `userRoles` is empty (zero-
    // downtime handover window — pre-backfill).
    const merged = attachMergedPermissions(user);

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
        // §14 — multi-role surface. Each entry: { id, name }.
        roles: merged.roles,
        // §14 — OR-union of module permissions. FE reads this.
        roleModules: merged.roleModules,
        // §14 — convenience flag; mirrors the server guard's check.
        isAdmin: merged.isAdmin,
        // Permissions round 3 — the web routes to "Set a new password"
        // before anything else while this is true; every other route
        // answers 403 PASSWORD_CHANGE_REQUIRED.
        mustChangePassword: user.mustChangePassword === true,
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

  /**
   * POST /auth/forgot-password. Permissions round 3 (2026-11-22) — the
   * code is now actually e-mailed (NotificationsService.sendEmail, SMTP
   * from MAIL_*; every attempt lands in email_logs) and stored only as a
   * hash. The caller gets the same answer whether or not the address
   * has an account: unknown / inactive / SSO-only addresses return
   * silently, and the e-mail goes out in the background so the response
   * time doesn't tell either.
   */
  async forgotPassword(email: string) {
    if (typeof email !== 'string' || !email.trim()) return;
    const user = await this.prisma.user.findFirst({
      where: { email: email.trim(), isActive: true, deletedAt: null },
      select: { id: true, email: true, firstName: true, password: true },
    });
    if (!user) return; // Silent fail for security
    // SSO-only accounts have no local password to reset — sign-in goes
    // through the identity provider.
    if (user.password === null) return;

    const otpCode = crypto.randomInt(100000, 1000000).toString();
    const otpExpiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { otpCode: this.hashResetSecret('otp', otpCode), otpExpiresAt, otpAttempts: 0 },
    });

    const message = renderPasswordResetEmail({
      firstName: user.firstName,
      code: otpCode,
      minutes: OTP_TTL_MINUTES,
    });
    // Not awaited — see the method comment. sendEmail never throws; the
    // catch is belt and braces.
    void this.notifications
      .sendEmail({ to: user.email, template: 'password-reset-code', ...message })
      .catch(() => undefined);
  }

  async verifyOtp(email: string, code: string) {
    const user = await this.prisma.user.findFirst({
      where: { email, isActive: true },
    });

    if (!user || !user.otpCode || !user.otpExpiresAt) {
      throw new BadRequestException(INVALID_CODE_MESSAGE);
    }

    if (user.otpAttempts >= OTP_MAX_ATTEMPTS) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { otpCode: null, otpExpiresAt: null, otpAttempts: 0 },
      });
      throw new BadRequestException(INVALID_CODE_MESSAGE);
    }

    if (new Date() > user.otpExpiresAt) {
      throw new BadRequestException(INVALID_CODE_MESSAGE);
    }

    if (!safeEqualHex(user.otpCode, this.hashResetSecret('otp', String(code ?? '')))) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { otpAttempts: { increment: 1 } },
      });
      throw new BadRequestException(INVALID_CODE_MESSAGE);
    }

    // Burn the code; store only the hash of the one-time reset token.
    const resetToken = uuidv4();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        otpCode: this.hashResetSecret('reset', resetToken),
        otpExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000),
        otpAttempts: 0,
      },
    });

    return { resetToken };
  }

  async resetPassword(resetToken: string, newPassword: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        otpCode: this.hashResetSecret('reset', String(resetToken ?? '')),
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
        // The user chose this password himself (proved the mailbox).
        mustChangePassword: false,
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
        roleId: true,
        // Retire-User.department Step 3/3 (2026-09-28) — free-text
        // `department` retired. OrgUnit is the sole source of truth
        // for org-tree membership on /auth/me.
        orgUnitId: true,
        orgUnit: { select: { id: true, name: true } },
        companyName: true,
        // Permissions round 3 — drives the forced "Set a new password" screen.
        mustChangePassword: true,
        role: {
          include: {
            roleModules: { include: { module: true } },
          },
        },
        // §14 RBAC multi-role (2026-10-18) — see jwt.strategy.ts for
        // the OR-union logic. /auth/me is the FE's single source of
        // truth for module permissions, so the merge happens here too.
        userRoles: {
          include: {
            role: {
              include: {
                roleModules: { include: { module: true } },
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const merged = attachMergedPermissions(user);
    // Strip the raw `userRoles` tree from the response — the FE reads
    // the merged `roleModules` + the `roles` chip list. Keeping the
    // raw tree would ship ~10x more JSON per /auth/me call for no
    // consumer benefit.
    const { userRoles: _ur, ...rest } = merged;
    return rest;
  }

  async updateProfile(userId: number, data: any) {
    // Self-service profile fields only. Anything not listed here is
    // silently ignored (the request is not rejected because /auth/me
    // uses `@Body() any` rather than a whitelisted DTO).
    //
    // Permissions round 1 (2026-11-20) — `orgUnitId` is NOT
    // self-writable: ProjectAccessService grants access to every project
    // of the caller's home org unit, so letting a user pick their own
    // unit let anyone open any department's projects. Home-unit
    // assignment goes through `PATCH /users/:id/org-unit` (`org:write`).
    const allowedFields = ['firstName', 'lastName', 'phone', 'position'];
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
        // Retire-User.department Step 3/3 — OrgUnit only.
        orgUnitId: true,
        orgUnit: { select: { id: true, name: true } },
        avatarUrl: true,
      },
    });
  }

  async changePassword(userId: number, currentPassword: string, newPassword: string) {
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(`The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (typeof currentPassword !== 'string' || !currentPassword) {
      throw new BadRequestException('Enter your current password.');
    }
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
    // A forced change must actually replace the password someone else chose.
    if (newPassword === currentPassword) {
      throw new BadRequestException('Choose a new password that is different from the current one.');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: userId },
      // Permissions round 3 — the user chose it himself: clear the flag.
      data: { password: hashedPassword, mustChangePassword: false },
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
}

/** Constant-time comparison of two hex digests (false on any length mismatch). */
function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
