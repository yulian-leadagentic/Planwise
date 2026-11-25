import { describe, expect, it } from 'vitest';
import {
  NO_END_DATE_LABEL,
  OPEN_ENDED_END_DATE,
  addYearsToIsoDate,
  defaultEndDateFor,
  formatProjectEndDate,
  formatProjectTimeline,
  isOpenEnded,
  nextEndDateOnStartChange,
} from './project-end-date';

describe('isOpenEnded (PR-061)', () => {
  it('treats the 9999-12-31 sentinel as open-ended, as date or ISO timestamp', () => {
    expect(isOpenEnded(OPEN_ENDED_END_DATE)).toBe(true);
    expect(isOpenEnded('9999-12-31T00:00:00.000Z')).toBe(true);
    expect(isOpenEnded(new Date(9999, 11, 31))).toBe(true);
  });

  it('treats a missing or unparsable end date as open-ended', () => {
    expect(isOpenEnded(null)).toBe(true);
    expect(isOpenEnded(undefined)).toBe(true);
    expect(isOpenEnded('')).toBe(true);
    expect(isOpenEnded('not a date')).toBe(true);
  });

  it('treats a real end date as bounded', () => {
    expect(isOpenEnded('2029-11-25')).toBe(false);
    expect(isOpenEnded('2029-11-25T00:00:00.000Z')).toBe(false);
    expect(isOpenEnded('9998-12-31')).toBe(false);
    expect(isOpenEnded(new Date(2030, 0, 1))).toBe(false);
  });
});

describe('default end date = start + 3 years (PR-061)', () => {
  it('adds three years to the start date', () => {
    expect(defaultEndDateFor('2026-11-25')).toBe('2029-11-25');
    expect(defaultEndDateFor('2026-01-01')).toBe('2029-01-01');
  });

  it('accepts an ISO timestamp start', () => {
    expect(defaultEndDateFor('2026-11-25T00:00:00.000Z')).toBe('2029-11-25');
  });

  it('lands Feb 29 on Feb 28 in a non-leap year', () => {
    expect(addYearsToIsoDate('2028-02-29', 3)).toBe('2031-02-28');
  });

  it('is blank when there is no valid start', () => {
    expect(defaultEndDateFor('')).toBe('');
    expect(defaultEndDateFor(null)).toBe('');
    expect(defaultEndDateFor(undefined)).toBe('');
    expect(defaultEndDateFor('garbage')).toBe('');
  });
});

describe('nextEndDateOnStartChange (PR-061)', () => {
  it('follows Start while End was not edited by hand', () => {
    expect(nextEndDateOnStartChange({
      startDate: '2026-11-25', currentEndDate: '', endDateEditedByUser: false,
    })).toBe('2029-11-25');
    // Start changes again: End follows again.
    expect(nextEndDateOnStartChange({
      startDate: '2027-03-01', currentEndDate: '2029-11-25', endDateEditedByUser: false,
    })).toBe('2030-03-01');
  });

  it('clears End together with Start while auto-following', () => {
    expect(nextEndDateOnStartChange({
      startDate: '', currentEndDate: '2029-11-25', endDateEditedByUser: false,
    })).toBe('');
  });

  it('stops following once the user edited End', () => {
    expect(nextEndDateOnStartChange({
      startDate: '2027-03-01', currentEndDate: '2028-06-30', endDateEditedByUser: true,
    })).toBe('2028-06-30');
    expect(nextEndDateOnStartChange({
      startDate: '2027-03-01', currentEndDate: undefined, endDateEditedByUser: true,
    })).toBe('');
  });
});

describe('project end-date labels (PR-061)', () => {
  it('shows "ללא תאריך סיום" instead of "Dec 9999"', () => {
    expect(NO_END_DATE_LABEL).toBe('ללא תאריך סיום');
    expect(formatProjectEndDate('9999-12-31T00:00:00.000Z')).toBe(NO_END_DATE_LABEL);
    expect(formatProjectEndDate(null)).toBe(NO_END_DATE_LABEL);
  });

  it('formats a real end date as month + year', () => {
    expect(formatProjectEndDate('2029-11-25T12:00:00.000Z')).toBe('Nov 2029');
  });

  it('builds the header timeline', () => {
    expect(formatProjectTimeline('2026-11-25T12:00:00.000Z', '2029-11-25T12:00:00.000Z'))
      .toBe('Nov 2026 – Nov 2029');
    expect(formatProjectTimeline('2026-11-25T12:00:00.000Z', '9999-12-31T00:00:00.000Z'))
      .toBe(`Nov 2026 – ${NO_END_DATE_LABEL}`);
    expect(formatProjectTimeline('2026-11-25T12:00:00.000Z', null))
      .toBe(`Nov 2026 – ${NO_END_DATE_LABEL}`);
    expect(formatProjectTimeline(null, '9999-12-31')).toBe(NO_END_DATE_LABEL);
    expect(formatProjectTimeline(null, '2029-11-25T12:00:00.000Z')).toBe('Nov 2029');
    expect(formatProjectTimeline(null, null)).toBeNull();
  });

  it('never uses a long dash', () => {
    const t = formatProjectTimeline('2026-11-25T12:00:00.000Z', '2029-11-25T12:00:00.000Z');
    expect(t).not.toContain('—');
  });
});
