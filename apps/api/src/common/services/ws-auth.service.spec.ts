import { JwtService } from '@nestjs/jwt';
import { ForbiddenException } from '@nestjs/common';
import { WsAuthService } from './ws-auth.service';
import { NotificationsGateway } from '../../modules/notifications/notifications.gateway';
import { MessagesGateway } from '../../modules/messages/messages.gateway';

/**
 * Permissions round 1 (2026-11-20) — Socket.IO handshake authentication
 * (WsAuthService) and the two gateways that use it. The gateways used to
 * trust `handshake.query.userId` and let anyone join any room; now a
 * verified access token is the only source of identity and every room
 * join passes the ProjectAccessService check.
 */

const TEST_ACCESS_SECRET = 'test-access-secret-0123456789-abcdef';
const OTHER_SECRET = 'some-other-secret-0123456789-abcdefgh';

function defaultUserRow(id: number, roleName = 'Employee') {
  return {
    id,
    email: `u${id}@x.com`,
    firstName: 'U',
    lastName: String(id),
    roleId: 3,
    userType: 'employee',
    avatarUrl: null,
    role: { id: 3, name: roleName, roleModules: [] },
    userRoles: [{ role: { id: 3, name: roleName, roleModules: [] } }],
  };
}

function makeWsAuth(userRow: any = defaultUserRow(5)) {
  const prisma: any = {
    user: { findFirst: jest.fn(async () => userRow) },
  };
  const config: any = {
    get: jest.fn((key: string) => (key === 'JWT_ACCESS_SECRET' ? TEST_ACCESS_SECRET : undefined)),
  };
  const svc = new WsAuthService(new JwtService({}), prisma, config);
  return { svc, prisma };
}

function signToken(sub: number, secret = TEST_ACCESS_SECRET, expiresIn: string | number = '1h') {
  return new JwtService({}).sign({ sub, email: `u${sub}@x.com`, roleId: 3 }, { secret, expiresIn });
}

function fakeSocket(handshake: { auth?: any; headers?: any; query?: any }) {
  const rooms = new Set<string>();
  return {
    id: `sock-${Math.random().toString(36).slice(2, 8)}`,
    handshake: { auth: {}, headers: {}, query: {}, ...handshake },
    data: {} as any,
    rooms,
    join: jest.fn((room: string) => { rooms.add(room); }),
    leave: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

describe('WsAuthService', () => {
  it('rejects a handshake without a token', async () => {
    const { svc, prisma } = makeWsAuth();
    expect(await svc.authenticate(fakeSocket({}) as any)).toBeNull();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('ignores query.userId entirely (no token → rejected)', async () => {
    const { svc, prisma } = makeWsAuth();
    expect(await svc.authenticate(fakeSocket({ query: { userId: '999999' } }) as any)).toBeNull();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('does not accept a token from the query string', async () => {
    const { svc } = makeWsAuth();
    expect(await svc.authenticate(fakeSocket({ query: { token: signToken(5) } }) as any)).toBeNull();
  });

  it('rejects a token signed with another secret', async () => {
    const { svc, prisma } = makeWsAuth();
    const sock = fakeSocket({ auth: { token: signToken(5, OTHER_SECRET) } });
    expect(await svc.authenticate(sock as any)).toBeNull();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('rejects an expired token', async () => {
    const { svc } = makeWsAuth();
    const sock = fakeSocket({ auth: { token: signToken(5, TEST_ACCESS_SECRET, -10) } });
    expect(await svc.authenticate(sock as any)).toBeNull();
  });

  it('rejects garbage', async () => {
    const { svc } = makeWsAuth();
    expect(await svc.authenticate(fakeSocket({ auth: { token: 'not-a-jwt' } }) as any)).toBeNull();
  });

  it('accepts auth.token and loads the user with the strategy checks (active, not deleted)', async () => {
    const { svc, prisma } = makeWsAuth();
    const user = await svc.authenticate(fakeSocket({ auth: { token: signToken(5) } }) as any);
    expect(user?.id).toBe(5);
    expect(user?.isAdmin).toBe(false);
    expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({ id: 5, isActive: true, deletedAt: null });
  });

  it('accepts an Authorization: Bearer handshake header', async () => {
    const { svc } = makeWsAuth();
    const user = await svc.authenticate(
      fakeSocket({ headers: { authorization: `Bearer ${signToken(5)}` } }) as any,
    );
    expect(user?.id).toBe(5);
  });

  it('takes the identity from the token, not from query.userId', async () => {
    const { svc, prisma } = makeWsAuth();
    const user = await svc.authenticate(
      fakeSocket({ auth: { token: signToken(5) }, query: { userId: '999999' } }) as any,
    );
    expect(user?.id).toBe(5);
    expect(prisma.user.findFirst.mock.calls[0][0].where.id).toBe(5);
  });

  it('rejects a valid token whose user is inactive / deleted / missing', async () => {
    const { svc } = makeWsAuth(null);
    expect(await svc.authenticate(fakeSocket({ auth: { token: signToken(5) } }) as any)).toBeNull();
  });
});

describe('NotificationsGateway — handshake auth', () => {
  function make(userRow: any = defaultUserRow(5)) {
    const { svc } = makeWsAuth(userRow);
    return new NotificationsGateway(svc);
  }

  it('disconnects a client without a token and joins nothing', async () => {
    const gw = make();
    const sock = fakeSocket({});
    await gw.handleConnection(sock as any);
    expect(sock.disconnect).toHaveBeenCalledWith(true);
    expect(sock.join).not.toHaveBeenCalled();
  });

  it('disconnects a client with an invalid token', async () => {
    const gw = make();
    const sock = fakeSocket({ auth: { token: signToken(5, OTHER_SECRET) } });
    await gw.handleConnection(sock as any);
    expect(sock.disconnect).toHaveBeenCalledWith(true);
    expect(sock.join).not.toHaveBeenCalled();
  });

  it('ignores query.userId: no token means no connection (the staging exploit)', async () => {
    const gw = make();
    const sock = fakeSocket({ query: { userId: '999999' } });
    await gw.handleConnection(sock as any);
    expect(sock.disconnect).toHaveBeenCalledWith(true);
    expect(sock.join).not.toHaveBeenCalled();
  });

  it("joins only the token user's own room, even when query.userId says otherwise", async () => {
    const gw = make();
    const sock = fakeSocket({ auth: { token: signToken(5) }, query: { userId: '999999' } });
    await gw.handleConnection(sock as any);
    expect(sock.disconnect).not.toHaveBeenCalled();
    expect(sock.join).toHaveBeenCalledTimes(1);
    expect(sock.join).toHaveBeenCalledWith('user-5');
    expect(sock.data.user.id).toBe(5);
  });
});

describe('MessagesGateway — handshake auth + room joins', () => {
  function make(userRow: any = defaultUserRow(5)) {
    const { svc } = makeWsAuth(userRow);
    const access: any = {
      assertProjectAccess: jest.fn(async () => undefined),
      assertTaskAccess: jest.fn(async () => 42),
      assertZoneAccess: jest.fn(async () => 42),
    };
    const gw = new MessagesGateway(svc, access);
    const emitted: Array<{ room: string; event: string; data: any }> = [];
    (gw as any).server = {
      to: jest.fn((room: string) => ({
        emit: (event: string, data: any) => emitted.push({ room, event, data }),
      })),
    };
    return { gw, access, emitted };
  }

  async function connected(gw: MessagesGateway, sub = 5) {
    const sock = fakeSocket({ auth: { token: signToken(sub) } });
    await gw.handleConnection(sock as any);
    return sock;
  }

  it('disconnects a client without a token, with an invalid token, or with only query.userId', async () => {
    const { gw } = make();
    for (const hs of [{}, { auth: { token: 'nope' } }, { query: { userId: '999999' } }]) {
      const sock = fakeSocket(hs);
      await gw.handleConnection(sock as any);
      expect(sock.disconnect).toHaveBeenCalledWith(true);
      expect(sock.data.user).toBeUndefined();
    }
  });

  it('refuses a room join without project access: emits message:error and does not join', async () => {
    const { gw, access } = make();
    access.assertProjectAccess.mockRejectedValueOnce(new ForbiddenException('You do not have access to this project'));
    const sock = await connected(gw);

    await gw.handleJoinRoom(sock as any, { entityType: 'project', entityId: 42 });

    expect(access.assertProjectAccess).toHaveBeenCalledWith(5, 42, false);
    expect(sock.join).not.toHaveBeenCalled();
    expect(sock.emit).toHaveBeenCalledWith(
      'message:error',
      expect.objectContaining({ event: 'message:join', entityType: 'project', entityId: 42 }),
    );
  });

  it('checks task and zone rooms with the matching assert', async () => {
    const { gw, access } = make();
    access.assertTaskAccess.mockRejectedValueOnce(new ForbiddenException());
    const sock = await connected(gw);

    await gw.handleJoinRoom(sock as any, { entityType: 'task', entityId: 10 });
    expect(access.assertTaskAccess).toHaveBeenCalledWith(5, 10, false);
    expect(sock.join).not.toHaveBeenCalled();

    await gw.handleJoinRoom(sock as any, { entityType: 'zone', entityId: 7 });
    expect(access.assertZoneAccess).toHaveBeenCalledWith(5, 7, false);
    expect(sock.join).toHaveBeenCalledWith('entity-zone-7');
  });

  it('joins when the caller has access', async () => {
    const { gw } = make();
    const sock = await connected(gw);
    await gw.handleJoinRoom(sock as any, { entityType: 'project', entityId: 42 });
    expect(sock.join).toHaveBeenCalledWith('entity-project-42');
  });

  it('passes isAdmin from the merged user_roles (Admin chip), not from roleId', async () => {
    const { gw, access } = make(defaultUserRow(6, 'Admin'));
    const sock = await connected(gw, 6);
    await gw.handleJoinRoom(sock as any, { entityType: 'project', entityId: 42 });
    expect(access.assertProjectAccess).toHaveBeenCalledWith(6, 42, true);
  });

  it('refuses joins from a socket that never authenticated, and unknown entity types', async () => {
    const { gw, access } = make();
    const anon = fakeSocket({});
    await gw.handleJoinRoom(anon as any, { entityType: 'project', entityId: 42 });
    expect(anon.join).not.toHaveBeenCalled();
    expect(anon.emit).toHaveBeenCalledWith('message:error', expect.objectContaining({ event: 'message:join' }));

    const sock = await connected(gw);
    await gw.handleJoinRoom(sock as any, { entityType: 'user', entityId: 5 });
    expect(sock.join).not.toHaveBeenCalled();
    expect(access.assertProjectAccess).not.toHaveBeenCalled();
  });

  it('typing uses the authenticated user id and only reaches rooms the socket joined', async () => {
    const { gw, emitted } = make();
    const sock = await connected(gw);
    jest.useFakeTimers();
    try {
      // Not in the room yet → nothing is broadcast.
      gw.handleTyping(sock as any, { entityType: 'project', entityId: 42, userId: 999999 } as any);
      expect(emitted).toEqual([]);

      sock.rooms.add('entity-project-42');
      gw.handleTyping(sock as any, { entityType: 'project', entityId: 42, userId: 999999 } as any);
      expect(emitted).toEqual([{ room: 'entity-project-42', event: 'typing:start', data: { userId: 5 } }]);
      jest.runAllTimers();
      expect(emitted[1]).toEqual({ room: 'entity-project-42', event: 'typing:stop', data: { userId: 5 } });
    } finally {
      jest.useRealTimers();
    }
  });
});
