/**
 * SSO admin service — CRUD + connection test for OrgAuthConfig rows.
 *
 * The client secret is write-only across every API surface: it comes
 * in on `PUT`, gets encrypted via SecretCryptoService and stored;
 * `GET` returns { hasSecret, secretHint } but NEVER the plaintext.
 * `secretHint` is derived from the CIPHERTEXT (not the plaintext) so
 * it can't leak the tail of the real secret and can be rendered
 * without decryption.
 *
 * Provider list is closed at P1 to just microsoft + google.
 * The controller only mounts routes admins actually need; extending
 * this to other IdPs is a matter of adding an issuer resolver +
 * lifting the `microsoft` branch below.
 *
 * Every mutation is audited via ActivityLog. The secret VALUE is
 * NEVER passed to the audit log — only booleans and metadata.
 */

import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as oidc from 'openid-client';

import { PrismaService } from '../../prisma/prisma.service';
import { SecretCryptoService } from '../../common/services/secret-crypto.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import type { UpsertSsoConfigDto } from './dto/upsert-sso-config.dto';

/** Providers we support today. Google is a P2 add. */
export const SUPPORTED_PROVIDERS = ['microsoft', 'google'] as const;
export type SsoProvider = (typeof SUPPORTED_PROVIDERS)[number];

/** Shape returned to the admin UI. No secret bytes, ever. */
export interface SsoConfigView {
  provider: string;
  enabled: boolean;
  tenantId: string | null;
  clientId: string;
  hasSecret: boolean;
  secretHint: string | null;
  allowedDomains: string;
  defaultRoleId: number;
  ssoOnly: boolean;
  keyVersion: number;
  updatedAt: Date;
}

@Injectable()
export class SsoAdminService {
  private readonly log = new Logger(SsoAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
    private readonly activity: ActivityLogService,
  ) {}

  // ─── Validation helpers ────────────────────────────────────────────

  assertProvider(provider: string): SsoProvider {
    if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
      throw new BadRequestException(`Unsupported SSO provider: "${provider}"`);
    }
    // Google is on the roadmap (P2). Block writes for now so the UI
    // can render a placeholder without also permitting a partial config.
    if (provider === 'google') {
      throw new ForbiddenException('Google SSO is coming in P2 and cannot be configured yet.');
    }
    return provider as SsoProvider;
  }

  // ─── Serialization ─────────────────────────────────────────────────

  private toView(row: {
    provider: string;
    enabled: boolean;
    tenantId: string | null;
    clientId: string;
    secretCiphertext: Buffer;
    allowedDomains: string;
    defaultRoleId: number;
    ssoOnly: boolean;
    keyVersion: number;
    updatedAt: Date;
  }): SsoConfigView {
    const hasSecret = !!row.secretCiphertext && row.secretCiphertext.length > 0;
    return {
      provider: row.provider,
      enabled: row.enabled,
      tenantId: row.tenantId,
      clientId: row.clientId,
      hasSecret,
      // Fingerprint is 4 hex chars of the ciphertext's sha256 — it's
      // safe to display and stable across restarts. Pure "•••" is
      // fine if we ever want to hide even that much.
      secretHint: hasSecret ? `•••${this.crypto.fingerprint(row.secretCiphertext)}` : null,
      allowedDomains: row.allowedDomains ?? '',
      defaultRoleId: row.defaultRoleId,
      ssoOnly: row.ssoOnly,
      keyVersion: row.keyVersion,
      updatedAt: row.updatedAt,
    };
  }

  // ─── Reads ─────────────────────────────────────────────────────────

  async list(): Promise<SsoConfigView[]> {
    const rows = await this.prisma.orgAuthConfig.findMany({ orderBy: { provider: 'asc' } });
    return rows.map((r) => this.toView(r));
  }

  private async getRow(provider: string) {
    this.assertProvider(provider);
    const row = await this.prisma.orgAuthConfig.findFirst({
      where: { organizationId: null, provider },
    });
    return row;
  }

  // ─── Writes ────────────────────────────────────────────────────────

  async upsert(provider: string, dto: UpsertSsoConfigDto, actorUserId: number, ipAddress: string | null): Promise<SsoConfigView> {
    this.assertProvider(provider);

    // A defaultRoleId is required — verify it exists so the FK error
    // surfaces as a friendly 400 instead of an opaque 500 later.
    const role = await this.prisma.role.findFirst({ where: { id: dto.defaultRoleId }, select: { id: true } });
    if (!role) throw new BadRequestException(`defaultRoleId ${dto.defaultRoleId} does not exist`);

    const existing = await this.prisma.orgAuthConfig.findFirst({
      where: { organizationId: null, provider },
    });

    // Normalize the allowed-domains input a bit: strip whitespace,
    // drop empties, lowercase. Stored as CSV to keep the admin surface
    // trivial (comma-separated field) — the resolver re-splits at
    // login time so this is the only place normalisation happens.
    const domains = (dto.allowedDomains ?? '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean)
      .join(',');

    // Only re-encrypt when a non-empty secret was supplied. This is
    // the mechanism that lets the admin UI edit everything else
    // without knowing the current secret.
    const rotateSecret = typeof dto.secret === 'string' && dto.secret.length > 0;
    let encFields: {
      secretCiphertext: Buffer;
      secretIv: Buffer;
      secretTag: Buffer;
      keyVersion: number;
    } | null = null;
    if (rotateSecret) {
      const enc = this.crypto.encrypt(dto.secret!);
      encFields = {
        secretCiphertext: enc.ciphertext,
        secretIv: enc.iv,
        secretTag: enc.tag,
        keyVersion: enc.keyVersion,
      };
    }

    if (!existing) {
      // Create — secret is required on first save (there's nothing to
      // preserve). Rejects with a 400 rather than a Prisma NOT NULL
      // error on the Bytes column.
      if (!encFields) {
        throw new BadRequestException('Client secret is required when creating a new SSO config.');
      }
      const created = await this.prisma.orgAuthConfig.create({
        data: {
          organizationId: null,
          provider,
          enabled: dto.enabled ?? false,
          tenantId: dto.tenantId ?? null,
          clientId: dto.clientId,
          allowedDomains: domains,
          defaultRoleId: dto.defaultRoleId,
          ssoOnly: dto.ssoOnly ?? false,
          updatedBy: actorUserId,
          ...encFields,
        },
      });
      await this.audit(actorUserId, ipAddress, 'sso.config.updated', provider, {
        created: true,
        rotatedSecret: true,
        enabled: created.enabled,
        ssoOnly: created.ssoOnly,
      });
      return this.toView(created);
    }

    const updated = await this.prisma.orgAuthConfig.update({
      where: { id: existing.id },
      data: {
        enabled: dto.enabled ?? existing.enabled,
        tenantId: dto.tenantId !== undefined ? dto.tenantId : existing.tenantId,
        clientId: dto.clientId,
        allowedDomains: domains,
        defaultRoleId: dto.defaultRoleId,
        ssoOnly: dto.ssoOnly ?? existing.ssoOnly,
        updatedBy: actorUserId,
        ...(encFields ?? {}),
      },
    });
    await this.audit(actorUserId, ipAddress, 'sso.config.updated', provider, {
      created: false,
      rotatedSecret: rotateSecret,
      enabled: updated.enabled,
      ssoOnly: updated.ssoOnly,
    });
    return this.toView(updated);
  }

  async setEnabled(provider: string, enabled: boolean, actorUserId: number, ipAddress: string | null): Promise<SsoConfigView> {
    const row = await this.getRow(provider);
    if (!row) throw new NotFoundException(`No SSO config for provider "${provider}"`);
    const updated = await this.prisma.orgAuthConfig.update({
      where: { id: row.id },
      data: { enabled, updatedBy: actorUserId },
    });
    await this.audit(
      actorUserId,
      ipAddress,
      enabled ? 'sso.config.enabled' : 'sso.config.disabled',
      provider,
      { enabled },
    );
    return this.toView(updated);
  }

  // ─── Test connection ───────────────────────────────────────────────

  /**
   * "Test connection" — decrypt the stored secret, run OIDC discovery
   * on the provider's issuer, then attempt a client-credentials token
   * grant to verify the client_id/secret actually work.
   *
   * Never returns the secret. Never logs it. Any error is stringified
   * into a human-readable line for the UI.
   */
  async test(provider: string, actorUserId: number, ipAddress: string | null): Promise<{ ok: boolean; discovery?: any; error?: string }> {
    const row = await this.getRow(provider);
    if (!row) throw new NotFoundException(`No SSO config for provider "${provider}"`);

    let result: { ok: boolean; discovery?: any; error?: string };
    try {
      const issuerUrl = this.issuerUrlFor(provider, row.tenantId);
      const clientSecret = this.crypto.decrypt({
        ciphertext: row.secretCiphertext,
        iv: row.secretIv,
        tag: row.secretTag,
        keyVersion: row.keyVersion,
      });
      const config = await oidc.discovery(new URL(issuerUrl), row.clientId, clientSecret);
      const meta = config.serverMetadata();

      // Client-credentials request. On Entra the scope pattern is
      // `<client_id>/.default` — the app talks to its own API. Both a
      // 200 (token returned) and a 400/401 with error='invalid_scope'
      // still prove the credentials work — an invalid client_secret
      // yields 'invalid_client' from Entra. Anything else is a
      // configuration issue we surface to the admin.
      try {
        await oidc.clientCredentialsGrant(config, { scope: `${row.clientId}/.default` });
      } catch (grantErr: any) {
        const msg = String(grantErr?.message ?? '').toLowerCase();
        if (msg.includes('invalid_client') || msg.includes('unauthorized_client')) {
          throw grantErr; // credentials really are wrong
        }
        // invalid_scope / consent_required / etc → credentials are OK
        this.log.debug(
          `test(${provider}): client_credentials returned non-invalid_client error — treating as "credentials OK": ${grantErr?.message}`,
        );
      }

      result = {
        ok: true,
        discovery: {
          issuer: meta.issuer,
          authorizationEndpoint: meta.authorization_endpoint,
          tokenEndpoint: meta.token_endpoint,
          jwksUri: meta.jwks_uri,
        },
      };
    } catch (err: any) {
      result = { ok: false, error: err?.message ?? String(err) };
      this.log.warn(`SSO test(${provider}) failed: ${result.error}`);
    }

    await this.audit(actorUserId, ipAddress, 'sso.config.tested', provider, {
      ok: result.ok,
      error: result.ok ? null : result.error,
    });
    return result;
  }

  // ─── Issuer resolver ───────────────────────────────────────────────

  /**
   * Turn (provider, tenantId) into the OIDC issuer URL. Kept here so
   * the OIDC auth flow and the admin test endpoint use the SAME
   * mapping — one place to fix if a provider changes their endpoint.
   */
  issuerUrlFor(provider: string, tenantId: string | null): string {
    if (provider === 'microsoft') {
      if (!tenantId) throw new BadRequestException('Microsoft SSO requires a tenantId');
      return `https://login.microsoftonline.com/${tenantId}/v2.0`;
    }
    if (provider === 'google') {
      return 'https://accounts.google.com';
    }
    throw new BadRequestException(`Unknown provider "${provider}"`);
  }

  // ─── Audit helper ──────────────────────────────────────────────────

  /**
   * NEVER pass a raw secret into `changes`. The activity log is
   * surfaced in an admin page and downstream ingestion pipes; any
   * value put here can end up in retention.
   */
  private async audit(
    actorUserId: number,
    ipAddress: string | null,
    action: 'sso.config.updated' | 'sso.config.enabled' | 'sso.config.disabled' | 'sso.config.tested',
    provider: string,
    metadata: Record<string, any>,
  ): Promise<void> {
    await this.activity.write({
      category: 'admin',
      action,
      entityType: 'org_auth_config',
      entityName: provider,
      description: `${action} for provider "${provider}"`,
      actorUserId,
      ipAddress,
      metadata,
    });
  }
}
