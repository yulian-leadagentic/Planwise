/**
 * QA6 P3 (PR-073 / PR-074) — the Workload range label and day columns
 * follow the days the API sends (org work week, Sunday first).
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  dayColumn,
  dayTasksTitle,
  formatWorkRange,
  groupByDepartment,
  shiftDateKey,
  utilizationPct,
  type TeamWorkloadDay,
  type TeamWorkloadPerson,
} from './workload-range';
import { WorkloadDayHeaders } from './parts/workload-day-headers';

const SUN_THU = ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'];

describe('formatWorkRange', () => {
  it('Sun–Thu in one month: "Sun 22 – Thu 26 Nov 2026"', () => {
    expect(formatWorkRange(SUN_THU)).toBe('Sun 22 – Thu 26 Nov 2026');
  });

  it('uses the first and last day whatever the order', () => {
    expect(formatWorkRange([...SUN_THU].reverse())).toBe('Sun 22 – Thu 26 Nov 2026');
  });

  it('across months and years; one day; none', () => {
    expect(formatWorkRange(['2026-11-29', '2026-12-03'])).toBe('Sun 29 Nov – Thu 3 Dec 2026');
    expect(formatWorkRange(['2026-12-27', '2027-01-01'])).toBe('Sun 27 Dec 2026 – Fri 1 Jan 2027');
    expect(formatWorkRange(['2026-11-22'])).toBe('Sun 22 Nov 2026');
    expect(formatWorkRange([])).toBe('');
  });

  it('has no long dash', () => {
    expect(formatWorkRange(SUN_THU)).not.toContain('—');
  });
});

describe('day columns', () => {
  const days: TeamWorkloadDay[] = SUN_THU.map((date, i) => ({
    date,
    dayOfWeek: i,
    isWorkingDay: i !== 2,
    holiday: i === 2 ? { name: 'Hanukkah', type: 'HOLIDAY', workingHours: 0 } : null,
  }));

  it('dayColumn gives weekday + dd/MM', () => {
    expect(dayColumn('2026-11-22')).toEqual({ weekday: 'Sun', date: '22/11' });
    expect(dayColumn('2026-11-26')).toEqual({ weekday: 'Thu', date: '26/11' });
  });

  it('renders exactly the API days, Sunday first, holidays named', () => {
    const html = renderToStaticMarkup(createElement('tr', null, createElement(WorkloadDayHeaders, { days })));
    const dates = [...html.matchAll(/data-date="([^"]+)"/g)].map((m) => m[1]);
    expect(dates).toEqual(SUN_THU);
    const weekdays = [...html.matchAll(/<th[^>]*>(\w{3})<br\/>/g)].map((m) => m[1]);
    expect(weekdays).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu']);
    expect(html).toContain('Hanukkah');
    expect(html).not.toContain('Fri');
  });
});

describe('helpers', () => {
  it('shiftDateKey moves by whole days', () => {
    expect(shiftDateKey('2026-11-22', -7)).toBe('2026-11-15');
    expect(shiftDateKey('2026-11-29', 7)).toBe('2026-12-06');
  });

  it('utilizationPct is 0 without capacity', () => {
    expect(utilizationPct(10, 40)).toBe(25);
    expect(utilizationPct(5, 0)).toBe(0);
  });

  it('groups by department, "No department" last', () => {
    const p = (id: number, unit: { id: number; name: string } | null) =>
      ({ id, orgUnit: unit } as unknown as TeamWorkloadPerson);
    const groups = groupByDepartment([p(1, null), p(2, { id: 5, name: 'BIM' }), p(3, { id: 6, name: 'MEP' }), p(4, { id: 5, name: 'BIM' })]);
    expect(groups.map((g) => [g.name, g.people.map((x) => x.id)])).toEqual([
      ['BIM', [2, 4]],
      ['MEP', [3]],
      ['No department', [1]],
    ]);
  });

  it('a masked chip reads "Other project" in the cell tooltip', () => {
    expect(
      dayTasksTitle([
        { taskId: 1, code: 'BIM-1', name: 'Walls', projectId: 5, projectName: 'P', hours: 2 },
        { taskId: null, code: null, name: 'Other project', projectId: null, projectName: null, hours: 1.5, masked: true },
      ]),
    ).toBe('BIM-1 Walls · 2h\nOther project · 1.5h');
  });
});
