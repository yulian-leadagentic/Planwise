import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { extractServiceMarker } from '../planning/marker-phase-resolver';

// DN-ext (2026-10-22) — Fields that must NEVER be edited through the
// Deliverable Template / Zone Template editors on a row that is
// linked to a catalog TemplateTask. Those live under Task Catalog
// (the catalog's own tasks have `catalogTaskId = null`, so the
// Catalog page keeps the full edit surface). Expressed as a readonly
// array so the guard can report which specific fields were touched.
const CATALOG_LINKED_READONLY_FIELDS = [
  'name',
  'defaultBudgetHours',
  'defaultBudgetAmount',
] as const;

// DN-ext — reusable live-override: when a template task row has a
// `catalogTask` relation populated by the `findOne` include, prefer
// the catalog's current name / hours / amount over the row's own
// (snapshot) scalars. The scalars stay as a safety fallback for
// ad-hoc rows (catalogTaskId null) and for rows whose catalog row
// was deleted (`onDelete: SetNull` nulled this FK). Pure function —
// mutates only a shallow copy of the row and recurses into zone
// trees so every TemplateTask / TemplateZoneTask in the response
// gets the same treatment.
export function resolveCatalogLiveFields<T>(input: T): T {
  if (input == null) return input;
  if (Array.isArray(input)) {
    return (input as unknown[]).map(resolveCatalogLiveFields) as unknown as T;
  }
  if (typeof input !== 'object') return input;
  const row: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  const ct = row.catalogTask as
    | { name?: string | null; defaultBudgetHours?: unknown; defaultBudgetAmount?: unknown }
    | null
    | undefined;
  if (ct) {
    if (ct.name != null) row.name = ct.name;
    if (ct.defaultBudgetHours != null) row.defaultBudgetHours = ct.defaultBudgetHours;
    if (ct.defaultBudgetAmount != null) row.defaultBudgetAmount = ct.defaultBudgetAmount;
  }
  // Recurse into the nested shapes `findOne` returns so a response
  // never ships a stale name buried under a zone > child > zone-task.
  for (const key of [
    'templateTasks',
    'templateZones',
    'templateZoneTasks',
    'children',
  ]) {
    if (key in row) row[key] = resolveCatalogLiveFields(row[key]);
  }
  return row as T;
}

@Injectable()
export class TemplatesService {
  constructor(private prisma: PrismaService) {}

  /**
   * QA4 · DN-2 (2026-10-04) — Server-side resolve a Deliverable
   * Template FK from a `[SERVICE:<marker>]` description marker.
   *
   * Used by `addTask` + `addZoneTask` as a defensive fallback when
   * the caller sends only the legacy marker (e.g. an older FE build
   * cached in a tab, or a direct API caller). The B1 service-picker
   * flows already send `deliverableTemplateId` explicitly; this is
   * belt-and-braces so new rows written through either of those
   * endpoints can never again end up with a null FK + stale marker.
   *
   * Matches `catalog.name = marker` first, then `name LIKE marker\%`
   * (the `base\detail` rename form). Same preference rules as the
   * DN-1 backfill:
   *   1. Phase match (if the task has `phaseId`).
   *   2. Prefer exact over prefix.
   *   3. Still > 1 → return null (never guess).
   * Zero candidates → null.
   *
   * Templates-side only: never resolves against anything other than
   * `type=task_list, deletedAt=null` catalog rows.
   */
  private async resolveDeliverableTemplateByMarker(
    description: string | null | undefined,
    taskPhaseId: number | null | undefined,
  ): Promise<number | null> {
    const marker = extractServiceMarker(description);
    if (!marker) return null;

    const catalog = await this.prisma.template.findMany({
      where: { deletedAt: null, type: 'task_list' },
      select: { id: true, name: true, phaseId: true },
    });

    const exact = catalog.filter((t) => t.name === marker);
    const prefix = catalog.filter((t) => t.name.startsWith(`${marker}\\`));
    const all = [
      ...exact.map((t) => ({ ...t, matchKind: 'exact' as const })),
      ...prefix.map((t) => ({ ...t, matchKind: 'prefix' as const })),
    ];
    if (all.length === 0) return null;
    if (all.length === 1) return all[0].id;

    // > 1 — phase preference first.
    if (taskPhaseId != null) {
      const samePhase = all.filter((c) => c.phaseId === taskPhaseId);
      if (samePhase.length === 1) return samePhase[0].id;
      if (samePhase.length > 1) {
        const exactPhase = samePhase.find((c) => c.matchKind === 'exact');
        if (exactPhase) return exactPhase.id;
      }
    }
    // Prefer exact over prefix.
    if (exact.length === 1) return exact[0].id;
    // Still ambiguous — refuse to guess.
    return null;
  }

  async findAll(type?: string) {
    const where: any = { deletedAt: null };
    if (type) where.type = type;

    // Load templates + the per-template-zone fields we need to recursively
    // count tasks across the full composition graph (referencedTemplateId,
    // linkedTaskTemplateId, inline task counts, multiplicity).
    const templates = await this.prisma.template.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
        phase: true,
        _count: { select: { templateTasks: true, templateZones: true } },
        templateTasks: { select: { id: true, description: true }, take: 100 },
        templateZones: {
          select: {
            instanceCount: true,
            referencedTemplateId: true,
            linkedTaskTemplateId: true,
            _count: { select: { templateZoneTasks: true } },
          },
        },
      },
    });

    // Build an id → template lookup for the recursive rollup below.
    const byId = new Map<number, any>(templates.map((t: any) => [t.id, t]));

    // Direct-services set per template: distinct service codes pulled from
    // the [SERVICE:xxx] tag in each templateTask description.
    const directServicesById = new Map<number, Set<string>>();
    for (const t of templates) {
      const set = new Set<string>();
      for (const task of (t.templateTasks ?? [])) {
        const m = task.description?.match(/^\[SERVICE:(.+)\]$/);
        if (m) set.add(m[1]);
      }
      directServicesById.set(t.id, set);
    }

    // Recursive rollup: count tasks AND collect distinct services across the
    // composition graph (root tasks + linkedTaskTemplate + referencedTemplate
    // children, multiplied by instanceCount where it makes sense for tasks
    // — services are a UNION so multiplicity doesn't apply). Memoised
    // per template id; cycle-guarded.
    const taskTotalCache = new Map<number, number>();
    const serviceSetCache = new Map<number, Set<string>>();
    const visiting = new Set<number>();

    const computeRollup = (id: number): { tasks: number; services: Set<string> } => {
      if (taskTotalCache.has(id) && serviceSetCache.has(id)) {
        return { tasks: taskTotalCache.get(id)!, services: serviceSetCache.get(id)! };
      }
      if (visiting.has(id)) return { tasks: 0, services: new Set() }; // cycle — bail
      const t = byId.get(id);
      if (!t) return { tasks: 0, services: new Set() };
      visiting.add(id);

      let tasks = t._count?.templateTasks ?? 0;
      const services = new Set<string>(directServicesById.get(id) ?? []);

      for (const z of (t.templateZones ?? [])) {
        const mult = Math.max(1, Number(z.instanceCount) || 1);
        let zoneTasks = z._count?.templateZoneTasks ?? 0;
        if (z.linkedTaskTemplateId) {
          const linked = byId.get(z.linkedTaskTemplateId);
          zoneTasks += linked?._count?.templateTasks ?? 0;
          for (const s of (directServicesById.get(z.linkedTaskTemplateId) ?? [])) services.add(s);
        }
        if (z.referencedTemplateId) {
          const child = computeRollup(z.referencedTemplateId);
          zoneTasks += child.tasks;
          for (const s of child.services) services.add(s);
        }
        tasks += zoneTasks * mult;
      }
      visiting.delete(id);
      taskTotalCache.set(id, tasks);
      serviceSetCache.set(id, services);
      return { tasks, services };
    };

    return templates.map((t: any) => {
      const expandedZones = (t.templateZones ?? []).reduce(
        (sum: number, z: any) => sum + Math.max(1, Number(z.instanceCount) || 1),
        0,
      );
      const rollup = computeRollup(t.id);
      return {
        ...t,
        _count: {
          ...t._count,
          templateZones: expandedZones,
          templateZoneRows: t._count?.templateZones ?? 0,
          templateRootTasks: t._count?.templateTasks ?? 0,
          templateTasks: rollup.tasks,
        },
        // Effective service list for the UI to count distinct services
        // without needing to walk descriptions itself. Replaces the direct
        // templateTasks list (which the picker only used for service extraction).
        templateTasks: Array.from(rollup.services).map((name) => ({
          id: 0,
          description: `[SERVICE:${name}]`,
        })),
        templateZones: undefined,
      };
    });
  }

  async create(userId: number, body: any) {
    const template = await this.prisma.template.create({
      data: {
        code: body.code || `TPL-${Date.now()}`,
        name: body.name,
        type: body.type || 'task_list',
        category: body.category || null,
        description: body.description || null,
        phaseId: body.phaseId || null,
        // QA3 follow-up: default zoneType tag applied when this
        // template is referenced from another template or a project.
        // Empty string treated as null so the form's "no default"
        // option round-trips cleanly.
        defaultZoneType: body.defaultZoneType || null,
        createdBy: userId,
      },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
        phase: true,
      },
    });

    // If tasks are provided inline, create them
    if (body.tasks && Array.isArray(body.tasks)) {
      for (let i = 0; i < body.tasks.length; i++) {
        const t = body.tasks[i];
        // QA4 · DN-2 (2026-10-04) — pass the Deliverable Template FK
        // through from the inline body; if the body carries only the
        // legacy `[SERVICE:<name>]` marker, resolve the FK server-side
        // so new rows never land with null FK + marker.
        const deliverableTemplateId =
          t.deliverableTemplateId
          ?? (await this.resolveDeliverableTemplateByMarker(t.description, t.phaseId ?? null));
        // DN-ext (2026-10-22) — same catalog FK passthrough as
        // `addTask`. Keeps the `POST /templates { tasks: [...] }`
        // bulk-create path consistent with the per-task picker.
        const rawCatalogTaskId = t.catalogTaskId ?? t.sourceCatalogTaskId;
        const catalogTaskId =
          rawCatalogTaskId == null || rawCatalogTaskId === ''
            ? null
            : Number.isFinite(Number(rawCatalogTaskId))
              ? Number(rawCatalogTaskId)
              : null;
        await this.prisma.templateTask.create({
          data: {
            templateId: template.id,
            serviceTypeId: t.serviceTypeId || null,
            deliverableTemplateId,
            catalogTaskId,
            code: t.code,
            name: t.name,
            description: t.description || null,
            defaultBudgetHours: t.defaultBudgetHours || null,
            defaultBudgetAmount: t.defaultBudgetAmount || null,
            defaultPriority: t.defaultPriority || 'medium',
            phaseId: t.phaseId || null,
            sortOrder: t.sortOrder ?? i,
          },
        });
      }
    }

    return this.findOne(template.id);
  }

  async findOne(id: number) {
    // QA4 B1 follow-up (2026-09-29) — every `templateTasks`/`templateZoneTasks`
    // include now surfaces the `deliverableTemplate` relation so the FE
    // can display the deliverable's CURRENT name (post-rename), instead
    // of the frozen `[SERVICE:<name>]` marker baked into `description`.
    // Without this include, a renamed deliverable causes the SERVICE
    // column in the zone editor to render blank (the marker holds a stale
    // name; the marker-only display path had no way to look up the FK
    // target). B1's write + apply paths already prefer the FK; this
    // completes the read side.
    const deliverableSelect = { id: true, name: true, code: true } as const;
    // DN-ext (2026-10-22) — the catalog source TemplateTask whose
    // name + budget values we resolve LIVE at serialization time.
    // Carries `id` for FE "is this linked?" checks + `code` for the
    // backfill audit trail; the override below only reads name +
    // hours + amount. Shape intentionally kept minimal.
    const catalogTaskSelect = {
      id: true,
      code: true,
      name: true,
      defaultBudgetHours: true,
      defaultBudgetAmount: true,
    } as const;
    const template = await this.prisma.template.findFirst({
      where: { id, deletedAt: null },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
        phase: true,
        templateTasks: {
          include: {
            serviceType: true,
            phase: true,
            deliverableTemplate: { select: deliverableSelect },
            catalogTask: { select: catalogTaskSelect },
            // T1-2 (2026-10-20) — surface the template-task predecessor
            // graph so the FE can render chips without a per-row round
            // trip. `dependsOnTemplateTask` carries just the id/name so
            // the chip label is self-contained.
            predecessors: {
              include: {
                dependsOnTemplateTask: { select: { id: true, name: true, code: true } },
              },
              orderBy: { id: 'asc' },
            },
          },
          orderBy: { sortOrder: 'asc' },
        },
        templateZones: {
          include: {
            children: {
              include: {
                linkedTaskTemplate: { select: { id: true, name: true, code: true } },
                referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
                templateZoneTasks: {
                  include: {
                    serviceType: true,
                    phase: true,
                    deliverableTemplate: { select: deliverableSelect },
                    catalogTask: { select: catalogTaskSelect },
                  },
                },
                children: {
                  include: {
                    linkedTaskTemplate: { select: { id: true, name: true, code: true } },
                    referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
                    templateZoneTasks: {
                      include: {
                        serviceType: true,
                        phase: true,
                        deliverableTemplate: { select: deliverableSelect },
                        catalogTask: { select: catalogTaskSelect },
                      },
                    },
                  },
                },
              },
            },
            linkedTaskTemplate: { select: { id: true, name: true, code: true } },
            referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
            templateZoneTasks: {
              include: {
                serviceType: true,
                phase: true,
                deliverableTemplate: { select: deliverableSelect },
                catalogTask: { select: catalogTaskSelect },
              },
            },
          },
          where: { parentId: null },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    if (!template) throw new NotFoundException('Template not found');

    // DN-ext (2026-10-22) — resolve name + default budget LIVE from the
    // catalog so a rename in Task Catalog reaches every Deliverable /
    // Zone Template that referenced the catalog row. Local `name`,
    // `defaultBudgetHours`, `defaultBudgetAmount` columns stay in place
    // as a snapshot fallback (used when `catalogTask` is NULL — ad-hoc
    // row — or when the catalog row was deleted and `onDelete: SetNull`
    // nulled this FK). We keep `catalogTask` on the payload so the FE
    // can tell whether to render the name as read-only (linked) or
    // editable (ad-hoc), and so audits can see which source the value
    // came from. This handles only the output shape; the write-side
    // guard that forbids editing name/hours when the row is linked
    // lives on `updateTask`.
    return resolveCatalogLiveFields(template);
  }

  async update(id: number, body: any) {
    await this.findOne(id);
    return this.prisma.template.update({
      where: { id },
      data: {
        name: body.name,
        code: body.code,
        category: body.category,
        description: body.description,
        isActive: body.isActive,
        phaseId: body.phaseId !== undefined ? (body.phaseId || null) : undefined,
        // QA3 follow-up: allow editing the default zoneType. undefined
        // leaves the field alone; '' from the "— No default —" option
        // sets it back to null so the template stops carrying a type.
        defaultZoneType: body.defaultZoneType !== undefined ? (body.defaultZoneType || null) : undefined,
      },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
        phase: true,
      },
    });
  }

  async remove(id: number) {
    const template = await this.findOne(id);
    if (template.usageCount > 0) {
      throw new BadRequestException(`Cannot delete: template has been used ${template.usageCount} times`);
    }
    await this.prisma.template.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { message: 'Template deleted' };
  }

  async addTask(templateId: number, body: any) {
    await this.findOne(templateId);
    const maxOrder = await this.prisma.templateTask.aggregate({
      where: { templateId },
      _max: { sortOrder: true },
    });
    // QA4 · B1 (2026-09-28) — accept the deliverable FK from the
    // pickers. Optional (some callers still write only the marker);
    // when both come in, this is the source of truth going forward.
    // QA4 · DN-2 (2026-10-04) — if the caller sent only the legacy
    // `[SERVICE:<name>]` marker (no FK), resolve the FK server-side
    // so new rows never land as null-FK + stale-marker (the exact
    // shape DN-1 had to clean up on staging).
    const deliverableTemplateId =
      body.deliverableTemplateId
      ?? (await this.resolveDeliverableTemplateByMarker(body.description, body.phaseId ?? null));
    // DN-ext (2026-10-22) — the "Pick from Catalog" + "Add Task +
    // Also add to catalog" FE flows now pass through the catalog
    // TemplateTask id as `catalogTaskId` (or the legacy alias
    // `sourceCatalogTaskId`). Still copies name/hours as a snapshot
    // (safety fallback for when the catalog row is later deleted
    // and the FK goes NULL via `onDelete: SetNull`). We DO NOT
    // validate the id here beyond type-coercion: the DB FK does the
    // existence check atomically and an invalid id surfaces as a
    // Prisma P2003 that the caller can retry.
    const rawCatalogTaskId = body.catalogTaskId ?? body.sourceCatalogTaskId;
    const catalogTaskId =
      rawCatalogTaskId == null || rawCatalogTaskId === ''
        ? null
        : Number.isFinite(Number(rawCatalogTaskId))
          ? Number(rawCatalogTaskId)
          : null;
    return this.prisma.templateTask.create({
      data: {
        templateId,
        serviceTypeId: body.serviceTypeId || null,
        deliverableTemplateId,
        catalogTaskId,
        code: body.code,
        name: body.name,
        description: body.description || null,
        defaultBudgetHours: body.defaultBudgetHours || null,
        defaultBudgetAmount: body.defaultBudgetAmount || null,
        defaultPriority: body.defaultPriority || 'medium',
        phaseId: body.phaseId || null,
        sortOrder: body.sortOrder ?? (maxOrder._max.sortOrder ?? 0) + 1,
      },
      include: { serviceType: true, phase: true },
    });
  }

  async updateTask(taskId: number, body: any) {
    // DN-ext (2026-10-22) — name + default budget are READ-ONLY on
    // template tasks that are linked to a catalog TemplateTask
    // (`catalogTaskId != null`). Those live under the Task Catalog
    // page; the Deliverable Template editor must only edit
    // sortOrder, predecessors + delete. We check the fields the
    // CALLER passed (own-prop check so an explicit `name: undefined`
    // never trips the guard — Prisma already treats `undefined` as
    // "skip this field"), so a sortOrder-only PATCH from an editor
    // row that happens to be linked still saves.
    //
    // The guard runs ONLY when the caller actually touches one of
    // these fields with a non-undefined value AND the row is
    // catalog-linked. Catalog rows themselves have
    // `catalogTaskId = null`, so edits from the Task Catalog page
    // keep the full edit surface. Explicitly setting
    // `catalogTaskId: null` (unlink) is allowed and clears the
    // guard for subsequent name/hours edits in the same request.
    const touchedReadonly = CATALOG_LINKED_READONLY_FIELDS.filter(
      (f) => Object.prototype.hasOwnProperty.call(body, f) && body[f] !== undefined,
    );
    if (touchedReadonly.length > 0) {
      const existing = await this.prisma.templateTask.findUnique({
        where: { id: taskId },
        select: { id: true, catalogTaskId: true },
      });
      if (!existing) throw new NotFoundException('Template task not found');
      if (existing.catalogTaskId != null) {
        throw new BadRequestException(
          `Fields ${touchedReadonly.join(', ')} are read-only on tasks linked to a catalog entry — edit the task in the Task Catalog instead.`,
        );
      }
    }
    return this.prisma.templateTask.update({
      where: { id: taskId },
      data: {
        serviceTypeId: body.serviceTypeId,
        // QA4 · B1 — allow a later PATCH to correct or clear the link.
        // `undefined` skips the field entirely (Prisma treats it as
        // "not part of the update"), so legacy callers stay unaffected.
        deliverableTemplateId: body.deliverableTemplateId,
        // DN-ext — allow unlinking from the catalog by sending
        // `catalogTaskId: null` (or re-link by sending a new id).
        // The guard above only trips on name/hours edits of an
        // already-linked row, so a client that wants to override a
        // name must first unlink the row with a dedicated PATCH.
        catalogTaskId: body.catalogTaskId,
        code: body.code,
        name: body.name,
        description: body.description,
        defaultBudgetHours: body.defaultBudgetHours,
        defaultBudgetAmount: body.defaultBudgetAmount,
        defaultPriority: body.defaultPriority,
        phaseId: body.phaseId,
        sortOrder: body.sortOrder,
      },
      include: { serviceType: true, phase: true },
    });
  }

  async removeTask(taskId: number) {
    await this.prisma.templateTask.delete({ where: { id: taskId } });
    return { message: 'Template task removed' };
  }

  // ─── T1-2 · Order + Predecessors (2026-10-20) ───────────────────
  //
  // Reorder every TemplateTask inside a template to a user-chosen
  // sequence, renumbering `sortOrder` to 10, 20, 30… so individual
  // inline edits don't force cascading renumbers later. One tx so a
  // partial reorder can't leave the template in a split state.
  //
  // The caller sends the FULL ordered list of taskIds for the
  // template; any id that doesn't belong to this template is rejected
  // (prevents a stale FE from reordering tasks across templates).
  async reorderTasks(templateId: number, orderedTaskIds: number[]) {
    const existing = await this.prisma.templateTask.findMany({
      where: { templateId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((t) => t.id));
    for (const id of orderedTaskIds) {
      if (!existingIds.has(id)) {
        throw new BadRequestException(`Task ${id} does not belong to template ${templateId}`);
      }
    }
    await this.prisma.$transaction(
      orderedTaskIds.map((id, i) =>
        this.prisma.templateTask.update({
          where: { id },
          data: { sortOrder: (i + 1) * 10 },
        }),
      ),
    );
    return { message: 'Template tasks reordered', count: orderedTaskIds.length };
  }

  // List this task's predecessors — small enough that the FE just
  // reads them off the parent template fetch, but the explicit
  // endpoint is handy for optimistic replacement + verification.
  async getTaskPredecessors(taskId: number) {
    const task = await this.prisma.templateTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Template task not found');
    return this.prisma.templateTaskDependency.findMany({
      where: { templateTaskId: taskId },
      include: {
        dependsOnTemplateTask: { select: { id: true, name: true, code: true } },
      },
      orderBy: { id: 'asc' },
    });
  }

  // Replace the whole predecessor set for a TemplateTask in one call.
  // Guards:
  //   • self-dependency (p === taskId) — rejected inline.
  //   • cross-template edges (p's template != this task's template) —
  //     rejected inline.
  //   • cycle detection — DFS over the proposed graph; if adding any
  //     of the new edges would make `taskId` reachable from itself,
  //     reject with the offending path for debugging.
  //
  // bm2 2026-10-21 — AUTO-REORDER: after the dep write, if the task's
  // current `sortOrder` is <= max(predecessor.sortOrder), bump it to
  // max + 1 and shift the siblings whose sortOrder sat in the vacated
  // range DOWN by 1 so the sequence stays contiguous. A predecessor
  // must schedule BEFORE its dependent, so this is the only way to
  // keep the invariant without blocking the user's save. The whole
  // thing (delete + create + reorder) runs inside one interactive
  // transaction so a partial failure can't leave the template split.
  //
  // Response shape (breaking from the previous flat array; the FE
  // discards the body and re-fetches, so moving to the richer shape
  // is safe):
  //   { predecessors: TemplateTaskDependency[], autoReorder?: {oldOrder, newOrder} }
  async setTaskPredecessors(taskId: number, predecessorIds: number[]) {
    const task = await this.prisma.templateTask.findUnique({
      where: { id: taskId },
      select: { id: true, templateId: true, sortOrder: true },
    });
    if (!task) throw new NotFoundException('Template task not found');

    // Normalize + dedupe, drop self-refs defensively (also hard-rejected below).
    const proposed = Array.from(new Set(predecessorIds.filter((p) => Number.isFinite(p))));
    if (proposed.includes(taskId)) {
      throw new BadRequestException('A task cannot depend on itself');
    }
    let predecessorRows: Array<{ id: number; templateId: number; sortOrder: number }> = [];
    if (proposed.length > 0) {
      predecessorRows = await this.prisma.templateTask.findMany({
        where: { id: { in: proposed } },
        select: { id: true, templateId: true, sortOrder: true },
      });
      if (predecessorRows.length !== proposed.length) {
        throw new BadRequestException('One or more predecessor tasks do not exist');
      }
      for (const s of predecessorRows) {
        if (s.templateId !== task.templateId) {
          throw new BadRequestException(
            `Predecessor task ${s.id} belongs to a different template`,
          );
        }
      }
    }

    // Build the proposed graph: existing deps for every other task in
    // the template + the new set for THIS task. If a DFS starting from
    // `taskId` can reach `taskId`, there is a cycle.
    const otherDeps = await this.prisma.templateTaskDependency.findMany({
      where: {
        templateTask: { templateId: task.templateId },
        NOT: { templateTaskId: taskId },
      },
      select: { templateTaskId: true, dependsOnTemplateTaskId: true },
    });
    const adj = new Map<number, number[]>();
    const push = (from: number, to: number) => {
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from)!.push(to);
    };
    for (const d of otherDeps) push(d.templateTaskId, d.dependsOnTemplateTaskId);
    for (const p of proposed) push(taskId, p);

    // DFS from taskId; a path back to taskId = cycle. We track the
    // actual path so the error is debuggable, not just "there is a cycle".
    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const color = new Map<number, number>();
    const path: number[] = [];
    const detect = (node: number): number[] | null => {
      color.set(node, GREY);
      path.push(node);
      for (const next of adj.get(node) ?? []) {
        if (color.get(next) === GREY) {
          // Found a cycle. Trim the path to the loop section.
          const start = path.indexOf(next);
          return path.slice(start).concat(next);
        }
        if (color.get(next) === WHITE || color.get(next) === undefined) {
          const found = detect(next);
          if (found) return found;
        }
      }
      path.pop();
      color.set(node, BLACK);
      return null;
    };
    const cycle = detect(taskId);
    if (cycle) {
      throw new BadRequestException(`Dependency cycle detected: ${cycle.join(' → ')}`);
    }

    // bm2 2026-10-21 — compute the sortOrder bump BEFORE the tx so the
    // numbers we shift are from the pre-write snapshot (predecessorRows
    // was selected above with the same sortOrder values we're about to
    // compare against). Interactive $transaction so the cycle guard +
    // dep write + reorder are atomic end-to-end.
    const maxPredOrder = predecessorRows.length
      ? Math.max(...predecessorRows.map((p) => p.sortOrder))
      : -1;
    let autoReorder: { oldOrder: number; newOrder: number } | null = null;

    await this.prisma.$transaction(async (tx) => {
      // Replace the dependency set.
      await tx.templateTaskDependency.deleteMany({
        where: { templateTaskId: taskId },
      });
      if (proposed.length > 0) {
        await tx.templateTaskDependency.createMany({
          data: proposed.map((p) => ({
            templateTaskId: taskId,
            dependsOnTemplateTaskId: p,
          })),
        });
      }

      // Auto-reorder: if the current task's sortOrder is at or below
      // ANY predecessor's, bump it past the max. Shift the siblings in
      // (oldOrder, newOrder] DOWN by 1 to fill the vacated slot without
      // colliding on the UNIQUE check that `reorderTasks` relies on.
      if (maxPredOrder >= 0 && task.sortOrder <= maxPredOrder) {
        const oldOrder = task.sortOrder;
        const newOrder = maxPredOrder + 1;
        await tx.templateTask.updateMany({
          where: {
            templateId: task.templateId,
            id: { not: taskId },
            sortOrder: { gt: oldOrder, lte: newOrder },
          },
          data: { sortOrder: { decrement: 1 } },
        });
        await tx.templateTask.update({
          where: { id: taskId },
          data: { sortOrder: newOrder },
        });
        autoReorder = { oldOrder, newOrder };
      }
    });

    const predecessors = await this.prisma.templateTaskDependency.findMany({
      where: { templateTaskId: taskId },
      include: {
        dependsOnTemplateTask: { select: { id: true, name: true, code: true } },
      },
      orderBy: { id: 'asc' },
    });
    return { predecessors, autoReorder };
  }

  async addZone(templateId: number, body: any) {
    await this.findOne(templateId); // verify template exists
    const maxOrder = await this.prisma.templateZone.aggregate({
      where: { templateId, parentId: body.parentId || null },
      _max: { sortOrder: true },
    });
    return this.prisma.templateZone.create({
      data: {
        templateId,
        parentId: body.parentId || null,
        zoneType: body.zoneType || 'building',
        name: body.name,
        code: body.code || null,
        isTypical: body.isTypical || false,
        typicalCount: body.typicalCount || 1,
        // Composition multiplicity — clamp to >=1 so a malformed body can't
        // mean "0 instances" (which would silently drop the zone at apply).
        instanceCount: Math.max(1, Number(body.instanceCount) || 1),
        sortOrder: body.sortOrder ?? (maxOrder._max.sortOrder ?? 0) + 1,
        linkedTaskTemplateId: body.linkedTaskTemplateId || null,
        referencedTemplateId: body.referencedTemplateId || null,
      },
      include: {
        linkedTaskTemplate: { select: { id: true, name: true, code: true } },
        referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
      },
    });
  }

  async updateZone(zoneId: number, body: any) {
    // Only set instanceCount if the caller explicitly sent it; otherwise
    // leave whatever's in the DB. Clamp to >=1 to avoid 0 / negative values.
    const instanceCount = body.instanceCount === undefined
      ? undefined
      : Math.max(1, Number(body.instanceCount) || 1);
    return this.prisma.templateZone.update({
      where: { id: zoneId },
      data: {
        name: body.name,
        code: body.code,
        zoneType: body.zoneType,
        isTypical: body.isTypical,
        typicalCount: body.typicalCount,
        instanceCount,
        sortOrder: body.sortOrder,
        linkedTaskTemplateId: body.linkedTaskTemplateId,
        referencedTemplateId: body.referencedTemplateId,
      },
      include: {
        linkedTaskTemplate: { select: { id: true, name: true, code: true } },
        referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
      },
    });
  }

  async removeZone(zoneId: number) {
    // Cascade will delete children and templateZoneTasks
    await this.prisma.templateZone.delete({ where: { id: zoneId } });
    return { message: 'Template zone deleted' };
  }

  async addZoneTask(templateZoneId: number, body: any) {
    const maxOrder = await this.prisma.templateZoneTask.aggregate({
      where: { templateZoneId },
      _max: { sortOrder: true },
    });
    // QA4 · B1 (2026-09-28) — mirror of addTask() above; keeps the
    // deliverable FK in sync when the zone-picker writes the task.
    // QA4 · DN-2 (2026-10-04) — marker-only callers get the FK
    // resolved server-side. See addTask for rationale.
    const deliverableTemplateId =
      body.deliverableTemplateId
      ?? (await this.resolveDeliverableTemplateByMarker(body.description, body.phaseId ?? null));
    // DN-ext (2026-10-22) — mirror the catalog FK passthrough on the
    // zone-task write path. The ZoneCatalogPickerModal now sends
    // `catalogTaskId: catalogTask.id` so a rename in the catalog
    // reaches every zone template that referenced it.
    const rawCatalogTaskId = body.catalogTaskId ?? body.sourceCatalogTaskId;
    const catalogTaskId =
      rawCatalogTaskId == null || rawCatalogTaskId === ''
        ? null
        : Number.isFinite(Number(rawCatalogTaskId))
          ? Number(rawCatalogTaskId)
          : null;
    return this.prisma.templateZoneTask.create({
      data: {
        templateZoneId,
        code: body.code,
        name: body.name,
        description: body.description || null,
        defaultBudgetHours: body.defaultBudgetHours || null,
        defaultBudgetAmount: body.defaultBudgetAmount || null,
        phaseId: body.phaseId || null,
        serviceTypeId: body.serviceTypeId || null,
        deliverableTemplateId,
        catalogTaskId,
        defaultPriority: body.defaultPriority || 'medium',
        sortOrder: body.sortOrder ?? (maxOrder._max.sortOrder ?? 0) + 1,
      },
      include: { phase: true },
    });
  }

  async removeZoneTask(id: number) {
    await this.prisma.templateZoneTask.delete({ where: { id } });
    return { message: 'Zone task deleted' };
  }

  async duplicate(id: number, userId: number, body: { name: string; code: string }) {
    const source = await this.findOne(id);

    const newTemplate = await this.prisma.template.create({
      data: {
        code: body.code,
        name: body.name,
        type: source.type,
        category: source.category,
        description: source.description,
        phaseId: source.phaseId,
        createdBy: userId,
      },
    });

    for (const task of source.templateTasks) {
      await this.prisma.templateTask.create({
        data: {
          templateId: newTemplate.id,
          serviceTypeId: task.serviceTypeId,
          // QA4 · DN-2 (2026-10-04) — carry the Deliverable FK across
          // a template clone. Without this, a duplicated Deliverable
          // Template produces tasks with a stale `[SERVICE:…]` marker
          // but no FK, re-introducing the exact drift DN-1 cleaned up.
          deliverableTemplateId: (task as any).deliverableTemplateId ?? null,
          // DN-ext (2026-10-22) — same rationale for the catalog FK:
          // a clone of a Deliverable Template keeps its live link to
          // the catalog so renames keep propagating through the
          // duplicate, not just the original.
          catalogTaskId: (task as any).catalogTaskId ?? null,
          code: task.code,
          name: task.name,
          description: task.description,
          defaultBudgetHours: task.defaultBudgetHours,
          defaultBudgetAmount: task.defaultBudgetAmount,
          defaultPriority: task.defaultPriority,
          phaseId: task.phaseId,
          sortOrder: task.sortOrder,
        },
      });
    }

    return this.findOne(newTemplate.id);
  }
}
