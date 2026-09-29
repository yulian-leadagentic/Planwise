/**
 * Project brief tiles — the 5-tile row below the project header
 * (DN-2 · 2026-09-29). Replaces the earlier inline "Contract Budget /
 * Labor Cost / Cost Utilization" chip strip.
 *
 * Tiles (left → right): CONTRACT · EST. AMOUNT · LOGGED COST ·
 * PROGRESS · AUTHORING TOOL.
 *
 * Data sources — no recompute:
 *   - CONTRACT              → `project.budget` (already on the detail
 *                             response; finance-gated by the server via
 *                             `omitBudget`).
 *   - EST. AMOUNT (₪) / N tasks / Σ budget hours
 *                           → `/projects/:id/planning-data` →
 *                             `budgetSummary.totalAmount`, `tasks.length`,
 *                             `budgetSummary.totalHours`. Same rollup the
 *                             planning grid uses; the query key mirrors
 *                             the planning modal so cache is shared.
 *   - LOGGED COST (₪)       → `project.actualCost` (server sums Σ hours ×
 *                             effective rate via `computeProjectActualCost`
 *                             — the same engine the Labor Cost tab uses).
 *   - LOGGED COST subtext   → tasks-with-logged-time count derived from
 *                             per-task `loggedMinutes > 0` on the
 *                             planning-data payload; Σ logged hours from
 *                             `budgetSummary.totalLoggedHours`.
 *   - Cost Utilization      → `actualCost ÷ contract × 100` (rounded).
 *                             Renders as muted subtext under LOGGED COST,
 *                             not its own tile.
 *   - PROGRESS              → `totalLoggedHours ÷ totalHours × 100`.
 *   - AUTHORING TOOL        → `project.authoringToolVersion`.
 *
 * Finance gate: CONTRACT / EST. AMOUNT's ₪ / LOGGED COST's ₪ + its
 * Cost-Utilization subtext render only when `showFinance` is true.
 * The tile shells still show for non-finance users so the layout stays
 * stable; the ₪ line collapses to a muted em-dash. Task/hour counts +
 * PROGRESS + AUTHORING TOOL stay visible to all.
 */

import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import { formatBudget } from './utils';

interface ProjectBriefTilesProps {
  projectId: number;
  contract: number | null;
  actualCost: number | null | undefined;
  authoringToolVersion: string | null | undefined;
  showFinance: boolean;
}

interface PlanningTaskLite {
  id: number;
  loggedMinutes?: number | null;
}

interface PlanningDataLite {
  tasks?: PlanningTaskLite[];
  budgetSummary?: {
    totalHours?: number;
    totalAmount?: number;
    totalLoggedMinutes?: number;
    totalLoggedHours?: number;
  };
}

function useProjectBrief(projectId: number) {
  return useQuery<PlanningDataLite>({
    // Same key the planning modal uses — no duplicate fetches.
    queryKey: ['planning', projectId],
    queryFn: () =>
      client
        .get(`/projects/${projectId}/planning-data`)
        .then((r) => r.data?.data ?? r.data),
    enabled: !!projectId,
    staleTime: 30 * 1000,
  });
}

function formatHours(hours: number): string {
  return `${hours.toLocaleString('en-US', { maximumFractionDigits: 1 })}h`;
}

// Shared token classes — mirrored from the design decisions in DN-2.
const tileShell =
  'rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3';
const labelCls =
  'text-[11px] font-semibold tracking-wide uppercase text-slate-500 dark:text-slate-400';
const moneyValueCls =
  'mt-1 font-mono text-lg font-semibold text-slate-900 dark:text-slate-100 tabular-nums';
const nonMoneyValueCls =
  'mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100';
const subtextCls = 'mt-0.5 text-[11px] text-slate-500 dark:text-slate-400';
const gatedPlaceholderCls =
  'mt-1 font-mono text-lg font-semibold text-slate-300 dark:text-slate-600 tabular-nums';

export function ProjectBriefTiles({
  projectId,
  contract,
  actualCost,
  authoringToolVersion,
  showFinance,
}: ProjectBriefTilesProps) {
  const { data } = useProjectBrief(projectId);

  const tasks = data?.tasks ?? [];
  const taskCount = tasks.length;
  const tasksWithLogged = tasks.filter(
    (t) => Number(t?.loggedMinutes ?? 0) > 0,
  ).length;
  const totalBudgetHours = Number(data?.budgetSummary?.totalHours ?? 0);
  const totalBudgetAmount = Number(data?.budgetSummary?.totalAmount ?? 0);
  const totalLoggedHours = Number(data?.budgetSummary?.totalLoggedHours ?? 0);

  const contractNum = Number(contract ?? 0);
  const actualCostNum = Number(actualCost ?? 0);
  const utilization =
    showFinance && contractNum > 0
      ? Math.round((actualCostNum / contractNum) * 100)
      : null;

  // Progress = logged hours ÷ budget hours (bar clamped to 100%; the
  // primary % may overshoot — that's the intended signal when the team
  // burned more hours than budgeted).
  const progressPctRaw =
    totalBudgetHours > 0
      ? Math.round((totalLoggedHours / totalBudgetHours) * 100)
      : 0;
  const progressBarPct = Math.min(100, Math.max(0, progressPctRaw));

  return (
    <div className="mt-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
      {/* CONTRACT */}
      <div
        className={tileShell}
        title="Contract budget — the fixed contract value on the project record."
      >
        <div className={labelCls}>CONTRACT</div>
        {showFinance ? (
          <div className={moneyValueCls}>
            &#8362;{formatBudget(contractNum)}
          </div>
        ) : (
          <div className={gatedPlaceholderCls} title="Finance-gated">—</div>
        )}
      </div>

      {/* EST. AMOUNT */}
      <div
        className={tileShell}
        title="Estimated amount = Σ of every task's budget amount across the plan (₪). Shown with task count and total budget hours."
      >
        <div className={labelCls}>EST. AMOUNT</div>
        {showFinance ? (
          <div className={moneyValueCls}>
            &#8362;{formatBudget(totalBudgetAmount)}
          </div>
        ) : (
          <div className={gatedPlaceholderCls} title="Finance-gated">—</div>
        )}
        <div className={subtextCls}>
          {taskCount} task{taskCount === 1 ? '' : 's'} · {formatHours(totalBudgetHours)}
        </div>
      </div>

      {/* LOGGED COST */}
      <div
        className={tileShell}
        title="Logged cost (actual labor cost) = Σ (logged hours × the effective hourly rate at each time entry's date). Shown with the number of tasks with logged time and total logged hours."
      >
        <div className={labelCls}>LOGGED COST</div>
        {showFinance ? (
          <>
            <div className={moneyValueCls}>
              &#8362;{formatBudget(actualCostNum)}
            </div>
            {utilization != null && (
              <div className={subtextCls}>{utilization}% of contract</div>
            )}
          </>
        ) : (
          <div className={gatedPlaceholderCls} title="Finance-gated">—</div>
        )}
        <div className={subtextCls}>
          {tasksWithLogged} task{tasksWithLogged === 1 ? '' : 's'} · {formatHours(totalLoggedHours)}
        </div>
      </div>

      {/* PROGRESS — visible to all (not money). */}
      <div className={tileShell} title="Progress = logged hours ÷ budget hours.">
        <div className={labelCls}>PROGRESS</div>
        <div className={nonMoneyValueCls}>{progressPctRaw}%</div>
        <div className="mt-2 h-1 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
          <div
            className="h-full rounded-full bg-blue-600 dark:bg-blue-500"
            style={{ width: `${progressBarPct}%` }}
          />
        </div>
      </div>

      {/* AUTHORING TOOL — visible to all. */}
      <div className={tileShell}>
        <div className={labelCls}>AUTHORING TOOL</div>
        {authoringToolVersion ? (
          <div className={nonMoneyValueCls}>{authoringToolVersion}</div>
        ) : (
          <div className="mt-1 text-lg font-semibold text-slate-300 dark:text-slate-600">—</div>
        )}
      </div>
    </div>
  );
}
