/**
 * T3-2 — Scheduler service unit tests.
 *
 * These exercise the backward + forward passes with the real algorithm
 * (snap-and-walk working-day helpers, Kahn's topo sort, dueDateOverridden
 * short-circuit) against a jest-mocked PrismaService — no DB needed.
 *
 * Calendar setup (shared across tests): weeklyRestDays = [5, 6]
 * (Fri + Sat; Israeli work-week). No holidays unless a test adds them.
 * November 2026 anchors are chosen so a 3-task × 2-working-day chain
 * sits inside Mon–Thu and doesn't collide with Fri/Sat:
 *
 *   Mon 2026-11-02 · Tue 2026-11-03 · Wed 2026-11-04 · Thu 2026-11-05
 *   Fri 2026-11-06 (rest) · Sat 2026-11-07 (rest)
 *   Mon 2026-11-09 · Tue 2026-11-10
 *
 * All date comparisons use the YYYY-MM-DD prefix of the ISO string.
 */
import { SchedulerService } from './scheduler.service';
import { ExecutionPlanningService } from '../execution-planning/execution-planning.service';

type Task = {
  id: number;
  budgetHours: number | null;
  estimatedStartDate: Date | null;
  startDate: Date | null;
  endDate: Date | null;
  dueDateOverridden: boolean;
  assignees: Array<{ user: { id: number; dailyStandardHours: number } }>;
};

function iso(d: Date): string {
  return d.toISOString().split('T')[0];
}

function makeTask(partial: Partial<Task> & { id: number }): Task {
  return {
    budgetHours: 8, // one day of work by default
    estimatedStartDate: null,
    startDate: null,
    endDate: null,
    dueDateOverridden: false,
    assignees: [{ user: { id: 1, dailyStandardHours: 8 } }],
    ...partial,
  } as Task;
}

/**
 * Build a mock PrismaService preloaded with the test's fixture.
 *
 *   - zoneDeliverableTarget.findUnique → { id, targetDate, zoneId,
 *     projectDeliverableId, projectDeliverable: { project: {...} } }
 *   - task.findMany → the fixture's tasks (projectDeliverableId filter
 *     is honoured implicitly by the fixture)
 *   - taskDependency.findMany → the fixture's edges
 *   - calendarDay.findMany → the fixture's holidays (empty by default)
 *   - hrSettings.findFirst → weeklyRestDays [5, 6] by default
 *   - $transaction + task.update → tracked, but no-op
 */
function makePrisma(fixture: {
  tasks: Task[];
  deps: Array<{ taskId: number; dependsOnId: number }>;
  deliverable: {
    id: number;
    targetDate: Date;
    zoneId: number;
    projectDeliverableId: number;
    projectStartDate?: Date | null;
  };
  holidays?: Array<{ date: Date; type: string; workingHours: number | null }>;
  weeklyRestDays?: number[] | null;
}) {
  const updates: Array<{ id: number; data: any }> = [];
  const prisma: any = {
    zoneDeliverableTarget: {
      findUnique: jest.fn().mockResolvedValue({
        id: fixture.deliverable.id,
        targetDate: fixture.deliverable.targetDate,
        zoneId: fixture.deliverable.zoneId,
        projectDeliverableId: fixture.deliverable.projectDeliverableId,
        projectDeliverable: {
          project: {
            id: 1,
            startDate: fixture.deliverable.projectStartDate ?? null,
          },
        },
        zone: { id: fixture.deliverable.zoneId, projectId: 1 },
      }),
    },
    task: {
      findMany: jest.fn().mockResolvedValue(fixture.tasks),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        updates.push({ id: where.id, data });
        return Promise.resolve({ ...fixture.tasks.find((t) => t.id === where.id), ...data });
      }),
    },
    taskDependency: {
      findMany: jest.fn().mockResolvedValue(fixture.deps),
    },
    calendarDay: {
      findMany: jest.fn().mockResolvedValue(fixture.holidays ?? []),
    },
    hrSettings: {
      findFirst: jest.fn().mockResolvedValue({
        weeklyRestDays: fixture.weeklyRestDays ?? [5, 6],
      }),
    },
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(prisma)),
  };
  return { prisma, updates };
}

function newService(prisma: any): SchedulerService {
  // ExecutionPlanningService.countWorkingDays only uses `this.prisma` /
  // `this.access` indirectly in other methods; we instantiate it with
  // stub deps and call only the public pure helper.
  const eps = new ExecutionPlanningService({} as any, {} as any);
  return new SchedulerService(prisma, eps);
}

describe('SchedulerService — T3-2 scheduling engine', () => {
  // ─── Test 1 ────────────────────────────────────────────────────────
  //
  // Linear chain, 3 tasks each 2 working days, anchor 2026-11-10 (Tue).
  // Weekly rest [5, 6] = Fri + Sat (Israel work-week: Sun IS working).
  // Expected walk-back behaviour:
  //   • Terminal 103: end=Tue 11-10, start=Mon 11-09 (inclusive 2 wd).
  //   • Mid 102:      end=Mon 11-09 (gap=0 handoff), start=Sun 11-08
  //                   (Sun working under [5,6]).
  //   • First 101:    end=Sun 11-08, start=Thu 11-05 — Sat/Fri skipped
  //                   as the walk crosses the weekend. This is the
  //                   "Fri/Sat skipped" case from the spec.
  //
  // Exercises: Kahn topo, backward chaining via successor.start, Fri/Sat
  // skip, inclusive walkWorkingDaysBack semantics.
  it('linear chain of 3 tasks (each 2 working days) walks back across the Fri/Sat weekend', async () => {
    const target = new Date(Date.UTC(2026, 10, 10)); // Tue 2026-11-10

    const tasks = [
      makeTask({ id: 101, budgetHours: 16 }),
      makeTask({ id: 102, budgetHours: 16 }),
      makeTask({ id: 103, budgetHours: 16 }),
    ];
    // 101 → 102 → 103
    const deps = [
      { taskId: 102, dependsOnId: 101 },
      { taskId: 103, dependsOnId: 102 },
    ];

    const { prisma } = makePrisma({
      tasks,
      deps,
      deliverable: { id: 1, targetDate: target, zoneId: 1, projectDeliverableId: 1 },
    });
    const svc = newService(prisma);

    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 1 });
    const byId = new Map(out.scheduled.map((s) => [s.taskId, s]));

    expect(iso(byId.get(103)!.endDate)).toBe('2026-11-10');
    expect(iso(byId.get(103)!.startDate)).toBe('2026-11-09');

    expect(iso(byId.get(102)!.endDate)).toBe('2026-11-09');
    expect(iso(byId.get(102)!.startDate)).toBe('2026-11-08');

    // First task 101 straddles the Fri/Sat weekend: end Sun 11-08,
    // walkBack 2 wd inclusive → skip Sat 11-07 + Fri 11-06, land Thu 11-05.
    expect(iso(byId.get(101)!.endDate)).toBe('2026-11-08');
    expect(iso(byId.get(101)!.startDate)).toBe('2026-11-05');

    // No overrides → no skipped rows.
    expect(out.scheduled.every((s) => !s.skippedByOverride)).toBe(true);
  });

  // ─── Test 2 ────────────────────────────────────────────────────────
  //
  // Fork: 1 → {2, 3} → 4. Each task 2 working days. Anchor Tue 11-10.
  // Weekly rest [5, 6] (Fri + Sat). Expected:
  //   • task 4: end Tue 11-10, start Mon 11-09.
  //   • task 2 and 3: both end Mon 11-09 (gap=0 handoff), both start
  //     Sun 11-08. Same dates because they're independent branches.
  //   • task 1: end = min(2.start, 3.start) = Sun 11-08; walkBack 2 wd
  //     inclusive crosses Sat/Fri → start Thu 11-05.
  it('dependency fork 1 → {2, 3} → 4: both branches end before 4 starts', async () => {
    const target = new Date(Date.UTC(2026, 10, 10));

    const tasks = [
      makeTask({ id: 1, budgetHours: 16 }),
      makeTask({ id: 2, budgetHours: 16 }),
      makeTask({ id: 3, budgetHours: 16 }),
      makeTask({ id: 4, budgetHours: 16 }),
    ];
    const deps = [
      { taskId: 2, dependsOnId: 1 },
      { taskId: 3, dependsOnId: 1 },
      { taskId: 4, dependsOnId: 2 },
      { taskId: 4, dependsOnId: 3 },
    ];

    const { prisma } = makePrisma({
      tasks,
      deps,
      deliverable: { id: 2, targetDate: target, zoneId: 1, projectDeliverableId: 2 },
    });
    const svc = newService(prisma);
    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 2 });
    const byId = new Map(out.scheduled.map((s) => [s.taskId, s]));

    expect(iso(byId.get(4)!.endDate)).toBe('2026-11-10');
    expect(iso(byId.get(4)!.startDate)).toBe('2026-11-09');

    // Both branches hand off on Mon 11-09.
    expect(iso(byId.get(2)!.endDate)).toBe('2026-11-09');
    expect(iso(byId.get(3)!.endDate)).toBe('2026-11-09');
    expect(iso(byId.get(2)!.startDate)).toBe('2026-11-08');
    expect(iso(byId.get(3)!.startDate)).toBe('2026-11-08');

    // Task 1 ends at min(branch starts) = Sun 11-08, walkBack 2 wd
    // across the Fri/Sat weekend → start Thu 11-05.
    expect(iso(byId.get(1)!.endDate)).toBe('2026-11-08');
    expect(iso(byId.get(1)!.startDate)).toBe('2026-11-05');
  });

  // ─── Test 3 ────────────────────────────────────────────────────────
  //
  // Mid-chain `dueDateOverridden`: the override's stored dates survive;
  // the chain upstream and downstream still schedules around it. The
  // mid task carries explicit endDate=11-06 (Fri — manually overridden
  // to a non-working day) and estimatedStartDate=11-04 so we can assert
  // on exact survival. Chain: 1 → 2(override) → 3. Anchor 11-10.
  //
  // Expectation: task 3 anchor-ends at 11-10, start Mon 11-09.
  //              task 2 stays at its override — end=11-06, start=11-04.
  //              task 1 ends at task-2 start (11-04); start = Tue 11-03.
  it('dueDateOverridden preserves stored dates and the chain respects the override', async () => {
    const target = new Date(Date.UTC(2026, 10, 10));

    const tasks = [
      makeTask({ id: 1, budgetHours: 8 }),
      makeTask({
        id: 2,
        budgetHours: 8,
        dueDateOverridden: true,
        estimatedStartDate: new Date(Date.UTC(2026, 10, 4)),
        endDate: new Date(Date.UTC(2026, 10, 6)),
      }),
      makeTask({ id: 3, budgetHours: 16 }),
    ];
    const deps = [
      { taskId: 2, dependsOnId: 1 },
      { taskId: 3, dependsOnId: 2 },
    ];

    const { prisma } = makePrisma({
      tasks,
      deps,
      deliverable: { id: 3, targetDate: target, zoneId: 1, projectDeliverableId: 3 },
    });
    const svc = newService(prisma);
    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 3 });
    const byId = new Map(out.scheduled.map((s) => [s.taskId, s]));

    // Task 2 — stored dates preserved; flagged.
    expect(byId.get(2)!.skippedByOverride).toBe(true);
    expect(iso(byId.get(2)!.endDate)).toBe('2026-11-06');
    expect(iso(byId.get(2)!.startDate)).toBe('2026-11-04');

    // Task 3 — ends at anchor; start Mon 11-09 (walk back 2 wd incl.).
    expect(iso(byId.get(3)!.endDate)).toBe('2026-11-10');
    expect(iso(byId.get(3)!.startDate)).toBe('2026-11-09');

    // Task 1 — ends at 2.startDate = Wed 11-04; dur=1 → start=11-04.
    expect(byId.get(1)!.skippedByOverride).toBe(false);
    expect(iso(byId.get(1)!.endDate)).toBe('2026-11-04');
    expect(iso(byId.get(1)!.startDate)).toBe('2026-11-04');
  });

  // ─── Test 4 ────────────────────────────────────────────────────────
  //
  // Unassigned task fallback: no assignees → defaults to org 8h/day;
  // no budgetHours → defaults to 1 working day. Terminal single task
  // ends at anchor and starts on same day (Mon 11-02).
  it('unassigned task with no budget uses org defaults (1 working day)', async () => {
    const target = new Date(Date.UTC(2026, 10, 2)); // Mon 2026-11-02

    const tasks = [
      makeTask({ id: 55, budgetHours: null, assignees: [] }),
    ];
    const { prisma } = makePrisma({
      tasks,
      deps: [],
      deliverable: { id: 4, targetDate: target, zoneId: 1, projectDeliverableId: 4 },
    });
    const svc = newService(prisma);
    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 4 });

    expect(out.scheduled).toHaveLength(1);
    expect(out.scheduled[0].workingDaysDuration).toBe(1);
    expect(iso(out.scheduled[0].endDate)).toBe('2026-11-02');
    expect(iso(out.scheduled[0].startDate)).toBe('2026-11-02');
  });

  // ─── Test 5 ────────────────────────────────────────────────────────
  //
  // Infeasible: a chain whose forward earliest-finish lands well past
  // the anchor → status='infeasible' and overflowDays > 5.
  //
  // Deterministic even on a CI box: anchor is in year 2030; projectStart
  // is in year 2040 (so baseDate = projectStart regardless of today's
  // date). The forward pass runs the whole chain from 2040, finishing
  // ~10 years past the 2030 anchor — overflow is thousands of working
  // days, far above the 5-wd 'at-risk' threshold.
  it('forward pass flags infeasibility when the chain finishes well past anchor', async () => {
    const target = new Date(Date.UTC(2030, 5, 3));        // Mon 2030-06-03
    const projectStart = new Date(Date.UTC(2040, 5, 4));   // ~10 years later

    const tasks = [
      makeTask({ id: 1, budgetHours: 64 }),
      makeTask({ id: 2, budgetHours: 64 }),
      makeTask({ id: 3, budgetHours: 64 }),
      makeTask({ id: 4, budgetHours: 64 }),
      makeTask({ id: 5, budgetHours: 64 }),
    ];
    const deps = [
      { taskId: 2, dependsOnId: 1 },
      { taskId: 3, dependsOnId: 2 },
      { taskId: 4, dependsOnId: 3 },
      { taskId: 5, dependsOnId: 4 },
    ];

    const { prisma } = makePrisma({
      tasks,
      deps,
      deliverable: {
        id: 5,
        targetDate: target,
        zoneId: 1,
        projectDeliverableId: 5,
        projectStartDate: projectStart,
      },
    });
    const svc = newService(prisma);
    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 5 });

    expect(out.feasibility.earliestForwardFinish).not.toBeNull();
    expect(out.feasibility.overflowDays).toBeGreaterThan(5);
    expect(out.feasibility.status).toBe('infeasible');
  });
});
