/**
 * QA6 P10 · PR-079 — the HTTP side: a successful write on a listed route
 * announces `realtime.invalidate` with the project / task ids it touched;
 * a failed write, a read and an unlisted route announce nothing.
 */
import { Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';

import { RealtimeInvalidationInterceptor } from './realtime.interceptor';
import { REALTIME_INVALIDATE } from './realtime.events';

@Controller('tasks')
class FakeTasksController {
  @Post() create() {}
  @Get(':id') findOne() {}
  @Patch(':id') update() {}
  @Delete(':id') remove() {}
  @Post('reorder') reorder() {}
  @Post(':id/watch') unlisted() {}
}

@Controller('zones')
class FakeZonesController {
  @Post() create() {}
}

function ctx(controller: any, handler: string, req: any) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
    getClass: () => controller,
    getHandler: () => controller.prototype[handler],
  } as any;
}

function setup() {
  const targets = {
    task: jest.fn(async (taskId: number) => ({ projectId: 42, taskId })),
    checklistItem: jest.fn(),
    attachment: jest.fn(),
    zone: jest.fn(),
    deliverable: jest.fn(),
    projectsOf: jest.fn(async () => [{ projectId: 42 }, { projectId: 43 }]),
  };
  const events = { emit: jest.fn() };
  const interceptor = new RealtimeInvalidationInterceptor(targets as any, events as any);
  return { interceptor, targets, events };
}

/** Run the interceptor around a handler result; wait for the detached announce. */
async function run(interceptor: RealtimeInvalidationInterceptor, context: any, handlerResult: () => any) {
  const obs = await interceptor.intercept(context, { handle: () => handlerResult() });
  const value = await lastValueFrom(obs);
  await new Promise((r) => setImmediate(r));
  return value;
}

describe('RealtimeInvalidationInterceptor', () => {
  it('a task status change (PATCH /tasks/:id) announces task.updated for its project', async () => {
    const { interceptor, targets, events } = setup();
    const req = { method: 'PATCH', params: { id: '10' }, body: { status: 'in_progress' } };
    const result = { success: true, data: { id: 10, status: 'in_progress' } };

    await expect(run(interceptor, ctx(FakeTasksController, 'update', req), () => of(result))).resolves.toBe(result);

    expect(targets.task).toHaveBeenCalledWith(10);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(REALTIME_INVALIDATE, { type: 'task.updated', projectId: 42, taskId: 10 });
  });

  it('a failed write announces nothing', async () => {
    const { interceptor, events } = setup();
    const req = { method: 'PATCH', params: { id: '10' }, body: { status: 'done' } };
    await expect(
      run(interceptor, ctx(FakeTasksController, 'update', req), () => throwError(() => new Error('403'))),
    ).rejects.toThrow('403');
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('reads and unlisted writes pass straight through without a lookup', async () => {
    const { interceptor, targets, events } = setup();
    await run(interceptor, ctx(FakeTasksController, 'findOne', { method: 'GET', params: { id: '10' } }), () => of({}));
    await run(interceptor, ctx(FakeTasksController, 'unlisted', { method: 'POST', params: { id: '10' } }), () => of({}));
    expect(targets.task).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('DELETE resolves the project BEFORE the row is gone and announces task.deleted', async () => {
    const { interceptor, targets, events } = setup();
    const order: string[] = [];
    targets.task.mockImplementation(async (taskId: number) => {
      order.push('lookup');
      return { projectId: 42, taskId };
    });
    const req = { method: 'DELETE', params: { id: '10' }, body: {} };
    await run(interceptor, ctx(FakeTasksController, 'remove', req), () => {
      order.push('handler');
      return of({ message: 'Task deleted' });
    });
    expect(order).toEqual(['lookup', 'handler']);
    expect(events.emit).toHaveBeenCalledWith(REALTIME_INVALIDATE, { type: 'task.deleted', projectId: 42, taskId: 10 });
  });

  it('a task moved to another project tells both project rooms', async () => {
    const { interceptor, targets, events } = setup();
    targets.task
      .mockResolvedValueOnce({ projectId: 41, taskId: 10 }) // before
      .mockResolvedValueOnce({ projectId: 42, taskId: 10 }); // after
    const req = { method: 'PATCH', params: { id: '10' }, body: { projectId: 42 } };
    await run(interceptor, ctx(FakeTasksController, 'update', req), () => of({ id: 10 }));
    expect(events.emit.mock.calls.map((c) => c[1])).toEqual([
      { type: 'task.updated', projectId: 41, taskId: 10 },
      { type: 'task.updated', projectId: 42, taskId: 10 },
    ]);
  });

  it('a created task uses the response ids; a personal task announces nothing', async () => {
    const { interceptor, targets, events } = setup();
    const req = { method: 'POST', params: {}, body: { name: 'x' } };
    await run(interceptor, ctx(FakeTasksController, 'create', req), () =>
      of({ success: true, data: { id: 77, projectId: 42, name: 'x' } }),
    );
    expect(events.emit).toHaveBeenCalledWith(REALTIME_INVALIDATE, { type: 'task.updated', projectId: 42, taskId: 77 });

    events.emit.mockClear();
    await run(interceptor, ctx(FakeTasksController, 'create', req), () => of({ id: 78, projectId: null }));
    expect(events.emit).not.toHaveBeenCalled();
    expect(targets.task).not.toHaveBeenCalled();
  });

  it('a bulk save announces project.updated once per project', async () => {
    const { interceptor, targets, events } = setup();
    const req = { method: 'POST', params: {}, body: { items: [{ id: 1 }, { id: 2 }, { id: 3 }] } };
    await run(interceptor, ctx(FakeTasksController, 'reorder', req), () => of({ updated: 3 }));
    expect(targets.projectsOf).toHaveBeenCalledWith('task', [1, 2, 3]);
    expect(events.emit.mock.calls.map((c) => c[1])).toEqual([
      { type: 'project.updated', projectId: 42 },
      { type: 'project.updated', projectId: 43 },
    ]);
  });

  it('a project-scoped create reads body.projectId', async () => {
    const { interceptor, events } = setup();
    const req = { method: 'POST', params: {}, body: { projectId: 42, name: 'Floor 3' } };
    await run(interceptor, ctx(FakeZonesController, 'create', req), () => of({ id: 5 }));
    expect(events.emit).toHaveBeenCalledWith(REALTIME_INVALIDATE, { type: 'project.updated', projectId: 42 });
  });

  it('a lookup failure never fails the request', async () => {
    const { interceptor, targets, events } = setup();
    targets.task.mockRejectedValue(new Error('db down'));
    const req = { method: 'PATCH', params: { id: '10' }, body: { status: 'done' } };
    await expect(run(interceptor, ctx(FakeTasksController, 'update', req), () => of({ ok: 1 }))).resolves.toEqual({ ok: 1 });
    expect(events.emit).not.toHaveBeenCalled();
  });
});
