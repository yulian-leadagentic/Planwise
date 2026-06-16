import { dateRangesOverlap, minutesOverlap } from './overlap';

describe('minutesOverlap', () => {
  it('returns true for fully nested intervals', () => {
    expect(minutesOverlap(540, 720, 600, 660)).toBe(true);
  });
  it('returns true for partial overlap on the left', () => {
    expect(minutesOverlap(540, 600, 570, 630)).toBe(true);
  });
  it('returns false for adjacent intervals (back-to-back)', () => {
    // 09:00-10:00 then 10:00-11:00 — share the instant 10:00 but no slot
    expect(minutesOverlap(540, 600, 600, 660)).toBe(false);
  });
  it('returns false for disjoint intervals', () => {
    expect(minutesOverlap(540, 600, 700, 800)).toBe(false);
  });
  // No test for degenerate intervals — callers (TimeEntry create/update)
  // already gate on `newEnd > newStart` before invoking this helper, so a
  // zero-length window never reaches here.
});

describe('dateRangesOverlap', () => {
  const d = (s: string) => new Date(s + 'T00:00:00');

  it('overlaps when intervals share at least one day', () => {
    expect(dateRangesOverlap(d('2026-06-01'), d('2026-06-10'), d('2026-06-05'), d('2026-06-15'))).toBe(true);
  });
  it('overlaps on a single shared boundary day (inclusive)', () => {
    expect(dateRangesOverlap(d('2026-06-01'), d('2026-06-10'), d('2026-06-10'), d('2026-06-20'))).toBe(true);
  });
  it('does not overlap when fully disjoint', () => {
    expect(dateRangesOverlap(d('2026-06-01'), d('2026-06-05'), d('2026-06-10'), d('2026-06-15'))).toBe(false);
  });
  it('treats null start as -Infinity (always extends to the past)', () => {
    expect(dateRangesOverlap(null, d('2026-06-01'), d('2025-06-01'), d('2025-12-31'))).toBe(true);
    expect(dateRangesOverlap(null, d('2026-06-01'), d('2026-06-02'), d('2026-06-10'))).toBe(false);
  });
  it('treats null end as +Infinity (open-ended into the future)', () => {
    expect(dateRangesOverlap(d('2026-06-01'), null, d('2027-01-01'), d('2027-01-31'))).toBe(true);
    expect(dateRangesOverlap(d('2026-06-01'), null, d('2025-01-01'), d('2025-12-31'))).toBe(false);
  });
  it('two open-ended-both-ways tasks always overlap', () => {
    expect(dateRangesOverlap(null, null, null, null)).toBe(true);
  });
});
