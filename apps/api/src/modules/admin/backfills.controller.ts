import * as fs from 'fs';
import * as path from 'path';

import { BadRequestException, Controller, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { CalendarDayType, Prisma } from '@prisma/client';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { ProjectDeliverablesService } from '../project-deliverables/project-deliverables.service';
import {
  extractServiceMarker,
  resolvePhasesByMarkerNames,
} from '../planning/marker-phase-resolver';
import { normalizeCompanyName } from '../data-import/contacts/dedup.service';
import {
  extractEmailDomain,
  PERSONAL_EMAIL_DOMAIN_FALLBACK,
} from '../business-partners/business-partners.service';

/**
 * One-shot admin backfill endpoints — mutations that fix historical
 * data drift and are safe to re-run (idempotent WHERE clauses). Not
 * wired into any UI; Yulian curls the endpoint once per staging /
 * prod deploy.
 *
 * Kept in the `admin` module and guarded by `admin:write` so only an
 * admin token can trigger a mass update. Every handler here MUST:
 *   • be idempotent — re-running with no matching rows returns
 *     `{ updated: 0 }` and never errors;
 *   • run the exact SQL that the queued file in
 *     `apps/api/prisma/backfills/` documents (the .sql file stays in
 *     place as the audit trail for what was executed);
 *   • return the affected-row count so the caller can confirm the
 *     write landed.
 */
@ApiTags('Admin - Backfills')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/backfills')
export class BackfillsController {
  constructor(
    private readonly prisma: PrismaService,
    // B5-3 (2026-10-20) — the user-business-partner backfill
    // reuses `UsersService.ensureBpForUser` + `syncEmployeeBpRole`
    // so historical orphan users land the exact same BP shape
    // that `UsersService.create` writes today, with no drift.
    private readonly usersService: UsersService,
    // B2.5 (2026-11-05) — the materialize-project-deliverables
    // backfill delegates to `ProjectDeliverablesService.materializeFromTasks`,
    // the single source of truth shared with the apply-template path in
    // `ZonesService` so the two can no longer drift.
    private readonly projectDeliverables: ProjectDeliverablesService,
  ) {}

  /**
   * Labor Category rename — Phase 2 Commit A (2026-09-28).
   *
   * The Admin > Job Titles catalog seeded a row called
   * "Proffesional employee" (extra F). This is the label rendered
   * on the People / Contacts / Admin > Job Titles surfaces. Fix the
   * typo. Idempotent: WHERE clause skips rows already renamed.
   *
   * Backing SQL is documented at
   * `apps/api/prisma/backfills/2026-09-28-profession-typo.sql` — do
   * not delete that file; it is the audit trail for what this
   * endpoint runs.
   */
  @Post('profession-typo')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'Backfill · rename "Proffesional employee" → "Professional employee" (idempotent)',
  })
  async runProfessionTypo() {
    const updated = await this.prisma.$executeRawUnsafe(
      "UPDATE profession SET name = 'Professional employee' WHERE name = 'Proffesional employee'",
    );
    return { updated };
  }

  /**
   * ProjectDeliverable → Service backfill (2026-09-29).
   *
   * `ProjectDeliverable.serviceId` should inherit from
   * `Template.phaseId` at creation time (see
   * `project-deliverables.service.ts::create`), but existing rows on
   * staging/prod that were created before that inheritance was in
   * place, or that were created without a `sourceTemplateId`, carry
   * `serviceId = NULL`. The result is the blank SERVICE column on the
   * project's zone-task views.
   *
   * This backfill sets `service_id = template.phase_id` for every
   * ProjectDeliverable where:
   *   • `service_id IS NULL`
   *   • AND `source_template_id IS NOT NULL`
   *   • AND the referenced template has a non-null `phase_id`
   *
   * Idempotent — re-running against a fully-backfilled table matches
   * zero rows and returns `{ updated: 0 }`. Safe to call after every
   * deploy while templates are still being renamed / relinked.
   *
   * Yulian reported the blank SERVICE column on project 32
   * (2026-09-29). This endpoint fixes the historical rows; new
   * deliverables created from templates already inherit correctly.
   */
  @Post('project-deliverable-service')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'Backfill · ProjectDeliverable.serviceId ← Template.phaseId when null (idempotent)',
  })
  async runProjectDeliverableService() {
    const updated = await this.prisma.$executeRawUnsafe(
      `UPDATE project_deliverables pd
         JOIN templates t ON t.id = pd.source_template_id
          SET pd.service_id = t.phase_id
        WHERE pd.service_id IS NULL
          AND pd.source_template_id IS NOT NULL
          AND t.phase_id IS NOT NULL
          AND pd.deleted_at IS NULL`,
    );
    return { updated };
  }

  /**
   * Task.phaseId backfill from `[SERVICE:xxx]` description marker
   * (QA4 · BF-1 · 2026-09-29 · durable follow-up to 94ebb43).
   *
   * `94ebb43` resolves the marker at READ time by name. That works,
   * but a future rename that is NOT a pure `\<suffix>` append silently
   * breaks resolution again — the marker still holds the old name.
   * The read resolver stays as defense-in-depth; this endpoint
   * persists the resolved phase into `task.phaseId` so future reads
   * use the FK (rename-proof).
   *
   * Candidate = every task with `phaseId IS NULL` + a `[SERVICE:`
   * marker + no `projectDeliverable.service` + no
   * `deliverableTemplate.phase`. Mirrors the resolver's own candidate
   * test exactly, so the backfill fixes only rows the resolver would
   * otherwise resolve at read time.
   *
   * Marker → template match is delegated to the SHARED helper
   * (`resolvePhasesByMarkerNames`) used by the read resolver — no
   * risk of drift between read and write.
   *
   * Writes `task.phaseId` ONLY. Does NOT touch `deliverableTemplateId`
   * (matched template is a `task_list` — wrong FK type). Leaves the
   * marker in `description` as provenance.
   *
   * Idempotent: once phaseId is set the candidate filter excludes the
   * row on re-run. Markers with no matching template stay NULL and
   * come back as `unresolved` on every run — safe.
   */
  @Post('task-service-phase')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'Backfill · task.phaseId ← [SERVICE:xxx] marker (idempotent, rename-proof follow-up to 94ebb43)',
  })
  async runTaskServicePhase() {
    // 1. Candidate tasks — phaseId NULL + marker prefix. Prisma keeps
    //    us safe from LIKE escaping here because `startsWith: '[SERVICE:'`
    //    contains no LIKE wildcards; MySQL treats every char as literal.
    const candidates = await this.prisma.task.findMany({
      where: {
        phaseId: null,
        deletedAt: null,
        description: { startsWith: '[SERVICE:' },
      },
      select: {
        id: true,
        description: true,
        projectDeliverable: { select: { service: { select: { name: true } } } },
        deliverableTemplate: { select: { phase: { select: { name: true } } } },
      },
    });

    // 2. Keep only rows where BOTH sibling FKs are also empty and the
    //    marker regex matches (mirrors the read-resolver's own gate).
    type C = { id: number; marker: string };
    const filtered: C[] = [];
    for (const t of candidates) {
      if (t.projectDeliverable?.service?.name) continue;
      if (t.deliverableTemplate?.phase?.name) continue;
      const marker = extractServiceMarker(t.description);
      if (!marker) continue;
      filtered.push({ id: t.id, marker });
    }

    const beforeNullCandidates = filtered.length;
    if (filtered.length === 0) {
      return { updated: 0, unresolved: 0, candidatesBefore: 0 };
    }

    // 3. Resolve markers → phase via the shared helper.
    const markerNames = new Set(filtered.map((f) => f.marker));
    const phaseByMarker = await resolvePhasesByMarkerNames(this.prisma as any, markerNames);

    // 4. Group task ids by resolved phaseId so we can `updateMany`
    //    once per distinct phase (small number of phases in practice).
    const idsByPhase = new Map<number, number[]>();
    let unresolved = 0;
    for (const c of filtered) {
      const p = phaseByMarker.get(c.marker);
      if (!p) {
        unresolved++;
        continue;
      }
      if (!idsByPhase.has(p.id)) idsByPhase.set(p.id, []);
      idsByPhase.get(p.id)!.push(c.id);
    }

    let updated = 0;
    for (const [phaseId, ids] of idsByPhase) {
      const res = await this.prisma.task.updateMany({
        where: { id: { in: ids }, phaseId: null },
        data: { phaseId },
      });
      updated += res.count;
    }

    return {
      updated,
      unresolved,
      candidatesBefore: beforeNullCandidates,
    };
  }

  /**
   * QA4 JT-4 (2026-09-29) — Split "Job Title" into Position + Qualification.
   * See docs/bm2/qa4-jobtitle-position-qualification-split.md.
   *
   * Taxonomy (Yulian-approved 2026-09-29, verified vs staging DB):
   *   Positions (moved to `positions` catalog): CEO, HR manager, VP, Finance
   *   Qualifications (kept in `professions`, gate): BIM Coordinator,
   *   BIM manager, BIM Leader, BIM modeler, Domain lead, Lead MEP coordination
   *
   * SAFETY (per Yulian rule): before removing a moved profession from the
   * gate, verify no `ProjectRoleType.requiredProfessionIds` references
   * it. On the current staging DB, `team_leader` references CEO (id=5) +
   * VP (id=8). For those two the migration keeps the catalog row in
   * `professions` so gates continue to resolve; it moves ONLY the
   * person-links off (to Position) so people no longer inherit the
   * gate eligibility via them. HR manager (6) and Finance (10) are
   * NOT referenced anywhere and can go fully.
   *
   * Steps (all inside a $transaction so a failure rolls back cleanly):
   *   1. Upsert 4 rows in `positions` — codes are stable slugs (ceo,
   *      hr-manager, vp, finance). English name + Hebrew names picked
   *      to match the current profession names.
   *   2. For every BusinessPartner holding any of those 4 professions,
   *      set `positionId` to the matching new Position (first hit
   *      wins — a person carrying both CEO and VP as professions is
   *      exceedingly unlikely; if it does happen, the earlier match
   *      by our fixed order — CEO > VP > HR manager > Finance —
   *      wins). Then delete their `business_partner_professions`
   *      row(s) for those profession ids so the gate no longer
   *      resolves them.
   *   3. For non-gate-referenced professions (HR manager, Finance),
   *      also delete the `professions` catalog row so the list
   *      stops offering them. CEO + VP stay in the catalog.
   *
   * Idempotency: re-running finds no BP with those profession rows
   * (they were removed on the first pass) and no non-gated profession
   * rows (also removed). Everything is upsert / DELETE-WHERE-IS with
   * `updated: 0` on a second run.
   *
   * DoD (reported in the response):
   *   • positionsUpserted — always 4 on first run, 0 on re-run
   *   • personLinksMoved  — BP × Profession rows deleted (== people
   *                          transitioned to Position)
   *   • gateRowsRemoved   — `professions` catalog rows removed (2
   *                          expected: HR manager, Finance)
   *   • gateRowsKept      — profession rows kept because a gate
   *                          references them (2 expected: CEO, VP)
   */
  @Post('jobtitle-position-split')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'Backfill · move CEO / VP / HR manager / Finance from Profession gate to Position (idempotent; keeps gate-referenced rows)',
  })
  async runJobTitlePositionSplit() {
    // Yulian-approved catalog. Order is significant — earlier entries
    // win when a BP happens to carry more than one moved profession.
    const CATALOG: Array<{
      profession: string;
      positionCode: string;
      positionName: string;
      positionNameHe: string | null;
      sortOrder: number;
    }> = [
      { profession: 'CEO',        positionCode: 'ceo',        positionName: 'CEO',        positionNameHe: 'מנכ״ל',      sortOrder: 10 },
      { profession: 'VP',         positionCode: 'vp',         positionName: 'VP',         positionNameHe: 'סמנכ״ל',     sortOrder: 20 },
      { profession: 'HR manager', positionCode: 'hr-manager', positionName: 'HR manager', positionNameHe: 'מנהל משאבי אנוש', sortOrder: 30 },
      { profession: 'Finance',    positionCode: 'finance',    positionName: 'Finance',    positionNameHe: 'כספים',       sortOrder: 40 },
    ];

    return this.prisma.$transaction(async (tx) => {
      // 1. Upsert positions catalog.
      let positionsUpserted = 0;
      const positionByProfession = new Map<string, { id: number; profession: string }>();
      for (const c of CATALOG) {
        const pos = await tx.position.upsert({
          where: { code: c.positionCode },
          create: {
            code: c.positionCode,
            name: c.positionName,
            nameHe: c.positionNameHe,
            sortOrder: c.sortOrder,
            isActive: true,
          },
          update: {},
        });
        positionByProfession.set(c.profession, { id: pos.id, profession: c.profession });
        positionsUpserted++;
      }

      // 2. Find each source profession row + which BPs carry it.
      const sourceProfessions = await tx.profession.findMany({
        where: { name: { in: CATALOG.map((c) => c.profession) } },
        select: {
          id: true,
          name: true,
          partners: { select: { businessPartnerId: true, isPrimary: true } },
        },
      });

      // 3. Which of them are referenced by any `ProjectRoleType.requiredProfessionIds`?
      const referencedProfessionIds = new Set<number>();
      const gates = await tx.projectRoleType.findMany({
        where: { requiredProfessionIds: { not: null as any } },
        select: { requiredProfessionIds: true },
      });
      for (const g of gates) {
        const ids = Array.isArray(g.requiredProfessionIds)
          ? (g.requiredProfessionIds as number[])
          : [];
        for (const id of ids) referencedProfessionIds.add(id);
      }

      // 4. For each source profession, set the BP's positionId (in
      //    catalog order — earliest wins), then delete the BPP link.
      //    Track which BPs already got a positionId so a later
      //    profession doesn't overwrite.
      let personLinksMoved = 0;
      const bpsAlreadyPositioned = new Set<number>();
      for (const c of CATALOG) {
        const src = sourceProfessions.find((p) => p.name === c.profession);
        if (!src) continue;
        const pos = positionByProfession.get(c.profession);
        if (!pos) continue;
        for (const link of src.partners) {
          if (!bpsAlreadyPositioned.has(link.businessPartnerId)) {
            await tx.businessPartner.update({
              where: { id: link.businessPartnerId },
              data: { positionId: pos.id },
            });
            bpsAlreadyPositioned.add(link.businessPartnerId);
          }
        }
        const del = await tx.businessPartnerProfession.deleteMany({
          where: { professionId: src.id },
        });
        personLinksMoved += del.count;
      }

      // 5. Remove non-referenced profession catalog rows. Keep the
      //    referenced ones (CEO/VP on current staging).
      let gateRowsRemoved = 0;
      let gateRowsKept = 0;
      const removableIds: number[] = [];
      for (const src of sourceProfessions) {
        if (referencedProfessionIds.has(src.id)) {
          gateRowsKept++;
        } else {
          removableIds.push(src.id);
        }
      }
      if (removableIds.length > 0) {
        const del = await tx.profession.deleteMany({ where: { id: { in: removableIds } } });
        gateRowsRemoved = del.count;
      }

      return {
        positionsUpserted,
        personLinksMoved,
        gateRowsRemoved,
        gateRowsKept,
        referencedProfessionIds: Array.from(referencedProfessionIds),
      };
    });
  }

  /**
   * QA4 · DP-EMPTY-1 (2026-09-30) — Materialize ProjectDeliverable rows
   * for every task whose deliverable dimension is unpersisted.
   *
   * Root cause (verified live on staging, project 33): 32 tasks each
   * carry a `[SERVICE:<name>]` marker in `description`, yet the project
   * has 0 rows in `project_deliverables`. The Planning tab renders a
   * DELIVERABLE badge via a marker fallback, but Deliverable Planning
   * grid reads only real `ProjectDeliverable` rows → empty. Systemic:
   * ~13 projects, ~591 tasks currently in this state (182 via
   * `deliverableTemplateId`, 409 via `[SERVICE:…]` marker only).
   *
   * For every project, for each task where `projectDeliverableId IS NULL`:
   *   1. If `deliverableTemplateId` is set → resolve name from the
   *      Template row (also carry over `phaseId` → `serviceId`,
   *      `sortOrder`, `sourceTemplateId`).
   *   2. Else parse the `[SERVICE:<name>]` marker (shared regex via
   *      `extractServiceMarker`). Task's own `phaseId` seeds the new
   *      deliverable's `serviceId` when consistent within the group.
   *
   * Group tasks by (projectId, resolvedName). For each group either
   * REUSE an existing `ProjectDeliverable` (idempotent — re-run is a
   * no-op) or CREATE one. Then repoint every task's
   * `projectDeliverableId` to that row.
   *
   * If tasks in a group disagree on `phaseId`, the deliverable is still
   * created but with `serviceId = null`; the disagreement is reported
   * as `phaseConflicts` per project so Yulian can inspect.
   *
   * Wrapped in a per-project `$transaction` — a bad project doesn't
   * roll back the whole batch. Same summary shape returned for dry-run
   * and execute so a diff is trivial.
   *
   * Query param: `?dryRun=true` (any truthy string) — reads only, writes
   * nothing. Default is EXECUTE so a plain POST runs the backfill;
   * Yulian invokes with `dryRun=true` first, reviews, then re-invokes
   * without the flag to execute.
   */
  @Post('materialize-project-deliverables')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'Backfill · materialize ProjectDeliverable rows from task deliverableTemplateId or [SERVICE:xxx] marker (idempotent; ?dryRun=true for plan-only)',
  })
  @ApiQuery({ name: 'dryRun', required: false, type: String, description: 'Truthy → plan only, no writes' })
  async runMaterializeProjectDeliverables(@Query('dryRun') dryRunRaw?: string) {
    const dryRun =
      typeof dryRunRaw === 'string' &&
      ['1', 'true', 'yes', 'on'].includes(dryRunRaw.toLowerCase());

    // 2026-11-05 — this endpoint now DELEGATES per-project to
    // `ProjectDeliverablesService.materializeFromTasks` (the single
    // source of truth shared with ZonesService's apply-template path).
    // The resolution rules (deliverableTemplate.name vs `[SERVICE:…]`
    // marker), reuse-vs-create decision, sortOrder seeding, and the
    // task-repoint step all live in the service.

    // 1. Candidate projects — one `findMany({ distinct })` so we don't
    //    load every task row into this process before materializing.
    //    `projectId: { not: null }` scopes out personal tasks and
    //    orphan rows.
    const candidateRows = await this.prisma.task.findMany({
      where: {
        projectDeliverableId: null,
        deletedAt: null,
        projectId: { not: null },
      },
      select: { projectId: true },
      distinct: ['projectId'],
    });
    const candidateProjectIds = candidateRows
      .map((t) => t.projectId)
      .filter((id): id is number => id != null)
      .sort((a, b) => a - b);

    // 2. Resolve project names up-front for the response payload; keeps
    //    the per-project loop body to a single service call + a name
    //    lookup.
    const projectRows = candidateProjectIds.length
      ? await this.prisma.project.findMany({
          where: { id: { in: candidateProjectIds } },
          select: { id: true, name: true },
        })
      : [];
    const projectNameById = new Map(projectRows.map((p) => [p.id, p.name]));

    // 3. Per-project delegation. Executes use a short per-project
    //    `$transaction` so a bad project doesn't poison the batch; the
    //    dry-run path reads only and skips the transaction.
    let totalCreated = 0;
    let totalRepointed = 0;
    let projectsTouched = 0;
    let totalUnresolved = 0;
    const perProject: Array<{
      projectId: number;
      projectName: string;
      deliverablesToCreate: Array<{
        name: string;
        sourcePhaseId: number | null;
        sourceTemplateId: number | null;
        taskCount: number;
        taskIds: number[];
      }>;
      deliverablesToReuse: Array<{
        existingId: number;
        name: string;
        taskCount: number;
        taskIds: number[];
      }>;
      unresolvedTasks: Array<{ taskId: number; reason: string }>;
      phaseConflicts: Array<{ deliverableName: string; phaseIds: number[] }>;
    }> = [];

    for (const projectId of candidateProjectIds) {
      const result = dryRun
        ? await this.projectDeliverables.materializeFromTasks(projectId, {
            dryRun: true,
          })
        : await this.prisma.$transaction((tx) =>
            this.projectDeliverables.materializeFromTasks(projectId, { tx }),
          );

      const anythingToDo =
        result.deliverablesToCreate.length > 0 ||
        result.deliverablesToReuse.length > 0;

      if (anythingToDo) {
        totalCreated += result.created;
        totalRepointed += result.repointed;
        projectsTouched++;
      }
      totalUnresolved += result.unresolvedTasks.length;

      perProject.push({
        projectId,
        projectName: projectNameById.get(projectId) ?? `Project #${projectId}`,
        deliverablesToCreate: result.deliverablesToCreate,
        deliverablesToReuse: result.deliverablesToReuse,
        unresolvedTasks: result.unresolvedTasks,
        phaseConflicts: result.phaseConflicts,
      });
    }

    perProject.sort((a, b) => a.projectId - b.projectId);

    return {
      dryRun,
      projectsProcessed: perProject.length,
      perProject,
      totals: {
        deliverablesCreated: totalCreated,
        tasksRepointed: totalRepointed,
        projectsTouched,
        unresolvedCount: totalUnresolved,
      },
    };
  }

  /**
   * DP · empty-ZDT cleanup (2026-11-03).
   *
   * Root cause (verified on staging, project 40 "אזור תעסוקה דרומי יקנעם"):
   * the pre-2026-11-03 `project-deliverables.service` grid save walked
   * every row — including "no target" cells — and upserted a
   * `ZoneDeliverableTarget` with `targetDate=null`, `targetMonths=null`,
   * `estimatedDurationWeeks=null` for each. These all-null rows have
   * no planning meaning, but the DP scoping (`connectionsByDeliverable`
   * in `deliverable-planning-tab.tsx`) treated any ZDT as an
   * intent-to-plan and emitted the deliverable under every zone that
   * carried a ghost row. On project 40 this showered every deliverable
   * (185–191) under both top-zones instead of its real one.
   *
   * The write-path fix (same date) stops NEW empty rows from being
   * created and auto-deletes any ZDT that is cleared to empty. This
   * backfill sweeps the historical rows so staging/prod match the
   * post-fix invariant.
   *
   * Deletes every `ZoneDeliverableTarget` where ALL of:
   *   • `targetDate IS NULL`
   *   • `targetMonths IS NULL`
   *   • `estimatedDurationWeeks IS NULL`
   *
   * The FE fix already renders empty rows harmless; this endpoint just
   * removes the noise so the DB stays truthful ("a ZDT only exists for
   * a real target"). Idempotent — a re-run after a clean sweep finds
   * zero rows and returns `deleted: 0`.
   *
   * Query param `?dryRun=1|true|yes|on` → read-only; returns the plan
   * (per-project row count) so Yulian can sanity-check scope before
   * the real run. The plural `?dryRun=true` default across admin
   * backfills is retained.
   *
   * Response shape:
   *   { scanned, wouldDelete, deleted, projects: [{ id, name, count }] }
   */
  @Post('empty-zone-deliverable-targets')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'Backfill · delete empty ZoneDeliverableTarget rows (targetDate+targetMonths+estimatedDurationWeeks all null; idempotent; ?dryRun=1|true|yes|on for plan-only)',
  })
  @ApiQuery({ name: 'dryRun', required: false, type: String, description: 'Truthy → plan only, no writes' })
  async runEmptyZoneDeliverableTargets(@Query('dryRun') dryRunRaw?: string) {
    const dryRun =
      typeof dryRunRaw === 'string' &&
      ['1', 'true', 'yes', 'on'].includes(dryRunRaw.toLowerCase());

    // 1. Scan every ghost ZDT. Prisma's `null` on each of the three
    //    target columns is exactly the all-null case the DP scoping
    //    treats as a false connection.
    const rows = await this.prisma.zoneDeliverableTarget.findMany({
      where: {
        targetDate: null,
        targetMonths: null,
        estimatedDurationWeeks: null,
      },
      select: {
        zoneId: true,
        projectDeliverableId: true,
        projectDeliverable: {
          select: {
            projectId: true,
            project: { select: { id: true, name: true } },
          },
        },
      },
    });

    const scanned = rows.length;

    // 2. Group by project so Yulian can eyeball the scope before the
    //    real run (expected ~14 on project 40 per the work order).
    const projectMap = new Map<number, { id: number; name: string; count: number }>();
    for (const r of rows) {
      const projectId = r.projectDeliverable?.projectId ?? 0;
      const projectName = r.projectDeliverable?.project?.name ?? `(unknown project ${projectId})`;
      const existing = projectMap.get(projectId);
      if (existing) existing.count++;
      else projectMap.set(projectId, { id: projectId, name: projectName, count: 1 });
    }
    const projects = Array.from(projectMap.values()).sort((a, b) => a.id - b.id);

    if (dryRun) {
      return { scanned, wouldDelete: scanned, deleted: 0, projects };
    }

    // 3. Real run — single-statement deleteMany inside a transaction.
    //    No pre-count/match-count race window: a row created between
    //    the scan and the delete is covered too, since the WHERE
    //    matches structural shape, not row ids. Idempotent: zero rows
    //    returns zero.
    const deleted = scanned === 0
      ? 0
      : await this.prisma.$transaction(async (tx) => {
          const res = await tx.zoneDeliverableTarget.deleteMany({
            where: {
              targetDate: null,
              targetMonths: null,
              estimatedDurationWeeks: null,
            },
          });
          return res.count;
        });

    return { scanned, wouldDelete: scanned, deleted, projects };
  }

  /**
   * QA4 CT-DEDUP (2026-09-30) — merge duplicate organization BPs.
   *
   * Motivating case (verified on staging 2026-09-30):
   *   • 75 non-deleted org BPs total in the catalog
   *   • 7 duplicated normalized names (top: "ברן ישראל" ×5,
   *     "נתיבי ישראל" ×4, "גיאו -פרוספקט" ×4). Every "ברן ישראל"
   *     row is one PERSON's row shoved into the org table (IW-6
   *     bug — the person's `Ilan.Turbiner@barangroup.com` was
   *     stamped as the org's email, and the row-per-person shape
   *     stuck around).
   *   • 63 distinct orgs referenced by any `worker_of` edge, so
   *     the By-Organization view already collapses to 63 while the
   *     catalog reads 75. This backfill closes the gap.
   *
   * Grouping key (mirrors the importer's own dedup order — see
   * `contacts/dedup.service.ts::computeBatchOrgKey`):
   *   1. `domain:<host>` — the org has a claimed corporate domain
   *      in `business_partner_domains` (`is_personal=false`), OR
   *      its `email` extracts to a non-personal domain. Strongest
   *      "same firm" signal.
   *   2. `name:<slug>` — normalized `displayName`
   *      (`normalizeCompanyName`, same helper the importer uses so
   *      cleanup keys match importer keys byte-for-byte).
   *   3. no key → row is not groupable (unique org, left alone).
   *
   * Survivor selection per group (deterministic, no ambiguity):
   *   A. oldest id (lowest numeric id — the row that was created
   *      first);
   *   B. tie-break: prefer the one carrying a claimed non-personal
   *      domain;
   *   C. tie-break: prefer the one with the most non-null fields
   *      (count of {displayName, email, phone, taxId, address,
   *      notes} that are set).
   *
   * For each group with ≥ 2 members, at EXECUTE time:
   *   1. Repoint every FK from every loser → survivor:
   *      • `partner_relationships.party_a_id`
   *      • `partner_relationships.party_b_id` (the worker_of edges)
   *      • `project_partner_roles.party_id`
   *      • `project_partner_roles.contact_party_id`
   *      • `project_partner_roles.on_behalf_of_party_id`
   *      • `business_partner_domains.partner_id`
   *      • `business_partner_emails.business_partner_id`
   *      • `business_partner_roles.business_partner_id`
   *      • `business_partner_professions.business_partner_id`
   *        (defensive — orgs shouldn't hold professions, but the
   *         schema allows it and cheap to repoint)
   *      • `contracts.party_id`
   *      • `users.business_partner_id` (defensive; the constraint
   *         is 1:1 so at most one loser can carry a user, and orgs
   *         shouldn't have one)
   *      P2002 (unique conflict when survivor already has the same
   *      pair) is swallowed as no-op → the survivor already has
   *      that edge, so the loser's edge just dies with the row.
   *   2. Fix email on the survivor: if the survivor's own email
   *      looks personal (person-name local part on any of the
   *      group's domains) OR matches any of the losers' persons'
   *      emails, replace with a routed generic mailbox (`office@`
   *      / `info@` / …) if any member of the group carries one on
   *      its email or its `BusinessPartnerEmail` rows — else clear
   *      to `null`. Same routing rule as the importer.
   *   3. Soft-delete losers: `deletedAt = now()`. Never
   *      hard-delete — the audit trail stays intact.
   *
   * Typo safety: two orgs with the SAME normalized name but
   * DIFFERENT claimed domains (real case on staging: `ברן ישראל`
   * id=77 domain=`barangroup.com` vs `ברן ישראל` id=83
   * domain=`barangroip.com`) are NEVER auto-merged. They land in
   * `manualReviewCandidates` on the response so Yulian can decide
   * (fix the typo domain, or genuinely two firms with the same
   * Hebrew name).
   *
   * Query param `dryRun=true` (any truthy string) — computes the
   * merge plan and returns it without a single write. `false` /
   * omitted → EXECUTE. Per Yulian's rule the endpoint ships with
   * dry-run OPTIONAL, so `?dryRun=true` MUST be set on the first
   * invocation.
   *
   * Wrapped in per-group `$transaction` — a single bad group does
   * not roll back the whole batch. P2002 stays inside the group
   * as a no-op; unexpected errors bubble to the group's error
   * counter without corrupting siblings.
   *
   * Admin role guard: same `admin:write` as JT-4 above.
   */
  @Post('merge-duplicate-orgs')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'Backfill · merge duplicate organization BPs by claimed domain / normalized name (dry-run required first)',
  })
  @ApiQuery({ name: 'dryRun', required: false, type: String, description: 'Truthy → plan only, no writes' })
  async runMergeDuplicateOrgs(@Query('dryRun') dryRunRaw?: string) {
    const dryRun =
      typeof dryRunRaw === 'string' &&
      ['1', 'true', 'yes', 'on'].includes(dryRunRaw.toLowerCase());

    // ─── Local helpers ────────────────────────────────────────────
    // Personal-mailbox classifier — same set the importer uses. Kept
    // inline so CT-DEDUP has zero coupling to `commit.service.ts`
    // (which is not exported).
    const GENERIC_LOCAL_PARTS = new Set([
      'office', 'info', 'studio', 'mail',
      'contact', 'contacts', 'hello', 'admin',
      'reception', 'sales', 'support',
    ]);
    const isGenericMailbox = (email: string): boolean => {
      const at = email.indexOf('@');
      if (at <= 0) return false;
      const local = email.slice(0, at).toLowerCase();
      if (GENERIC_LOCAL_PARTS.has(local)) return true;
      const head = local.split(/[.+_-]/, 1)[0] ?? '';
      return GENERIC_LOCAL_PARTS.has(head);
    };
    // Does this email's local part look like a personal address?
    // (dot in local part like `first.last`, OR just a person-name
    // slug like `alex`). Excludes generic mailboxes explicitly.
    const isPersonLikeEmail = (email: string | null): boolean => {
      if (!email) return false;
      const at = email.indexOf('@');
      if (at <= 0) return false;
      const local = email.slice(0, at).toLowerCase();
      if (!local) return false;
      if (isGenericMailbox(email)) return false;
      // A dot in the local part is a strong personal signal
      // (first.last), and a name-only slug also reads as personal
      // on the sheets we're cleaning up.
      return /[.]/.test(local) || /^[a-z]+[a-z0-9]*$/.test(local);
    };
    // Personal-domain check — combines the hard-coded fallback set
    // with the admin-managed catalog so a domain the admin marked
    // personal after seeding counts as personal here too. Cached
    // per-call.
    const personalDomainsFromCatalog = new Set<string>(
      (await this.prisma.personalEmailDomain.findMany({
        select: { domain: true },
      })).map((r) => r.domain.toLowerCase()),
    );
    const isPersonalDomain = (domain: string): boolean => {
      const d = domain.toLowerCase();
      return PERSONAL_EMAIL_DOMAIN_FALLBACK.has(d) || personalDomainsFromCatalog.has(d);
    };

    // Count "completeness" for survivor tie-break (C).
    const completeness = (o: {
      displayName: string | null;
      email: string | null;
      phone: string | null;
      taxId: string | null;
      address: string | null;
      notes: string | null;
    }): number => {
      let n = 0;
      if (o.displayName && o.displayName.trim()) n++;
      if (o.email && o.email.trim()) n++;
      if (o.phone && o.phone.trim()) n++;
      if (o.taxId && o.taxId.trim()) n++;
      if (o.address && o.address.trim()) n++;
      if (o.notes && o.notes.trim()) n++;
      return n;
    };

    // ─── 1. Load every non-deleted org BP + its non-personal
    //        claimed domains + its additional-email rows. Cost: 3
    //        queries total for the whole catalog. ──────────────────
    const orgs = await this.prisma.businessPartner.findMany({
      where: { partnerType: 'organization', deletedAt: null },
      select: {
        id: true,
        displayName: true,
        companyName: true,
        email: true,
        phone: true,
        taxId: true,
        address: true,
        notes: true,
        domains: { select: { domain: true, isPersonal: true } },
        emails: { select: { email: true, isPrimary: true } },
      },
      orderBy: { id: 'asc' },
    });

    // Resolve each org's "claimed domain" (first non-personal
    // domain from `business_partner_domains`, else the email
    // domain when non-personal). Used both for grouping and for
    // survivor tie-break B.
    type OrgRow = (typeof orgs)[number] & {
      claimedDomain: string | null;
      allDomains: string[]; // every non-personal domain (bp_domains + email)
      genericMailboxes: string[]; // every generic mailbox on this org
      personLikeEmails: string[]; // person-shaped emails currently on this org
    };
    const enriched: OrgRow[] = orgs.map((o) => {
      // Collect every non-personal domain claim for this row.
      const bpDomains = (o.domains ?? [])
        .filter((d) => !d.isPersonal)
        .map((d) => d.domain.toLowerCase())
        .filter((d) => !!d && !isPersonalDomain(d));
      const emailDomain = extractEmailDomain(o.email);
      const emailDomainNonPersonal =
        emailDomain && !isPersonalDomain(emailDomain) ? emailDomain : null;
      const allDomainsSet = new Set<string>();
      for (const d of bpDomains) allDomainsSet.add(d);
      if (emailDomainNonPersonal) allDomainsSet.add(emailDomainNonPersonal);
      const allDomains = Array.from(allDomainsSet);
      // Prefer the explicit `business_partner_domains` row (that's
      // the intentional claim); fall back to the email domain.
      const claimedDomain = bpDomains[0] ?? emailDomainNonPersonal ?? null;

      // Scan every email associated with the org (primary + rows)
      // for generic mailboxes and person-shaped addresses.
      const emailUniverse = new Set<string>();
      if (o.email) emailUniverse.add(o.email.toLowerCase());
      for (const e of o.emails ?? []) {
        if (e.email) emailUniverse.add(e.email.toLowerCase());
      }
      const genericMailboxes = [...emailUniverse].filter(isGenericMailbox);
      const personLikeEmails = [...emailUniverse].filter(isPersonLikeEmail);
      return {
        ...o,
        claimedDomain,
        allDomains,
        genericMailboxes,
        personLikeEmails,
      };
    });

    // ─── 2. Bucket by (a) domain, then (b) normalized name.
    //        `by domain` wins so a group that shares a corporate
    //        domain collapses even if names drift slightly. ────────
    const groupsByKey = new Map<string, OrgRow[]>();
    const orgIdToKey = new Map<number, string>();
    for (const o of enriched) {
      let key: string | null = null;
      if (o.claimedDomain) key = `domain:${o.claimedDomain}`;
      if (!key) {
        const nameKey = normalizeCompanyName(o.displayName ?? '');
        if (nameKey) key = `name:${nameKey}`;
      }
      if (!key) continue; // ungrouped — never touched
      orgIdToKey.set(o.id, key);
      const arr = groupsByKey.get(key) ?? [];
      arr.push(o);
      groupsByKey.set(key, arr);
    }

    // ─── 3. Detect manual-review candidates.
    //        These are org rows that share a NAME slug but disagree
    //        on their claimed domain (real case: ברן ישראל +
    //        barangroup.com vs +barangroip.com typo). We never
    //        auto-merge those — the analyst has to decide whether
    //        one is a typo. Rows land BOTH in `groupsByKey` under
    //        their own domain key AND in `manualReviewCandidates`
    //        so the analyst sees them explicitly. ──────────────────
    const nameGroups = new Map<string, OrgRow[]>();
    for (const o of enriched) {
      const nameKey = normalizeCompanyName(o.displayName ?? '');
      if (!nameKey) continue;
      const arr = nameGroups.get(`name:${nameKey}`) ?? [];
      arr.push(o);
      nameGroups.set(`name:${nameKey}`, arr);
    }
    const manualReviewCandidates: Array<{
      reason: 'domain-mismatch-in-name-group';
      key: string;
      members: Array<{ id: number; displayName: string; claimedDomain: string | null }>;
    }> = [];
    for (const [key, arr] of nameGroups) {
      if (arr.length < 2) continue;
      const domainSet = new Set(arr.map((o) => o.claimedDomain).filter(Boolean) as string[]);
      // > 1 distinct domain in the same name-group → typo suspicion.
      // Also: a single-domain group where SOME members have no
      // claimed domain is NOT a manual case (they collapse under
      // that domain naturally). Only alarm on the mismatch shape.
      if (domainSet.size >= 2) {
        manualReviewCandidates.push({
          reason: 'domain-mismatch-in-name-group',
          key,
          members: arr.map((o) => ({
            id: o.id,
            displayName: o.displayName ?? '',
            claimedDomain: o.claimedDomain,
          })),
        });
      }
    }
    // Every id that participates in a manual-review group is EXCLUDED
    // from the auto-merge plan below, so we never touch a row the
    // analyst has to inspect first.
    const manualReviewIds = new Set<number>();
    for (const m of manualReviewCandidates) {
      for (const x of m.members) manualReviewIds.add(x.id);
    }

    // ─── 4. Build the merge plan per (grouped, ≥ 2 members, no
    //        manual-review-flagged members) group. ─────────────────
    type PlanGroup = {
      key: string;
      keyKind: 'domain' | 'name';
      survivor: OrgRow;
      losers: OrgRow[];
      emailAction: 'keep' | 'replaceWith' | 'clearToNull';
      newEmail: string | null;
    };
    const plan: PlanGroup[] = [];
    let groupsScanned = 0;
    for (const [key, members] of groupsByKey) {
      groupsScanned++;
      if (members.length < 2) continue;
      // If ANY member is in the manual-review set, punt the whole
      // group — the analyst is going to reshape it.
      if (members.some((m) => manualReviewIds.has(m.id))) continue;

      // Survivor selection: oldest id (A) → domain (B) → completeness (C).
      const sorted = [...members].sort((a, b) => {
        // A. oldest id wins
        if (a.id !== b.id) return a.id - b.id;
        return 0;
      });
      // Apply tie-breaks by re-sorting when the winner is ambiguous.
      // In practice A already picks a single row; B and C are safety
      // nets if two rows shared an id (impossible under a proper PK,
      // but the spec asks for them explicitly).
      const oldestId = sorted[0].id;
      const oldestTie = sorted.filter((m) => m.id === oldestId);
      let survivor: OrgRow;
      if (oldestTie.length === 1) {
        survivor = oldestTie[0];
      } else {
        // B. prefer claimed domain
        const withDomain = oldestTie.filter((m) => m.claimedDomain != null);
        if (withDomain.length === 1) survivor = withDomain[0];
        else {
          const pool = withDomain.length > 0 ? withDomain : oldestTie;
          // C. prefer most complete
          survivor = pool.slice().sort((a, b) => completeness(b) - completeness(a))[0];
        }
      }
      const losers = members.filter((m) => m.id !== survivor.id);

      // Decide the survivor's email:
      //   • KEEP when the survivor's email is either null OR
      //     already generic (office@ / info@).
      //   • CLEAR TO NULL when the survivor's email is person-shaped
      //     (`first.last@…`, `alex@…`) — do NOT put a person's
      //     mailbox on an org.
      //   • REPLACE WITH when the group carries at least one
      //     generic mailbox anywhere. The chosen mailbox is the
      //     first generic mailbox from survivor.email, then any
      //     loser's email, then survivor.emails rows, then any
      //     loser's emails rows. Deterministic.
      const groupGenerics: string[] = [];
      for (const m of [survivor, ...losers]) {
        for (const g of m.genericMailboxes) {
          if (!groupGenerics.includes(g)) groupGenerics.push(g);
        }
      }
      const survivorEmailLower = (survivor.email ?? '').trim().toLowerCase() || null;
      const survivorIsGeneric = !!survivorEmailLower && isGenericMailbox(survivorEmailLower);
      const survivorIsPersonLike = !!survivorEmailLower && isPersonLikeEmail(survivorEmailLower);
      let emailAction: 'keep' | 'replaceWith' | 'clearToNull';
      let newEmail: string | null = null;
      if (!survivorEmailLower || survivorIsGeneric) {
        emailAction = 'keep';
        newEmail = survivorEmailLower;
        // Even when "keep", if the survivor is null but the group
        // has a generic, promote — that's the IW-6 shape.
        if (!survivorEmailLower && groupGenerics.length > 0) {
          emailAction = 'replaceWith';
          newEmail = groupGenerics[0];
        }
      } else if (survivorIsPersonLike) {
        if (groupGenerics.length > 0) {
          emailAction = 'replaceWith';
          newEmail = groupGenerics[0];
        } else {
          emailAction = 'clearToNull';
          newEmail = null;
        }
      } else {
        // Not clearly generic, not clearly personal (e.g. `sales@`
        // that wasn't in our set) — leave alone.
        emailAction = 'keep';
        newEmail = survivorEmailLower;
      }

      plan.push({
        key,
        keyKind: key.startsWith('domain:') ? 'domain' : 'name',
        survivor,
        losers,
        emailAction,
        newEmail,
      });
    }

    // ─── 5. Execute per group (skipped when dryRun). Each group's
    //        writes wrap in a $transaction so a bad group doesn't
    //        drag the batch down. ─────────────────────────────────
    let groupsMerged = 0;
    let losersSoftDeleted = 0;
    let edgesRepointed = 0;
    let emailsCleaned = 0;
    const executeErrors: Array<{ key: string; error: string }> = [];

    if (!dryRun) {
      // Look up the worker_of type id once — needed only for reporting.
      const workerOfType = await this.prisma.partnerRelationshipType.findUnique({
        where: { code: 'worker_of' },
        select: { id: true },
      });
      void workerOfType; // reserved for future per-edge reporting

      for (const g of plan) {
        try {
          await this.prisma.$transaction(async (tx) => {
            const loserIds = g.losers.map((l) => l.id);
            const survivorId = g.survivor.id;

            // Repoint helper — runs an updateMany from loser fk =
            // survivorId, catching P2002. Returns rows updated
            // (which is 0 when the survivor already had the same
            // pair — the loser's original row just dies with the
            // soft-delete because CASCADE is on the loser).
            //
            // Prisma's updateMany does not raise P2002 in the same
            // way as create; the DB does. We catch it and skip.
            const safeRepoint = async (
              model: keyof Prisma.TransactionClient,
              field: string,
              extraWhere: Record<string, unknown> = {},
            ): Promise<number> => {
              try {
                const res = await (tx as any)[model].updateMany({
                  where: { [field]: { in: loserIds }, ...extraWhere },
                  data: { [field]: survivorId },
                });
                return res.count as number;
              } catch (err) {
                if (
                  err instanceof Prisma.PrismaClientKnownRequestError &&
                  err.code === 'P2002'
                ) {
                  // Fall back to per-row: skip losing edges that
                  // would collide with an existing survivor edge.
                  let count = 0;
                  // The generic path — read rows, try one-by-one.
                  const rows: Array<{ id: number }> = await (tx as any)[model].findMany({
                    where: { [field]: { in: loserIds }, ...extraWhere },
                    select: { id: true },
                  });
                  for (const r of rows) {
                    try {
                      await (tx as any)[model].update({
                        where: { id: r.id },
                        data: { [field]: survivorId },
                      });
                      count++;
                    } catch (err2) {
                      if (
                        !(err2 instanceof Prisma.PrismaClientKnownRequestError &&
                          err2.code === 'P2002')
                      ) {
                        throw err2;
                      }
                      // Loser row conflicts with survivor's existing
                      // row — leave it. It goes away with the loser.
                    }
                  }
                  return count;
                }
                throw err;
              }
            };

            // Party↔party edges (worker_of + any other type).
            edgesRepointed += await safeRepoint('partnerRelationship', 'partyAId');
            edgesRepointed += await safeRepoint('partnerRelationship', 'partyBId');
            // Project participation.
            edgesRepointed += await safeRepoint('projectPartnerRole', 'partyId');
            edgesRepointed += await safeRepoint('projectPartnerRole', 'contactPartyId');
            edgesRepointed += await safeRepoint('projectPartnerRole', 'onBehalfOfPartyId');
            // Domain claims + email rows + partner-role tags +
            // profession tags. Each has a unique constraint on
            // (bp, foo); safeRepoint catches P2002 and skips.
            edgesRepointed += await safeRepoint('businessPartnerDomain', 'partnerId');
            edgesRepointed += await safeRepoint('businessPartnerEmail', 'businessPartnerId');
            edgesRepointed += await safeRepoint('businessPartnerRole', 'businessPartnerId');
            edgesRepointed += await safeRepoint('businessPartnerProfession', 'businessPartnerId');
            // Contracts as party.
            edgesRepointed += await safeRepoint('contract', 'partyId');
            // Users — defensive (an org shouldn't hold one but
            // the schema allows it and this catches drift).
            edgesRepointed += await safeRepoint('user', 'businessPartnerId');

            // Fix email on survivor.
            if (g.emailAction === 'replaceWith') {
              await tx.businessPartner.update({
                where: { id: survivorId },
                data: { email: g.newEmail },
              });
              emailsCleaned++;
            } else if (g.emailAction === 'clearToNull') {
              await tx.businessPartner.update({
                where: { id: survivorId },
                data: { email: null },
              });
              emailsCleaned++;
            }

            // Soft-delete losers.
            const del = await tx.businessPartner.updateMany({
              where: { id: { in: loserIds }, deletedAt: null },
              data: { deletedAt: new Date() },
            });
            losersSoftDeleted += del.count;
            groupsMerged++;
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          executeErrors.push({ key: g.key, error: message });
        }
      }
    } else {
      // Dry-run counters mirror what execute WOULD write.
      for (const g of plan) {
        groupsMerged++;
        losersSoftDeleted += g.losers.length;
        if (g.emailAction === 'replaceWith' || g.emailAction === 'clearToNull') {
          emailsCleaned++;
        }
        // edgesRepointed left as 0 for dry-run — computing the exact
        // count would require the same FK scan the execute path does,
        // which defeats "read-only preview" cheapness. The plan below
        // still shows per-group worker/role/domain counts.
      }
    }

    // ─── 6. Batched per-loser counts so the response shows how
    //        much each merge would move. Two group-bys keep this
    //        cheap regardless of plan size. Ran AFTER execute so
    //        the dry-run + execute paths reuse the same numbers
    //        (execute already updated pointers, but we captured
    //        the loser ids in `plan` before that). ──────────────
    const allLoserIds = plan.flatMap((g) => g.losers.map((l) => l.id));
    const workerCountByLoser = new Map<number, number>();
    const roleCountByLoser = new Map<number, number>();
    if (allLoserIds.length > 0 && dryRun) {
      // Only compute for the dry-run: after execute the counts on
      // the loser are all zero (they were repointed).
      const workerOfType = await this.prisma.partnerRelationshipType.findUnique({
        where: { code: 'worker_of' },
        select: { id: true },
      });
      if (workerOfType) {
        const workerRows = await this.prisma.partnerRelationship.groupBy({
          by: ['partyBId'],
          where: { partyBId: { in: allLoserIds }, typeId: workerOfType.id },
          _count: { _all: true },
        });
        for (const r of workerRows) {
          workerCountByLoser.set(r.partyBId, r._count._all);
        }
      }
      const roleRows = await this.prisma.projectPartnerRole.groupBy({
        by: ['partyId'],
        where: { partyId: { in: allLoserIds } },
        _count: { _all: true },
      });
      for (const r of roleRows) {
        roleCountByLoser.set(r.partyId, r._count._all);
      }
    }

    // ─── 7. Shape the response per the spec. ──────────────────────
    return {
      dryRun,
      groupsScanned,
      groupsToMerge: plan.map((g) => ({
        key: g.key,
        keyKind: g.keyKind,
        survivor: {
          id: g.survivor.id,
          displayName: g.survivor.displayName ?? '',
          email: g.survivor.email,
          claimedDomain: g.survivor.claimedDomain,
        },
        losers: g.losers.map((l) => ({
          id: l.id,
          displayName: l.displayName ?? '',
          email: l.email,
          claimedDomain: l.claimedDomain,
          workerCount: workerCountByLoser.get(l.id) ?? 0,
          roleCount: roleCountByLoser.get(l.id) ?? 0,
          domainCount: (l.domains ?? []).filter((d) => !d.isPersonal).length,
        })),
        emailAction: g.emailAction,
        newEmail: g.newEmail,
      })),
      manualReviewCandidates,
      totals: {
        groupsMerged,
        losersSoftDeleted,
        edgesRepointed,
        emailsCleaned,
        executeErrors: executeErrors.length,
      },
      executeErrors,
    };
  }

  /**
   * QA4 · DN-1 (2026-10-04) — Relink TemplateTask / TemplateZoneTask
   * rows whose `deliverableTemplateId` is NULL back to the live
   * Deliverable Template, parsing the carried `[SERVICE:<marker>]`
   * description marker.
   *
   * Context (verified live on staging 2026-10-04):
   *   • Zone-template rows written BEFORE QA4 B1 (2026-09-28)
   *     carry only the `[SERVICE:<name>]` marker in `description`;
   *     the `deliverableTemplateId` FK is NULL.
   *   • The FE prefers `task.deliverableTemplate?.name` with a
   *     fallback to the marker (read-only-zone-node.tsx L37,
   *     zone-tree-node.tsx L69). With the FK null, the FE falls
   *     back to the STALE marker — a Deliverable rename in the
   *     catalog never reaches the zone-template label.
   *   • Deliverable templates follow a `base\detail` naming
   *     convention. The marker contains only the `base` segment
   *     (the pre-rename name), so a strict exact-string match
   *     misses the renamed rows. The durable rule is: match on
   *     `name = <marker>` OR `name LIKE <marker>\%`.
   *
   * Example (staging): marker `תכנון ראשוני` → template id 18
   * `תכנון ראשוני\תשתית ודוח קריטי` (base-prefix match).
   *
   * TEMPLATES ONLY — this backfill never touches `Task` or
   * `ProjectDeliverable`. A project copies the template at pull
   * time; its `ProjectDeliverable` rows are an owned snapshot and
   * template renames must NOT propagate into existing projects.
   *
   * Marker regex: delegates to `extractServiceMarker` so this
   * endpoint cannot drift from the planning read-resolver or the
   * other backfills that read the same marker.
   *
   * Candidate lookup: Prisma's JS filter (same approach as
   * `resolvePhasesByMarkerNames`) — raw `LIKE 'm\%'` SQL would
   * require double-escaping the literal `\` and has been shown
   * (94ebb43) to zero-match on this schema. The catalog of
   * `type=task_list` templates is small (9 on staging), so an
   * in-memory filter is fine.
   *
   * Preference when multiple candidates match a marker:
   *   1. If the task carries a `serviceTypeId`, prefer a template
   *      whose `phaseId` matches the task's `phaseId` (templates
   *      key off phase, not serviceType — closest alignment).
   *   2. If still > 1 candidates, prefer exact `name = marker`
   *      over a `base\detail` prefix match.
   *   3. If still > 1, record under `ambiguous[]` — never guess.
   *
   * Idempotent: WHERE `deliverableTemplateId IS NULL` so a re-run
   * after execute returns `toRelink: []`.
   *
   * Transaction scope: batched by target deliverable id. A single
   * bad batch doesn't roll back the siblings; a per-task
   * transaction would be overkill for a short catalog.
   *
   * Query param `dryRun=true` → plan only. Default `false` so a
   * raw POST executes (per the admin-backfill house convention).
   * Yulian always invokes with `?dryRun=true` first.
   */
  @Post('relink-template-deliverables')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'Backfill · relink TemplateTask / TemplateZoneTask.deliverableTemplateId from [SERVICE:xxx] marker (idempotent; ?dryRun=true for plan-only)',
  })
  @ApiQuery({ name: 'dryRun', required: false, type: String, description: 'Truthy → plan only, no writes' })
  async runRelinkTemplateDeliverables(@Query('dryRun') dryRunRaw?: string) {
    const dryRun =
      typeof dryRunRaw === 'string' &&
      ['1', 'true', 'yes', 'on'].includes(dryRunRaw.toLowerCase());

    // 1. Catalog of candidate target templates (deliverable templates).
    //    Only active (deletedAt null) and only `task_list` type — zone
    //    and combined templates are never a task's deliverable target.
    const catalog = await this.prisma.template.findMany({
      where: { deletedAt: null, type: 'task_list' },
      select: { id: true, name: true, phaseId: true },
    });

    // 2. Candidate tasks on both sides: null FK + description starts
    //    with the marker prefix. `startsWith` compiles to literal
    //    MySQL (no LIKE escaping) because the prefix carries no
    //    wildcards.
    const [templateTasks, templateZoneTasks] = await Promise.all([
      this.prisma.templateTask.findMany({
        where: {
          deliverableTemplateId: null,
          description: { startsWith: '[SERVICE:' },
        },
        select: {
          id: true,
          templateId: true,
          serviceTypeId: true,
          phaseId: true,
          description: true,
        },
      }),
      this.prisma.templateZoneTask.findMany({
        where: {
          deliverableTemplateId: null,
          description: { startsWith: '[SERVICE:' },
        },
        select: {
          id: true,
          templateZoneId: true,
          serviceTypeId: true,
          phaseId: true,
          description: true,
          templateZone: { select: { templateId: true } },
        },
      }),
    ]);

    const scanned = {
      templateTasks: templateTasks.length,
      templateZoneTasks: templateZoneTasks.length,
    };

    // 3. Resolve each candidate.
    type RelinkRow = {
      kind: 'TemplateTask' | 'TemplateZoneTask';
      taskId: number;
      taskTemplateId?: number;
      zoneTemplateId?: number;
      marker: string;
      deliverableTemplateId: number;
      deliverableTemplateName: string;
      matchKind: 'exact' | 'base-prefix';
    };
    type UnmatchedRow = {
      kind: 'TemplateTask' | 'TemplateZoneTask';
      taskId: number;
      marker: string;
      reason: string;
    };
    type AmbiguousRow = {
      kind: 'TemplateTask' | 'TemplateZoneTask';
      taskId: number;
      marker: string;
      candidates: { id: number; name: string }[];
    };

    const toRelink: RelinkRow[] = [];
    const unmatched: UnmatchedRow[] = [];
    const ambiguous: AmbiguousRow[] = [];

    const resolveMarker = (
      marker: string,
      taskPhaseId: number | null,
    ): {
      pick?: { id: number; name: string; matchKind: 'exact' | 'base-prefix' };
      candidates: { id: number; name: string }[];
    } => {
      const exact = catalog.filter((t) => t.name === marker);
      const prefix = catalog.filter((t) => t.name.startsWith(`${marker}\\`));
      // All candidates for the ambiguous report (exact + prefix).
      const all = [
        ...exact.map((t) => ({ id: t.id, name: t.name, matchKind: 'exact' as const, phaseId: t.phaseId })),
        ...prefix.map((t) => ({ id: t.id, name: t.name, matchKind: 'base-prefix' as const, phaseId: t.phaseId })),
      ];
      if (all.length === 0) return { candidates: [] };
      if (all.length === 1) {
        return { pick: all[0], candidates: all.map(({ id, name }) => ({ id, name })) };
      }
      // > 1 — apply preferences.
      //   1. Phase match (if task has a phaseId).
      if (taskPhaseId != null) {
        const sameePhase = all.filter((c) => c.phaseId === taskPhaseId);
        if (sameePhase.length === 1) {
          return { pick: sameePhase[0], candidates: all.map(({ id, name }) => ({ id, name })) };
        }
        if (sameePhase.length > 1) {
          const exactPhase = sameePhase.find((c) => c.matchKind === 'exact');
          if (exactPhase) {
            return { pick: exactPhase, candidates: all.map(({ id, name }) => ({ id, name })) };
          }
          // Fall through to overall exact preference below.
        }
      }
      //   2. Prefer exact over prefix.
      if (exact.length === 1) {
        return {
          pick: { id: exact[0].id, name: exact[0].name, matchKind: 'exact' },
          candidates: all.map(({ id, name }) => ({ id, name })),
        };
      }
      // Still ambiguous.
      return { candidates: all.map(({ id, name }) => ({ id, name })) };
    };

    for (const t of templateTasks) {
      const marker = extractServiceMarker(t.description);
      if (!marker) {
        unmatched.push({
          kind: 'TemplateTask',
          taskId: t.id,
          marker: '',
          reason: 'description starts with [SERVICE: but regex did not match',
        });
        continue;
      }
      const { pick, candidates } = resolveMarker(marker, t.phaseId ?? null);
      if (pick) {
        toRelink.push({
          kind: 'TemplateTask',
          taskId: t.id,
          taskTemplateId: t.templateId,
          marker,
          deliverableTemplateId: pick.id,
          deliverableTemplateName: pick.name,
          matchKind: pick.matchKind,
        });
      } else if (candidates.length === 0) {
        unmatched.push({
          kind: 'TemplateTask',
          taskId: t.id,
          marker,
          reason: 'no active task_list Template with name = marker or name LIKE marker\\%',
        });
      } else {
        ambiguous.push({
          kind: 'TemplateTask',
          taskId: t.id,
          marker,
          candidates,
        });
      }
    }

    for (const t of templateZoneTasks) {
      const marker = extractServiceMarker(t.description);
      if (!marker) {
        unmatched.push({
          kind: 'TemplateZoneTask',
          taskId: t.id,
          marker: '',
          reason: 'description starts with [SERVICE: but regex did not match',
        });
        continue;
      }
      const { pick, candidates } = resolveMarker(marker, t.phaseId ?? null);
      if (pick) {
        toRelink.push({
          kind: 'TemplateZoneTask',
          taskId: t.id,
          zoneTemplateId: t.templateZone?.templateId,
          marker,
          deliverableTemplateId: pick.id,
          deliverableTemplateName: pick.name,
          matchKind: pick.matchKind,
        });
      } else if (candidates.length === 0) {
        unmatched.push({
          kind: 'TemplateZoneTask',
          taskId: t.id,
          marker,
          reason: 'no active task_list Template with name = marker or name LIKE marker\\%',
        });
      } else {
        ambiguous.push({
          kind: 'TemplateZoneTask',
          taskId: t.id,
          marker,
          candidates,
        });
      }
    }

    // 4. Totals + by-deliverable rollup.
    const byDeliverable: Record<number, { name: string; count: number }> = {};
    for (const r of toRelink) {
      const key = r.deliverableTemplateId;
      if (!byDeliverable[key]) {
        byDeliverable[key] = { name: r.deliverableTemplateName, count: 0 };
      }
      byDeliverable[key].count++;
    }

    // 5. Execute batched by deliverable id. A bad group doesn't roll
    //    back siblings.
    if (!dryRun && toRelink.length > 0) {
      // Group row ids by (kind, deliverableTemplateId).
      const groups = new Map<
        string,
        { kind: 'TemplateTask' | 'TemplateZoneTask'; deliverableTemplateId: number; ids: number[] }
      >();
      for (const r of toRelink) {
        const key = `${r.kind}:${r.deliverableTemplateId}`;
        let g = groups.get(key);
        if (!g) {
          g = { kind: r.kind, deliverableTemplateId: r.deliverableTemplateId, ids: [] };
          groups.set(key, g);
        }
        g.ids.push(r.taskId);
      }
      for (const g of groups.values()) {
        await this.prisma.$transaction(async (tx) => {
          if (g.kind === 'TemplateTask') {
            await tx.templateTask.updateMany({
              where: { id: { in: g.ids }, deliverableTemplateId: null },
              data: { deliverableTemplateId: g.deliverableTemplateId },
            });
          } else {
            await tx.templateZoneTask.updateMany({
              where: { id: { in: g.ids }, deliverableTemplateId: null },
              data: { deliverableTemplateId: g.deliverableTemplateId },
            });
          }
        });
      }
    }

    return {
      dryRun,
      scanned,
      toRelink,
      unmatched,
      ambiguous,
      totals: {
        toRelink: toRelink.length,
        unmatchedCount: unmatched.length,
        ambiguousCount: ambiguous.length,
        byDeliverable,
      },
    };
  }

  /**
   * QA4 · ZT-3 (2026-10-08) — Remap legacy zone-type codes to the
   * approved catalog values.
   *
   * Mapping (Yulian-approved 2026-10-08):
   *   floor   → level
   *   area    → site
   *   zone    → building
   *   section → wing
   *
   * Columns rewritten (confirmed vs schema.prisma 2026-10-08):
   *   • `zones.zone_type`            (ENUM, Prisma `Zone.zoneType`)
   *   • `templates.default_zone_type` (VarChar 32, Prisma `Template.defaultZoneType`)
   *   • `template_zones.zone_type`   (ENUM, Prisma `TemplateZone.zoneType`)
   *
   * All four target codes (level/site/building/wing) are members of
   * the current `ZoneType` enum, so updating an ENUM column to the
   * mapped value is accepted without a schema migration. The enum
   * also still contains the legacy members (floor/area/zone/section)
   * — removal is a separate cleanup once the data is remapped.
   *
   * Case-insensitive match on the SOURCE value — `floor`, `FLOOR`,
   * `Floor` are all treated as the same legacy code and remapped to
   * `level`. The TARGET value is always written in canonical
   * lowercase. Only the four legacy codes are touched; a row whose
   * current value is already a catalog code (`site`/`building`/
   * `level`/`wing`) is left alone, which keeps the endpoint
   * idempotent — re-running returns `rowsRemapped: 0`.
   *
   * Dry-run honors the `?dryRun=true` query param (same convention
   * as JT-4 / DP-EMPTY-1 / CT-DEDUP). Default `false` so a raw POST
   * executes. Both branches return the same shape; dry-run reads
   * only.
   *
   * Transaction scope: wrapped PER-TABLE (not per-row) so a bad row
   * doesn't roll back the whole batch for the sibling tables. Within
   * a table every mapping bucket runs as a single `updateMany` —
   * MySQL applies each `updateMany` atomically on its own, and the
   * `$transaction([…])` wrapper around the three per-table batches
   * guarantees no half-updated table on an unexpected error.
   *
   * Response shape mirrors the spec in
   * docs/bm2/qa4-zone-type-dropdown-vs-catalog.md section ZT-3.
   */
  @Post('remap-legacy-zone-codes')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'Backfill · remap legacy zone-type codes (floor/area/zone/section) to catalog codes (level/site/building/wing) across Zone / Template / TemplateZone (idempotent; ?dryRun=true for plan-only)',
  })
  @ApiQuery({ name: 'dryRun', required: false, type: String, description: 'Truthy → plan only, no writes' })
  async runRemapLegacyZoneCodes(@Query('dryRun') dryRunRaw?: string) {
    const dryRun =
      typeof dryRunRaw === 'string' &&
      ['1', 'true', 'yes', 'on'].includes(dryRunRaw.toLowerCase());

    // Approved mapping. Keys are the canonical lowercase legacy
    // codes; values are the canonical lowercase catalog codes
    // (all members of the ZoneType enum, so an ENUM column accepts
    // them). Case-insensitivity on the SOURCE value is handled by
    // matching via `LOWER(column) = key` on read.
    const MAPPING = {
      floor: 'level',
      area: 'site',
      zone: 'building',
      section: 'wing',
    } as const;
    type LegacyCode = keyof typeof MAPPING;
    type CatalogCode = (typeof MAPPING)[LegacyCode];
    const LEGACY_CODES = Object.keys(MAPPING) as LegacyCode[];

    const isLegacy = (val: string | null | undefined): val is LegacyCode =>
      typeof val === 'string' && (LEGACY_CODES as string[]).includes(val.toLowerCase());

    // ─── 1. Pull every candidate row across all three tables.
    //         The catalog is tiny (438 Zone + 38 Template + 17
    //         TemplateZone = 493 rows on staging today), so one
    //         select-by-id-and-value scan per table is cheap and
    //         gives us the full `toRemap[].{ id, before, after }`
    //         payload for free. Raw SQL on `LOWER(…)` so the match
    //         is explicitly case-insensitive regardless of column
    //         collation.
    const [zoneRows, templateRows, templateZoneRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{ id: number; zoneType: string }>>(
        `SELECT id, zone_type AS zoneType
           FROM zones
          WHERE LOWER(zone_type) IN ('floor','area','zone','section')`,
      ),
      this.prisma.$queryRawUnsafe<Array<{ id: number; defaultZoneType: string }>>(
        `SELECT id, default_zone_type AS defaultZoneType
           FROM templates
          WHERE LOWER(default_zone_type) IN ('floor','area','zone','section')`,
      ),
      this.prisma.$queryRawUnsafe<Array<{ id: number; zoneType: string }>>(
        `SELECT id, zone_type AS zoneType
           FROM template_zones
          WHERE LOWER(zone_type) IN ('floor','area','zone','section')`,
      ),
    ]);

    // Table totals — handy context in the response so Yulian sees
    // "309 of 436 Zone rows carry a legacy code" at a glance. The
    // VarChar `Template.default_zone_type` is nullable, so `total`
    // here counts every non-deleted row (including NULLs that this
    // backfill leaves alone — they aren't legacy codes).
    const [zoneTotalRow, templateTotalRow, templateZoneTotalRow] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*) AS n FROM zones`,
      ),
      this.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*) AS n FROM templates`,
      ),
      this.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*) AS n FROM template_zones`,
      ),
    ]);
    const asNum = (b: bigint | number | undefined): number =>
      typeof b === 'bigint' ? Number(b) : (b ?? 0);

    // ─── 2. Build the plan rows + per-table/per-code counters.
    const makeToRemap = (
      rows: Array<{ id: number; code: string }>,
    ): Array<{ id: number; before: string; after: CatalogCode }> =>
      rows
        .filter((r) => isLegacy(r.code))
        .map((r) => ({
          id: r.id,
          before: r.code,
          after: MAPPING[r.code.toLowerCase() as LegacyCode],
        }));

    const zoneToRemap = makeToRemap(
      zoneRows.map((r) => ({ id: r.id, code: r.zoneType })),
    );
    const templateToRemap = makeToRemap(
      templateRows.map((r) => ({ id: r.id, code: r.defaultZoneType })),
    );
    const templateZoneToRemap = makeToRemap(
      templateZoneRows.map((r) => ({ id: r.id, code: r.zoneType })),
    );

    // Per-code counts (summed across all three tables) so the dry-
    // run report shows the Yulian-level distribution before any
    // writes land.
    const perCode: Record<LegacyCode, number> = { floor: 0, area: 0, zone: 0, section: 0 };
    // Per-table-per-code counts for the `scanned` field.
    const legacyPerTable = (
      rows: Array<{ id: number; code: string }>,
    ): Record<LegacyCode, number> => {
      const out: Record<LegacyCode, number> = { floor: 0, area: 0, zone: 0, section: 0 };
      for (const r of rows) {
        const lc = r.code.toLowerCase();
        if ((LEGACY_CODES as string[]).includes(lc)) {
          out[lc as LegacyCode]++;
          perCode[lc as LegacyCode]++;
        }
      }
      return out;
    };
    const zoneLegacy = legacyPerTable(
      zoneRows.map((r) => ({ id: r.id, code: r.zoneType })),
    );
    const templateLegacy = legacyPerTable(
      templateRows.map((r) => ({ id: r.id, code: r.defaultZoneType })),
    );
    const templateZoneLegacy = legacyPerTable(
      templateZoneRows.map((r) => ({ id: r.id, code: r.zoneType })),
    );

    // ─── 3. Execute (unless dry-run). One `updateMany` per
    //         (table × target-code) bucket — MySQL applies that as
    //         an atomic set operation. All three tables' batches run
    //         inside a single `$transaction([...])` so the three
    //         tables commit together; a bad bucket rolls back the
    //         batch without leaving a sibling table half-updated.
    //         Target values (level/site/building/wing) are valid
    //         `ZoneType` enum members, so the ENUM columns accept
    //         them without a schema migration.
    let totalRowsRemapped = 0;
    if (!dryRun && (zoneToRemap.length + templateToRemap.length + templateZoneToRemap.length) > 0) {
      // Bucket ids per target code so each updateMany flips one
      // code at a time and the WHERE clause stays tight.
      const bucketIds = (
        plan: Array<{ id: number; after: CatalogCode }>,
      ): Record<CatalogCode, number[]> => {
        const out: Record<CatalogCode, number[]> = { level: [], site: [], building: [], wing: [] };
        for (const r of plan) out[r.after].push(r.id);
        return out;
      };
      const zoneBuckets = bucketIds(zoneToRemap);
      const templateBuckets = bucketIds(templateToRemap);
      const templateZoneBuckets = bucketIds(templateZoneToRemap);

      // Build the transactional updateMany set. `prisma.$transaction([...])`
      // accepts the array form so each table's bucketed updates land
      // together — the three per-table batches commit as one unit,
      // which matches the "per-table transaction (not per-row)"
      // guarantee the ZT-3 spec asks for.
      const ops: Prisma.PrismaPromise<unknown>[] = [];
      for (const [after, ids] of Object.entries(zoneBuckets) as Array<[CatalogCode, number[]]>) {
        if (ids.length === 0) continue;
        ops.push(
          this.prisma.zone.updateMany({
            where: { id: { in: ids } },
            data: { zoneType: after },
          }),
        );
      }
      for (const [after, ids] of Object.entries(templateBuckets) as Array<[CatalogCode, number[]]>) {
        if (ids.length === 0) continue;
        ops.push(
          this.prisma.template.updateMany({
            where: { id: { in: ids } },
            data: { defaultZoneType: after },
          }),
        );
      }
      for (const [after, ids] of Object.entries(templateZoneBuckets) as Array<[CatalogCode, number[]]>) {
        if (ids.length === 0) continue;
        ops.push(
          this.prisma.templateZone.updateMany({
            where: { id: { in: ids } },
            data: { zoneType: after },
          }),
        );
      }

      if (ops.length > 0) {
        const results = (await this.prisma.$transaction(ops)) as Array<{ count: number }>;
        for (const r of results) totalRowsRemapped += r.count;
      }
    } else if (dryRun) {
      // Dry-run mirrors execute's counter — rowsRemapped == every
      // row in the plan.
      totalRowsRemapped =
        zoneToRemap.length + templateToRemap.length + templateZoneToRemap.length;
    }

    return {
      dryRun,
      scanned: {
        zone: { total: asNum(zoneTotalRow[0]?.n), legacy: zoneLegacy },
        template: { total: asNum(templateTotalRow[0]?.n), legacy: templateLegacy },
        templateZone: { total: asNum(templateZoneTotalRow[0]?.n), legacy: templateZoneLegacy },
      },
      toRemap: {
        zone: zoneToRemap,
        template: templateToRemap,
        templateZone: templateZoneToRemap,
      },
      totals: {
        perCode,
        perTable: {
          zone: zoneToRemap.length,
          template: templateToRemap.length,
          templateZone: templateZoneToRemap.length,
        },
        rowsRemapped: totalRowsRemapped,
      },
    };
  }

  /**
   * §14 RBAC multi-role · M1 handover backfill (2026-10-18).
   *
   * Seeds one row per user in `user_roles` from the legacy
   * `users.role_id` so the new `UserRole`-based permission read has a
   * row for every existing user before the admin UI starts letting
   * admins add/remove roles via multi-select chips (M4). Zero-downtime:
   * `common/guards/roles.guard.ts` falls back to the legacy `role_id`
   * lookup when `user_roles` is empty for a user, so this endpoint
   * can run before OR after the M1 code deploy without breaking live
   * requests.
   *
   * Candidates: every non-deleted user with a non-null `role_id`
   * (the current staging state: 123 users, all with role_id set).
   *
   * Idempotent: writes with `createMany({ skipDuplicates: true })` on
   * `(userId, roleId)` so a re-run against a fully-seeded table
   * returns `toInsert: 0` and leaves the table untouched. `?dryRun=
   * true` returns the plan without writes; a plain POST executes.
   */
  @Post('rbac-m1-seed-user-roles')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      '§14 M1 · seed user_roles from users.role_id (idempotent; ?dryRun=true for plan-only)',
  })
  @ApiQuery({ name: 'dryRun', required: false, type: String, description: 'Truthy → plan only, no writes' })
  async runRbacM1SeedUserRoles(@Query('dryRun') dryRunRaw?: string) {
    const dryRun =
      typeof dryRunRaw === 'string' &&
      ['1', 'true', 'yes', 'on'].includes(dryRunRaw.toLowerCase());

    // 1. Scan — every non-deleted user, joined to its role.
    //    Explicit raw-SQL JOIN mirrors the spec's example query exactly
    //    and keeps the result shape small (6 columns). role_id is
    //    schema-non-null on `users`, but we still guard with
    //    `role_id IS NOT NULL` so a future column loosening doesn't
    //    silently crash the backfill.
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ id: number; first_name: string; last_name: string; role_id: number; role_name: string }>
    >(
      `SELECT u.id, u.first_name, u.last_name, u.role_id, r.name AS role_name
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.deleted_at IS NULL
          AND u.role_id IS NOT NULL
        ORDER BY u.id ASC`,
    );

    const usersWithRole = rows.length;
    // Second count — users with NULL role_id (should be 0 on staging
    // today, kept for post-deploy audits).
    const nullRoleCountRows = await this.prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND role_id IS NULL`,
    );
    const usersWithoutRole = Number(nullRoleCountRows[0]?.n ?? 0);

    // 2. Which (userId, roleId) pairs already exist in user_roles?
    //    One batched SELECT; the comparison runs locally. Only looks
    //    for rows that match current candidates — a stale row (user
    //    deleted but user_role surviving) is ignored.
    const existing =
      usersWithRole === 0
        ? []
        : await this.prisma.userRole.findMany({
            where: {
              userId: { in: rows.map((r) => r.id) },
            },
            select: { userId: true, roleId: true },
          });
    const existingKey = new Set(existing.map((e) => `${e.userId}:${e.roleId}`));

    let alreadyPresent = 0;
    const toInsert: Array<{ userId: number; roleId: number }> = [];
    for (const r of rows) {
      const key = `${r.id}:${r.role_id}`;
      if (existingKey.has(key)) alreadyPresent++;
      else toInsert.push({ userId: r.id, roleId: r.role_id });
    }

    // 3. Sample for the response (first 10 to-insert rows; falls back
    //    to the first 10 scanned rows if everything is already present
    //    so a re-run still shows what WOULD have been inserted).
    const sampleSource = toInsert.length > 0
      ? toInsert.map((p) => rows.find((r) => r.id === p.userId && r.role_id === p.roleId)).filter(Boolean) as typeof rows
      : rows.slice(0, 10);
    const sample = sampleSource.slice(0, 10).map((r) => ({
      userId: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      roleId: r.role_id,
      roleName: r.role_name,
    }));

    // 4. Execute — createMany with skipDuplicates for defense in depth
    //    (if two requests race, the second's skipDuplicates swallows
    //    the (userId, roleId) unique-constraint collisions).
    let insertedOrSkipped = 0;
    if (!dryRun && toInsert.length > 0) {
      const res = await this.prisma.userRole.createMany({
        data: toInsert,
        skipDuplicates: true,
      });
      insertedOrSkipped = res.count;
    } else if (dryRun) {
      insertedOrSkipped = toInsert.length;
    }

    return {
      dryRun,
      scanned: { usersWithRole, usersWithoutRole },
      toInsert: toInsert.length,
      alreadyPresent,
      sample,
      totals: { insertedOrSkipped },
    };
  }

  /**
   * B5-3 (2026-10-20) — Backfill the `User.businessPartnerId` link
   * for active users that are missing one. Fixes the ~43% of active
   * employees on staging whose Qualifications section was silently
   * hidden by the `businessPartnerId != null` gate on the People
   * edit modal (verified 26 of 61 active users, all imported before
   * B5-2 landed).
   *
   * Per user, inside a per-row `$transaction`:
   *   1. `UsersService.ensureBpForUser(tx, {…})` — reuses the person
   *      BP with the matching email when one exists and isn't
   *      already linked to another user, else creates a fresh BP.
   *      Shape matches `UsersService.create`'s own writes exactly
   *      so no new drift is introduced.
   *   2. `tx.user.update({ businessPartnerId })` — points the row.
   *   3. `UsersService.syncEmployeeBpRole(bpId, user.userType, tx)`
   *      — tags the BP with the `employee` role when the user's
   *      type says so (idempotent upsert on the unique pair).
   *
   * dryRun uses the SAME transactional path so the prediction can't
   * drift from the real run. Inside the tx the counters update,
   * then a sentinel `__DRY_RUN_ROLLBACK__` throw forces Prisma to
   * roll back every write. Caught just below the tx so the loop
   * continues. The outer `try/catch` wrapping the whole per-user
   * block pushes any genuine error onto the `errors` array —
   * failures of one user never roll back another.
   *
   * Idempotent — once a user is linked, the WHERE filter excludes
   * them on the next scan, so a re-run after a successful run
   * returns `{ scanned: 0 }`.
   *
   * Response shape (both dryRun + real):
   *   {
   *     dryRun: boolean,
   *     scanned: number,              // active users with no BP
   *     alreadyLinked: 0,             // reserved — WHERE excludes
   *     reusedExistingBp: number,     // email hit, no @unique collision
   *     createdBp: number,            // nothing found, or hit + collision
   *     linked: number,               // reused + created
   *     skippedConflicts: 0,          // reserved — ensureBp handles conflict by creating
   *     errors: Array<{ userId; email; message }>,
   *   }
   */
  @Post('backfill/user-business-partner')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'B5-3 · Backfill User.businessPartnerId for active users missing one (idempotent; ?dryRun=true for plan-only)',
  })
  @ApiQuery({ name: 'dryRun', required: false, type: String, description: 'Truthy → plan only, no writes' })
  async runBackfillUserBusinessPartner(@Query('dryRun') dryRunRaw?: string) {
    const dryRun =
      typeof dryRunRaw === 'string' &&
      ['1', 'true', 'yes', 'on'].includes(dryRunRaw.toLowerCase());

    // 1. Scan — active, non-deleted users whose BP link is NULL.
    //    Select every field `ensureBpForUser` needs plus `userType`
    //    for `syncEmployeeBpRole`.
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        businessPartnerId: null,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        firstNameHe: true,
        lastNameHe: true,
        phone: true,
        userType: true,
      },
      orderBy: { id: 'asc' },
    });

    const scanned = users.length;
    let reusedExistingBp = 0;
    let createdBp = 0;
    let linked = 0;
    const errors: Array<{ userId: number; email: string; message: string }> = [];

    // Early-return shape so the caller can distinguish "nothing to
    // do" from "we found users but every one errored".
    if (scanned === 0) {
      return {
        dryRun,
        scanned: 0,
        alreadyLinked: 0,
        reusedExistingBp: 0,
        createdBp: 0,
        linked: 0,
        skippedConflicts: 0,
        errors: [],
      };
    }

    // 2. Per-user transaction. A single failure (bad data, race on
    //    @unique) only aborts that user; siblings keep going.
    const DRY_RUN_SENTINEL = '__B5_BACKFILL_DRY_RUN_ROLLBACK__';
    for (const user of users) {
      // Captured BEFORE the throw so the catch block knows which
      // bucket to increment on a dryRun rollback.
      let predicted: 'reused' | 'created' | null = null;
      try {
        await this.prisma.$transaction(async (tx) => {
          const { bpId, outcome } = await this.usersService.ensureBpForUser(tx, {
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            firstNameHe: user.firstNameHe ?? null,
            lastNameHe: user.lastNameHe ?? null,
            phone: user.phone ?? null,
          });
          predicted = outcome;
          await tx.user.update({
            where: { id: user.id },
            data: { businessPartnerId: bpId },
          });
          await this.usersService.syncEmployeeBpRole(bpId, user.userType, tx);
          if (dryRun) {
            // Force rollback — the tx-aware strategy keeps dryRun's
            // predicted path byte-identical to the real path.
            throw new Error(DRY_RUN_SENTINEL);
          }
        });
        // Real run reached here cleanly.
        if (predicted === 'reused') reusedExistingBp++;
        else createdBp++;
        linked++;
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === DRY_RUN_SENTINEL && predicted) {
          // Expected dryRun rollback — count the predicted outcome.
          if (predicted === 'reused') reusedExistingBp++;
          else createdBp++;
          linked++;
          continue;
        }
        errors.push({ userId: user.id, email: user.email, message });
      }
    }

    return {
      dryRun,
      scanned,
      // Always 0 — the WHERE filter excludes users that already
      // have a BP; this stays in the response shape for parity with
      // the backfill-report conventions.
      alreadyLinked: 0,
      reusedExistingBp,
      createdBp,
      linked,
      // Reserved for a future stricter policy — ensureBpForUser's
      // @unique-collision guard currently creates a fresh BP rather
      // than skipping, so nothing lands here today.
      skippedConflicts: 0,
      errors,
    };
  }

  /**
   * DN-ext (2026-10-22) — Backfill the `catalogTaskId` FK on
   * `TemplateTask` + `TemplateZoneTask` from the source catalog
   * TemplateTask (lives under the Task Catalog template, `code =
   * '__TASK_CATALOG__'`). Phase 2 of the template name/hours sync
   * fix; see docs/bm2/template-name-sync-investigation.md.
   *
   * Match rule (per Yulian 2026-10-22): exact `code` match against
   * the catalog's own TemplateTask rows. One catalog hit → link.
   * Zero → skippedNoMatch. Two or more → skippedMultipleMatches
   * (the schema allows a duplicate `code` in the catalog; we never
   * guess). Rows with no `code` are skipped outright — a code-based
   * backfill can't match a row that lacks the join key.
   *
   * Scope:
   *   • TemplateTask rows whose `templateId` is NOT the catalog's
   *     own id (so catalog rows don't link to themselves) AND
   *     `catalogTaskId IS NULL` (idempotent — re-run matches 0).
   *   • TemplateZoneTask rows where `catalogTaskId IS NULL` (zone
   *     tasks never live under the catalog template, so no self-
   *     scope guard needed).
   *
   * Per-row transaction so one failure doesn't tank the batch.
   * `?dryRun=true` → plan only (default `false`, matches the
   * admin-backfill house convention of a plain POST executing).
   * Yulian always invokes dryRun first per the Phase 2 work order
   * — CC never executes this.
   *
   * Response shape: separate counters per table so a mixed batch
   * can be audited precisely. `errors` holds per-row failures
   * that didn't fit a skip bucket.
   */
  @Post('backfill/template-catalog-task-fk')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'DN-ext · Backfill TemplateTask / TemplateZoneTask.catalogTaskId by code match against Task Catalog (idempotent; ?dryRun=true for plan-only)',
  })
  @ApiQuery({ name: 'dryRun', required: false, type: String, description: 'Truthy → plan only, no writes' })
  async runBackfillTemplateCatalogTaskFk(@Query('dryRun') dryRunRaw?: string) {
    const dryRun =
      typeof dryRunRaw === 'string' &&
      ['1', 'true', 'yes', 'on'].includes(dryRunRaw.toLowerCase());

    // 1. Locate the Task Catalog template. If it doesn't exist
    //    nothing is linkable — the backfill is a no-op.
    const catalog = await this.prisma.template.findFirst({
      where: { code: '__TASK_CATALOG__', deletedAt: null },
      select: { id: true, name: true },
    });
    if (!catalog) {
      return {
        dryRun,
        catalogFound: false,
        totals: {
          templateTask: {
            scanned: 0,
            linked: 0,
            skippedNoMatch: 0,
            skippedMultipleMatches: 0,
            skippedNoCode: 0,
          },
          templateZoneTask: {
            scanned: 0,
            linked: 0,
            skippedNoMatch: 0,
            skippedMultipleMatches: 0,
            skippedNoCode: 0,
          },
        },
        errors: [],
      };
    }

    // 2. Build an index of catalog TemplateTask rows keyed by
    //    `code`. One trip to Prisma; the catalog is small (a few
    //    hundred rows at most on staging). Rows without a code are
    //    excluded — they can't anchor a match.
    const catalogTasks = await this.prisma.templateTask.findMany({
      where: { templateId: catalog.id, code: { not: '' } },
      select: { id: true, code: true, name: true },
    });
    const byCode = new Map<string, Array<{ id: number; name: string }>>();
    for (const t of catalogTasks) {
      if (!t.code) continue;
      const arr = byCode.get(t.code) ?? [];
      arr.push({ id: t.id, name: t.name });
      byCode.set(t.code, arr);
    }

    // 3. Candidate TemplateTask rows: NOT in the catalog, FK null.
    const candidateTemplateTasks = await this.prisma.templateTask.findMany({
      where: {
        catalogTaskId: null,
        templateId: { not: catalog.id },
      },
      select: { id: true, code: true, templateId: true, name: true },
    });

    // 4. Candidate TemplateZoneTask rows: FK null (zone tasks never
    //    live under the catalog so no self-scope guard).
    const candidateZoneTasks = await this.prisma.templateZoneTask.findMany({
      where: { catalogTaskId: null },
      select: { id: true, code: true, templateZoneId: true, name: true },
    });

    const errors: Array<{
      kind: 'TemplateTask' | 'TemplateZoneTask';
      id: number;
      error: string;
    }> = [];

    // Classifier used for both tables — returns the catalog id to
    // link, or a skip reason bucket, or an error (for truly broken
    // rows: empty code, etc.).
    const classify = (
      code: string | null | undefined,
    ): { bucket: 'link'; catalogId: number }
      | { bucket: 'skippedNoCode' }
      | { bucket: 'skippedNoMatch' }
      | { bucket: 'skippedMultipleMatches'; candidates: Array<{ id: number; name: string }> } => {
      if (!code || !code.trim()) return { bucket: 'skippedNoCode' };
      const hits = byCode.get(code) ?? [];
      if (hits.length === 0) return { bucket: 'skippedNoMatch' };
      if (hits.length === 1) return { bucket: 'link', catalogId: hits[0].id };
      return { bucket: 'skippedMultipleMatches', candidates: hits };
    };

    // 5. Plan + execute. Each successful link runs in its own
    //    `$transaction` so a Prisma error on one row doesn't poison
    //    the siblings. Dry-run shares the planner path and skips
    //    the write.
    const ttLinks: Array<{ id: number; catalogId: number }> = [];
    const ttSkippedNoMatch: number[] = [];
    const ttSkippedMultiple: Array<{ id: number; code: string; candidates: Array<{ id: number; name: string }> }> = [];
    let ttSkippedNoCode = 0;

    for (const row of candidateTemplateTasks) {
      const c = classify(row.code);
      if (c.bucket === 'link') ttLinks.push({ id: row.id, catalogId: c.catalogId });
      else if (c.bucket === 'skippedNoMatch') ttSkippedNoMatch.push(row.id);
      else if (c.bucket === 'skippedMultipleMatches') {
        ttSkippedMultiple.push({ id: row.id, code: row.code ?? '', candidates: c.candidates });
      } else {
        ttSkippedNoCode++;
      }
    }

    const ztLinks: Array<{ id: number; catalogId: number }> = [];
    const ztSkippedNoMatch: number[] = [];
    const ztSkippedMultiple: Array<{ id: number; code: string; candidates: Array<{ id: number; name: string }> }> = [];
    let ztSkippedNoCode = 0;

    for (const row of candidateZoneTasks) {
      const c = classify(row.code);
      if (c.bucket === 'link') ztLinks.push({ id: row.id, catalogId: c.catalogId });
      else if (c.bucket === 'skippedNoMatch') ztSkippedNoMatch.push(row.id);
      else if (c.bucket === 'skippedMultipleMatches') {
        ztSkippedMultiple.push({ id: row.id, code: row.code ?? '', candidates: c.candidates });
      } else {
        ztSkippedNoCode++;
      }
    }

    // Execute writes (unless dry-run). Per-row transactions so one
    // bad id (e.g. a race-deleted catalog row that no longer exists
    // between planning and executing) only drops that single link.
    let ttLinked = 0;
    let ztLinked = 0;
    if (!dryRun) {
      for (const link of ttLinks) {
        try {
          await this.prisma.$transaction(async (tx) => {
            // Guard the WHERE with `catalogTaskId: null` so re-run
            // after a prior partial pass picks up only what still
            // needs linking.
            const res = await tx.templateTask.updateMany({
              where: { id: link.id, catalogTaskId: null },
              data: { catalogTaskId: link.catalogId },
            });
            if (res.count > 0) ttLinked += res.count;
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ kind: 'TemplateTask', id: link.id, error: message });
        }
      }
      for (const link of ztLinks) {
        try {
          await this.prisma.$transaction(async (tx) => {
            const res = await tx.templateZoneTask.updateMany({
              where: { id: link.id, catalogTaskId: null },
              data: { catalogTaskId: link.catalogId },
            });
            if (res.count > 0) ztLinked += res.count;
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ kind: 'TemplateZoneTask', id: link.id, error: message });
        }
      }
    } else {
      // Dry-run mirrors execute's counter — every planned link
      // counts as 1.
      ttLinked = ttLinks.length;
      ztLinked = ztLinks.length;
    }

    return {
      dryRun,
      catalogFound: true,
      catalog: { id: catalog.id, name: catalog.name },
      plan: {
        templateTask: {
          toLink: ttLinks,
          skippedNoMatch: ttSkippedNoMatch,
          skippedMultipleMatches: ttSkippedMultiple,
        },
        templateZoneTask: {
          toLink: ztLinks,
          skippedNoMatch: ztSkippedNoMatch,
          skippedMultipleMatches: ztSkippedMultiple,
        },
      },
      totals: {
        templateTask: {
          scanned: candidateTemplateTasks.length,
          linked: ttLinked,
          skippedNoMatch: ttSkippedNoMatch.length,
          skippedMultipleMatches: ttSkippedMultiple.length,
          skippedNoCode: ttSkippedNoCode,
        },
        templateZoneTask: {
          scanned: candidateZoneTasks.length,
          linked: ztLinked,
          skippedNoMatch: ztSkippedNoMatch.length,
          skippedMultipleMatches: ztSkippedMultiple.length,
          skippedNoCode: ztSkippedNoCode,
        },
      },
      errors,
    };
  }

  /**
   * HR-TESTSET · import (2026-11-04).
   *
   * One-shot admin endpoint that loads historical HR data for a Yulian-
   * curated group of 8 employees (June + September 2026) from the
   * committed JSON at `docs/bm2/hr-testset-2026.json`. Needed because
   * `POST /time-entries` is `@OwnData()` — there is no admin path to
   * seed TimeEntries against ANOTHER user's id. Absences and calendar
   * days have per-user admin paths but we batch them here so the whole
   * dataset lands via one call.
   *
   * Flow per employee (map by `email` → `User.id`, isActive + non-deleted):
   *   1. CalendarDay — upsert each holiday (global, keyed on `date`).
   *      Idempotent via findUnique-then-create; a re-run finds every
   *      row already present and returns `created: 0`. workingHours
   *      defaults match `CalendarService`'s type defaults (HOLIDAY=0,
   *      HOLIDAY_EVE/CHOL_HAMOED=5).
   *   2. TimeEntry — one row per worked day (`{date, minutes}`). Marked
   *      with a durable note tag `[HR_TESTSET_IMPORT_2026]` so the
   *      idempotency check keys on (userId, date, note=marker). Written
   *      directly via Prisma, NOT via `TimeEntriesService.create` — that
   *      service is `@OwnData` + requires a projectId, which this
   *      historical seed intentionally leaves null (bucketId=null,
   *      taskId=null, projectId=null). isBillable=false because these
   *      hours are not customer-billable; they exist only to feed the
   *      HR monthly report.
   *   3. AbsenceRecord — one row per absence day (`{date, bucket}`).
   *      Bucket code maps 1:1 to the seeded `AbsenceType.code` catalog
   *      (vacation/sick/reserve_duty/holiday_eve_leave/chol_hamoed_leave/
   *      holiday_full). Written directly via Prisma (NOT via
   *      `HrService.createAbsence`) because the `holiday_*` types were
   *      deactivated on 2026-10-20 — the service rejects inactive types
   *      for new user-driven requests, but historical ingest for parity
   *      against the legacy report must still accept them. `day_off`
   *      (no seeded type) is aliased to `vacation` per the work order's
   *      intent. Amount is `1` (full day) for every row; halfDay flag
   *      on the type is a UI picker hint, not a data constraint.
   *   4. dailyStandardHours — reported per resolved user. The work
   *      order says "don't auto-update, just report", so Yulian can
   *      flip any outlier manually from the HR drawer before kicking
   *      off `POST /hr/monthly/recompute`.
   *
   * Transaction scope: per-employee `$transaction` — a single bad row
   * (DB constraint violation, FK drift) stops that employee without
   * poisoning the batch. Errors collected in `errors[]`. Calendar
   * writes are NOT inside any employee tx (they're global, shared) —
   * they commit outside the employee loop so a per-employee failure
   * doesn't orphan the calendar rows.
   *
   * Idempotency keys:
   *   • CalendarDay: unique `date` column.
   *   • TimeEntry: (userId, date, note=marker, deletedAt=null). The
   *     marker column lets a later cleanup (hard-delete every HR
   *     testset row) run via a single WHERE on the note. Pre-fetched
   *     per user into a Set<ms> for O(1) lookup.
   *   • AbsenceRecord: (userId, dateFrom, absenceTypeId). Pre-fetched
   *     per user into a Set<"yyyy-mm-dd:typeId">.
   *
   * dryRun (any truthy query param value: `1`, `true`, `yes`, `on`) →
   * read + report, no writes. Both branches return the exact same
   * response shape; a diff of two responses confirms what the real
   * run will land. Expected counts on first run: ~71 TimeEntries in
   * Sep + ~160 in Jun, ~84 absences in Sep + a few in Jun, 7 calendar
   * holidays (Sep only; Jun has none).
   *
   * Date handling: every input date `YYYY-MM-DD` is parsed into UTC
   * midnight (`Date.UTC(y, m-1, d)`) so a `@db.Date` column round-trips
   * byte-stable regardless of the API host's timezone — the DB stores
   * the date portion, Prisma reads it back as UTC midnight, and the
   * idempotency Set keys compare cleanly.
   *
   * NOT in scope for this endpoint — Yulian triggers these separately:
   *   • `POST /hr/monthly/recompute` for 2026-06 and 2026-09 after a
   *     real run (rolls up the new TimeEntries / AbsenceRecords into
   *     `HrMonthly`).
   *   • Any FE page — hits the endpoint via Postman/curl.
   */
  @Post('import-hr-testset')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'HR · import test group (8 employees, Jun+Sep 2026) from docs/bm2/hr-testset-2026.json (idempotent; ?dryRun=1|true|yes|on for plan-only)',
  })
  @ApiQuery({ name: 'dryRun', required: false, type: String, description: 'Truthy → plan only, no writes' })
  async runImportHrTestset(
    @Query('dryRun') dryRunRaw: string | undefined,
    @CurrentUser() actor: any,
  ) {
    const dryRun =
      typeof dryRunRaw === 'string' &&
      ['1', 'true', 'yes', 'on'].includes(dryRunRaw.toLowerCase());
    const actorId: number | undefined = actor?.id;
    if (!actorId) {
      throw new BadRequestException('Admin actor required (missing JWT user id)');
    }

    // ─── 1. Load the committed JSON ──────────────────────────────
    // Lives at `<repo>/docs/bm2/hr-testset-2026.json`. At runtime
    // `__dirname` is `apps/api/dist/modules/admin` (prod) or
    // `apps/api/src/modules/admin` (ts-jest / dev); both need 5
    // `..` steps up to the repo root.
    const jsonPath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      'docs',
      'bm2',
      'hr-testset-2026.json',
    );
    let raw: string;
    try {
      raw = fs.readFileSync(jsonPath, 'utf8');
    } catch (err) {
      throw new BadRequestException(
        `Cannot read testset JSON at ${jsonPath}: ${(err as Error).message}`,
      );
    }
    let data: HrTestset;
    try {
      data = JSON.parse(raw) as HrTestset;
    } catch (err) {
      throw new BadRequestException(
        `Invalid JSON in testset file: ${(err as Error).message}`,
      );
    }

    const employees = Array.isArray(data.employees) ? data.employees : [];
    const monthKeys = Object.keys(data.months ?? {}).sort();
    const scanned = { employees: employees.length, months: monthKeys };

    // ─── 2. Resolve bucket code → AbsenceType row ────────────────
    // The seeded `absence_types` catalog carries the exact codes the
    // JSON uses (no translation step needed). `day_off` is the sole
    // alias — the work order includes it for completeness but the
    // seed has no dedicated row; map to regular vacation. Inactive
    // rows (holiday_full / holiday_eve_leave / chol_hamoed_leave,
    // deactivated 2026-10-20) are still resolvable here — the
    // backfill writes directly via Prisma (not via HrService) so
    // the service's active-only guard does not fire for history.
    const BUCKET_TO_CODE: Record<string, string> = {
      vacation: 'vacation',
      sick: 'sick',
      holiday_eve_leave: 'holiday_eve_leave',
      chol_hamoed_leave: 'chol_hamoed_leave',
      reserve_duty: 'reserve_duty',
      holiday_full: 'holiday_full',
      day_off: 'vacation',
    };
    const wantedCodes = Array.from(new Set(Object.values(BUCKET_TO_CODE)));
    const absenceTypes = await this.prisma.absenceType.findMany({
      where: { code: { in: wantedCodes } },
      select: { id: true, code: true, nameHe: true, unit: true, active: true },
    });
    const typeByCode = new Map(absenceTypes.map((t) => [t.code, t]));

    // ─── 3. Resolve users by email ──────────────────────────────
    const emails = employees.map((e) => e.email).filter((e): e is string => !!e);
    const users =
      emails.length === 0
        ? []
        : await this.prisma.user.findMany({
            where: {
              email: { in: emails },
              deletedAt: null,
              isActive: true,
            },
            select: { id: true, email: true, dailyStandardHours: true },
          });
    const userByEmail = new Map(users.map((u) => [u.email, u]));

    const resolved: Array<{
      email: string;
      userId: number;
      dailyStandardHours: number;
      dailyStandardHoursOk: boolean;
    }> = [];
    const skipped: Array<{ email: string; reason: string }> = [];
    for (const emp of employees) {
      if (!emp.email) {
        skipped.push({ email: '(blank)', reason: 'employee row has no email' });
        continue;
      }
      const u = userByEmail.get(emp.email);
      if (!u) {
        skipped.push({ email: emp.email, reason: 'no active user' });
        continue;
      }
      const dsh = Number(u.dailyStandardHours);
      resolved.push({
        email: emp.email,
        userId: u.id,
        dailyStandardHours: dsh,
        dailyStandardHoursOk: Math.abs(dsh - 8.4) < 1e-9,
      });
    }

    // ─── 4. Calendar days — global, scanned once ─────────────────
    // Deduplicate by date across every month (same date could appear
    // in multiple months in principle, though the testset keeps them
    // segregated by YYYY-MM key). UTC midnight so the @db.DateTime
    // column round-trips byte-stable.
    const holidayByDate = new Map<
      string,
      { date: string; name: string; type: CalendarDayType }
    >();
    for (const monthData of Object.values(data.months ?? {})) {
      for (const h of monthData?.holidays ?? []) {
        if (!h?.date || !h?.name || !h?.type) continue;
        if (!holidayByDate.has(h.date)) {
          holidayByDate.set(h.date, {
            date: h.date,
            name: h.name,
            type: h.type as CalendarDayType,
          });
        }
      }
    }
    const uniqueHolidays = Array.from(holidayByDate.values());
    const holidayDateObjs = uniqueHolidays.map((h) => parseUtcDate(h.date));

    const existingCalendarRows =
      holidayDateObjs.length === 0
        ? []
        : await this.prisma.calendarDay.findMany({
            where: { date: { in: holidayDateObjs } },
            select: { date: true },
          });
    const existingCalendarMs = new Set(
      existingCalendarRows.map((r) => r.date.getTime()),
    );

    let calendarCreated = 0;
    let calendarWouldCreate = 0;
    let calendarExisted = 0;
    for (const h of uniqueHolidays) {
      const dateObj = parseUtcDate(h.date);
      if (existingCalendarMs.has(dateObj.getTime())) {
        calendarExisted++;
        continue;
      }
      calendarWouldCreate++;
      if (!dryRun) {
        await this.prisma.calendarDay.create({
          data: {
            date: dateObj,
            name: h.name,
            type: h.type,
            workingHours: defaultWorkingHoursForCalendarType(h.type),
            createdBy: actorId,
          },
        });
        existingCalendarMs.add(dateObj.getTime());
        calendarCreated++;
      }
    }

    // ─── 5. Per-employee time entries + absences ─────────────────
    const TIME_ENTRY_NOTE_MARKER = '[HR_TESTSET_IMPORT_2026]';
    const ABSENCE_NOTE = 'HR testset import 2026';
    let teCreated = 0;
    let teWouldCreate = 0;
    let teExisted = 0;
    let absCreated = 0;
    let absWouldCreate = 0;
    let absExisted = 0;
    const teByMonth: Record<string, number> = {};
    const absByMonth: Record<string, number> = {};
    const errors: Array<{ email?: string; code?: string; message: string }> = [];

    for (const emp of employees) {
      const u = userByEmail.get(emp.email);
      if (!u) continue; // already in skipped[]

      try {
        await this.prisma.$transaction(async (tx) => {
          // Pre-fetch existing marker-tagged TimeEntries for this user.
          const existingTeRows = await tx.timeEntry.findMany({
            where: {
              userId: u.id,
              note: TIME_ENTRY_NOTE_MARKER,
              deletedAt: null,
            },
            select: { date: true },
          });
          const existingTeMs = new Set(
            existingTeRows.map((r) => r.date.getTime()),
          );

          // Pre-fetch existing AbsenceRecord keys for this user —
          // scoped to the catalog of types we might write so the
          // query stays narrow.
          const typeIdsInUse = Array.from(typeByCode.values()).map((t) => t.id);
          const existingAbsRows =
            typeIdsInUse.length === 0
              ? []
              : await tx.absenceRecord.findMany({
                  where: {
                    userId: u.id,
                    absenceTypeId: { in: typeIdsInUse },
                  },
                  select: { dateFrom: true, absenceTypeId: true },
                });
          const existingAbsKeys = new Set(
            existingAbsRows.map(
              (r) => `${toUtcIsoDay(r.dateFrom)}:${r.absenceTypeId}`,
            ),
          );

          // Worked days → TimeEntry.
          for (const [ym, entries] of Object.entries(emp.worked ?? {})) {
            if (!Array.isArray(entries)) continue;
            for (const w of entries) {
              if (!w?.date || typeof w.minutes !== 'number' || w.minutes <= 0) {
                continue;
              }
              const dateObj = parseUtcDate(w.date);
              if (existingTeMs.has(dateObj.getTime())) {
                teExisted++;
                continue;
              }
              teWouldCreate++;
              teByMonth[ym] = (teByMonth[ym] ?? 0) + 1;
              if (!dryRun) {
                await tx.timeEntry.create({
                  data: {
                    userId: u.id,
                    date: dateObj,
                    minutes: w.minutes,
                    note: TIME_ENTRY_NOTE_MARKER,
                    projectId: null,
                    taskId: null,
                    timeClockId: null,
                    specialHourBucketId: null,
                    // Historical seed, not customer-billable hours.
                    isBillable: false,
                  },
                });
                existingTeMs.add(dateObj.getTime());
                teCreated++;
              }
            }
          }

          // Absences → AbsenceRecord.
          for (const [ym, absences] of Object.entries(emp.absences ?? {})) {
            if (!Array.isArray(absences)) continue;
            for (const a of absences) {
              if (!a?.date || !a?.bucket) continue;
              const code = BUCKET_TO_CODE[a.bucket];
              if (!code) {
                errors.push({
                  email: emp.email,
                  code: a.bucket,
                  message: `Unknown bucket code "${a.bucket}" for ${emp.email} on ${a.date}`,
                });
                continue;
              }
              const type = typeByCode.get(code);
              if (!type) {
                errors.push({
                  email: emp.email,
                  code,
                  message: `No AbsenceType with code="${code}" (bucket=${a.bucket}, ${emp.email} on ${a.date}); run the HR seed first`,
                });
                continue;
              }
              const key = `${a.date}:${type.id}`;
              if (existingAbsKeys.has(key)) {
                absExisted++;
                continue;
              }
              absWouldCreate++;
              absByMonth[ym] = (absByMonth[ym] ?? 0) + 1;
              if (!dryRun) {
                const dateObj = parseUtcDate(a.date);
                await tx.absenceRecord.create({
                  data: {
                    userId: u.id,
                    absenceTypeId: type.id,
                    dateFrom: dateObj,
                    dateTo: dateObj,
                    amount: new Prisma.Decimal(1),
                    createdById: actorId,
                    note: ABSENCE_NOTE,
                  },
                });
                existingAbsKeys.add(key);
                absCreated++;
              }
            }
          }
        });
      } catch (err) {
        errors.push({
          email: emp.email,
          message: `Per-employee transaction failed: ${(err as Error).message}`,
        });
      }
    }

    return {
      dryRun,
      scanned,
      resolved,
      skipped,
      calendar: {
        wouldCreate: calendarWouldCreate,
        created: calendarCreated,
        existed: calendarExisted,
      },
      timeEntries: {
        wouldCreate: teWouldCreate,
        created: teCreated,
        existed: teExisted,
        byMonth: teByMonth,
      },
      absences: {
        wouldCreate: absWouldCreate,
        created: absCreated,
        existed: absExisted,
        byMonth: absByMonth,
      },
      errors,
    };
  }

  /**
   * B1 (QA-FIX-ALL 2026-11-04) — LagReason catalog seed backfill.
   *
   * The LagReason catalog (schema + migration + admin CRUD + lookups
   * endpoint) shipped in 33cc866 + 800f5ea, but Railway does NOT run
   * `prisma:seed` on deploy, so `lag_reasons` is empty on staging /
   * prod. The `prisma/seed.ts` block at §B1 performs 3 upserts; this
   * endpoint runs the exact same upserts so Yulian can trigger the
   * seed via a POST once per environment.
   *
   * Seeds (verbatim from `apps/api/prisma/seed.ts`):
   *   1. "אישור לקוח"   · nameHe "אישור לקוח"   · sortOrder 10
   *   2. "אספקה"         · nameHe "אספקה"         · sortOrder 20
   *   3. "בדיקה פנימית" · nameHe "בדיקה פנימית" · sortOrder 30
   *
   * Idempotent — upserts on `name` (unique). On update we re-assert
   * nameHe + sortOrder + isActive=true so a row that drifted (admin
   * toggled isActive off, or the sortOrder was hand-edited) snaps
   * back to the catalog default. The seed.ts block uses `update:{}`
   * to preserve admin edits; this endpoint is slightly stricter per
   * the work-order spec, which is intentional: the endpoint exists
   * so Yulian can re-seed to a known-good state after a drift.
   *
   * Response:
   *   { created: number, updated: number, skipped: number,
   *     rows: Array<{id, name, action}> }
   *
   * Query param `?dryRun=1|true|yes|on` → read-only; returns the
   * plan (which rows would be created vs updated) without writing.
   * Mirrors the convention used by `import-hr-testset` and
   * `materialize-project-deliverables`.
   */
  @Post('lag-reasons-seed')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'Backfill · LagReason catalog seed (3 rows, idempotent; ?dryRun=1|true|yes|on for plan-only)',
  })
  @ApiQuery({ name: 'dryRun', required: false, type: String, description: 'Truthy → plan only, no writes' })
  async runLagReasonsSeed(@Query('dryRun') dryRunRaw?: string) {
    const dryRun =
      typeof dryRunRaw === 'string' &&
      ['1', 'true', 'yes', 'on'].includes(dryRunRaw.toLowerCase());

    // Verbatim from apps/api/prisma/seed.ts §B1 — three Yulian-approved
    // rows. Keep this list in lockstep with the seed; any addition
    // there should be mirrored here.
    const SEEDS: Array<{
      name: string;
      nameHe: string;
      sortOrder: number;
    }> = [
      { name: 'אישור לקוח',   nameHe: 'אישור לקוח',   sortOrder: 10 },
      { name: 'אספקה',         nameHe: 'אספקה',         sortOrder: 20 },
      { name: 'בדיקה פנימית', nameHe: 'בדיקה פנימית', sortOrder: 30 },
    ];

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const rows: Array<{ id: number; name: string; action: 'created' | 'updated' | 'skipped' }> = [];

    for (const s of SEEDS) {
      const existing = await this.prisma.lagReason.findUnique({
        where: { name: s.name },
        select: { id: true, nameHe: true, sortOrder: true, isActive: true },
      });

      if (!existing) {
        if (dryRun) {
          created++;
          // id=0 as a placeholder in dry-run; real id is only known
          // after the upsert actually writes.
          rows.push({ id: 0, name: s.name, action: 'created' });
        } else {
          const r = await this.prisma.lagReason.create({
            data: {
              name: s.name,
              nameHe: s.nameHe,
              sortOrder: s.sortOrder,
              isActive: true,
            },
            select: { id: true, name: true },
          });
          created++;
          rows.push({ id: r.id, name: r.name, action: 'created' });
        }
        continue;
      }

      // Determine if the row needs an update — nameHe / sortOrder /
      // isActive must match the catalog defaults.
      const needsUpdate =
        existing.nameHe !== s.nameHe ||
        existing.sortOrder !== s.sortOrder ||
        existing.isActive !== true;

      if (!needsUpdate) {
        skipped++;
        rows.push({ id: existing.id, name: s.name, action: 'skipped' });
        continue;
      }

      if (dryRun) {
        updated++;
        rows.push({ id: existing.id, name: s.name, action: 'updated' });
      } else {
        const r = await this.prisma.lagReason.update({
          where: { name: s.name },
          data: {
            nameHe: s.nameHe,
            sortOrder: s.sortOrder,
            isActive: true,
          },
          select: { id: true, name: true },
        });
        updated++;
        rows.push({ id: r.id, name: r.name, action: 'updated' });
      }
    }

    return { dryRun, created, updated, skipped, rows };
  }
}

// ─── HR testset local types + helpers ────────────────────────────

/**
 * Shape of `docs/bm2/hr-testset-2026.json`. Validated at parse time
 * via runtime nullish checks — this type is only a developer aid.
 */
type HrTestset = {
  source?: string;
  mapBy?: string;
  dailyStandardHours?: number;
  months?: Record<
    string,
    {
      standardDays?: number;
      holidays?: Array<{ date: string; type: string; name: string }>;
    }
  >;
  employees?: Array<{
    email: string;
    legacyId?: string;
    worked?: Record<string, Array<{ date: string; minutes: number }>>;
    absences?: Record<string, Array<{ date: string; bucket: string }>>;
  }>;
};

/**
 * Parse `YYYY-MM-DD` into a Date at UTC midnight. Keeps `@db.Date`
 * columns byte-stable across host timezones (Prisma stores the UTC
 * date portion and reads it back as UTC midnight).
 */
function parseUtcDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

/**
 * Format a UTC midnight Date back into `YYYY-MM-DD` using UTC
 * getters — the inverse of {@link parseUtcDate}.
 */
function toUtcIsoDay(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Default `CalendarDay.workingHours` for the given type — mirrors
 * `CalendarService.defaultWorkingHoursForType` (HOLIDAY_EVE /
 * CHOL_HAMOED = 5h AMEC short-day, HOLIDAY / REST = 0h, REGULAR
 * never materializes via this path).
 */
function defaultWorkingHoursForCalendarType(type: CalendarDayType): number {
  switch (type) {
    case CalendarDayType.HOLIDAY_EVE:
    case CalendarDayType.CHOL_HAMOED:
      return 5;
    case CalendarDayType.HOLIDAY:
    case CalendarDayType.REST:
      return 0;
    default:
      return 0;
  }
}
