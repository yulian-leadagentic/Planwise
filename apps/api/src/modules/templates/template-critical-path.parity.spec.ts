/**
 * BM2-30 (QA6, 2026-11-25) — parity between the Deliverable Template
 * "Fastest" value and the project scheduler.
 *
 * The template screen's Fastest chip is the critical-path length of the
 * template's predecessor graph. The acceptance rule is that it equals
 * what the project scheduler (D1-Lag / D7 forward pass) computes for the
 * same tasks and edges. Each fixture below runs through BOTH:
 *
 *   • `computeFastestWorkingDays(tasks, edges)` — the template value, and
 *   • `SchedulerService.scheduleDeliverableDryRun` on a mocked project
 *     whose tasks / dependencies are the same graph (unassigned, so the
 *     scheduler sizes them with its default 8h day), default calendar
 *     (Fri + Sat rest, no holidays), project start on a Sunday. The
 *     forward pass's `earliestForwardFinish` is turned back into a
 *     working-day count from the project start, inclusive.
 *
 * The two numbers must be identical.
 */
import { SchedulerService } from '../scheduling/scheduler.service';
import { ExecutionPlanningService } from '../execution-planning/execution-planning.service';
import { computeFastestWorkingDays, type SwdEdge, type SwdTask } from './templates.service';

type LagUnit = 'WORKING_DAYS' | 'CALENDAR_DAYS';
interface Fixture {
  name: string;
  tasks: SwdTask[];
  edges: SwdEdge[];
}

// "Today" is pinned before the project start so the forward pass runs
// from the project start (max(projectStart, today)).
const TODAY = new Date('2026-10-27T09:00:00.000Z');
// Sunday 2027-01-03 — first working day of an Israeli work week.
const PROJECT_START = new Date(Date.UTC(2027, 0, 3));
// Far anchor: the backward pass never constrains the forward finish.
const TARGET = new Date(Date.UTC(2027, 11, 30));

beforeAll(() => {
  jest.useFakeTimers({
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  jest.setSystemTime(TODAY);
});
afterAll(() => {
  jest.useRealTimers();
});

function schedulerFor(fx: Fixture): SchedulerService {
  const prisma: any = {
    zoneDeliverableTarget: {
      findUnique: jest.fn().mockResolvedValue({
        id: 1,
        targetDate: TARGET,
        zoneId: 10,
        projectDeliverableId: 100,
        projectDeliverable: { project: { id: 1, startDate: PROJECT_START } },
        zone: { id: 10, projectId: 1 },
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    zone: { findMany: jest.fn().mockResolvedValue([]) },
    task: {
      findMany: jest.fn().mockResolvedValue(
        fx.tasks.map((t) => ({
          id: t.id,
          budgetHours: t.budgetHours ?? null,
          estimatedStartDate: null,
          startDate: null,
          endDate: null,
          dueDateOverridden: false,
          assignees: [],
        })),
      ),
      update: jest.fn(),
    },
    taskDependency: {
      findMany: jest.fn().mockResolvedValue(
        fx.edges.map((e) => ({
          taskId: e.templateTaskId,
          dependsOnId: e.dependsOnTemplateTaskId,
          lag: e.lag ?? 0,
          lagUnit: (e.lagUnit ?? 'WORKING_DAYS') as LagUnit,
        })),
      ),
    },
    calendarDay: { findMany: jest.fn().mockResolvedValue([]) },
    hrSettings: { findFirst: jest.fn().mockResolvedValue({ weeklyRestDays: [5, 6] }) },
    workSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(),
  };
  const eps = new ExecutionPlanningService({} as any, {} as any);
  return new SchedulerService(prisma, eps);
}

function workingDaysInclusive(from: Date, to: Date): number {
  let n = 0;
  const c = new Date(from.getTime());
  while (c.getTime() <= to.getTime()) {
    const dow = c.getUTCDay();
    if (dow !== 5 && dow !== 6) n++;
    c.setUTCDate(c.getUTCDate() + 1);
  }
  return n;
}

async function schedulerCriticalPathDays(fx: Fixture): Promise<number> {
  const out = await schedulerFor(fx).scheduleDeliverableDryRun({ deliverableId: 1 } as any);
  const finish = out.feasibility.earliestForwardFinish;
  if (!finish) throw new Error(`scheduler returned no forward finish for ${fx.name}`);
  return workingDaysInclusive(PROJECT_START, finish);
}

const h = (id: number, budgetHours: number | null): SwdTask => ({ id, budgetHours });
const dep = (succ: number, pred: number, lag = 0, lagUnit: LagUnit = 'WORKING_DAYS'): SwdEdge => ({
  templateTaskId: succ,
  dependsOnTemplateTaskId: pred,
  lag,
  lagUnit,
});

const FIXTURES: Array<Fixture & { expected: number }> = [
  {
    name: 'QA6 report: CRD-036 waits 7 working days after CRD-002',
    tasks: [h(2, 1), h(36, 1)],
    edges: [dep(36, 2, 7)],
    expected: 9,
  },
  {
    name: 'template 41 "תיאום ראשוני": 002 → 021 (+7 wd) → 036 (+7 cal)',
    tasks: [h(2, 1), h(21, 1), h(36, 1)],
    edges: [dep(21, 2, 7), dep(36, 21, 7, 'CALENDAR_DAYS')],
    expected: 15,
  },
  {
    name: 'linear chain 3 × 8h, no lag',
    tasks: [h(1, 8), h(2, 8), h(3, 8)],
    edges: [dep(2, 1), dep(3, 2)],
    expected: 3,
  },
  {
    name: 'diamond with a calendar wait on one branch',
    tasks: [h(1, 16), h(2, 8), h(3, 24), h(4, 4)],
    edges: [dep(2, 1, 5, 'CALENDAR_DAYS'), dep(3, 1), dep(4, 2), dep(4, 3, 1)],
    expected: 7,
  },
  {
    name: 'multi-day tasks crossing a weekend, mixed lags, a task without hours',
    tasks: [h(1, 20), h(2, null), h(3, 40), h(4, 12), h(5, 3)],
    edges: [dep(2, 1, 2), dep(3, 1, 3, 'CALENDAR_DAYS'), dep(4, 2), dep(4, 3), dep(5, 4, 6, 'CALENDAR_DAYS')],
    expected: 17,
  },
  {
    name: 'no edges: the longest single task',
    tasks: [h(1, 4), h(2, 30), h(3, 8)],
    edges: [],
    expected: 4,
  },
];

describe('BM2-30 · template Fastest = scheduler critical path', () => {
  it.each(FIXTURES)('$name', async (fx) => {
    const template = computeFastestWorkingDays(fx.tasks, fx.edges);
    const scheduler = await schedulerCriticalPathDays(fx);
    expect(template).toBe(scheduler);
    expect(template).toBe(fx.expected);
  });
});
