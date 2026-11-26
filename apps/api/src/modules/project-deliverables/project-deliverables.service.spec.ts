/**
 * DP · empty-ZDT prevention (2026-11-03) — unit tests for the
 * `setTarget` / `batchSetTargets` short-circuit that stops ghost
 * ZoneDeliverableTarget rows from being written.
 *
 * Context: before this fix, saving the Deliverable Planning grid
 * upserted a ZDT for every (zone × deliverable) cell including the
 * "no target" ones, producing all-null rows that the FE scoping then
 * counted as a connection and emitted the deliverable under every
 * zone (project 40 regression).
 *
 * These tests exercise the write-path with a jest-mocked Prisma — no
 * DB needed. They assert the three cases the work order calls out:
 *   (a) empty save + no existing row → no row created
 *   (b) empty save + existing row    → row deleted
 *   (c) real target                  → row persisted correctly
 * Plus a 4th guard that a persisted duration preserves the row (the
 * tri-state `durationWeeks: undefined = keep` contract).
 */
import { ProjectDeliverablesService } from './project-deliverables.service';
import { resolveUngovernedZoneIds } from '../scheduling/target-scope.util';

type MockPrisma = {
  zoneDeliverableTarget: {
    upsert: jest.Mock;
    deleteMany: jest.Mock;
    findUnique: jest.Mock;
  };
  projectDeliverable: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
};

function makeService(): { service: ProjectDeliverablesService; prisma: MockPrisma } {
  const prisma: MockPrisma = {
    zoneDeliverableTarget: {
      upsert: jest.fn().mockResolvedValue(undefined),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    projectDeliverable: {
      findUnique: jest.fn().mockResolvedValue({ id: 1 }),
      update: jest.fn().mockResolvedValue({ id: 1 }),
    },
  };
  const activityLog = { write: jest.fn() } as any;
  const service = new ProjectDeliverablesService(prisma as any, activityLog);
  return { service, prisma };
}

describe('ProjectDeliverablesService.setTarget — empty-ZDT prevention', () => {
  it('(a) empty save + no existing row → does NOT create a ZDT', async () => {
    const { service, prisma } = makeService();
    prisma.zoneDeliverableTarget.findUnique.mockResolvedValueOnce(null);

    await service.setTarget(
      /* id */ 10,
      /* months */ null,
      /* baseDate */ undefined,
      /* zoneId */ 7,
      /* durationWeeks */ undefined,
    );

    expect(prisma.zoneDeliverableTarget.upsert).not.toHaveBeenCalled();
    // deleteMany with the composite WHERE is safe — matches zero rows
    // when none exist and the ghost row is never created.
    expect(prisma.zoneDeliverableTarget.deleteMany).toHaveBeenCalledWith({
      where: { zoneId: 7, projectDeliverableId: 10 },
    });
  });

  it('(b) empty save + existing row → DELETES the row', async () => {
    const { service, prisma } = makeService();
    // Existing row carries no duration either → full clear.
    prisma.zoneDeliverableTarget.findUnique.mockResolvedValueOnce({ estimatedDurationWeeks: null });

    await service.setTarget(
      /* id */ 11,
      /* months */ null,
      /* baseDate */ undefined,
      /* zoneId */ 8,
      /* durationWeeks */ null, // explicit clear
    );

    expect(prisma.zoneDeliverableTarget.upsert).not.toHaveBeenCalled();
    expect(prisma.zoneDeliverableTarget.deleteMany).toHaveBeenCalledWith({
      where: { zoneId: 8, projectDeliverableId: 11 },
    });
  });

  it('(c) real target → persists via upsert, no delete', async () => {
    const { service, prisma } = makeService();

    await service.setTarget(
      /* id */ 12,
      /* months */ 2,
      /* baseDate */ '2026-01-01',
      /* zoneId */ 9,
      /* durationWeeks */ 3,
    );

    expect(prisma.zoneDeliverableTarget.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.zoneDeliverableTarget.deleteMany).not.toHaveBeenCalled();

    const args = prisma.zoneDeliverableTarget.upsert.mock.calls[0][0];
    expect(args.create.targetMonths).toBe(2);
    expect(args.create.estimatedDurationWeeks).toBe(3);
    expect(args.create.targetDate).toBeInstanceOf(Date);
    // computeTarget snaps Jan 1 2026 (Thursday) + 2mo = Mar 1 2026
    // (Sunday); 1-Mar is a Sunday so stays. YYYY-MM-DD prefix check.
    expect((args.create.targetDate as Date).toISOString().slice(0, 10)).toBe('2026-03-01');
  });

  it('(d) months cleared but persisted duration survives → upsert, NOT delete', async () => {
    const { service, prisma } = makeService();
    // Existing row carries a duration — tri-state `undefined = keep`
    // means the resulting row is still non-empty, so the fix must
    // preserve it via upsert (clearing only targetDate+targetMonths).
    prisma.zoneDeliverableTarget.findUnique.mockResolvedValueOnce({ estimatedDurationWeeks: 4 });

    await service.setTarget(
      /* id */ 13,
      /* months */ null,
      /* baseDate */ undefined,
      /* zoneId */ 10,
      /* durationWeeks */ undefined, // keep existing
    );

    expect(prisma.zoneDeliverableTarget.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.zoneDeliverableTarget.deleteMany).not.toHaveBeenCalled();

    const args = prisma.zoneDeliverableTarget.upsert.mock.calls[0][0];
    expect(args.update.targetDate).toBeNull();
    expect(args.update.targetMonths).toBeNull();
    // durPatch is {} when durationWeeks is undefined — the key is
    // absent from the write, so Prisma leaves the column untouched.
    expect('estimatedDurationWeeks' in args.update).toBe(false);
    expect('estimatedDurationWeeks' in args.create).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// §12 (2026-11-14) · A (deliverable × zone) target owns the tasks of the
// zone AND its sub-zones — same rule as the scheduler
// (`scheduling/target-scope.util.ts`): closest ancestor-or-self dated
// target wins.
//
//   693 Building A ── 695 Level 1 ── 696 Wing
//                  └─ 697 Level 2
//   700 Building B
//
// Where-aware, stateful Prisma mock: the ZDT "table" is mutated by
// upsert / deleteMany so the scope is resolved against what the batch
// itself just wrote, as in production.
// ════════════════════════════════════════════════════════════════════
type ZoneRow = { id: number; parentId: number | null; path: string; name: string };
type ZdtRow = { zoneId: number; projectDeliverableId: number; targetDate: Date | null };
type TaskRow = {
  id: number;
  name: string;
  zoneId: number | null;
  projectDeliverableId: number;
  budgetHours: number | null;
  endDate: Date | null;
  dueDateOverridden: boolean;
};

const PD_ID = 230;
const PROJECT_ID = 59;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const isoDay = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

const ZONES: ZoneRow[] = [
  { id: 693, parentId: null, path: '693', name: 'Building A' },
  { id: 695, parentId: 693, path: '693/695', name: 'Level 1' },
  { id: 696, parentId: 695, path: '693/695/696', name: 'Wing' },
  { id: 697, parentId: 693, path: '693/697', name: 'Level 2' },
  { id: 700, parentId: null, path: '700', name: 'Building B' },
];

function task(id: number, zoneId: number | null, extra: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    name: `Task ${id}`,
    zoneId,
    projectDeliverableId: PD_ID,
    budgetHours: 8,
    endDate: null,
    dueDateOverridden: false,
    ...extra,
  };
}

function makeScopedService(fx: { zdts?: ZdtRow[]; tasks: TaskRow[]; pdTargetDate?: Date | null }) {
  const zdts: ZdtRow[] = [...(fx.zdts ?? [])];
  const updates = new Map<number, any>();
  const zoneMatches = (taskZoneId: number | null, cond: any): boolean => {
    if (cond === undefined) return true;
    if (cond === null) return taskZoneId === null;
    if (typeof cond === 'object') return taskZoneId !== null && cond.in.includes(taskZoneId);
    return taskZoneId === cond;
  };
  const findZdt = (zoneId: number, projectDeliverableId: number) =>
    zdts.find((z) => z.zoneId === zoneId && z.projectDeliverableId === projectDeliverableId);

  const prisma: any = {
    projectDeliverable: {
      findUnique: jest.fn().mockResolvedValue({
        id: PD_ID,
        projectId: PROJECT_ID,
        name: 'BIM model',
        targetDate: fx.pdTargetDate ?? null,
        targetMonths: null,
        estimatedDurationWeeks: null,
      }),
      update: jest.fn().mockResolvedValue({ id: PD_ID }),
    },
    zone: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => ZONES.find((z) => z.id === where.id) ?? null),
      // §12 zone tree (all live zones of the project). §16: no path-prefix
      // descendant lookup any more — the specs below assert none is made.
      findMany: jest.fn().mockImplementation(async ({ where }: any) =>
        where?.projectId === PROJECT_ID ? ZONES.map((z) => ({ id: z.id, parentId: z.parentId })) : [],
      ),
    },
    zoneDeliverableTarget: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        const key = where.zoneId_projectDeliverableId;
        const hit = findZdt(key.zoneId, key.projectDeliverableId);
        return hit ? { ...hit, targetMonths: null, estimatedDurationWeeks: null } : null;
      }),
      findMany: jest.fn().mockImplementation(async ({ where }: any) =>
        zdts.filter(
          (z) =>
            z.projectDeliverableId === where.projectDeliverableId &&
            (!(where.targetDate && 'not' in where.targetDate) || z.targetDate != null),
        ),
      ),
      upsert: jest.fn().mockImplementation(async ({ where, create, update }: any) => {
        const key = where.zoneId_projectDeliverableId;
        const hit = findZdt(key.zoneId, key.projectDeliverableId);
        if (hit) hit.targetDate = update.targetDate;
        else zdts.push({ zoneId: create.zoneId, projectDeliverableId: create.projectDeliverableId, targetDate: create.targetDate });
      }),
      deleteMany: jest.fn().mockImplementation(async ({ where }: any) => {
        for (let i = zdts.length - 1; i >= 0; i--) {
          if (zdts[i].projectDeliverableId === where.projectDeliverableId && zoneMatches(zdts[i].zoneId, where.zoneId)) {
            zdts.splice(i, 1);
          }
        }
        return { count: 0 };
      }),
    },
    task: {
      // PR-077 follow-up · a Root item asks for `OR: [{ zoneId: null }, { zoneId: { in } }]`.
      findMany: jest.fn().mockImplementation(async ({ where }: any) =>
        fx.tasks.filter(
          (t) =>
            t.projectDeliverableId === where.projectDeliverableId &&
            (Array.isArray(where.OR)
              ? where.OR.some((c: any) => zoneMatches(t.zoneId, c.zoneId))
              : zoneMatches(t.zoneId, where.zoneId)),
        ),
      ),
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => fx.tasks.find((t) => t.id === where.id) ?? null),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        updates.set(where.id, data);
        return { id: where.id, ...data };
      }),
    },
  };
  const service = new ProjectDeliverablesService(prisma as any, { write: jest.fn() } as any);
  return { service, prisma, updates, zdts };
}

describe('ProjectDeliverablesService.batchSetTargets — §12 · propagation covers sub-zones', () => {
  const TASKS = () => [
    task(1, 693),
    task(21, 695),
    task(22, 696),
    task(23, 697),
    task(24, 695, { dueDateOverridden: true, endDate: day('2026-12-20') }),
    task(99, 700),
  ];

  it('propagates to the zone and its sub-zones, except a sub-tree that keeps its own dated target', async () => {
    const { service, prisma, updates } = makeScopedService({
      // Level 2 has its own target for this deliverable → stays with it.
      zdts: [{ zoneId: 697, projectDeliverableId: PD_ID, targetDate: day('2026-12-06') }],
      tasks: TASKS(),
    });

    // Months path: 2026-10-01 + 1 month = Sun 2026-11-01 (no snap).
    const res = await service.batchSetTargets([{ id: PD_ID, zoneId: 693, months: 1 }], '2026-10-01', true, 7);

    expect(prisma.task.findMany.mock.calls[0][0].where).toMatchObject({
      projectDeliverableId: PD_ID,
      zoneId: { in: [693, 695, 696] },
    });
    // 1 (zone itself), 21 + 22 (sub-zones) get the date; start = due − 1 week (8h).
    expect([...updates.keys()].sort((a, b) => a - b)).toEqual([1, 21, 22]);
    for (const id of [1, 21, 22]) {
      expect(isoDay(updates.get(id).endDate)).toBe('2026-11-01');
      expect(isoDay(updates.get(id).estimatedStartDate)).toBe('2026-10-25');
    }
    // 24 is a manual date inside the scope → reported, never written.
    expect(res.overriddenTasks).toEqual([
      { taskId: 24, taskName: 'Task 24', currentDue: '2026-12-20', targetDate: '2026-11-01' },
    ]);
  });

  // §16 (2026-11-18) · The "Option X" descendant clean-up is gone: each
  // zone row owns its own target, closest ancestor-or-self wins.
  const noPathLookup = (prisma: { zone: { findMany: jest.Mock } }) =>
    prisma.zone.findMany.mock.calls.every(([args]) => args?.where?.path === undefined);

  it('§16 · an explicit (drag) date on a parent zone leaves the child zone target in place; that sub-tree is out of scope', async () => {
    const { service, prisma, updates, zdts } = makeScopedService({
      zdts: [{ zoneId: 697, projectDeliverableId: PD_ID, targetDate: day('2026-12-06') }],
      tasks: TASKS(),
    });

    await service.batchSetTargets(
      [{ id: PD_ID, zoneId: 693, months: null, targetDate: '2026-11-15' }], // a Sunday
      undefined,
      true,
      7,
    );

    // Level 2 keeps its own target, untouched; Building A gets the new one.
    expect(zdts.map((z) => [z.zoneId, isoDay(z.targetDate)]).sort()).toEqual([
      [693, '2026-11-15'],
      [697, '2026-12-06'],
    ]);
    expect(prisma.zoneDeliverableTarget.deleteMany).not.toHaveBeenCalled();
    expect(noPathLookup(prisma)).toBe(true);
    // Propagation scope excludes the Level 2 sub-tree (task 23 stays put).
    expect(prisma.task.findMany.mock.calls[0][0].where).toMatchObject({
      projectDeliverableId: PD_ID,
      zoneId: { in: [693, 695, 696] },
    });
    expect([...updates.keys()].sort((a, b) => a - b)).toEqual([1, 21, 22]);
    for (const id of [1, 21, 22]) expect(isoDay(updates.get(id).endDate)).toBe('2026-11-15');
  });

  const PARENT = { id: PD_ID, zoneId: 693, months: null, targetDate: '2026-11-15' };
  const CHILD = { id: PD_ID, zoneId: 697, months: null, targetDate: '2026-12-13' };

  it.each([
    ['parent first', [PARENT, CHILD]],
    ['child first', [CHILD, PARENT]],
  ])('§16 · parent + child in one batch (%s): both targets survive, same end state', async (_label, items) => {
    const { service, prisma, updates, zdts } = makeScopedService({
      // Stale dates on both rows — the batch must overwrite each with its own.
      zdts: [
        { zoneId: 693, projectDeliverableId: PD_ID, targetDate: day('2026-10-04') },
        { zoneId: 697, projectDeliverableId: PD_ID, targetDate: day('2026-10-04') },
      ],
      tasks: TASKS(),
    });

    await service.batchSetTargets(items, undefined, true, 7);

    expect(zdts.map((z) => [z.zoneId, isoDay(z.targetDate)]).sort()).toEqual([
      [693, '2026-11-15'],
      [697, '2026-12-13'],
    ]);
    expect(prisma.zoneDeliverableTarget.deleteMany).not.toHaveBeenCalled();
    expect(noPathLookup(prisma)).toBe(true);
    // Each task follows its closest dated target; 99 (Building B) untouched.
    expect([...updates.keys()].sort((a, b) => a - b)).toEqual([1, 21, 22, 23]);
    for (const id of [1, 21, 22]) expect(isoDay(updates.get(id).endDate)).toBe('2026-11-15');
    expect(isoDay(updates.get(23).endDate)).toBe('2026-12-13');
  });

  // PR-077 follow-up (2026-11-26, owner's decision 3) · A deliverable-level
  // (Root) item used to overwrite EVERY task of the deliverable, zone
  // targets included. It now writes the zone-less tasks and the tasks of
  // zones with no dated target of their own for the deliverable: the
  // scheduler's fallback set (`resolveUngovernedZoneIds`).
  describe('a deliverable-level (Root) item', () => {
    const ROOT_TASKS = () => [
      ...TASKS(),
      task(50, null),
      task(51, null, { dueDateOverridden: true, endDate: day('2026-12-27') }),
    ];

    it('without any zone target: every zone is uncovered, so every task of the deliverable (manual dates kept)', async () => {
      const { service, prisma, updates } = makeScopedService({ tasks: ROOT_TASKS() });

      const res = await service.batchSetTargets([{ id: PD_ID, months: 1 }], '2026-10-01', true, 7);

      expect(prisma.task.findMany.mock.calls[0][0].where).toMatchObject({
        projectDeliverableId: PD_ID,
        OR: [{ zoneId: null }, { zoneId: { in: [693, 695, 696, 697, 700] } }],
      });
      expect([...updates.keys()].sort((a, b) => a - b)).toEqual([1, 21, 22, 23, 50, 99]);
      for (const id of updates.keys()) expect(isoDay(updates.get(id).endDate)).toBe('2026-11-01');
      expect(res.overriddenTasks.map((o) => o.taskId).sort((a, b) => a - b)).toEqual([24, 51]);
    });

    it('a zone covered by its own dated target keeps its tasks\' dates; zone-less and uncovered-zone tasks get the Root date', async () => {
      const { service, prisma, updates } = makeScopedService({
        // Building A (and so its whole sub-tree) has its own target; a
        // date-less row on Building B is not a target.
        zdts: [
          { zoneId: 693, projectDeliverableId: PD_ID, targetDate: day('2026-12-06') },
          { zoneId: 700, projectDeliverableId: PD_ID, targetDate: null },
        ],
        tasks: ROOT_TASKS(),
      });

      const res = await service.batchSetTargets([{ id: PD_ID, months: 1 }], '2026-10-01', true, 7);

      // The very set the scheduler's Root-level run takes.
      expect(resolveUngovernedZoneIds(ZONES, [693])).toEqual([700]);
      expect(prisma.task.findMany.mock.calls[0][0].where).toMatchObject({
        projectDeliverableId: PD_ID,
        OR: [{ zoneId: null }, { zoneId: { in: [700] } }],
      });
      expect([...updates.keys()].sort((a, b) => a - b)).toEqual([50, 99]);
      for (const id of [50, 99]) expect(isoDay(updates.get(id).endDate)).toBe('2026-11-01');
      // 24 is inside Building A: not in scope, not even reported.
      expect(res.overriddenTasks.map((o) => o.taskId)).toEqual([51]);
    });

    it('every zone covered: only the zone-less tasks', async () => {
      const { service, prisma, updates } = makeScopedService({
        zdts: [
          { zoneId: 693, projectDeliverableId: PD_ID, targetDate: day('2026-12-06') },
          { zoneId: 700, projectDeliverableId: PD_ID, targetDate: day('2026-12-13') },
        ],
        tasks: ROOT_TASKS(),
      });

      await service.batchSetTargets([{ id: PD_ID, months: 1 }], '2026-10-01', true, 7);

      expect(prisma.task.findMany.mock.calls[0][0].where).toEqual({
        projectDeliverableId: PD_ID,
        zoneId: null,
        deletedAt: null,
        isArchived: false,
      });
      expect([...updates.keys()]).toEqual([50]);
    });

    const ROOT = { id: PD_ID, months: null, targetDate: '2026-11-01' };
    const ZONE_A = { id: PD_ID, zoneId: 693, months: null, targetDate: '2026-12-06' };

    it.each([
      ['Root first', [ROOT, ZONE_A]],
      ['zone first', [ZONE_A, ROOT]],
    ])('Root + a new zone target in one batch (%s): same end state', async (_label, items) => {
      const { service, updates } = makeScopedService({ tasks: ROOT_TASKS() });

      await service.batchSetTargets(items, undefined, true, 7);

      const ends = Object.fromEntries([...updates.entries()].map(([id, d]) => [id, isoDay(d.endDate)]));
      expect(ends).toEqual({
        1: '2026-12-06', 21: '2026-12-06', 22: '2026-12-06', 23: '2026-12-06', // Building A's own target
        50: '2026-11-01', 99: '2026-11-01', // zone-less + Building B: the Root target
      });
    });

    it('a zone target cleared in the same batch hands its tasks back to the Root date, whatever the order', async () => {
      for (const order of ['root-first', 'zone-first']) {
        const clearA = { id: PD_ID, zoneId: 693, months: null, targetDate: null };
        const items = order === 'root-first' ? [ROOT, clearA] : [clearA, ROOT];
        const { service, updates, zdts } = makeScopedService({
          zdts: [{ zoneId: 693, projectDeliverableId: PD_ID, targetDate: day('2026-12-06') }],
          tasks: ROOT_TASKS(),
        });

        await service.batchSetTargets(items as any, undefined, true, 7);

        expect(zdts).toEqual([]);
        for (const id of [1, 21, 22, 23, 50, 99]) expect(isoDay(updates.get(id).endDate)).toBe('2026-11-01');
      }
    });
  });

  it('applyToTasks=false (what the DP tab sends) touches no task and resolves no scope', async () => {
    const { service, prisma } = makeScopedService({ tasks: TASKS() });

    await service.batchSetTargets([{ id: PD_ID, zoneId: 693, months: 1 }], '2026-10-01', false, 7);

    expect(prisma.task.findMany).not.toHaveBeenCalled();
    expect(prisma.task.update).not.toHaveBeenCalled();
    expect(prisma.zone.findMany).not.toHaveBeenCalled();
  });
});

describe('ProjectDeliverablesService.forceApplyTargetToTask — §12 · closest ancestor-or-self target', () => {
  const TOP = { zoneId: 693, projectDeliverableId: PD_ID, targetDate: day('2026-11-15') };

  it('a sub-zone task takes the target of the top zone it is planned under', async () => {
    const { service, prisma } = makeScopedService({
      zdts: [TOP],
      tasks: [task(22, 696, { dueDateOverridden: true, endDate: day('2026-12-20') })],
      pdTargetDate: day('2027-03-07'), // deliverable-level fallback must NOT win
    });

    await service.forceApplyTargetToTask(22);

    const { data } = prisma.task.update.mock.calls[0][0];
    expect(isoDay(data.endDate)).toBe('2026-11-15');
    expect(isoDay(data.estimatedStartDate)).toBe('2026-11-08'); // 8h → one week
    expect(data.dueDateOverridden).toBe(false);
  });

  it('a dated target on a closer zone wins over the ancestor', async () => {
    const { service, prisma } = makeScopedService({
      zdts: [TOP, { zoneId: 695, projectDeliverableId: PD_ID, targetDate: day('2026-11-29') }],
      tasks: [task(22, 696), task(21, 695)],
    });

    await service.forceApplyTargetToTask(22); // zone 696 → parent 695 has the closer target
    expect(isoDay(prisma.task.update.mock.calls[0][0].data.endDate)).toBe('2026-11-29');

    await service.forceApplyTargetToTask(21); // own zone
    expect(isoDay(prisma.task.update.mock.calls[1][0].data.endDate)).toBe('2026-11-29');
    // Own-zone hit needs no zone tree; the first call needed exactly one.
    expect(prisma.zone.findMany).toHaveBeenCalledTimes(1);
  });

  it('a date-less row on the task zone is not a target — the ancestor target applies', async () => {
    const { service, prisma } = makeScopedService({
      zdts: [TOP, { zoneId: 695, projectDeliverableId: PD_ID, targetDate: null }],
      tasks: [task(21, 695)],
    });

    await service.forceApplyTargetToTask(21);

    expect(isoDay(prisma.task.update.mock.calls[0][0].data.endDate)).toBe('2026-11-15');
  });

  it('falls back to the deliverable-level target when no zone on the way up has one', async () => {
    const { service, prisma } = makeScopedService({
      zdts: [TOP], // Building A only
      tasks: [task(99, 700), task(5, null, { budgetHours: 100 })],
      pdTargetDate: day('2027-03-07'),
    });

    await service.forceApplyTargetToTask(99); // Building B — another tree
    expect(isoDay(prisma.task.update.mock.calls[0][0].data.endDate)).toBe('2027-03-07');

    await service.forceApplyTargetToTask(5); // zone-less task — no zone target lookup at all
    const { data } = prisma.task.update.mock.calls[1][0];
    expect(isoDay(data.endDate)).toBe('2027-03-07');
    expect(isoDay(data.estimatedStartDate)).toBe('2027-02-14'); // 100h → ceil(100/40) = 3 weeks
    expect(prisma.zoneDeliverableTarget.findMany).toHaveBeenCalledTimes(1); // only for task 99
  });
});
