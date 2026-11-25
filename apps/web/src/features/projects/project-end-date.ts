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
 * The open-ended rule lives in `@/lib/project-dates` (single source, shared
 * with Operations): the sentinel is any end date from year 9000 on, and a
 * missing / invalid end date also has "no end date" (`hasNoEndDate`).
 */
import { addYears, format, isValid, parseISO } from 'date-fns';
import { hasNoEndDate, NO_END_DATE_LABEL } from '@/lib/project-dates';
import { formatShortDate } from './project-detail/utils';

export { NO_END_DATE_LABEL, OPEN_ENDED_FROM_YEAR, hasNoEndDate } from '@/lib/project-dates';

/**
 * The form / header sense of "open-ended": no real end date at all —
 * missing, blank, unparsable, or the sentinel (year >= 9000). Same as
 * `hasNoEndDate` in `@/lib/project-dates`; note that lib's own
 * `isOpenEnded` is the sentinel only (null there is not open-ended).
 */
export const isOpenEnded = hasNoEndDate;

/** Far-future sentinel older projects were saved with. */
export const OPEN_ENDED_END_DATE = '9999-12-31';

/** PR-061 decision: a new project runs 3 years by default. */
export const DEFAULT_PROJECT_DURATION_YEARS = 3;

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
  if (hasNoEndDate(endDate)) return NO_END_DATE_LABEL;
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
