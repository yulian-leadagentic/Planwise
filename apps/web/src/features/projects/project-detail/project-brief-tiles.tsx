/**
 * Project brief tiles — the tile row below the project header
 * (DN-2 · 2026-09-29; collapsibility + finance gate · QA5 UI-8).
 *
 * Tiles (left → right): CONTRACT · EST. AMOUNT · LOGGED COST ·
 * PROGRESS. The AUTHORING TOOL tile was removed in UI-8 and the
 * authoring tool value now lives on the Timeline row of the project
 * header (UI-11).
 *
 * Collapsibility (UI-8):
 *   - Finance users: block defaults to OPEN, with a chevron toggle to
 *     collapse/expand. Preference persists per user in localStorage.
 *   - Non-finance users: block defaults to CLOSED and the toggle is
 *     hidden entirely. This supersedes the earlier "show empty tile
 *     shells" behavior — no financial figures (CONTRACT / EST. AMOUNT
 *     ₪ / LOGGED COST ₪) are ever rendered to a non-finance viewer.
 *     Progress is folded into the same block, so it also stays hidden
 *     until the toggle is used (which non-finance users cannot do).
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
 */

import { useQuery } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { formatBudget } from './utils';

interface ProjectBriefTilesProps {
  projectId: number;
  contract: number | null;
  actualCost: number | null | undefined;
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

// localStorage key — scoped to the whole block (not per project) as
// specified in UI-8. One preference across every project the user
// visits, so the operator doesn't have to toggle it on every project.
const COLLAPSE_KEY = 'project.briefTiles.collapsed';

export function ProjectBriefTiles({
  projectId,
  contract,
  actualCost,
  showFinance,
}: ProjectBriefTilesProps) {
  const { data } = useProjectBrief(projectId);

  // UI-8 collapsibility: finance users default-open with a persisted
  // choice; non-finance users are forced-closed regardless of the
  // stored preference and cannot toggle. Lazy initializer so we read
  // localStorage once (SSR-safe via typeof window).
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (!showFinance) return true;
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  // Keep localStorage in sync when a finance user toggles, so the
  // choice survives reloads.
  useEffect(() => {
    if (!showFinance || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore storage errors (quota / private mode) */
    }
  }, [collapsed, showFinance]);

  // Force non-finance users to the closed state in case the stored
  // preference says otherwise (e.g. a user lost finance access mid-
  // session). Belt-and-braces for the gate.
  useEffect(() => {
    if (!showFinance && !collapsed) setCollapsed(true);
  }, [showFinance, collapsed]);

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

  // Collapsed header — a slim bar with just the toggle. For non-finance
  // users we don't render the collapsed-bar at all, since there's no
  // way to open it; dropping it entirely saves the vertical space.
  if (collapsed) {
    if (!showFinance) {
      return null;
    }
    return (
      <div className="mt-3 rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="flex w-full items-center gap-2 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          aria-expanded="false"
          aria-controls="project-brief-tiles"
          title="Show project financial tiles"
        >
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          Financial summary
        </button>
      </div>
    );
  }

  return (
    <div
      id="project-brief-tiles"
      className="mt-3 rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
    >
      {/* Collapse toggle — only shown to finance users; non-finance
          viewers never reach this branch (collapsed=true → return null
          above). */}
      <div className="flex items-center justify-between px-5 pt-2 pb-1">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Financial summary
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200"
          aria-expanded="true"
          aria-controls="project-brief-tiles-body"
          title="Hide project financial tiles"
        >
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          Hide
        </button>
      </div>
      <div
        id="project-brief-tiles-body"
        className={cn(
          'flex flex-wrap items-stretch px-5 pb-3 pt-1 divide-x divide-slate-200 dark:divide-slate-700',
        )}
      >
        {/* CONTRACT */}
        <div
          className={itemCls}
          title="Contract budget — the fixed contract value on the project record."
        >
          <div className={labelCls}>CONTRACT</div>
          <div className={moneyValueCls}>
            &#8362;{formatBudget(contractNum)}
          </div>
        </div>

        {/* EST. AMOUNT */}
        <div
          className={itemCls}
          title="Estimated amount = Σ of every task's budget amount across the plan (₪). Shown with task count and total budget hours."
        >
          <div className={labelCls}>EST. AMOUNT</div>
          <div className="flex items-baseline gap-1.5">
            <span className={moneyValueCls}>
              &#8362;{formatBudget(totalBudgetAmount)}
            </span>
            <span className={subtextCls}>
              · {taskCount} task{taskCount === 1 ? '' : 's'} · {formatHours(totalBudgetHours)}
            </span>
          </div>
        </div>

        {/* LOGGED COST */}
        <div
          className={itemCls}
          title="Logged cost (actual labor cost) = Σ (logged hours × the effective hourly rate at each time entry's date). Shown with the number of tasks with logged time and total logged hours."
        >
          <div className={labelCls}>LOGGED COST</div>
          <div className="flex items-baseline gap-1.5">
            <span className={moneyValueCls}>
              &#8362;{formatBudget(actualCostNum)}
            </span>
            <span className={subtextCls}>
              · {tasksWithLogged} task{tasksWithLogged === 1 ? '' : 's'} · {formatHours(totalLoggedHours)}
              {utilization != null ? ` · ${utilization}% of contract` : ''}
            </span>
          </div>
        </div>

        {/* PROGRESS — folded into the finance-gated block per UI-8
            (resolved: whole block including Progress is finance-gated). */}
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
      </div>
    </div>
  );
}
