/**
 * QA6 PR-061 — an open-ended project (end date 9999-12-31) reads
 * "ללא תאריך סיום" and never gets a days-left figure ("2912116d left").
 */
import { describe, it, expect } from 'vitest';
import { NO_END_DATE_LABEL, daysLeft, formatDaysLeft, hasNoEndDate, isOpenEnded } from './project-dates';

const NOW = new Date('2026-11-25T10:00:00Z');

describe('project-dates', () => {
  it('9999-12-31 is open-ended, in any form', () => {
    expect(isOpenEnded('9999-12-31')).toBe(true);
    expect(isOpenEnded('9999-12-31T00:00:00.000Z')).toBe(true);
    expect(isOpenEnded(new Date('9999-12-30T22:00:00Z'))).toBe(true); // Israel midnight stored as UTC
    expect(isOpenEnded('9000-01-01')).toBe(true);
  });

  it('a real date, a missing or a broken one is not open-ended', () => {
    expect(isOpenEnded('2029-11-25')).toBe(false);
    expect(isOpenEnded(null)).toBe(false);
    expect(isOpenEnded(undefined)).toBe(false);
    expect(isOpenEnded('not a date')).toBe(false);
    expect(hasNoEndDate(null)).toBe(true);
    expect(hasNoEndDate('9999-12-31')).toBe(true);
    expect(hasNoEndDate('2029-11-25')).toBe(false);
  });

  it('daysLeft is never computed for an open-ended project', () => {
    expect(daysLeft('9999-12-31', NOW)).toBeNull();
    expect(daysLeft(null, NOW)).toBeNull();
    expect(daysLeft('2026-12-05T10:00:00Z', NOW)).toBe(10);
    expect(daysLeft('2026-11-20T10:00:00Z', NOW)).toBe(-5);
  });

  it('formatDaysLeft: the label instead of "2912116d left"', () => {
    expect(NO_END_DATE_LABEL).toBe('ללא תאריך סיום');
    expect(formatDaysLeft('9999-12-31')).toBe('ללא תאריך סיום');
    // even when an older API still sends the huge number
    expect(formatDaysLeft('9999-12-31', 2912116)).toBe('ללא תאריך סיום');
    expect(formatDaysLeft('2026-12-05', 10)).toBe('10d left');
    expect(formatDaysLeft('2026-11-20', -5)).toBe('5d overdue');
    expect(formatDaysLeft(null, null)).toBe('—');
  });
});
