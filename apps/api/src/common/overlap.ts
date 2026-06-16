/**
 * Pure helpers for overlap detection.
 *
 * Used in two places:
 *  - TimeEntry create/update: a user can't log two time slots that overlap
 *    on the same day. (Implementation lives in time-entries.service.ts and
 *    uses minutesOverlap below.)
 *  - TaskAssignee add: a user can't be active on two tasks whose date
 *    ranges overlap. (Implementation in tasks.service.ts uses dateRangesOverlap.)
 *
 * Policy decision (2026-06-14, "No overlap"): both flavours are hard rejects.
 * No `confirmOverlap` escape — the previous flag is removed.
 */

/**
 * Open-interval overlap on minutes-since-midnight. Adjacent intervals
 * (09:00-10:00 then 10:00-11:00) are NOT considered overlapping — they
 * share an instant, not a slot.
 */
export function minutesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Closed-interval overlap on day-resolution dates. Tasks span calendar
 * days, so we treat [start, end] as inclusive on both ends — a task
 * ending Mon and a task starting Mon DO overlap (they share Monday).
 *
 * Null semantics:
 *  - null start → treat as -Infinity (task is "open from the past")
 *  - null end   → treat as +Infinity (task is "open-ended into the future")
 *
 * That matches how PMs use the system: a task with only a due date is
 * something that needs doing by date X but might be worked on at any
 * time before. Treating it as ongoing makes any overlapping assignment
 * a real conflict, which is the conservative thing to enforce.
 */
export function dateRangesOverlap(
  aStart: Date | null,
  aEnd: Date | null,
  bStart: Date | null,
  bEnd: Date | null,
): boolean {
  const aS = aStart ? aStart.getTime() : -Infinity;
  const aE = aEnd ? aEnd.getTime() : Infinity;
  const bS = bStart ? bStart.getTime() : -Infinity;
  const bE = bEnd ? bEnd.getTime() : Infinity;
  return aS <= bE && bS <= aE;
}
