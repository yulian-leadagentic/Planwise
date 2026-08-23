/**
 * Canonical completion rollup for a bucket of tasks.
 *
 * Per-task `completionPct` is status-aware (100 for completed/cancelled,
 * 90 for in_review, else min(80, round(logged/budget × 80))) and is
 * kept in sync by the API's tasks/time-entries services. Never
 * recompute per-task here — trust the stored value.
 *
 * Bucket rule: budget-hours-weighted average of `completionPct`, with a
 * simple-mean fallback when total budget hours = 0 (so a Done task with
 * no budget still contributes 100 to the average — PR-014 fix).
 *
 * Sourced from planning-modal's HierarchicalZoneGroup (extracted so
 * planning-modal and cell-summary share ONE implementation).
 */
export function rollupCompletion(
  tasks: Array<{ completionPct?: number | null; budgetHours?: number | string | null }>,
): number {
  if (tasks.length === 0) return 0;

  let weightedSum = 0;
  let pctSum = 0;
  let totalHours = 0;
  for (const t of tasks) {
    const pct = Number(t.completionPct || 0);
    const hours = Number(t.budgetHours || 0);
    weightedSum += pct * hours;
    pctSum += pct;
    totalHours += hours;
  }

  return totalHours > 0
    ? Math.round(weightedSum / totalHours)
    : Math.round(pctSum / tasks.length);
}
