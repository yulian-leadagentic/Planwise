import { describe, expect, it } from 'vitest';
import {
  formatRangeLabel,
  matchesPeriod,
  periodRange,
  periodRangeLabel,
} from './period-filter';

// Local-time anchors so the specs hold in any timezone.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0, 0, 0).getTime();
const WED_25_NOV_2026 = at(2026, 11, 25);

describe('periodRangeLabel (PR-072)', () => {
  it('spells out the Week range, Sunday to Friday', () => {
    expect(periodRangeLabel('week', WED_25_NOV_2026)).toBe('Sun 22 – Fri 27 Nov 2026');
  });

  it('spells out the Month range', () => {
    expect(periodRangeLabel('month', WED_25_NOV_2026)).toBe('Sun 1 – Mon 30 Nov 2026');
  });

  it('spells out the Day', () => {
    expect(periodRangeLabel('day', WED_25_NOV_2026)).toBe('Wed 25 Nov 2026');
  });

  it('has no label for Any / Custom', () => {
    expect(periodRangeLabel('any', WED_25_NOV_2026)).toBeNull();
    expect(periodRangeLabel('custom', WED_25_NOV_2026)).toBeNull();
  });

  it('writes both months when the week crosses a month', () => {
    expect(periodRangeLabel('week', at(2026, 12, 1))).toBe('Sun 29 Nov – Fri 4 Dec 2026');
  });

  it('writes both years when the week crosses a year', () => {
    expect(periodRangeLabel('week', at(2026, 12, 30))).toBe('Sun 27 Dec 2026 – Fri 1 Jan 2027');
  });

  it('starts the week on Sunday even on a Sunday or a Saturday', () => {
    expect(periodRangeLabel('week', at(2026, 11, 22, 8))).toBe('Sun 22 – Fri 27 Nov 2026');
    expect(periodRangeLabel('week', at(2026, 11, 28, 8))).toBe('Sun 22 – Fri 27 Nov 2026');
  });

  it('never uses a long dash', () => {
    const r = periodRange('week', WED_25_NOV_2026)!;
    expect(formatRangeLabel(r.startMs, r.endMs)).not.toContain('—');
  });
});

describe('matchesPeriod overdue carry-over (PR-072)', () => {
  const overdue = { endDate: '2026-10-20T00:00:00.000Z', status: 'not_started' };
  const overdueInReview = { endDate: '2026-10-03T00:00:00.000Z', status: 'in_review' };
  const overdueDone = { endDate: '2026-10-20T00:00:00.000Z', status: 'completed' };
  const overdueInProgress = { endDate: '2026-10-20T00:00:00.000Z', status: 'in_progress' };
  const inWeek = { endDate: '2026-11-24T00:00:00.000Z', status: 'not_started' };
  const nextMonth = { endDate: '2026-12-16T00:00:00.000Z', status: 'not_started' };

  it('shows open tasks due before the range by default', () => {
    for (const p of ['day', 'week', 'month'] as const) {
      expect(matchesPeriod(overdue, p, WED_25_NOV_2026)).toBe(true);
      expect(matchesPeriod(overdueInReview, p, WED_25_NOV_2026)).toBe(true);
    }
  });

  it('drops them when "Include overdue" is off', () => {
    for (const p of ['day', 'week', 'month'] as const) {
      expect(matchesPeriod(overdue, p, WED_25_NOV_2026, '', '', { includeOverdue: false })).toBe(false);
    }
  });

  it('never carries completed tasks', () => {
    expect(matchesPeriod(overdueDone, 'week', WED_25_NOV_2026)).toBe(false);
  });

  it('keeps in-progress tasks regardless of the overdue toggle', () => {
    expect(matchesPeriod(overdueInProgress, 'week', WED_25_NOV_2026, '', '', { includeOverdue: false })).toBe(true);
  });

  it('keeps tasks due inside the range and drops later ones', () => {
    expect(matchesPeriod(inWeek, 'week', WED_25_NOV_2026, '', '', { includeOverdue: false })).toBe(true);
    expect(matchesPeriod(nextMonth, 'week', WED_25_NOV_2026)).toBe(false);
    expect(matchesPeriod(nextMonth, 'month', WED_25_NOV_2026)).toBe(false);
  });

  it('leaves Any and Custom alone', () => {
    expect(matchesPeriod(overdue, 'any', WED_25_NOV_2026, '', '', { includeOverdue: false })).toBe(true);
    // Custom is a strict due-date range: no overdue carry-over.
    expect(matchesPeriod(overdue, 'custom', WED_25_NOV_2026, '2026-11-20', '2026-11-30')).toBe(false);
  });
});
