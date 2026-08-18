/**
 * DriveService — Google Drive integration primitives.
 *
 * Scope: create + look up folders inside the customer's configured
 * Shared Drive, and attach existing Drive files (by URL or fileId)
 * to Planwise records. All operations are read/write of METADATA and
 * FOLDER structure; Planwise NEVER touches file contents.
 *
 * Locked security invariants — do NOT relax without an ADR:
 *   1. Every drive.files.* / drive.drives.* call passes
 *      `supportsAllDrives: true`. List operations additionally pass
 *      `includeItemsFromAllDrives: true` + `corpora: 'drive'`. Missing
 *      any of these makes the SA return empty results for a Shared
 *      Drive and silently misbehaves.
 *   2. Every operation is scoped to the configured Shared Drive id.
 *      Absolutely nothing here operates on My Drive or another Shared
 *      Drive.
 *   3. NO call to drive.permissions.create|update|delete anywhere.
 *      Access is governed on the Google side by Shared-Drive
 *      membership. If you find yourself reaching for permissions.*,
 *      you're solving the wrong problem — talk to the customer's
 *      Workspace admin about who's on the Shared Drive.
 *
 * Concurrency: ensureFolder for the same (entityType, entityId) can
 * fire from two requests simultaneously (e.g. a user double-clicks
 * "Open in Drive"). A per-key in-process mutex serialises the
 * search-then-create so we never end up with duplicate folders. The
 * `drive_folder_links` unique index is the ultimate backstop.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { google, drive_v3 } from 'googleapis';

import { PrismaService } from '../../prisma/prisma.service';
import { SecretCryptoService } from '../../common/services/secret-crypto.service';
import { DriveFileNotAccessibleException, DriveNotConfiguredException } from './drive.exceptions';

/** Folder mimeType constant — Drive's magic string for "this is a folder". */
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Config cache TTL. Short — an admin toggling `enabled` should take
 *  effect within a few seconds without a process restart. Long
 *  enough to save a DB hit on every folder ensure during a busy
 *  planning session. */
const CONFIG_CACHE_MS = 15_000;

/** Public shape returned by folder-ensure calls. */
export interface DriveFolderRef {
  folderId: string;
  webViewLink: string | null;
}

/** Public shape returned by attach-by-URL. */
export interface DriveFileRef {
  fileId: string;
  name: string;
  mimeType: string | null;
  webViewLink: string | null;
}

/** Loaded + resolved config, kept in cache. */
interface LoadedConfig {
  enabled: boolean;
  sharedDriveId: string;
  rootFolderId: string | null;
  saJson: string;
}

@Injectable()
export class DriveService {
  private readonly log = new Logger(DriveService.name);

  /** TTL cache of the decrypted config. Cleared on config change is
   *  future work; the 15s TTL covers admin toggles for now. */
  private configCache: { loadedAt: number; config: LoadedConfig } | null = null;

  /** Cache of the auth'd Drive client — cheap to build but reusing
   *  keeps the OAuth2 token pool warm. Invalidated with the config. */
  private driveClient: drive_v3.Drive | null = null;

  /** Per-key mutex so simultaneous ensureFolder calls for the same
   *  (entityType, entityId) serialise into ONE search-then-create.
   *  Keyed by `${entityType}:${entityId}`. */
  private readonly folderLocks = new Map<string, Promise<DriveFolderRef>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
  ) {}

  // ─── Config ────────────────────────────────────────────────────────

  /**
   * Return `{ enabled, configured }` for the current Drive config without
   * throwing. `configured` = a row exists; `enabled` = row exists AND its
   * `enabled` toggle is true. Reads through the same short-lived cache
   * `loadConfig()` populates so a hot page render doesn't hammer the DB.
   *
   * Never returns the SA key, Shared Drive id, or any other secret — the
   * point of the public status endpoint is a boolean the client can gate
   * UI on, not enough to reconstruct any config field.
   */
  async getStatus(): Promise<{ enabled: boolean; configured: boolean }> {
    // Fast path: hot cache says config is loaded + enabled.
    const now = Date.now();
    if (this.configCache && now - this.configCache.loadedAt < CONFIG_CACHE_MS) {
      return { enabled: this.configCache.config.enabled, configured: true };
    }
    // Slow path: cache miss. Read only the tiny row shape we need — do
    // NOT touch saCiphertext / iv / tag; there's no reason to pull
    // encrypted secrets across the wire for a status probe.
    const row = await this.prisma.orgDriveConfig.findFirst({
      where: { organizationId: null },
      select: { enabled: true },
    });
    if (!row) return { enabled: false, configured: false };
    return { enabled: row.enabled, configured: true };
  }

  /** Load + decrypt the config. Throws DriveNotConfiguredException
   *  when nothing is set up OR `enabled` is false. Caching keeps the
   *  hot path off the DB during a request burst. */
  private async loadConfig(): Promise<LoadedConfig> {
    const now = Date.now();
    if (this.configCache && now - this.configCache.loadedAt < CONFIG_CACHE_MS) {
      return this.configCache.config;
    }
    const row = await this.prisma.orgDriveConfig.findFirst({
      where: { organizationId: null },
    });
    if (!row) throw new DriveNotConfiguredException();
    if (!row.enabled) {
      throw new DriveNotConfiguredException(
        'Google Drive integration is disabled by the administrator.',
      );
    }
    const saJson = this.crypto.decrypt({
      ciphertext: row.saCiphertext,
      iv: row.saIv,
      tag: row.saTag,
      keyVersion: row.keyVersion,
    });
    const config: LoadedConfig = {
      enabled: row.enabled,
      sharedDriveId: row.sharedDriveId,
      rootFolderId: row.rootFolderId,
      saJson,
    };
    this.configCache = { loadedAt: now, config };
    // Drop the cached client whenever we reload the config so an
    // admin key rotation propagates without a process restart.
    this.driveClient = null;
    return config;
  }

  /** Get an authenticated Drive v3 client. Uses the service account
   *  directly (no domain-wide delegation, no user impersonation). */
  private async getDrive(): Promise<{ drive: drive_v3.Drive; config: LoadedConfig }> {
    const config = await this.loadConfig();
    if (this.driveClient) return { drive: this.driveClient, config };
    const credentials = JSON.parse(config.saJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    this.driveClient = google.drive({ version: 'v3', auth });
    return { drive: this.driveClient, config };
  }

  // ─── Folder helpers ────────────────────────────────────────────────

  /** Search inside the Shared Drive (bounded to `parentId`) for a
   *  folder with the given name. Returns the first match's id, or
   *  null. Kept small so ensureFolder can compose it. */
  private async findChildFolder(
    drive: drive_v3.Drive,
    sharedDriveId: string,
    parentId: string,
    name: string,
  ): Promise<{ id: string; webViewLink: string | null } | null> {
    // Escape single quotes for the Drive `q` string. Google's parser
    // uses backslash-quote for escaping.
    const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = `'${parentId}' in parents and name = '${safeName}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const { data } = await drive.files.list({
      q,
      driveId: sharedDriveId,
      corpora: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: 'files(id, webViewLink)',
      pageSize: 5,
    });
    const first = data.files?.[0];
    if (!first?.id) return null;
    return { id: first.id, webViewLink: first.webViewLink ?? null };
  }

  /** Create a folder inside `parentId`. Returns the new id + webViewLink. */
  private async createFolder(
    drive: drive_v3.Drive,
    parentId: string,
    name: string,
  ): Promise<{ id: string; webViewLink: string | null }> {
    const { data } = await drive.files.create({
      requestBody: {
        name,
        mimeType: FOLDER_MIME,
        parents: [parentId],
      },
      fields: 'id, webViewLink',
      supportsAllDrives: true,
    });
    if (!data.id) throw new Error('Drive.files.create returned no id');
    return { id: data.id, webViewLink: data.webViewLink ?? null };
  }

  /** Core ensure — check DB link, else search Drive, else create.
   *  Wrapped by the mutex from `ensureFolder`. */
  private async ensureFolderInner(
    entityType: 'project' | 'zone' | 'deliverable',
    entityId: number,
    parentId: string,
    folderName: string,
  ): Promise<DriveFolderRef> {
    // Step 1: DB cache. The unique index on (entityType, entityId)
    // makes this the source of truth for "we already made one".
    const existing = await this.prisma.driveFolderLink.findUnique({
      where: { entityType_entityId: { entityType, entityId } },
    });
    if (existing) {
      return { folderId: existing.folderId, webViewLink: existing.webViewLink };
    }

    const { drive, config } = await this.getDrive();

    // Step 2: search inside the Shared Drive under `parentId`. Handles
    // the case where a folder was created outside Planwise but has
    // the right name — we adopt it rather than making a duplicate.
    const found = await this.findChildFolder(drive, config.sharedDriveId, parentId, folderName);
    let folderId: string;
    let webViewLink: string | null;
    if (found) {
      folderId = found.id;
      webViewLink = found.webViewLink;
    } else {
      // Step 3: create.
      const created = await this.createFolder(drive, parentId, folderName);
      folderId = created.id;
      webViewLink = created.webViewLink;
    }

    // Step 4: persist the link. Upsert (not create) because a
    // parallel request that made it past step 1 first might have
    // written the row already; the unique index would otherwise 500.
    const link = await this.prisma.driveFolderLink.upsert({
      where: { entityType_entityId: { entityType, entityId } },
      create: { entityType, entityId, folderId, webViewLink },
      update: { folderId, webViewLink },
    });
    return { folderId: link.folderId, webViewLink: link.webViewLink };
  }

  /** Public ensure with per-key mutex. Two concurrent calls for the
   *  same (entityType, entityId) share the same in-flight promise so
   *  we never race-create duplicate folders. */
  private ensureFolder(
    entityType: 'project' | 'zone' | 'deliverable',
    entityId: number,
    parentId: string,
    folderName: string,
  ): Promise<DriveFolderRef> {
    const key = `${entityType}:${entityId}`;
    const inFlight = this.folderLocks.get(key);
    if (inFlight) return inFlight;
    const p = this.ensureFolderInner(entityType, entityId, parentId, folderName).finally(() => {
      // Clean up after settle so subsequent calls can proceed via the
      // fast (DB-cache) path.
      this.folderLocks.delete(key);
    });
    this.folderLocks.set(key, p);
    return p;
  }

  // ─── Public folder-ensure entry points ─────────────────────────────

  /**
   * Ensure the project folder exists in Drive and return its ref.
   * Folder name is `<projectNumber> - <projectName>` (hyphen, not em-
   * dash — safer on Google's filename validators). When no number is
   * set, falls back to `<projectName> (P<id>)` so two projects with
   * the same name don't collide.
   */
  async ensureProjectFolder(projectId: number): Promise<DriveFolderRef> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, name: true, number: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const config = await this.loadConfig();
    const parentId = config.rootFolderId ?? config.sharedDriveId;
    const folderName = project.number
      ? `${project.number} - ${project.name}`
      : `${project.name} (P${project.id})`;
    return this.ensureFolder('project', projectId, parentId, folderName);
  }

  /**
   * Ensure the zone folder — nested under the project folder. Recurses
   * into ensureProjectFolder so a zone can be opened even before its
   * project's folder was.
   */
  async ensureZoneFolder(zoneId: number): Promise<DriveFolderRef> {
    const zone = await this.prisma.zone.findFirst({
      where: { id: zoneId, deletedAt: null },
      select: { id: true, name: true, projectId: true },
    });
    if (!zone) throw new NotFoundException('Zone not found');
    const projectFolder = await this.ensureProjectFolder(zone.projectId);
    return this.ensureFolder('zone', zoneId, projectFolder.folderId, zone.name);
  }

  /**
   * Ensure the deliverable folder — nested under the project folder.
   * (Deliverables aren't zone-scoped in the current model; they belong
   * to a project. If the model ever adds zone-scoped deliverables, add
   * the ensureZoneFolder recursion path here.)
   */
  async ensureDeliverableFolder(deliverableId: number): Promise<DriveFolderRef> {
    const del = await this.prisma.projectDeliverable.findFirst({
      where: { id: deliverableId, deletedAt: null },
      select: { id: true, name: true, projectId: true },
    });
    if (!del) throw new NotFoundException('Deliverable not found');
    const projectFolder = await this.ensureProjectFolder(del.projectId);
    return this.ensureFolder('deliverable', deliverableId, projectFolder.folderId, del.name);
  }

  /**
   * Fetch an existing folder link WITHOUT auto-creating it. Used by
   * read-only surfaces that shouldn't quietly call out to Google.
   */
  async getFolderLink(
    entityType: 'project' | 'zone' | 'deliverable',
    entityId: number,
  ): Promise<DriveFolderRef | null> {
    const row = await this.prisma.driveFolderLink.findUnique({
      where: { entityType_entityId: { entityType, entityId } },
    });
    if (!row) return null;
    return { folderId: row.folderId, webViewLink: row.webViewLink };
  }

  // ─── Attach-by-URL ─────────────────────────────────────────────────

  /**
   * Parse a Google-Drive URL (or a bare fileId) into a fileId string.
   * Recognizes the common share/edit/view URL shapes; returns the
   * input untouched if it already looks like a fileId.
   *
   * NB: this is deliberately permissive on the input side — a real
   * check happens via drive.files.get in attachDriveFile. If Google
   * rejects it, so do we.
   */
  parseFileId(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) throw new Error('driveUrlOrId is empty');
    // Bare id? Drive fileIds are base64url-ish, 20-50 chars typically.
    // Accept anything without a slash or colon and no whitespace.
    if (!/[\s/:]/.test(trimmed)) return trimmed;

    // Try the common shapes:
    //   https://drive.google.com/file/d/{FILE_ID}/view
    //   https://drive.google.com/file/d/{FILE_ID}
    //   https://docs.google.com/document/d/{FILE_ID}/edit
    //   https://docs.google.com/spreadsheets/d/{FILE_ID}/edit
    //   https://docs.google.com/presentation/d/{FILE_ID}/edit
    const dPath = trimmed.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
    if (dPath?.[1]) return dPath[1];

    // Query-style: ?id={FILE_ID}
    const idParam = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
    if (idParam?.[1]) return idParam[1];

    // Open URL: https://drive.google.com/open?id={FILE_ID} (covered
    // above) or unrecognised — fall through.
    throw new Error(
      `Could not parse a Google Drive fileId from "${trimmed.slice(0, 80)}". Paste a link like https://drive.google.com/file/d/<id>/view or the raw file id.`,
    );
  }

  /**
   * Attach an EXISTING Drive file (referenced by URL or fileId) to a
   * project + optional task + optional deliverable. Creates a
   * project_files row of kind='drive' with the fileId in `url` and
   * the metadata Drive returned. Fetches metadata with
   * supportsAllDrives so files that live in the Shared Drive are
   * findable; a file outside the SA's reach yields a helpful 403.
   */
  async attachDriveFile(params: {
    projectId: number;
    taskId?: number | null;
    deliverableId?: number | null;
    driveUrlOrId: string;
    uploadedBy: number;
  }) {
    const fileId = this.parseFileId(params.driveUrlOrId);
    const { drive } = await this.getDrive();

    let meta: DriveFileRef;
    try {
      const { data } = await drive.files.get({
        fileId,
        fields: 'id, name, mimeType, webViewLink',
        supportsAllDrives: true,
      });
      if (!data.id) throw new Error('files.get returned no id');
      meta = {
        fileId: data.id,
        name: data.name ?? '(untitled)',
        mimeType: data.mimeType ?? null,
        webViewLink: data.webViewLink ?? null,
      };
    } catch (err: any) {
      const status = err?.code ?? err?.response?.status;
      const msg =
        err?.errors?.[0]?.message ??
        err?.response?.data?.error?.message ??
        err?.message ??
        String(err);
      if (status === 404 || status === 403) {
        throw new DriveFileNotAccessibleException(fileId, msg);
      }
      // Anything else — re-throw as-is so the caller / global filter
      // decides what to surface.
      throw err;
    }

    const created = await this.prisma.projectFile.create({
      data: {
        projectId: params.projectId,
        taskId: params.taskId ?? null,
        deliverableId: params.deliverableId ?? null,
        kind: 'drive',
        // For drive-kind rows, `url` stores the Drive fileId. The
        // canonical user-facing URL is `webViewLink` (or the
        // predictable fallback the client builds from the id).
        url: meta.fileId,
        name: meta.name,
        mimeType: meta.mimeType,
        webViewLink: meta.webViewLink,
        uploadedBy: params.uploadedBy,
      },
      include: {
        uploader: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
      },
    });
    return created;
  }
}
