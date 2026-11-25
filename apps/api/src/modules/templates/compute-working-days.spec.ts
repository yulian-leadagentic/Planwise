import {
  computeFastestWorkingDays,
  computeSlowestWorkingDays,
  templateTaskWorkingDays,
  type SwdEdge,
  type SwdTask,
} from './templates.service';

// bm2 (2026-10-28) — Fastest = critical-path forward pass (min
// completion time with unlimited parallelism).
//
// BM2-30 (QA6, 2026-11-25) — Fastest now runs the scheduler's own
// forward pass (D1-Lag / D7): a task lasts max(1, ceil(hours / 8))
// working days, lag 0 = the successor starts the next working day (no
// idle day in between), and each edge's lag is added in its unit.
// `template-critical-path.parity.spec.ts` proves the value equals the
// project scheduler's forward pass on the same graphs.
describe('computeFastestWorkingDays', () => {
  it('returns null for an empty template', () => {
    // bm2 (2026-10-28, "no hours = no measure") — a template with
    // no tasks has no measure to display; null lets the FE hide the
    // chip rather than render "~0 working days".
    expect(computeFastestWorkingDays([], [])).toBeNull();
  });

  it('returns null when every task has null / zero / missing budgetHours', () => {
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: null },
      { id: 2, budgetHours: undefined },
      { id: 3, budgetHours: 0 },
      { id: 4, budgetHours: null },
      { id: 5, budgetHours: null },
      { id: 6, budgetHours: null },
    ];
    expect(computeFastestWorkingDays(tasks, [])).toBeNull();
  });

  it('linear chain: 3 tasks of 8h, no lag → 3 working days (day 1, 2, 3)', () => {
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: 8 },
      { id: 2, budgetHours: 8 },
      { id: 3, budgetHours: 8 },
    ];
    const edges: SwdEdge[] = [
      { templateTaskId: 2, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 3, dependsOnTemplateTaskId: 2 },
    ];
    expect(computeFastestWorkingDays(tasks, edges)).toBe(3);
  });

  it('diamond: A → B,C → D (all 8h) → 3 working days', () => {
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
    expect(computeFastestWorkingDays(tasks, edges)).toBe(3);
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

  it('a task shorter than a day still takes one working day', () => {
    expect(computeFastestWorkingDays([{ id: 1, budgetHours: 4 }], [])).toBe(1);
    expect(computeFastestWorkingDays([{ id: 1, budgetHours: 9 }], [])).toBe(2);
  });

  it('a task with no hours still takes one working day (as in the scheduler)', () => {
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: null },
      { id: 2, budgetHours: 8 },
    ];
    const edges: SwdEdge[] = [{ templateTaskId: 2, dependsOnTemplateTaskId: 1 }];
    expect(computeFastestWorkingDays(tasks, edges)).toBe(2);
  });

  it('BIM-template scenario: 9 tasks, longest chain 1→3→4→8→9 → 5 working days', () => {
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
    expect(computeFastestWorkingDays(tasks, BIM_EDGES)).toBe(5);
  });

  describe('BM2-30 · dependency lag', () => {
    it('"CRD-036 waits 7 working days after CRD-002" (1h each) → 1 + 7 + 1 = 9 working days', () => {
      const tasks: SwdTask[] = [
        { id: 2, budgetHours: 1 }, // CRD-002
        { id: 36, budgetHours: 1 }, // CRD-036
      ];
      const edges: SwdEdge[] = [
        { templateTaskId: 36, dependsOnTemplateTaskId: 2, lag: 7, lagUnit: 'WORKING_DAYS' },
      ];
      expect(computeFastestWorkingDays(tasks, edges)).toBe(9);
      // The same graph without the wait is the plain 2-day handoff.
      expect(computeFastestWorkingDays(tasks, [{ templateTaskId: 36, dependsOnTemplateTaskId: 2 }])).toBe(2);
    });

    it('template 41 "תיאום ראשוני": 002 → 021 (+7 working) → 036 (+7 calendar) → 15 working days', () => {
      // Sun 01-04 CRD-002 · next working day + 7 → Wed 01-14 CRD-021 ·
      // +1+7 calendar days → Thu 01-22 CRD-036. Sun 01-04..Thu 01-22 =
      // three full Sun–Thu weeks = 15 working days.
      expect(computeFastestWorkingDays(CRD_TASKS, CRD_EDGES)).toBe(15);
    });

    it('a calendar-day lag counts the weekend it spans', () => {
      // A (8h) on Sun; 1 + 3 calendar days after Sun = Thu → B on Thu.
      // Sun..Thu = 5 working days.
      const tasks: SwdTask[] = [
        { id: 1, budgetHours: 8 },
        { id: 2, budgetHours: 8 },
      ];
      expect(
        computeFastestWorkingDays(tasks, [
          { templateTaskId: 2, dependsOnTemplateTaskId: 1, lag: 3, lagUnit: 'CALENDAR_DAYS' },
        ]),
      ).toBe(5);
      // 1 + 5 calendar days after Sun lands on Sat (rest) → snaps to
      // Sun of week 2: 6 working days. 5 working days after the next
      // working day (Mon) lands on Mon of week 2: 7 working days.
      expect(
        computeFastestWorkingDays(tasks, [
          { templateTaskId: 2, dependsOnTemplateTaskId: 1, lag: 5, lagUnit: 'CALENDAR_DAYS' },
        ]),
      ).toBe(6);
      expect(
        computeFastestWorkingDays(tasks, [
          { templateTaskId: 2, dependsOnTemplateTaskId: 1, lag: 5, lagUnit: 'WORKING_DAYS' },
        ]),
      ).toBe(7);
    });

    it('the longest path wins when only a side branch carries the lag', () => {
      // 1 → 2 → 3 → 4 (8h each, no lag) = 4 days; 1 → 5 (+1 wd) = 3 days.
      const tasks: SwdTask[] = [1, 2, 3, 4, 5].map((id) => ({ id, budgetHours: 8 }));
      const edges: SwdEdge[] = [
        { templateTaskId: 2, dependsOnTemplateTaskId: 1 },
        { templateTaskId: 3, dependsOnTemplateTaskId: 2 },
        { templateTaskId: 4, dependsOnTemplateTaskId: 3 },
        { templateTaskId: 5, dependsOnTemplateTaskId: 1, lag: 1, lagUnit: 'WORKING_DAYS' },
      ];
      expect(computeFastestWorkingDays(tasks, edges)).toBe(4);
      // A 4-day wait on the side branch makes it the critical path.
      edges[3] = { templateTaskId: 5, dependsOnTemplateTaskId: 1, lag: 4, lagUnit: 'WORKING_DAYS' };
      expect(computeFastestWorkingDays(tasks, edges)).toBe(6);
    });

    it('negative / garbage lag is treated as 0, unknown unit as working days', () => {
      const tasks: SwdTask[] = [
        { id: 1, budgetHours: 8 },
        { id: 2, budgetHours: 8 },
      ];
      expect(
        computeFastestWorkingDays(tasks, [
          { templateTaskId: 2, dependsOnTemplateTaskId: 1, lag: -3, lagUnit: 'WORKING_DAYS' },
        ]),
      ).toBe(2);
      expect(
        computeFastestWorkingDays(tasks, [
          { templateTaskId: 2, dependsOnTemplateTaskId: 1, lag: 2, lagUnit: 'SOMETHING' },
        ]),
      ).toBe(4);
    });
  });
});

describe('templateTaskWorkingDays', () => {
  it('mirrors the scheduler duration: max(1, ceil(h / 8)), 1 without hours', () => {
    expect(templateTaskWorkingDays(null)).toBe(1);
    expect(templateTaskWorkingDays(0)).toBe(1);
    expect(templateTaskWorkingDays(1)).toBe(1);
    expect(templateTaskWorkingDays(8)).toBe(1);
    expect(templateTaskWorkingDays(8.5)).toBe(2);
    expect(templateTaskWorkingDays(40)).toBe(5);
  });
});

// bm2 (2026-10-28) — Slowest = pure sequential execution with no
// parallelism. `ceil(sum(budgetHours) / 8 + (N - 1) × 1 gap day)`.
// BM2-30 — floored at Fastest when the edges are passed.
describe('computeSlowestWorkingDays', () => {
  it('returns null for an empty template', () => {
    expect(computeSlowestWorkingDays([])).toBeNull();
  });

  it('returns null when every task has null / zero / missing budgetHours', () => {
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: null },
      { id: 2, budgetHours: undefined },
      { id: 3, budgetHours: 0 },
      { id: 4, budgetHours: null },
      { id: 5, budgetHours: null },
      { id: 6, budgetHours: null },
    ];
    expect(computeSlowestWorkingDays(tasks)).toBeNull();
  });

  it('single 8h task → 1 day', () => {
    expect(computeSlowestWorkingDays([{ id: 1, budgetHours: 8 }])).toBe(1);
  });

  it('three 8h tasks → ceil(3 + 2) = 5 days (serial, regardless of edges)', () => {
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: 8 },
      { id: 2, budgetHours: 8 },
      { id: 3, budgetHours: 8 },
    ];
    expect(computeSlowestWorkingDays(tasks)).toBe(5);
  });

  it('BIM-template scenario: 9 tasks, 22h total → ceil(22/8 + 8) = ceil(10.75) = 11 days', () => {
    expect(computeSlowestWorkingDays(BIM_TASKS)).toBe(11);
    expect(computeSlowestWorkingDays(BIM_TASKS, BIM_EDGES)).toBe(11);
  });

  it('null / zero budget hours treated as zero duration', () => {
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: null },
      { id: 2, budgetHours: 8 },
    ];
    expect(computeSlowestWorkingDays(tasks)).toBe(2);
  });

  it('BM2-30: never below Fastest when a lag makes the critical path longer', () => {
    // Sequential formula alone: ceil(3/8 + 2) = 3. Fastest = 15.
    expect(computeSlowestWorkingDays(CRD_TASKS)).toBe(3);
    expect(computeSlowestWorkingDays(CRD_TASKS, CRD_EDGES)).toBe(15);
  });
});

describe('fastest vs slowest', () => {
  it('empty → both null', () => {
    expect(computeFastestWorkingDays([], [])).toBeNull();
    expect(computeSlowestWorkingDays([], [])).toBeNull();
  });

  it('all-null hours → both null (FE hides the chip)', () => {
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: null },
      { id: 2, budgetHours: null },
      { id: 3, budgetHours: null },
    ];
    expect(computeFastestWorkingDays(tasks, [])).toBeNull();
    expect(computeSlowestWorkingDays(tasks, [])).toBeNull();
  });

  it('single 8h task → both 1', () => {
    const tasks: SwdTask[] = [{ id: 1, budgetHours: 8 }];
    expect(computeFastestWorkingDays(tasks, [])).toBe(1);
    expect(computeSlowestWorkingDays(tasks, [])).toBe(1);
  });

  it('three 8h tasks linear chain → fastest 3, slowest 5', () => {
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: 8 },
      { id: 2, budgetHours: 8 },
      { id: 3, budgetHours: 8 },
    ];
    const edges: SwdEdge[] = [
      { templateTaskId: 2, dependsOnTemplateTaskId: 1 },
      { templateTaskId: 3, dependsOnTemplateTaskId: 2 },
    ];
    expect(computeFastestWorkingDays(tasks, edges)).toBe(3);
    expect(computeSlowestWorkingDays(tasks, edges)).toBe(5);
  });

  it('three 8h tasks fully parallel (no edges) → fastest 1, slowest 5', () => {
    const tasks: SwdTask[] = [
      { id: 1, budgetHours: 8 },
      { id: 2, budgetHours: 8 },
      { id: 3, budgetHours: 8 },
    ];
    expect(computeFastestWorkingDays(tasks, [])).toBe(1);
    expect(computeSlowestWorkingDays(tasks, [])).toBe(5);
  });

  it('BIM-template scenario: fastest 5, slowest 11', () => {
    expect(computeFastestWorkingDays(BIM_TASKS, BIM_EDGES)).toBe(5);
    expect(computeSlowestWorkingDays(BIM_TASKS, BIM_EDGES)).toBe(11);
  });
});

// ─── fixtures ────────────────────────────────────────────────────────

const BIM_TASKS: SwdTask[] = [
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

const BIM_EDGES: SwdEdge[] = [
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

// Template 41 "תיאום ראשוני" as documented in
// docs/bm2/planwise-DP-predecessor-lag-scheduling-BUG.md: CRD-002 /
// CRD-021 / CRD-036, 1h each; 021 ← 002 +7 working days, 036 ← 021 +7
// calendar days.
const CRD_TASKS: SwdTask[] = [
  { id: 2, budgetHours: 1 },
  { id: 21, budgetHours: 1 },
  { id: 36, budgetHours: 1 },
];
const CRD_EDGES: SwdEdge[] = [
  { templateTaskId: 21, dependsOnTemplateTaskId: 2, lag: 7, lagUnit: 'WORKING_DAYS' },
  { templateTaskId: 36, dependsOnTemplateTaskId: 21, lag: 7, lagUnit: 'CALENDAR_DAYS' },
];
