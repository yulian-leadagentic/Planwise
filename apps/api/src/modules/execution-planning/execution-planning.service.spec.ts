/**
 * FEAS-1 (incident 2026-10-07) — smoke tests for the two CPU-bound
 * helpers that wedged `/projects/:id/feasibility` on far-future
 * endDates and cyclic task dependencies.
 *
 * These are intentionally scoped: they prove the loops are bounded
 * (closed-form `countWorkingDays`) and the DFS has cycle detection.
 * Full feasibility coverage lives in integration tests.
 */
import { ExecutionPlanningService, isBlockingPredecessor } from './execution-planning.service';

describe('ExecutionPlanningService — FEAS-1 hardening', () => {
  // Construct with stub deps; we only call the private helpers via
  // reflection so prisma / access are never dereferenced.
  const svc = new ExecutionPlanningService({} as any, {} as any);

  describe('countWorkingDays — bounded under far-future endDates', () => {
    it('completes in <100ms for a ~8000-year span with no holidays', () => {
      const from = new Date('2026-01-01T00:00:00.000Z');
      const to = new Date('9999-12-31T00:00:00.000Z');
      const t0 = Date.now();
      const result = (svc as any).countWorkingDays(from, to, new Set());
      const ms = Date.now() - t0;
      expect(ms).toBeLessThan(100);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThan(0);
      // Fri+Sat (Israel week) off → ~5/7 of ~2.9M days.
      expect(result).toBeGreaterThan(2_000_000);
      expect(result).toBeLessThan(2_300_000);
    });

    it('matches reference day-stepping on a short, holiday-ful range', () => {
      const from = new Date('2026-01-01T00:00:00.000Z');
      const to = new Date('2026-03-31T00:00:00.000Z');
      const holidays = new Set<string>([
        '2026-01-05', // weekday
        '2026-01-10', // Saturday — must NOT double-subtract
        '2026-02-15', // weekday
      ]);
      const got = (svc as any).countWorkingDays(from, to, holidays);

      // Reference impl — the pre-FEAS-1 loop, for parity.
      let ref = 0;
      const cur = new Date(from);
      while (cur <= to) {
        const d = cur.getDay();
        const key = cur.toISOString().split('T')[0];
        if (d !== 5 && d !== 6 && !holidays.has(key)) ref++;
        cur.setDate(cur.getDate() + 1);
      }
      expect(got).toBe(ref);
    });

    it('returns 0 when from > to', () => {
      expect(
        (svc as any).countWorkingDays(new Date('2026-06-01'), new Date('2026-05-01'), new Set()),
      ).toBe(0);
    });
  });

  describe('calculateCriticalPath — cycle detection', () => {
    it('does not stack-overflow on a 2-task cycle A→B→A', () => {
      const tasks = [
        { id: 1, budgetHours: 8, dependencies: [{ dependsOnId: 2 }] },
        { id: 2, budgetHours: 8, dependencies: [{ dependsOnId: 1 }] },
      ];
      const out = (svc as any).calculateCriticalPath(tasks);
      expect(out).toBeDefined();
      expect(Number.isFinite(out.days)).toBe(true);
      expect(out.cycleIds.length).toBeGreaterThan(0);
    });

    it('handles a 3-task cycle A→B→C→A', () => {
      const tasks = [
        { id: 1, budgetHours: 8, dependencies: [{ dependsOnId: 2 }] },
        { id: 2, budgetHours: 8, dependencies: [{ dependsOnId: 3 }] },
        { id: 3, budgetHours: 8, dependencies: [{ dependsOnId: 1 }] },
      ];
      const out = (svc as any).calculateCriticalPath(tasks);
      expect(Number.isFinite(out.days)).toBe(true);
      expect(out.cycleIds.length).toBeGreaterThan(0);
    });

    it('still computes a correct longest path on acyclic input', () => {
      // A(8h) → B(16h) → C(8h) ; D(32h) standalone.
      // Longest = D standalone (4d) vs chain (8+16+8 = 32h = 4d). Tie, cp = 4.
      const tasks = [
        { id: 1, budgetHours: 8, dependencies: [] },
        { id: 2, budgetHours: 16, dependencies: [{ dependsOnId: 1 }] },
        { id: 3, budgetHours: 8, dependencies: [{ dependsOnId: 2 }] },
        { id: 4, budgetHours: 32, dependencies: [] },
      ];
      const out = (svc as any).calculateCriticalPath(tasks);
      expect(out.cycleIds).toEqual([]);
      expect(out.days).toBe(4);
    });
  });

  describe('daysBetween — clamped to 100 years', () => {
    it('does not propagate absurd values beyond 100 years', () => {
      const result = (svc as any).daysBetween(
        new Date('2026-01-01'),
        new Date('9999-12-31'),
      );
      expect(result).toBe(365 * 100);
    });
  });
});

// ─── Soft-deleted / cancelled predecessors never block (2026-11-19) ───
//
// Task delete is a soft delete (status → cancelled, deletedAt set) and
// keeps its TaskDependency rows so a restore brings the edges back. A
// deleted predecessor used to block its successor forever (its status is
// never `completed`), which could push a project to AT_RISK.
describe('ExecutionPlanningService — deleted / cancelled predecessors', () => {
  const LIVE_PREDECESSOR = { dependsOn: { deletedAt: null } };

  describe('isBlockingPredecessor', () => {
    it('blocks only for a live predecessor that is neither completed nor cancelled', () => {
      expect(isBlockingPredecessor({ status: 'in_progress', deletedAt: null })).toBe(true);
      expect(isBlockingPredecessor({ status: 'not_started' })).toBe(true);
      expect(isBlockingPredecessor({ status: 'completed', deletedAt: null })).toBe(false);
      expect(isBlockingPredecessor({ status: 'cancelled', deletedAt: null })).toBe(false);
      expect(isBlockingPredecessor({ status: 'cancelled', deletedAt: new Date() })).toBe(false);
      expect(isBlockingPredecessor({ status: 'in_progress', deletedAt: new Date() })).toBe(false);
      expect(isBlockingPredecessor(null)).toBe(false);
      expect(isBlockingPredecessor(undefined)).toBe(false);
    });
  });

  it('feasibility — only a live, unfinished predecessor marks a task blocked; edges to deleted tasks are not loaded', async () => {
    // Four open tasks, each with one predecessor of a different kind.
    // The mock returns every edge, as if the DB ignored the filter, so
    // the in-code guard is exercised too.
    const task = (id: number, dependsOn: any) => ({
      id,
      name: `T${id}`,
      budgetHours: 0,
      assignees: [],
      dependencies: [{ dependsOnId: dependsOn.id, dependsOn }],
    });
    const tasks = [
      task(1, { id: 101, status: 'in_progress', deletedAt: null, endDate: null }), // blocks
      task(2, { id: 102, status: 'cancelled', deletedAt: new Date(), endDate: null }), // deleted
      task(3, { id: 103, status: 'cancelled', deletedAt: null, endDate: null }), // cancelled
      task(4, { id: 104, status: 'completed', deletedAt: null, endDate: null }), // done
    ];
    const prisma: any = {
      project: { findUniqueOrThrow: jest.fn(async () => ({ id: 59, name: 'P', endDate: null, budget: null })) },
      task: { findMany: jest.fn(async () => tasks) },
      timeEntry: { groupBy: jest.fn(async () => []) },
    };
    const svc = new ExecutionPlanningService(prisma, {} as any);

    const out: any = await svc.calculateFeasibility(59);

    expect(out.isComputable).toBeUndefined(); // computed, not the error fallback
    expect(out.details.blockedTasks).toEqual([{ taskId: 1, title: 'T1', blockedBy: ['Task #101'] }]);
    // 1 of 4 blocked (25%) — under the 30% AT_RISK threshold. With the old
    // rule 3 of 4 were "blocked" and the project read AT_RISK.
    expect(out.status).toBe('OK');
    const include = prisma.task.findMany.mock.calls[0][0].include;
    expect(include.dependencies.where).toEqual(LIVE_PREDECESSOR);
  });

  it('operations dashboard — a deleted or cancelled predecessor does not count a task as blocked', async () => {
    const live = { id: 201, status: 'in_progress', deletedAt: null };
    const openTask = (id: number, dependsOn: any) => ({
      id,
      code: `T-${id}`,
      name: `T${id}`,
      projectId: 59,
      endDate: null,
      budgetHours: 0,
      priority: 'medium',
      status: 'not_started',
      assignees: [],
      project: { id: 59, name: 'P', number: '1' },
      zone: null,
      serviceType: null,
      dependencies: [{ dependsOnId: dependsOn.id, dependsOn }],
    });
    const allTasks = [
      openTask(1, live),
      openTask(2, { id: 202, status: 'cancelled', deletedAt: new Date() }),
      openTask(3, { id: 203, status: 'cancelled', deletedAt: null }),
    ];
    const prisma: any = {
      user: { findUnique: jest.fn(async () => ({ orgUnitId: null, orgUnit: null })), findMany: jest.fn(async () => []) },
      project: { findMany: jest.fn(async () => [{ id: 59, name: 'P', number: '1', budget: 0, endDate: null, leader: null, department: null }]) },
      task: {
        findMany: jest.fn().mockResolvedValueOnce(allTasks).mockResolvedValueOnce([]),
        aggregate: jest.fn(async () => ({ _sum: { budgetAmount: 0, budgetHours: 0 }, _count: 0 })),
      },
      timeEntry: { aggregate: jest.fn(async () => ({ _sum: { minutes: 0 } })), groupBy: jest.fn(async () => []) },
      taskAssignee: { groupBy: jest.fn(async () => []) },
    };
    const access: any = { getAccessibleProjectIds: jest.fn(async () => ({ all: true, projectIds: [] })) };
    const svc = new ExecutionPlanningService(prisma, access);

    const out: any = await svc.getOperationsDashboard({ id: 42, isAdmin: true });

    expect(out.summary.totalBlocked).toBe(1);
    expect(prisma.task.findMany.mock.calls[0][0].include.dependencies.where).toEqual(LIVE_PREDECESSOR);
  });
});
