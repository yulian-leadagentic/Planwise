/**
 * QA6 P10 · PR-079 — a task status change reaches the tabs watching that
 * project, and nobody else.
 *
 * The domain event `task.status.changed` (emitted by tasks.service.ts)
 * goes through the real Nest EventEmitter wiring: RealtimeEventsListener
 * → `realtime.invalidate` → RealtimeGateway → the `project-<id>` room of
 * the /realtime namespace, with the round-4 access re-check on every
 * broadcast.
 */
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';

import { RealtimeGateway } from './realtime.gateway';
import { RealtimeEventsListener } from './realtime-events.listener';
import { RealtimeTargetsService } from './realtime-targets.service';
import { REALTIME_INVALIDATE, REALTIME_WIRE_EVENT } from './realtime.events';
import { WsAuthService } from '../../common/services/ws-auth.service';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';

const notMember = () =>
  new PermissionDeniedException("You're not a member of this project.", { module: 'projects', reason: 'NOT_PROJECT_MEMBER' });

function fakeSocket(userId: number | null, rooms: string[] = []) {
  const set = new Set<string>(rooms);
  return {
    id: `sock-${userId}-${Math.random().toString(36).slice(2, 6)}`,
    data: userId == null ? {} : { user: { id: userId, isAdmin: false, roleModules: [] } },
    handshake: { auth: {}, headers: {} },
    rooms: set,
    emit: jest.fn(),
    join: jest.fn((room: string) => {
      set.add(room);
    }),
    leave: jest.fn((room: string) => {
      set.delete(room);
    }),
    disconnect: jest.fn(),
  };
}
type FakeSocket = ReturnType<typeof fakeSocket>;

/**
 * Access: user 6 → projects 42 and 43; user 7 → project 43 only;
 * user 5 → nothing (e.g. removed from the team after he joined).
 */
const ACCESS: Record<number, number[]> = { 6: [42, 43], 7: [43], 5: [] };

async function setup(sockets: FakeSocket[]) {
  const access = {
    assertProjectAccess: jest.fn(async (userId: number, projectId: number) => {
      if (!(ACCESS[userId] ?? []).includes(projectId)) throw notMember();
    }),
  };
  const wsAuth = { authenticate: jest.fn(async () => null) };
  const targets = { task: jest.fn(async (taskId: number) => ({ projectId: 42, taskId })) };

  const moduleRef = await Test.createTestingModule({
    imports: [EventEmitterModule.forRoot()],
    providers: [
      RealtimeGateway,
      RealtimeEventsListener,
      { provide: RealtimeTargetsService, useValue: targets },
      { provide: WsAuthService, useValue: wsAuth },
      { provide: ProjectAccessService, useValue: access },
    ],
  }).compile();
  await moduleRef.init(); // binds the @OnEvent handlers

  const gw = moduleRef.get(RealtimeGateway);
  (gw as any).server = {
    in: jest.fn((room: string) => ({
      fetchSockets: jest.fn(async () => sockets.filter((s) => s.rooms.has(room))),
    })),
  };
  const events = moduleRef.get(EventEmitter2);
  return { moduleRef, gw, events, access, wsAuth, targets };
}

const statusChanged = { taskId: 10, projectId: 42, userId: 6, oldStatus: 'todo', newStatus: 'in_progress', userName: 'Dana Levi' };

describe('RealtimeGateway — task status change', () => {
  it('reaches the sockets in that project room only, with ids only', async () => {
    const watcher = fakeSocket(6, ['project-42']);
    const otherProject = fakeSocket(7, ['project-43']);
    const notJoined = fakeSocket(6, []);
    const { moduleRef, gw, events } = await setup([watcher, otherProject, notJoined]);

    events.emit('task.status.changed', statusChanged);
    await gw.flushPending();

    expect(watcher.emit).toHaveBeenCalledTimes(1);
    expect(watcher.emit).toHaveBeenCalledWith(REALTIME_WIRE_EVENT, { type: 'task.updated', projectId: 42, taskId: 10 });
    // No status, names or user ids on the wire.
    expect(Object.keys(watcher.emit.mock.calls[0][1]).sort()).toEqual(['projectId', 'taskId', 'type']);
    expect(otherProject.emit).not.toHaveBeenCalled();
    expect(notJoined.emit).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('a user without access never receives it and is taken out of the room', async () => {
    const member = fakeSocket(6, ['project-42']);
    const removed = fakeSocket(5, ['project-42']);
    const anon = fakeSocket(null, ['project-42']);
    const { moduleRef, gw, events, access } = await setup([member, removed, anon]);

    events.emit('task.status.changed', statusChanged);
    await gw.flushPending();

    expect(access.assertProjectAccess).toHaveBeenCalledWith(5, 42, false);
    expect(removed.emit).not.toHaveBeenCalled();
    expect(removed.leave).toHaveBeenCalledWith('project-42');
    expect(anon.emit).not.toHaveBeenCalled();
    expect(anon.leave).toHaveBeenCalledWith('project-42');
    expect(member.emit).toHaveBeenCalledTimes(1);

    // Gone from the room: the next change does not reach him at all.
    events.emit('task.status.changed', { ...statusChanged, taskId: 11 });
    await gw.flushPending();
    expect(removed.emit).not.toHaveBeenCalled();
    expect(member.emit).toHaveBeenCalledTimes(2);
    await moduleRef.close();
  });

  it('a deleted project (404) also clears the room; a database error skips the event but keeps it', async () => {
    const sock = fakeSocket(6, ['project-42']);
    const { moduleRef, gw, access } = await setup([sock]);

    access.assertProjectAccess.mockRejectedValueOnce(new Error('connection lost'));
    gw.handleInvalidate({ type: 'project.updated', projectId: 42 });
    await gw.flushPending();
    expect(sock.emit).not.toHaveBeenCalled();
    expect(sock.leave).not.toHaveBeenCalled();

    access.assertProjectAccess.mockRejectedValueOnce(new NotFoundException('Project not found'));
    gw.handleInvalidate({ type: 'project.updated', projectId: 42 });
    await gw.flushPending();
    expect(sock.emit).not.toHaveBeenCalled();
    expect(sock.leave).toHaveBeenCalledWith('project-42');
    await moduleRef.close();
  });

  it('the same change announced twice (domain event + HTTP interceptor) goes out once', async () => {
    const watcher = fakeSocket(6, ['project-42']);
    const { moduleRef, gw, events, access } = await setup([watcher]);

    events.emit('task.status.changed', statusChanged);
    events.emit(REALTIME_INVALIDATE, { type: 'task.updated', projectId: 42, taskId: 10 });
    await gw.flushPending();

    expect(watcher.emit).toHaveBeenCalledTimes(1);
    expect(access.assertProjectAccess).toHaveBeenCalledTimes(1);
    await moduleRef.close();
  });

  it('a burst for one project collapses into one project.updated', async () => {
    const watcher = fakeSocket(6, ['project-42']);
    const { moduleRef, gw } = await setup([watcher]);

    for (let taskId = 1; taskId <= RealtimeGateway.MAX_EVENTS_PER_PROJECT + 5; taskId++) {
      gw.handleInvalidate({ type: 'task.updated', projectId: 42, taskId });
    }
    await gw.flushPending();

    expect(watcher.emit).toHaveBeenCalledTimes(1);
    expect(watcher.emit).toHaveBeenCalledWith(REALTIME_WIRE_EVENT, { type: 'project.updated', projectId: 42 });
    await moduleRef.close();
  });

  it('task.assignee.added (no projectId in the payload) is resolved to the task project', async () => {
    const watcher = fakeSocket(6, ['project-42']);
    const { moduleRef, gw, events, targets } = await setup([watcher]);

    events.emit('task.assignee.added', { taskId: 10, userId: 6, assigneeId: 7, userName: 'a', assigneeName: 'b' });
    await new Promise((r) => setImmediate(r));
    await gw.flushPending();

    expect(targets.task).toHaveBeenCalledWith(10);
    expect(watcher.emit).toHaveBeenCalledWith(REALTIME_WIRE_EVENT, { type: 'task.updated', projectId: 42, taskId: 10 });
    await moduleRef.close();
  });

  it('a personal task (no project) and malformed events are never sent', async () => {
    const watcher = fakeSocket(6, ['project-42']);
    const { moduleRef, gw, events } = await setup([watcher]);

    events.emit('task.status.changed', { ...statusChanged, projectId: null });
    gw.handleInvalidate({ type: 'task.updated', projectId: 42 }); // no taskId
    gw.handleInvalidate({ type: 'project.renamed', projectId: 42 });
    gw.handleInvalidate({ type: 'project.updated', projectId: -1 });
    await gw.flushPending();

    expect(watcher.emit).not.toHaveBeenCalled();
    await moduleRef.close();
  });
});

describe('RealtimeGateway — joining a project room', () => {
  it('joins only with project access (same rule as the HTTP routes)', async () => {
    const { moduleRef, gw, access } = await setup([]);
    const sock = fakeSocket(7);

    await expect(gw.handleJoin(sock as any, { projectId: 42 })).resolves.toMatchObject({ ok: false, projectId: 42 });
    expect(sock.join).not.toHaveBeenCalled();

    await expect(gw.handleJoin(sock as any, { projectId: 43 })).resolves.toEqual({ ok: true, projectId: 43 });
    expect(sock.join).toHaveBeenCalledWith('project-43');
    expect(access.assertProjectAccess).toHaveBeenCalledWith(7, 43, false);

    gw.handleLeave(sock as any, { projectId: 43 });
    expect(sock.leave).toHaveBeenCalledWith('project-43');
    await moduleRef.close();
  });

  it('refuses an unauthenticated socket, a bad id and more rooms than the cap', async () => {
    const { moduleRef, gw } = await setup([]);
    const anon = fakeSocket(null);
    await expect(gw.handleJoin(anon as any, { projectId: 42 })).resolves.toMatchObject({ ok: false });
    expect(anon.join).not.toHaveBeenCalled();

    const sock = fakeSocket(6);
    await expect(gw.handleJoin(sock as any, { projectId: 'x' as any })).resolves.toMatchObject({ ok: false, projectId: null });

    const full = fakeSocket(
      6,
      Array.from({ length: RealtimeGateway.MAX_ROOMS_PER_SOCKET }, (_, i) => `project-${1000 + i}`),
    );
    await expect(gw.handleJoin(full as any, { projectId: 42 })).resolves.toMatchObject({ ok: false });
    expect(full.join).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('disconnects a handshake without a valid token', async () => {
    const { moduleRef, gw, wsAuth } = await setup([]);
    const sock = fakeSocket(null);
    await gw.handleConnection(sock as any);
    expect(wsAuth.authenticate).toHaveBeenCalled();
    expect(sock.disconnect).toHaveBeenCalledWith(true);
    await moduleRef.close();
  });
});
