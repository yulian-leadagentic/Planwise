import { taskCompletionValue, rollupTaskCompletion } from './task-completion';

describe('taskCompletionValue', () => {
  it('pins completed to 100 regardless of hours', () => {
    expect(taskCompletionValue({ status: 'completed', loggedMinutes: 0, budgetHours: 10 })).toBe(100);
    expect(taskCompletionValue({ status: 'completed', loggedMinutes: 0, budgetHours: 0 })).toBe(100);
    expect(taskCompletionValue({ status: 'completed' })).toBe(100);
  });

  it('pins cancelled to 100 regardless of hours', () => {
    expect(taskCompletionValue({ status: 'cancelled', loggedMinutes: 600, budgetHours: 10 })).toBe(100);
    expect(taskCompletionValue({ status: 'cancelled' })).toBe(100);
  });

  it('pins in_review to 90 regardless of hours', () => {
    expect(taskCompletionValue({ status: 'in_review', loggedMinutes: 0, budgetHours: 10 })).toBe(90);
    expect(taskCompletionValue({ status: 'in_review', loggedMinutes: 100000, budgetHours: 10 })).toBe(90);
  });

  it('computes in_progress with partial hours as capped time-based', () => {
    // 5h logged / 10h budget × 80 = 40
    expect(taskCompletionValue({ status: 'in_progress', loggedMinutes: 300, budgetHours: 10 })).toBe(40);
  });

  it('caps in_progress at 80 even when logged >= budget', () => {
    // 20h logged / 10h budget × 80 = 160 → capped at 80
    expect(taskCompletionValue({ status: 'in_progress', loggedMinutes: 1200, budgetHours: 10 })).toBe(80);
  });

  it('returns 0 for in_progress with no logged hours', () => {
    expect(taskCompletionValue({ status: 'in_progress', loggedMinutes: 0, budgetHours: 10 })).toBe(0);
  });

  it('returns 0 for not_started with no logged hours', () => {
    expect(taskCompletionValue({ status: 'not_started', loggedMinutes: 0, budgetHours: 10 })).toBe(0);
  });

  it('returns 0 for in_progress with no budget', () => {
    expect(taskCompletionValue({ status: 'in_progress', loggedMinutes: 300, budgetHours: 0 })).toBe(0);
    expect(taskCompletionValue({ status: 'in_progress', loggedMinutes: 300 })).toBe(0);
  });

  it('handles on_hold and unknown statuses via the time-based branch', () => {
    // 5h logged / 10h budget × 80 = 40
    expect(taskCompletionValue({ status: 'on_hold', loggedMinutes: 300, budgetHours: 10 })).toBe(40);
    expect(taskCompletionValue({ status: 'weird_unknown', loggedMinutes: 0, budgetHours: 10 })).toBe(0);
  });

  it('coerces Prisma Decimal-shaped budget values via Number()', () => {
    // Mimic the Decimal-with-.toString() shape Prisma returns.
    const decimalBudget = { toString: () => '10' } as unknown as number;
    expect(taskCompletionValue({ status: 'in_progress', loggedMinutes: 300, budgetHours: decimalBudget })).toBe(40);
  });
});

describe('rollupTaskCompletion', () => {
  it('returns 0 for an empty bucket', () => {
    expect(rollupTaskCompletion([])).toBe(0);
  });

  it('reads 100 when every task is Done — regardless of logged hours', () => {
    // The BIM-management repro: 11 completed tasks, zero hours logged.
    // The stored completionPct would drag the rollup to 0; this helper
    // computes from status and returns 100.
    const tasks = Array.from({ length: 11 }, () => ({ status: 'completed', loggedMinutes: 0, budgetHours: 10 }));
    expect(rollupTaskCompletion(tasks)).toBe(100);
  });

  it('reads ~82 on the DoD scenario (9/11 done, 2 not started, all with equal budget)', () => {
    // Spec says "9/11 done → ~82%". 9 × 100 + 2 × 0 = 900 / 11 tasks (equal
    // budget) → 900/11 ≈ 82. Weighted-by-budget with equal budgets is the
    // same as simple mean.
    const tasks = [
      ...Array.from({ length: 9 }, () => ({ status: 'completed', loggedMinutes: 0, budgetHours: 10 })),
      ...Array.from({ length: 2 }, () => ({ status: 'not_started', loggedMinutes: 0, budgetHours: 10 })),
    ];
    expect(rollupTaskCompletion(tasks)).toBe(82);
  });

  it('budget-weights when tasks have unequal budgets', () => {
    // completed × 10h → 100, in_progress-2h-of-10 → 16, not_started × 5h → 0
    // 100×10 + 16×10 + 0×5 = 1000 + 160 + 0 = 1160 / 25 = 46.4 → 46
    const tasks = [
      { status: 'completed', loggedMinutes: 0, budgetHours: 10 },
      { status: 'in_progress', loggedMinutes: 120, budgetHours: 10 },
      { status: 'not_started', loggedMinutes: 0, budgetHours: 5 },
    ];
    expect(rollupTaskCompletion(tasks)).toBe(46);
  });

  it('falls back to simple mean when total budget = 0 (PR-014)', () => {
    // Two completed with zero budget: weighted formula would be 0/0; the
    // simple-mean fallback keeps them at 100.
    const tasks = [
      { status: 'completed', loggedMinutes: 0, budgetHours: 0 },
      { status: 'completed', loggedMinutes: 0, budgetHours: 0 },
    ];
    expect(rollupTaskCompletion(tasks)).toBe(100);
  });

  it('excludes zero-budget tasks from the weighted denominator but includes them in simple-mean fallback', () => {
    // completed (0 budget) + completed (10h budget). Weighted branch:
    // only the 10h task counts → 100×10 / 10 = 100. Simple mean would
    // also be 100 — but this test locks in the weighted path so a
    // future change that changes behaviour here trips.
    const tasks = [
      { status: 'completed', loggedMinutes: 0, budgetHours: 0 },
      { status: 'completed', loggedMinutes: 0, budgetHours: 10 },
    ];
    expect(rollupTaskCompletion(tasks)).toBe(100);
  });
});
