/**
 * #196 · apply-side: child-slot distributes parent-ward (P1 §0b.1)
 *
 * Unit tests for the "pure slot" path in `ZonesService.applyProjectTemplate`.
 * A pure slot is a `TemplateZone` whose only purpose is to anchor a
 * Deliverable template — `linkedTaskTemplateId != null` AND no own
 * `templateZoneTasks` AND no own `children`. For those, apply must NOT
 * create a project Zone row; instead the linked template's tasks
 * materialize under the PARENT project zone (or project-root when the
 * slot has no parent project zone), carrying `deliverableTemplateId`
 * for Deliverable-Planning grouping and preserving predecessors.
 *
 * Mixed zones (linked + own tasks/children) keep today's behavior —
 * safety net until the P1 migration is complete.
 *
 * Prisma is jest-mocked — no DB needed. We stub `tx.task.create`,
 * `tx.zone.create`, `tx.taskDependency.createMany` and assert the
 * calls' shape (zoneId, deliverableTemplateId, sortOrder, dep edges).
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { ZonesService } from './zones.service';

type CreateCall = { data: any };

// --- helpers -------------------------------------------------------------

let nextTaskId = 1000;
let nextZoneId = 100;

function makeTx() {
  nextTaskId = 1000;
  nextZoneId = 100;
  const tx: any = {
    task: {
      create: jest.fn(async ({ data }: CreateCall) => ({ id: ++nextTaskId, ...data })),
    },
    zone: {
      create: jest.fn(async ({ data }: CreateCall) => ({ id: ++nextZoneId, ...data })),
      update: jest.fn(async () => ({})),
    },
    taskDependency: {
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    template: {
      // Catalog pull inside the transaction (loadCatalogMap).
      findFirst: jest.fn(async () => ({ templateTasks: [] })),
      // Referenced-template pull (not exercised by these specs).
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
    },
    $executeRaw: jest.fn(async () => 0),
  };
  return tx;
}

// `applyProjectTemplate` loads template zones FLAT (by templateId) and
// builds the tree itself. Fixtures stay readable as nested trees; this
// turns one into the rows the DB would return (parentId set, ordered by
// sortOrder then id, `children` not part of the row).
function flattenTemplateZones(zones: any[], templateId: number, parentId: number | null = null): any[] {
  return zones.flatMap((z) => {
    const { children, ...row } = z;
    return [
      { ...row, parentId, templateId },
      ...flattenTemplateZones(children ?? [], templateId, z.id),
    ];
  });
}

function templateZoneRows(templates: any[]) {
  const rows = templates.flatMap((t) => flattenTemplateZones(t.templateZones ?? [], t.id));
  return jest.fn(async ({ where }: any) =>
    rows
      .filter((r) => r.templateId === where.templateId)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id),
  );
}

function makeService(template: any, referencedTemplates: any[] = []) {
  const tx = makeTx();
  tx.templateZone = { findMany: templateZoneRows(referencedTemplates) };
  tx.template.findUnique = jest.fn(async ({ where }: any) =>
    referencedTemplates.find((t) => t.id === where.id) ?? null,
  );
  const prisma: any = {
    template: {
      findUniqueOrThrow: jest.fn(async () => template),
    },
    templateZone: { findMany: templateZoneRows([template]) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const projectDeliverables: any = {
    materializeFromTasks: jest.fn(async () => undefined),
  };
  const activityLog: any = { logTaskCreated: jest.fn(async () => undefined) };
  const service = new ZonesService(prisma, projectDeliverables, activityLog);
  return { service, tx };
}

// Shape helpers — every template shape the apply path touches has a
// predictable set of fields (phaseId, type, templateTasks, templateZones).
function mkDeliverableTemplate(opts: {
  id: number;
  tasks?: Array<{
    id: number;
    code?: string;
    name: string;
    sortOrder?: number;
    serviceTypeId?: number | null;
    phaseId?: number | null;
    predecessors?: Array<{
      dependsOnTemplateTaskId: number;
      lag?: number;
      lagUnit?: 'WORKING_DAYS' | 'CALENDAR_DAYS';
      reason?: string | null;
    }>;
  }>;
  phaseId?: number | null;
}) {
  return {
    id: opts.id,
    type: 'task_list',
    phaseId: opts.phaseId ?? null,
    templateTasks: (opts.tasks ?? []).map((t) => ({
      id: t.id,
      code: t.code ?? null,
      name: t.name,
      description: null,
      sortOrder: t.sortOrder ?? 0,
      serviceTypeId: t.serviceTypeId ?? null,
      phaseId: t.phaseId ?? null,
      defaultPriority: 'medium',
      defaultBudgetHours: null,
      defaultBudgetAmount: null,
      deliverableTemplateId: null,
      catalogTask: null,
      predecessors: (t.predecessors ?? []).map((p) => ({
        dependsOnTemplateTaskId: p.dependsOnTemplateTaskId,
        lag: p.lag ?? 0,
        lagUnit: p.lagUnit ?? 'WORKING_DAYS',
        reason: p.reason ?? null,
      })),
    })),
  };
}

function mkSlotZone(opts: {
  id: number;
  name?: string;
  sortOrder?: number;
  linkedTaskTemplateId: number;
  linkedTaskTemplate: any;
  children?: any[];
}) {
  return {
    id: opts.id,
    name: opts.name ?? 'slot',
    code: null,
    zoneType: 'building',
    isTypical: false,
    typicalCount: 1,
    instanceCount: 1,
    sortOrder: opts.sortOrder ?? 0,
    linkedTaskTemplateId: opts.linkedTaskTemplateId,
    referencedTemplateId: null,
    linkedTaskTemplate: opts.linkedTaskTemplate,
    templateZoneTasks: [], // pure slot: no own tasks
    children: opts.children ?? [], // pure slot: no own children
  };
}

function mkZone(opts: {
  id: number;
  name: string;
  sortOrder?: number;
  templateZoneTasks?: any[];
  linkedTaskTemplateId?: number | null;
  linkedTaskTemplate?: any;
  children?: any[];
}) {
  return {
    id: opts.id,
    name: opts.name,
    code: null,
    zoneType: 'building',
    isTypical: false,
    typicalCount: 1,
    instanceCount: 1,
    sortOrder: opts.sortOrder ?? 0,
    linkedTaskTemplateId: opts.linkedTaskTemplateId ?? null,
    referencedTemplateId: null,
    linkedTaskTemplate: opts.linkedTaskTemplate ?? null,
    templateZoneTasks: opts.templateZoneTasks ?? [],
    children: opts.children ?? [],
  };
}

function mkOuterTemplate(opts: {
  id: number;
  name?: string;
  type?: 'zone_template' | 'task_list';
  templateTasks?: any[];
  templateZones?: any[];
}) {
  return {
    id: opts.id,
    name: opts.name ?? 'Outer Template',
    code: null,
    type: opts.type ?? 'zone_template',
    phaseId: null,
    templateTasks: opts.templateTasks ?? [],
    templateZones: opts.templateZones ?? [],
  };
}

// Pull every task.create call's data payload.
const createdTaskData = (tx: any): any[] =>
  (tx.task.create.mock.calls as any[]).map((c) => c[0].data);

const createdZoneNames = (tx: any): string[] =>
  (tx.zone.create.mock.calls as any[]).map((c) => c[0].data.name);

// Resolve the id of the Nth tx.zone.create — since the mock is async
// (returns a Promise), `mock.results[N].value` is itself a Promise;
// we must await it to see the id. Returns 1-indexed convenience:
// zoneIdAt(tx, 0) is the first created zone.
const zoneIdAt = async (tx: any, index: number): Promise<number> => {
  const entry = (tx.zone.create.mock.results as any[])[index];
  const resolved = await entry.value;
  return resolved.id;
};

// --- tests ---------------------------------------------------------------

describe('ZonesService.applyProjectTemplate · #196 pure-slot inlining', () => {
  it('(1) pure ROOT slot — no sub-zone created, linked tasks inline under main project zone with deliverableTemplateId + 2 TaskDependency edges', async () => {
    const deliverable = mkDeliverableTemplate({
      id: 41,
      tasks: [
        { id: 501, name: 'A', sortOrder: 0 },
        { id: 502, name: 'B', sortOrder: 1, predecessors: [{ dependsOnTemplateTaskId: 501, lag: 7, lagUnit: 'WORKING_DAYS', reason: 'wait' }] },
        { id: 503, name: 'C', sortOrder: 2, predecessors: [{ dependsOnTemplateTaskId: 502, lag: 7, lagUnit: 'CALENDAR_DAYS' }] },
      ],
    });
    const slot = mkSlotZone({ id: 9001, name: 'Deliverable Slot', sortOrder: 5, linkedTaskTemplateId: 41, linkedTaskTemplate: deliverable });
    const outer = mkOuterTemplate({ id: 99, templateZones: [slot] });

    const { service, tx } = makeService(outer);
    await service.applyProjectTemplate(7, 99, 42, 'My Project');

    // Only the main project Zone is created — NOT a Zone for the slot.
    expect(tx.zone.create).toHaveBeenCalledTimes(1);
    expect(createdZoneNames(tx)).toEqual(['My Project']);

    const mainZoneId = await zoneIdAt(tx, 0);

    // All three linked tasks are created, all pinned to the main project
    // zone (slot's parent), carrying the linkedTaskTemplateId as the
    // deliverable FK.
    expect(tx.task.create).toHaveBeenCalledTimes(3);
    const datas = createdTaskData(tx);
    for (const d of datas) {
      expect(d.zoneId).toBe(mainZoneId);
      expect(d.deliverableTemplateId).toBe(41);
      expect(d.projectId).toBe(7);
      expect(d.createdBy).toBe(42);
    }
    expect(datas.map((d) => d.name)).toEqual(['A', 'B', 'C']);
    // Sort order: slot.sortOrder (5) * 100 + tt.sortOrder → 500/501/502.
    expect(datas.map((d) => d.sortOrder)).toEqual([500, 501, 502]);

    // Predecessors materialize into project-level TaskDependency rows,
    // one per edge, with lag/lagUnit/reason preserved.
    expect(tx.taskDependency.createMany).toHaveBeenCalledTimes(1);
    const depArg = (tx.taskDependency.createMany.mock.calls as any[])[0][0];
    expect(depArg.skipDuplicates).toBe(true);
    expect(depArg.data).toHaveLength(2);
    // Edge 502→501 (B depends on A), lag 7 WORKING_DAYS.
    const edgeBA = depArg.data.find((e: any) => e.lag === 7 && e.lagUnit === 'WORKING_DAYS');
    expect(edgeBA).toBeDefined();
    expect(edgeBA.reason).toBe('wait');
    // Edge 503→502 (C depends on B), lag 7 CALENDAR_DAYS.
    const edgeCB = depArg.data.find((e: any) => e.lagUnit === 'CALENDAR_DAYS');
    expect(edgeCB).toBeDefined();
    expect(edgeCB.lag).toBe(7);
  });

  it('(2) pure CHILD slot — one parent Zone created, slot linked tasks live under that parent, no slot sub-zone', async () => {
    const deliverable = mkDeliverableTemplate({
      id: 41,
      tasks: [
        { id: 501, name: 'A', sortOrder: 0 },
        { id: 502, name: 'B', sortOrder: 1 },
        { id: 503, name: 'C', sortOrder: 2 },
      ],
    });
    const slot = mkSlotZone({ id: 9002, name: 'Deliverable Slot', sortOrder: 3, linkedTaskTemplateId: 41, linkedTaskTemplate: deliverable });
    const parentZone = mkZone({ id: 8001, name: 'Floor 1', children: [slot] });
    const outer = mkOuterTemplate({ id: 99, templateZones: [parentZone] });

    const { service, tx } = makeService(outer);
    await service.applyProjectTemplate(7, 99, 42, 'My Project');

    // Main project zone + Floor 1 — but NOT a sub-zone for the slot.
    expect(tx.zone.create).toHaveBeenCalledTimes(2);
    expect(createdZoneNames(tx)).toEqual(['My Project', 'Floor 1']);

    const floor1Id = await zoneIdAt(tx, 1);

    // 3 linked tasks under Floor 1, with the deliverable FK.
    expect(tx.task.create).toHaveBeenCalledTimes(3);
    const datas = createdTaskData(tx);
    for (const d of datas) {
      expect(d.zoneId).toBe(floor1Id);
      expect(d.deliverableTemplateId).toBe(41);
    }
    expect(datas.map((d) => d.sortOrder)).toEqual([300, 301, 302]);
  });

  it('(3) mixed zone (linked + own tasks) — today\'s behavior: Zone created, all tasks under it (regression guard)', async () => {
    const deliverable = mkDeliverableTemplate({
      id: 41,
      tasks: [{ id: 501, name: 'LinkedA', sortOrder: 0 }],
    });
    // Zone has BOTH a linkedTaskTemplate AND its own templateZoneTasks
    // → not a pure slot, keep today's behavior.
    const mixed = mkZone({
      id: 8002,
      name: 'Mixed',
      sortOrder: 0,
      linkedTaskTemplateId: 41,
      linkedTaskTemplate: deliverable,
      templateZoneTasks: [
        {
          id: 701,
          code: null,
          name: 'OwnTask',
          description: null,
          serviceTypeId: null,
          phaseId: null,
          defaultPriority: 'medium',
          defaultBudgetHours: null,
          defaultBudgetAmount: null,
          deliverableTemplateId: null,
          catalogTask: null,
        },
      ],
    });
    const outer = mkOuterTemplate({ id: 99, templateZones: [mixed] });

    const { service, tx } = makeService(outer);
    await service.applyProjectTemplate(7, 99, 42);

    // Main zone + Mixed zone — Mixed survives because it's not a pure slot.
    expect(tx.zone.create).toHaveBeenCalledTimes(2);
    expect(createdZoneNames(tx)).toEqual([outer.name, 'Mixed']);

    const mixedZoneId = await zoneIdAt(tx, 1);

    // Linked tasks + own tasks both land on Mixed.
    expect(tx.task.create).toHaveBeenCalledTimes(2);
    for (const d of createdTaskData(tx)) {
      expect(d.zoneId).toBe(mixedZoneId);
    }
  });

  it('(4) mixed zone with child pure slot — parent Zone created, parent\'s own tasks AND slot\'s linked tasks ALL inline under parent (deliverable grouping preserved via deliverableTemplateId)', async () => {
    const deliverable = mkDeliverableTemplate({
      id: 41,
      tasks: [
        { id: 501, name: 'SlotA', sortOrder: 0 },
        { id: 502, name: 'SlotB', sortOrder: 1 },
      ],
    });
    const slot = mkSlotZone({ id: 9003, name: 'Deliverable Slot', sortOrder: 2, linkedTaskTemplateId: 41, linkedTaskTemplate: deliverable });
    const parent = mkZone({
      id: 8003,
      name: 'Parent',
      sortOrder: 0,
      templateZoneTasks: [
        {
          id: 801,
          code: null,
          name: 'ParentOwn',
          description: null,
          serviceTypeId: null,
          phaseId: null,
          defaultPriority: 'medium',
          defaultBudgetHours: null,
          defaultBudgetAmount: null,
          deliverableTemplateId: null,
          catalogTask: null,
        },
      ],
      children: [slot],
    });
    const outer = mkOuterTemplate({ id: 99, templateZones: [parent] });

    const { service, tx } = makeService(outer);
    await service.applyProjectTemplate(7, 99, 42, 'P');

    // Main project zone + Parent — the slot does NOT get its own Zone.
    expect(tx.zone.create).toHaveBeenCalledTimes(2);
    expect(createdZoneNames(tx)).toEqual(['P', 'Parent']);

    const parentZoneId = await zoneIdAt(tx, 1);
    const datas = createdTaskData(tx);

    // 1 parent-own task + 2 slot-linked tasks, all on Parent.
    expect(datas).toHaveLength(3);
    for (const d of datas) expect(d.zoneId).toBe(parentZoneId);

    // The parent-own task has no deliverable FK (nothing set on the
    // templateZoneTask); the slot-linked tasks carry 41.
    const own = datas.find((d) => d.name === 'ParentOwn');
    const slotA = datas.find((d) => d.name === 'SlotA');
    const slotB = datas.find((d) => d.name === 'SlotB');
    expect(own.deliverableTemplateId).toBeNull();
    expect(slotA.deliverableTemplateId).toBe(41);
    expect(slotB.deliverableTemplateId).toBe(41);
  });

  it('(5) deep-nested slot — root + mid Zones created, slot\'s linked tasks live under MID (not root)', async () => {
    const deliverable = mkDeliverableTemplate({
      id: 41,
      tasks: [
        { id: 501, name: 'DeepA', sortOrder: 0 },
        { id: 502, name: 'DeepB', sortOrder: 1 },
      ],
    });
    const slot = mkSlotZone({ id: 9004, name: 'Deliverable Slot', sortOrder: 4, linkedTaskTemplateId: 41, linkedTaskTemplate: deliverable });
    const mid = mkZone({ id: 8005, name: 'Mid', sortOrder: 0, children: [slot] });
    const root = mkZone({ id: 8004, name: 'Root', sortOrder: 0, children: [mid] });
    const outer = mkOuterTemplate({ id: 99, templateZones: [root] });

    const { service, tx } = makeService(outer);
    await service.applyProjectTemplate(7, 99, 42, 'P');

    // Main + Root + Mid — slot is inlined, no fourth zone.
    expect(tx.zone.create).toHaveBeenCalledTimes(3);
    expect(createdZoneNames(tx)).toEqual(['P', 'Root', 'Mid']);

    const midZoneId = await zoneIdAt(tx, 2);

    const datas = createdTaskData(tx);
    expect(datas).toHaveLength(2);
    // Tasks land under Mid (slot's direct parent), NOT under Root.
    for (const d of datas) {
      expect(d.zoneId).toBe(midZoneId);
      expect(d.deliverableTemplateId).toBe(41);
    }
    expect(datas.map((d) => d.sortOrder)).toEqual([400, 401]);
  });
});

// ─── §12 (2026-11-14) · zoneType on create / update ───────────────────
//
// The DTO now validates / normalises a PROVIDED zoneType
// (dto/create-zone.dto.spec.ts). These cover the service side: what is
// written when none is provided. The create fallback used to be the
// legacy code "zone", which the `ZoneType` enum no longer has, so a
// create without a type failed in Prisma just like an invalid one.
describe('ZonesService — zoneType written by create / update (§12)', () => {
  function makeCrudService() {
    const prisma: any = {
      zone: {
        findFirst: jest.fn(async () => null), // no parent lookup hit, no last sibling
        create: jest.fn(async ({ data }: CreateCall) => ({ id: 501, ...data })),
        update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      },
    };
    const service = new ZonesService(
      prisma,
      { materializeFromTasks: jest.fn() } as any,
      { logTaskCreated: jest.fn() } as any,
    );
    return { service, prisma };
  }

  it('create without a zoneType falls back to "building" (the column default), never the legacy "zone"', async () => {
    const { service, prisma } = makeCrudService();

    await service.create({ projectId: 59, name: 'Tower A' } as any);

    expect(prisma.zone.create.mock.calls[0][0].data.zoneType).toBe('building');
  });

  it('create writes the provided (already validated) zoneType as-is', async () => {
    const { service, prisma } = makeCrudService();

    await service.create({ projectId: 59, name: 'Level 1', zoneType: 'level' } as any);

    expect(prisma.zone.create.mock.calls[0][0].data.zoneType).toBe('level');
  });

  it('update leaves the type alone when zoneType is absent or null, and writes it when provided', async () => {
    const { service, prisma } = makeCrudService();
    prisma.zone.findFirst.mockResolvedValue({ id: 7, zoneType: 'site' }); // findOne

    await service.update(7, { name: 'Renamed' } as any);
    await service.update(7, { zoneType: null } as any);
    await service.update(7, { zoneType: 'wing' } as any);

    const written = prisma.zone.update.mock.calls.map((c: any) => c[0].data);
    expect(written).toEqual([{ name: 'Renamed' }, {}, { zoneType: 'wing' }]);
  });
});

// ─── Deliverable Template → zone / project root (2026-11-19) ──────────
//
// `applyTaskTemplateToTarget` is the one server-side materializer behind
// the planning modal's "From Template" pickers (zone Add menu, group-card
// Add menu, Add Deliverable at Project Root). Before it, the pickers
// created each task with POST /tasks and never wrote TaskDependency rows,
// so a template's predecessor graph was lost on the way into the project.
describe('ZonesService.applyTaskTemplateToTarget — Deliverable Template into a zone / project root', () => {
  type TT = {
    id: number;
    name: string;
    code?: string;
    sortOrder?: number;
    serviceTypeId?: number | null;
    phaseId?: number | null;
    deliverableTemplateId?: number | null;
    defaultPriority?: string;
    defaultBudgetHours?: number | null;
    defaultBudgetAmount?: number | null;
    catalogTask?: { name: string | null; defaultBudgetHours: number | null; defaultBudgetAmount: number | null } | null;
    predecessors?: Array<{ dependsOnTemplateTaskId: number; lag?: number; lagUnit?: 'WORKING_DAYS' | 'CALENDAR_DAYS'; reason?: string | null }>;
  };

  function mkTaskListTemplate(opts: { id: number; phaseId?: number | null; type?: string; tasks: TT[] }) {
    return {
      id: opts.id,
      name: `Deliverable ${opts.id}`,
      type: opts.type ?? 'task_list',
      phaseId: opts.phaseId ?? null,
      templateTasks: opts.tasks.map((t, i) => ({
        id: t.id,
        code: t.code ?? `T-${t.id}`,
        name: t.name,
        description: null,
        sortOrder: t.sortOrder ?? i,
        serviceTypeId: t.serviceTypeId ?? null,
        phaseId: t.phaseId ?? null,
        deliverableTemplateId: t.deliverableTemplateId ?? null,
        defaultPriority: t.defaultPriority ?? 'medium',
        defaultBudgetHours: t.defaultBudgetHours ?? null,
        defaultBudgetAmount: t.defaultBudgetAmount ?? null,
        catalogTask: t.catalogTask ?? null,
        predecessors: (t.predecessors ?? []).map((p) => ({
          dependsOnTemplateTaskId: p.dependsOnTemplateTaskId,
          lag: p.lag ?? 0,
          lagUnit: p.lagUnit ?? 'WORKING_DAYS',
          reason: p.reason ?? null,
        })),
      })),
    };
  }

  function makeApply(opts: {
    template: any;
    zone?: { projectId: number } | null;
    deliverable?: { id: number } | null;
    tailSortOrder?: number | null;
    catalogTasks?: Array<{ code: string; defaultBudgetHours: number | null; defaultBudgetAmount: number | null }>;
  }) {
    let nextId = 2000;
    const tx: any = {
      zone: { findFirst: jest.fn(async () => opts.zone ?? null) },
      projectDeliverable: { findFirst: jest.fn(async () => opts.deliverable ?? null) },
      template: {
        // Two reads share this mock: the catalog (`loadCatalogMap`, by
        // code) and the applied template (by id).
        findFirst: jest.fn(async ({ where }: any) =>
          where?.code === '__TASK_CATALOG__' ? { templateTasks: opts.catalogTasks ?? [] } : opts.template,
        ),
        update: jest.fn(async () => ({})),
      },
      task: {
        aggregate: jest.fn(async () => ({ _max: { sortOrder: opts.tailSortOrder ?? null } })),
        create: jest.fn(async ({ data }: CreateCall) => ({ id: ++nextId, ...data })),
      },
      zoneServiceType: { upsert: jest.fn(async () => ({})) },
      taskDependency: { createMany: jest.fn(async ({ data }: any) => ({ count: data.length })) },
    };
    const prisma: any = {
      zone: { findFirst: jest.fn(async () => opts.zone ?? null) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const projectDeliverables: any = { materializeFromTasks: jest.fn(async () => undefined) };
    const activityLog: any = { logTaskCreated: jest.fn(async () => undefined) };
    const service = new ZonesService(prisma, projectDeliverables, activityLog);
    return { service, tx, prisma, projectDeliverables, activityLog };
  }

  // A → B (lag 3 calendar days, reason) → C, plus an edge to a task that
  // is not part of this template and a self-edge — both must be skipped.
  const chainTemplate = () =>
    mkTaskListTemplate({
      id: 41,
      phaseId: 7,
      tasks: [
        { id: 501, name: 'A', serviceTypeId: 3 },
        { id: 502, name: 'B', predecessors: [{ dependsOnTemplateTaskId: 501, lag: 3, lagUnit: 'CALENDAR_DAYS', reason: 'customer approval' }] },
        {
          id: 503,
          name: 'C',
          predecessors: [
            { dependsOnTemplateTaskId: 502 },
            { dependsOnTemplateTaskId: 999 }, // outside the applied set
            { dependsOnTemplateTaskId: 503 }, // self-edge
          ],
        },
      ],
    });

  it('zone target — creates every task under the zone and maps each in-set edge to a TaskDependency with lag / lagUnit / reason', async () => {
    const { service, tx, projectDeliverables, activityLog } = makeApply({
      template: chainTemplate(),
      zone: { projectId: 59 },
      tailSortOrder: 3000,
    });

    const result = await service.applyTaskTemplateToTarget({ projectId: 59, zoneId: 12 }, 41, 42);

    expect(tx.zone.findFirst).toHaveBeenCalledWith({ where: { id: 12, deletedAt: null }, select: { projectId: true } });
    const datas = createdTaskData(tx);
    expect(datas.map((d) => d.name)).toEqual(['A', 'B', 'C']);
    for (const d of datas) {
      expect(d).toMatchObject({
        zoneId: 12,
        projectId: 59,
        deliverableTemplateId: 41,
        projectDeliverableId: null,
        phaseId: 7,
        status: 'not_started',
        requiresReview: true,
        createdBy: 42,
      });
    }
    // Appended after the zone's current last task (3000), template order kept.
    expect(datas.map((d) => d.sortOrder)).toEqual([4000, 5000, 6000]);
    expect(tx.task.aggregate).toHaveBeenCalledWith({
      where: { projectId: 59, zoneId: 12, deletedAt: null },
      _max: { sortOrder: true },
    });

    const [idA, idB, idC] = result.tasks.map((t: any) => t.id);
    expect(tx.taskDependency.createMany).toHaveBeenCalledTimes(1);
    expect(tx.taskDependency.createMany).toHaveBeenCalledWith({
      data: [
        { taskId: idB, dependsOnId: idA, lag: 3, lagUnit: 'CALENDAR_DAYS', reason: 'customer approval' },
        { taskId: idC, dependsOnId: idB, lag: 0, lagUnit: 'WORKING_DAYS', reason: null },
      ],
      skipDuplicates: true,
    });
    expect(result.dependenciesCreated).toBe(2);

    // Side effects kept from POST /tasks + applyTaskTemplate.
    expect(tx.zoneServiceType.upsert).toHaveBeenCalledTimes(1);
    expect(tx.zoneServiceType.upsert.mock.calls[0][0].create).toEqual({ zoneId: 12, serviceTypeId: 3 });
    expect(projectDeliverables.materializeFromTasks).toHaveBeenCalledWith(59, { tx });
    expect(tx.template.update).toHaveBeenCalledWith({ where: { id: 41 }, data: { usageCount: { increment: 1 } } });
    expect(activityLog.logTaskCreated).toHaveBeenCalledTimes(3);
    expect(activityLog.logTaskCreated.mock.calls.map((c: any) => c[0].entityId)).toEqual([idA, idB, idC]);
    expect(activityLog.logTaskCreated.mock.calls[0][0]).toMatchObject({ actorUserId: 42, projectId: 59, taskName: 'A' });
  });

  it('project-root target (zoneId null) — tasks land at the root with their dependency edges; no zone lookup, no ZoneServiceType row', async () => {
    const { service, tx } = makeApply({ template: chainTemplate(), tailSortOrder: null });

    const result = await service.applyTaskTemplateToTarget({ projectId: 59, zoneId: null }, 41, 42);

    expect(tx.zone.findFirst).not.toHaveBeenCalled();
    expect(tx.zoneServiceType.upsert).not.toHaveBeenCalled();
    const datas = createdTaskData(tx);
    expect(datas).toHaveLength(3);
    for (const d of datas) {
      expect(d.zoneId).toBeNull();
      expect(d.projectId).toBe(59);
      expect(d.deliverableTemplateId).toBe(41);
    }
    // Empty root container → 1000, 2000, … (same seed as computeInsertSortOrder).
    expect(datas.map((d) => d.sortOrder)).toEqual([1000, 2000, 3000]);
    expect(tx.task.aggregate.mock.calls[0][0].where).toEqual({ projectId: 59, zoneId: null, deletedAt: null });
    const [idA, idB, idC] = result.tasks.map((t: any) => t.id);
    expect(tx.taskDependency.createMany.mock.calls[0][0].data).toEqual([
      { taskId: idB, dependsOnId: idA, lag: 3, lagUnit: 'CALENDAR_DAYS', reason: 'customer approval' },
      { taskId: idC, dependsOnId: idB, lag: 0, lagUnit: 'WORKING_DAYS', reason: null },
    ]);
  });

  it('group context — projectDeliverableId / deliverableTemplateId / phaseId / serviceTypeId land on every task', async () => {
    const template = mkTaskListTemplate({
      id: 41,
      phaseId: 7,
      tasks: [
        { id: 501, name: 'Own service', serviceTypeId: 3, phaseId: 8, deliverableTemplateId: 41 },
        { id: 502, name: 'No own service', predecessors: [{ dependsOnTemplateTaskId: 501 }] },
      ],
    });
    const { service, tx } = makeApply({ template, zone: { projectId: 59 }, deliverable: { id: 300 } });

    await service.applyTaskTemplateToTarget({ projectId: 59, zoneId: 12 }, 41, 42, {
      projectDeliverableId: 300,
      deliverableTemplateId: 77,
      phaseId: 9,
      serviceTypeId: 5,
    });

    expect(tx.projectDeliverable.findFirst).toHaveBeenCalledWith({
      where: { id: 300, projectId: 59, deletedAt: null },
      select: { id: true },
    });
    const [own, none] = createdTaskData(tx);
    // Deliverable + Service: the group the PM added from wins.
    expect(own).toMatchObject({ projectDeliverableId: 300, deliverableTemplateId: 77, phaseId: 9 });
    expect(none).toMatchObject({ projectDeliverableId: 300, deliverableTemplateId: 77, phaseId: 9 });
    // Service type: the template task's own wins; the group fills the gap.
    expect(own.serviceTypeId).toBe(3);
    expect(none.serviceTypeId).toBe(5);
    expect(tx.zoneServiceType.upsert.mock.calls.map((c: any) => c[0].create.serviceTypeId)).toEqual([3, 5]);
    expect(tx.taskDependency.createMany).toHaveBeenCalledTimes(1);
  });

  it('no group context — applyTaskTemplate rules: tt FK > template id, template phase > task phase, catalog-live name/budget (DN-ext), template priority', async () => {
    const template = mkTaskListTemplate({
      id: 41,
      phaseId: 7,
      tasks: [
        {
          id: 501,
          name: 'Stale snapshot name',
          code: 'C-1',
          phaseId: 8,
          deliverableTemplateId: 88,
          defaultPriority: 'high',
          defaultBudgetHours: 1,
          defaultBudgetAmount: 10,
          catalogTask: { name: 'Live catalog name', defaultBudgetHours: 12, defaultBudgetAmount: 3400 },
        },
        { id: 502, name: 'Ad-hoc', code: 'C-2' },
      ],
    });
    const { service, tx } = makeApply({
      template,
      zone: { projectId: 59 },
      catalogTasks: [{ code: 'C-2', defaultBudgetHours: 6, defaultBudgetAmount: 900 }],
    });

    await service.applyTaskTemplateToTarget({ projectId: 59, zoneId: 12 }, 41, 42);

    const [linked, adHoc] = createdTaskData(tx);
    expect(linked).toMatchObject({
      name: 'Live catalog name',
      budgetHours: 12,
      budgetAmount: 3400,
      deliverableTemplateId: 88,
      phaseId: 7,
      priority: 'high',
      serviceTypeId: null,
    });
    // No catalog link, no own budget → catalog-by-code fallback.
    expect(adHoc).toMatchObject({ name: 'Ad-hoc', budgetHours: 6, budgetAmount: 900, deliverableTemplateId: 41, phaseId: 7 });
    expect(tx.projectDeliverable.findFirst).not.toHaveBeenCalled();
    expect(tx.taskDependency.createMany).not.toHaveBeenCalled();
  });

  it('template without a Service — falls back to the template task\'s own phase', async () => {
    const template = mkTaskListTemplate({ id: 41, phaseId: null, tasks: [{ id: 501, name: 'A', phaseId: 8 }] });
    const { service, tx } = makeApply({ template, zone: { projectId: 59 } });

    await service.applyTaskTemplateToTarget({ projectId: 59, zoneId: 12 }, 41, 42);

    expect(createdTaskData(tx)[0].phaseId).toBe(8);
  });

  it('refuses a zone from another project, a deliverable from another project, and an unknown template — nothing written', async () => {
    const zoneElsewhere = makeApply({ template: chainTemplate(), zone: { projectId: 60 } });
    await expect(
      zoneElsewhere.service.applyTaskTemplateToTarget({ projectId: 59, zoneId: 12 }, 41, 42),
    ).rejects.toBeInstanceOf(BadRequestException);

    const deliverableElsewhere = makeApply({ template: chainTemplate(), zone: { projectId: 59 }, deliverable: null });
    await expect(
      deliverableElsewhere.service.applyTaskTemplateToTarget({ projectId: 59, zoneId: 12 }, 41, 42, { projectDeliverableId: 300 }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const noTemplate = makeApply({ template: null, zone: { projectId: 59 } });
    await expect(
      noTemplate.service.applyTaskTemplateToTarget({ projectId: 59, zoneId: null }, 41, 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    for (const run of [zoneElsewhere, deliverableElsewhere, noTemplate]) {
      expect(run.tx.task.create).not.toHaveBeenCalled();
      expect(run.tx.taskDependency.createMany).not.toHaveBeenCalled();
      expect(run.activityLog.logTaskCreated).not.toHaveBeenCalled();
    }
  });

  it('POST /zones/:id/apply-task-template wrapper — resolves the zone\'s project, runs the same materializer, returns the task rows', async () => {
    const { service, tx, prisma } = makeApply({ template: chainTemplate(), zone: { projectId: 59 } });

    const tasks = await service.applyTaskTemplate(12, 41, 42);

    expect(prisma.zone.findFirst).toHaveBeenCalledWith({ where: { id: 12, deletedAt: null }, select: { projectId: true } });
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t: any) => t.zoneId === 12 && t.projectId === 59)).toBe(true);
    expect(tx.taskDependency.createMany.mock.calls[0][0].data).toHaveLength(2);

    const missing = makeApply({ template: chainTemplate(), zone: null });
    await expect(missing.service.applyTaskTemplate(12, 41, 42)).rejects.toBeInstanceOf(NotFoundException);
    expect(missing.tx.task.create).not.toHaveBeenCalled();
  });
});

// ─── Add Zone from Template — any depth (2026-11-19) ──────────────────
//
// The nested include behind `applyProjectTemplate` used to stop at 3
// levels (2 for a referenced template). At the 3rd level `children` was
// never loaded, so a zone there that had children read as a pure slot,
// got inlined, and everything below it was silently dropped.
describe('ZonesService.applyProjectTemplate — template zone trees of any depth', () => {
  it('4-level tree with a pure slot at depth 4 — every zone is created, the slot inlines under its depth-3 parent with its dependencies', async () => {
    const wingDeliverable = mkDeliverableTemplate({ id: 42, tasks: [{ id: 601, name: 'W1', sortOrder: 0 }] });
    const slotDeliverable = mkDeliverableTemplate({
      id: 41,
      tasks: [
        { id: 501, name: 'A', sortOrder: 0 },
        { id: 502, name: 'B', sortOrder: 1, predecessors: [{ dependsOnTemplateTaskId: 501, lag: 2, lagUnit: 'CALENDAR_DAYS', reason: 'cure' }] },
      ],
    });
    const slot = mkSlotZone({ id: 9004, name: 'Deliverable Slot', sortOrder: 1, linkedTaskTemplateId: 41, linkedTaskTemplate: slotDeliverable });
    // Depth 3: linked to a deliverable, no own tasks, BUT it has a child —
    // not a pure slot. The old loader never fetched its children.
    const wing = mkZone({ id: 8003, name: 'Wing', linkedTaskTemplateId: 42, linkedTaskTemplate: wingDeliverable, children: [slot] });
    const level = mkZone({ id: 8002, name: 'Level', children: [wing] });
    const building = mkZone({ id: 8001, name: 'Building', children: [level] });
    const outer = mkOuterTemplate({ id: 99, templateZones: [building] });

    const { service, tx } = makeService(outer);
    await service.applyProjectTemplate(7, 99, 42, 'P');

    expect(createdZoneNames(tx)).toEqual(['P', 'Building', 'Level', 'Wing']);
    const wingZoneId = await zoneIdAt(tx, 3);
    // Parent chain: each zone hangs off the previous one.
    const zoneDatas = (tx.zone.create.mock.calls as any[]).map((c) => c[0].data);
    expect(zoneDatas.map((d) => d.depth)).toEqual([0, 1, 2, 3]);
    expect(zoneDatas[3].parentId).toBe(await zoneIdAt(tx, 2));

    const datas = createdTaskData(tx);
    expect(datas.map((d) => d.name)).toEqual(['W1', 'A', 'B']);
    for (const d of datas) expect(d.zoneId).toBe(wingZoneId);
    expect(datas.find((d) => d.name === 'A').deliverableTemplateId).toBe(41);

    // The depth-4 slot's edge B → A is materialized with its lag.
    // Task ids: W1 → 1001, A → 1002, B → 1003.
    expect(tx.taskDependency.createMany).toHaveBeenCalledTimes(1);
    const { data, skipDuplicates } = (tx.taskDependency.createMany.mock.calls as any[])[0][0];
    expect(skipDuplicates).toBe(true);
    expect(data).toEqual([{ taskId: 1003, dependsOnId: 1002, lag: 2, lagUnit: 'CALENDAR_DAYS', reason: 'cure' }]);
  });

  it('siblings are created in sortOrder, then id order, at every depth', async () => {
    const deep = mkZone({
      id: 8010,
      name: 'Root',
      children: [
        mkZone({ id: 8013, name: 'Second', sortOrder: 2 }),
        mkZone({ id: 8012, name: 'First', sortOrder: 1, children: [mkZone({ id: 8020, name: 'Grandchild' })] }),
      ],
    });
    const { service, tx } = makeService(mkOuterTemplate({ id: 99, templateZones: [deep] }));

    await service.applyProjectTemplate(7, 99, 42, 'P');

    expect(createdZoneNames(tx)).toEqual(['P', 'Root', 'First', 'Grandchild', 'Second']);
  });

  it('a referenced template contributes its whole zone tree (3 levels; the old include loaded 2)', async () => {
    const referenced = mkOuterTemplate({
      id: 77,
      name: 'Referenced',
      templateZones: [
        mkZone({ id: 7701, name: 'R1', children: [mkZone({ id: 7702, name: 'R2', children: [mkZone({ id: 7703, name: 'R3' })] })] }),
      ],
    });
    const host = { ...mkZone({ id: 8100, name: 'Host' }), referencedTemplateId: 77 };
    const { service, tx } = makeService(mkOuterTemplate({ id: 99, templateZones: [host] }), [referenced]);

    await service.applyProjectTemplate(7, 99, 42, 'P');

    expect(createdZoneNames(tx)).toEqual(['P', 'Host', 'R1', 'R2', 'R3']);
    expect(tx.templateZone.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { templateId: 77 } }));
  });

  it('a template that references itself does not recurse forever', async () => {
    const selfRef = { ...mkZone({ id: 8200, name: 'Loop' }), referencedTemplateId: 99 };
    const outer = mkOuterTemplate({ id: 99, templateZones: [selfRef] });
    const { service, tx } = makeService(outer, [outer]);

    await service.applyProjectTemplate(7, 99, 42, 'P');

    expect(createdZoneNames(tx)).toEqual(['P', 'Loop']);
    expect(tx.template.findUnique).not.toHaveBeenCalled();
  });
});

// ─── Duplicate zone (2026-11-19) ──────────────────────────────────────
//
// `duplicateZone` used to drop every TaskDependency, reset task order,
// and stop copying below 3 zone levels.
describe('ZonesService.duplicateZone — dependencies, order and depth', () => {
  function makeDuplicate() {
    // Project tree: 1 (root) → 10 (source) → 11 → 12 → 13 → 14, and an
    // unrelated sibling 20 under the root.
    const z = (id: number, parentId: number | null, name: string, depth: number, sortOrder = 0) => ({
      id, projectId: 59, parentId, name, code: null, zoneType: 'building', sortOrder,
      path: parentId == null ? `${id}` : `1/${id}`, depth, deletedAt: null,
    });
    const projectZones = [
      z(1, null, 'Root', 0),
      z(10, 1, 'Source', 1, 4),
      z(11, 10, 'L2', 2),
      z(12, 11, 'L3', 3),
      z(13, 12, 'L4', 4),
      z(14, 13, 'L5', 5),
      z(20, 1, 'Other', 1),
    ];
    const task = (id: number, zoneId: number, sortOrder: number) => ({
      id, zoneId, projectId: 59, sortOrder, code: `T-${id}`, name: `Task ${id}`, serviceTypeId: null,
      deliverableTemplateId: 41, description: null, budgetHours: 8, budgetAmount: null, phaseId: 3,
      priority: 'high', status: 'in_progress', completionPct: 60,
      estimatedStartDate: new Date('2026-12-01'), startDate: new Date('2026-12-02'), endDate: new Date('2026-12-10'),
    });
    const tasks = [task(101, 10, 1000), task(100, 10, 3000), task(103, 13, 500), task(102, 14, 2000), task(200, 20, 1000)];
    const edges = [
      { taskId: 100, dependsOnId: 101, lag: 2, lagUnit: 'CALENDAR_DAYS', reason: 'approval' },
      { taskId: 102, dependsOnId: 103, lag: 0, lagUnit: 'WORKING_DAYS', reason: null },
      { taskId: 100, dependsOnId: 200, lag: 1, lagUnit: 'WORKING_DAYS', reason: null }, // other end not copied
    ];
    let nextZone = 500;
    let nextTask = 5000;
    const tx: any = {
      zone: {
        findMany: jest.fn(async () => projectZones),
        create: jest.fn(async ({ data }: CreateCall) => ({ id: ++nextZone, ...data })),
        update: jest.fn(async () => ({})),
      },
      task: {
        findMany: jest.fn(async ({ where }: any) =>
          tasks
            .filter((t) => where.zoneId.in.includes(t.zoneId))
            .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
        ),
        create: jest.fn(async ({ data }: CreateCall) => ({ id: ++nextTask, ...data })),
      },
      zoneServiceType: {
        findMany: jest.fn(async () => [{ zoneId: 12, serviceTypeId: 5, sortOrder: 2 }]),
        create: jest.fn(async () => ({})),
      },
      taskDependency: {
        findMany: jest.fn(async ({ where }: any) =>
          edges.filter((e) => where.taskId.in.includes(e.taskId) && where.dependsOnId.in.includes(e.dependsOnId)),
        ),
        createMany: jest.fn(async ({ data }: any) => ({ count: data.length })),
      },
    };
    const prisma: any = {
      zone: {
        findFirst: jest.fn(async ({ where }: any) => (where.id === 10 ? projectZones[1] : null)),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const projectDeliverables: any = { materializeFromTasks: jest.fn(async () => undefined) };
    const service = new ZonesService(prisma, projectDeliverables, { logTaskCreated: jest.fn() } as any);
    return { service, tx, prisma, projectDeliverables };
  }

  it('copies the whole subtree (5 levels), task order, and the edges between copied tasks; not dates or status', async () => {
    const { service, tx, projectDeliverables } = makeDuplicate();

    const result = await service.duplicateZone(10, 'Source (copy)', 42);

    // Every level of the subtree, nothing from the sibling zone 20.
    const zoneDatas = (tx.zone.create.mock.calls as any[]).map((c) => c[0].data);
    expect(zoneDatas.map((d) => d.name)).toEqual(['Source (copy)', 'L2', 'L3', 'L4', 'L5']);
    expect(zoneDatas.map((d) => d.depth)).toEqual([1, 2, 3, 4, 5]);
    expect(zoneDatas[0].parentId).toBe(1);
    expect(zoneDatas.slice(1).map((d) => d.parentId)).toEqual([501, 502, 503, 504]);
    // The copy sits next to the original, so it keeps the parent's path.
    expect(result.path).toBe('1/501');
    expect(tx.zone.update.mock.calls[1][0].data.path).toBe('1/501/502');

    // Tasks: order carried, plan copied, progress / dates / status not.
    const taskDatas = (tx.task.create.mock.calls as any[]).map((c) => c[0].data);
    expect(taskDatas.map((d) => [d.code, d.sortOrder])).toEqual([
      ['T-101', 1000],
      ['T-100', 3000],
      ['T-103', 500],
      ['T-102', 2000],
    ]);
    for (const d of taskDatas) {
      expect(d).toMatchObject({ status: 'not_started', completionPct: 0, createdBy: 42, deliverableTemplateId: 41, budgetHours: 8, priority: 'high' });
      expect(d.estimatedStartDate).toBeUndefined();
      expect(d.startDate).toBeUndefined();
      expect(d.endDate).toBeUndefined();
    }
    expect(tx.zoneServiceType.create).toHaveBeenCalledWith({ data: { zoneId: 503, serviceTypeId: 5, sortOrder: 2 } });

    // Edges: only the two whose both ends were copied, remapped, lag kept.
    // Copy ids: 101 → 5001, 100 → 5002, 103 → 5003, 102 → 5004.
    expect(tx.taskDependency.createMany).toHaveBeenCalledWith({
      data: [
        { taskId: 5002, dependsOnId: 5001, lag: 2, lagUnit: 'CALENDAR_DAYS', reason: 'approval' },
        { taskId: 5004, dependsOnId: 5003, lag: 0, lagUnit: 'WORKING_DAYS', reason: null },
      ],
      skipDuplicates: true,
    });
    expect(projectDeliverables.materializeFromTasks).toHaveBeenCalledWith(59, { tx });
  });

  it('refuses a name already used in the project and an unknown zone', async () => {
    const { service, tx, prisma } = makeDuplicate();
    prisma.zone.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === 10 ? { id: 10, projectId: 59, parentId: 1, path: '1/10', depth: 1 } : { id: 77 },
    );
    await expect(service.duplicateZone(10, 'Taken', 42)).rejects.toThrow('Zone name must be unique within project');

    prisma.zone.findFirst.mockResolvedValue(null);
    await expect(service.duplicateZone(10, 'Fresh', 42)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.zone.create).not.toHaveBeenCalled();
  });
});
