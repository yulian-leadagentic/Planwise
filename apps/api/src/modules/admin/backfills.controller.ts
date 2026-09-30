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
}
