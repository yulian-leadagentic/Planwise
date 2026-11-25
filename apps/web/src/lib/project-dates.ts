/**
 * QA6 PR-061 — open-ended projects.
 *
 * Projects imported without an end date carry the sentinel 9999-12-31.
 * Counting days to it gives "2912116d left"; such a project has no end
 * date, says so ("ללא תאריך סיום"), and never gets a days-left figure.
 *
 * Any end date from year OPEN_ENDED_FROM_YEAR on is the sentinel (a
 * margin, so a timezone shift of 9999-12-31 or a 9000-01-01 variant
 * still counts). A missing date is NOT open-ended here: callers that
 * want "no end date" for null too use `hasNoEndDate`.
 */

export const OPEN_ENDED_FROM_YEAR = 9000;
export const NO_END_DATE_LABEL = 'ללא תאריך סיום';

function toDate(value: string | Date | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The 9999-12-31 "no end date" sentinel (any year ≥ 9000). */
export function isOpenEnded(endDate: string | Date | null | undefined): boolean {
  const d = toDate(endDate);
  return d != null && d.getUTCFullYear() >= OPEN_ENDED_FROM_YEAR;
}

/** No usable end date: missing, invalid, or the open-ended sentinel. */
export function hasNoEndDate(endDate: string | Date | null | undefined): boolean {
  return toDate(endDate) == null || isOpenEnded(endDate);
}

/**
 * Whole days from `now` to the end date (negative = past). Null when the
 * project has no usable end date — never computed for an open-ended one.
 */
export function daysLeft(endDate: string | Date | null | undefined, now: Date = new Date()): number | null {
  const d = toDate(endDate);
  if (d == null || isOpenEnded(d)) return null;
  return Math.round((d.getTime() - now.getTime()) / 86_400_000);
}

/**
 * The Operations days-left text: "12d left", "5d overdue", the
 * no-end-date label for an open-ended project, or "—" when nothing is
 * known. Pass `days` when the API already computed it.
 */
export function formatDaysLeft(
  endDate: string | Date | null | undefined,
  days: number | null | undefined = daysLeft(endDate),
): string {
  if (isOpenEnded(endDate)) return NO_END_DATE_LABEL;
  if (days == null) return '—';
  return days < 0 ? `${Math.abs(days)}d overdue` : `${days}d left`;
}
