import { rollupCompletion, taskCompletionValue } from './completion-rollup';

describe('taskCompletionValue', () => {
  it('pins completed / cancelled to 100 regardless of hours', () => {
    expect(taskCompletionValue({ status: 'completed', loggedMinutes: 0, budgetHours: 10 })).toBe(100);
    expect(taskCompletionValue({ status: 'cancelled', loggedMinutes: 0, budgetHours: 0 })).toBe(100);
  });

  it('pins in_review to 90 regardless of hours', () => {
    expect(taskCompletionValue({ status: 'in_review', loggedMinutes: 0, budgetHours: 10 })).toBe(90);
    expect(taskCompletionValue({ status: 'in_review', loggedMinutes: 100000, budgetHours: 10 })).toBe(90);
  });

  it('caps in_progress time-based value at 80', () => {
    // 5h logged / 10h budget × 80 = 40
    expect(taskCompletionValue({ status: 'in_progress', loggedMinutes: 300, budgetHours: 10 })).toBe(40);
    // Over budget still capped
    expect(taskCompletionValue({ status: 'in_progress', loggedMinutes: 1200, budgetHours: 10 })).toBe(80);
  });

  it('returns 0 for in_progress / not_started with no logged hours or no budget', () => {
    expect(taskCompletionValue({ status: 'in_progress', loggedMinutes: 0, budgetHours: 10 })).toBe(0);
    expect(taskCompletionValue({ status: 'not_started', loggedMinutes: 0, budgetHours: 10 })).toBe(0);
    expect(taskCompletionValue({ status: 'in_progress', loggedMinutes: 300, budgetHours: 0 })).toBe(0);
  });

  it('ignores a stale stored completionPct — status always wins', () => {
    // The whole point of this rewire: a completed task with stale
    // stored completionPct=0 must still contribute 100.
    expect(taskCompletionValue({ status: 'completed', completionPct: 0, loggedMinutes: 0, budgetHours: 10 })).toBe(100);
    // And a not_started task with a stored completionPct=50 must
    // return 0 — we no longer trust the field for rollup input.
    expect(taskCompletionValue({ status: 'not_started', completionPct: 50, loggedMinutes: 0, budgetHours: 10 })).toBe(0);
  });
});

describe('rollupCompletion', () => {
  it('returns 0 for an empty bucket', () => {
    expect(rollupCompletion([])).toBe(0);
  });

  it('reads 100 when every task is Done — regardless of logged hours', () => {
    // BIM-management repro: 11 completed tasks, 0h logged. Stored
    // completionPct was 0 in the wild; the helper must return 100.
    const tasks = Array.from({ length: 11 }, () => ({ status: 'completed', loggedMinutes: 0, budgetHours: 10 }));
    expect(rollupCompletion(tasks)).toBe(100);
  });

  it('reads ~82 on the DoD scenario (9/11 done, 2 not started, equal budget)', () => {
    // 9 × 100 + 2 × 0 = 900 / 11 tasks (equal budget) → 900/11 ≈ 82.
    const tasks = [
      ...Array.from({ length: 9 }, () => ({ status: 'completed', loggedMinutes: 0, budgetHours: 10 })),
      ...Array.from({ length: 2 }, () => ({ status: 'not_started', loggedMinutes: 0, budgetHours: 10 })),
    ];
    expect(rollupCompletion(tasks)).toBe(82);
  });

  it('budget-weights when tasks have unequal budgets', () => {
    // completed × 10h → 100, in_progress-2h-of-10 → 16, not_started × 5h → 0
    // 100×10 + 16×10 + 0×5 = 1160 / 25 = 46.4 → 46
    const tasks = [
      { status: 'completed', loggedMinutes: 0, budgetHours: 10 },
      { status: 'in_progress', loggedMinutes: 120, budgetHours: 10 },
      { status: 'not_started', loggedMinutes: 0, budgetHours: 5 },
    ];
    expect(rollupCompletion(tasks)).toBe(46);
  });

  it('falls back to simple mean when total budget = 0 (PR-014)', () => {
    // Two completed with zero budget: weighted formula would be 0/0;
    // simple-mean fallback keeps them at 100.
    const tasks = [
      { status: 'completed', loggedMinutes: 0, budgetHours: 0 },
      { status: 'completed', loggedMinutes: 0, budgetHours: null },
    ];
    expect(rollupCompletion(tasks)).toBe(100);
  });

  it('the no-zone bucket of Done tasks with 0h logged reads 100, not 0 (DoD)', () => {
    // The spec's "no-zone bucket with Done tasks isn't 0%" repro.
    const bucket = [
      { status: 'completed', loggedMinutes: 0, budgetHours: 4 },
      { status: 'completed', loggedMinutes: 0, budgetHours: 8 },
    ];
    expect(rollupCompletion(bucket)).toBe(100);
  });
});
