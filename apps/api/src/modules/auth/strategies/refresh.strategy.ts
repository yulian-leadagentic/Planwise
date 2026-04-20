import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

import { PrismaService } from '../../../prisma/prisma.service';

function requireSecret(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value || value.length < 32) {
    throw new Error(`${key} must be set and at least 32 characters long`);
  }
  return value;
}

@Injectable()
export class RefreshStrategy extends PassportStrategy(Strategy, 'refresh') {
  constructor(
    private prisma: PrismaService,
    configService: ConfigService,
  ) {
    super({
      jwtFromRequest: (req: Request) => {
        if (req && req.cookies) {
          return req.cookies['refresh_token'];
        }
        return null;
      },
      ignoreExpiration: false,
      secretOrKey: requireSecret(configService, 'JWT_REFRESH_SECRET'),
    });
  }

  async validate(payload: { sub: number; email: string; roleId: number }) {
    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, isActive: true },
      select: { id: true, email: true, roleId: true },
    });

    if (!user) {
      throw new UnauthorizedException('User not found or inactive');
    }

    return user;
  }
}
