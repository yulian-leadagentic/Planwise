import { rollupCompletion } from './completion-rollup';

describe('rollupCompletion', () => {
  it('computes a budget-hours-weighted average when totalHours > 0', () => {
    // 80% × 10h = 800, 40% × 5h = 200, 100% × 2h = 200 → 1200 / 17 = 70.588 → 71
    const tasks = [
      { completionPct: 80, budgetHours: 10 },
      { completionPct: 40, budgetHours: 5 },
      { completionPct: 100, budgetHours: 2 },
    ];
    expect(rollupCompletion(tasks)).toBe(71);
  });

  it('falls back to the simple mean of completionPct when every task has 0 budget (PR-014)', () => {
    // A Done task with no budget should still contribute 100 to the average
    // instead of being silently dropped to 0 by the weighted formula.
    const tasks = [
      { completionPct: 100, budgetHours: 0 },
      { completionPct: 100, budgetHours: null },
      { completionPct: 0, budgetHours: 0 },
    ];
    // Simple mean: (100 + 100 + 0) / 3 = 66.67 → 67
    expect(rollupCompletion(tasks)).toBe(67);
  });

  it('returns 0 for an empty bucket', () => {
    expect(rollupCompletion([])).toBe(0);
  });

  it('treats null budgetHours as 0 in the weighted sum and null completionPct as 0', () => {
    // Weighted-hours path is exercised by the task with budgetHours=8.
    // Null completionPct becomes 0; null budgetHours contributes nothing.
    // 90 × 8 = 720, 0 × 8 = 0, 100 × 0 = 0 → 720 / 16 = 45
    const tasks = [
      { completionPct: 90, budgetHours: 8 },
      { completionPct: null, budgetHours: 8 },
      { completionPct: 100, budgetHours: null },
    ];
    expect(rollupCompletion(tasks)).toBe(45);
  });
});
