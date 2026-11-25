import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { ForbiddenException, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

import { WsAuthService } from '../../common/services/ws-auth.service';
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
export class RealtimeGateway implements OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  /** Events arriving within this window are sent together (one access pass per room). */
  static readonly FLUSH_MS = 100;
  /** A socket watches at most this many projects at once. */
  static readonly MAX_ROOMS_PER_SOCKET = 50;
  /** More task events than this for one project in one window → one `project.updated`. */
  static readonly MAX_EVENTS_PER_PROJECT = 25;

  private readonly logger = new Logger(RealtimeGateway.name);
  private pending = new Map<number, Map<string, RealtimeInvalidation>>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly wsAuth: WsAuthService,
    private readonly access: ProjectAccessService,
  ) {}

  async handleConnection(client: Socket) {
    const user = await this.wsAuth.authenticate(client);
    if (!user) {
      this.logger.warn(`Rejected unauthenticated realtime socket ${client.id}`);
      client.disconnect(true);
      return;
    }
    client.data.user = user;
  }

  onModuleDestroy() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending.clear();
  }

  /** Watch a project. Acked with `{ ok, projectId, error? }`. */
  @SubscribeMessage('project:join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { projectId?: unknown },
  ): Promise<RealtimeJoinAck> {
    const user = client.data?.user;
    const projectId = positiveInt(data?.projectId);
    if (!user) return { ok: false, projectId, error: 'Not authenticated' };
    if (projectId == null) return { ok: false, projectId: null, error: 'projectId must be a positive integer' };

    const room = projectRoom(projectId);
    if (client.rooms.has(room)) return { ok: true, projectId };
    if (projectRoomCount(client) >= RealtimeGateway.MAX_ROOMS_PER_SOCKET) {
      return { ok: false, projectId, error: 'Too many projects watched at once' };
    }
    try {
      await this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
    } catch {
      return { ok: false, projectId, error: 'You do not have access to this project' };
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
    await Promise.all(
      [...batch].map(([projectId, events]) => this.broadcast(projectId, collapse(projectId, [...events.values()]))),
    );
  }

  /**
   * Same re-check as MessagesGateway.emitToRoom (round 4): every socket
   * in the room passes the project-access rule again (one check per
   * user); a user who no longer passes leaves the room and gets nothing.
   * A transient error (database down) skips the event for that socket
   * and keeps its room.
   */
  private async broadcast(projectId: number, events: RealtimeInvalidation[]): Promise<void> {
    if (events.length === 0) return;
    const room = projectRoom(projectId);
    try {
      const sockets = await this.server.in(room).fetchSockets();
      if (sockets.length === 0) return;
      const verdicts = new Map<number, Promise<'allowed' | 'denied' | 'error'>>();
      const verdictFor = (user: any) => {
        let verdict = verdicts.get(user.id);
        if (!verdict) {
          verdict = this.access.assertProjectAccess(user.id, projectId, isAdminUser(user)).then(
            () => 'allowed' as const,
            (err) => (err instanceof ForbiddenException || err instanceof NotFoundException ? 'denied' : 'error'),
          );
          verdicts.set(user.id, verdict);
        }
        return verdict;
      };
      await Promise.all(
        sockets.map(async (socket) => {
          const user = socket.data?.user;
          const verdict = user?.id != null ? await verdictFor(user) : 'denied';
          if (verdict === 'allowed') {
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
