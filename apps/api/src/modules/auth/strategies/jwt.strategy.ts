import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../../prisma/prisma.service';

function requireSecret(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value || value.length < 32) {
    throw new Error(`${key} must be set and at least 32 characters long`);
  }
  return value;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private prisma: PrismaService,
    configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireSecret(configService, 'JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: { sub: number; email: string; roleId: number }) {
    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, isActive: true },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        roleId: true,
        userType: true,
        avatarUrl: true,
        role: {
          include: {
            roleModules: { include: { module: true } },
          },
        },
        // §14 RBAC multi-role (2026-10-18) — load every granted role +
        // its role_modules so the request's effective permission set is
        // the OR union across them. The guard falls back to the legacy
        // `role.roleModules` list when `userRoles` is empty (zero-
        // downtime handover window — the backfill endpoint seeds
        // `user_roles` from `user.role_id`).
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
      throw new UnauthorizedException('User not found or inactive');
    }

    return attachMergedPermissions(user);
  }
}

/**
 * §14 RBAC multi-role · unified permission read (2026-10-18).
 *
 * Merges every row in `user.userRoles.role.roleModules` into a single
 * `roleModules` array keyed by moduleId with each flag ORed across the
 * granted roles. When `userRoles` is empty, falls back to the legacy
 * `user.role.roleModules` list — zero-downtime handover.
 *
 * Also exposes:
 *   • `roles: Array<{id, name}>` — the chip-rendering shape consumed
 *     by the FE (Admin UI shows the holder's roles beside the primary
 *     legacy chip);
 *   • `isAdmin: boolean` — true when ANY granted role is named
 *     'Admin'. Falls back to the legacy `role.name === 'Admin'` when
 *     `userRoles` is empty, same handover rule as above.
 *
 * Exported so `AuthService.login`, `getProfile`, and `impersonate` can
 * reuse the exact same merge logic — the three code paths that mint
 * `/auth/me`-shaped payloads MUST return the same `roleModules` array
 * the guard reads.
 */
export function attachMergedPermissions<T extends {
  role?: { name: string; roleModules: any[] } | null;
  userRoles?: Array<{
    role: { id: number; name: string; roleModules: any[] };
  }>;
}>(user: T): T & {
  roleModules: any[];
  roles: Array<{ id: number; name: string }>;
  isAdmin: boolean;
} {
  const userRoles = user.userRoles ?? [];
  const hasAnyGranted = userRoles.length > 0;

  // Merge roleModules by moduleId, ORing each flag.
  let mergedList: any[];
  if (hasAnyGranted) {
    const byModule = new Map<number, any>();
    for (const ur of userRoles) {
      for (const rm of ur.role.roleModules ?? []) {
        const prev = byModule.get(rm.moduleId);
        if (!prev) {
          // Clone so later ORs don't mutate the DB row's object.
          byModule.set(rm.moduleId, { ...rm });
        } else {
          prev.canRead    = prev.canRead    || rm.canRead;
          prev.canWrite   = prev.canWrite   || rm.canWrite;
          prev.canDelete  = prev.canDelete  || rm.canDelete;
          prev.canApprove = prev.canApprove || rm.canApprove;
          prev.canExport  = prev.canExport  || rm.canExport;
          // Keep the first module object we saw — all rows for the
          // same moduleId reference the same Module row anyway.
        }
      }
    }
    mergedList = Array.from(byModule.values());
  } else {
    mergedList = user.role?.roleModules ?? [];
  }

  const roles = hasAnyGranted
    ? userRoles.map((ur) => ({ id: ur.role.id, name: ur.role.name }))
    : user.role
      ? [{ id: (user.role as any).id ?? 0, name: user.role.name }]
      : [];

  const isAdmin = hasAnyGranted
    ? userRoles.some((ur) => ur.role.name === 'Admin')
    : user.role?.name === 'Admin';

  return {
    ...user,
    roleModules: mergedList,
    roles,
    isAdmin,
  };
}
