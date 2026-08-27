/**
 * Canonical per-task completion value + bucket rollup.
 *
 * ─── PROBLEM THIS SOLVES ────────────────────────────────────────────────
 * Every progress rollup (Execution Board cell, planning-modal zone header,
 * projects-list Completion column, project-progress overall/zone) used to
 * TRUST the stored `task.completionPct` scalar. That value is written
 * status-aware on the way in (see `syncTaskCompletion` /
 * `recomputeCompletionPct`), but stale rows exist — data that predates
 * the sync, or a completion set via a code path that skipped it. Any
 * such row is `0` on disk even though its status is `completed`, and
 * the rollup silently drops the whole bucket toward 0 ("9/11 done · 0%"
 * on the BIM management service). We now compute the per-task value at
 * READ TIME from status + logged minutes + budget, so a completed
 * task always contributes 100 regardless of what the scalar says.
 *
 * ─── FORMULA (must stay identical to the WRITE-time formula) ────────────
 *   • completed / cancelled       → 100
 *   • in_review                   → 90
 *   • otherwise, budget > 0       → min(80, round(loggedHours / budget × 80))
 *   • otherwise (no budget)       → 0
 *
 * The upper cap of 80 is intentional: even fully-reported hours can't
 * "look done" — the last 20% is a workflow signal (review + sign-off),
 * not a time signal. Sources this MUST match:
 *   • `apps/api/src/modules/time/time-entries.service.ts` → syncTaskCompletion
 *   • `apps/api/src/modules/tasks/tasks.service.ts`      → recomputeCompletionPct
 *   • `apps/web/src/lib/task-health.ts`                   → computedPct
 *   • `apps/web/src/lib/completion-rollup.ts`             → taskCompletionValue
 *
 * ─── BUCKET RULE ────────────────────────────────────────────────────────
 * Budget-hours-weighted average of the per-task values, with a simple-mean
 * fallback when the whole bucket has zero total budget hours (PR-014 —
 * a bucket of Done tasks with no budget still reads 100, not 0/0). Matches
 * the pre-existing rollup shape in `execution-planning.service` /
 * `projects.service` / the web helper. Kept identical across API + web so
 * the two sides can never drift.
 */

export interface TaskCompletionInput {
  status: string;
  /** Sum of TimeEntry.minutes for this task, deletedAt is null. */
  loggedMinutes?: number | null;
  /**
   * Accepts any of: `number`, Prisma `Decimal`, string, or nullish. The
   * body coerces with `Number(...)` and treats anything non-finite or ≤ 0
   * as "no budget", so callers can pass the raw Prisma value without a
   * pre-cast (Prisma Decimal serializes via `.toString()` and the runtime
   * `Number()` handles that).
   */
  budgetHours?: unknown;
}

/**
 * Per-task completion value (0-100). Status-aware, defensive against
 * a stale stored `completionPct` — always recomputed from the live
 * status / logged / budget triple. See file header for the formula.
 */
export function taskCompletionValue(task: TaskCompletionInput): number {
  if (task.status === 'completed' || task.status === 'cancelled') return 100;
  if (task.status === 'in_review') return 90;
  const budget = Number(task.budgetHours ?? 0);
  if (!Number.isFinite(budget) || budget <= 0) return 0;
  const loggedHours = Number(task.loggedMinutes ?? 0) / 60;
  return Math.min(80, Math.round((loggedHours / budget) * 80));
}

/**
 * Budget-hours-weighted average of per-task completion values, with a
 * simple-mean fallback when the whole bucket has zero total budget
 * hours (PR-014). Empty bucket → 0.
 */
export function rollupTaskCompletion(tasks: readonly TaskCompletionInput[]): number {
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
  if (totalBudget > 0) {
    return Math.round(weightedSum / totalBudget);
  }
  return Math.round(valueSum / tasks.length);
}
