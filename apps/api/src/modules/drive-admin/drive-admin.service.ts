/**
 * Google Drive admin service — CRUD + test surface for OrgDriveConfig.
 *
 * The service-account JSON key is write-only across every API surface:
 * it comes in on PUT, gets JSON-validated, encrypted via
 * SecretCryptoService, and stored; GET returns { hasKey, keyHint } but
 * NEVER the plaintext. `keyHint` is derived from the CIPHERTEXT so it
 * can be rendered without decryption and cannot leak the tail of the
 * real key.
 *
 * `test` decrypts the SA key, authenticates as the service account,
 * and verifies the configured Shared Drive is reachable via
 * drive.drives.get. Never returns the key. Never logs it.
 *
 * IMPORTANT INVARIANT (Google permission model):
 *   Nothing in this module or its downstream service (DriveService)
 *   calls Google's permissions.* API. User access to files is
 *   controlled by the customer's Shared-Drive membership on the
 *   Google side; Planwise merely uses the service account to create
 *   folders and read metadata inside that Shared Drive.
 *
 * Every mutation + the test call is audited via ActivityLog. The
 * key VALUE is NEVER passed to the audit log — only booleans and
 * metadata.
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { google } from 'googleapis';

import { PrismaService } from '../../prisma/prisma.service';
import { SecretCryptoService } from '../../common/services/secret-crypto.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import type { UpsertDriveConfigDto } from './dto/upsert-drive-config.dto';

/** Shape returned to the admin UI. No SA key bytes, ever. */
export interface DriveConfigView {
  enabled: boolean;
  sharedDriveId: string;
  rootFolderId: string | null;
  hasKey: boolean;
  keyHint: string | null;
  keyVersion: number;
  updatedAt: Date | null;
}

/** Result of test-connection — kept small; NEVER include raw metadata. */
export interface DriveTestResult {
  ok: boolean;
  driveName?: string;
  driveId?: string;
  error?: string;
}

@Injectable()
export class DriveAdminService {
  private readonly log = new Logger(DriveAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
    private readonly activity: ActivityLogService,
  ) {}

  // ─── Serialization ─────────────────────────────────────────────────

  private toView(row: {
    enabled: boolean;
    sharedDriveId: string;
    rootFolderId: string | null;
    saCiphertext: Buffer;
    keyVersion: number;
    updatedAt: Date;
  } | null): DriveConfigView {
    if (!row) {
      // Default view when nothing is configured yet — lets the UI render
      // the empty form without an extra branch.
      return {
        enabled: false,
        sharedDriveId: '',
        rootFolderId: null,
        hasKey: false,
        keyHint: null,
        keyVersion: 0,
        updatedAt: null,
      };
    }
    const hasKey = !!row.saCiphertext && row.saCiphertext.length > 0;
    return {
      enabled: row.enabled,
      sharedDriveId: row.sharedDriveId,
      rootFolderId: row.rootFolderId,
      hasKey,
      // Fingerprint = last 4 hex chars of sha256(ciphertext). Safe to
      // display and stable across restarts. See SecretCryptoService.
      keyHint: hasKey ? `•••${this.crypto.fingerprint(row.saCiphertext)}` : null,
      keyVersion: row.keyVersion,
      updatedAt: row.updatedAt,
    };
  }

  // ─── Reads ─────────────────────────────────────────────────────────

  private async getRow() {
    // Single-company at P1 — organizationId is null. Matches
    // OrgAuthConfig lookup convention. When the multi-tenant model
    // arrives, this widens to a resolver.
    return this.prisma.orgDriveConfig.findFirst({ where: { organizationId: null } });
  }

  async get(): Promise<DriveConfigView> {
    const row = await this.getRow();
    return this.toView(row);
  }

  // ─── Writes ────────────────────────────────────────────────────────

  async upsert(
    dto: UpsertDriveConfigDto,
    actorUserId: number,
    ipAddress: string | null,
  ): Promise<DriveConfigView> {
    if (!dto.sharedDriveId || dto.sharedDriveId.trim().length === 0) {
      throw new BadRequestException('sharedDriveId is required.');
    }

    const existing = await this.getRow();

    // Only re-encrypt when a non-empty key was supplied. This is the
    // mechanism that lets the admin UI edit the other fields (Shared
    // Drive id, root folder, enabled) without knowing the current key.
    const rotateKey = typeof dto.serviceAccountKey === 'string' && dto.serviceAccountKey.length > 0;
    let encFields: {
      saCiphertext: Buffer;
      saIv: Buffer;
      saTag: Buffer;
      keyVersion: number;
    } | null = null;
    if (rotateKey) {
      // Reject non-JSON up front so a broken paste doesn't get
      // encrypted and stored — decryption would succeed later but the
      // Google client would blow up on shape.
      try {
        const parsed = JSON.parse(dto.serviceAccountKey!);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
          throw new Error('missing client_email or private_key');
        }
      } catch (err: any) {
        throw new BadRequestException(
          `serviceAccountKey is not a valid Google service-account JSON: ${err?.message ?? String(err)}`,
        );
      }
      const enc = this.crypto.encrypt(dto.serviceAccountKey!);
      encFields = {
        saCiphertext: enc.ciphertext,
        saIv: enc.iv,
        saTag: enc.tag,
        keyVersion: enc.keyVersion,
      };
    }

    const sharedDriveId = dto.sharedDriveId.trim();
    const rootFolderId = dto.rootFolderId?.trim() || null;

    if (!existing) {
      if (!encFields) {
        // Create — SA key is required on first save (there's nothing to
        // preserve). Rejects with 400 rather than a Prisma NOT NULL
        // error on the Bytes column.
        throw new BadRequestException(
          'Service-account JSON key is required when creating a new Google Drive configuration.',
        );
      }
      const created = await this.prisma.orgDriveConfig.create({
        data: {
          organizationId: null,
          enabled: dto.enabled ?? false,
          sharedDriveId,
          rootFolderId,
          updatedBy: actorUserId,
          ...encFields,
        },
      });
      await this.audit(actorUserId, ipAddress, 'drive.config.updated', {
        created: true,
        rotatedKey: true,
        enabled: created.enabled,
        sharedDriveIdSet: true,
        rootFolderIdSet: !!rootFolderId,
      });
      return this.toView(created);
    }

    const updated = await this.prisma.orgDriveConfig.update({
      where: { id: existing.id },
      data: {
        enabled: dto.enabled ?? existing.enabled,
        sharedDriveId,
        rootFolderId,
        updatedBy: actorUserId,
        ...(encFields ?? {}),
      },
    });
    await this.audit(actorUserId, ipAddress, 'drive.config.updated', {
      created: false,
      rotatedKey: rotateKey,
      enabled: updated.enabled,
      sharedDriveIdSet: true,
      rootFolderIdSet: !!rootFolderId,
    });
    return this.toView(updated);
  }

  async setEnabled(
    enabled: boolean,
    actorUserId: number,
    ipAddress: string | null,
  ): Promise<DriveConfigView> {
    const row = await this.getRow();
    if (!row) throw new NotFoundException('No Google Drive configuration exists yet.');
    const updated = await this.prisma.orgDriveConfig.update({
      where: { id: row.id },
      data: { enabled, updatedBy: actorUserId },
    });
    await this.audit(
      actorUserId,
      ipAddress,
      enabled ? 'drive.config.enabled' : 'drive.config.disabled',
      { enabled },
    );
    return this.toView(updated);
  }

  // ─── Test connection ───────────────────────────────────────────────

  /**
   * "Test connection" — decrypt the stored SA key, authenticate as the
   * service account, and verify the configured Shared Drive is
   * reachable. Uses drive.drives.get with supportsAllDrives:true to
   * both authenticate the SA and confirm the Shared Drive id.
   *
   * Never returns the key. Never logs it. Errors are stringified into
   * a human-readable line for the UI.
   */
  async test(
    actorUserId: number,
    ipAddress: string | null,
  ): Promise<DriveTestResult> {
    const row = await this.getRow();
    if (!row) throw new NotFoundException('No Google Drive configuration exists yet.');

    let result: DriveTestResult;
    try {
      const saJson = this.crypto.decrypt({
        ciphertext: row.saCiphertext,
        iv: row.saIv,
        tag: row.saTag,
        keyVersion: row.keyVersion,
      });
      const credentials = JSON.parse(saJson);
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive'],
      });
      const drive = google.drive({ version: 'v3', auth });
      // drives.get validates: (a) the SA credentials work, (b) the
      // Shared Drive exists, (c) the SA has been added to it. Perfect
      // one-shot health check for the "Test connection" button.
      const { data } = await drive.drives.get({
        driveId: row.sharedDriveId,
        // drive.drives.get does NOT accept supportsAllDrives (per
        // googleapis' typedef) — the call is already scoped to a
        // single Shared Drive by the driveId. The "every drive.*
        // call passes supportsAllDrives:true" invariant applies to
        // drive.files.* only, where it toggles cross-drive access.
      });
      result = {
        ok: true,
        driveId: data.id ?? row.sharedDriveId,
        driveName: data.name ?? '(unnamed)',
      };
    } catch (err: any) {
      // Google errors nest the useful line in .errors[0].message or
      // .response.data.error.message. Fall back to .message so we
      // always have something to show.
      const msg =
        err?.errors?.[0]?.message ??
        err?.response?.data?.error?.message ??
        err?.message ??
        String(err);
      result = { ok: false, error: String(msg) };
      this.log.warn(`Drive test failed: ${result.error}`);
    }

    await this.audit(actorUserId, ipAddress, 'drive.config.tested', {
      ok: result.ok,
      driveId: result.ok ? result.driveId : null,
      error: result.ok ? null : result.error,
    });
    return result;
  }

  // ─── Audit helper ──────────────────────────────────────────────────

  /**
   * NEVER pass the raw SA key or credentials into `metadata`. The
   * activity log is surfaced in the admin page and downstream
   * ingestion pipes; any value put here can end up in retention.
   */
  private async audit(
    actorUserId: number,
    ipAddress: string | null,
    action:
      | 'drive.config.updated'
      | 'drive.config.enabled'
      | 'drive.config.disabled'
      | 'drive.config.tested',
    metadata: Record<string, any>,
  ): Promise<void> {
    await this.activity.write({
      category: 'admin',
      action,
      entityType: 'org_drive_config',
      entityName: 'google-drive',
      description: `${action} for Google Drive integration`,
      actorUserId,
      ipAddress,
      metadata,
    });
  }
}
