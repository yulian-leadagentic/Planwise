import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';

import { PrismaService } from '../../prisma/prisma.service';
import { loadAuthenticatedUser, requireSecret } from '../../modules/auth/strategies/jwt.strategy';

export type WsAuthenticatedUser = NonNullable<Awaited<ReturnType<typeof loadAuthenticatedUser>>>;

/**
 * WebSocket handshake authentication (permissions round 1, 2026-11-20).
 *
 * The Socket.IO gateways used to trust `handshake.query.userId`, so any
 * client could connect as any user. They now call `authenticate()` on
 * connection:
 *   • the access token comes from `handshake.auth.token` (what the web
 *     client sends) or an `Authorization: Bearer …` handshake header —
 *     never from the query string, which ends up in proxy/access logs;
 *   • it is verified with the same secret the HTTP JwtStrategy uses
 *     (JWT_ACCESS_SECRET, expiry enforced, jsonwebtoken's default HS*
 *     algorithms — `none` is rejected);
 *   • the user is loaded with the strategy's own helper, so the
 *     active / not-deleted checks and the merged permission set
 *     (`isAdmin`, `roleModules`) are identical to an HTTP request.
 * Returns null on any failure; the gateway disconnects the socket.
 */
@Injectable()
export class WsAuthService {
  private readonly logger = new Logger(WsAuthService.name);
  private readonly secret: string;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.secret = requireSecret(config, 'JWT_ACCESS_SECRET');
  }

  extractToken(client: Pick<Socket, 'handshake'>): string | null {
    const handshake = client?.handshake;
    const fromAuth = (handshake?.auth as Record<string, unknown> | undefined)?.token;
    if (typeof fromAuth === 'string' && fromAuth.trim()) {
      return fromAuth.trim().replace(/^Bearer\s+/i, '');
    }
    const header = handshake?.headers?.authorization;
    if (typeof header === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      if (match && match[1].trim()) return match[1].trim();
    }
    return null;
  }

  async authenticate(client: Pick<Socket, 'handshake'>): Promise<WsAuthenticatedUser | null> {
    const token = this.extractToken(client);
    if (!token) return null;

    let payload: { sub?: unknown };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: this.secret, ignoreExpiration: false });
    } catch {
      return null;
    }

    const userId = Number(payload?.sub);
    if (!Number.isInteger(userId) || userId <= 0) return null;

    try {
      return await loadAuthenticatedUser(this.prisma, userId);
    } catch (err) {
      this.logger.warn(`ws auth user lookup failed: ${(err as Error).message}`);
      return null;
    }
  }
}
