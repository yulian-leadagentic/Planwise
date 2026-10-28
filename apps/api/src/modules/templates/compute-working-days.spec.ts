import {
  computeFastestWorkingDays,
  computeSlowestWorkingDays,
  type SwdEdge,
  type SwdTask,
} from './templates.service';

// bm2 (2026-10-28) — Fastest = critical-path forward pass (min
// completion time with unlimited parallelism). Covers the four
// shapes the user locked in: linear chain, diamond, empty, and a
// cycle. 1-day finish-to-start gap per
// `docs/bm2/planwise-scheduling-business-rules-LOCKED.md` §3.
describe('computeFastestWorkingDays', () => {
  it('returns 0 for an empty template', () => {
    expect(computeFastestWorkingDays([], [])).toBe(0);
  });

  it('linear chain: 3 tasks of 8h with 1-day gap → ceil(5) = 5 days', () => {
    // T1=0..1, T2=2..3, T3=4..5 (gap of 1 day between each)
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: 8 },
      { id: 2, budgetHours: 8 },
      { id: 3, budgetHours: 8 },
    ];
    const edges: SwdEdge[] = [
      { templateTaskId: 2, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 3, dependsOnTemplateTaskId: 2 },
    ];
    expect(computeFastestWorkingDays(tasks, edges)).toBe(5);
  });

  it('diamond: A → B,C → D (all 8h) → ceil(5) = 5 days', () => {
    // A=0..1, B=2..3, C=2..3, D depends on both → start=max(3,3)+1=4, end=5
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: 8 }, // A
      { id: 2, budgetHours: 8 }, // B
      { id: 3, budgetHours: 8 }, // C
      { id: 4, budgetHours: 8 }, // D
    ];
    const edges: SwdEdge[] = [
      { templateTaskId: 2, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 3, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 4, dependsOnTemplateTaskId: 2 },
      { templateTaskId: 4, dependsOnTemplateTaskId: 3 },
    ];
    expect(computeFastestWorkingDays(tasks, edges)).toBe(5);
  });

  it('cycle: returns 0 and logs a warning', () => {
    // 1 ← 2 ← 3 ← 1 : nothing has in-degree 0 → Kahn processes nothing.
    const warnSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn').mockImplementation(() => undefined);
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: 8 },
      { id: 2, budgetHours: 8 },
      { id: 3, budgetHours: 8 },
    ];
    const edges: SwdEdge[] = [
      { templateTaskId: 1, dependsOnTemplateTaskId: 2 },
      { templateTaskId: 2, dependsOnTemplateTaskId: 3 },
      { templateTaskId: 3, dependsOnTemplateTaskId: 1 },
    ];
    expect(computeFastestWorkingDays(tasks, edges)).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('fractional durations: single 4h task → ceil(0.5) = 1 day', () => {
    expect(computeFastestWorkingDays([{ id: 1, budgetHours: 4 }], [])).toBe(1);
  });

  it('null / zero budget hours treated as zero duration', () => {
    // 1 (0h) → 2 (8h): start of 2 = 0 + 1 = 1, end = 2 → ceil(2) = 2
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: null },
      { id: 2, budgetHours: 8 },
    ];
    const edges: SwdEdge[] = [{ templateTaskId: 2, dependsOnTemplateTaskId: 1 }];
    expect(computeFastestWorkingDays(tasks, edges)).toBe(2);
  });

  it('BIM-template scenario: 9 tasks with mixed hours → ceil(5.125) = 6 days', () => {
    // The real screenshot the user showed. Numbers below are task ids
    // 1..9 mapping to BIM-001..BIM-009; hours per `defaultBudgetHours`.
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: 2 },
      { id: 2, budgetHours: 2 },
      { id: 3, budgetHours: 2 },
      { id: 4, budgetHours: 2 },
      { id: 5, budgetHours: 3 }, // BEP
      { id: 6, budgetHours: 6 },
      { id: 7, budgetHours: 2 },
      { id: 8, budgetHours: 2 },
      { id: 9, budgetHours: 1 },
    ];
    const edges: SwdEdge[] = [
      { templateTaskId: 2, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 3, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 4, dependsOnTemplateTaskId: 3 },
      { templateTaskId: 5, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 6, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 7, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 8, dependsOnTemplateTaskId: 4 },
      { templateTaskId: 8, dependsOnTemplateTaskId: 2 },
      { templateTaskId: 8, dependsOnTemplateTaskId: 5 },
      { templateTaskId: 9, dependsOnTemplateTaskId: 8 },
    ];
    expect(computeFastestWorkingDays(tasks, edges)).toBe(6);
  });
});

// bm2 (2026-10-28) — Slowest = pure sequential execution with no
// parallelism. `ceil(sum(budgetHours) / 8 + (N - 1) × 1 gap day)`.
// Dependency edges are ignored — this is the upper-bound
// "worst-case solo operator" number that pairs with the Fastest
// critical-path calc above.
describe('computeSlowestWorkingDays', () => {
  it('returns 0 for an empty template', () => {
    expect(computeSlowestWorkingDays([])).toBe(0);
  });

  it('single 8h task → 1 day', () => {
    // sum=8, totalDays = 8/8 + 0 = 1
    expect(computeSlowestWorkingDays([{ id: 1, budgetHours: 8 }])).toBe(1);
  });

  it('three 8h tasks → ceil(3 + 2) = 5 days (serial, regardless of edges)', () => {
    // sum=24, totalDays = 24/8 + 2 = 5
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: 8 },
      { id: 2, budgetHours: 8 },
      { id: 3, budgetHours: 8 },
    ];
    expect(computeSlowestWorkingDays(tasks)).toBe(5);
  });

  it('BIM-template scenario: 9 tasks, 22h total → ceil(22/8 + 8) = ceil(10.75) = 11 days', () => {
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: 2 },
      { id: 2, budgetHours: 2 },
      { id: 3, budgetHours: 2 },
      { id: 4, budgetHours: 2 },
      { id: 5, budgetHours: 3 },
      { id: 6, budgetHours: 6 },
      { id: 7, budgetHours: 2 },
      { id: 8, budgetHours: 2 },
      { id: 9, budgetHours: 1 },
    ];
    expect(computeSlowestWorkingDays(tasks)).toBe(11);
  });

  it('null / zero budget hours treated as zero duration', () => {
    // sum=8, N=2, totalDays = 1 + 1 = 2
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: null },
      { id: 2, budgetHours: 8 },
    ];
    expect(computeSlowestWorkingDays(tasks)).toBe(2);
  });
});

// bm2 (2026-10-28) — Fastest-vs-Slowest comparison scenarios that
// make the semantic difference between the two calcs visible: when
// everything is serial they should agree, when everything is
// parallel they should diverge.
describe('fastest vs slowest', () => {
  it('empty → both 0', () => {
    expect(computeFastestWorkingDays([], [])).toBe(0);
    expect(computeSlowestWorkingDays([])).toBe(0);
  });

  it('single 8h task → both 1', () => {
    const tasks: SwdTask[] = [{ id: 1, budgetHours: 8 }];
    expect(computeFastestWorkingDays(tasks, [])).toBe(1);
    expect(computeSlowestWorkingDays(tasks)).toBe(1);
  });

  it('three 8h tasks linear chain → both 5 (serial anyway)', () => {
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: 8 },
      { id: 2, budgetHours: 8 },
      { id: 3, budgetHours: 8 },
    ];
    const edges: SwdEdge[] = [
      { templateTaskId: 2, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 3, dependsOnTemplateTaskId: 2 },
    ];
    expect(computeFastestWorkingDays(tasks, edges)).toBe(5);
    expect(computeSlowestWorkingDays(tasks)).toBe(5);
  });

  it('three 8h tasks fully parallel (no edges) → fastest 1, slowest 5', () => {
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: 8 },
      { id: 2, budgetHours: 8 },
      { id: 3, budgetHours: 8 },
    ];
    expect(computeFastestWorkingDays(tasks, [])).toBe(1);
    expect(computeSlowestWorkingDays(tasks)).toBe(5);
  });

  it('BIM-template scenario: fastest 6, slowest 11', () => {
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: 2 },
      { id: 2, budgetHours: 2 },
      { id: 3, budgetHours: 2 },
      { id: 4, budgetHours: 2 },
      { id: 5, budgetHours: 3 },
      { id: 6, budgetHours: 6 },
      { id: 7, budgetHours: 2 },
      { id: 8, budgetHours: 2 },
      { id: 9, budgetHours: 1 },
    ];
    const edges: SwdEdge[] = [
      { templateTaskId: 2, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 3, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 4, dependsOnTemplateTaskId: 3 },
      { templateTaskId: 5, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 6, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 7, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 8, dependsOnTemplateTaskId: 4 },
      { templateTaskId: 8, dependsOnTemplateTaskId: 2 },
      { templateTaskId: 8, dependsOnTemplateTaskId: 5 },
      { templateTaskId: 9, dependsOnTemplateTaskId: 8 },
    ];
    expect(computeFastestWorkingDays(tasks, edges)).toBe(6);
    expect(computeSlowestWorkingDays(tasks)).toBe(11);
  });
});
