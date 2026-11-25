/**
 * QA6 security review (2026-11-25) — Weekly timesheet › Quick task.
 * A refused self-assignment (403 ASSIGNEE_NOT_ON_TEAM) is no longer
 * swallowed: the new task is removed again (or the caller is told it
 * could not be), and the server's error comes back for notify.apiError.
 */
import { describe, expect, it, vi } from 'vitest';

import { createQuickTaskForMe, type QuickTaskHttp } from './quick-task';

const NOT_ON_TEAM = {
  message: 'Request failed with status code 403',
  response: {
    status: 403,
    data: {
      success: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: "Dana Levi is not on this project's team. Only the project leader or an administrator can add someone new to the project.",
        details: { module: 'projects', reason: 'ASSIGNEE_NOT_ON_TEAM' },
      },
    },
  },
};

function http(opts: { zones?: Array<{ id: number }>; assign?: 'ok' | 'refuse'; remove?: 'ok' | 'refuse' } = {}) {
  const h = {
    get: vi.fn(async () => ({ data: { data: { zones: opts.zones ?? [{ id: 580 }, { id: 581 }] } } })),
    post: vi.fn(async (url: string) => {
      if (url === '/tasks') return { data: { data: { id: 77, name: 'Fix clash' } } };
      if (opts.assign === 'refuse') throw NOT_ON_TEAM;
      return { data: { data: { id: 1 } } };
    }),
    delete: vi.fn(async () => {
      if (opts.remove === 'refuse') throw new Error('403');
      return { data: {} };
    }),
  };
  return h as typeof h & QuickTaskHttp;
}

describe('createQuickTaskForMe', () => {
  it('creates the task in the first zone and assigns the current user', async () => {
    const h = http();
    const res = await createQuickTaskForMe(h, { projectId: 58, name: 'Fix clash', userId: 7, code: 'QT-1' });
    expect(res).toEqual({ ok: true, task: { id: 77, name: 'Fix clash' } });
    expect(h.get).toHaveBeenCalledWith('/projects/58/planning-data');
    expect(h.post).toHaveBeenNthCalledWith(1, '/tasks', { zoneId: 580, code: 'QT-1', name: 'Fix clash' });
    expect(h.post).toHaveBeenNthCalledWith(2, '/tasks/77/assignees', { userId: 7 });
    expect(h.delete).not.toHaveBeenCalled();
  });

  it('a refused self-assignment returns the server error and removes the new task', async () => {
    const h = http({ assign: 'refuse' });
    const res = await createQuickTaskForMe(h, { projectId: 58, name: 'Fix clash', userId: 7 });
    expect(res).toMatchObject({ ok: false, reason: 'ASSIGN_FAILED', taskRemoved: true, task: { id: 77 } });
    expect(res.ok === false && res.reason === 'ASSIGN_FAILED' ? res.error : null).toBe(NOT_ON_TEAM);
    expect(h.delete).toHaveBeenCalledWith('/tasks/77');
  });

  it('when the new task cannot be removed either, it says so (never a silent unassigned task)', async () => {
    const h = http({ assign: 'refuse', remove: 'refuse' });
    const res = await createQuickTaskForMe(h, { projectId: 58, name: 'Fix clash', userId: 7 });
    expect(res).toMatchObject({ ok: false, reason: 'ASSIGN_FAILED', taskRemoved: false, task: { id: 77 } });
  });

  it('a project without zones creates nothing', async () => {
    const h = http({ zones: [] });
    await expect(createQuickTaskForMe(h, { projectId: 58, name: 'x', userId: 7 })).resolves.toEqual({ ok: false, reason: 'NO_ZONE' });
    expect(h.post).not.toHaveBeenCalled();
  });
});
