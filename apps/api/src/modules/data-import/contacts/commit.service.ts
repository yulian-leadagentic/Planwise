import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { ActivityLogService } from '../../../common/services/activity-log.service';
import { ContactsResolveService } from './resolve.service';
import { DedupDecision, ContactAction, OrgAction } from './dedup.service';
import { ContactField } from './header-dictionary';
import { ColumnMapping } from './split-merge.service';
import { ExtractedSheet } from './triage.service';
import * as Sentry from '@sentry/node';

/**
 * BM2 · Contacts import wizard · Stage 6 — idempotent commit.
 *
 * Follows §3-Stage-6 verbatim:
 *   1. Re-run the Stage 5 resolve (server-side; the client can't lie
 *      about what the preview said).
 *   2. Per row, apply the user's decisions where present, else the
 *      preview's default.
 *   3. Create/link typed org BPs (partnerType='organization', typing
 *      choice is deferred — no default), then create/link person BPs.
 *   4. Wire the `worker_of` party↔party edge when both sides
 *      materialize.
 *   5. Optionally attach the person to a project via project-partner-roles
 *      with the row's discipline (only if attachToProjectId was supplied).
 *   6. Track everything under a DataImport row so history + rollback
 *      work.
 *
 * Idempotency guarantees (§9 target):
 *   • Org dedup runs a fresh domain-first / normalized-name lookup on
 *     each row, so re-uploading the same file resolves everything to
 *     'link' the second time.
 *   • Domain writes catch P2002 unique violations (a race with another
 *     import) and skip the domain-write rather than crashing.
 *   • worker_of writes catch P2002 (existing edge) so re-runs are no-ops.
 *   • project-partner-roles writes catch P2002 (the (projectId,
 *     partyId, roleId, validFrom) unique).
 *   • Person dedup on email — matches an existing person even when
 *     the address was created outside this importer.
 */
@Injectable()
export class ContactsCommitService {
  private readonly logger = new Logger(ContactsCommitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolveService: ContactsResolveService,
    private readonly activityLog: ActivityLogService,
  ) {}

  async commit(input: CommitInput, userId: number): Promise<CommitResult> {
    if (!input.sheet) throw new BadRequestException('sheet is required');

    // Stage 5 re-runs authoritatively on the server.
    const preview = await this.resolveService.previewSheet({
      sheet: input.sheet,
      mapping: input.mapping,
      headerRowIndex: input.headerRowIndex,
    });

    const decisionsByRow = new Map<number, RowDecision>();
    for (const d of input.decisions ?? []) {
      if (typeof d.sourceRowIndex === 'number') decisionsByRow.set(d.sourceRowIndex, d);
    }

    // Open the DataImport history row up-front so per-row telemetry
    // can attach even on partial failure.
    const fileHash = computeContentHash(input);
    const importRecord = await this.prisma.dataImport.create({
      data: {
        userId,
        target: 'contacts',
        filename: input.filename ?? input.sheet.name ?? 'contacts.xlsx',
        fileHash,
        mode: 'insert',
        rowCount: preview.resolvedRows.length,
        status: 'parsed',
        notes: buildRunNotes(input, preview.summary),
      },
    });

    // Look up the worker_of relationship type once — creating the edge
    // fails silently rather than crashing the whole commit if the seed
    // is missing.
    const workerOf = await this.prisma.partnerRelationshipType.findUnique({
      where: { code: 'worker_of' },
    });

    const result: CommitResult = {
      importId: importRecord.id,
      orgsCreated: 0,
      orgsLinked: 0,
      orgsSkipped: 0,
      contactsCreated: 0,
      contactsLinked: 0,
      contactsSkipped: 0,
      workerOfLinksCreated: 0,
      projectAttached: 0,
      belowContract: 0,
      errors: 0,
      perRow: [],
    };

    // Validate attachToProjectId early so we don't half-commit before
    // realising the project doesn't exist.
    if (input.attachToProjectId != null) {
      const proj = await this.prisma.project.findUnique({
        where: { id: input.attachToProjectId },
        select: { id: true },
      });
      if (!proj) {
        await this.prisma.dataImport.update({
          where: { id: importRecord.id },
          data: { status: 'failed', finishedAt: new Date() },
        });
        throw new BadRequestException(`Project ${input.attachToProjectId} not found`);
      }
    }

    for (let i = 0; i < preview.decisions.length; i++) {
      const dec = preview.decisions[i];
      const dp = decisionsByRow.get(dec.sourceRowIndex);
      const orgAction: OrgAction = dp?.orgAction
        ?? (dec.org.action === 'conflict' ? 'skip' : (dec.org.action as OrgAction));
      const contactAction: ContactAction = dp?.contactAction ?? (dec.contact.action as ContactAction);

      // Enforce §7 minimum contract at commit — even if the client
      // sends a decision for a row below the contract, we skip.
      if (!dec.meetsMinimumContract) {
        result.belowContract++;
        result.perRow.push({
          sourceRowIndex: dec.sourceRowIndex,
          status: 'skipped',
          orgBpId: null,
          contactBpId: null,
          message: dec.contractError ?? 'below minimum contract',
        });
        await this.recordRow(importRecord.id, dec.sourceRowIndex, 'skipped', null, dec.contractError, dec.values);
        continue;
      }

      try {
        // ─── ORG SIDE ─────────────────────────────────────────────
        let orgBpId: number | null = null;
        if (orgAction === 'link') {
          orgBpId = dp?.orgBpId ?? dec.org.matchedBpId ?? null;
          if (!orgBpId) throw new Error('link action needs an org BP id');
          result.orgsLinked++;
        } else if (orgAction === 'create') {
          const created = await this.prisma.businessPartner.create({
            data: {
              partnerType: 'organization',
              displayName: dec.values.company ?? '(unnamed)',
              companyName: dec.values.company ?? null,
              email: dec.values.email ?? null,
              phone: dec.values.phone ?? null,
              address: dec.values.address ?? null,
              notes: dec.values.note ?? null,
              source: 'import',
              createdByImportId: importRecord.id,
            },
          });
          orgBpId = created.id;
          result.orgsCreated++;

          // Claim the org's domain when the email carries a real
          // company domain (not personal). Uniqueness is enforced at
          // the DB; catch P2002 to survive races with concurrent
          // imports.
          if (dec.domain && !dec.isPersonalDomain) {
            try {
              await this.prisma.businessPartnerDomain.create({
                data: { partnerId: created.id, domain: dec.domain },
              });
            } catch (err: unknown) {
              if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
                throw err;
              }
            }
          }
        } else {
          result.orgsSkipped++;
        }

        // ─── PERSON SIDE ──────────────────────────────────────────
        let contactBpId: number | null = null;
        if (contactAction === 'link') {
          contactBpId = dp?.contactBpId ?? dec.contact.matchedBpId ?? null;
          if (!contactBpId) throw new Error('link person action needs a person BP id');
          result.contactsLinked++;
        } else if (contactAction === 'create') {
          const email = dp?.chosenEmail ?? dec.values.email ?? null;
          // Idempotency re-check — a preview computed 30 seconds ago
          // may be stale if another import committed the same person
          // in the meantime.
          if (email) {
            const existing = await this.prisma.businessPartner.findFirst({
              where: { partnerType: 'person', email, deletedAt: null },
              select: { id: true },
            });
            if (existing) {
              contactBpId = existing.id;
              result.contactsLinked++;
            }
          }
          if (contactBpId == null) {
            const [firstName, ...restName] = (dec.values.contact ?? '').trim().split(/\s+/);
            const lastName = restName.join(' ') || null;
            const created = await this.prisma.businessPartner.create({
              data: {
                partnerType: 'person',
                displayName: dec.values.contact ?? email ?? '(unnamed)',
                firstName: firstName || null,
                lastName,
                email,
                phone: dec.values.phone ?? null,
                mobile: dec.values.mobile ?? null,
                address: dec.values.address ?? null,
                notes: dec.values.note ?? null,
                source: 'import',
                createdByImportId: importRecord.id,
              },
            });
            contactBpId = created.id;
            result.contactsCreated++;
          }
        } else {
          result.contactsSkipped++;
        }

        // ─── worker_of edge ──────────────────────────────────────
        // Pre-check by (partyA, partyB, typeId) rather than relying on
        // the (partyA, partyB, typeId, validFrom) unique — validFrom
        // defaults to now(), so re-runs would NOT collide on the
        // unique. This keeps re-runs idempotent even across days.
        if (workerOf && orgBpId && contactBpId) {
          const existingEdge = await this.prisma.partnerRelationship.findFirst({
            where: { partyAId: contactBpId, partyBId: orgBpId, typeId: workerOf.id },
            select: { id: true },
          });
          if (!existingEdge) {
            try {
              await this.prisma.partnerRelationship.create({
                data: {
                  partyAId: contactBpId,
                  partyBId: orgBpId,
                  typeId: workerOf.id,
                  isPrimary: true,
                  titleAtB: dec.values.role ?? dec.values.discipline ?? null,
                },
              });
              result.workerOfLinksCreated++;
            } catch (err: unknown) {
              if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
                throw err;
              }
              // A concurrent commit just wrote the same edge — treat as
              // idempotent success.
            }
          }
        }

        // ─── Attach to project (optional) ────────────────────────
        // Pre-check for an active existing membership before creating
        // (unique includes validFrom → default now() → wouldn't collide).
        if (input.attachToProjectId != null && contactBpId != null) {
          const roleId = await this.pickProjectRoleId(input.projectRoleId ?? null, dec.values);
          if (roleId) {
            const existingMembership = await this.prisma.projectPartnerRole.findFirst({
              where: {
                projectId: input.attachToProjectId,
                partyId: contactBpId,
                roleId,
                validTo: { gt: new Date() },
              },
              select: { id: true },
            });
            if (!existingMembership) {
              try {
                await this.prisma.projectPartnerRole.create({
                  data: {
                    projectId: input.attachToProjectId,
                    partyId: contactBpId,
                    roleId,
                    isPrimary: false,
                    titleInProject: dec.values.discipline ?? dec.values.role ?? null,
                    onBehalfOfPartyId: orgBpId ?? null,
                  },
                });
                result.projectAttached++;
              } catch (err: unknown) {
                if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
                  throw err;
                }
              }
            }
          }
        }

        result.perRow.push({
          sourceRowIndex: dec.sourceRowIndex,
          status: orgAction === 'create' || contactAction === 'create' ? 'created' : 'linked',
          orgBpId,
          contactBpId,
        });
        await this.recordRow(
          importRecord.id,
          dec.sourceRowIndex,
          orgAction === 'create' || contactAction === 'create' ? 'created' : 'skipped',
          contactBpId ?? orgBpId ?? null,
          null,
          dec.values,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`contacts-import row ${dec.sourceRowIndex} failed: ${message}`);
        result.errors++;
        result.perRow.push({
          sourceRowIndex: dec.sourceRowIndex,
          status: 'error',
          orgBpId: null,
          contactBpId: null,
          message,
        });
        await this.recordRow(importRecord.id, dec.sourceRowIndex, 'failed', null, message, dec.values);
      }
    }

    const status =
      result.errors === 0 && (result.orgsCreated + result.orgsLinked + result.contactsCreated + result.contactsLinked) > 0
        ? 'committed'
        : result.errors === 0
          ? 'committed'
          : 'partial';

    await this.prisma.dataImport.update({
      where: { id: importRecord.id },
      data: {
        status,
        createdCount: result.orgsCreated + result.contactsCreated,
        updatedCount: result.workerOfLinksCreated + result.projectAttached,
        skippedCount:
          result.orgsSkipped + result.contactsSkipped + result.belowContract,
        errorCount: result.errors,
        finishedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    // Audit trail — ONE summary row per commit so the admin Activity Log
    // shows "who imported what, when, and how many rows landed" without
    // spamming a row per contact. `projectId` is set only when the
    // wizard attached rows to a project (that's the whole reason to
    // scope this to a project's Activity tab). Category is 'admin' —
    // there's no 'import' enum value; imports are admin-triggered
    // ingest events, matching the sso-admin / drive-admin convention.
    try {
      const created = result.orgsCreated + result.contactsCreated;
      const linked = result.orgsLinked + result.contactsLinked + result.workerOfLinksCreated;
      const skipped = result.orgsSkipped + result.contactsSkipped + result.belowContract;
      await this.activityLog.write({
        category: 'admin',
        action: 'import.contacts.committed',
        actorUserId: userId,
        projectId: input.attachToProjectId ?? null,
        entityType: 'data_import',
        entityId: importRecord.id,
        entityName: importRecord.filename,
        description: `Imported contacts "${importRecord.filename}": ${created} created, ${linked} linked, ${skipped} skipped` +
          (result.errors > 0 ? `, ${result.errors} errors` : ''),
        metadata: {
          importId: importRecord.id,
          created,
          linked,
          skipped,
          errors: result.errors,
          projectAttached: result.projectAttached,
          orgsCreated: result.orgsCreated,
          orgsLinked: result.orgsLinked,
          contactsCreated: result.contactsCreated,
          contactsLinked: result.contactsLinked,
        },
      });
    } catch (e) { Sentry.captureException(e); /* swallow */ }

    return result;
  }

  /**
   * Pick a ProjectRoleType id for the project attach step. Order:
   *   1. Explicit projectRoleId from the wizard call.
   *   2. Any role type whose code === 'contact' or 'external_contact'
   *      (seeded by BM2 Phase 6) — the "generic contact" fallback.
   *   3. null (skip project attach for this row).
   */
  private async pickProjectRoleId(
    explicit: number | null,
    _values: Partial<Record<ContactField, string>>,
  ): Promise<number | null> {
    if (explicit != null) return explicit;
    const fallback = await this.prisma.projectRoleType.findFirst({
      where: { code: { in: ['contact', 'external_contact', 'consultant'] } },
      orderBy: { sortOrder: 'asc' },
    });
    return fallback?.id ?? null;
  }

  private async recordRow(
    importId: number,
    rowIndex: number,
    outcome: 'created' | 'skipped' | 'failed' | 'updated',
    entityId: number | null,
    errorMessage: string | null,
    afterValues: Partial<Record<ContactField, string>>,
  ) {
    await this.prisma.dataImportRow.create({
      data: {
        importId,
        rowIndex,
        outcome,
        entityId,
        errorMessage,
        afterJson: afterValues as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

// ─── Types ─────────────────────────────────────────────────────────────

export interface RowDecision {
  sourceRowIndex: number;
  orgAction?: OrgAction;
  orgBpId?: number | null;
  contactAction?: ContactAction;
  contactBpId?: number | null;
  chosenEmail?: string;
}

export interface CommitInput {
  sheet: ExtractedSheet;
  mapping: ColumnMapping;
  headerRowIndex?: number;
  decisions?: RowDecision[];
  filename?: string;
  /** When set, each created/linked person is attached to this project. */
  attachToProjectId?: number | null;
  /** Optional explicit ProjectRoleType id for the attach step. */
  projectRoleId?: number | null;
  /** Free-text notes stored on the DataImport history row. */
  notes?: string;
}

export interface CommitResult {
  importId: number;
  orgsCreated: number;
  orgsLinked: number;
  orgsSkipped: number;
  contactsCreated: number;
  contactsLinked: number;
  contactsSkipped: number;
  workerOfLinksCreated: number;
  projectAttached: number;
  belowContract: number;
  errors: number;
  perRow: Array<{
    sourceRowIndex: number;
    status: 'created' | 'linked' | 'skipped' | 'error';
    orgBpId: number | null;
    contactBpId: number | null;
    message?: string;
  }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Hash the effective content (sheet name + row count + mapping + first
 * few rows) so re-committing the same sheet with the same decisions is
 * detectable in history. We don't have the original file bytes at this
 * point (the wizard is stateless server-side after Stage 1), so a
 * content hash is the best we can do.
 */
function computeContentHash(input: CommitInput): string {
  const h = crypto.createHash('sha256');
  h.update(input.sheet.name ?? '');
  h.update('|');
  h.update(String(input.sheet.rows.length));
  h.update('|');
  h.update(JSON.stringify(input.mapping));
  h.update('|');
  // Sample first + last 5 rows into the hash — enough to spot re-uploads
  // without paying for the entire grid.
  const samples = [...input.sheet.rows.slice(0, 5), ...input.sheet.rows.slice(-5)];
  h.update(JSON.stringify(samples));
  return h.digest('hex');
}

function buildRunNotes(input: CommitInput, summary: { totalRows: number; eligible: number; belowContract: number }): string {
  const parts: string[] = [];
  if (input.notes?.trim()) parts.push(input.notes.trim());
  parts.push(
    `contacts wizard: sheet "${input.sheet.name ?? ''}" · ${summary.totalRows} rows (${summary.eligible} eligible, ${summary.belowContract} below contract) · mapping: ${Object.keys(input.mapping).sort().join(', ')}`,
  );
  return parts.join('\n');
}
