import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { ForbiddenException, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

import { WsAuthService, WsAuthenticatedUser } from '../../common/services/ws-auth.service';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { isAdminUser } from '../../common/guards/roles.guard';
import { socketCorsOrigins } from '../../common/ws-cors';
import {
  REALTIME_INVALIDATE,
  REALTIME_WIRE_EVENT,
  RealtimeInvalidation,
  positiveInt,
  projectRoom,
  toRealtimeInvalidation,
} from './realtime.events';

export interface RealtimeJoinAck {
  ok: boolean;
  projectId: number | null;
  error?: string;
}

/**
 * QA6 P10 · PR-079 — the live "something changed" channel.
 *
 * Socket.IO default path `/socket.io`, namespace `/realtime` (next to
 * `/notifications` and `/messaging`). Same rules as the messaging
 * gateway (permissions rounds 1 and 4):
 *   • the handshake must carry a valid access token, else disconnect;
 *   • `project:join` passes the HTTP project-access rule
 *     (ProjectAccessService.assertProjectAccess) or the socket does not
 *     join;
 *   • every broadcast re-checks each socket in the room (once per user)
 *     and takes out a user who lost access since he joined.
 * QA6 security review (2026-11-25):
 *   • the re-check uses the user as he is NOW (`isActive`, `isAdmin`,
 *     roles), re-read at most every USER_REFRESH_MS, not the handshake
 *     copy: a deactivated user is disconnected, a demoted Admin loses
 *     the projects only his Admin role opened;
 *   • a socket does not outlive its access token: the token's `exp` is
 *     kept at connect and the socket is disconnected once it passes (a
 *     timer, plus a check on every join and broadcast); the web client
 *     reconnects with a fresh token;
 *   • a socket refused MAX_REFUSED_JOINS `project:join`s (a project-id
 *     scan) is disconnected.
 * The payload is `{ type, projectId, taskId? }` — ids only; the client
 * refetches through the HTTP routes.
 */
@WebSocketGateway({
  cors: {
    origin: socketCorsOrigins(),
    credentials: true,
  },
  namespace: '/realtime',
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  /** Events arriving within this window are sent together (one access pass per room). */
  static readonly FLUSH_MS = 100;
  /** A socket watches at most this many projects at once. */
  static readonly MAX_ROOMS_PER_SOCKET = 50;
  /** More task events than this for one project in one window → one `project.updated`. */
  static readonly MAX_EVENTS_PER_PROJECT = 25;
  /** A user's active / Admin state is re-read from the database at most this often. */
  static readonly USER_REFRESH_MS = 60_000;
  /** Refused `project:join`s on one socket; the last one disconnects it. */
  static readonly MAX_REFUSED_JOINS = 20;
  /** setTimeout's ceiling; a later expiry is left to the join / broadcast checks. */
  private static readonly MAX_TIMER_MS = 2_147_483_647;

  private readonly logger = new Logger(RealtimeGateway.name);
  private pending = new Map<number, Map<string, RealtimeInvalidation>>();
  private flushTimer: NodeJS.Timeout | null = null;
  /** userId → the user as last read at `at` (null = inactive / deleted). */
  private users = new Map<number, { at: number; user: Promise<WsAuthenticatedUser | null> }>();
  /** Clock, replaceable in tests. */
  now: () => number = () => Date.now();

  constructor(
    private readonly wsAuth: WsAuthService,
    private readonly access: ProjectAccessService,
  ) {}

  async handleConnection(client: Socket) {
    const session = await this.wsAuth.authenticateSession(client);
    if (!session) {
      this.logger.warn(`Rejected unauthenticated realtime socket ${client.id}`);
      client.disconnect(true);
      return;
    }
    client.data.user = session.user;
    client.data.tokenExpiresAt = session.expiresAt;
    client.data.refusedJoins = 0;
    // The handshake has just loaded him: that counts as a fresh read.
    this.users.set(session.user.id, { at: this.now(), user: Promise.resolve(session.user) });
    if (session.expiresAt != null) {
      const ms = session.expiresAt - this.now();
      if (ms <= 0) {
        client.disconnect(true);
        return;
      }
      if (ms <= RealtimeGateway.MAX_TIMER_MS) {
        const timer = setTimeout(() => this.expire(client), ms);
        timer.unref?.();
        client.data.expiryTimer = timer;
      }
    }
  }

  handleDisconnect(client: Socket) {
    const timer = client?.data?.expiryTimer;
    if (timer) clearTimeout(timer);
    if (client?.data) client.data.expiryTimer = null;
  }

  onModuleDestroy() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending.clear();
    this.users.clear();
  }

  /** Watch a project. Acked with `{ ok, projectId, error? }`. */
  @SubscribeMessage('project:join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { projectId?: unknown },
  ): Promise<RealtimeJoinAck> {
    const handshakeUser = client.data?.user;
    const projectId = positiveInt(data?.projectId);
    if (!handshakeUser) return this.refuse(client, { ok: false, projectId, error: 'Not authenticated' });
    if (this.isExpired(client)) {
      this.expire(client);
      return { ok: false, projectId, error: 'Session expired' };
    }
    if (projectId == null) {
      return this.refuse(client, { ok: false, projectId: null, error: 'projectId must be a positive integer' });
    }

    const room = projectRoom(projectId);
    if (client.rooms.has(room)) return { ok: true, projectId };
    if (projectRoomCount(client) >= RealtimeGateway.MAX_ROOMS_PER_SOCKET) {
      return this.refuse(client, { ok: false, projectId, error: 'Too many projects watched at once' });
    }
    try {
      const user = await this.currentUser(handshakeUser.id);
      if (!user) {
        client.disconnect(true);
        return { ok: false, projectId, error: 'Not authenticated' };
      }
      await this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
    } catch {
      return this.refuse(client, { ok: false, projectId, error: 'You do not have access to this project' });
    }
    client.join(room);
    return { ok: true, projectId };
  }

  @SubscribeMessage('project:leave')
  handleLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { projectId?: unknown },
  ): RealtimeJoinAck {
    const projectId = positiveInt(data?.projectId);
    if (projectId == null) return { ok: false, projectId: null, error: 'projectId must be a positive integer' };
    client.leave(projectRoom(projectId));
    return { ok: true, projectId };
  }

  /** From RealtimeInvalidationInterceptor and RealtimeEventsListener. */
  @OnEvent(REALTIME_INVALIDATE)
  handleInvalidate(raw: unknown): void {
    const event = toRealtimeInvalidation(raw);
    if (!event) return;
    let forProject = this.pending.get(event.projectId);
    if (!forProject) {
      forProject = new Map();
      this.pending.set(event.projectId, forProject);
    }
    forProject.set(`${event.type}:${event.taskId ?? ''}`, event);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flushPending(), RealtimeGateway.FLUSH_MS);
      this.flushTimer.unref?.();
    }
  }

  /** Sends everything queued so far (tests call it directly). */
  async flushPending(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const batch = this.pending;
    this.pending = new Map();
    // Drop user reads past their refresh window (keeps the map bounded).
    const now = this.now();
    for (const [id, hit] of this.users) if (now - hit.at >= RealtimeGateway.USER_REFRESH_MS) this.users.delete(id);
    await Promise.all(
      [...batch].map(([projectId, events]) => this.broadcast(projectId, collapse(projectId, [...events.values()]))),
    );
  }

  /** The access token this socket connected with has expired. */
  private isExpired(client: { data?: any }): boolean {
    const at = client?.data?.tokenExpiresAt;
    return typeof at === 'number' && this.now() >= at;
  }

  private expire(client: { id: string; disconnect(close?: boolean): unknown }): void {
    this.logger.debug(`Realtime socket ${client.id}: access token expired, disconnecting`);
    client.disconnect(true);
  }

  /**
   * The user as he is now: re-read through WsAuthService.loadUser at most
   * every USER_REFRESH_MS (shared by all his sockets). Null = inactive,
   * deleted or must change his password. A database error rejects and is
   * not cached, so the caller skips instead of disconnecting.
   */
  private currentUser(userId: number): Promise<WsAuthenticatedUser | null> {
    const now = this.now();
    const hit = this.users.get(userId);
    if (hit && now - hit.at < RealtimeGateway.USER_REFRESH_MS) return hit.user;
    const user = this.wsAuth.loadUser(userId);
    this.users.set(userId, { at: now, user });
    user.catch(() => {
      if (this.users.get(userId)?.user === user) this.users.delete(userId);
    });
    return user;
  }

  /** Counts a refused join; the MAX_REFUSED_JOINS-th refusal disconnects the socket. */
  private refuse(client: Socket, ack: RealtimeJoinAck): RealtimeJoinAck {
    if (client?.data) {
      client.data.refusedJoins = (Number(client.data.refusedJoins) || 0) + 1;
      if (client.data.refusedJoins >= RealtimeGateway.MAX_REFUSED_JOINS) {
        this.logger.warn(
          `Realtime socket ${client.id} (user ${client.data.user?.id}): ${client.data.refusedJoins} refused project joins, disconnecting`,
        );
        client.disconnect(true);
      }
    }
    return ack;
  }

  /**
   * Same re-check as MessagesGateway.emitToRoom (round 4): every socket
   * in the room passes the project-access rule again (one check per
   * user); a user who no longer passes leaves the room and gets nothing.
   * A transient error (database down) skips the event for that socket
   * and keeps its room.
   * QA6: the check runs on the user as he is now (`currentUser`); a user
   * who is gone (inactive / deleted) and a socket whose access token has
   * expired are disconnected.
   */
  private async broadcast(projectId: number, events: RealtimeInvalidation[]): Promise<void> {
    if (events.length === 0) return;
    const room = projectRoom(projectId);
    try {
      const sockets = await this.server.in(room).fetchSockets();
      if (sockets.length === 0) return;
      type Verdict = 'allowed' | 'denied' | 'gone' | 'error';
      const verdicts = new Map<number, Promise<Verdict>>();
      const check = async (userId: number): Promise<Verdict> => {
        let user: WsAuthenticatedUser | null;
        try {
          user = await this.currentUser(userId);
        } catch {
          return 'error';
        }
        if (!user) return 'gone';
        try {
          await this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
          return 'allowed';
        } catch (err) {
          return err instanceof ForbiddenException || err instanceof NotFoundException ? 'denied' : 'error';
        }
      };
      const verdictFor = (userId: number) => {
        let verdict = verdicts.get(userId);
        if (!verdict) {
          verdict = check(userId);
          verdicts.set(userId, verdict);
        }
        return verdict;
      };
      await Promise.all(
        sockets.map(async (socket) => {
          const user = socket.data?.user;
          if (this.isExpired(socket)) {
            this.expire(socket);
            return;
          }
          const verdict: Verdict = user?.id != null ? await verdictFor(user.id) : 'denied';
          if (verdict === 'gone') {
            socket.disconnect(true);
            this.logger.debug(`Socket ${socket.id} (user ${user?.id}): user inactive or deleted; disconnected`);
          } else if (verdict === 'allowed') {
            for (const event of events) socket.emit(REALTIME_WIRE_EVENT, toWire(event));
          } else if (verdict === 'denied') {
            socket.leave(room);
            this.logger.debug(`Socket ${socket.id} (user ${user?.id}) lost access; left room ${room}`);
          }
        }),
      );
    } catch (err) {
      this.logger.warn(`Realtime broadcast to ${room} failed: ${(err as Error)?.message ?? err}`);
    }
  }
}

function projectRoomCount(client: Socket): number {
  let n = 0;
  for (const room of client.rooms ?? []) if (room.startsWith('project-')) n += 1;
  return n;
}

/** A `project.updated` (or a burst) supersedes the task events of that project. */
function collapse(projectId: number, events: RealtimeInvalidation[]): RealtimeInvalidation[] {
  if (events.length > RealtimeGateway.MAX_EVENTS_PER_PROJECT || events.some((e) => e.type === 'project.updated')) {
    return [{ type: 'project.updated', projectId }];
  }
  return events;
}

/** Exactly the ids — nothing else a caller attached reaches the client. */
function toWire(event: RealtimeInvalidation): RealtimeInvalidation {
  return event.taskId != null
    ? { type: event.type, projectId: event.projectId, taskId: event.taskId }
    : { type: event.type, projectId: event.projectId };
}
