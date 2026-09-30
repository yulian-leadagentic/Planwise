import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { ActivityLogService } from '../../../common/services/activity-log.service';
import { ContactsResolveService } from './resolve.service';
import { DedupDecision, ContactAction, OrgAction, isPlausibleCompanyName } from './dedup.service';
import { ContactField } from './header-dictionary';
import { ColumnMapping, SecondaryContact } from './split-merge.service';
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

    // ─── QA4 R2b ORG-1 · intra-batch org materialisation ─────────────
    // The Stage-5 dedup pass already tagged each decision with a
    // `batchOrgKey`. Materialise every distinct key EXACTLY ONCE here
    // so the per-row loop below can look up the concrete BP id from
    // the map instead of re-creating the same org on every colleague
    // row. Only handles rows the row loop is about to process
    // (skipped and below-contract rows never touch this map).
    //
    // Row-decision overrides (skip / create-instead-of-link) are
    // resolved in the same order as the row loop uses so the
    // materialisation matches the effective action, not the preview
    // default. When the leader is `skip` we drop the key entirely so
    // the row loop falls back to the single-row path — never silently
    // "link" a person to an org the user asked to skip.
    const batchOrgIdByKey = new Map<string, number>();
    // Track which distinct key already had its "orgsCreated" counter
    // bumped so re-encounters of the same key don't double-count.
    const orgsMaterialisedKeys = new Set<string>();
    // QA4 E3 (2026-09-29) — reviewer-deleted orgs. `cascade` drops
    // every person in the group; `keep-people` still deletes the org
    // materialisation but leaves the people to their `personOrgOverride`
    // (E6 on the FE guarantees each has one, else it blocks commit).
    const deletedOrgKeys = new Set<string>(input.orgDeleted ?? []);
    const orgDeleteModeByKey = input.orgDeleteMode ?? {};
    // QA4 E4 (2026-09-29) — per-row org reassignment. `null` means
    // "move to individuals" (treated as no batch key at all).
    const personOrgOverrides = input.personOrgOverrides ?? {};
    // Effective batch key for a row — reads the E4 override when set.
    const effectiveBatchKeyFor = (dec: DedupDecision): string | null => {
      const override = personOrgOverrides[dec.sourceRowIndex];
      if (override === null) return null; // moved to individuals
      if (typeof override === 'string' && override) return override;
      return dec.batchOrgKey ?? null;
    };
    // Read per-row overrides once so both the materialisation pass and
    // the row loop below see the same effective action.
    const effectiveOrgActionFor = (dec: DedupDecision): OrgAction => {
      const dp = decisionsByRow.get(dec.sourceRowIndex);
      // ORG-6 — user-marked skip wins over everything else.
      if (dp?.skipped) return 'skip';
      // QA4 E3 — a row whose (effective) org was deleted by the
      // reviewer: cascade drops the row entirely; keep-people leaves
      // it to E4 to reassign, but if no reassignment we drop too
      // (should never happen — E6 gate prevents commit).
      const effKey = effectiveBatchKeyFor(dec);
      if (effKey && deletedOrgKeys.has(effKey)) {
        return 'skip';
      }
      // Also honour below-contract as skip here so we don't pre-create
      // orgs for rows the loop is going to drop anyway.
      if (!dec.meetsMinimumContract) return 'skip';
      return dp?.orgAction
        ?? (dec.org.action === 'conflict' ? 'skip' : (dec.org.action as OrgAction));
    };

    // Pass 1 — collect leader decisions per (effective) key. First
    // occurrence wins so the materialisation follows the same
    // "leader / member" split the dedup service built the batchOrgKey
    // around. E4 reassignments recompute the key per row; a moved row
    // can BECOME the leader of a target org whose native rows all
    // ended up skipped.
    const leaderByKey = new Map<string, DedupDecision>();
    for (const dec of preview.decisions) {
      const key = effectiveBatchKeyFor(dec);
      if (!key) continue;
      if (deletedOrgKeys.has(key)) continue;
      if (effectiveOrgActionFor(dec) === 'skip') continue;
      if (!leaderByKey.has(key)) leaderByKey.set(key, dec);
    }

    // Pass 2 — resolve/create each key. When the key encodes an
    // existing BP (`bp:<id>`) just record the id; otherwise honour
    // the leader's `orgAction` (link → existing matched BP; create →
    // fresh BP with the leader's parsed values).
    for (const [key, leader] of leaderByKey) {
      const leaderDp = decisionsByRow.get(leader.sourceRowIndex);
      const leaderAction = effectiveOrgActionFor(leader);
      const eff = <T extends OverrideField>(field: T): string | null => {
        const overrides = leaderDp?.overrides ?? {};
        if (field in overrides) return overrides[field] ?? null;
        if (field === 'officeManager') return null;
        return (leader.values as Partial<Record<ContactField, string>>)[field as ContactField] ?? null;
      };

      let orgBpId: number | null = null;
      try {
        if (leaderAction === 'link') {
          orgBpId = leaderDp?.orgBpId ?? leader.org.matchedBpId ?? null;
          // QA4 E5 (2026-09-29) — apply per-field conflict picks. Any
          // field the reviewer flipped to `imported` is written to the
          // matched org BP; `existing` is a no-op. Runs a single
          // UPDATE keyed on the org's id.
          if (orgBpId != null) {
            const picks = input.conflictResolutions?.[`org:${key}`] ?? {};
            const updates: Record<string, string | null> = {};
            for (const [field, choice] of Object.entries(picks)) {
              if (choice !== 'imported') continue;
              const val = eff(field as OverrideField);
              if (field === 'company') {
                updates['displayName'] = val ?? '';
                updates['companyName'] = val ?? null;
              } else if (field === 'email') {
                updates['email'] = val;
              } else if (field === 'phone') {
                updates['phone'] = val;
              } else if (field === 'mobile') {
                updates['mobile'] = val;
              } else if (field === 'address') {
                updates['address'] = val;
              } else if (field === 'note') {
                updates['notes'] = val;
              }
            }
            if (Object.keys(updates).length > 0) {
              try {
                await this.prisma.businessPartner.update({
                  where: { id: orgBpId },
                  data: updates as Prisma.BusinessPartnerUpdateInput,
                });
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                this.logger.warn(
                  `contacts-import E5 org "${key}" field-update failed: ${message}`,
                );
              }
            }
          }
        } else if (leaderAction === 'create') {
          const rawOrgName = eff('company');
          // QA4 E2 (2026-09-29) — inline name override wins over the
          // parsed cell. Domain override replaces the leader row's
          // extracted domain for both the org identity fallback + the
          // domain claim.
          const orgOverride = input.orgOverrides?.[key];
          const overrideName = orgOverride?.name?.trim();
          const overrideDomain = orgOverride?.domain?.trim().toLowerCase();
          // QA4 RD-3 (2026-09-29) — never let an email / dash /
          // single-character cell become the org identity. The batch
          // key already collapsed the group under its domain, so the
          // best fallback for a nameless group is the domain itself
          // (e.g. "@mra.co.il") — a human-readable label the PM can
          // rename post-commit.
          const safeOrgName = overrideName
            ? { displayName: overrideName, companyName: overrideName }
            : deriveSafeOrgName(rawOrgName, overrideDomain ?? leader.domain);
          const domainToClaim = overrideDomain ?? leader.domain ?? null;
          const orgPhone = eff('phone')
            ?? (leader.secondaryContacts ?? []).map((s) => s.phone).find(Boolean)
            ?? null;
          // Prefer the routed generic mailbox (office@…) over the
          // primary email column when the row carried both — same
          // routing as the row loop uses.
          const routedOrgEmail = pickOrgPrimaryEmailForRow(leader, leaderDp);
          const leaderPrimaryEmail = leaderDp?.overrides && 'email' in leaderDp.overrides
            ? leaderDp.overrides.email ?? null
            : (leaderDp?.chosenEmail ?? leader.values.email ?? null);
          const created = await this.prisma.businessPartner.create({
            data: {
              partnerType: 'organization',
              displayName: safeOrgName.displayName,
              companyName: safeOrgName.companyName,
              email: routedOrgEmail ?? leaderPrimaryEmail,
              phone: orgPhone,
              address: leader.values.address ?? null,
              notes: leader.values.note ?? null,
              source: 'import',
              createdByImportId: importRecord.id,
            },
          });
          orgBpId = created.id;
          result.orgsCreated++;
          orgsMaterialisedKeys.add(key);

          // Claim the domain when the row carried one (mirror the
          // existing per-row branch).
          // QA4 RD-3 — only claim the sanitised (shape-checked) domain.
          // A mangled `<foo@bar.com>` copy-paste that once stored
          // `bar.com>` as a claimed domain no longer happens here.
          // QA4 E2 — a user-typed domain wins if it's shape-valid.
          if (domainToClaim && !leader.isPersonalDomain && isDomainShaped(domainToClaim)) {
            try {
              await this.prisma.businessPartnerDomain.create({
                data: { partnerId: created.id, domain: domainToClaim },
              });
            } catch (err: unknown) {
              if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
                throw err;
              }
            }
          }

          // QA4 R2b ORG-3 — write the user-picked BusinessPartnerRole
          // on the freshly-created org so the Organizations list shows
          // a real TYPE instead of "not set". Idempotent via
          // `@@unique([businessPartnerId, roleTypeId])`.
          //
          // QA4 IW-2 (2026-09-30) — a NEW org that reached commit
          // without a user-picked type falls back to `partner` (the
          // wizard's default; matches the FE gate's pre-selected value).
          // A commit call that omits `orgTypes[key]` still produces a
          // typed org rather than the pre-IW-2 "not set" shape.
          const roleCode = input.orgTypes?.[key] ?? 'partner';
          if (roleCode) {
            const roleType = await this.prisma.partnerRoleType.findUnique({
              where: { code: roleCode.toLowerCase() },
              select: { id: true },
            });
            if (roleType) {
              try {
                await this.prisma.businessPartnerRole.create({
                  data: {
                    businessPartnerId: created.id,
                    roleTypeId: roleType.id,
                    isPrimary: true,
                  },
                });
              } catch (err: unknown) {
                if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
                  throw err;
                }
              }
            }
          }
        }
      } catch (err: unknown) {
        // Surface but don't fail the whole commit — the row loop below
        // will still try (single-row fallback) and record its own error.
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `contacts-import batchOrgKey "${key}" leader row ${leader.sourceRowIndex} failed: ${message}`,
        );
      }
      if (orgBpId != null) batchOrgIdByKey.set(key, orgBpId);
    }

    for (let i = 0; i < preview.decisions.length; i++) {
      const dec = preview.decisions[i];
      const dp = decisionsByRow.get(dec.sourceRowIndex);

      // QA4 R2b ORG-6 — per-row trash (user removed the row before
      // commit). Honour BEFORE the min-contract check so the audit row
      // records the explicit "user removed" reason.
      if (dp?.skipped) {
        result.contactsSkipped++;
        result.perRow.push({
          sourceRowIndex: dec.sourceRowIndex,
          status: 'skipped',
          orgBpId: null,
          contactBpId: null,
          message: 'removed from import by reviewer',
        });
        await this.recordRow(importRecord.id, dec.sourceRowIndex, 'skipped', null, 'removed from import by reviewer', dec.values);
        continue;
      }

      // QA4 E3 (2026-09-29) — row's effective org was cascade-deleted.
      // `keep-people` never lands here because the FE reassigns each
      // kept row's `personOrgOverrides` before allowing commit (E6).
      const effKey = effectiveBatchKeyFor(dec);
      if (effKey && deletedOrgKeys.has(effKey)) {
        const mode = orgDeleteModeByKey[effKey] ?? 'cascade';
        if (mode === 'cascade') {
          result.contactsSkipped++;
          result.perRow.push({
            sourceRowIndex: dec.sourceRowIndex,
            status: 'skipped',
            orgBpId: null,
            contactBpId: null,
            message: `org "${effKey}" deleted by reviewer (cascade)`,
          });
          await this.recordRow(
            importRecord.id,
            dec.sourceRowIndex,
            'skipped',
            null,
            `org "${effKey}" deleted by reviewer (cascade)`,
            dec.values,
          );
          continue;
        }
        // keep-people without a personOrgOverride means the FE let this
        // slip through. Skip defensively — better a missed row than a
        // silently-orphaned person BP.
        result.contactsSkipped++;
        result.perRow.push({
          sourceRowIndex: dec.sourceRowIndex,
          status: 'skipped',
          orgBpId: null,
          contactBpId: null,
          message: `org "${effKey}" deleted; row not reassigned (keep-people fallback)`,
        });
        await this.recordRow(
          importRecord.id,
          dec.sourceRowIndex,
          'skipped',
          null,
          `org "${effKey}" deleted; row not reassigned`,
          dec.values,
        );
        continue;
      }

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

      // QA4 IMP-2 — per-row inline overrides win over the parsed values.
      // `null` in the override map explicitly clears the value.
      const eff = (field: OverrideField): string | null => {
        const overrides = dp?.overrides ?? {};
        if (field in overrides) return overrides[field] ?? null;
        // officeManager is not a canonical ContactField; only overrides
        // populate it (or IMP-4's classifier via its own emit path).
        if (field === 'officeManager') return null;
        return (dec.values as Partial<Record<ContactField, string>>)[field] ?? null;
      };
      // `chosenEmail` (multi-email split resolution) still takes priority
      // over the override for the email field so a legacy caller that
      // only supplies chosenEmail keeps working; overrides win when set.
      const emailForCommit = (): string | null => {
        const overrides = dp?.overrides ?? {};
        if ('email' in overrides) return overrides.email ?? null;
        return dp?.chosenEmail ?? dec.values.email ?? null;
      };

      // QA4 R2 IMP-9 — sort the row's emails into (personEmail,
      // orgEmail, additionalEmails). Kept local to the row so re-runs
      // are deterministic. Called below AFTER `emailForCommit` picks
      // the person's primary; the routing then decides where the
      // remaining addresses go.
      const routeEmails = (): {
        personPrimary: string | null;
        personAdditional: string[];
        orgPrimary: string | null;
        orgAdditional: string[];
      } => {
        // Universe of every valid email the row surfaced.
        const universe: string[] = [];
        const primary = emailForCommit();
        if (primary) universe.push(primary.toLowerCase());
        for (const e of dec.extraEmails ?? []) {
          const t = (e ?? '').trim().toLowerCase();
          if (t) universe.push(t);
        }
        const seen = new Set<string>();
        const uniq = universe.filter((e) => {
          if (seen.has(e)) return false;
          seen.add(e);
          return true;
        });

        const generic: string[] = [];
        const personal: string[] = [];
        for (const e of uniq) {
          if (isGenericMailbox(e)) generic.push(e);
          else personal.push(e);
        }

        // Person gets a personal address; else falls back to the
        // caller-supplied primary (which the override may pin), even
        // when that primary is generic — we never drop a value the PM
        // typed themselves.
        const personPrimary = personal[0] ?? primary ?? null;
        const personAdditional = personal.slice(personPrimary === personal[0] ? 1 : 0);

        // Org takes the first generic mailbox as primary; the rest
        // become the org's additional-emails list.
        const orgPrimary = generic[0] ?? null;
        const orgAdditional = generic.slice(orgPrimary === generic[0] ? 1 : 0);

        return { personPrimary, personAdditional, orgPrimary, orgAdditional };
      };

      // QA4 R2 IMP-9 — compute the email routing once per row so both
      // the org-side and person-side code below stay consistent, and
      // the additional-emails writes happen after both BPs materialise.
      const emailRouting = routeEmails();

      try {
        // ─── ORG SIDE ─────────────────────────────────────────────
        // QA4 R2b ORG-1 — when the row carries a `batchOrgKey` the
        // materialisation pass above already resolved the org id;
        // this branch just links every group member to that same id.
        // Falls back to the single-row path for rows without a key
        // (personal-domain rows / rows with only a person + email).
        let orgBpId: number | null = null;
        // QA4 E4 — a reviewer-moved row picks up its target's key.
        const batchKey = effectiveBatchKeyFor(dec);
        const batchOrgId = batchKey ? batchOrgIdByKey.get(batchKey) ?? null : null;
        if (orgAction === 'link') {
          orgBpId = dp?.orgBpId ?? dec.org.matchedBpId ?? batchOrgId ?? null;
          if (!orgBpId) throw new Error('link action needs an org BP id');
          if (batchKey && batchOrgId === orgBpId && orgsMaterialisedKeys.has(batchKey)) {
            // The batch pass created this org for the group — the leader
            // row already bumped `orgsCreated`, so every subsequent row
            // in the group counts as a "link" (fits the ORG-1 mental
            // model in the wizard: one create + N links).
            result.orgsLinked++;
          } else {
            result.orgsLinked++;
          }
        } else if (orgAction === 'create') {
          // Group leader path: the batch pass already created the org.
          if (batchKey && batchOrgId != null) {
            orgBpId = batchOrgId;
            // orgsCreated was bumped in the batch pass; nothing to add.
          } else {
            // No batch key — genuine single-row create (e.g. row had a
            // company name we couldn't slug, or dedup declined to
            // materialise). Fall through to the legacy inline create so
            // the row still lands.
            const rawOrgName = eff('company');
            const safeOrgName = deriveSafeOrgName(rawOrgName, dec.domain);
            const orgPhone = eff('phone')
              ?? (dec.secondaryContacts ?? []).map((s) => s.phone).find(Boolean)
              ?? null;
            const orgPrimaryEmail = emailRouting.orgPrimary ?? emailForCommit();
            const created = await this.prisma.businessPartner.create({
              data: {
                partnerType: 'organization',
                displayName: safeOrgName.displayName,
                companyName: safeOrgName.companyName,
                email: orgPrimaryEmail,
                phone: orgPhone,
                address: dec.values.address ?? null,
                notes: dec.values.note ?? null,
                source: 'import',
                createdByImportId: importRecord.id,
              },
            });
            orgBpId = created.id;
            result.orgsCreated++;

            // QA4 RD-3 — only claim domain-shaped values.
            if (dec.domain && !dec.isPersonalDomain && isDomainShaped(dec.domain)) {
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
          }
        } else {
          result.orgsSkipped++;
        }

        // QA4 R2 IMP-9 — write out the org's additional emails once
        // orgBpId is known. Idempotent: upsert on (BP, email) so a
        // re-import doesn't stack duplicates. Also seeds the primary
        // as a row of its own so the drawer can show one clean list.
        if (orgBpId != null) {
          const orgPrimaryEmail = emailRouting.orgPrimary
            ?? (orgAction === 'create' ? (emailForCommit() ?? null) : null);
          await this.upsertPartnerEmails(
            orgBpId,
            orgPrimaryEmail,
            emailRouting.orgAdditional,
          );
        }

        // ─── PERSON SIDE ──────────────────────────────────────────
        let contactBpId: number | null = null;
        // QA4 R2b ORG-5b — a row whose ONLY email is a generic
        // mailbox (office@, info@, …) and that has no separate phone
        // identity is really "the org's mailbox on a labelled row",
        // not a person. IMP-9's routeEmails already parks the mailbox
        // on the org; here we suppress the person side so the row
        // doesn't create a shadow person with the office@ address.
        const hasPersonalEmailSignal =
          !!emailRouting.personPrimary && !isGenericMailbox(emailRouting.personPrimary);
        const hasNonEmailReach = !!(eff('phone') || eff('mobile'));
        const genericOnly =
          !hasPersonalEmailSignal &&
          !hasNonEmailReach &&
          !!emailRouting.orgPrimary;
        if (contactAction === 'link') {
          contactBpId = dp?.contactBpId ?? dec.contact.matchedBpId ?? null;
          if (!contactBpId) throw new Error('link person action needs a person BP id');
          result.contactsLinked++;
          // QA4 E5 — apply per-field conflict picks against the
          // matched person BP. `imported` overwrites; `existing` is a
          // no-op. Discipline is resolved via the same helper as the
          // create path so a "use imported discipline" pick lands on
          // the structured discipline id, not on a raw string.
          const picks = input.conflictResolutions?.[`person:${dec.sourceRowIndex}`] ?? {};
          const updates: Record<string, unknown> = {};
          for (const [field, choice] of Object.entries(picks)) {
            if (choice !== 'imported') continue;
            const val = eff(field as OverrideField);
            if (field === 'contact') {
              updates['displayName'] = val ?? '(unnamed)';
              const [firstName, ...restName] = (val ?? '').trim().split(/\s+/);
              updates['firstName'] = firstName || null;
              updates['lastName'] = restName.join(' ') || null;
            } else if (field === 'email') {
              updates['email'] = val;
            } else if (field === 'phone') {
              updates['phone'] = val;
            } else if (field === 'mobile') {
              updates['mobile'] = val;
            } else if (field === 'address') {
              updates['address'] = val;
            } else if (field === 'note') {
              updates['notes'] = val;
            } else if (field === 'discipline') {
              const disciplineId = await this.resolveDisciplineId(val);
              updates['disciplineId'] = disciplineId ?? null;
            }
          }
          if (Object.keys(updates).length > 0) {
            try {
              await this.prisma.businessPartner.update({
                where: { id: contactBpId },
                data: updates as Prisma.BusinessPartnerUpdateInput,
              });
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              this.logger.warn(
                `contacts-import E5 person row ${dec.sourceRowIndex} field-update failed: ${message}`,
              );
            }
          }
        } else if (contactAction === 'create' && genericOnly) {
          // Skip person creation; the mailbox already went onto the org
          // via emailRouting.orgPrimary in the batch pass above.
          result.contactsSkipped++;
        } else if (contactAction === 'create') {
          // QA4 IW-BUG (2026-09-30) — belt-and-suspenders orphan guard.
          // The wizard's E6 gate already blocks commit when any kept
          // person has no org; but if a race, a reassignment loop, or
          // a genuine bug drops the org resolution to null here, NEVER
          // create a dangling person BP with no `worker_of` employer.
          // Withhold the row instead — the reviewer sees a clear
          // per-row reason on the commit result and can re-run after
          // fixing the assignment. Consistent with RD-6.
          if (orgBpId == null) {
            const personLabel = eff('contact') ?? emailRouting.personPrimary ?? emailForCommit() ?? `row:${dec.sourceRowIndex}`;
            const reason = orgAction === 'skip'
              ? 'org action resolved to skip — cannot create a person without an employer'
              : `no organization resolved for row ${dec.sourceRowIndex} (batchOrgKey missing or reassignment left it orphaned)`;
            result.contactsSkipped++;
            (result.withheldOrphans ??= []).push({
              sourceRowIndex: dec.sourceRowIndex,
              personKey: personLabel,
              reason,
            });
            result.perRow.push({
              sourceRowIndex: dec.sourceRowIndex,
              status: 'skipped',
              orgBpId: null,
              contactBpId: null,
              message: `withheld orphan: ${reason}`,
            });
            await this.recordRow(
              importRecord.id,
              dec.sourceRowIndex,
              'skipped',
              null,
              `withheld orphan: ${reason}`,
              dec.values,
            );
            continue;
          }
          // QA4 R2 IMP-9 — prefer the routed personal address as the
          // person's primary; that way `office@` never lands on the
          // person BP as their primary email.
          const email = emailRouting.personPrimary ?? emailForCommit();
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
            const contactName = eff('contact');
            const [firstName, ...restName] = (contactName ?? '').trim().split(/\s+/);
            const lastName = restName.join(' ') || null;
            // QA4 R2 IMP-10 — resolve the Excel discipline value to a
            // structured `disciplineId` (upserting the lookup row when the
            // name is new). `titleInProject` still carries the label for
            // display continuity with IMP-6.
            const disciplineValue = eff('discipline');
            const disciplineId = await this.resolveDisciplineId(disciplineValue);
            const created = await this.prisma.businessPartner.create({
              data: {
                partnerType: 'person',
                displayName: contactName ?? email ?? '(unnamed)',
                firstName: firstName || null,
                lastName,
                email,
                phone: eff('phone'),
                mobile: eff('mobile'),
                address: dec.values.address ?? null,
                notes: dec.values.note ?? null,
                source: 'import',
                createdByImportId: importRecord.id,
                disciplineId: disciplineId ?? undefined,
              },
            });
            contactBpId = created.id;
            result.contactsCreated++;
          }
        } else {
          result.contactsSkipped++;
        }

        // QA4 R2 IMP-9 — persist the person's additional emails. When
        // the person was LINKED (not created) we still record the row's
        // additional addresses on the existing BP so a later import
        // that finds new alt addresses doesn't drop them silently.
        if (contactBpId != null) {
          await this.upsertPartnerEmails(
            contactBpId,
            emailRouting.personPrimary ?? emailForCommit(),
            emailRouting.personAdditional,
          );
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
                  titleAtB:
                    // QA4 Round-2 IMP-6: prefer the PM's inline
                    // Role/Title override when set — falls back to the
                    // Excel role column and then the row's discipline.
                    eff('role') ?? dec.values.role ?? eff('discipline') ?? null,
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
                    titleInProject:
                      // QA4 Round-2 IMP-6 — role override takes
                      // precedence for the per-project title.
                      eff('role') ?? eff('discipline') ?? dec.values.role ?? null,
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

        // ─── QA4 IMP-4 — secondary contacts (office managers etc.) ─
        // Each extracted secondary attaches to the same org with a
        // worker_of edge and a default "Office manager" title. Skipped
        // when we have no org to bind to (secondary without a firm is
        // not persisted — the classifier gives it back to the PM in
        // the preview, but standalone people-only writes aren't the
        // shape this importer supports). Idempotency: match on
        // (partnerType='person', orgBpId, name/email/phone) so a
        // re-import doesn't duplicate.
        const secondaries = dec.secondaryContacts ?? [];
        if (secondaries.length > 0 && orgBpId != null) {
          for (const secondary of secondaries) {
            try {
              const secondaryBpId = await this.upsertSecondaryContact(
                secondary,
                orgBpId,
                importRecord.id,
              );
              if (secondaryBpId != null && workerOf) {
                await this.linkWorkerOf(
                  secondaryBpId,
                  orgBpId,
                  workerOf.id,
                  secondary.title,
                );
                result.workerOfLinksCreated++;
              }
              // Attach to project when the wizard asked for it.
              if (
                input.attachToProjectId != null &&
                secondaryBpId != null
              ) {
                const roleId = await this.pickProjectRoleId(
                  input.projectRoleId ?? null,
                  dec.values,
                );
                if (roleId) {
                  const existing = await this.prisma.projectPartnerRole.findFirst({
                    where: {
                      projectId: input.attachToProjectId,
                      partyId: secondaryBpId,
                      roleId,
                      validTo: { gt: new Date() },
                    },
                    select: { id: true },
                  });
                  if (!existing) {
                    try {
                      await this.prisma.projectPartnerRole.create({
                        data: {
                          projectId: input.attachToProjectId,
                          partyId: secondaryBpId,
                          roleId,
                          isPrimary: false,
                          titleInProject: secondary.title,
                          onBehalfOfPartyId: orgBpId,
                        },
                      });
                      result.projectAttached++;
                    } catch (err: unknown) {
                      if (
                        !(err instanceof Prisma.PrismaClientKnownRequestError &&
                          err.code === 'P2002')
                      ) {
                        throw err;
                      }
                    }
                  }
                }
              }
            } catch (err: unknown) {
              // Secondary-write failure is non-fatal for the row; log
              // to the DataImport telemetry so the PM sees it.
              const message = err instanceof Error ? err.message : String(err);
              this.logger.warn(
                `contacts-import row ${dec.sourceRowIndex} secondary "${secondary.name}" failed: ${message}`,
              );
              result.errors++;
              await this.recordRow(
                importRecord.id,
                dec.sourceRowIndex,
                'failed',
                null,
                `secondary "${secondary.name}": ${message}`,
                dec.values,
              );
            }
          }
        }
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
   *   2. QA4 R2 IMP-10 — the row's `role` value matched by name/code
   *      against ProjectRoleType (case-insensitive, trim). Lets a sheet
   *      that carries a role column (e.g. "Structural engineer") land
   *      on the specific project role rather than a bucket fallback.
   *   3. Any role type whose code === 'contact' or 'external_contact'
   *      or 'consultant' (seeded by BM2 Phase 6 / QA4 D9) — the
   *      "generic contact" bucket.
   *   4. `external_contact` seeded on the fly (defensive: staging
   *      may lag the migration). NEVER returns null now — every
   *      attach-on-import row gets a Project Role per IMP-10 DoD.
   */
  private async pickProjectRoleId(
    explicit: number | null,
    values: Partial<Record<ContactField, string>>,
  ): Promise<number | null> {
    if (explicit != null) return explicit;

    // (2) — try to match the row's role text against a real role type.
    const rowRole = (values.role ?? '').trim();
    if (rowRole) {
      const normalized = rowRole.toLowerCase();
      const byNameOrCode = await this.prisma.projectRoleType.findFirst({
        where: {
          OR: [
            { name: { equals: rowRole } },
            { code: { equals: normalized } },
          ],
        },
      });
      if (byNameOrCode) return byNameOrCode.id;
    }

    // (3) — canonical fallback bucket.
    const fallback = await this.prisma.projectRoleType.findFirst({
      where: { code: { in: ['external_contact', 'contact', 'consultant'] } },
      orderBy: { sortOrder: 'asc' },
    });
    if (fallback) return fallback.id;

    // (4) — defensive on-the-fly seed. Mirrors the shape in migration
    // `20260928230000_seed_external_contact_project_role`. Idempotent
    // via upsert on the unique `code`.
    const seeded = await this.prisma.projectRoleType.upsert({
      where: { code: 'external_contact' },
      create: {
        code: 'external_contact',
        name: 'External Contact',
        description:
          'Third-party stakeholder on the project (consultant, planner, supplier contact, etc.); not employee-of-record.',
        allowedPartnerKind: 'any',
        isPrimaryRequired: false,
        requiresContactPerson: false,
        sortOrder: 25,
        isSystem: true,
      },
      update: {},
    });
    return seeded.id;
  }

  /**
   * QA4 R2 IMP-10 — resolve an Excel discipline label to a structured
   * `Discipline` row id. Case-insensitive/trim lookup by name; when
   * nothing matches, upserts a new row (code = normalized name;
   * name = the raw label the user typed). Returns null on empty input.
   *
   * Idempotent via `upsert` on the unique `code`; a re-import of the
   * same label lands on the same row.
   */
  private async resolveDisciplineId(raw: string | null | undefined): Promise<number | null> {
    const label = (raw ?? '').trim();
    if (!label) return null;
    // Case-insensitive name match — the sheet's spelling may differ
    // from the seeded canonical name.
    const existing = await this.prisma.discipline.findFirst({
      where: { name: { equals: label } },
      select: { id: true },
    });
    if (existing) return existing.id;

    // No match — upsert by a derived code. Keeping the code in the
    // 'imp-<slug>' namespace signals "created by importer, review".
    const code = deriveDisciplineCode(label);
    try {
      const created = await this.prisma.discipline.upsert({
        where: { code },
        create: { code, name: label, isActive: true, sortOrder: 999 },
        update: { name: label },
      });
      return created.id;
    } catch (err: unknown) {
      // Extremely defensive — a race with another import trying the
      // same code raises P2002, which the upsert already handles, but
      // some Prisma versions surface it through the raw path. Fall
      // back to a fresh findFirst.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const again = await this.prisma.discipline.findFirst({
          where: { code },
          select: { id: true },
        });
        return again?.id ?? null;
      }
      throw err;
    }
  }

  /**
   * QA4 IMP-4 — create or link a secondary contact person. Idempotent:
   * looks for an existing person BP already `worker_of` this org whose
   * (email OR phone OR normalized-name) matches; returns its id when
   * found so a re-import doesn't duplicate. When nothing matches, a
   * fresh person BP is created with `source: 'import'` so history +
   * rollback still work.
   */
  private async upsertSecondaryContact(
    secondary: SecondaryContact,
    orgBpId: number,
    importId: number,
  ): Promise<number | null> {
    if (!secondary.name) return null;
    const normalizedName = normalizeCompare(secondary.name);

    // Idempotency probe #1 — a person BP whose email matches (email
    // is globally unique in this schema when set).
    if (secondary.email) {
      const byEmail = await this.prisma.businessPartner.findFirst({
        where: { partnerType: 'person', email: secondary.email, deletedAt: null },
        select: { id: true },
      });
      if (byEmail) return byEmail.id;
    }

    // Idempotency probe #2 — a person BP already linked worker_of
    // this org, whose display name or phone matches. Covers the
    // "same office manager appears in two rows of the same firm"
    // shape that the split-merge dedup pass may not have caught (the
    // pass runs per-import; probe covers cross-import runs).
    const linkedOfThisOrg = await this.prisma.partnerRelationship.findMany({
      where: {
        partyBId: orgBpId,
        typeId: { in: await this.workerOfTypeIds() },
      },
      select: { partyAId: true },
    });
    if (linkedOfThisOrg.length > 0) {
      const ids = linkedOfThisOrg.map((r) => r.partyAId);
      const candidates = await this.prisma.businessPartner.findMany({
        where: { id: { in: ids }, partnerType: 'person', deletedAt: null },
        select: { id: true, displayName: true, phone: true, mobile: true },
      });
      for (const c of candidates) {
        if (secondary.phone && c.phone && normalizeCompare(c.phone) === normalizeCompare(secondary.phone)) {
          return c.id;
        }
        if (secondary.mobile && c.mobile && normalizeCompare(c.mobile) === normalizeCompare(secondary.mobile)) {
          return c.id;
        }
        if (normalizeCompare(c.displayName ?? '') === normalizedName) return c.id;
      }
    }

    // Nothing matched — create.
    const [firstName, ...restName] = secondary.name.trim().split(/\s+/);
    const lastName = restName.join(' ') || null;
    const created = await this.prisma.businessPartner.create({
      data: {
        partnerType: 'person',
        displayName: secondary.name,
        firstName: firstName || null,
        lastName,
        email: secondary.email ?? null,
        phone: secondary.phone ?? null,
        mobile: secondary.mobile ?? null,
        notes: buildSecondaryNotes(secondary),
        source: 'import',
        createdByImportId: importId,
      },
    });

    // QA4 R2 IMP-7 — attach the person to the Profession that matches
    // the classifier's title (default "Office manager"). Profession is
    // upsert-by-name so a re-import lands on the same row; the join is
    // upsert-by-(bp, profession) so a re-run stays idempotent. Best-
    // effort: a failure here does NOT roll back the person write —
    // the primary DoD is "person BP exists with the right job title",
    // and the profession link is the display anchor for that title.
    try {
      const professionId = await this.resolveProfessionId(secondary.title);
      if (professionId != null) {
        await this.prisma.businessPartnerProfession.upsert({
          where: {
            businessPartnerId_professionId: {
              businessPartnerId: created.id,
              professionId,
            },
          },
          create: {
            businessPartnerId: created.id,
            professionId,
            isPrimary: true,
          },
          update: { isPrimary: true },
        });
      }
    } catch (err: unknown) {
      // Non-fatal — the person BP + secondary title already carry the
      // "Office manager" information via displayName + worker_of.titleAtB.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `contacts-import: attach office-manager profession failed for bp ${created.id}: ${message}`,
      );
    }
    return created.id;
  }

  /**
   * QA4 R2 IMP-9 — persist a BP's primary + additional emails on the
   * new `business_partner_emails` table. Idempotent: an upsert on the
   * (bp, email) unique so a re-import lands on the same rows. Empty
   * emails are skipped. Passing `primaryEmail: null` still writes the
   * additional list — used when the org side already had a primary
   * from a prior run and we're only adding new alternates.
   */
  private async upsertPartnerEmails(
    partnerId: number,
    primaryEmail: string | null,
    additional: string[],
  ): Promise<void> {
    const rows: Array<{ email: string; isPrimary: boolean }> = [];
    const seen = new Set<string>();
    if (primaryEmail) {
      const p = primaryEmail.trim().toLowerCase();
      if (p) {
        rows.push({ email: p, isPrimary: true });
        seen.add(p);
      }
    }
    for (const a of additional) {
      const t = (a ?? '').trim().toLowerCase();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      rows.push({ email: t, isPrimary: false });
    }
    if (rows.length === 0) return;
    for (const row of rows) {
      try {
        await this.prisma.businessPartnerEmail.upsert({
          where: {
            businessPartnerId_email: {
              businessPartnerId: partnerId,
              email: row.email,
            },
          },
          create: {
            businessPartnerId: partnerId,
            email: row.email,
            isPrimary: row.isPrimary,
          },
          // On re-import, promote to primary if a newer routing decided
          // so; never demote a primary that was already set (avoids the
          // "second import silently un-flags the row's primary" case).
          update: row.isPrimary ? { isPrimary: true } : {},
        });
      } catch (err: unknown) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
          throw err;
        }
      }
    }
  }

  /**
   * QA4 R2 IMP-7 — resolve/seed a Profession row by its display name.
   * Idempotent: uses upsert on Profession.name (which is @unique). When
   * the name is "Office manager", both an English and a Hebrew
   * synonym match so a Hebrew-configured catalog isn't duplicated.
   * Returns null on empty input.
   */
  private async resolveProfessionId(title: string | null | undefined): Promise<number | null> {
    const t = (title ?? '').trim();
    if (!t) return null;

    // Prefer an existing case-insensitive match — the catalog may
    // already carry "Office Manager" (title-case) or "מנהלת משרד" and
    // the classifier's default is "Office manager". A plain unique on
    // name is case-sensitive at the DB level; walk both spellings.
    const exact = await this.prisma.profession.findFirst({
      where: {
        OR: [
          { name: { equals: t } },
          // Hebrew synonym for the default case — keeps a Hebrew-first
          // catalog collapsing onto one row.
          ...(t.toLowerCase() === 'office manager'
            ? [
                { name: { equals: 'מנהלת משרד' } },
                { name: { equals: 'מנהל משרד' } },
              ]
            : []),
        ],
      },
      select: { id: true },
    });
    if (exact) return exact.id;

    // Nothing matched — create by canonical spelling. Wrap in a
    // try/catch so a race with another import racing on the same
    // Profession name yields the existing row.
    try {
      const created = await this.prisma.profession.create({
        data: { name: t, sortOrder: 999 },
        select: { id: true },
      });
      return created.id;
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const again = await this.prisma.profession.findFirst({
          where: { name: { equals: t } },
          select: { id: true },
        });
        return again?.id ?? null;
      }
      throw err;
    }
  }

  /**
   * Cheap helper — creates the worker_of edge if it doesn't exist.
   * Mirrors the primary-side write (P2002 raced → treat as no-op).
   */
  private async linkWorkerOf(
    contactBpId: number,
    orgBpId: number,
    typeId: number,
    titleAtB: string | null,
  ): Promise<void> {
    const existing = await this.prisma.partnerRelationship.findFirst({
      where: { partyAId: contactBpId, partyBId: orgBpId, typeId },
      select: { id: true },
    });
    if (existing) return;
    try {
      await this.prisma.partnerRelationship.create({
        data: {
          partyAId: contactBpId,
          partyBId: orgBpId,
          typeId,
          isPrimary: false,
          titleAtB,
        },
      });
    } catch (err: unknown) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
        throw err;
      }
    }
  }

  private cachedWorkerOfIds: number[] | null = null;
  private async workerOfTypeIds(): Promise<number[]> {
    if (this.cachedWorkerOfIds != null) return this.cachedWorkerOfIds;
    const row = await this.prisma.partnerRelationshipType.findUnique({
      where: { code: 'worker_of' },
      select: { id: true },
    });
    this.cachedWorkerOfIds = row ? [row.id] : [];
    return this.cachedWorkerOfIds;
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

/**
 * Fields the wizard's Preview table (QA4 IMP-2) can override inline.
 * `officeManager` is not a canonical ContactField — see split-merge's
 * office-manager extraction (QA4 IMP-4); when present on the primary
 * row's override map it seeds a secondary Office-manager contact.
 */
export type OverrideField =
  | 'contact'
  | 'company'
  | 'phone'
  | 'mobile'
  | 'email'
  | 'discipline'
  | 'role'
  | 'officeManager';

export type RowOverrides = Partial<Record<OverrideField, string | null>>;

export interface RowDecision {
  sourceRowIndex: number;
  orgAction?: OrgAction;
  orgBpId?: number | null;
  contactAction?: ContactAction;
  contactBpId?: number | null;
  chosenEmail?: string;
  /**
   * QA4 IMP-2 — per-field overrides applied at commit time. When a
   * field is present in this map the override wins over the parsed
   * value; `null` explicitly clears the parsed value.
   */
  overrides?: RowOverrides;
  /**
   * QA4 R2b ORG-6 (2026-09-29) — reviewer removed the row via the
   * trash icon on the preview table. When true the commit skips the
   * row entirely: no person BP, no worker_of edge, no project
   * attach. Undo on the FE clears the flag.
   */
  skipped?: boolean;
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
  /**
   * QA4 R2b ORG-3 (2026-09-29) — user-picked BusinessPartnerRole per
   * distinct batch org key. Keys are the `batchOrgKey` strings emitted
   * by dedup.service.ts (`bp:<id>` / `domain:<host>` / `name:<slug>`);
   * values are `PartnerRoleType.code` (customer / supplier /
   * consultant / partner / …). Only orgs the batch pass CREATES get
   * their role written; matched-existing orgs are never downgraded.
   */
  orgTypes?: Record<string, string>;
  /**
   * QA4 E2 (2026-09-29) — inline overrides of a NEW org's identity
   * per batchOrgKey. `name` overrides both displayName + companyName;
   * `domain` (optional) replaces the domain claimed on commit.
   * Matched-existing orgs use E5 conflictResolutions instead.
   */
  orgOverrides?: Record<string, { name?: string; domain?: string }>;
  /**
   * QA4 E3 (2026-09-29) — orgs the reviewer deleted before commit.
   * List of batchOrgKeys; `orgDeleteMode` picks whether the org's
   * people cascade to skip or become individuals. When
   * `keep-people`, the wizard is expected to have supplied a
   * `personOrgOverrides` for every kept row (E6 gate).
   */
  orgDeleted?: string[];
  orgDeleteMode?: Record<string, 'cascade' | 'keep-people'>;
  /**
   * QA4 E4 (2026-09-29) — per-row org reassignment (drag/move + Move
   * to…). Keyed by sourceRowIndex; value is the target batchOrgKey.
   * `null` moves the row to "no org" (which the commit treats as an
   * orphan — E6 blocks commit on the FE unless every kept row has an
   * org). At commit we honour the override and re-key the person's
   * batchOrgKey lookup.
   */
  personOrgOverrides?: Record<number, string | null>;
  /**
   * QA4 E5 (2026-09-29) — per-record per-field conflict picks. Keyed
   * by a stable id (`org:<batchOrgKey>` or `person:<sourceRowIndex>`);
   * inner map value is `existing` (leave the DB value untouched) or
   * `imported` (overwrite with the row's value). Fields absent
   * default to `existing`.
   */
  conflictResolutions?: Record<string, Record<string, 'existing' | 'imported'>>;
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
  /**
   * QA4 IW-BUG (2026-09-30) — rows withheld by the belt-and-suspenders
   * orphan guard: a `create` person action reached the commit path with
   * `orgBpId === null`. The E6 gate on the FE already blocks commit for
   * orphans, so this list should always be EMPTY in practice; a
   * non-empty list means the FE gate was bypassed and the reviewer
   * needs to fix each row's org assignment before re-committing.
   */
  withheldOrphans?: Array<{
    sourceRowIndex: number;
    personKey: string;
    reason: string;
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

/**
 * QA4 IMP-4 — normalize a name/phone/email for cheap idempotent
 * comparison. Uppercases, strips punctuation + whitespace so a person
 * seen twice under slightly different formatting collapses.
 */
function normalizeCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s‐-―.\-'"׳״()]+/g, '')
    .trim();
}

/**
 * Build a compact notes body for a persisted secondary contact so the
 * PM can see later where it came from (which column, what city, and
 * the classifier's confidence). Truncated at 200 chars.
 */
function buildSecondaryNotes(s: SecondaryContact): string {
  const parts: string[] = [`Extracted from ${s.sourceField} cell`];
  if (s.city) parts.push(`city: ${s.city}`);
  if (s.confidence < 1) parts.push(`confidence: ${s.confidence}`);
  const joined = parts.join(' · ');
  return joined.length > 200 ? joined.slice(0, 200) : joined;
}

/**
 * QA4 R2 IMP-9 — classify an email address as a generic office
 * mailbox (routes to the ORG's email store) vs a personal address
 * (routes to the PERSON). Matches on the local part before `@`; the
 * generic prefixes are the ones the spec locks in — `office@`,
 * `info@`, `studio@`, `mail@` — plus the customary `contact@` /
 * `hello@` / `admin@` neighbours that show up on the same sheets.
 * Case-insensitive.
 */
function isGenericMailbox(email: string): boolean {
  const at = email.indexOf('@');
  if (at <= 0) return false;
  const local = email.slice(0, at).toLowerCase();
  const GENERIC_LOCAL_PARTS = new Set([
    'office',
    'info',
    'studio',
    'mail',
    'contact',
    'contacts',
    'hello',
    'admin',
    'reception',
    'sales',
    'support',
  ]);
  if (GENERIC_LOCAL_PARTS.has(local)) return true;
  // Handle "office.tel-aviv" / "office+jobs" style variants.
  const head = local.split(/[.+_-]/, 1)[0] ?? '';
  return GENERIC_LOCAL_PARTS.has(head);
}

/**
 * QA4 R2 IMP-10 — derive a stable `Discipline.code` from a free-text
 * discipline label. Truncated at 50 chars (schema limit). Prefix
 * `imp-` marks importer-created rows so ops can review + rename them
 * from the admin catalog.
 */
function deriveDisciplineCode(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 44);
  // Guarantee non-empty even for all-punctuation labels.
  const base = slug || 'discipline';
  return `imp-${base}`.slice(0, 50);
}

/**
 * QA4 R2b ORG-1 — mirror of the row-loop `routeEmails()` for the
 * batch materialisation pass. Given the leader row + its overrides,
 * return the generic mailbox that belongs on the org (or `null` when
 * the row only carries a personal address). Keeps `office@…` on the
 * org rather than on the first person committed for that org.
 */
function pickOrgPrimaryEmailForRow(
  dec: DedupDecision,
  dp: RowDecision | undefined,
): string | null {
  const overrides = dp?.overrides ?? {};
  const primary =
    ('email' in overrides
      ? overrides.email ?? null
      : dp?.chosenEmail ?? dec.values.email ?? null) ?? null;
  const universe: string[] = [];
  if (primary) universe.push(primary.toLowerCase());
  for (const e of dec.extraEmails ?? []) {
    const t = (e ?? '').trim().toLowerCase();
    if (t) universe.push(t);
  }
  const seen = new Set<string>();
  const uniq = universe.filter((e) => (seen.has(e) ? false : (seen.add(e), true)));
  for (const e of uniq) if (isGenericMailbox(e)) return e;
  return null;
}

/**
 * QA4 RD-3 (2026-09-29) — pick a safe org identity. Never let an
 * email address, a bare dash, or a single character become the org's
 * displayName / companyName: those are what Yulian's screenshots
 * showed after the pre-ORG-1 import (orgs literally titled
 * `aryeh@mra.co.il`, `—`, etc.). When the raw cell fails the
 * plausibility check we fall back to the group's domain (e.g.
 * `@mra.co.il`) so the PM sees the batch-shared identity and can
 * rename it after the import lands. `companyName` stays null in the
 * fallback path so the ORG-panel "matched by name" lookup doesn't
 * later reuse the fallback string for an unrelated file's rows.
 */
function deriveSafeOrgName(
  rawOrgName: string | null | undefined,
  domain: string | null | undefined,
): { displayName: string; companyName: string | null } {
  const trimmed = (rawOrgName ?? '').trim();
  if (trimmed && isPlausibleCompanyName(trimmed)) {
    return { displayName: trimmed, companyName: trimmed };
  }
  const cleanDomain = (domain ?? '').trim();
  if (cleanDomain && isDomainShaped(cleanDomain)) {
    return { displayName: `@${cleanDomain}`, companyName: null };
  }
  return { displayName: '(unnamed)', companyName: null };
}

const DOMAIN_SHAPE_RE_COMMIT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
function isDomainShaped(s: string): boolean {
  return DOMAIN_SHAPE_RE_COMMIT.test(s.trim());
}

function buildRunNotes(input: CommitInput, summary: { totalRows: number; eligible: number; belowContract: number }): string {
  const parts: string[] = [];
  if (input.notes?.trim()) parts.push(input.notes.trim());
  parts.push(
    `contacts wizard: sheet "${input.sheet.name ?? ''}" · ${summary.totalRows} rows (${summary.eligible} eligible, ${summary.belowContract} below contract) · mapping: ${Object.keys(input.mapping).sort().join(', ')}`,
  );
  return parts.join('\n');
}
