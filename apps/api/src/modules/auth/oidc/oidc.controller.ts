/**
 * OIDC login + callback for enterprise SSO. Phase 1 covers Microsoft
 * Entra ID; Google is stubbed to a 501 until P2.
 *
 * Flow (Microsoft):
 *   GET /auth/oidc/microsoft/login
 *     → load enabled OrgAuthConfig for provider='microsoft' (404 if
 *       none). Generate state + nonce + PKCE verifier, stash them in
 *       a short-lived signed httpOnly cookie scoped to the callback
 *       path, then 302 to Entra's authorize URL.
 *
 *   GET /auth/oidc/microsoft/callback
 *     → validate the cookie is present and matches, run the code
 *       exchange (openid-client verifies ID-token iss/aud/exp/nonce +
 *       JWKS signature). Extract oid/email/name/tid. resolveUser()
 *       links or JIT-creates the User row. Then mint the SAME app
 *       JWT + refresh cookie that /auth/login issues — nothing
 *       downstream cares that the auth channel was SSO.
 *
 *   GET /auth/oidc/providers  (public)
 *     → tiny list the login page consumes to decide which
 *       Sign-in-with-X buttons to render. Contains {provider, enabled}
 *       only — no tenant ids, no secrets.
 *
 * Callback is throttled to 10 req/min per IP so a stuck client can't
 * hammer the token endpoint. State/nonce/PKCE are strictly enforced;
 * a missing cookie yields a 400 rather than silently accepting the
 * response.
 */

import { BadRequestException, Controller, Get, HttpCode, HttpStatus, Logger, NotFoundException, Param, Req, Res, UseGuards, HttpException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Request, Response } from 'express';
import * as oidc from 'openid-client';

import { PrismaService } from '../../../prisma/prisma.service';
import { SecretCryptoService } from '../../../common/services/secret-crypto.service';
import { ActivityLogService } from '../../../common/services/activity-log.service';
import { AuthService } from '../auth.service';
import { OidcUserResolverService } from './oidc-user-resolver.service';
import { SsoAdminService } from '../../sso-admin/sso-admin.service';
import { setSignedFlowCookie, readSignedFlowCookie, clearFlowCookie, OidcFlowState } from './oidc-flow-cookie.util';

@ApiTags('Auth - OIDC')
@Controller('auth/oidc')
export class OidcController {
  private readonly log = new Logger(OidcController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
    private readonly activity: ActivityLogService,
    private readonly auth: AuthService,
    private readonly resolver: OidcUserResolverService,
    private readonly ssoAdmin: SsoAdminService,
  ) {}

  // ─── Public providers list — no auth required ─────────────────────

  @Get('providers')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Public list of provider enabled-state for the login page' })
  async providers() {
    const rows = await this.prisma.orgAuthConfig.findMany({
      select: { provider: true, enabled: true },
      orderBy: { provider: 'asc' },
    });
    return rows;
  }

  // ─── Microsoft — authorize kickoff ────────────────────────────────

  @Get('microsoft/login')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Start the Microsoft SSO redirect flow' })
  async microsoftLogin(@Req() req: Request, @Res() res: Response) {
    const provider = 'microsoft';
    const row = await this.prisma.orgAuthConfig.findFirst({
      where: { organizationId: null, provider, enabled: true },
    });
    if (!row) {
      throw new NotFoundException('Microsoft SSO is not enabled for this organization.');
    }

    const clientSecret = this.crypto.decrypt({
      ciphertext: row.secretCiphertext,
      iv: row.secretIv,
      tag: row.secretTag,
      keyVersion: row.keyVersion,
    });
    const issuerUrl = this.ssoAdmin.issuerUrlFor(provider, row.tenantId);
    const config = await oidc.discovery(new URL(issuerUrl), row.clientId, clientSecret);

    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

    const redirectUri = this.callbackUrl(req, provider);

    const authUrl = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      response_mode: 'query',
      response_type: 'code',
      prompt: 'select_account',
    });

    // Persist state + nonce + PKCE verifier in a short-lived signed
    // cookie scoped to the callback path so it doesn't hang around
    // on unrelated requests. 5-minute lifetime is comfortably longer
    // than a normal IdP round-trip and shorter than any casual
    // browser-back window.
    const flow: OidcFlowState = { state, nonce, codeVerifier, provider, redirectUri, createdAt: Date.now() };
    setSignedFlowCookie(res, flow, provider);

    res.redirect(302, authUrl.toString());
  }

  // ─── Microsoft — callback ─────────────────────────────────────────

  @Get('microsoft/callback')
  @UseGuards(ThrottlerGuard)
  // Rate-limit the callback so a stuck client / bot can't hammer the
  // token endpoint. Chose 10/min per IP as a conservative default —
  // a legit user hits this once per SSO login.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Microsoft SSO callback — exchange code, resolve user, mint JWT.' })
  async microsoftCallback(@Req() req: Request, @Res() res: Response) {
    const provider = 'microsoft';
    let flow: OidcFlowState | null = null;
    try {
      flow = readSignedFlowCookie(req, provider);
    } catch (err: any) {
      this.log.warn(`oidc callback rejected — bad flow cookie: ${err?.message}`);
      throw new BadRequestException('Invalid or expired SSO session. Please start again.');
    }
    if (!flow) {
      throw new BadRequestException('Missing SSO session. Please start again from the login page.');
    }
    clearFlowCookie(res, provider);

    const row = await this.prisma.orgAuthConfig.findFirst({
      where: { organizationId: null, provider, enabled: true },
    });
    if (!row) {
      throw new NotFoundException('Microsoft SSO is not enabled for this organization.');
    }

    const clientSecret = this.crypto.decrypt({
      ciphertext: row.secretCiphertext,
      iv: row.secretIv,
      tag: row.secretTag,
      keyVersion: row.keyVersion,
    });
    const issuerUrl = this.ssoAdmin.issuerUrlFor(provider, row.tenantId);
    const config = await oidc.discovery(new URL(issuerUrl), row.clientId, clientSecret);

    // Build the "current URL" as openid-client expects it — the URL
    // the AS redirected the browser to. We reconstruct from the
    // request so the state/nonce validators can compare directly.
    const currentUrl = new URL(this.callbackUrl(req, provider));
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === 'string') currentUrl.searchParams.set(k, v);
    }

    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        pkceCodeVerifier: flow.codeVerifier,
        // Force ID token presence — Entra returns one for the openid
        // scope, but be explicit.
        idTokenExpected: true,
      });
    } catch (err: any) {
      this.log.warn(`OIDC code-exchange failed: ${err?.message}`);
      throw new BadRequestException('SSO login failed. Please try again.');
    }

    const claims = tokens.claims();
    if (!claims) {
      throw new BadRequestException('SSO login failed — no ID token in response.');
    }

    // Entra's oid claim is the stable user object id. The `sub` claim
    // is app-specific (differs per client_id) and NOT safe as a
    // cross-app identifier. We prefer oid for microsoft and fall back
    // to sub only if oid is missing (won't happen for Entra work
    // accounts — belt and braces).
    const subject = (claims.oid as string | undefined) ?? claims.sub;
    const email = (claims.email as string | undefined) ?? (claims.preferred_username as string | undefined) ?? null;
    // Entra returns email_verified only for personal (MSA) accounts;
    // for work/school accounts a work email in preferred_username is
    // considered verified by the tenant, so we accept it as verified
    // when the tenant matches the configured tid.
    const tenantIdInClaim = claims.tid as string | undefined;
    const tenantMatches = !!tenantIdInClaim && tenantIdInClaim === row.tenantId;
    const emailVerified = tenantMatches || claims.email_verified === true;
    const name = (claims.name as string | undefined) ?? null;

    let resolved;
    try {
      resolved = await this.resolver.resolveUser({
        provider: 'microsoft',
        subject,
        email,
        emailVerified,
        name,
        allowedDomainsCsv: row.allowedDomains,
        defaultRoleId: row.defaultRoleId,
      });
    } catch (err: any) {
      // Audit the failed attempt so admins can see rejected domains.
      await this.activity.write({
        category: 'auth',
        action: 'sso.login.rejected',
        entityType: 'user_identity',
        entityName: email ?? subject,
        description: `SSO login rejected: ${err?.message ?? 'unknown reason'}`,
        actorUserId: null,
        ipAddress: this.ipOf(req),
        metadata: { provider, email, subject: subject?.slice(0, 8) + '…' },
      });
      throw err instanceof HttpException ? err : new BadRequestException('SSO login failed.');
    }

    // Mint the SAME app JWT + refresh cookie the password path uses.
    const result = await this.auth.login(resolved.user);

    // Audit the successful login.
    await this.activity.write({
      category: 'auth',
      action: 'sso.login',
      entityType: 'user',
      entityId: resolved.user.id,
      entityName: resolved.user.email,
      description: `SSO login via ${provider}${resolved.wasCreated ? ' (JIT-created)' : resolved.wasLinked ? ' (linked existing user)' : ''}`,
      actorUserId: resolved.user.id,
      ipAddress: this.ipOf(req),
      metadata: { provider, wasCreated: resolved.wasCreated, wasLinked: resolved.wasLinked },
    });

    res.cookie('refresh_token', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    // 302 to the post-login URL. If APP_POST_LOGIN_URL isn't set, fall
    // back to the frontend origin — better than an empty redirect.
    // The access token rides in the URL fragment ONLY so it never
    // hits the server logs or the Referer header. The frontend
    // hydrates from window.location.hash on landing.
    const target = process.env.APP_POST_LOGIN_URL || 'http://localhost:5173/';
    const dst = new URL(target);
    dst.hash = `access_token=${encodeURIComponent(result.accessToken)}`;
    res.redirect(302, dst.toString());
  }

  // ─── Google — not yet implemented ──────────────────────────────────

  @Get(':provider/login')
  @ApiOperation({ summary: 'Fallback for unsupported providers' })
  async unsupportedLogin(@Param('provider') provider: string) {
    throw new NotFoundException(`SSO provider "${provider}" is not supported at this time.`);
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private callbackUrl(req: Request, provider: string): string {
    // Prefer API_URL from env so the redirect_uri exactly matches
    // what the admin registered with the IdP — reconstructing from
    // the request headers is unreliable behind a proxy.
    const base = process.env.API_URL?.replace(/\/$/, '');
    if (base) return `${base}/api/v1/auth/oidc/${provider}/callback`;
    // Fallback: reconstruct from the request. Uses x-forwarded-proto
    // + host when present so it works behind Railway / Fly / any TLS
    // terminator.
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] || req.protocol;
    const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0] || req.headers.host;
    return `${proto}://${host}/api/v1/auth/oidc/${provider}/callback`;
  }

  private ipOf(req: Request): string | null {
    const raw = req.headers['x-forwarded-for'];
    if (typeof raw === 'string') return raw.split(',')[0]?.trim() || null;
    return req.ip ?? null;
  }
}
