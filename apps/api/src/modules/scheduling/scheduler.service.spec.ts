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
 *
 * §12 (2026-11-14) · The clock is pinned (see `SUITE_TODAY` below). The
 * engine reads `new Date()` as "today" — the forward pass and the
 * resource-leveling runway both start at max(project.startDate, today) —
 * and these fixtures use fixed November-2026 anchors with no project
 * start, so the run date leaked into the results: the two D2 "spill to
 * the previous working day" specs went red from 2026-11-10 (today past
 * the day the spill lands on → flagged `overload`) and the D7 diamond was
 * only ever green on 2026-11-03 / 11-04 (its float math needs ES(A) to be
 * exactly the documented "today"). Nothing in the engine is wrong there;
 * the specs simply never said which day they run on.
 */
import { NotFoundException } from '@nestjs/common';

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

/**
 * §12 (2026-11-14) · "Today" for every spec in this file unless a spec
 * pins its own: Tue 2026-10-27 — before every November anchor used
 * below, so the whole runway is open, and the day the D2 overload spec
 * already names in its comment. Mid-morning UTC so the UTC calendar day
 * is the same in any host timezone.
 */
const SUITE_TODAY = new Date('2026-10-27T09:00:00.000Z');

/**
 * Fake ONLY `Date`. The service awaits jest-mocked Prisma promises;
 * leaving the timer / microtask APIs real keeps that plumbing untouched,
 * so pinning the clock cannot change anything but "what day is it".
 */
const REAL_TIMER_APIS = [
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
] as const;

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: [...REAL_TIMER_APIS] });
});
beforeEach(() => {
  // Re-pin before every spec — one that moves the clock (D7) must not
  // leak its date into the next.
  jest.setSystemTime(SUITE_TODAY);
});
afterAll(() => {
  jest.useRealTimers();
});

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
  /**
   * D1-Lag (2026-11-03): each dep may carry `lag` / `lagUnit`. The
   * mock below normalises missing values to `lag=0, lagUnit='WORKING_DAYS'`
   * so legacy fixtures auto-populate the new fields.
   */
  deps: Array<{
    taskId: number;
    dependsOnId: number;
    lag?: number;
    lagUnit?: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  }>;
  deliverable: {
    id: number;
    targetDate: Date;
    zoneId: number;
    projectDeliverableId: number;
    projectStartDate?: Date | null;
  };
  holidays?: Array<{ date: Date; type: string; workingHours: number | null }>;
  weeklyRestDays?: number[] | null;
  /**
   * Per-user WorkSchedule rows used by D2 resource leveling. The
   * fixture lookup matches on `userId` + `isActive=true`; if no row
   * exists the service falls back to the task's dailyStandardHours.
   */
  workSchedules?: Array<{
    userId: number;
    shiftStart: string;
    shiftEnd: string;
    breakMinutes: number;
  }>;
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
      // §12 · scope lookup: no OTHER dated target for the deliverable.
      findMany: jest.fn().mockResolvedValue([]),
    },
    // §12 · scope lookup: a flat project (the target's zone has no
    // sub-zones), so the scope is the target's zone alone — the shape
    // every pre-§12 spec in this file was written for.
    zone: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    task: {
      findMany: jest.fn().mockResolvedValue(fixture.tasks),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        updates.push({ id: where.id, data });
        return Promise.resolve({ ...fixture.tasks.find((t) => t.id === where.id), ...data });
      }),
    },
    taskDependency: {
      findMany: jest.fn().mockResolvedValue(
        (fixture.deps ?? []).map((d) => ({
          lag: 0,
          lagUnit: 'WORKING_DAYS',
          ...d,
        })),
      ),
    },
    calendarDay: {
      findMany: jest.fn().mockResolvedValue(fixture.holidays ?? []),
    },
    hrSettings: {
      findFirst: jest.fn().mockResolvedValue({
        weeklyRestDays: fixture.weeklyRestDays ?? [5, 6],
      }),
    },
    workSchedule: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        const rows = fixture.workSchedules ?? [];
        const row = rows.find((r) => r.userId === where?.userId);
        return Promise.resolve(row ?? null);
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
  // D1 (gap = 1 working day) walk-back:
  //   • Terminal 103: end=Tue 11-10, start=Mon 11-09 (inclusive 2 wd).
  //   • Mid 102:      end = prevWorkingDay(Mon 11-09) = Sun 11-08
  //                   (Sun working under [5,6]); walkBack 2 wd inclusive
  //                   crosses Sat/Fri → start Thu 11-05.
  //   • First 101:    end = prevWorkingDay(Thu 11-05) = Wed 11-04;
  //                   walkBack 2 wd inclusive → start Tue 11-03.
  //
  // Exercises: Kahn topo, backward chaining via successor.start, Fri/Sat
  // skip, inclusive walkWorkingDaysBack semantics, D1 gap.
  it('linear chain of 3 tasks (each 2 working days) walks back across the Fri/Sat weekend with 1-wd gap', async () => {
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

    // D1: 102 ends ONE working day before 103 starts → Sun 11-08.
    // Walk back 2 wd inclusive from Sun 11-08 across Fri/Sat → Thu 11-05.
    expect(iso(byId.get(102)!.endDate)).toBe('2026-11-08');
    expect(iso(byId.get(102)!.startDate)).toBe('2026-11-05');

    // D1: 101 ends ONE working day before 102 starts (Thu 11-05) → Wed 11-04.
    // Walk back 2 wd inclusive → Tue 11-03.
    expect(iso(byId.get(101)!.endDate)).toBe('2026-11-04');
    expect(iso(byId.get(101)!.startDate)).toBe('2026-11-03');

    // No overrides → no skipped rows.
    expect(out.scheduled.every((s) => !s.skippedByOverride)).toBe(true);
  });

  // ─── Test 2 ────────────────────────────────────────────────────────
  //
  // Fork: 1 → {2, 3} → 4. Each task 2 working days. Anchor Tue 11-10.
  // Weekly rest [5, 6] (Fri + Sat). D1 gap = 1 working day.
  // Branch tasks 2 and 3 use DIFFERENT assignees (10, 20) so D2
  // resource leveling does NOT push them apart — we're isolating the
  // dependency-gap rule here.
  //   • task 4: end Tue 11-10, start Mon 11-09.
  //   • task 2 and 3: both end = prevWorkingDay(Mon 11-09) = Sun 11-08;
  //     walkBack 2 wd across Fri/Sat → start Thu 11-05.
  //   • task 1: end = prevWorkingDay(min(2.start, 3.start)) =
  //     prevWorkingDay(Thu 11-05) = Wed 11-04; walkBack 2 wd → Tue 11-03.
  it('dependency fork 1 → {2, 3} → 4: branches hand off with 1-wd gap', async () => {
    const target = new Date(Date.UTC(2026, 10, 10));

    const tasks = [
      makeTask({ id: 1, budgetHours: 16 }),
      makeTask({
        id: 2,
        budgetHours: 16,
        assignees: [{ user: { id: 10, dailyStandardHours: 8 } }],
      }),
      makeTask({
        id: 3,
        budgetHours: 16,
        assignees: [{ user: { id: 20, dailyStandardHours: 8 } }],
      }),
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

    // D1: both branches hand off ONE working day before 4 starts → Sun 11-08.
    expect(iso(byId.get(2)!.endDate)).toBe('2026-11-08');
    expect(iso(byId.get(3)!.endDate)).toBe('2026-11-08');
    expect(iso(byId.get(2)!.startDate)).toBe('2026-11-05');
    expect(iso(byId.get(3)!.startDate)).toBe('2026-11-05');

    // Task 1 ends at prevWorkingDay(min(branch starts)) = prev(Thu 11-05) = Wed 11-04.
    expect(iso(byId.get(1)!.endDate)).toBe('2026-11-04');
    expect(iso(byId.get(1)!.startDate)).toBe('2026-11-03');
  });

  // ─── Test 3 ────────────────────────────────────────────────────────
  //
  // Mid-chain `dueDateOverridden`: the override's stored dates survive;
  // the chain upstream and downstream still schedules around it. The
  // mid task carries explicit endDate=11-06 (Fri — manually overridden
  // to a non-working day) and estimatedStartDate=11-04 so we can assert
  // on exact survival. Chain: 1 → 2(override) → 3. Anchor 11-10.
  //
  // Expectation (D1 gap = 1 wd):
  //   task 3 anchor-ends at 11-10, start Mon 11-09.
  //   task 2 stays at its override — end=11-06, start=11-04.
  //   task 1 ends at prevWorkingDay(2.start = Wed 11-04) = Tue 11-03;
  //          dur=1 → start = Tue 11-03.
  it('dueDateOverridden preserves stored dates; chain respects override + 1-wd gap', async () => {
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

    // Task 1 — D1: end = prevWorkingDay(2.start = Wed 11-04) = Tue 11-03;
    //         dur = 1 → start = Tue 11-03.
    expect(byId.get(1)!.skippedByOverride).toBe(false);
    expect(iso(byId.get(1)!.endDate)).toBe('2026-11-03');
    expect(iso(byId.get(1)!.startDate)).toBe('2026-11-03');
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

  // ─── D1 extra ──────────────────────────────────────────────────────
  //
  // Two predecessors feeding a terminal successor: the forward-pass
  // earliest start of the successor must land 1 working day AFTER the
  // LATER predecessor's earliest finish (spec rule 3 + rule 4). We assert
  // the backward-pass dates do the same max-and-step via the single
  // handoff: both predecessors end at prevWorkingDay(successor.start),
  // regardless of their individual durations.
  //
  // Branches 1 and 2 use DIFFERENT assignees (10, 20) so D2 leveling
  // doesn't push the shorter branch earlier — this test isolates D1.
  //
  // Shape:  A(16h, 2 wd)  ─┐
  //                        ├─▶  C(8h, 1 wd)   anchor Tue 11-10
  //         B(8h,  1 wd)  ─┘
  it('two predecessors: successor starts the working day AFTER the later predecessor ends (D1)', async () => {
    const target = new Date(Date.UTC(2026, 10, 10)); // Tue 2026-11-10

    const tasks = [
      makeTask({
        id: 1,
        budgetHours: 16, // 2 wd
        assignees: [{ user: { id: 10, dailyStandardHours: 8 } }],
      }),
      makeTask({
        id: 2,
        budgetHours: 8, // 1 wd
        assignees: [{ user: { id: 20, dailyStandardHours: 8 } }],
      }),
      makeTask({ id: 3, budgetHours: 8 }), // 1 wd — terminal, assignee 1
    ];
    const deps = [
      { taskId: 3, dependsOnId: 1 },
      { taskId: 3, dependsOnId: 2 },
    ];

    const { prisma } = makePrisma({
      tasks,
      deps,
      deliverable: { id: 10, targetDate: target, zoneId: 1, projectDeliverableId: 10 },
    });
    const svc = newService(prisma);
    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 10 });
    const byId = new Map(out.scheduled.map((s) => [s.taskId, s]));

    // Task 3 terminal — ends at anchor Tue 11-10, start Tue 11-10 (1 wd).
    expect(iso(byId.get(3)!.endDate)).toBe('2026-11-10');
    expect(iso(byId.get(3)!.startDate)).toBe('2026-11-10');

    // Both preds end ONE working day before 3's start:
    //   prevWorkingDay(Tue 11-10) = Mon 11-09.
    expect(iso(byId.get(1)!.endDate)).toBe('2026-11-09');
    expect(iso(byId.get(2)!.endDate)).toBe('2026-11-09');

    // Starts differ by their own durations: Task 1 is 2 wd → start Sun 11-08.
    expect(iso(byId.get(1)!.startDate)).toBe('2026-11-08');
    // Task 2 is 1 wd → start Mon 11-09.
    expect(iso(byId.get(2)!.startDate)).toBe('2026-11-09');
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

  // ─── D2 · Test 1 ───────────────────────────────────────────────────
  //
  // Resource leveling: two 4-hour tasks for the SAME assignee share the
  // same anchor day → both fit inside 8h capacity → both keep their
  // backward-pass startDate (anchor). No WorkSchedule fixture → the
  // service falls back to dailyStandardHours×60 = 480 min.
  it('D2 · two 4h tasks for same assignee on same anchor day fit in one 8h day', async () => {
    const target = new Date(Date.UTC(2026, 10, 2)); // Mon 2026-11-02

    const tasks = [
      makeTask({ id: 1, budgetHours: 4 }),
      makeTask({ id: 2, budgetHours: 4 }),
    ];
    const { prisma } = makePrisma({
      tasks,
      deps: [],
      deliverable: { id: 11, targetDate: target, zoneId: 1, projectDeliverableId: 11 },
    });
    const svc = newService(prisma);
    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 11 });
    const byId = new Map(out.scheduled.map((s) => [s.taskId, s]));

    expect(iso(byId.get(1)!.endDate)).toBe('2026-11-02');
    expect(iso(byId.get(2)!.endDate)).toBe('2026-11-02');
    // 4 + 4 ≤ 8 → both start on the anchor day.
    expect(iso(byId.get(1)!.startDate)).toBe('2026-11-02');
    expect(iso(byId.get(2)!.startDate)).toBe('2026-11-02');
    expect(byId.get(1)!.infeasible).toBeFalsy();
    expect(byId.get(2)!.infeasible).toBeFalsy();
  });

  // ─── D2 · Test 2 ───────────────────────────────────────────────────
  //
  // Two 6-hour tasks for the SAME assignee ending on anchor → total 12h
  // > 8h capacity → the SECOND task (sorted by id asc at the tie) spills
  // 240 min back to the previous working day (Mon 11-09, since Sun 11-08
  // is a Sunday — rest day under [5,6]? No! [5,6]=Fri+Sat so Sun IS a
  // working day). Prev working day of Tue 11-10 under [5,6] is Mon 11-09.
  it('D2 · two 6h tasks for same assignee spill the second to the previous working day', async () => {
    const target = new Date(Date.UTC(2026, 10, 10)); // Tue 2026-11-10

    const tasks = [
      makeTask({ id: 1, budgetHours: 6 }),
      makeTask({ id: 2, budgetHours: 6 }),
    ];
    const { prisma } = makePrisma({
      tasks,
      deps: [],
      deliverable: { id: 12, targetDate: target, zoneId: 1, projectDeliverableId: 12 },
    });
    const svc = newService(prisma);
    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 12 });
    const byId = new Map(out.scheduled.map((s) => [s.taskId, s]));

    expect(iso(byId.get(1)!.endDate)).toBe('2026-11-10');
    expect(iso(byId.get(2)!.endDate)).toBe('2026-11-10');

    // Sort tie: id=1 first → fills 360 min on 11-10 (remaining 120).
    // id=2 next: places 120 on 11-10 (used=480), spills 240 to 11-09.
    expect(iso(byId.get(1)!.startDate)).toBe('2026-11-10');
    expect(iso(byId.get(2)!.startDate)).toBe('2026-11-09');
    expect(byId.get(1)!.infeasible).toBeFalsy();
    expect(byId.get(2)!.infeasible).toBeFalsy();
  });

  // ─── D2 · Test 3 ───────────────────────────────────────────────────
  //
  // Three 4h tasks on the same anchor day for the same assignee → the
  // first two fit (8h), the third (id=3) spills back one working day.
  it('D2 · three 4h tasks spill the third task to the previous working day', async () => {
    const target = new Date(Date.UTC(2026, 10, 10)); // Tue 2026-11-10

    const tasks = [
      makeTask({ id: 1, budgetHours: 4 }),
      makeTask({ id: 2, budgetHours: 4 }),
      makeTask({ id: 3, budgetHours: 4 }),
    ];
    const { prisma } = makePrisma({
      tasks,
      deps: [],
      deliverable: { id: 13, targetDate: target, zoneId: 1, projectDeliverableId: 13 },
    });
    const svc = newService(prisma);
    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 13 });
    const byId = new Map(out.scheduled.map((s) => [s.taskId, s]));

    expect(iso(byId.get(1)!.startDate)).toBe('2026-11-10');
    expect(iso(byId.get(2)!.startDate)).toBe('2026-11-10');
    expect(iso(byId.get(3)!.startDate)).toBe('2026-11-09'); // spilled
    expect(byId.get(3)!.infeasible).toBeFalsy();
  });

  // ─── D2 · Test 4 ───────────────────────────────────────────────────
  //
  // Overload beyond baseDate flags `infeasible: 'overload'`.
  // projectStart = anchor = Mon 11-02 → baseDate = projectStart =
  // 2026-11-02 (projectStart is after today 2026-10-27). Two full-day
  // tasks (8h each) end on anchor → task 2 overflow walks to Sun 11-01
  // which is BELOW baseDate → infeasible flag.
  it('D2 · overload beyond baseDate flags infeasible with reason=overload', async () => {
    const target = new Date(Date.UTC(2026, 10, 2));         // Mon 2026-11-02
    const projectStart = new Date(Date.UTC(2026, 10, 2));   // same day → baseDate=11-02

    const tasks = [
      makeTask({ id: 1, budgetHours: 8 }),
      makeTask({ id: 2, budgetHours: 8 }),
    ];
    const { prisma } = makePrisma({
      tasks,
      deps: [],
      deliverable: {
        id: 14,
        targetDate: target,
        zoneId: 1,
        projectDeliverableId: 14,
        projectStartDate: projectStart,
      },
    });
    const svc = newService(prisma);
    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 14 });
    const byId = new Map(out.scheduled.map((s) => [s.taskId, s]));

    // Task 1 fits exactly on anchor day.
    expect(iso(byId.get(1)!.startDate)).toBe('2026-11-02');
    expect(byId.get(1)!.infeasible).toBeFalsy();

    // Task 2 overflows → walks back and lands below baseDate →
    // infeasible. We don't pin its exact startDate (the engine exposes
    // the below-baseDate cursor), only the flag.
    expect(byId.get(2)!.infeasible).toBe(true);
    expect(byId.get(2)!.infeasibleReason).toBe('overload');
  });

  // ─── D2 · Test 5 — WorkSchedule capacity ───────────────────────────
  //
  // When a WorkSchedule row exists for the assignee it OVERRIDES the
  // dailyStandardHours fallback. Row: 08:00-17:00, break 60 min = 480
  // min/day. Two 4h tasks → fit in one day. Add a third 4h task → the
  // third spills (same as D2·Test 3 but via the WorkSchedule path).
  it('D2 · WorkSchedule row sets capacity (shiftEnd − shiftStart − break)', async () => {
    const target = new Date(Date.UTC(2026, 10, 10)); // Tue 2026-11-10

    const tasks = [
      makeTask({ id: 1, budgetHours: 4 }),
      makeTask({ id: 2, budgetHours: 4 }),
      makeTask({ id: 3, budgetHours: 4 }),
    ];
    const { prisma } = makePrisma({
      tasks,
      deps: [],
      deliverable: { id: 15, targetDate: target, zoneId: 1, projectDeliverableId: 15 },
      workSchedules: [
        {
          userId: 1,
          shiftStart: '08:00',
          shiftEnd: '17:00',
          breakMinutes: 60,
        },
      ],
    });
    const svc = newService(prisma);
    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 15 });
    const byId = new Map(out.scheduled.map((s) => [s.taskId, s]));

    // 9h − 1h break = 8h/day. Same spill behavior as D2·Test 3.
    expect(iso(byId.get(1)!.startDate)).toBe('2026-11-10');
    expect(iso(byId.get(2)!.startDate)).toBe('2026-11-10');
    expect(iso(byId.get(3)!.startDate)).toBe('2026-11-09');
  });

  // ─── D1-Lag · WORKING_DAYS lag=2 ───────────────────────────────────
  //
  // 2-task linear chain, each 2wd, anchor Tue 2026-11-10. Dep 103←102
  // carries `lag: 2, lagUnit: 'WORKING_DAYS'`. The base "+1 working-day
  // handoff" plus 2 extra working-day steps = pred ends 3 working days
  // before successor starts.
  //
  //   Task 103 (terminal, 2 wd): end Tue 11-10, start Mon 11-09.
  //   Task 102: applyLagBackward(Mon 11-09, lag=2) =
  //             prevWorkingDay(Mon 11-09) = Sun 11-08 (Sun is working
  //             under [5,6]), then back 2 more wd — step 1 Thu 11-05
  //             (skipping Sat 11-07, Fri 11-06), step 2 Wed 11-04.
  //             Wait — Sun 11-08 back one wd = Thu 11-05 (skipping Sat,
  //             Fri). Then one more = Wed 11-04. So 102.end = Wed 11-04.
  //             Hmm. The work-order says 102.end = Thu 11-05 — i.e. only
  //             ONE more wd step after prevWorkingDay. Let me recount:
  //             applyLagBackward:
  //               cursor = prevWorkingDay(Mon 11-09) = Sun 11-08.
  //               remaining = safeLag = 2.
  //               loop iter 1: cursor = prevWorkingDay(Sun 11-08) = Thu
  //                 11-05 (skips Sat 11-07, Fri 11-06). remaining = 1.
  //               loop iter 2: cursor = prevWorkingDay(Thu 11-05) = Wed
  //                 11-04. remaining = 0.
  //             So 102.end = Wed 11-04. walkBack 2 wd inclusive from
  //             Wed 11-04 → Tue 11-03.
  it('D1-Lag · WORKING_DAYS lag=2 pushes predecessor earlier by 2 extra wd', async () => {
    const target = new Date(Date.UTC(2026, 10, 10)); // Tue 2026-11-10

    const tasks = [
      makeTask({ id: 102, budgetHours: 16 }),
      makeTask({ id: 103, budgetHours: 16 }),
    ];
    const deps = [
      { taskId: 103, dependsOnId: 102, lag: 2, lagUnit: 'WORKING_DAYS' as const },
    ];

    const { prisma } = makePrisma({
      tasks,
      deps,
      deliverable: { id: 20, targetDate: target, zoneId: 1, projectDeliverableId: 20 },
    });
    const svc = newService(prisma);
    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 20 });
    const byId = new Map(out.scheduled.map((s) => [s.taskId, s]));

    expect(iso(byId.get(103)!.endDate)).toBe('2026-11-10');
    expect(iso(byId.get(103)!.startDate)).toBe('2026-11-09');

    expect(iso(byId.get(102)!.endDate)).toBe('2026-11-04');
    expect(iso(byId.get(102)!.startDate)).toBe('2026-11-03');
  });

  // ─── D1-Lag · CALENDAR_DAYS lag=5 over weekend ─────────────────────
  //
  // Chain 2 → 1 (task 1 depends on task 2). Each 1wd, anchor Wed
  // 2026-11-11. Dep from 1 → 2 is OPPOSITE in the backward pass
  // direction so we flip: actually, task 1 depends on task 2 means
  // `taskId=1, dependsOnId=2` — so the successor is task 1. For the
  // backward pass we want a chain where the terminal task anchors at
  // 11-11 and the predecessor rolls back 5 cal days + the +1 base.
  //
  // Simpler shape: tasks 1 (pred) → 2 (succ, terminal); dep from 2 → 1.
  //   Task 2 (terminal, 1 wd): end Wed 11-11, start Wed 11-11.
  //   Task 1: applyLagBackward(Wed 11-11, lag=5, CALENDAR_DAYS) =
  //           snapBack(Wed 11-11 − 6 cal days = Thu 11-05).
  //           Thu 11-05 is working under [5,6] → stays. So 1.end = Thu
  //           11-05, start = Thu 11-05 (1 wd).
  it('D1-Lag · CALENDAR_DAYS lag=5 rolls backward over Fri/Sat weekend', async () => {
    const target = new Date(Date.UTC(2026, 10, 11)); // Wed 2026-11-11

    const tasks = [
      makeTask({ id: 1, budgetHours: 8 }),
      makeTask({ id: 2, budgetHours: 8 }),
    ];
    const deps = [
      { taskId: 2, dependsOnId: 1, lag: 5, lagUnit: 'CALENDAR_DAYS' as const },
    ];

    const { prisma } = makePrisma({
      tasks,
      deps,
      deliverable: { id: 21, targetDate: target, zoneId: 1, projectDeliverableId: 21 },
    });
    const svc = newService(prisma);
    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 21 });
    const byId = new Map(out.scheduled.map((s) => [s.taskId, s]));

    expect(iso(byId.get(2)!.endDate)).toBe('2026-11-11');
    expect(iso(byId.get(2)!.startDate)).toBe('2026-11-11');

    expect(iso(byId.get(1)!.endDate)).toBe('2026-11-05');
    expect(iso(byId.get(1)!.startDate)).toBe('2026-11-05');
  });

  // ─── D7 · diamond critical path ────────────────────────────────────
  //
  // A → B → D and A → C → D. B is short (1 wd), C is long (3 wd), so
  // A → C → D is the longer path. We expect:
  //   • A, C, D on the critical path (float = 0 under LS==ES).
  //   • B off the critical path (float ≥ 1).
  //
  // We tighten the anchor to Mon 2026-11-09 so the project's own slack
  // is zero (EF of the terminal task equals LS). Standard CPM: when
  // project due equals earliest possible finish, every task on the
  // longest branch has LS==ES → float=0; the shorter branch inherits
  // the branch-length diff as slack.
  //
  // Tasks:  A = 1 wd, B = 1 wd, C = 3 wd, D = 1 wd.
  // Base date = today (2026-11-03, Tue). Forward pass:
  //   ES_A=11-03, ES_B=11-04, ES_C=11-04, EF_C=11-08, ES_D=11-09.
  it('D7 · diamond: critical path flows through the longer branch', async () => {
    // §12 (2026-11-14) · The premise above ("today = Tue 2026-11-03") is
    // now stated to the engine instead of assumed from the wall clock:
    // zero project slack needs ES(A) to be exactly that day.
    jest.setSystemTime(new Date('2026-11-03T09:00:00.000Z'));
    const target = new Date(Date.UTC(2026, 10, 9)); // Mon 2026-11-09

    const tasks = [
      makeTask({ id: 1, budgetHours: 8 }),  // A — 1 wd
      makeTask({
        id: 2,
        budgetHours: 8,                     // B — 1 wd (short branch)
        assignees: [{ user: { id: 10, dailyStandardHours: 8 } }],
      }),
      makeTask({
        id: 3,
        budgetHours: 24,                    // C — 3 wd (long branch)
        assignees: [{ user: { id: 20, dailyStandardHours: 8 } }],
      }),
      makeTask({ id: 4, budgetHours: 8 }),  // D — 1 wd (terminal)
    ];
    const deps = [
      { taskId: 2, dependsOnId: 1 },        // B ← A
      { taskId: 3, dependsOnId: 1 },        // C ← A
      { taskId: 4, dependsOnId: 2 },        // D ← B
      { taskId: 4, dependsOnId: 3 },        // D ← C
    ];

    const { prisma } = makePrisma({
      tasks,
      deps,
      deliverable: { id: 22, targetDate: target, zoneId: 1, projectDeliverableId: 22 },
    });
    const svc = newService(prisma);
    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 22 });
    const byId = new Map(out.scheduled.map((s) => [s.taskId, s]));

    // Longer branch (A, C, D) must be on CP (float=0).
    expect(byId.get(1)!.onCriticalPath).toBe(true);
    expect(byId.get(3)!.onCriticalPath).toBe(true);
    expect(byId.get(4)!.onCriticalPath).toBe(true);
    expect(byId.get(1)!.float).toBe(0);
    expect(byId.get(3)!.float).toBe(0);
    expect(byId.get(4)!.float).toBe(0);

    // Shorter branch (B) must have slack.
    expect(byId.get(2)!.onCriticalPath).toBe(false);
    expect((byId.get(2)!.float ?? 0)).toBeGreaterThan(0);
  });

  // ─── §10 (2026-11-13) · Dry-run by (ProjectDeliverable × Zone) ─────
  //
  // The Deliverable Planning UI only holds the ProjectDeliverable id +
  // zone id; `scheduleProjectDeliverableDryRun` resolves the ZDT via
  // the composite unique key and delegates to the ZDT-keyed dry-run.
  // The shared `makePrisma` mock answers every
  // `zoneDeliverableTarget.findUnique` with the full fixture row, so
  // each test below overrides it to tell the two lookups apart:
  //   • composite-key lookup → `{ id }` (or null)
  //   • id lookup (inside `scheduleDeliverable`) → the full row
  describe('scheduleProjectDeliverableDryRun', () => {
    const target = new Date(Date.UTC(2026, 10, 10)); // Tue 2026-11-10
    const ZDT_ID = 77;
    const PD_ID = 227; // ProjectDeliverable id — deliberately ≠ ZDT id
    const ZONE_ID = 9;

    function setup() {
      const { prisma } = makePrisma({
        tasks: [makeTask({ id: 1, budgetHours: 8 })],
        deps: [],
        deliverable: { id: ZDT_ID, targetDate: target, zoneId: ZONE_ID, projectDeliverableId: PD_ID },
      });
      const fullRow = {
        id: ZDT_ID,
        targetDate: target,
        zoneId: ZONE_ID,
        projectDeliverableId: PD_ID,
        projectDeliverable: { project: { id: 1, startDate: null } },
        zone: { id: ZONE_ID, projectId: 1 },
      };
      prisma.zoneDeliverableTarget.findUnique = jest.fn().mockImplementation(({ where }: any) => {
        const key = where?.zoneId_projectDeliverableId;
        if (key) {
          const hit = key.zoneId === ZONE_ID && key.projectDeliverableId === PD_ID;
          return Promise.resolve(hit ? { id: ZDT_ID } : null);
        }
        return Promise.resolve(where?.id === ZDT_ID ? fullRow : null);
      });
      return { prisma, svc: newService(prisma) };
    }

    it('zoneId null/undefined → empty result (reason=no-zone) without any ZDT lookup', async () => {
      const { prisma, svc } = setup();

      for (const zoneId of [null, undefined]) {
        const out = await svc.scheduleProjectDeliverableDryRun({ projectDeliverableId: PD_ID, zoneId });
        expect(out.scheduled).toEqual([]);
        expect(out.feasibility.reason).toBe('no-zone');
        expect(out.feasibility.earliestForwardFinish).toBeNull();
      }

      expect(prisma.zoneDeliverableTarget.findUnique).not.toHaveBeenCalled();
      expect(prisma.task.findMany).not.toHaveBeenCalled();
    });

    it('no ZDT row for the (zone × deliverable) pair → empty result (reason=no-target-row)', async () => {
      const { prisma, svc } = setup();
      const spy = jest.spyOn(svc, 'scheduleDeliverableDryRun');

      // Zone 999 has no saved target for this deliverable.
      const out = await svc.scheduleProjectDeliverableDryRun({ projectDeliverableId: PD_ID, zoneId: 999 });

      expect(out.scheduled).toEqual([]);
      expect(out.feasibility.reason).toBe('no-target-row');

      // Looked up by the composite unique key — never by `id`.
      expect(prisma.zoneDeliverableTarget.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.zoneDeliverableTarget.findUnique).toHaveBeenCalledWith({
        where: { zoneId_projectDeliverableId: { zoneId: 999, projectDeliverableId: PD_ID } },
        select: { id: true },
      });
      expect(spy).not.toHaveBeenCalled();
      expect(prisma.task.findMany).not.toHaveBeenCalled();
    });

    it('ZDT found → delegates with the resolved ZDT id (not the ProjectDeliverable id) and forwards anchorDate', async () => {
      const { svc } = setup();
      const anchorDate = new Date(Date.UTC(2026, 10, 17)); // Tue 2026-11-17
      const canned = {
        scheduled: [],
        feasibility: { status: 'feasible' as const, earliestForwardFinish: null, overflowDays: 0 },
      };
      const spy = jest.spyOn(svc, 'scheduleDeliverableDryRun').mockResolvedValue(canned);

      const out = await svc.scheduleProjectDeliverableDryRun({
        projectDeliverableId: PD_ID,
        zoneId: ZONE_ID,
        anchorDate,
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ deliverableId: ZDT_ID, anchorDate });
      expect(out).toBe(canned);
    });

    it('end-to-end through the engine: anchorDate overrides the stored target; nothing is written', async () => {
      const { prisma, svc } = setup();

      // No anchorDate → the stored ZDT target (Tue 11-10) anchors the task.
      const stored = await svc.scheduleProjectDeliverableDryRun({ projectDeliverableId: PD_ID, zoneId: ZONE_ID });
      expect(stored.scheduled).toHaveLength(1);
      expect(stored.scheduled[0].taskId).toBe(1);
      expect(iso(stored.scheduled[0].endDate)).toBe('2026-11-10');

      // anchorDate → the hypothetical target (Tue 11-17) anchors it instead.
      const preview = await svc.scheduleProjectDeliverableDryRun({
        projectDeliverableId: PD_ID,
        zoneId: ZONE_ID,
        anchorDate: new Date(Date.UTC(2026, 10, 17)),
      });
      expect(iso(preview.scheduled[0].endDate)).toBe('2026-11-17');
      expect(iso(preview.scheduled[0].startDate)).toBe('2026-11-17');

      // Tasks were loaded for the resolved pair; dry-run never writes.
      // §12 (2026-11-14) · the zone filter is the target's SCOPE (zone +
      // sub-zones) — here the zone alone, it has no sub-zones.
      expect(prisma.task.findMany.mock.calls[0][0].where).toMatchObject({
        projectDeliverableId: PD_ID,
        zoneId: { in: [ZONE_ID] },
      });
      expect(prisma.task.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // §10 · Project resolution used by the controller's access check.
  describe('getProjectIdForProjectDeliverable', () => {
    function setup(row: { projectId: number } | null) {
      const { prisma } = makePrisma({
        tasks: [],
        deps: [],
        deliverable: { id: 1, targetDate: new Date(Date.UTC(2026, 10, 10)), zoneId: 1, projectDeliverableId: 1 },
      });
      prisma.projectDeliverable = { findFirst: jest.fn().mockResolvedValue(row) };
      return { prisma, svc: newService(prisma) };
    }

    it('returns the projectId of a live (non-soft-deleted) deliverable', async () => {
      const { prisma, svc } = setup({ projectId: 42 });

      await expect(svc.getProjectIdForProjectDeliverable(227)).resolves.toBe(42);
      expect(prisma.projectDeliverable.findFirst).toHaveBeenCalledWith({
        where: { id: 227, deletedAt: null },
        select: { projectId: true },
      });
    });

    it('throws NotFoundException when the deliverable does not exist', async () => {
      const { svc } = setup(null);

      await expect(svc.getProjectIdForProjectDeliverable(227)).rejects.toThrow(NotFoundException);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// §12 (2026-11-14) · project-shaped fixture for the specs below.
//
// `makePrisma` above answers every query with the whole fixture, which
// is right for a single (deliverable × zone) pair but cannot show WHICH
// tasks a target picks. This one is where-aware: a zone tree, several
// targets, tasks that carry their zone + deliverable, and Prisma mocks
// that filter the way the real queries do.
// ════════════════════════════════════════════════════════════════════
type ZoneFx = { id: number; parentId: number | null; name?: string };
type TargetFx = {
  id: number; // ZoneDeliverableTarget id
  zoneId: number | null;
  projectDeliverableId: number;
  targetDate: Date | null;
};
type ProjectTask = Task & {
  zoneId: number | null;
  projectDeliverableId: number;
  code: string;
  name: string;
};

function makeProjectTask(
  partial: Partial<ProjectTask> & { id: number; zoneId: number | null; projectDeliverableId: number },
): ProjectTask {
  return {
    ...makeTask(partial),
    code: `T-${partial.id}`,
    name: `Task ${partial.id}`,
    ...partial,
  } as ProjectTask;
}

const PROJECT_ID = 59;

function makeProjectPrisma(fx: {
  zones: ZoneFx[];
  targets: TargetFx[];
  tasks: ProjectTask[];
  deps?: Array<{ taskId: number; dependsOnId: number }>;
}) {
  const updates: Array<{ id: number; data: any }> = [];
  const zoneById = new Map(fx.zones.map((z) => [z.id, z]));
  const targetRow = (t: TargetFx) => ({
    id: t.id,
    zoneId: t.zoneId,
    projectDeliverableId: t.projectDeliverableId,
    targetDate: t.targetDate,
    projectDeliverable: {
      id: t.projectDeliverableId,
      name: `Deliverable ${t.projectDeliverableId}`,
      project: { id: PROJECT_ID, startDate: null },
    },
    zone:
      t.zoneId == null
        ? null
        : { id: t.zoneId, name: zoneById.get(t.zoneId)?.name ?? `Zone ${t.zoneId}`, projectId: PROJECT_ID },
  });
  // Prisma's `zoneId` filter shapes used by the service: a scalar, null,
  // or `{ in: [...] }`.
  const zoneMatches = (taskZoneId: number | null, cond: any): boolean => {
    if (cond === undefined) return true;
    if (cond === null) return taskZoneId === null;
    if (typeof cond === 'object') return taskZoneId !== null && cond.in.includes(taskZoneId);
    return taskZoneId === cond;
  };

  const prisma: any = {
    project: {
      findUnique: jest.fn().mockResolvedValue({ id: PROJECT_ID, name: 'Sandbox' }),
    },
    zone: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) =>
        where?.projectId === PROJECT_ID
          ? fx.zones.map((z) => ({ id: z.id, parentId: z.parentId }))
          : [],
      ),
    },
    zoneDeliverableTarget: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        const key = where?.zoneId_projectDeliverableId;
        if (key) {
          const hit = fx.targets.find(
            (t) => t.zoneId === key.zoneId && t.projectDeliverableId === key.projectDeliverableId,
          );
          return hit ? { id: hit.id } : null;
        }
        const hit = fx.targets.find((t) => t.id === where?.id);
        return hit ? targetRow(hit) : null;
      }),
      // Two callers: the scope lookup (`projectDeliverableId` + dated
      // only) and the project-wide loops (every target of the project).
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        let rows = fx.targets;
        if (where?.projectDeliverableId != null) {
          rows = rows.filter((t) => t.projectDeliverableId === where.projectDeliverableId);
        }
        if (where?.targetDate && 'not' in where.targetDate) {
          rows = rows.filter((t) => t.targetDate != null);
        }
        return rows.map(targetRow);
      }),
    },
    task: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where?.id?.in) return fx.tasks.filter((t) => where.id.in.includes(t.id));
        return fx.tasks.filter(
          (t) =>
            t.projectDeliverableId === where.projectDeliverableId &&
            zoneMatches(t.zoneId, where.zoneId),
        );
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
        return { ...fx.tasks.find((t) => t.id === where.id), ...data };
      }),
    },
    taskDependency: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) =>
        (fx.deps ?? [])
          .filter(
            (d) => where.taskId.in.includes(d.taskId) && where.dependsOnId.in.includes(d.dependsOnId),
          )
          .map((d) => ({ lag: 0, lagUnit: 'WORKING_DAYS', ...d })),
      ),
    },
    timeEntry: { groupBy: jest.fn().mockResolvedValue([]) },
    calendarDay: { findMany: jest.fn().mockResolvedValue([]) },
    hrSettings: { findFirst: jest.fn().mockResolvedValue({ weeklyRestDays: [5, 6] }) },
    workSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(prisma)),
  };
  return { prisma, updates, svc: newService(prisma) };
}

const ids = (scheduled: Array<{ taskId: number }>): number[] =>
  scheduled.map((s) => s.taskId).sort((a, b) => a - b);

// ════════════════════════════════════════════════════════════════════
// §12 (2026-11-14) · S1 — a target schedules its zone AND its sub-zones
//
// Staging shape: deliverable 230 targeted on top zone 693 "Building A";
// task BIM-021 lives in zone 695 "Level 1" (child of 693). The DP row
// for (230 × 693) lists it, but the exact `zoneId` match dropped it
// from the dry-run, the reschedule preview and the commit.
//
//   693 Building A ── 695 Level 1 ── 696 Wing
//                  └─ 697 Level 2
//   700 Building B
// ════════════════════════════════════════════════════════════════════
describe('SchedulerService — §12 · target scope covers sub-zones', () => {
  const PD = 230;
  const TUE_1110 = new Date(Date.UTC(2026, 10, 10)); // Tue 2026-11-10
  const TUE_1117 = new Date(Date.UTC(2026, 10, 17)); // Tue 2026-11-17
  const ZONES: ZoneFx[] = [
    { id: 693, parentId: null, name: 'Building A' },
    { id: 695, parentId: 693, name: 'Level 1' },
    { id: 696, parentId: 695, name: 'Wing' },
    { id: 697, parentId: 693, name: 'Level 2' },
    { id: 700, parentId: null, name: 'Building B' },
  ];
  // One assignee per task unless a spec says otherwise — resource
  // leveling must not blur what these specs are about.
  const assignee = (id: number) => [{ user: { id, dailyStandardHours: 8 } }];

  it('schedules tasks of descendant zones under the top-zone target (and nothing outside the sub-tree)', async () => {
    const { prisma, svc } = makeProjectPrisma({
      zones: ZONES,
      targets: [{ id: 501, zoneId: 693, projectDeliverableId: PD, targetDate: TUE_1110 }],
      tasks: [
        makeProjectTask({ id: 1, zoneId: 693, projectDeliverableId: PD, assignees: assignee(1) }),
        makeProjectTask({ id: 21, zoneId: 695, projectDeliverableId: PD, assignees: assignee(2) }), // BIM-021
        makeProjectTask({ id: 22, zoneId: 696, projectDeliverableId: PD, assignees: assignee(3) }), // grandchild
        makeProjectTask({ id: 98, zoneId: 695, projectDeliverableId: 231, assignees: assignee(4) }), // other deliverable
        makeProjectTask({ id: 99, zoneId: 700, projectDeliverableId: PD, assignees: assignee(5) }), // other top zone
      ],
    });

    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 501 });

    expect(ids(out.scheduled)).toEqual([1, 21, 22]);
    // No dependencies → all three are terminal and end on the target.
    for (const s of out.scheduled) expect(iso(s.endDate)).toBe('2026-11-10');
    // The task query carries the whole sub-tree of zone 693.
    expect(prisma.task.findMany.mock.calls[0][0].where).toMatchObject({
      projectDeliverableId: PD,
      zoneId: { in: [693, 695, 696, 697] },
    });

    // Same result through the (ProjectDeliverable × Zone) entry point
    // the Deliverable Planning preview picker uses.
    const viaPair = await svc.scheduleProjectDeliverableDryRun({ projectDeliverableId: PD, zoneId: 693 });
    expect(ids(viaPair.scheduled)).toEqual([1, 21, 22]);
  });

  it('a descendant zone with its own target is excluded and scheduled by that target — closest ancestor-or-self wins', async () => {
    const fixture = () => ({
      zones: ZONES,
      targets: [
        { id: 501, zoneId: 693, projectDeliverableId: PD, targetDate: TUE_1110 },
        { id: 502, zoneId: 695, projectDeliverableId: PD, targetDate: TUE_1117 }, // own target on Level 1
        // A row WITHOUT a target date (duration only) is not a target:
        // it cannot anchor anything, so it must not take Level 2 away
        // from the Building A target either.
        { id: 503, zoneId: 697, projectDeliverableId: PD, targetDate: null },
      ] as TargetFx[],
      tasks: [
        makeProjectTask({ id: 1, zoneId: 693, projectDeliverableId: PD, assignees: assignee(1) }),
        makeProjectTask({ id: 21, zoneId: 695, projectDeliverableId: PD, assignees: assignee(2) }),
        makeProjectTask({ id: 22, zoneId: 696, projectDeliverableId: PD, assignees: assignee(3) }), // under Level 1
        makeProjectTask({ id: 23, zoneId: 697, projectDeliverableId: PD, assignees: assignee(4) }), // Level 2
      ],
      // 21 (Level 1 scope) is a predecessor of 1 (Building A scope): the
      // edge crosses two targets, so neither schedule may use it.
      deps: [{ taskId: 1, dependsOnId: 21 }],
    });
    const { svc } = makeProjectPrisma(fixture());

    const top = await svc.scheduleDeliverableDryRun({ deliverableId: 501 });
    expect(ids(top.scheduled)).toEqual([1, 23]);
    for (const s of top.scheduled) expect(iso(s.endDate)).toBe('2026-11-10');

    const nested = await svc.scheduleDeliverableDryRun({ deliverableId: 502 });
    expect(ids(nested.scheduled)).toEqual([21, 22]); // its whole sub-tree, incl. zone 696
    // Anchored on ITS target — not chained in front of task 1's start.
    for (const s of nested.scheduled) expect(iso(s.endDate)).toBe('2026-11-17');

    const dateless = await svc.scheduleDeliverableDryRun({ deliverableId: 503 });
    expect(dateless.scheduled).toEqual([]);
    expect(dateless.feasibility.reason).toBe('no-anchor');

    // Project-wide: every task exactly once, with its own target's
    // dates — whatever order the targets come back in.
    const expected = { 1: '2026-11-10', 21: '2026-11-17', 22: '2026-11-17', 23: '2026-11-10' };
    for (const reverse of [false, true]) {
      const fx = fixture();
      if (reverse) fx.targets.reverse();
      const { svc: s2 } = makeProjectPrisma(fx);
      const { preview } = await s2.previewReschedule(PROJECT_ID);
      expect(preview).toHaveLength(4);
      expect(Object.fromEntries(preview.map((r) => [r.taskId, r.afterEnd]))).toEqual(expected);
    }
  });

  it('a null zone stays an exact match — only tasks with no zone, no tree lookup', async () => {
    const { prisma, svc } = makeProjectPrisma({
      zones: ZONES,
      // The schema does not allow a zone-less ZDT; the engine still
      // treats one defensively and this pins what it does with it.
      targets: [{ id: 510, zoneId: null, projectDeliverableId: PD, targetDate: TUE_1110 }],
      tasks: [
        makeProjectTask({ id: 5, zoneId: null, projectDeliverableId: PD, assignees: assignee(1) }),
        makeProjectTask({ id: 6, zoneId: 693, projectDeliverableId: PD, assignees: assignee(2) }),
      ],
    });

    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 510 });

    expect(ids(out.scheduled)).toEqual([5]);
    expect(prisma.task.findMany.mock.calls[0][0].where.zoneId).toBeNull();
    expect(prisma.zone.findMany).not.toHaveBeenCalled();
    expect(prisma.zoneDeliverableTarget.findMany).not.toHaveBeenCalled();
  });

  it('a dependency between tasks of two zones inside the scope is an in-scope edge', async () => {
    // 21 (Level 1, 1 wd) → 1 (Building A, 2 wd). Anchor Tue 11-10.
    //   task 1 : end Tue 11-10, start Mon 11-09 (2 wd inclusive).
    //   task 21: end = prevWorkingDay(Mon 11-09) = Sun 11-08, start Sun 11-08.
    const { prisma, svc } = makeProjectPrisma({
      zones: ZONES,
      targets: [{ id: 501, zoneId: 693, projectDeliverableId: PD, targetDate: TUE_1110 }],
      tasks: [
        makeProjectTask({ id: 1, zoneId: 693, projectDeliverableId: PD, budgetHours: 16, assignees: assignee(1) }),
        makeProjectTask({ id: 21, zoneId: 695, projectDeliverableId: PD, budgetHours: 8, assignees: assignee(2) }),
      ],
      deps: [{ taskId: 1, dependsOnId: 21 }],
    });

    const out = await svc.scheduleDeliverableDryRun({ deliverableId: 501 });
    const byId = new Map(out.scheduled.map((s) => [s.taskId, s]));

    expect(iso(byId.get(1)!.endDate)).toBe('2026-11-10');
    expect(iso(byId.get(1)!.startDate)).toBe('2026-11-09');
    // Without the edge task 21 would be terminal and end on the anchor.
    expect(iso(byId.get(21)!.endDate)).toBe('2026-11-08');
    expect(iso(byId.get(21)!.startDate)).toBe('2026-11-08');
    expect(prisma.taskDependency.findMany.mock.calls[0][0].where).toEqual({
      taskId: { in: [1, 21] },
      dependsOnId: { in: [1, 21] },
    });
  });

  it('the commit paths write the sub-zone task — once, from its own target', async () => {
    const fixture = () => ({
      zones: ZONES,
      targets: [
        { id: 501, zoneId: 693, projectDeliverableId: PD, targetDate: TUE_1110 },
        { id: 502, zoneId: 697, projectDeliverableId: PD, targetDate: TUE_1117 },
      ] as TargetFx[],
      tasks: [
        makeProjectTask({ id: 1, zoneId: 693, projectDeliverableId: PD, assignees: assignee(1) }),
        makeProjectTask({ id: 21, zoneId: 695, projectDeliverableId: PD, assignees: assignee(2) }),
        makeProjectTask({ id: 23, zoneId: 697, projectDeliverableId: PD, assignees: assignee(3) }),
      ],
    });

    // Project-wide "Save & update due dates".
    const a = makeProjectPrisma(fixture());
    const res = await a.svc.saveAndUpdateDueDates(PROJECT_ID, 7);
    expect(res.requiresReview).toEqual([]);
    expect([...res.autoApplied].sort((x, y) => x.taskId - y.taskId)).toEqual([
      { taskId: 1, newStart: '2026-11-10', newEnd: '2026-11-10' },
      { taskId: 21, newStart: '2026-11-10', newEnd: '2026-11-10' }, // Level 1 → Building A target
      { taskId: 23, newStart: '2026-11-17', newEnd: '2026-11-17' }, // Level 2 → its own target
    ]);
    expect(a.updates.map((u) => u.id).sort((x, y) => x - y)).toEqual([1, 21, 23]);

    // Single-target commit (`POST deliverables/:id/schedule/commit`).
    const b = makeProjectPrisma(fixture());
    await b.svc.scheduleDeliverableAndCommit({ deliverableId: 501 }, 7);
    expect(b.updates.map((u) => u.id).sort((x, y) => x - y)).toEqual([1, 21]);
    expect(iso(b.updates.find((u) => u.id === 21)!.data.endDate)).toBe('2026-11-10');
  });

  it('the overload scan sees a sub-zone task and reports it under the target (DP row) zone', async () => {
    // Today (pinned) = Tue 2026-10-27 = the target day. Two full-day
    // tasks for the SAME assignee: the first fills the day, the second
    // has no runway left before "today" → overload. The second lives in
    // the sub-zone, so before §12 it was not even loaded.
    const today = new Date(Date.UTC(2026, 9, 27));
    const { svc } = makeProjectPrisma({
      zones: ZONES,
      targets: [{ id: 501, zoneId: 693, projectDeliverableId: PD, targetDate: today }],
      tasks: [
        makeProjectTask({ id: 1, zoneId: 693, projectDeliverableId: PD, budgetHours: 8, assignees: assignee(1) }),
        makeProjectTask({ id: 21, zoneId: 695, projectDeliverableId: PD, budgetHours: 8, assignees: assignee(1) }),
      ],
    });

    const res = await svc.scanProjectOverload(PROJECT_ID);

    expect(res.flaggedTasks).toHaveLength(1);
    expect(res.flaggedTasks[0]).toMatchObject({
      taskId: 21,
      infeasibleReason: 'overload',
      deliverableId: 501,
      zoneId: 693,
      zoneName: 'Building A',
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// §12 (2026-11-14) · S2 — a manually-overridden task with no usable
// stored start
//
// The backward pass used `estimatedStartDate ?? startDate ?? anchor`, so
// a manual task with no stored start "started" on the anchor — after its
// own end — and its predecessors were chained from there. Rows whose
// stored start is after their stored end (left by an end-only edit) had
// the same effect.
// ════════════════════════════════════════════════════════════════════
describe('SchedulerService — §12 · override-skipped task without a usable stored start', () => {
  const TUE_1110 = new Date(Date.UTC(2026, 10, 10)); // Tue 2026-11-10
  const WED_1104 = new Date(Date.UTC(2026, 10, 4)); // Wed 2026-11-04

  // Chain 1 → 2 (manual) → 3, anchor Tue 11-10. Task 2 is 2 wd.
  async function runChain(override: Partial<Task>) {
    const { prisma } = makePrisma({
      tasks: [
        makeTask({ id: 1, budgetHours: 8 }),
        makeTask({ id: 2, budgetHours: 16, dueDateOverridden: true, ...override }),
        makeTask({ id: 3, budgetHours: 16 }),
      ],
      deps: [
        { taskId: 2, dependsOnId: 1 },
        { taskId: 3, dependsOnId: 2 },
      ],
      deliverable: { id: 30, targetDate: TUE_1110, zoneId: 1, projectDeliverableId: 30 },
    });
    const out = await newService(prisma).scheduleDeliverableDryRun({ deliverableId: 30 });
    return new Map(out.scheduled.map((s) => [s.taskId, s]));
  }

  it('no stored start → start is derived from the stored end, never the anchor; the predecessor chains from it', async () => {
    const byId = await runChain({ estimatedStartDate: null, startDate: null, endDate: WED_1104 });

    // Task 2: end stays the stored Wed 11-04; start = walk 2 wd back
    // (inclusive) → Tue 11-03. The old code put the start on 11-10.
    expect(byId.get(2)!.skippedByOverride).toBe(true);
    expect(iso(byId.get(2)!.endDate)).toBe('2026-11-04');
    expect(iso(byId.get(2)!.startDate)).toBe('2026-11-03');

    // Task 1 (1 wd): end = prevWorkingDay(Tue 11-03) = Mon 11-02. Chained
    // from the anchor-as-start it would have ended on Mon 11-09.
    expect(iso(byId.get(1)!.endDate)).toBe('2026-11-02');
    expect(iso(byId.get(1)!.startDate)).toBe('2026-11-02');

    // Task 3 is untouched by any of this.
    expect(iso(byId.get(3)!.endDate)).toBe('2026-11-10');
    expect(iso(byId.get(3)!.startDate)).toBe('2026-11-09');

    // Invariant: nothing the engine emits starts after it ends.
    for (const s of byId.values()) {
      expect(s.startDate.getTime()).toBeLessThanOrEqual(s.endDate.getTime());
    }
  });

  it('a stored start that is AFTER the stored end is treated like a missing start', async () => {
    // The staging rows: an end-only edit pulled the due date before the
    // estimated start (e.g. start 2027-01-25 / end 2027-01-11).
    const byId = await runChain({
      estimatedStartDate: new Date(Date.UTC(2026, 10, 9)), // Mon 11-09 — after the end
      endDate: WED_1104,
    });

    expect(iso(byId.get(2)!.endDate)).toBe('2026-11-04');
    expect(iso(byId.get(2)!.startDate)).toBe('2026-11-03'); // derived, not 11-09
    expect(iso(byId.get(1)!.endDate)).toBe('2026-11-02'); // chained from the derived start
  });

  it('a usable stored start is still preferred over deriving — the estimate, else the actual start', async () => {
    // Estimate on/before the end → used as-is (unchanged behaviour).
    const kept = await runChain({
      estimatedStartDate: new Date(Date.UTC(2026, 10, 2)), // Mon 11-02
      endDate: WED_1104,
    });
    expect(iso(kept.get(2)!.startDate)).toBe('2026-11-02');
    expect(iso(kept.get(1)!.endDate)).toBe('2026-11-01'); // prevWorkingDay(Mon 11-02) = Sun 11-01

    // Estimate after the end, actual start usable → the actual start,
    // exactly as a missing estimate already fell through to it.
    const actual = await runChain({
      estimatedStartDate: new Date(Date.UTC(2026, 10, 9)),
      startDate: new Date(Date.UTC(2026, 10, 2)),
      endDate: WED_1104,
    });
    expect(iso(actual.get(2)!.startDate)).toBe('2026-11-02');
  });

  it('derived start is on or before the end even when the manual end is a rest day', async () => {
    // Manual end on Fri 11-06 (rest day), 1 wd, no stored start →
    // start snaps back to Thu 11-05.
    const byId = await runChain({
      budgetHours: 8,
      estimatedStartDate: null,
      startDate: null,
      endDate: new Date(Date.UTC(2026, 10, 6)),
    });
    expect(iso(byId.get(2)!.endDate)).toBe('2026-11-06');
    expect(iso(byId.get(2)!.startDate)).toBe('2026-11-05');
  });

  // ─── preview / commit coherence ─────────────────────────────────────
  //
  // Zone 9, deliverable 40, anchor Tue 11-10. 31 → 32 (31 precedes 32).
  //   31: ordinary task, nothing stored            → will move.
  //   32: manual, end Wed 11-04, NO stored start   → skipped.
  //   33: manual, start Mon 11-09 / end Wed 11-04  → skipped (bad row).
  function coherenceFixture() {
    const one = (id: number) => [{ user: { id, dailyStandardHours: 8 } }];
    return makeProjectPrisma({
      zones: [{ id: 9, parentId: null, name: 'Zone 9' }],
      targets: [{ id: 601, zoneId: 9, projectDeliverableId: 40, targetDate: TUE_1110 }],
      tasks: [
        makeProjectTask({ id: 31, zoneId: 9, projectDeliverableId: 40, budgetHours: 8, assignees: one(1) }),
        makeProjectTask({
          id: 32,
          zoneId: 9,
          projectDeliverableId: 40,
          budgetHours: 16,
          dueDateOverridden: true,
          estimatedStartDate: null,
          endDate: WED_1104,
          assignees: one(2),
        }),
        makeProjectTask({
          id: 33,
          zoneId: 9,
          projectDeliverableId: 40,
          budgetHours: 8,
          dueDateOverridden: true,
          estimatedStartDate: new Date(Date.UTC(2026, 10, 9)),
          endDate: WED_1104,
          assignees: one(3),
        }),
      ],
      deps: [{ taskId: 32, dependsOnId: 31 }],
    });
  }

  it('previewReschedule: a skipped task does not move and its "after" dates are its stored dates', async () => {
    const { svc } = coherenceFixture();

    const { preview, projectSummary } = await svc.previewReschedule(PROJECT_ID);
    const byId = new Map(preview.map((r) => [r.taskId, r]));

    // 32 — stored start is null and STAYS null; no invented dates.
    expect(byId.get(32)).toMatchObject({
      skippedByOverride: true,
      willMove: false,
      beforeStart: null,
      afterStart: null,
      beforeEnd: '2026-11-04',
      afterEnd: '2026-11-04',
      delta: { startDays: null, endDays: 0 },
    });
    // 33 — the inverted stored pair is reported as stored, not "fixed".
    expect(byId.get(33)).toMatchObject({
      skippedByOverride: true,
      willMove: false,
      afterStart: '2026-11-09',
      afterEnd: '2026-11-04',
      delta: { startDays: 0, endDays: 0 },
    });
    // 31 — moves, and is chained from 32's DERIVED start (Tue 11-03):
    // end = prevWorkingDay(11-03) = Mon 11-02.
    expect(byId.get(31)).toMatchObject({
      skippedByOverride: false,
      willMove: true,
      afterStart: '2026-11-02',
      afterEnd: '2026-11-02',
    });
    expect(projectSummary.movedTasks).toBe(1);
  });

  it('saveAndUpdateDueDates agrees with the preview: skipped tasks are never written, approved or not', async () => {
    // Preview-approved path — even with the manual rows ticked.
    const approved = coherenceFixture();
    const res = await approved.svc.saveAndUpdateDueDates(PROJECT_ID, 7, { taskIds: [31, 32, 33] });
    expect(res.autoApplied).toEqual([{ taskId: 31, newStart: '2026-11-02', newEnd: '2026-11-02' }]);
    expect(approved.updates.map((u) => u.id)).toEqual([31]);

    // Unfiltered path — the manual rows go to the review list instead.
    const plain = coherenceFixture();
    const res2 = await plain.svc.saveAndUpdateDueDates(PROJECT_ID, 7);
    expect(res2.autoApplied.map((a) => a.taskId)).toEqual([31]);
    expect(res2.requiresReview.map((r) => [r.taskId, r.reason, r.currentEnd, r.proposedEnd])).toEqual([
      [32, 'manual', '2026-11-04', '2026-11-04'],
      [33, 'manual', '2026-11-04', '2026-11-04'],
    ]);
    expect(plain.updates.map((u) => u.id)).toEqual([31]);
  });
});
