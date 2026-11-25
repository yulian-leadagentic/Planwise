import { describe, expect, it, vi, beforeEach } from 'vitest';

const get = vi.fn();
vi.mock('./client', () => ({ default: { get: (...args: unknown[]) => get(...args) } }));

import { tasksApi, myTasksFromResponse } from './tasks.api';

/**
 * QA6 P0 — "/my-tasks showed 0 of 0 while the Dashboard showed 3".
 * My Tasks, the Tasks page and the weekly timesheet share the React
 * Query key ['tasks', 'mine']. The Tasks page cached the raw envelope
 * and My Tasks treats anything but an array as "no tasks", so the
 * shared fetcher must always resolve to the array itself.
 */
describe('tasksApi.mine', () => {
  beforeEach(() => get.mockReset());

  it('unwraps the { success, data } envelope to the task array', async () => {
    get.mockResolvedValue({ data: { success: true, data: [{ id: 1 }, { id: 2 }] } });
    await expect(tasksApi.mine()).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(get).toHaveBeenCalledWith('/tasks/mine');
  });

  it('what one screen caches is what My Tasks reads (an array, never the envelope)', async () => {
    get.mockResolvedValue({ data: { success: true, data: [{ id: 7 }] } });
    const cached = await tasksApi.mine();
    // my-tasks-kanban: `Array.isArray(tasksData) ? tasksData : []`
    expect(Array.isArray(cached) ? cached : []).toHaveLength(1);
    // tasks-page: `myData?.data ?? myData ?? []`
    expect(cached?.data ?? cached ?? []).toHaveLength(1);
  });
});

describe('myTasksFromResponse', () => {
  it.each([
    [[{ id: 1 }], 1],
    [{ success: true, data: [{ id: 1 }, { id: 2 }] }, 2],
    [{ data: { data: [{ id: 1 }] } }, 1],
    [null, 0],
    [{ success: true, data: null }, 0],
  ])('%j → %i tasks', (body, n) => {
    expect(myTasksFromResponse(body)).toHaveLength(n);
  });
});
