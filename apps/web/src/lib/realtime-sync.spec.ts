/**
 * QA6 P10 · PR-079 — live updates across tabs: which React Query keys an
 * `invalidate` event makes stale, which projects a tab watches, and the
 * debounce that turns a bulk save into one refresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REALTIME_SOCKET_NAMESPACE,
  REALTIME_SOCKET_PATH,
  createInvalidationBatcher,
  desiredProjectIds,
  matchesAnyRealtimeEvent,
  matchesRealtimeEvent,
  parseRealtimeEvent,
  projectIdsFromPath,
  realtimeSocketUrl,
  roomChanges,
  type RealtimeEvent,
} from './realtime-sync';
import { queryKeys } from './query-keys';

const taskUpdated: RealtimeEvent = { type: 'task.updated', projectId: 42, taskId: 7 };
const taskDeleted: RealtimeEvent = { type: 'task.deleted', projectId: 42, taskId: 7 };
const projectUpdated: RealtimeEvent = { type: 'project.updated', projectId: 42 };

const hits = (key: readonly unknown[], event: RealtimeEvent, data?: unknown) => matchesRealtimeEvent(key, data, event);

describe('realtime socket address', () => {
  it('is the API origin + /realtime on the Socket.IO default path', () => {
    expect(REALTIME_SOCKET_PATH).toBe('/socket.io');
    expect(REALTIME_SOCKET_NAMESPACE).toBe('/realtime');
    expect(realtimeSocketUrl('https://api.example.app/', 'https://web.example.app')).toBe('https://api.example.app/realtime');
    expect(realtimeSocketUrl('', 'http://localhost:5173')).toBe('http://localhost:5173/realtime');
  });
});

describe('parseRealtimeEvent', () => {
  it('keeps the ids only', () => {
    expect(parseRealtimeEvent({ type: 'task.updated', projectId: 42, taskId: 7, name: 'x', status: 'done' })).toEqual(taskUpdated);
    expect(parseRealtimeEvent({ type: 'project.updated', projectId: '42', taskId: 7 })).toEqual(projectUpdated);
  });

  it('rejects anything malformed', () => {
    expect(parseRealtimeEvent(null)).toBeNull();
    expect(parseRealtimeEvent({ type: 'task.updated', projectId: 42 })).toBeNull();
    expect(parseRealtimeEvent({ type: 'task.renamed', projectId: 42, taskId: 7 })).toBeNull();
    expect(parseRealtimeEvent({ type: 'project.updated', projectId: 0 })).toBeNull();
  });
});

describe('event → invalidated query keys', () => {
  it('a task change refreshes task lists, my tasks, the task itself, planning, kanban, dashboards, workload and deliverable planning', () => {
    const invalidated: unknown[][] = [
      queryKeys.tasks.list({ projectId: 42 }) as unknown as unknown[],
      queryKeys.tasks.list() as unknown as unknown[],
      ['tasks', 'all', { status: 'todo' }],
      ['tasks', 'archived', 42],
      queryKeys.tasks.mine() as unknown as unknown[],
      ['tasks', { projectId: 42, search: '' }],
      queryKeys.tasks.detail(7) as unknown as unknown[],
      ['tasks', 7],
      ['tasks', 7, 'checklist'],
      ['task-attachments', 7],
      queryKeys.planning.byProject(42) as unknown as unknown[], // planning grid + project kanban
      ['planning-data', 42],
      ['project-deliverables', 42], // Deliverable Planning
      queryKeys.executionBoard.with(42, null) as unknown as unknown[],
      queryKeys.executionBoard.with(null, null) as unknown as unknown[],
      ['dashboard', 'operations', { myDeptOnly: false }],
      ['dashboard', 'operations', 'executive-review', { myDeptOnly: true }],
      ['dashboard', 'manager'],
      ['workload', 'all-users', '2026-11-01', '2026-11-30'],
      ['workload', 'project', 42, '2026-11-01', '2026-11-30'],
      ['activity', 'project', 42],
      ['project-info-summary', 42],
    ];
    for (const key of invalidated) {
      expect({ key, hit: hits(key, taskUpdated) }).toEqual({ key, hit: true });
      expect({ key, hit: hits(key, taskDeleted) }).toEqual({ key, hit: true });
    }
  });

  it('…but not other projects, other tasks, static lookups or project-only data', () => {
    const untouched: unknown[][] = [
      queryKeys.tasks.list({ projectId: 43 }) as unknown as unknown[],
      ['tasks', 'archived', 43],
      ['tasks', { projectId: 43 }],
      queryKeys.tasks.detail(8) as unknown as unknown[],
      ['tasks', 8, 'comments'],
      ['tasks', 'allowed-transitions', 'todo'],
      ['task-attachments', 8],
      queryKeys.planning.byProject(43) as unknown as unknown[],
      ['project-deliverables', 43],
      queryKeys.executionBoard.with(43, null) as unknown as unknown[],
      ['workload', 'project', 43, '2026-11-01', '2026-11-30'],
      ['activity', 'project', 43],
      ['zones', 'tree', 42], // zones change only with project.updated
      ['projects', 42],
      ['project-status-board'],
      ['users', 'all-active'],
      ['messages', 'project', 42],
      ['hr', 'month', 11],
    ];
    for (const key of untouched) {
      expect({ key, hit: hits(key, taskUpdated) }).toEqual({ key, hit: false });
    }
  });

  it('a project-level change (zones, deliverables, targets, due dates) also refreshes zones, the project header and open tasks of that project', () => {
    expect(hits(['zones', 'tree', 42], projectUpdated)).toBe(true);
    expect(hits(['zones', 'for-task-create', 42], projectUpdated)).toBe(true);
    expect(hits(['project-zones', 42], projectUpdated)).toBe(true);
    expect(hits(['projects', 42], projectUpdated)).toBe(true);
    expect(hits(['project-status-board'], projectUpdated)).toBe(true);
    expect(hits(['planning', 42], projectUpdated)).toBe(true);
    expect(hits(['tasks', 'mine'], projectUpdated)).toBe(true);
    // An open task: refreshed when it belongs to the project (or we can't tell).
    expect(hits(queryKeys.tasks.detail(7), projectUpdated, { id: 7, projectId: 42 })).toBe(true);
    expect(hits(['tasks', 7], projectUpdated, { success: true, data: { id: 7, projectId: 42 } })).toBe(true);
    expect(hits(queryKeys.tasks.detail(9), projectUpdated, { id: 9, projectId: 43 })).toBe(false);
    expect(hits(queryKeys.tasks.detail(9), projectUpdated, undefined)).toBe(true);
    // Not other projects, not per-task side data.
    expect(hits(['zones', 'tree', 43], projectUpdated)).toBe(false);
    expect(hits(['projects', 43], projectUpdated)).toBe(false);
    expect(hits(['projects', 42, 'labor-cost'], projectUpdated)).toBe(false);
    expect(hits(['task-attachments', 7], projectUpdated)).toBe(false);
  });

  it('a batch matches when any of its events does', () => {
    const batch = [taskUpdated, { type: 'project.updated', projectId: 43 } as RealtimeEvent];
    expect(matchesAnyRealtimeEvent(['zones', 'tree', 43], undefined, batch)).toBe(true);
    expect(matchesAnyRealtimeEvent(['planning', 42], undefined, batch)).toBe(true);
    expect(matchesAnyRealtimeEvent(['planning', 44], undefined, batch)).toBe(false);
  });
});

describe('watched projects', () => {
  it('reads the project from the URL', () => {
    expect(projectIdsFromPath('/projects/42')).toEqual([42]);
    expect(projectIdsFromPath('/projects/42/planning')).toEqual([42]);
    expect(projectIdsFromPath('/projects/new')).toEqual([]);
    expect(projectIdsFromPath('/tasks/9')).toEqual([]);
  });

  it('URL first, then project-keyed queries, open tasks, then rows of cross-project lists; deduped and capped', () => {
    const active = [
      { queryKey: ['tasks', 'mine'], data: [{ id: 1, projectId: 50 }, { id: 2, project: { id: 51 } }, { id: 3, projectId: null }] },
      { queryKey: ['planning', 44], data: {} },
      { queryKey: queryKeys.tasks.detail(7), data: { id: 7, projectId: 45 } },
      { queryKey: ['tasks', 'list', { projectId: 46 }], data: [{ id: 9, projectId: 46 }] },
      { queryKey: ['users', 'all-active'], data: [{ id: 3, projectId: 99 }] },
      { queryKey: ['execution-board', null, null], data: { data: { tasks: [{ projectId: 52 }] } } },
    ];
    expect(desiredProjectIds('/projects/42/planning', active)).toEqual([42, 44, 46, 45, 50, 51, 52]);
    expect(desiredProjectIds('/projects/42', active, 3)).toEqual([42, 44, 46]);
  });

  it('computes the rooms to join and to leave', () => {
    expect(roomChanges(new Set([1, 2, 3]), [2, 3, 4])).toEqual({ join: [4], leave: [1] });
    expect(roomChanges(new Set(), [])).toEqual({ join: [], leave: [] });
  });
});

describe('invalidation debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a burst (bulk save) becomes one flush, duplicates kept once', () => {
    const onFlush = vi.fn();
    const b = createInvalidationBatcher({ delayMs: 400, maxWaitMs: 2000, onFlush });
    for (let taskId = 1; taskId <= 30; taskId++) {
      b.push({ type: 'task.updated', projectId: 42, taskId });
      vi.advanceTimersByTime(10);
    }
    b.push({ type: 'task.updated', projectId: 42, taskId: 1 });
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(399);
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0]).toHaveLength(30);
    expect(b.pendingCount()).toBe(0);
  });

  it('a steady stream still flushes after maxWait', () => {
    const onFlush = vi.fn();
    const b = createInvalidationBatcher({ delayMs: 400, maxWaitMs: 2000, onFlush });
    for (let i = 0; i < 12; i++) {
      b.push({ type: 'task.updated', projectId: 42, taskId: i + 1 });
      vi.advanceTimersByTime(300); // never 400 ms quiet
    }
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0].length).toBeGreaterThanOrEqual(6);
  });

  it('holds the flush while this tab has a mutation in flight, up to maxDefer', () => {
    const onFlush = vi.fn();
    let busy = true;
    const b = createInvalidationBatcher({ delayMs: 400, maxWaitMs: 2000, maxDeferMs: 5000, isBusy: () => busy, onFlush });
    b.push(taskUpdated);
    vi.advanceTimersByTime(1200);
    expect(onFlush).not.toHaveBeenCalled();
    busy = false;
    vi.advanceTimersByTime(400);
    expect(onFlush).toHaveBeenCalledTimes(1);

    busy = true;
    b.push(projectUpdated);
    vi.advanceTimersByTime(7000 + 400); // maxWait + maxDefer (+ one tick)
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it('flushNow applies at once (tab became visible); cancel drops the batch', () => {
    const onFlush = vi.fn();
    const b = createInvalidationBatcher({ delayMs: 400, maxWaitMs: 2000, onFlush });
    b.push(taskUpdated);
    b.flushNow();
    expect(onFlush).toHaveBeenCalledWith([taskUpdated]);
    b.flushNow();
    expect(onFlush).toHaveBeenCalledTimes(1);

    b.push(projectUpdated);
    b.cancel();
    vi.advanceTimersByTime(5000);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });
});
