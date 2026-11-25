import { describe, expect, it } from 'vitest';
import { compareDueAscNullsLast, parseKanbanSort, sortKanbanColumn } from './kanban-sort';

const t = (id: number, endDate: string | null, extra: Record<string, unknown> = {}) => ({ id, endDate, ...extra });
const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);

describe('Kanban due-date sort (PR-072)', () => {
  const rows = [
    t(1, null),
    t(2, '2026-12-01T00:00:00.000Z'),
    t(3, '2026-11-10T00:00:00.000Z'),
    t(4, null),
    t(5, '2026-11-20T00:00:00.000Z'),
  ];

  it('orders by due date ascending with no-date tasks last, in every column', () => {
    for (const col of ['not_started', 'in_progress', 'in_review', 'completed']) {
      expect(ids(sortKanbanColumn(col, rows, 'due'))).toEqual([3, 5, 2, 1, 4]);
    }
  });

  it('keeps the incoming order for ties and for no-date tasks', () => {
    const tied = [t(7, '2026-11-20T00:00:00.000Z'), t(6, '2026-11-20T00:00:00.000Z'), t(9, null), t(8, null)];
    expect(ids(sortKanbanColumn('in_review', tied, 'due'))).toEqual([7, 6, 9, 8]);
  });

  it('treats an unparsable date like no date', () => {
    expect(compareDueAscNullsLast({ endDate: 'garbage' }, { endDate: '2026-11-20' })).toBe(1);
    expect(compareDueAscNullsLast({ endDate: null }, { endDate: 'garbage' })).toBe(0);
  });

  it('does not mutate the input', () => {
    const copy = [...rows];
    sortKanbanColumn('in_progress', rows, 'due');
    expect(rows).toEqual(copy);
  });
});

describe('Kanban default sort (unchanged behavior)', () => {
  it('To Do: most urgent first (overdue + critical beats far-out + low)', () => {
    const rows = [
      t(1, '2099-01-01T00:00:00.000Z', { priority: 'low' }),
      t(2, '2000-01-01T00:00:00.000Z', { priority: 'critical' }),
    ];
    expect(ids(sortKanbanColumn('not_started', rows, 'default'))).toEqual([2, 1]);
  });

  it('In Progress: due date ascending, no date last', () => {
    const rows = [t(1, null), t(2, '2026-12-01'), t(3, '2026-11-01')];
    expect(ids(sortKanbanColumn('in_progress', rows, 'default'))).toEqual([3, 2, 1]);
  });

  it('In Review: API order kept', () => {
    const rows = [t(1, '2026-12-01'), t(2, null), t(3, '2026-11-01')];
    expect(ids(sortKanbanColumn('in_review', rows, 'default'))).toEqual([1, 2, 3]);
  });

  it('Done: newest completion first', () => {
    const rows = [
      t(1, null, { updatedAt: '2026-11-20T10:00:00.000Z' }),
      t(2, null, { updatedAt: '2026-11-24T10:00:00.000Z' }),
      t(3, null, { updatedAt: '2026-11-22T10:00:00.000Z' }),
    ];
    expect(ids(sortKanbanColumn('completed', rows, 'default'))).toEqual([2, 3, 1]);
  });
});

describe('parseKanbanSort', () => {
  it('falls back to default for anything unknown', () => {
    expect(parseKanbanSort('due')).toBe('due');
    expect(parseKanbanSort('default')).toBe('default');
    expect(parseKanbanSort(null)).toBe('default');
    expect(parseKanbanSort('weird')).toBe('default');
  });
});
