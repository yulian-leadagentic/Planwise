/**
 * Permissions round 4 (review fix) — stale socket rooms. A socket joined
 * a discussion room while its user had access; after he loses access
 * (removed member, partner role or task assignee, …) the next broadcast
 * re-checks him with the message:join rule, takes the socket out of the
 * room and sends him nothing.
 */
import { NotFoundException } from '@nestjs/common';

import { MessagesGateway } from './messages.gateway';
import { PermissionDeniedException } from '../../common/errors/permission-denied';

const notMember = () =>
  new PermissionDeniedException("You're not a member of this project.", { module: 'projects', reason: 'NOT_PROJECT_MEMBER' });

function fakeSocket(userId: number | null, rooms: string[]) {
  const set = new Set(rooms);
  return {
    id: `sock-${userId}-${Math.random().toString(36).slice(2, 6)}`,
    data: userId == null ? {} : { user: { id: userId, isAdmin: false, roleModules: [] } },
    rooms: set,
    emit: jest.fn(),
    leave: jest.fn((room: string) => {
      set.delete(room);
    }),
  };
}

/** User 6 still has access to project 42 and task 10; user 5 was removed. */
function make(sockets: ReturnType<typeof fakeSocket>[]) {
  const allowed = new Set([6]);
  const check = async (userId: number) => {
    if (!allowed.has(userId)) throw notMember();
  };
  const access: any = {
    assertProjectAccess: jest.fn(async (u: number) => check(u)),
    assertTaskAccess: jest.fn(async (u: number) => check(u)),
    assertZoneAccess: jest.fn(async (u: number) => check(u)),
  };
  const gw = new MessagesGateway({} as any, access);
  (gw as any).server = {
    in: jest.fn((room: string) => ({
      fetchSockets: jest.fn(async () => sockets.filter((s) => s.rooms.has(room))),
    })),
  };
  return { gw, access };
}

describe('MessagesGateway — a user who lost access leaves the room on the next broadcast', () => {
  it('a new message reaches members only; the removed user leaves the project room', async () => {
    const member = fakeSocket(6, ['entity-project-42']);
    const removed = fakeSocket(5, ['entity-project-42']);
    const { gw, access } = make([member, removed]);

    await gw.handleMessageCreated({ message: { id: 1 }, entityType: 'project', entityId: 42 });

    expect(member.emit).toHaveBeenCalledWith('message:new', { message: { id: 1 } });
    expect(removed.emit).not.toHaveBeenCalled();
    expect(removed.leave).toHaveBeenCalledWith('entity-project-42');
    expect(member.leave).not.toHaveBeenCalled();
    expect(access.assertProjectAccess).toHaveBeenCalledWith(5, 42, false);

    // Gone from the room: the next broadcast does not reach him at all.
    await gw.handleMessageUpdated({ message: { id: 1 }, entityType: 'project', entityId: 42 });
    expect(removed.emit).not.toHaveBeenCalled();
    expect(member.emit).toHaveBeenCalledTimes(2);
  });

  it('task rooms are re-checked with the task rule (removed assignee)', async () => {
    const removed = fakeSocket(5, ['entity-task-10']);
    const { gw, access } = make([removed]);
    await gw.handleMessageDeleted({ messageId: 3, entityType: 'task', entityId: 10 });
    expect(access.assertTaskAccess).toHaveBeenCalledWith(5, 10, false);
    expect(removed.emit).not.toHaveBeenCalled();
    expect(removed.leave).toHaveBeenCalledWith('entity-task-10');
  });

  it('an entity that no longer exists (404) also clears the room', async () => {
    const sock = fakeSocket(6, ['entity-zone-7']);
    const { gw, access } = make([sock]);
    access.assertZoneAccess.mockRejectedValueOnce(new NotFoundException('Zone not found'));
    await gw.handleMessageCreated({ message: { id: 2 }, entityType: 'zone', entityId: 7 });
    expect(sock.emit).not.toHaveBeenCalled();
    expect(sock.leave).toHaveBeenCalledWith('entity-zone-7');
  });

  it('one access check per user, however many sockets he has open', async () => {
    const a = fakeSocket(6, ['entity-project-42']);
    const b = fakeSocket(6, ['entity-project-42']);
    const { gw, access } = make([a, b]);
    await gw.handleMessageCreated({ message: { id: 1 }, entityType: 'project', entityId: 42 });
    expect(access.assertProjectAccess).toHaveBeenCalledTimes(1);
    expect(a.emit).toHaveBeenCalled();
    expect(b.emit).toHaveBeenCalled();
  });

  it('an unexpected error (e.g. database down) skips the event but keeps the room', async () => {
    const sock = fakeSocket(6, ['entity-project-42']);
    const { gw, access } = make([sock]);
    access.assertProjectAccess.mockRejectedValueOnce(new Error('connection lost'));
    await gw.handleMessageCreated({ message: { id: 1 }, entityType: 'project', entityId: 42 });
    expect(sock.emit).not.toHaveBeenCalled();
    expect(sock.leave).not.toHaveBeenCalled();
  });

  it('a socket without an authenticated user is taken out and gets nothing', async () => {
    const anon = fakeSocket(null, ['entity-project-42']);
    const { gw } = make([anon]);
    await gw.handleMessageCreated({ message: { id: 1 }, entityType: 'project', entityId: 42 });
    expect(anon.emit).not.toHaveBeenCalled();
    expect(anon.leave).toHaveBeenCalledWith('entity-project-42');
  });
});
