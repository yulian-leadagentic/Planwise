/**
 * FEAS-1 (incident 2026-10-07) — smoke tests for the two CPU-bound
 * helpers that wedged `/projects/:id/feasibility` on far-future
 * endDates and cyclic task dependencies.
 *
 * These are intentionally scoped: they prove the loops are bounded
 * (closed-form `countWorkingDays`) and the DFS has cycle detection.
 * Full feasibility coverage lives in integration tests.
 */
import { ExecutionPlanningService } from './execution-planning.service';

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
