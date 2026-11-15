/**
 * §12 (2026-11-14) · Task date invariant helpers — `estimatedStartDate`
 * must never be stored after `endDate`.
 *
 * Kept as pure functions so the three writers that derive a start from
 * a due date (`ProjectDeliverablesService.batchSetTargets`,
 * `.forceApplyTargetToTask` and `TasksService.update`) share ONE
 * budget-based formula and one definition of "the end moved before the
 * start".
 *
 * All Task date columns are `@db.Date`: Prisma hands them back as
 * midnight-UTC and truncates whatever it is given to the UTC calendar
 * day. Everything here therefore compares and computes on UTC days.
 */

const DAY_MS = 86_400_000;

/** Midnight-UTC copy of `d` (what a `@db.Date` column will store). */
function toUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Budget-based estimated start for a task due on `end`:
 * `end − ceil(budgetHours / 40) weeks`, one week when there is no
 * budget. 40h ≈ one full working week per the client's brief. This is
 * the length `forceApplyTargetToTask` / `batchSetTargets` have always
 * used; it lives here so the fallback below cannot drift from it.
 */
export function budgetBasedEstimatedStart(end: Date, budgetHours: unknown): Date {
  const budgetH = Number(budgetHours ?? 0);
  const weeks = budgetH > 0 ? Math.ceil(budgetH / 40) : 1;
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - weeks * 7);
  return start;
}

/**
 * An update is moving a task's due date WITHOUT saying anything about
 * its estimated start. Returns the start to write alongside the new
 * end, or `undefined` to leave the stored start alone.
 *
 * The start moves only when ALL of these hold:
 *   • the request does not carry `estimatedStartDate` (a caller that
 *     sends it — even `null` — owns it),
 *   • the request sets `endDate` to a non-null day different from the
 *     stored one,
 *   • the stored start would be AFTER that new end.
 *
 * Then the task keeps its previous length — stored end − stored start
 * in calendar days — when that is a valid, non-negative span; a task
 * with no stored end, or one already stored with start > end, has no
 * length to keep and gets the budget-based one instead.
 *
 * Every other end-only edit is a legitimate change of length and is
 * left alone: an end moved later, or earlier but still on/after the
 * start.
 */
export function resolveStartForMovedEnd(args: {
  /** `undefined` = the request has no `endDate`; `null` = it clears it. */
  newEnd: Date | null | undefined;
  /** The request has an `estimatedStartDate` key (any value, incl. null). */
  startProvided: boolean;
  storedStart: Date | null | undefined;
  storedEnd: Date | null | undefined;
  budgetHours: unknown;
}): Date | undefined {
  if (args.startProvided) return undefined;
  if (!args.newEnd || Number.isNaN(args.newEnd.getTime())) return undefined;
  if (!args.storedStart) return undefined;

  const end = toUtcDay(args.newEnd);
  const start = toUtcDay(args.storedStart);
  const oldEnd = args.storedEnd ? toUtcDay(args.storedEnd) : null;

  if (oldEnd && oldEnd.getTime() === end.getTime()) return undefined; // end is not changing
  if (start.getTime() <= end.getTime()) return undefined; // lengthen / shorten — legitimate

  if (oldEnd && oldEnd.getTime() >= start.getTime()) {
    const spanDays = Math.round((oldEnd.getTime() - start.getTime()) / DAY_MS);
    return new Date(end.getTime() - spanDays * DAY_MS);
  }
  return budgetBasedEstimatedStart(end, args.budgetHours);
}
