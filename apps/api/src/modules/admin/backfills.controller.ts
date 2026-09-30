import { Controller, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
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
  constructor(private readonly prisma: PrismaService) {}

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

    // 1. Candidate tasks — every non-deleted task without a
    //    projectDeliverableId, project-scoped only (personal tasks and
    //    orphans are excluded). Include the relations we need to resolve
    //    a name (deliverableTemplate) and to seed the deliverable's
    //    service (phase) plus the project for reporting.
    const tasks = (await this.prisma.task.findMany({
      where: {
        projectDeliverableId: null,
        deletedAt: null,
        projectId: { not: null },
      },
      select: {
        id: true,
        projectId: true,
        description: true,
        deliverableTemplateId: true,
        phaseId: true,
        project: { select: { id: true, name: true } },
        deliverableTemplate: {
          select: { id: true, name: true, phaseId: true },
        },
      },
    })) as Array<{
      id: number;
      projectId: number | null;
      description: string | null;
      deliverableTemplateId: number | null;
      phaseId: number | null;
      project: { id: number; name: string } | null;
      deliverableTemplate: { id: number; name: string; phaseId: number | null } | null;
    }>;

    // 2. Bucket per-project → per-resolvedName; track unresolved
    //    separately so the summary shows them.
    type PlanGroup = {
      name: string;
      sourceTemplateId: number | null;
      sourceTemplateSortOrder: number | null;
      phaseIds: Set<number>;
      taskIds: number[];
    };
    type ProjectPlan = {
      projectId: number;
      projectName: string;
      groups: Map<string, PlanGroup>;
      unresolved: { taskId: number; reason: string }[];
    };
    const plans = new Map<number, ProjectPlan>();

    const ensurePlan = (projectId: number, projectName: string): ProjectPlan => {
      let p = plans.get(projectId);
      if (!p) {
        p = { projectId, projectName, groups: new Map(), unresolved: [] };
        plans.set(projectId, p);
      }
      return p;
    };

    for (const t of tasks) {
      if (t.projectId == null || !t.project) continue;
      const plan = ensurePlan(t.projectId, t.project.name);

      let resolvedName: string | null = null;
      let sourceTemplateId: number | null = null;
      let sourceTemplateSortOrder: number | null = null;

      if (t.deliverableTemplateId != null && t.deliverableTemplate?.name) {
        resolvedName = t.deliverableTemplate.name;
        sourceTemplateId = t.deliverableTemplate.id;
        // Template has no sortOrder — we tail-append per project below.
        sourceTemplateSortOrder = null;
      } else {
        const marker = extractServiceMarker(t.description);
        if (marker) resolvedName = marker;
      }

      if (!resolvedName) {
        plan.unresolved.push({
          taskId: t.id,
          reason:
            t.deliverableTemplateId != null
              ? 'deliverableTemplateId set but template row/name missing'
              : 'no deliverableTemplateId and no [SERVICE:…] marker in description',
        });
        continue;
      }

      let g = plan.groups.get(resolvedName);
      if (!g) {
        g = {
          name: resolvedName,
          sourceTemplateId,
          sourceTemplateSortOrder,
          phaseIds: new Set<number>(),
          taskIds: [],
        };
        plan.groups.set(resolvedName, g);
      }
      // If any task in the group has a template FK, keep it — used to
      // seed the new deliverable's `sourceTemplateId` and `sortOrder`.
      if (g.sourceTemplateId == null && sourceTemplateId != null) {
        g.sourceTemplateId = sourceTemplateId;
        g.sourceTemplateSortOrder = sourceTemplateSortOrder;
      }
      if (t.phaseId != null) g.phaseIds.add(t.phaseId);
      g.taskIds.push(t.id);
    }

    // 3. For each project, decide reuse vs create by looking up
    //    existing ProjectDeliverable rows by (projectId, name). Then
    //    either report (dryRun) or execute (transactionally per project).
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

    for (const plan of plans.values()) {
      const existingByName = new Map<string, number>();
      const existing = await this.prisma.projectDeliverable.findMany({
        where: {
          projectId: plan.projectId,
          deletedAt: null,
          name: { in: Array.from(plan.groups.keys()) },
        },
        select: { id: true, name: true },
      });
      for (const e of existing) existingByName.set(e.name, e.id);

      const toCreate: Array<{
        name: string;
        sourcePhaseId: number | null;
        sourceTemplateId: number | null;
        taskCount: number;
        taskIds: number[];
      }> = [];
      const toReuse: Array<{
        existingId: number;
        name: string;
        taskCount: number;
        taskIds: number[];
      }> = [];
      const phaseConflicts: Array<{ deliverableName: string; phaseIds: number[] }> = [];

      for (const g of plan.groups.values()) {
        const hit = existingByName.get(g.name);
        if (hit != null) {
          toReuse.push({
            existingId: hit,
            name: g.name,
            taskCount: g.taskIds.length,
            taskIds: g.taskIds,
          });
        } else {
          const phaseIds = Array.from(g.phaseIds);
          const consistent = phaseIds.length === 1;
          const sourcePhaseId = consistent ? phaseIds[0] : null;
          if (!consistent && phaseIds.length > 1) {
            phaseConflicts.push({ deliverableName: g.name, phaseIds });
          }
          toCreate.push({
            name: g.name,
            sourcePhaseId,
            sourceTemplateId: g.sourceTemplateId,
            taskCount: g.taskIds.length,
            taskIds: g.taskIds,
          });
        }
      }

      const anythingToDo =
        toCreate.length > 0 || toReuse.length > 0;

      if (anythingToDo && !dryRun) {
        await this.prisma.$transaction(async (tx) => {
          // Seed sortOrder tail for created rows. Same strategy as
          // ProjectDeliverablesService.create (max + 1000). Compute once,
          // then increment locally so multiple creates within one project
          // land in a predictable order.
          const last = await tx.projectDeliverable.findFirst({
            where: { projectId: plan.projectId, deletedAt: null },
            orderBy: [{ sortOrder: 'desc' }, { id: 'desc' }],
            select: { sortOrder: true },
          });
          let nextSortOrder = (last?.sortOrder ?? 0) + 1000;

          const nameToId = new Map<string, number>();

          for (const c of toCreate) {
            const created = await tx.projectDeliverable.create({
              data: {
                projectId: plan.projectId,
                name: c.name,
                sourceTemplateId: c.sourceTemplateId,
                serviceId: c.sourcePhaseId,
                sortOrder: nextSortOrder,
                status: 'active',
              },
              select: { id: true, name: true },
            });
            nameToId.set(created.name, created.id);
            nextSortOrder += 1000;
          }
          for (const r of toReuse) {
            nameToId.set(r.name, r.existingId);
          }

          // Repoint tasks. Guard the WHERE with `projectDeliverableId:
          // null` so a re-run (which finds all rows already pointed)
          // touches nothing.
          for (const [name, deliverableId] of nameToId) {
            const ids =
              toCreate.find((c) => c.name === name)?.taskIds ??
              toReuse.find((r) => r.name === name)?.taskIds ??
              [];
            if (ids.length === 0) continue;
            const res = await tx.task.updateMany({
              where: { id: { in: ids }, projectDeliverableId: null },
              data: { projectDeliverableId: deliverableId },
            });
            totalRepointed += res.count;
          }
          totalCreated += toCreate.length;
        });
        projectsTouched++;
      } else if (anythingToDo && dryRun) {
        // Dry-run counters mirror what execute would report.
        totalCreated += toCreate.length;
        totalRepointed += toCreate.reduce((a, c) => a + c.taskCount, 0)
          + toReuse.reduce((a, r) => a + r.taskCount, 0);
        projectsTouched++;
      }

      totalUnresolved += plan.unresolved.length;
      perProject.push({
        projectId: plan.projectId,
        projectName: plan.projectName,
        deliverablesToCreate: toCreate,
        deliverablesToReuse: toReuse,
        unresolvedTasks: plan.unresolved,
        phaseConflicts,
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
}
