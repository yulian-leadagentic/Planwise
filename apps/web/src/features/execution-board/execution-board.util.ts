/**
 * Pure helpers for the Execution Board matrix. Extracted from the page
 * component so they can be unit-tested independently of React.
 */

const SERVICE_RE = /^\[SERVICE:(.+)\]$/;

export interface TaskLike {
  id: number;
  zoneId: number;
  description?: string | null;
  serviceType?: { name: string } | null;
}

export interface ZoneNodeLike {
  id: number;
  children: ZoneNodeLike[];
}

/**
 * Resolves the phase/milestone column a task belongs to. Priority:
 *  1. task.serviceType.name (DB-linked)
 *  2. [SERVICE:...] marker inside task.description (legacy/template flow)
 *  3. null → placed in the "No Phase" column
 */
export function getTaskPhaseName(task: TaskLike): string | null {
  if (task.serviceType?.name) return task.serviceType.name;
  const m = task.description?.match(SERVICE_RE);
  return m ? m[1] : null;
}

/**
 * Builds a map from zoneId → descendant zone IDs (including self), by
 * walking the zone tree once. Used so a parent-zone cell can aggregate
 * all of its children's tasks in O(1) later.
 */
export function buildZoneDescendants(
  zonesByProject: Record<number, ZoneNodeLike[]>,
): Map<number, number[]> {
  const map = new Map<number, number[]>();

  function collect(node: ZoneNodeLike): number[] {
    const ids = [node.id];
    for (const child of node.children ?? []) {
      ids.push(...collect(child));
    }
    map.set(node.id, ids);
    return ids;
  }

  for (const roots of Object.values(zonesByProject)) {
    for (const root of roots ?? []) collect(root);
  }
  return map;
}

/**
 * Builds the zone × phase → tasks matrix from a flat task list.
 * Key format: `${zoneId}|${phaseName}` where phaseName is the result of
 * getTaskPhaseName or `'__none__'` for tasks with no phase.
 */
export function buildTaskMatrix<T extends TaskLike>(tasks: T[]): Map<string, T[]> {
  const matrix = new Map<string, T[]>();
  for (const task of tasks) {
    const phaseName = getTaskPhaseName(task) ?? '__none__';
    const key = `${task.zoneId}|${phaseName}`;
    if (!matrix.has(key)) matrix.set(key, []);
    matrix.get(key)!.push(task);
  }
  return matrix;
}

/**
 * Returns all tasks under a zone (including tasks in descendant zones) for
 * a given phase, using a pre-built descendant map and task matrix.
 */
export function aggregateCellTasks<T>(
  zoneId: number,
  phaseName: string,
  descendants: Map<number, number[]>,
  matrix: Map<string, T[]>,
): T[] {
  const descIds = descendants.get(zoneId) ?? [zoneId];
  const result: T[] = [];
  for (const id of descIds) {
    const tasks = matrix.get(`${id}|${phaseName}`);
    if (tasks) result.push(...tasks);
  }
  return result;
}

/**
 * Returns the ordered list of phase-name column headers for the board.
 * Templates set the canonical order; any extra phase names that appear
 * in tasks but not templates are appended in insertion order.
 */
export function computePhaseColumns(
  tasks: TaskLike[],
  templateNames: string[],
): { columns: string[]; hasNoPhase: boolean } {
  const present = new Set<string>();
  let hasNoPhase = false;
  for (const task of tasks) {
    const name = getTaskPhaseName(task);
    if (name) present.add(name);
    else hasNoPhase = true;
  }
  const ordered: string[] = [];
  for (const n of templateNames) if (present.has(n)) ordered.push(n);
  for (const n of present) if (!ordered.includes(n)) ordered.push(n);
  return { columns: ordered, hasNoPhase };
}
