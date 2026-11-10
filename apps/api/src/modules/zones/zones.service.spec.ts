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

function makeService(template: any) {
  const tx = makeTx();
  const prisma: any = {
    template: {
      findUniqueOrThrow: jest.fn(async () => template),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const projectDeliverables: any = {
    materializeFromTasks: jest.fn(async () => undefined),
  };
  const service = new ZonesService(prisma, projectDeliverables);
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
