/**
 * QA6 PR-080 — Executive Review: department filter + the full list
 * rendered progressively (no row is dropped, only deferred).
 */
import { describe, it, expect } from 'vitest';
import {
  NO_DEPARTMENT,
  RENDER_STEP,
  countLabel,
  departmentOptions,
  matchesDepartment,
  windowGroups,
} from './executive-review.util';

const t = (id: number, dept: string | null) => ({ id, project: { department: dept ? { id: dept.length, name: dept } : null } });

describe('department filter', () => {
  const tasks = [t(1, 'MEP'), t(2, 'BIM'), t(3, null), t(4, 'BIM'), { id: 5, project: null }];

  it('options come from the loaded rows, A→Z, with counts; "(no department)" last', () => {
    expect(departmentOptions(tasks)).toEqual([
      { value: 'BIM', label: 'BIM', count: 2 },
      { value: 'MEP', label: 'MEP', count: 1 },
      { value: NO_DEPARTMENT, label: '(no department)', count: 2 },
    ]);
  });

  it('matches one department, the rows without one, or everything', () => {
    expect(tasks.filter((x) => matchesDepartment(x, 'BIM')).map((x) => x.id)).toEqual([2, 4]);
    expect(tasks.filter((x) => matchesDepartment(x, NO_DEPARTMENT)).map((x) => x.id)).toEqual([3, 5]);
    expect(tasks.filter((x) => matchesDepartment(x, '')).length).toBe(5);
  });
});

describe('progressive rendering of the full list', () => {
  const rows = Array.from({ length: 341 }, (_, i) => i + 1);

  it('341 tasks: every row is reachable, RENDER_STEP at a time', () => {
    let limit = RENDER_STEP;
    let shown = windowGroups([{ key: '', tasks: rows }], limit);
    expect(shown[0].tasks).toHaveLength(150);
    expect(shown[0].total).toBe(341);
    while (limit < rows.length) limit += RENDER_STEP;
    shown = windowGroups([{ key: '', tasks: rows }], limit);
    expect(shown[0].tasks).toEqual(rows);
  });

  it('spans groups in order and keeps each group’s full count', () => {
    const out = windowGroups([{ key: 'A', tasks: [1, 2, 3] }, { key: 'B', tasks: [4, 5] }, { key: 'C', tasks: [6] }], 4);
    expect(out).toEqual([
      { key: 'A', tasks: [1, 2, 3], total: 3 },
      { key: 'B', tasks: [4], total: 2 },
    ]);
  });

  it('the count says all 341, or how many a filter leaves', () => {
    expect(countLabel({ loaded: 341, total: 341, shown: 341 })).toBe('341 tasks');
    expect(countLabel({ loaded: 341, total: 341, shown: 12 })).toBe('12 of 341 tasks');
    expect(countLabel({ loaded: 10000, total: 12000, shown: 10000, truncated: true })).toBe('Showing 10000 of 12000');
    expect(countLabel({ loaded: 1, total: 1, shown: 1 })).toBe('1 task');
  });
});
