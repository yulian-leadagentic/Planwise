/**
 * PR-061 (QA6 package 8): project end-date rules for the project form and
 * the project header.
 *
 * - New projects: End Date fills in as Start Date + 3 years and follows
 *   Start until the user edits End by hand.
 * - Projects saved with the old open-ended sentinel (9999-12-31), or with no
 *   end date at all, show "ללא תאריך סיום" instead of "Dec 9999". We never
 *   compute days left for them.
 *
 * NOTE: the Operations / Executive Review work ships its own
 * `isOpenEnded` in `@/lib/project-dates`. The two are meant to be unified
 * at integration; keep the semantics here identical (null or year >= 9999).
 */
import { addYears, format, isValid, parseISO } from 'date-fns';
import { formatShortDate } from './project-detail/utils';

/** Far-future sentinel older projects were saved with. */
export const OPEN_ENDED_END_DATE = '9999-12-31';

/** Shown wherever a project has no real end date. */
export const NO_END_DATE_LABEL = 'ללא תאריך סיום';

/** PR-061 decision: a new project runs 3 years by default. */
export const DEFAULT_PROJECT_DURATION_YEARS = 3;

/**
 * True when the project has no real end date: missing, blank, unparsable,
 * or the far-future sentinel (any date in year 9999 or later).
 * Reads the year straight from an ISO prefix so a `9999-12-31T00:00:00Z`
 * value can't drift into 9999-12-30 / 10000 through the local timezone.
 */
export function isOpenEnded(endDate: string | Date | null | undefined): boolean {
  if (endDate == null || endDate === '') return true;
  if (typeof endDate === 'string') {
    const m = /^(\d{4,})-/.exec(endDate.trim());
    if (m) return Number(m[1]) >= 9999;
    const d = new Date(endDate);
    return Number.isNaN(d.getTime()) || d.getFullYear() >= 9999;
  }
  return Number.isNaN(endDate.getTime()) || endDate.getFullYear() >= 9999;
}

/**
 * `YYYY-MM-DD` + N years, as `YYYY-MM-DD`. Feb 29 lands on Feb 28 in a
 * non-leap target year. Returns '' for a blank or invalid start so the
 * caller can clear End together with Start.
 */
export function addYearsToIsoDate(isoDate: string | null | undefined, years: number): string {
  if (!isoDate) return '';
  const d = parseISO(isoDate.slice(0, 10));
  if (!isValid(d)) return '';
  return format(addYears(d, years), 'yyyy-MM-dd');
}

/** Default End Date for a new project with the given Start Date. */
export function defaultEndDateFor(startDate: string | null | undefined): string {
  return addYearsToIsoDate(startDate, DEFAULT_PROJECT_DURATION_YEARS);
}

/**
 * New End Date after Start changes in the create form. Follows Start while
 * the user hasn't edited End by hand; once they have, End is left alone.
 */
export function nextEndDateOnStartChange(args: {
  startDate: string | null | undefined;
  currentEndDate: string | null | undefined;
  endDateEditedByUser: boolean;
}): string {
  if (args.endDateEditedByUser) return args.currentEndDate ?? '';
  return defaultEndDateFor(args.startDate);
}

/** Short end-date label for headers, lists and cards ("Nov 2029"). */
export function formatProjectEndDate(endDate: string | null | undefined): string {
  if (isOpenEnded(endDate)) return NO_END_DATE_LABEL;
  return formatShortDate(endDate ?? null) ?? NO_END_DATE_LABEL;
}

/**
 * Header timeline text: "Nov 2026 – Nov 2029", "Nov 2026 – ללא תאריך סיום",
 * or null when the project has neither a start nor an end date.
 */
export function formatProjectTimeline(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): string | null {
  const startLabel = formatShortDate(startDate ?? null);
  if (!startLabel && !endDate) return null;
  const endLabel = formatProjectEndDate(endDate);
  return startLabel ? `${startLabel} – ${endLabel}` : endLabel;
}
