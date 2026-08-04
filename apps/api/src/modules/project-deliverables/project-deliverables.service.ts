import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { CreateProjectDeliverableDto } from './dto/create-project-deliverable.dto';
import { UpdateProjectDeliverableDto } from './dto/update-project-deliverable.dto';
import { ReorderProjectDeliverablesDto } from './dto/reorder-project-deliverables.dto';

/**
 * CRUD for the first-class, per-project Deliverable entity.
 *
 * A ProjectDeliverable is instantiated from a catalog Template but OWNS its
 * own name/description/order/status — renaming it changes the project's
 * deliverable as the PM and customer see it (planning grid, execution board,
 * reports), without ever mutating the shared catalog template.
 */
@Injectable()
export class ProjectDeliverablesService {
  constructor(
    private prisma: PrismaService,
    private activityLog: ActivityLogService,
  ) {}

  private readonly selectShape = {
    id: true,
    projectId: true,
    sourceTemplateId: true,
    serviceId: true,
    name: true,
    description: true,
    sortOrder: true,
    status: true,
    targetDate: true,
    targetMonths: true,
    estimatedDurationWeeks: true,
    service: { select: { id: true, name: true, color: true } },
  } as const;

  /** Resolve a deliverable → its projectId (for authorization). */
  async getProjectId(id: number): Promise<number> {
    const row = await this.prisma.projectDeliverable.findFirst({
      where: { id, deletedAt: null },
      select: { projectId: true },
    });
    if (!row) throw new NotFoundException('Deliverable not found');
    return row.projectId;
  }

  /** List a project's deliverables, ordered for display. Includes
   *  per-zone target rows so the Deliverable Planning UI can lay out
   *  one row per (zone × deliverable). */
  async findAllForProject(projectId: number) {
    return this.prisma.projectDeliverable.findMany({
      where: { projectId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        ...this.selectShape,
        zoneTargets: {
          select: {
            zoneId: true,
            targetDate: true,
            targetMonths: true,
            estimatedDurationWeeks: true,
          },
        },
      } as any,
    });
  }

  async create(dto: CreateProjectDeliverableDto) {
    // Default sortOrder to the end of the project's current list.
    let sortOrder = dto.sortOrder;
    if (sortOrder == null) {
      const last = await this.prisma.projectDeliverable.findFirst({
        where: { projectId: dto.projectId, deletedAt: null },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      sortOrder = (last?.sortOrder ?? -1) + 1;
    }

    // Inherit the Service line from the source template's phase when not given.
    let serviceId = dto.serviceId ?? null;
    if (serviceId == null && dto.sourceTemplateId != null) {
      const tmpl = await this.prisma.template.findUnique({
        where: { id: dto.sourceTemplateId },
        select: { phaseId: true },
      });
      serviceId = tmpl?.phaseId ?? null;
    }

    return this.prisma.projectDeliverable.create({
      data: {
        projectId: dto.projectId,
        name: dto.name.trim(),
        description: dto.description ?? null,
        sourceTemplateId: dto.sourceTemplateId ?? null,
        serviceId,
        sortOrder,
        status: 'active',
      },
      select: this.selectShape,
    });
  }

  async update(id: number, dto: UpdateProjectDeliverableDto) {
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.serviceId !== undefined) data.serviceId = dto.serviceId;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    return this.prisma.projectDeliverable.update({
      where: { id },
      data,
      select: this.selectShape,
    });
  }

  /** Batch reorder within a project. */
  async reorder(dto: ReorderProjectDeliverablesDto) {
    await this.prisma.$transaction(
      dto.items.map((it) =>
        this.prisma.projectDeliverable.update({
          where: { id: it.id },
          data: { sortOrder: it.sortOrder },
        }),
      ),
    );
    return { updated: dto.items.length };
  }

  /**
   * Soft-delete a deliverable. Tasks linked to it keep their row but lose the
   * link (project_deliverable_id is set NULL by the FK's ON DELETE SET NULL on
   * a hard delete; for the soft delete we null it explicitly so the board
   * doesn't render a phantom column).
   */
  async remove(id: number) {
    await this.prisma.$transaction([
      this.prisma.task.updateMany({
        where: { projectDeliverableId: id },
        data: { projectDeliverableId: null },
      }),
      this.prisma.projectDeliverable.update({
        where: { id },
        data: { deletedAt: new Date(), status: 'archived' },
      }),
    ]);
    return { id, deleted: true };
  }

  // ─── Deliverable Planning target-date (Tier E #10, 2026-06-30) ────
  // "Months from base date", snapped FORWARD to the NEXT Sunday
  // (Sunday is the first day of the week in Israel). We always round
  // forward so the persisted date is never earlier than the raw
  // computed date — a customer promised "in 2 months" should get at
  // least 2 months, not 4 days less. (Updated 2026-08-02 per client.)
  private computeTarget(months: number | null, baseDateInput?: string): Date | null {
    if (months == null || Number.isNaN(months) || months < 0) return null;
    const [by, bm, bd] = baseDateInput
      ? baseDateInput.split('-').map(Number)
      : (() => {
          const now = new Date();
          return [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()];
        })();
    const base = new Date(Date.UTC(by, (bm ?? 1) - 1, bd ?? 1));
    const shifted = new Date(base);
    shifted.setUTCMonth(shifted.getUTCMonth() + Math.floor(months));
    // Snap FORWARD to next Sunday. getUTCDay(): Sun=0..Sat=6.
    // Sunday → +0 (already Sunday, keep), else add (7 - day) days.
    const day = shifted.getUTCDay();
    const daysForward = day === 0 ? 0 : 7 - day;
    shifted.setUTCDate(shifted.getUTCDate() + daysForward);
    return shifted;
  }

  /** Sunday-forward snap for an explicit ISO date (client feedback
   *  2026-08-02 item 4). Same rule as computeTarget's snap: if the
   *  input date lands mid-week, move it to the following Sunday. */
  private snapToSunday(iso: string): Date {
    const [y, m, d] = iso.split('-').map(Number);
    const shifted = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
    const day = shifted.getUTCDay();
    const daysForward = day === 0 ? 0 : 7 - day;
    shifted.setUTCDate(shifted.getUTCDate() + daysForward);
    return shifted;
  }

  /** Persist a target date + optional estimated duration for either the
   *  deliverable itself (no zoneId) or a specific (zone × deliverable)
   *  pair. `durationWeeks` is CALENDAR days used by the Gantt to draw the
   *  bar from target − N days → target. Pass undefined to leave the
   *  existing duration untouched, `null` to clear it. */
  async setTarget(
    id: number,
    months: number | null,
    baseDate?: string,
    zoneId?: number,
    durationWeeks?: number | null,
  ) {
    const targetDate = this.computeTarget(months, baseDate);
    const durPatch = durationWeeks === undefined ? {} : { estimatedDurationWeeks: durationWeeks };
    if (zoneId != null) {
      await this.prisma.zoneDeliverableTarget.upsert({
        where: { zoneId_projectDeliverableId: { zoneId, projectDeliverableId: id } },
        create: { zoneId, projectDeliverableId: id, targetDate, targetMonths: months ?? null, ...durPatch },
        update: { targetDate, targetMonths: months ?? null, ...durPatch },
      });
    } else {
      await this.prisma.projectDeliverable.update({
        where: { id },
        data: { targetDate, targetMonths: months ?? null, ...durPatch },
      });
    }
    return this.prisma.projectDeliverable.findUnique({
      where: { id },
      select: { ...this.selectShape, zoneTargets: { select: { zoneId: true, targetDate: true, targetMonths: true, estimatedDurationWeeks: true } } } as any,
    });
  }

  /** Batch save (zone × deliverable) target dates for the Deliverable
   *  Planning UI. When `applyToTasks` is true, propagates the target
   *  date onto every task in that (zone, deliverable) that hasn't
   *  been manually overridden. Returns the list of tasks that WERE
   *  overridden so the UI can prompt the PM. */
  async batchSetTargets(
    items: {
      id: number;
      months: number | null;
      zoneId?: number | null;
      durationWeeks?: number | null;
      /** Explicit ISO date override — when provided, takes precedence
       *  over the months+baseDate computation. Set by the Gantt bar
       *  drag so week-level precision is preserved (client feedback
       *  2026-08-02 item 4). Still snapped forward to the next
       *  Sunday to stay consistent with the rest of the pipeline. */
      targetDate?: string | null;
    }[],
    baseDate?: string,
    applyToTasks: boolean = true,
    actorUserId?: number | null,
  ) {
    let updated = 0;
    const overriddenTasks: { taskId: number; taskName: string; currentDue: string | null; targetDate: string | null }[] = [];

    // Today midnight UTC — for detecting past-date targets that must
    // be recorded in the activity log (client feedback 2026-08-02).
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);

    for (const it of items) {
      // Capture the PRIOR target/duration so the audit-log payload can
      // record what the user is overwriting.
      const zoneId = it.zoneId ?? null;
      const prior = zoneId != null
        ? await this.prisma.zoneDeliverableTarget.findUnique({
            where: { zoneId_projectDeliverableId: { zoneId, projectDeliverableId: it.id } },
            select: { targetDate: true, targetMonths: true, estimatedDurationWeeks: true },
          })
        : await this.prisma.projectDeliverable.findUnique({
            where: { id: it.id },
            select: { targetDate: true, targetMonths: true, estimatedDurationWeeks: true, projectId: true, name: true },
          });

      // Prefer an explicit targetDate override (Gantt drag path);
      // fall back to months+baseDate for the classic table input.
      const targetDate = it.targetDate
        ? this.snapToSunday(it.targetDate)
        : this.computeTarget(it.months, baseDate);
      // durationWeeks: undefined → leave existing; null → clear;
      // number → set. Same tri-state as setTarget above.
      const durPatch = it.durationWeeks === undefined ? {} : { estimatedDurationWeeks: it.durationWeeks };

      if (zoneId != null) {
        await this.prisma.zoneDeliverableTarget.upsert({
          where: { zoneId_projectDeliverableId: { zoneId, projectDeliverableId: it.id } },
          create: { zoneId, projectDeliverableId: it.id, targetDate, targetMonths: it.months ?? null, ...durPatch },
          update: { targetDate, targetMonths: it.months ?? null, ...durPatch },
        });
      } else {
        await this.prisma.projectDeliverable.update({
          where: { id: it.id },
          data: { targetDate, targetMonths: it.months ?? null, ...durPatch },
        });
      }
      updated++;

      // Backdated-target audit log. If the newly-saved target lands
      // strictly before today, record it — regardless of whether the
      // client showed a confirmation prompt (the server is the source
      // of truth here; a rogue client that skips the modal is still
      // audited). We resolve projectId + deliverable name for the
      // description; zone context lives in metadata.
      if (targetDate && targetDate < todayMidnight) {
        const deliverable = await this.prisma.projectDeliverable.findUnique({
          where: { id: it.id },
          select: { projectId: true, name: true },
        });
        const zoneName = zoneId != null
          ? (await this.prisma.zone.findUnique({ where: { id: zoneId }, select: { name: true } }))?.name ?? `Zone #${zoneId}`
          : 'Project Root';
        const priorIso = prior?.targetDate ? new Date(prior.targetDate).toISOString().slice(0, 10) : null;
        const newIso = targetDate.toISOString().slice(0, 10);
        await this.activityLog.write({
          category: 'project',
          action: 'deliverable_target_backdated',
          entityType: 'projectDeliverable',
          entityId: it.id,
          entityName: deliverable?.name ?? `Deliverable #${it.id}`,
          projectId: deliverable?.projectId ?? null,
          actorUserId: actorUserId ?? null,
          severity: 'warn',
          description: `Backdated target for "${deliverable?.name ?? `Deliverable #${it.id}`}" (${zoneName}) — ${priorIso ?? '—'} → ${newIso}`,
          changes: {
            previousTargetDate: priorIso,
            newTargetDate: newIso,
            previousTargetMonths: prior?.targetMonths ?? null,
            newTargetMonths: it.months ?? null,
          },
          metadata: {
            zoneId,
            zoneName,
            durationWeeks: it.durationWeeks ?? null,
          },
        });
      }

      // Auto-propagate to task due dates. Match tasks by
      // (projectDeliverableId + optional zoneId). Skip tasks with
      // manual overrides — those get reported back so the PM can
      // choose to keep or overwrite in a follow-up call.
      if (applyToTasks) {
        const taskFilter: any = { projectDeliverableId: it.id, deletedAt: null, isArchived: false };
        if (zoneId != null) taskFilter.zoneId = zoneId;

        const affectedTasks = await this.prisma.task.findMany({
          where: taskFilter,
          select: { id: true, name: true, endDate: true, budgetHours: true, dueDateOverridden: true },
        });

        for (const t of affectedTasks) {
          if (t.dueDateOverridden) {
            overriddenTasks.push({
              taskId: t.id,
              taskName: t.name,
              currentDue: t.endDate ? t.endDate.toISOString().slice(0, 10) : null,
              targetDate: targetDate ? targetDate.toISOString().slice(0, 10) : null,
            });
            continue; // don't clobber user's manual date
          }

          // Est. start = due date − ceil(budgetHours / 40) weeks.
          // 40h ≈ one full working week per the client's brief.
          const budgetH = Number(t.budgetHours ?? 0);
          const weeks = budgetH > 0 ? Math.ceil(budgetH / 40) : 1;
          let estStart: Date | null = null;
          if (targetDate) {
            estStart = new Date(targetDate);
            estStart.setUTCDate(estStart.getUTCDate() - weeks * 7);
          }

          await this.prisma.task.update({
            where: { id: t.id },
            data: {
              endDate: targetDate,
              estimatedStartDate: estStart,
            },
          });
        }
      }
    }

    return { updated, overriddenTasks };
  }

  /** Force-overwrite a specific task's endDate + estimatedStartDate
   *  from its deliverable's target (used after the PM confirms the
   *  "overwrite manual dates" prompt). Clears the override flag so
   *  future auto-propagation works again. */
  async forceApplyTargetToTask(taskId: number) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: { id: true, budgetHours: true, projectDeliverableId: true, zoneId: true },
    });
    if (!task || task.projectDeliverableId == null) {
      throw new BadRequestException('Task is not linked to a deliverable');
    }
    // Try the zone-scoped target first; fall back to the deliverable-level target.
    let targetDate: Date | null = null;
    if (task.zoneId != null) {
      const zt = await this.prisma.zoneDeliverableTarget.findUnique({
        where: { zoneId_projectDeliverableId: { zoneId: task.zoneId, projectDeliverableId: task.projectDeliverableId } },
      });
      if (zt?.targetDate) targetDate = zt.targetDate;
    }
    if (!targetDate) {
      const pd = await this.prisma.projectDeliverable.findUnique({
        where: { id: task.projectDeliverableId },
        select: { targetDate: true },
      });
      targetDate = pd?.targetDate ?? null;
    }

    const budgetH = Number(task.budgetHours ?? 0);
    const weeks = budgetH > 0 ? Math.ceil(budgetH / 40) : 1;
    const estStart = targetDate ? new Date(targetDate) : null;
    if (estStart) estStart.setUTCDate(estStart.getUTCDate() - weeks * 7);

    return this.prisma.task.update({
      where: { id: taskId },
      data: { endDate: targetDate, estimatedStartDate: estStart, dueDateOverridden: false },
      select: { id: true, endDate: true, estimatedStartDate: true, dueDateOverridden: true },
    });
  }
}
