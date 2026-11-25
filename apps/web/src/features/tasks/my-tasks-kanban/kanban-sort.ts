/**
 * My Tasks Kanban column sorting.
 *
 * - `default`: the board's existing per-column order. To Do by urgency
 *   score (overdue / due soon / priority), In Progress by due date, In
 *   Review in API order, Done newest completion first.
 * - `due` (PR-072): every column by due date ascending, tasks without a
 *   due date last.
 */
import { getTaskScore } from './helpers';

export type KanbanSort = 'default' | 'due';

export const KANBAN_SORT_OPTIONS: ReadonlyArray<{ value: KanbanSort; label: string }> = [
  { value: 'default', label: 'Sort: Default' },
  { value: 'due', label: 'Sort: Due date' },
];

export const KANBAN_SORT_STORAGE_KEY = 'my-tasks.kanban.sort';

export function parseKanbanSort(raw: string | null | undefined): KanbanSort {
  return raw === 'due' ? 'due' : 'default';
}

interface SortableTask {
  endDate?: string | Date | null;
  updatedAt?: string | Date | null;
}

/** Due-date sort key: calendar day as ms, Infinity when missing or bad. */
function dueKey(t: SortableTask): number {
  if (!t.endDate) return Number.POSITIVE_INFINITY;
  const ms = new Date(t.endDate).getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** Due date ascending, nulls last. Ties keep their incoming order. */
export function compareDueAscNullsLast(a: SortableTask, b: SortableTask): number {
  const ak = dueKey(a);
  const bk = dueKey(b);
  if (ak === bk) return 0;
  return ak < bk ? -1 : 1;
}

/** Sorted copy of one column's tasks. */
export function sortKanbanColumn<T extends SortableTask>(columnId: string, tasks: readonly T[], sort: KanbanSort): T[] {
  const out = [...tasks];
  if (sort === 'due') return out.sort(compareDueAscNullsLast);
  if (columnId === 'not_started') return out.sort((a, b) => getTaskScore(b) - getTaskScore(a));
  if (columnId === 'in_progress') return out.sort(compareDueAscNullsLast);
  if (columnId === 'completed') {
    // Newest completions first so the freshest finishes float to the top.
    return out.sort((a, b) => {
      const au = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bu = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bu - au;
    });
  }
  return out;
}
