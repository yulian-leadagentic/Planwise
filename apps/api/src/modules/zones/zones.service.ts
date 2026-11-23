import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
  HttpException,
} from '@nestjs/common';
import { Prisma, Task } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { withQueryTimeout } from '../../common/query-timeout';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { ProjectDeliverablesService } from '../project-deliverables/project-deliverables.service';
import { CreateZoneDto } from './dto/create-zone.dto';
import { UpdateZoneDto } from './dto/update-zone.dto';
import { buildCatalogMap, resolveBudget as resolveBudgetUtil } from './zones.util';

/**
 * Where a Deliverable Template's tasks land: a zone, or the project root
 * (`zoneId = null`).
 */
export interface TaskTemplateApplyTarget {
  projectId: number;
  zoneId: number | null;
}

/**
 * Group context the planning-modal pickers pre-fill when a Deliverable
 * Template is added from a group card (mirrors the web `TaskAddContext`).
 * Every field is optional; see `applyTaskTemplateToTarget` for how each
 * one merges with the template's own values.
 */
export interface TaskTemplateApplyContext {
  projectDeliverableId?: number | null;
  deliverableTemplateId?: number | null;
  phaseId?: number | null;
  serviceTypeId?: number | null;
}

/** Gap between consecutive `Task.sortOrder` values — same step as
 *  `TasksService.computeInsertSortOrder` (midpoint headroom for drags). */
const TASK_SORT_STEP = 1000;

@Injectable()
export class ZonesService {
  constructor(
    private prisma: PrismaService,
    private projectDeliverables: ProjectDeliverablesService,
    private activityLog: ActivityLogService,
  ) {}

  /**
   * Loads the Task Catalog and returns a map of code → { defaultBudgetHours, defaultBudgetAmount }.
   * Used as a fallback when template tasks don't have their own budget values set.
   *
   * Accepts an optional transaction client so callers inside $transaction
   * read a consistent snapshot of the catalog (no mid-tx drift).
   */
  private async loadCatalogMap(tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    const catalog = await client.template.findFirst({
      where: { code: '__TASK_CATALOG__' },
      include: { templateTasks: true },
    });
    return buildCatalogMap(catalog?.templateTasks ?? []);
  }

  /**
   * Resolves budget for a task: template task value OR catalog fallback by code.
   * Thin wrapper around the pure `resolveBudget` utility.
   */
  private resolveBudget(
    tt: { code?: string | null; defaultBudgetHours?: any; defaultBudgetAmount?: any },
    catalog: Map<string, { hours: any; amount: any }>,
  ) {
    return resolveBudgetUtil(tt, catalog);
  }

  /**
   * QA4 · DP-EMPTY-2 (2026-09-30) — Prevent recurrence at creation time.
   *
   * After tasks are created from a template (either applyTaskTemplate
   * or applyProjectTemplate) they may carry:
   *   • a `deliverableTemplateId` FK, or
   *   • a legacy `[SERVICE:<name>]` marker in `description` (or both,
   *     when the marker was resolved by the guard SQL later in
   *     applyProjectTemplate).
   * …but NOT a `projectDeliverableId`. Deliverable Planning grid reads
   * only real `ProjectDeliverable` rows, so those tasks landed in an
   * empty grid until DP-EMPTY-1 backfilled them.
   *
   * This helper materializes ProjectDeliverable rows per distinct
   * (project, resolvedName) and repoints every new task's
   * `projectDeliverableId` in-transaction — same shape as the backfill
   * so the two paths converge on identical row structure.
   *
   * Called from applyTaskTemplate and applyProjectTemplate after every
   * task row is written. Idempotent: an existing ProjectDeliverable
   * with the same name is reused (upsert-by-name), and the marker in
   * `description` is left untouched (existing display paths still read
   * it as a fallback / provenance).
   *
   * 2026-11-05 — this helper now DELEGATES to
   * `ProjectDeliverablesService.materializeFromTasks(projectId, { tx })`,
   * the single source of truth shared with the admin backfill endpoint
   * `POST /admin/backfills/materialize-project-deliverables`. The two
   * paths can no longer drift on the resolution rules (template.name
   * vs `[SERVICE:…]` marker), the group-by-name upsert, or the repoint
   * step.
   */
  private async materializeProjectDeliverablesForProject(
    tx: Prisma.TransactionClient,
    projectId: number,
  ): Promise<void> {
    await this.projectDeliverables.materializeFromTasks(projectId, { tx });
  }

  async findAll(projectId: number) {
    return this.prisma.zone.findMany({
      where: { projectId, deletedAt: null },
      
      orderBy: [{ path: 'asc' }, { sortOrder: 'asc' }],
    });
  }

  async findTree(projectId: number) {
    const zones = await this.prisma.zone.findMany({
      where: { projectId, deletedAt: null },
      
      orderBy: [{ path: 'asc' }, { sortOrder: 'asc' }],
    });

    const map = new Map<number, any>();
    const roots: any[] = [];

    for (const zone of zones) {
      map.set(zone.id, { ...zone, children: [] });
    }

    for (const zone of zones) {
      const node = map.get(zone.id);
      if (zone.parentId && map.has(zone.parentId)) {
        map.get(zone.parentId).children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  async findOne(id: number) {
    const zone = await this.prisma.zone.findFirst({
      where: { id, deletedAt: null },
      include: {
        children: { where: { deletedAt: null } },
        zoneServiceTypes: { include: { serviceType: true } },
        tasks: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
      },
    });

    if (!zone) {
      throw new NotFoundException('Zone not found');
    }

    return zone;
  }

  async create(dto: CreateZoneDto) {
    let path = '';
    let depth = 0;

    if (dto.parentId) {
      const parent = await this.prisma.zone.findFirst({
        where: { id: dto.parentId, deletedAt: null },
      });
      if (!parent) {
        throw new NotFoundException('Parent zone not found');
      }
      // Round 4 — a zone's parent is in the same project.
      if (parent.projectId !== dto.projectId) {
        throw new BadRequestException({
          code: 'CROSS_PROJECT_PARENT',
          message: "A zone's parent must be in the same project.",
        });
      }
      path = parent.path;
      depth = parent.depth + 1;
    }

    // Smart-insert sortOrder — Commit 8 · Model B. Zones carry no
    // planning date, so we simply append at the tail of the sibling
    // container (project + parentId). Sibling sortOrder values are seeded
    // as multiples of 1000 by planning_sequence_backfill so `max + 1000`
    // preserves midpoint headroom for a future manual drag.
    const lastSibling = await this.prisma.zone.findFirst({
      where: { projectId: dto.projectId, parentId: dto.parentId ?? null, deletedAt: null },
      orderBy: [{ sortOrder: 'desc' }, { id: 'desc' }],
      select: { sortOrder: true },
    });
    const sortOrder = (lastSibling?.sortOrder ?? 0) + 1000;

    const zone = await this.prisma.zone.create({
      data: {
        projectId: dto.projectId,
        parentId: dto.parentId ?? null,
        // §12 (2026-11-14) · The old fallback was the legacy code "zone",
        // which the `ZoneType` enum no longer has — creating a zone
        // WITHOUT a type therefore failed in Prisma (500) exactly like an
        // invalid type did. `building` is the column default and what
        // every other writer in this service falls back to. A provided
        // value is already validated / normalised by CreateZoneDto.
        zoneType: dto.zoneType || 'building',
        name: dto.name,
        code: dto.code,
        areaSqm: dto.areaSqm,
        description: dto.description,
        isTypical: dto.isTypical ?? false,
        typicalCount: dto.typicalCount ?? 1,
        path: '', // placeholder, updated below
        depth,
        sortOrder,
      },

    });

    // Update path to include own id
    const fullPath = path ? `${path}/${zone.id}` : `${zone.id}`;
    await this.prisma.zone.update({
      where: { id: zone.id },
      data: { path: fullPath },
    });

    return { ...zone, path: fullPath };
  }

  async update(id: number, dto: UpdateZoneDto) {
    await this.findOne(id);

    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.description !== undefined) data.description = dto.description;
    // §12 (2026-11-14) · `!= null`: the column is NOT NULL, so a null
    // that reaches this method without passing the DTO must mean
    // "leave it", not a Prisma error.
    if (dto.zoneType != null) data.zoneType = dto.zoneType;
    if (dto.areaSqm !== undefined) data.areaSqm = dto.areaSqm;
    if (dto.isTypical !== undefined) data.isTypical = dto.isTypical;
    if (dto.typicalCount !== undefined) data.typicalCount = dto.typicalCount;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    return this.prisma.zone.update({
      where: { id },
      data,
    });
  }

  async remove(id: number) {
    // QA3 round-5 (point 4): intermittent "Unable to connect to server"
    // on zone delete — network-level socket drop mid-request, same
    // signature as the project-26 wedge. Wrap the whole delete path in
    // the shared 10s guard so a slow/hung query fails fast with a clean
    // 503 instead of dropping the socket. The BFS `collectDescendantIds`
    // (which fired N sequential queries per tree depth) is now a single
    // recursive CTE round-trip, shrinking the window where a wedge can
    // land.
    return withQueryTimeout(
      () => this.removeImpl(id),
      10_000,
      `zone.remove(id=${id})`,
    );
  }

  private async removeImpl(id: number) {
    await this.findOne(id);

    // Cascade soft-delete: previously this only flagged the SINGLE zone
    // as deletedAt, leaving its children with parentId still pointing at
    // a now-invisible parent. The tree-list query (which filters
    // deletedAt IS NULL) then showed the orphan children "promoted" up
    // to their grandparent — exactly the bug the user reported as
    // "deleting a parent floats children up a level instead of deleting
    // them" (marked critical).
    //
    // We now recursively gather every descendant of `id` and soft-delete
    // them in one update — plus the tasks inside those zones, so the
    // archive view stays consistent.
    const descendantIds = await this.collectDescendantIds(id);
    const allIds = [id, ...descendantIds];
    const now = new Date();

    // QA3 Wave-3 Commit 9 (PR-040): block delete when ANY task under
    // this zone (or its descendants) has logged time. Mirrors the
    // "Cannot delete: still referenced" pattern in phases.service.ts.
    // We count non-deleted TimeEntry rows on non-deleted tasks under
    // any of `allIds` — one query is enough because Prisma joins the
    // task filter on the TimeEntry side. Empty zones and zones whose
    // tasks are unlogged still soft-delete normally.
    const loggedEntryCount = await this.prisma.timeEntry.count({
      where: {
        deletedAt: null,
        task: {
          deletedAt: null,
          zoneId: { in: allIds },
        },
      },
    });
    if (loggedEntryCount > 0) {
      const affectedTaskCount = await this.prisma.task.count({
        where: {
          deletedAt: null,
          zoneId: { in: allIds },
          timeEntries: { some: { deletedAt: null } },
        },
      });
      throw new ConflictException(
        `Cannot delete: ${loggedEntryCount} logged time entr${loggedEntryCount === 1 ? 'y' : 'ies'} on ${affectedTaskCount} task${affectedTaskCount === 1 ? '' : 's'} under this zone. Move or delete the logged time first.`,
      );
    }

    // ZONE-DELETE-500 fix (2026-09-29) — the unique constraint
    // `zones_project_id_name_deleted_at_key` covers (project_id, name,
    // deleted_at). When two sibling zones share a name (e.g. two "Level"
    // sub-zones under one parent), a bulk updateMany writes the SAME
    // `deletedAt` to both and the tuple collides. Rename each zone at
    // soft-delete with a `#deleted-<id>-<epoch>` suffix so the tuple is
    // guaranteed unique across concurrent deletes without a schema
    // change. Active reads still filter `deletedAt IS NULL`; archive
    // views can strip the suffix for display if needed.
    const zonesToSoftDelete = await this.prisma.zone.findMany({
      where: { id: { in: allIds }, deletedAt: null },
      select: { id: true, name: true },
    });
    const nowMs = now.getTime();

    await this.prisma.$transaction([
      ...zonesToSoftDelete.map((z) =>
        this.prisma.zone.update({
          where: { id: z.id },
          data: {
            deletedAt: now,
            name: `${z.name} #deleted-${z.id}-${nowMs}`,
          },
        }),
      ),
      // Soft-delete tasks belonging to any of the affected zones. Tasks
      // already have a deletedAt column (used for the manual delete
      // path); reusing it keeps the archive list consistent.
      // Match the single-task delete behaviour: flip status to
      // 'cancelled' so status-based reports reflect the deletion, and
      // keep the old status in status_before_delete for restore. Raw SQL
      // because updateMany cannot copy one column into another. MySQL
      // applies SET assignments left to right, so status_before_delete
      // must come BEFORE status is overwritten. updated_at is set by hand
      // (Prisma's @updatedAt only fills it for client writes).
      this.prisma.$executeRaw`
        UPDATE tasks
           SET status_before_delete = status,
               status = 'cancelled',
               deleted_at = ${now},
               updated_at = ${now}
         WHERE zone_id IN (${Prisma.join(allIds)})
           AND deleted_at IS NULL`,
    ]);

    return {
      message: 'Zone deleted',
      deletedZoneCount: allIds.length,
    };
  }

  /**
   * Collect every not-yet-deleted descendant id under `rootId`. Returns
   * [] when `rootId` is a leaf. Used by remove() for cascade soft-delete.
   *
   * QA3 round-5 (point 4): the previous BFS fired one query per tree
   * depth level (parent → children → grandchildren → …), which for a
   * modestly deep zone tree meant many sequential round-trips and a
   * wider window for a socket drop / timeout. This is now a single
   * MySQL 8 recursive CTE — one round-trip regardless of depth. Matches
   * the semantics exactly: only walks non-deleted rows, only returns
   * strict descendants (root is excluded).
   */
  private async collectDescendantIds(rootId: number): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: number }>>`
      WITH RECURSIVE zone_tree AS (
        SELECT id, parent_id
          FROM zones
         WHERE parent_id = ${rootId}
           AND deleted_at IS NULL
        UNION ALL
        SELECT z.id, z.parent_id
          FROM zones z
          INNER JOIN zone_tree zt ON z.parent_id = zt.id
         WHERE z.deleted_at IS NULL
      )
      SELECT id FROM zone_tree
    `;
    return rows.map((r) => Number(r.id));
  }

  async copyStructure(id: number, newParentId: number) {
    const source = await this.prisma.zone.findFirst({
      where: { id, deletedAt: null },
      include: { children: { where: { deletedAt: null } } },
    });
    if (!source) throw new NotFoundException('Source zone not found');

    const newParent = await this.prisma.zone.findFirst({
      where: { id: newParentId, deletedAt: null },
    });
    if (!newParent) throw new NotFoundException('Target parent zone not found');
    // Round 4 — the copy keeps the source's project, so the new parent
    // must be in that project too.
    if (newParent.projectId !== source.projectId) {
      throw new BadRequestException({
        code: 'CROSS_PROJECT_PARENT',
        message: "A zone's parent must be in the same project.",
      });
    }

    // Wrap the recursive copy in a transaction so a partial failure does not
    // leave orphan zones behind.
    const copiedId = await this.prisma.$transaction(async (tx) => {
      const copyZone = async (
        sourceZone: any,
        parentId: number,
        parentPath: string,
        depth: number,
      ): Promise<number> => {
        const created = await tx.zone.create({
          data: {
            projectId: sourceZone.projectId,
            parentId,
            zoneType: sourceZone.zoneType || 'building',
            name: `${sourceZone.name} (copy)`,
            code: sourceZone.code ? `${sourceZone.code}-copy` : null,
            areaSqm: sourceZone.areaSqm,
            description: sourceZone.description,
            isTypical: sourceZone.isTypical,
            typicalCount: sourceZone.typicalCount,
            path: '',
            depth,
          },
        });

        const fullPath = parentPath ? `${parentPath}/${created.id}` : `${created.id}`;
        await tx.zone.update({ where: { id: created.id }, data: { path: fullPath } });

        const children = await tx.zone.findMany({
          where: { parentId: sourceZone.id, deletedAt: null },
        });
        for (const child of children) {
          await copyZone(child, created.id, fullPath, depth + 1);
        }

        return created.id;
      };

      return copyZone(source, newParentId, newParent.path, newParent.depth + 1);
    }, { timeout: 30_000 });

    return this.findOne(copiedId);
  }

  async explodeTypical(id: number) {
    const zone = await this.prisma.zone.findFirst({
      where: { id, deletedAt: null },
    });

    if (!zone) {
      throw new NotFoundException('Zone not found');
    }

    if (!zone.isTypical || zone.typicalCount <= 1) {
      return [zone];
    }

    // Wrap explode + soft-delete in a transaction. Without this, a partial
    // failure leaves half the copies created but the original still active.
    return this.prisma.$transaction(async (tx) => {
      const createdZones: any[] = [];
      for (let i = 1; i <= zone.typicalCount; i++) {
        const created = await tx.zone.create({
          data: {
            projectId: zone.projectId,
            parentId: zone.parentId,
            zoneType: zone.zoneType || 'building',
            name: `${zone.name} ${i}`,
            code: zone.code ? `${zone.code}-${i}` : null,
            areaSqm: zone.areaSqm,
            description: zone.description,
            isTypical: false,
            typicalCount: 1,
            path: '',
            depth: zone.depth,
          },
        });

        const parentPath = zone.path.split('/').slice(0, -1).join('/');
        const fullPath = parentPath ? `${parentPath}/${created.id}` : `${created.id}`;
        await tx.zone.update({ where: { id: created.id }, data: { path: fullPath } });
        createdZones.push({ ...created, path: fullPath });
      }

      await tx.zone.update({ where: { id }, data: { deletedAt: new Date() } });
      return createdZones;
    }, { timeout: 30_000 });
  }

  /**
   * `POST /zones/:id/apply-task-template` — apply a Deliverable Template
   * into an existing zone with no group context. Thin wrapper over
   * `applyTaskTemplateToTarget` (the one materializer); keeps this
   * endpoint's response shape (the created task rows).
   */
  async applyTaskTemplate(zoneId: number, templateId: number, userId: number) {
    const zone = await this.prisma.zone.findFirst({
      where: { id: zoneId, deletedAt: null },
      select: { projectId: true },
    });
    if (!zone) throw new NotFoundException('Zone not found');
    const { tasks } = await this.applyTaskTemplateToTarget(
      { projectId: zone.projectId, zoneId },
      templateId,
      userId,
    );
    return tasks;
  }

  /**
   * The single server-side materializer for "add a Deliverable Template
   * (Template.type = 'task_list') into a zone or the project root".
   * One transaction creates every template task AND the dependency edges
   * between them, so a partial apply can't leave tasks without their
   * TemplateTaskDependency graph (the bug when the planning-modal
   * pickers created tasks one by one via POST /tasks).
   *
   * Field resolution per created task (template = the applied Template,
   * tt = its TemplateTask, context = the picker's group context):
   *   • zoneId / projectId — the target (zoneId null = project root).
   *   • name / budget — DN-ext: live from the catalog row when tt is
   *     linked, else tt's snapshot, then (budget only) catalog-by-code.
   *   • phaseId — context.phaseId (the Service group the PM added from)
   *     → template.phaseId (the deliverable's Service) → tt.phaseId.
   *   • serviceTypeId — tt.serviceTypeId → context.serviceTypeId.
   *   • deliverableTemplateId — context.deliverableTemplateId (the
   *     template-backed group the PM added from) → tt's own FK (QA4 · B1)
   *     → the template itself when it is a task_list.
   *   • projectDeliverableId — context.projectDeliverableId; otherwise
   *     filled by `materializeFromTasks` at the end of the tx.
   *   • priority — tt.defaultPriority; requiresReview — true (same
   *     default as POST /tasks); status — not_started.
   *   • sortOrder — appended after the target container's current last
   *     task (projectId + zoneId, as `TasksService.computeInsertSortOrder`
   *     does for one task), in the template's own order, 1000 apart.
   *
   * Dependencies: every TemplateTaskDependency edge whose both ends are
   * tasks of this template becomes a TaskDependency with the same
   * lag / lagUnit / reason (T1-3 + T1-Lag). Edges to tasks outside the
   * applied set, and self-edges, are skipped.
   *
   * Side effects kept from `TasksService.create`: ZoneServiceType upsert
   * (zone targets only), ProjectDeliverable materialization (in-tx
   * here), one `task.create` activity-log row per task (after commit,
   * best-effort, like the original). Plus `Template.usageCount += 1`.
   */
  async applyTaskTemplateToTarget(
    target: TaskTemplateApplyTarget,
    templateId: number,
    userId: number,
    context: TaskTemplateApplyContext = {},
  ): Promise<{ tasks: Task[]; dependenciesCreated: number }> {
    const { projectId, zoneId } = target;

    const result = await this.prisma.$transaction(async (tx) => {
      if (zoneId != null) {
        const zone = await tx.zone.findFirst({
          where: { id: zoneId, deletedAt: null },
          select: { projectId: true },
        });
        if (!zone) throw new NotFoundException('Zone not found');
        if (zone.projectId !== projectId) {
          throw new BadRequestException('Zone does not belong to this project');
        }
      }
      if (context.projectDeliverableId != null) {
        const deliverable = await tx.projectDeliverable.findFirst({
          where: { id: context.projectDeliverableId, projectId, deletedAt: null },
          select: { id: true },
        });
        if (!deliverable) {
          throw new BadRequestException('Deliverable does not belong to this project');
        }
      }

      const template = await tx.template.findFirst({
        where: { id: templateId, deletedAt: null },
        include: {
          // T1-3 (2026-10-20) — pull template tasks in their declared
          // `sortOrder` so the project tasks are created in the same
          // order a PM edited them in. `predecessors` carry the
          // template-level dependency graph; we materialize matching
          // `TaskDependency` rows AFTER every project task exists.
          templateTasks: {
            include: {
              // T1-Lag (2026-11-03) — carry lag/lagUnit/reason through
              // to the project side so the materialized `TaskDependency`
              // rows preserve the Deliverable Template's wait semantics.
              predecessors: {
                select: {
                  dependsOnTemplateTaskId: true,
                  lag: true,
                  lagUnit: true,
                  reason: true,
                },
              },
              // DN-ext (2026-10-22) — resolve the task's name + budget
              // LIVE from the catalog at pull-time so the project
              // Task row snapshots the CURRENT catalog name, not the
              // stale local copy. Existing project rows are never
              // retroactively updated (Yulian's locked rule); this
              // only shapes what gets written on fresh pulls.
              catalogTask: {
                select: {
                  name: true,
                  defaultBudgetHours: true,
                  defaultBudgetAmount: true,
                },
              },
            },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          },
        },
      });
      if (!template) throw new NotFoundException('Template not found');

      const catalog = await this.loadCatalogMap(tx);
      // deliverableTemplateId is only meaningful when the source is a
      // task_list template (a real Deliverable). Zone templates aren't
      // deliverables — they describe spatial structure — so we leave
      // the FK NULL in that case so the planning grid falls through to
      // the description marker / serviceType for display.
      const deliverableId = template.type === 'task_list' ? template.id : null;

      // Append after the container's current last task, keeping the
      // template's order (planning sorts by sortOrder ASC, id ASC).
      const tail = await tx.task.aggregate({
        where: { projectId, zoneId, deletedAt: null },
        _max: { sortOrder: true },
      });
      let sortOrder = tail._max.sortOrder ?? 0;

      const createdTasks: Task[] = [];
      // T1-3 — map templateTask.id → projectTask.id so we can wire
      // TaskDependency rows after the loop below.
      const idMap = new Map<number, number>();
      const linkedServiceTypeIds = new Set<number>();
      for (const tt of template.templateTasks) {
        const serviceTypeId = tt.serviceTypeId ?? context.serviceTypeId ?? null;
        if (zoneId != null && serviceTypeId != null && !linkedServiceTypeIds.has(serviceTypeId)) {
          linkedServiceTypeIds.add(serviceTypeId);
          await tx.zoneServiceType.upsert({
            where: { zoneId_serviceTypeId: { zoneId, serviceTypeId } },
            create: { zoneId, serviceTypeId },
            update: {},
          });
        }
        // DN-ext (2026-10-22) — effective name + budget preferring
        // the catalog's live values over the template-task's own
        // snapshot. For budget, this slots in BEFORE the existing
        // code-match fallback inside `resolveBudget`, so the
        // precedence is: catalog FK → local snapshot → catalog by
        // code → null. For name, there is no secondary catalog
        // resolution path yet (we never did a code-match for name),
        // so the catalog FK is the only live source — the local
        // snapshot is the fallback.
        const catalogTask = tt.catalogTask ?? null;
        const { budgetHours, budgetAmount } = this.resolveBudget(
          {
            code: tt.code,
            defaultBudgetHours: catalogTask?.defaultBudgetHours ?? tt.defaultBudgetHours,
            defaultBudgetAmount: catalogTask?.defaultBudgetAmount ?? tt.defaultBudgetAmount,
          },
          catalog,
        );
        sortOrder += TASK_SORT_STEP;
        const task = await tx.task.create({
          data: {
            zoneId,
            projectId,
            serviceTypeId,
            // Group context first (the PM added from that deliverable
            // group), then the templateTask's own FK (QA4 · B1 — a
            // rename-safe link), then the applied task_list template.
            deliverableTemplateId: context.deliverableTemplateId ?? tt.deliverableTemplateId ?? deliverableId,
            // First-class project deliverable from the group; tasks
            // without one are linked by the materialize pass below.
            projectDeliverableId: context.projectDeliverableId ?? null,
            code: tt.code,
            name: catalogTask?.name ?? tt.name,
            description: tt.description,
            budgetHours,
            budgetAmount,
            // Service: the group's (when added from a Service group),
            // else the deliverable template's, else the task's own.
            phaseId: context.phaseId ?? template.phaseId ?? tt.phaseId,
            priority: tt.defaultPriority,
            status: 'not_started',
            requiresReview: true,
            sortOrder,
            createdBy: userId,
          },
        });
        createdTasks.push(task);
        idMap.set(tt.id, task.id);
      }

      // T1-3 — translate TemplateTaskDependency edges into project
      // TaskDependency rows using the id map above. `createMany` with
      // `skipDuplicates` guards the unique(taskId, dependsOnId) index.
      // T1-Lag (2026-11-03) — carry lag/lagUnit/reason through so a
      // "wait 3 calendar days for customer approval" edge in the
      // template arrives on the project with the same semantics the
      // scheduler reads.
      const depEdges: Prisma.TaskDependencyCreateManyInput[] = [];
      for (const tt of template.templateTasks) {
        const taskId = idMap.get(tt.id);
        if (taskId == null) continue;
        for (const pred of tt.predecessors) {
          const dependsOnId = idMap.get(pred.dependsOnTemplateTaskId);
          // Predecessor outside the applied set (or a self-edge) — skip.
          if (dependsOnId == null || dependsOnId === taskId) continue;
          depEdges.push({
            taskId,
            dependsOnId,
            lag: Number(pred.lag ?? 0),
            lagUnit: pred.lagUnit ?? 'WORKING_DAYS',
            reason: pred.reason ?? null,
          });
        }
      }
      let dependenciesCreated = 0;
      if (depEdges.length > 0) {
        const written = await tx.taskDependency.createMany({ data: depEdges, skipDuplicates: true });
        dependenciesCreated = written.count;
      }

      await tx.template.update({
        where: { id: templateId },
        data: { usageCount: { increment: 1 } },
      });
      // DP-EMPTY-2 — materialize ProjectDeliverable rows for the tasks
      // this apply just created (grouped by deliverableTemplate.name or
      // [SERVICE:xxx] marker) so the Deliverable Planning grid isn't
      // empty on a template-seeded project.
      await this.materializeProjectDeliverablesForProject(tx, projectId);
      return { tasks: createdTasks, dependenciesCreated };
    }, { timeout: 30_000 }).catch((err: unknown) => this.wrapPrismaError(err));

    // Same per-task audit row `TasksService.create` writes, after the
    // commit so a rolled-back apply never logs. Best-effort by contract
    // (ActivityLogService swallows its own errors).
    for (const task of result.tasks) {
      await this.activityLog.logTaskCreated({
        actorUserId: userId,
        projectId,
        entityId: task.id,
        taskCode: task.code ?? null,
        taskName: task.name,
      });
    }

    return result;
  }

  /**
   * `POST /zones/:id/duplicate` — copy a zone with its whole live subtree
   * (any depth), every live task, the zone service-type links, and the
   * TaskDependency edges between copied tasks (lag / lagUnit / reason
   * kept). Task `sortOrder` is carried so the copy keeps the original's
   * order; dates, status and progress are NOT copied (a fresh plan).
   * Edges to a task outside the copied subtree are not copied.
   */
  async duplicateZone(zoneId: number, newName: string, userId: number) {
    const zone = await this.prisma.zone.findFirst({ where: { id: zoneId, deletedAt: null } });
    if (!zone) throw new NotFoundException('Zone not found');

    const existing = await this.prisma.zone.findFirst({
      where: { projectId: zone.projectId, name: newName, deletedAt: null },
    });
    if (existing) throw new ConflictException('Zone name must be unique within project');

    return this.prisma.$transaction(async (tx) => {
      // The zone tree is parentId-based (Zone.path can be stale after a
      // re-parent — see scheduling/target-scope.util), so load the
      // project's live zones flat and walk parentId in memory: no depth
      // limit (the old nested include stopped at 3 levels).
      const projectZones = await tx.zone.findMany({
        where: { projectId: zone.projectId, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      const childrenOf = new Map<number, typeof projectZones>();
      for (const z of projectZones) {
        if (z.parentId == null) continue;
        const siblings = childrenOf.get(z.parentId) ?? [];
        siblings.push(z);
        childrenOf.set(z.parentId, siblings);
      }
      const subtree = new Set<number>();
      const pending = [zone.id];
      while (pending.length > 0) {
        const id = pending.pop()!;
        if (subtree.has(id)) continue; // guards a corrupt parent loop
        subtree.add(id);
        for (const child of childrenOf.get(id) ?? []) pending.push(child.id);
      }
      const subtreeIds = [...subtree];

      const tasks = await tx.task.findMany({
        where: { zoneId: { in: subtreeIds }, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      const zoneServiceTypes = await tx.zoneServiceType.findMany({
        where: { zoneId: { in: subtreeIds } },
      });
      const sourceTaskIds = tasks.map((t) => t.id);
      // Edges whose BOTH ends are copied (both live — `tasks` excludes
      // soft-deleted rows).
      const sourceEdges = sourceTaskIds.length === 0
        ? []
        : await tx.taskDependency.findMany({
            where: { taskId: { in: sourceTaskIds }, dependsOnId: { in: sourceTaskIds } },
            select: { taskId: true, dependsOnId: true, lag: true, lagUnit: true, reason: true },
          });
      const tasksByZone = new Map<number, typeof tasks>();
      for (const t of tasks) {
        const list = tasksByZone.get(t.zoneId!) ?? [];
        list.push(t);
        tasksByZone.set(t.zoneId!, list);
      }
      const serviceTypesByZone = new Map<number, typeof zoneServiceTypes>();
      for (const zst of zoneServiceTypes) {
        const list = serviceTypesByZone.get(zst.zoneId) ?? [];
        list.push(zst);
        serviceTypesByZone.set(zst.zoneId, list);
      }

      const taskIdMap = new Map<number, number>(); // source task id → copy id
      const copied = new Set<number>();
      const copyZoneRecursive = async (
        sourceZone: (typeof projectZones)[number],
        parentId: number | null,
        parentPath: string,
        depth: number,
        zoneName: string,
      ) => {
        copied.add(sourceZone.id);
        const newZone = await tx.zone.create({
          data: {
            projectId: sourceZone.projectId,
            parentId,
            zoneType: sourceZone.zoneType,
            name: zoneName,
            code: sourceZone.code,
            path: '',
            depth,
            sortOrder: sourceZone.sortOrder + 1,
          },
        });
        const path = parentPath ? `${parentPath}/${newZone.id}` : `${newZone.id}`;
        await tx.zone.update({ where: { id: newZone.id }, data: { path } });

        // Copy service types
        for (const zst of serviceTypesByZone.get(sourceZone.id) ?? []) {
          await tx.zoneServiceType.create({
            data: { zoneId: newZone.id, serviceTypeId: zst.serviceTypeId, sortOrder: zst.sortOrder },
          });
        }

        // Copy every live task — planning attributes and order, not the
        // dates / status / progress.
        for (const task of tasksByZone.get(sourceZone.id) ?? []) {
          const copy = await tx.task.create({
            data: {
              zoneId: newZone.id, projectId: sourceZone.projectId,
              serviceTypeId: task.serviceTypeId, code: task.code, name: task.name,
              // Preserve source Deliverable so duplicated tasks keep
              // grouping under the same template name.
              deliverableTemplateId: task.deliverableTemplateId,
              description: task.description, budgetHours: task.budgetHours, budgetAmount: task.budgetAmount,
              phaseId: task.phaseId, priority: task.priority, status: 'not_started', completionPct: 0,
              sortOrder: task.sortOrder,
              createdBy: userId,
            },
          });
          taskIdMap.set(task.id, copy.id);
        }

        // Recursively copy children (any depth)
        for (const child of childrenOf.get(sourceZone.id) ?? []) {
          if (copied.has(child.id)) continue;
          await copyZoneRecursive(child, newZone.id, path, depth + 1, child.name);
        }

        return { ...newZone, path };
      };

      // The copy sits next to the original, so it shares the original's
      // parent path (empty for a top-level zone).
      const parentPath = zone.parentId == null ? '' : zone.path.split('/').slice(0, -1).join('/');
      const result = await copyZoneRecursive(zone, zone.parentId, parentPath, zone.depth, newName);

      // Re-create the dependency graph between the copies.
      const copiedEdges: Prisma.TaskDependencyCreateManyInput[] = [];
      for (const e of sourceEdges) {
        const taskId = taskIdMap.get(e.taskId);
        const dependsOnId = taskIdMap.get(e.dependsOnId);
        if (taskId == null || dependsOnId == null) continue;
        copiedEdges.push({ taskId, dependsOnId, lag: e.lag, lagUnit: e.lagUnit, reason: e.reason });
      }
      if (copiedEdges.length > 0) {
        await tx.taskDependency.createMany({ data: copiedEdges, skipDuplicates: true });
      }

      // DP-EMPTY-3 (2026-11-08) — mirror applyTaskTemplate /
      // applyProjectTemplate: the recursive copy above carries
      // `deliverableTemplateId` forward on every task but never sets
      // `projectDeliverableId`, which leaves the DP-EMPTY-2 invariant
      // broken for the duplicated subtree. Materialize once at the end
      // of the tx: within-project duplicates reuse the existing PD by
      // name (no new row); cross-project duplicates get a fresh PD.
      await this.materializeProjectDeliverablesForProject(tx, zone.projectId);
      return result;
    }, { timeout: 30_000 });
  }

  /**
   * PR-013: catches Prisma constraint errors from any create in the
   * transaction below and re-throws them as HTTP 4xx with a specific,
   * user-facing message. Anything genuinely unexpected still surfaces
   * as 500 (kept for observability). Without this, the entire path
   * would report "Internal server error" for both a duplicate zone
   * name (avoidable — retry with a new name) and a corrupt template
   * (real bug — needs investigation), and the UI couldn't tell them
   * apart.
   */
  private wrapPrismaError(err: unknown): never {
    // HttpException already thrown by our code (NotFoundException,
    // ConflictException, etc.) — pass through so we don't double-wrap.
    if (err instanceof HttpException) throw err;
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // Unique constraint violation. `meta.target` names the column(s).
      if (err.code === 'P2002') {
        const target = Array.isArray(err.meta?.target)
          ? (err.meta!.target as string[]).join(', ')
          : String(err.meta?.target ?? 'unknown');
        throw new ConflictException(
          `Cannot apply template: a record with the same ${target} already exists`,
        );
      }
      // Foreign key violation — a referenced entity doesn't exist
      // (e.g. the template references a Phase / ServiceType that's
      // been removed). Treat as unprocessable — the template is
      // corrupt, retrying won't help.
      if (err.code === 'P2003') {
        const field = String(err.meta?.field_name ?? err.meta?.constraint ?? 'a referenced record');
        throw new UnprocessableEntityException(
          `Cannot apply template: ${field} points to a record that no longer exists`,
        );
      }
      // Referenced record not found on connect / update.
      if (err.code === 'P2025') {
        throw new BadRequestException(
          `Cannot apply template: ${err.meta?.cause ?? 'a referenced record was not found'}`,
        );
      }
      // Value too long for column.
      if (err.code === 'P2000') {
        const col = String((err.meta as { column_name?: string } | undefined)?.column_name ?? 'column');
        throw new BadRequestException(
          `Cannot apply template: a field value is too long (${col})`,
        );
      }
    }
    // Everything else — rethrow so HttpExceptionFilter still logs the
    // stack and Sentry captures it. The user gets a generic 500 but
    // this path stays observable.
    throw err;
  }

  /**
   * Loads a template's zones FLAT (by templateId) and builds the parentId
   * tree in memory, so a zone tree of any depth comes back. The nested
   * include this replaces stopped at 3 levels for the applied template
   * and 2 for a referenced one: deeper zones were dropped, and at the
   * last level `children` was never loaded, so `isPureSlot` read "no
   * children" and could inline a zone that had some.
   *
   * Siblings come back in `sortOrder`, then `id` order. Roots are the
   * zones with `parentId = null`; a zone whose parent isn't part of this
   * template is unreachable, as before (this also means a corrupt parent
   * loop can't recurse forever — no node in it hangs off a root).
   */
  private async loadTemplateZoneTree(
    client: PrismaService | Prisma.TransactionClient,
    templateId: number,
    include: Prisma.TemplateZoneInclude,
  ): Promise<any[]> {
    const rows: any[] = await client.templateZone.findMany({
      where: { templateId },
      include,
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    const nodes = new Map<number, any>();
    for (const row of rows) nodes.set(row.id, { ...row, children: [] });
    const roots: any[] = [];
    for (const row of rows) {
      const node = nodes.get(row.id);
      if (row.parentId == null) roots.push(node);
      else nodes.get(row.parentId)?.children.push(node);
    }
    return roots;
  }

  async applyProjectTemplate(projectId: number, templateId: number, userId: number, zoneName?: string) {
    // T1-3 (2026-10-20) — pull TemplateTask rows in `sortOrder` ASC
    // AND include their `predecessors` so we can materialize matching
    // project-level TaskDependency rows after every task is created.
    // `templateZoneTasks` do not participate in the template-level
    // dependency graph (they are per-zone-template entries, not
    // referenced by TemplateTaskDependency); they continue to apply
    // without a dependency pass.
    // DN-ext (2026-10-22) — the pull path reads name + budget LIVE
    // from the catalog so a project rebuild uses the CURRENT
    // catalog values, not the stale template-side snapshot. The
    // selector mirrors `templates.service.ts findOne`'s shape so
    // the two code paths read the same fields.
    const catalogTaskSelect = {
      name: true,
      defaultBudgetHours: true,
      defaultBudgetAmount: true,
    } as const;
    const templateTaskInclude = {
      include: {
        // T1-Lag (2026-11-03) — pull per-edge Lag metadata through to
        // the materialized project `TaskDependency` rows (see
        // `materializeDeps` below). Same select on `applyTaskTemplate`.
        predecessors: {
          select: {
            dependsOnTemplateTaskId: true,
            lag: true,
            lagUnit: true,
            reason: true,
          },
        },
        catalogTask: { select: catalogTaskSelect },
      },
      orderBy: { sortOrder: 'asc' as const },
    };
    // Zone-tasks don't participate in the template-level dependency
    // graph but DO carry the same catalog FK (DN-ext), so include it
    // here so the pull path can snapshot the live name/hours.
    const templateZoneTaskInclude = {
      include: {
        catalogTask: { select: catalogTaskSelect },
      },
    };
    // What every template zone carries, at any depth (see
    // `loadTemplateZoneTree`). linkedTaskTemplate is a service template —
    // its phaseId is available.
    const templateZoneInclude = {
      templateZoneTasks: templateZoneTaskInclude,
      linkedTaskTemplate: { include: { templateTasks: templateTaskInclude } },
    };

    const template = await this.prisma.template.findUniqueOrThrow({
      where: { id: templateId },
      include: {
        templateTasks: templateTaskInclude,
      },
    });
    const templateZones = await this.loadTemplateZoneTree(this.prisma, templateId, templateZoneInclude);

    const resolveBudget = this.resolveBudget.bind(this);

    // DN-ext (2026-10-22) — pick the LIVE catalog values (name + hours
    // + amount) if the template task is linked to a catalog row,
    // falling back to the task's own local snapshot otherwise. Keeps
    // the `resolveBudget` code-match fallback as a secondary net for
    // ad-hoc rows that happen to share a code with the catalog. One
    // helper used by every `tx.task.create` site below so the pull
    // path can't drift between the four creation shapes.
    const resolveFromCatalog = (
      ttLike: {
        name: string;
        code?: string | null;
        description?: string | null;
        defaultBudgetHours?: any;
        defaultBudgetAmount?: any;
        catalogTask?: {
          name?: string | null;
          defaultBudgetHours?: any;
          defaultBudgetAmount?: any;
        } | null;
      },
    ): {
      name: string;
      description: string | null;
      budgetHours: any;
      budgetAmount: any;
    } => {
      const ct = ttLike.catalogTask ?? null;
      const ttWithCatalogBudget = {
        code: ttLike.code,
        defaultBudgetHours: ct?.defaultBudgetHours ?? ttLike.defaultBudgetHours,
        defaultBudgetAmount: ct?.defaultBudgetAmount ?? ttLike.defaultBudgetAmount,
      };
      const { budgetHours, budgetAmount } = resolveBudget(ttWithCatalogBudget, catalogRef.current ?? new Map());
      return {
        name: ct?.name ?? ttLike.name,
        description: ttLike.description ?? null,
        budgetHours,
        budgetAmount,
      };
    };
    // Captured so the helper above can read the per-tx catalog map
    // without re-opening the connection. Set once the catalog is
    // loaded inside the transaction below.
    const catalogRef: { current: Map<string, { hours: any; amount: any }> | null } = { current: null };

    try {
    return await this.prisma.$transaction(async (tx) => {
      const catalog = await this.loadCatalogMap(tx);
      catalogRef.current = catalog;
      const createdZones: any[] = [];

      // T1-3 (2026-10-20) — materialize TemplateTaskDependency edges
      // into project-level TaskDependency rows. Scope is one group of
      // templateTasks from a SINGLE template (root templateTasks,
      // linkedTaskTemplate.templateTasks, refTemplate.templateTasks).
      // Dependencies CANNOT cross templates (service enforces it), so a
      // local id map per group is enough — and avoids the ambiguity of
      // zones with instanceCount > 1 where one templateTask materializes
      // into multiple project tasks (each instance gets its own wiring).
      const materializeDeps = async (
        tasksCreated: Array<{ tt: any; projectTaskId: number }>,
      ) => {
        if (tasksCreated.length === 0) return;
        const localIdMap = new Map<number, number>();
        for (const { tt, projectTaskId } of tasksCreated) {
          localIdMap.set(tt.id, projectTaskId);
        }
        // T1-Lag (2026-11-03) — same shape as `applyTaskTemplate`'s
        // edge list; copy the template-side lag/lagUnit/reason to the
        // materialized project `TaskDependency` row.
        const edges: {
          taskId: number;
          dependsOnId: number;
          lag: number;
          lagUnit: 'WORKING_DAYS' | 'CALENDAR_DAYS';
          reason: string | null;
        }[] = [];
        for (const { tt, projectTaskId } of tasksCreated) {
          for (const pred of (tt.predecessors ?? [])) {
            const dependsOnId = localIdMap.get(pred.dependsOnTemplateTaskId);
            if (!dependsOnId) continue; // predecessor fell outside this group — skip
            edges.push({
              taskId: projectTaskId,
              dependsOnId,
              lag: Number(pred.lag ?? 0),
              lagUnit: (pred.lagUnit as 'WORKING_DAYS' | 'CALENDAR_DAYS') ?? 'WORKING_DAYS',
              reason: pred.reason ?? null,
            });
          }
        }
        if (edges.length > 0) {
          await tx.taskDependency.createMany({ data: edges, skipDuplicates: true });
        }
      };

      // ─── #196 · pure slot detection (P1 §0b decision 1) ──────────────
      // A "pure slot" is a `TemplateZone` that exists ONLY to anchor a
      // referenced Deliverable template — it has a linkedTaskTemplateId
      // but no own tasks and no own children. Compose-time refs (P1 §1)
      // emit this shape; post-migration, root-level TemplateTasks grouped
      // by deliverableTemplateId also convert to these. Rule: after apply
      // the project tree stays "physical zone → tasks grouped by
      // deliverableTemplateId", NOT "physical zone → sub-zone named after
      // the deliverable". So for a pure slot we skip creating a project
      // Zone and inline the linked tasks under the parent project zone
      // (or project-root, i.e. zoneId=null, when the slot has no parent
      // project zone).
      //
      // `referencedTemplateId` disqualifies — a referenced zone template
      // is a different shape (spatial scaffolding) handled below and we
      // keep today's behavior for it as a safety net.
      const isPureSlot = (tz: any): boolean =>
        tz.linkedTaskTemplateId != null
        && !tz.referencedTemplateId
        && (tz.templateZoneTasks?.length ?? 0) === 0
        && (tz.children?.length ?? 0) === 0;

      // Inline a pure slot's linkedTaskTemplate.templateTasks under the
      // caller's parent project zone. Keeps deliverableTemplateId so the
      // Deliverable Planning grid still groups by Service, and threads
      // predecessors through `materializeDeps` like the in-zone path.
      // Sort order: slot.sortOrder * 100 + tt.sortOrder — keeps the
      // deliverable's tasks together and preserves inner order even when
      // multiple slots inline under the same parent.
      const materializeSlotTasksUnder = async (
        tz: any,
        parentProjectZoneId: number | null,
      ): Promise<void> => {
        if (!tz.linkedTaskTemplate?.templateTasks?.length) return;
        const servicePhaseId = (tz.linkedTaskTemplate as any).phaseId;
        const anchor = (Number(tz.sortOrder) || 0) * 100;
        const createdInSlot: Array<{ tt: any; projectTaskId: number }> = [];
        for (const tt of tz.linkedTaskTemplate.templateTasks) {
          const resolved = resolveFromCatalog(tt as any);
          const createdTask = await tx.task.create({
            data: {
              zoneId: parentProjectZoneId,
              projectId,
              serviceTypeId: tt.serviceTypeId,
              // Per-templateTask FK wins over the slot's own link —
              // matches the in-zone linked path above.
              deliverableTemplateId: (tt as any).deliverableTemplateId ?? tz.linkedTaskTemplateId,
              code: tt.code,
              name: resolved.name,
              description: resolved.description,
              budgetHours: resolved.budgetHours,
              budgetAmount: resolved.budgetAmount,
              phaseId: servicePhaseId ?? tt.phaseId,
              priority: tt.defaultPriority,
              status: 'not_started',
              createdBy: userId,
              sortOrder: anchor + (Number(tt.sortOrder) || 0),
            },
          });
          createdInSlot.push({ tt, projectTaskId: createdTask.id });
        }
        await materializeDeps(createdInSlot);
      };

      // ─── Composition multiplicity ──────────────────────────────────────
      // If a template-zone has instanceCount > 1, instantiate it that many
      // times. Each instance is a separate, individually-renameable zone in
      // the project, with the same children/tasks underneath. Default 1 keeps
      // legacy templates' behaviour unchanged.
      // `refChain` — ids of the templates whose zones we are inside
      // (the applied one, then each referenced one on the way down). A
      // reference back into that chain is skipped so a referencing loop
      // in template data can't recurse forever.
      const createZoneRecursive = async (
        tz: any,
        parentId: number | null,
        parentPath: string,
        depth: number,
        refChain: ReadonlySet<number>,
      ) => {
        // #196 — pure slot: inline parent-ward, skip Zone creation.
        // Mixed zones (linked + own tasks/children) fall through to
        // `createSingleZone` and keep today's behavior as a safety net.
        if (isPureSlot(tz)) {
          await materializeSlotTasksUnder(tz, parentId);
          return;
        }
        const rawCount = Number(tz.instanceCount);
        const instanceCount = Number.isFinite(rawCount) && rawCount > 1 ? Math.floor(rawCount) : 1;
        if (instanceCount === 1) {
          await createSingleZone(tz, tz.name, parentId, parentPath, depth, refChain);
          return;
        }
        for (let i = 0; i < instanceCount; i++) {
          // Default naming: "<Template name> <N>". The user can rename each
          // instance afterwards via the inline edit in the planning view.
          const instanceName = `${tz.name} ${i + 1}`;
          await createSingleZone(tz, instanceName, parentId, parentPath, depth, refChain);
        }
      };

      const createSingleZone = async (
        tz: any,
        instanceName: string,
        parentId: number | null,
        parentPath: string,
        depth: number,
        refChain: ReadonlySet<number>,
      ) => {
        const zone = await tx.zone.create({
          data: {
            projectId,
            parentId,
            zoneType: tz.zoneType || 'building',
            name: instanceName,
            code: tz.code,
            isTypical: tz.isTypical || false,
            typicalCount: tz.typicalCount || 1,
            path: '',
            depth,
          },
        });

        const path = parentPath ? `${parentPath}/${zone.id}` : `${zone.id}`;
        await tx.zone.update({ where: { id: zone.id }, data: { path } });
        createdZones.push({ ...zone, path });

        // Create tasks from linked task template (service template)
        if (tz.linkedTaskTemplate?.templateTasks) {
          // Use the service template's phaseId for all its tasks
          const servicePhaseId = (tz.linkedTaskTemplate as any).phaseId;
          // T1-3 — collect (templateTask, projectTaskId) so we can wire
          // this group's TemplateTaskDependency → TaskDependency edges
          // after every task in the linked template exists.
          const createdInGroup: Array<{ tt: any; projectTaskId: number }> = [];
          for (const tt of tz.linkedTaskTemplate.templateTasks) {
            // DN-ext — snapshot the LIVE catalog name + budget onto
            // the project task when the template task is linked.
            const resolved = resolveFromCatalog(tt as any);
            const createdTask = await tx.task.create({
              data: {
                zoneId: zone.id, projectId, serviceTypeId: tt.serviceTypeId,
                // The linked task template is the Deliverable for these tasks.
                // QA4 · B1: prefer the per-templateTask FK (correct after a
                // deliverable rename); fall back to the zone's linked-task
                // template id for pre-backfill rows.
                deliverableTemplateId: (tt as any).deliverableTemplateId ?? tz.linkedTaskTemplateId,
                code: tt.code, name: resolved.name, description: resolved.description,
                budgetHours: resolved.budgetHours, budgetAmount: resolved.budgetAmount,
                phaseId: servicePhaseId ?? tt.phaseId, priority: tt.defaultPriority, status: 'not_started', createdBy: userId,
                // T1-3 — carry the template's explicit order into the project.
                sortOrder: tt.sortOrder,
              },
            });
            createdInGroup.push({ tt, projectTaskId: createdTask.id });
          }
          await materializeDeps(createdInGroup);
        }

        // Create tasks from templateZoneTasks (inline tasks on the zone)
        if (tz.templateZoneTasks?.length) {
          for (const tzt of tz.templateZoneTasks) {
            // DN-ext — same live-catalog resolution for the inline
            // zone-task path.
            const resolved = resolveFromCatalog(tzt as any);
            await tx.task.create({
              data: {
                zoneId: zone.id, projectId, serviceTypeId: tzt.serviceTypeId,
                // QA4 · B1 (2026-09-28) — inline zone-tasks now carry a
                // deliverable FK too (from the picker or the migration
                // backfill). Read it here so the created project task
                // arrives with its Service intact even when the Deliverable
                // template was renamed later. Description marker stays for
                // display back-compat; the final name-JOIN below is the
                // last-resort fallback for un-backfilled rows.
                deliverableTemplateId: (tzt as any).deliverableTemplateId ?? null,
                code: tzt.code, name: resolved.name, description: resolved.description,
                budgetHours: resolved.budgetHours, budgetAmount: resolved.budgetAmount,
                phaseId: tzt.phaseId, priority: tzt.defaultPriority, status: 'not_started', createdBy: userId,
              },
            });
          }
        }

        // Handle referenced template — fetch and copy its tasks + zones recursively
        if (tz.referencedTemplateId && !refChain.has(tz.referencedTemplateId)) {
          const refTemplate = await tx.template.findUnique({
            where: { id: tz.referencedTemplateId },
            include: {
              // T1-3 — same pattern as outer: pull sortOrder + predecessors
              // so the materialized project tasks respect the referenced
              // template's order AND copy its dependency graph.
              templateTasks: templateTaskInclude,
            },
          });

          if (refTemplate) {
            // Copy root-level templateTasks using referenced template's phaseId
            const refPhaseId = refTemplate.phaseId;
            // Only tag with the referenced template's id when it's a
            // task_list (Deliverable). Zone templates referenced
            // recursively contribute spatial structure — not a
            // deliverable identity.
            const refDeliverableId = refTemplate.type === 'task_list' ? tz.referencedTemplateId : null;
            const createdInRef: Array<{ tt: any; projectTaskId: number }> = [];
            for (const tt of (refTemplate.templateTasks || [])) {
              // DN-ext — live-catalog name + budget for the referenced
              // template path.
              const resolved = resolveFromCatalog(tt as any);
              const createdTask = await tx.task.create({
                data: {
                  zoneId: zone.id, projectId, serviceTypeId: tt.serviceTypeId,
                  // QA4 · B1: per-templateTask FK wins over the outer
                  // ref-template default — a referenced task_list is one
                  // deliverable per templateTask when the marker/FK sets
                  // it explicitly (post-fix).
                  deliverableTemplateId: (tt as any).deliverableTemplateId ?? refDeliverableId,
                  code: tt.code, name: resolved.name, description: resolved.description,
                  budgetHours: resolved.budgetHours, budgetAmount: resolved.budgetAmount,
                  phaseId: refPhaseId ?? tt.phaseId, priority: tt.defaultPriority || 'medium', status: 'not_started', createdBy: userId,
                  // T1-3 — carry template's sortOrder into the project.
                  sortOrder: tt.sortOrder,
                },
              });
              createdInRef.push({ tt, projectTaskId: createdTask.id });
            }
            await materializeDeps(createdInRef);

            // Recursively create child zones from referenced template —
            // its whole zone tree, any depth.
            const refZones = await this.loadTemplateZoneTree(tx, refTemplate.id, templateZoneInclude);
            const refChainBelow = new Set(refChain).add(refTemplate.id);
            for (const childTz of refZones) {
              await createZoneRecursive(childTz, zone.id, path, depth + 1, refChainBelow);
            }
          }
        }

        // Recurse into direct children
        for (const child of (tz.children || [])) {
          await createZoneRecursive(child, zone.id, path, depth + 1, refChain);
        }
      };

      // Create a main project zone with user's chosen name (or template name as fallback)
      const mainZone = await tx.zone.create({
        data: { projectId, zoneType: 'building', name: zoneName?.trim() || template.name, code: template.code, path: '', depth: 0 },
      });
      const mainPath = `${mainZone.id}`;
      await tx.zone.update({ where: { id: mainZone.id }, data: { path: mainPath } });
      createdZones.push({ ...mainZone, path: mainPath });

      // Create tasks from root-level templateTasks on the main zone.
      // Only tag with deliverableTemplateId when the outer template is
      // type=task_list (a real Deliverable). Zone templates aren't
      // deliverables, so leave the FK NULL there — the description
      // marker [SERVICE:xxx] on each templateTask still encodes the
      // deliverable identity for the legacy grouping fallback.
      if (template.templateTasks?.length) {
        const rootDeliverableId = template.type === 'task_list' ? templateId : null;
        const createdInRoot: Array<{ tt: any; projectTaskId: number }> = [];
        for (const tt of template.templateTasks) {
          // DN-ext — live-catalog name + budget for root template
          // tasks (the Deliverable Template editor's own tasks).
          const resolved = resolveFromCatalog(tt as any);
          const createdTask = await tx.task.create({
            data: {
              zoneId: mainZone.id, projectId, serviceTypeId: tt.serviceTypeId,
              // QA4 · B1: per-templateTask FK wins. For a `task_list`
              // outer template each templateTask still resolves to the
              // outer templateId when its own FK is NULL (legacy shape).
              // For a zone template (rootDeliverableId=null) the
              // templateTask's FK — set by the picker or backfill — is
              // what wires the deliverable identity.
              deliverableTemplateId: (tt as any).deliverableTemplateId ?? rootDeliverableId,
              code: tt.code, name: resolved.name, description: resolved.description,
              budgetHours: resolved.budgetHours, budgetAmount: resolved.budgetAmount,
              phaseId: tt.phaseId, priority: tt.defaultPriority || 'medium', status: 'not_started', createdBy: userId,
              // T1-3 — explicit order from the template.
              sortOrder: tt.sortOrder,
            },
          });
          createdInRoot.push({ tt, projectTaskId: createdTask.id });
        }
        await materializeDeps(createdInRoot);
      }

      // Create child zones from templateZones under the main zone
      const appliedChain = new Set([templateId]);
      for (const rootZone of templateZones) {
        await createZoneRecursive(rootZone, mainZone.id, mainPath, 1, appliedChain);
      }

      // Increment usage count
      await tx.template.update({
        where: { id: templateId },
        data: { usageCount: { increment: 1 } },
      });

      // ── Guard against deliverable-link drift ──────────────────────────
      // Several creation paths above copy a templateTask's [SERVICE:<name>]
      // description marker into the project task but leave
      // deliverable_template_id NULL (zone templates aren't deliverables).
      // The Execution Board groups by the deliverable LINK, so resolve any
      // just-created marked task to its matching Deliverable in one pass —
      // the marker stays in the description (non-destructive). This keeps
      // new data consistent with the 20260521030000 backfill so columns,
      // dropdown and filter never drift apart again.
      await tx.$executeRaw`
        UPDATE tasks t
        JOIN templates dt
          ON dt.type = 'task_list'
          AND dt.deleted_at IS NULL
          AND dt.name = TRIM(SUBSTRING(
                t.description,
                LOCATE('[SERVICE:', t.description) + 9,
                LOCATE(']', t.description, LOCATE('[SERVICE:', t.description))
                  - (LOCATE('[SERVICE:', t.description) + 9)
              ))
        SET t.deliverable_template_id = dt.id
        WHERE t.project_id = ${projectId}
          AND t.deliverable_template_id IS NULL
          AND t.description LIKE '%[SERVICE:%'`;

      // DP-EMPTY-2 — materialize a ProjectDeliverable per distinct
      // (deliverableTemplateId OR [SERVICE:xxx] marker) name for the
      // tasks this apply just created, and set every task's
      // projectDeliverableId. Runs AFTER the marker→template guard SQL
      // above so tasks resolved from a marker to a real template FK get
      // one ProjectDeliverable per source template, not two.
      await this.materializeProjectDeliverablesForProject(tx, projectId);

      return createdZones;
    }, { timeout: 30_000 });
    } catch (err) {
      this.wrapPrismaError(err);
    }
  }

  async batchReorder(items: { id: number; sortOrder: number; parentId?: number | null }[]) {
    // Round 4 — a new parent must be in the zone's own project.
    const moves = items.filter((i) => i.parentId != null);
    if (moves.length > 0) {
      const ids = [...new Set([...moves.map((m) => m.id), ...moves.map((m) => m.parentId as number)])];
      const rows = await this.prisma.zone.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: { id: true, projectId: true },
      });
      const projectOf = new Map(rows.map((r) => [r.id, r.projectId]));
      for (const m of moves) {
        if (!projectOf.has(m.parentId as number)) throw new NotFoundException('Parent zone not found');
        if (projectOf.get(m.parentId as number) !== projectOf.get(m.id)) {
          throw new BadRequestException({
            code: 'CROSS_PROJECT_PARENT',
            message: "A zone's parent must be in the same project.",
          });
        }
      }
    }
    await this.prisma.$transaction(
      items.map((item) =>
        this.prisma.zone.update({
          where: { id: item.id },
          data: {
            sortOrder: item.sortOrder,
            ...(item.parentId !== undefined ? { parentId: item.parentId } : {}),
          },
        }),
      ),
    );
    return { message: `Reordered ${items.length} zones` };
  }
}
