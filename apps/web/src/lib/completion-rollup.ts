/**
 * Canonical completion rollup + per-task value for the web.
 *
 * ─── ONE FORMULA, MANY SURFACES ─────────────────────────────────────────
 * Both are used from every progress surface — Execution Board's
 * CellSummary, planning-modal's zone header, and any future rollup
 * on the web. Per-task value is now computed at READ time from status
 * + logged + budget so a stale stored `task.completionPct` on a
 * completed task can no longer collapse the whole bucket to 0
 * (the "9/11 done · 0%" repro on the BIM management service).
 *
 * The formula MUST stay identical to the API-side helper at
 * `apps/api/src/common/task-completion.ts` and to the write-time
 * paths (`syncTaskCompletion`, `recomputeCompletionPct`) so the
 * project header, list Completion, cell summary, and zone header
 * always agree on ONE number.
 *
 *   • completed / cancelled  → 100
 *   • in_review              → 90
 *   • else with budget > 0   → min(80, round(loggedHours / budget × 80))
 *   • else                   → 0
 *
 * Bucket rule: budget-hours-weighted average of the per-task values,
 * with a simple-mean fallback when the whole bucket has zero total
 * budget hours (PR-014 — a bucket of Done tasks with no budget still
 * reads 100).
 */

export interface TaskCompletionInput {
  status?: string | null;
  loggedMinutes?: number | string | null;
  /** Accepts number, string (Prisma Decimal-serialized), or nullish. */
  budgetHours?: unknown;
  /** Legacy field — accepted for backwards-compat callers that still
   *  hand it in, but IGNORED. The value is now derived from status +
   *  logged + budget at read time to defeat stale writes. */
  completionPct?: number | null;
}

/**
 * Per-task completion value (0-100). Status-aware, defensive against
 * a stale stored `completionPct` — always recomputed. Mirror of
 * `apps/api/src/common/task-completion.ts#taskCompletionValue`.
 */
export function taskCompletionValue(task: TaskCompletionInput): number {
  if (task.status === 'completed' || task.status === 'cancelled') return 100;
  if (task.status === 'in_review') return 90;
  const budget = Number(task.budgetHours ?? 0);
  if (!Number.isFinite(budget) || budget <= 0) return 0;
  const loggedHours = Number(task.loggedMinutes ?? 0) / 60;
  if (!Number.isFinite(loggedHours) || loggedHours <= 0) return 0;
  return Math.min(80, Math.round((loggedHours / budget) * 80));
}

/**
 * Bucket completion (0-100). Budget-hours-weighted average of per-task
 * values, with a simple-mean fallback when the whole bucket has zero
 * total budget hours (PR-014).
 *
 * The legacy `{ completionPct }`-only shape is still accepted — the
 * status-aware branches make the field redundant, but old call sites
 * (e.g. planning-modal / cell-summary before this rewire) can keep
 * calling without a code change while status/loggedMinutes are threaded
 * through. Once all callers pass status + loggedMinutes, the field can
 * be dropped from the interface.
 */
export function rollupCompletion(tasks: readonly TaskCompletionInput[]): number {
  if (tasks.length === 0) return 0;

  let weightedSum = 0;
  let valueSum = 0;
  let totalBudget = 0;
  for (const t of tasks) {
    const value = taskCompletionValue(t);
    const budget = Number(t.budgetHours ?? 0);
    valueSum += value;
    if (Number.isFinite(budget) && budget > 0) {
      weightedSum += value * budget;
      totalBudget += budget;
    }
  }

  return totalBudget > 0
    ? Math.round(weightedSum / totalBudget)
    : Math.round(valueSum / tasks.length);
}
