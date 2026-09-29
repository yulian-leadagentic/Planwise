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

// Shared token classes — DN-2 round 4 (2026-09-29). Aligns to the target
// screenshot at `docs/bm2/assets/dn2-brief-target.png`: every tile is a
// 2-line footprint (label + inline value line with `·` separators), so
// heights are uniform across the strip. `divide-x` between tiles.
const itemCls =
  'flex flex-1 flex-col justify-center gap-0.5 min-w-[160px] px-5 py-1 first:pl-0 last:pr-0';
const labelCls =
  'text-[11px] font-semibold tracking-wide uppercase text-slate-400 dark:text-slate-500';
const moneyValueCls =
  'font-mono text-[15px] font-bold text-slate-900 dark:text-slate-100 tabular-nums';
const nonMoneyValueCls =
  'text-[15px] font-bold text-slate-900 dark:text-slate-100';
const subtextCls = 'text-[11px] font-medium text-slate-500 dark:text-slate-400 tabular-nums';
const gatedPlaceholderCls =
  'font-mono text-[15px] font-bold text-slate-300 dark:text-slate-600 tabular-nums';

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
    <div className="mt-3 flex flex-wrap items-stretch rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-5 py-3 divide-x divide-slate-200 dark:divide-slate-700">
      {/* CONTRACT */}
      <div
        className={itemCls}
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

      {/* EST. AMOUNT — money value + counts inline on one row so every
          tile in the strip has the same 2-line footprint (label + value). */}
      <div
        className={itemCls}
        title="Estimated amount = Σ of every task's budget amount across the plan (₪). Shown with task count and total budget hours."
      >
        <div className={labelCls}>EST. AMOUNT</div>
        <div className="flex items-baseline gap-1.5">
          {showFinance ? (
            <span className={moneyValueCls}>
              &#8362;{formatBudget(totalBudgetAmount)}
            </span>
          ) : (
            <span className={gatedPlaceholderCls} title="Finance-gated">—</span>
          )}
          <span className={subtextCls}>
            · {taskCount} task{taskCount === 1 ? '' : 's'} · {formatHours(totalBudgetHours)}
          </span>
        </div>
      </div>

      {/* LOGGED COST — money value + tasks-with-logged + hours on one row. */}
      <div
        className={itemCls}
        title="Logged cost (actual labor cost) = Σ (logged hours × the effective hourly rate at each time entry's date). Shown with the number of tasks with logged time and total logged hours."
      >
        <div className={labelCls}>LOGGED COST</div>
        <div className="flex items-baseline gap-1.5">
          {showFinance ? (
            <span className={moneyValueCls}>
              &#8362;{formatBudget(actualCostNum)}
            </span>
          ) : (
            <span className={gatedPlaceholderCls} title="Finance-gated">—</span>
          )}
          <span className={subtextCls}>
            · {tasksWithLogged} task{tasksWithLogged === 1 ? '' : 's'} · {formatHours(totalLoggedHours)}
            {utilization != null ? ` · ${utilization}% of contract` : ''}
          </span>
        </div>
      </div>

      {/* PROGRESS — visible to all (not money). % + bar inline (2-line
          footprint matches the other tiles). */}
      <div className={itemCls} title="Progress = logged hours ÷ budget hours.">
        <div className={labelCls}>PROGRESS</div>
        <div className="flex items-center gap-2">
          <span className={nonMoneyValueCls}>{progressPctRaw}%</span>
          <span className="h-1.5 w-24 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
            <span
              className="block h-full rounded-full bg-blue-600 dark:bg-blue-500 transition-all"
              style={{ width: `${progressBarPct}%` }}
            />
          </span>
        </div>
      </div>

      {/* AUTHORING TOOL — visible to all. Uses the accent color per the
          DN-2 target (subtle brand highlight; not a link, no interaction). */}
      <div className={itemCls}>
        <div className={labelCls}>AUTHORING TOOL</div>
        {authoringToolVersion ? (
          <div className="text-[15px] font-bold text-blue-600 dark:text-blue-400">
            {authoringToolVersion}
          </div>
        ) : (
          <div className="text-[15px] font-bold text-slate-300 dark:text-slate-600">—</div>
        )}
      </div>
    </div>
  );
}
