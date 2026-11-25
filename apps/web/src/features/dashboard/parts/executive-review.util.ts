/**
 * QA6 PR-080 — Executive Review helpers: the department filter (from the
 * project's org unit, as the API sends it) and progressive rendering of
 * the full task list (all rows are loaded; the DOM grows as you scroll).
 */

export const NO_DEPARTMENT = '__none__';
export const NO_DEPARTMENT_LABEL = '(no department)';
/** Rows added to the DOM per step. */
export const RENDER_STEP = 150;

type WithDepartment = { project: { department: { id: number; name: string } | null } | null };

export function departmentOf(t: WithDepartment): string | null {
  return t.project?.department?.name ?? null;
}

/** Departments present in the loaded rows, A→Z, "(no department)" last. */
export function departmentOptions(tasks: WithDepartment[]): Array<{ value: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  let none = 0;
  for (const t of tasks) {
    const d = departmentOf(t);
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
    else none++;
  }
  const opts = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ value: name, label: name, count }));
  if (none > 0) opts.push({ value: NO_DEPARTMENT, label: NO_DEPARTMENT_LABEL, count: none });
  return opts;
}

/** '' = every department. */
export function matchesDepartment(t: WithDepartment, filter: string): boolean {
  if (!filter) return true;
  const d = departmentOf(t);
  return filter === NO_DEPARTMENT ? d == null : d === filter;
}

/**
 * Keep the first `limit` rows across the groups, in order. Every group
 * keeps its full `total` for the header count.
 */
export function windowGroups<T>(groups: Array<{ key: string; tasks: T[] }>, limit: number): Array<{ key: string; tasks: T[]; total: number }> {
  const out: Array<{ key: string; tasks: T[]; total: number }> = [];
  let left = Math.max(0, limit);
  for (const g of groups) {
    if (left <= 0) break;
    const rows = g.tasks.slice(0, left);
    left -= rows.length;
    out.push({ key: g.key, tasks: rows, total: g.tasks.length });
  }
  return out;
}

/** "341 tasks" · "120 of 341 tasks" (filtered) · "Showing 10000 of 12000" (guardrail). */
export function countLabel(opts: { loaded: number; total: number; shown: number; truncated?: boolean }): string {
  const { loaded, total, shown, truncated } = opts;
  if (truncated) return `Showing ${loaded} of ${total}`;
  const plural = (n: number) => `${n} task${n === 1 ? '' : 's'}`;
  return shown === loaded ? plural(total) : `${shown} of ${plural(total)}`;
}
