import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import {
  extractServiceMarker,
  resolvePhasesByMarkerNames,
} from '../planning/marker-phase-resolver';

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
}
