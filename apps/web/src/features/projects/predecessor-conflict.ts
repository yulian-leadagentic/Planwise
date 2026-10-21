/**
 * Predecessor-conflict helpers (bm2 2026-10-21).
 *
 * A project task has a predecessor conflict when its `endDate` falls
 * BEFORE the `endDate` of at least one of its predecessors — in other
 * words, the dependent task is scheduled to finish before the work it
 * depends on has even wrapped up. Per the PM's request this is a
 * WARNING, not a block: the user can still save the change, they just
 * see a visual signal on screen (banner / toast / inline icon).
 *
 * The helpers accept a loose task shape so the same code can run on
 * every surface that lists tasks — planning rows, kanban cards, Gantt
 * labels, drawer forms. Shape is defined in-line (no @prisma/client
 * dependency) so it is safe to import into any client component.
 *
 * The accompanying BE change (planning.service.ts / tasks.service.ts,
 * same date) adds `endDate` to each `dependencies.dependsOn.select`
 * so the data these helpers read is on the wire everywhere.
 */

export interface PredecessorConflictTaskDep {
  dependsOn?: {
    id?: number;
    code?: string | null;
    name?: string | null;
    endDate?: string | Date | null;
  } | null;
}

export interface PredecessorConflictTask {
  endDate?: string | Date | null;
  dependencies?: PredecessorConflictTaskDep[] | null;
}

/**
 * Returns true when the task's endDate is earlier than at least one of
 * its predecessors'. Missing dates (task.endDate null, predecessor
 * endDate null, unparseable string) are treated as "no conflict" — a
 * conflict needs two concrete dates to compare.
 */
export function hasPredecessorConflict(task: PredecessorConflictTask | null | undefined): boolean {
  if (!task?.endDate) return false;
  const deps = task.dependencies;
  if (!Array.isArray(deps) || deps.length === 0) return false;
  const myEnd = new Date(task.endDate as any).getTime();
  if (!Number.isFinite(myEnd)) return false;
  return deps.some((d) => {
    const pEnd = d?.dependsOn?.endDate;
    if (!pEnd) return false;
    const pTime = new Date(pEnd as any).getTime();
    return Number.isFinite(pTime) && myEnd < pTime;
  });
}

/**
 * Of all predecessors whose endDate is AFTER this task's endDate,
 * returns the one that finishes LATEST (the "most out-of-order" link,
 * which is the one the PM will have to deal with first). null when
 * there is no conflict.
 */
export function getLatestConflictingPredecessor(
  task: PredecessorConflictTask | null | undefined,
): { id: number | null; name: string; endDate: string } | null {
  if (!task?.endDate) return null;
  const deps = task.dependencies;
  if (!Array.isArray(deps) || deps.length === 0) return null;
  const myEnd = new Date(task.endDate as any).getTime();
  if (!Number.isFinite(myEnd)) return null;
  let worst: { id: number | null; name: string; endDate: string; t: number } | null = null;
  for (const d of deps) {
    const dep = d?.dependsOn;
    if (!dep?.endDate) continue;
    const t = new Date(dep.endDate as any).getTime();
    if (!Number.isFinite(t)) continue;
    if (t <= myEnd) continue;
    if (!worst || t > worst.t) {
      worst = {
        id: dep.id ?? null,
        name: dep.name ?? dep.code ?? `#${dep.id ?? '?'}`,
        endDate: String(dep.endDate).slice(0, 10),
        t,
      };
    }
  }
  return worst ? { id: worst.id, name: worst.name, endDate: worst.endDate } : null;
}

/**
 * Human-readable Hebrew message describing the latest-conflicting
 * predecessor. Fed to `notify.warning()` on the TaskDrawer save, and
 * also used as the inline-note / tooltip text.
 */
export function getPredecessorConflictMessage(
  task: PredecessorConflictTask | null | undefined,
): string | null {
  if (!task?.endDate) return null;
  const info = getLatestConflictingPredecessor(task);
  if (!info) return null;
  const myEnd = String(task.endDate as any).slice(0, 10);
  return `תאריך סיום (${myEnd}) קודם לתאריך הסיום של משימה מקדימה "${info.name}" (${info.endDate}).`;
}
