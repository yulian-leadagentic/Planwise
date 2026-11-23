import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';

import { WsAuthService } from '../../common/services/ws-auth.service';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { isAdminUser } from '../../common/guards/roles.guard';
import { socketCorsOrigins } from '../../common/ws-cors';

type EntityType = 'project' | 'task' | 'zone';
const ENTITY_TYPES: readonly EntityType[] = ['project', 'task', 'zone'];

@WebSocketGateway({
  cors: {
    origin: socketCorsOrigins(),
    credentials: true,
  },
  namespace: '/messaging',
})
export class MessagesGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MessagesGateway.name);
  private userSockets = new Map<number, Set<string>>();

  constructor(
    private readonly wsAuth: WsAuthService,
    private readonly access: ProjectAccessService,
  ) {}

  /**
   * Permissions round 1 (2026-11-20) — the handshake must carry a valid
   * access token (`auth.token` or `Authorization: Bearer`); the user is
   * stored on `client.data.user` and `handshake.query.userId` is never
   * read. Unauthenticated sockets are disconnected.
   */
  async handleConnection(client: Socket) {
    const user = await this.wsAuth.authenticate(client);
    if (!user) {
      this.logger.warn(`Rejected unauthenticated messaging socket ${client.id}`);
      client.disconnect(true);
      return;
    }
    client.data.user = user;
    if (!this.userSockets.has(user.id)) {
      this.userSockets.set(user.id, new Set());
    }
    this.userSockets.get(user.id)!.add(client.id);
    this.logger.log(`Messaging client connected: ${client.id} (user: ${user.id})`);
  }

  handleDisconnect(client: Socket) {
    const userId: number | undefined = client.data?.user?.id;
    if (userId && this.userSockets.has(userId)) {
      this.userSockets.get(userId)!.delete(client.id);
      if (this.userSockets.get(userId)!.size === 0) {
        this.userSockets.delete(userId);
      }
    }
  }

  /**
   * Join an entity room. The caller must pass the same project / task /
   * zone access check the HTTP routes use; otherwise a `message:error`
   * event is emitted and the socket does not join.
   */
  @SubscribeMessage('message:join')
  async handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { entityType: string; entityId: number },
  ) {
    const user = client.data?.user;
    if (!user) {
      this.emitError(client, 'message:join', 'Not authenticated');
      return;
    }
    const target = parseEntity(data);
    if (!target) {
      this.emitError(client, 'message:join', 'entityType must be project, task or zone and entityId a positive integer');
      return;
    }
    try {
      await this.assertEntityAccess(user, target.entityType, target.entityId);
    } catch {
      this.emitError(
        client,
        'message:join',
        `You do not have access to this ${target.entityType}`,
        target,
      );
      return;
    }
    const room = roomFor(target.entityType, target.entityId);
    client.join(room);
    this.logger.debug(`Client ${client.id} (user ${user.id}) joined room ${room}`);
  }

  @SubscribeMessage('message:leave')
  handleLeaveRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { entityType: string; entityId: number },
  ) {
    const target = parseEntity(data);
    if (!target) return;
    client.leave(roomFor(target.entityType, target.entityId));
  }

  /**
   * Typing indicator. The user id comes from the authenticated socket,
   * and only a socket that already joined the room (i.e. passed the
   * access check) can broadcast into it.
   */
  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { entityType: string; entityId: number },
  ) {
    const userId: number | undefined = client.data?.user?.id;
    const target = parseEntity(data);
    if (!userId || !target) return;
    const room = roomFor(target.entityType, target.entityId);
    if (!client.rooms.has(room)) return;
    this.server.to(room).emit('typing:start', { userId });

    // Auto-stop typing after 3 seconds
    setTimeout(() => {
      this.server.to(room).emit('typing:stop', { userId });
    }, 3000);
  }

  // ─── Event listeners for real-time message broadcasting ─────────────────

  @OnEvent('message.created')
  handleMessageCreated(payload: { message: any; entityType: string; entityId: number }) {
    return this.emitToRoom(payload.entityType, payload.entityId, 'message:new', { message: payload.message });
  }

  @OnEvent('message.updated')
  handleMessageUpdated(payload: { message: any; entityType: string; entityId: number }) {
    return this.emitToRoom(payload.entityType, payload.entityId, 'message:updated', { message: payload.message });
  }

  @OnEvent('message.deleted')
  handleMessageDeleted(payload: { messageId: number; entityType: string; entityId: number }) {
    return this.emitToRoom(payload.entityType, payload.entityId, 'message:deleted', { messageId: payload.messageId });
  }

  /**
   * Round 4 (review fix) — a socket keeps its rooms after its user loses
   * access to the project (removed as a member, partner role or task
   * assignee, a new leader, an org-unit change …). So every broadcast
   * re-checks each socket in the room with the same rule as message:join
   * (one check per user per broadcast): a user who no longer passes is
   * taken out of the room and gets nothing. This covers project, task and
   * zone rooms and every removal path, without hooks in each of them.
   */
  private async emitToRoom(entityType: string, entityId: number, event: string, data: unknown): Promise<void> {
    const target = parseEntity({ entityType, entityId });
    if (!target) return;
    const room = roomFor(target.entityType, target.entityId);
    try {
      const sockets = await this.server.in(room).fetchSockets();
      const verdicts = new Map<number, Promise<'allowed' | 'denied' | 'error'>>();
      const verdictFor = (user: any) => {
        let verdict = verdicts.get(user.id);
        if (!verdict) {
          verdict = this.assertEntityAccess(user, target.entityType, target.entityId).then(
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
            socket.emit(event, data);
          } else if (verdict === 'denied') {
            socket.leave(room);
            this.logger.debug(`Socket ${socket.id} (user ${user?.id}) lost access; left room ${room}`);
          }
          // 'error' (e.g. the database is unreachable): this event is
          // skipped for the socket, which keeps its room.
        }),
      );
    } catch (err) {
      this.logger.warn(`Broadcast ${event} to ${room} failed: ${(err as Error)?.message ?? err}`);
    }
  }

  private async assertEntityAccess(user: any, entityType: EntityType, entityId: number): Promise<void> {
    const isAdmin = isAdminUser(user);
    switch (entityType) {
      case 'project':
        await this.access.assertProjectAccess(user.id, entityId, isAdmin);
        return;
      case 'task':
        await this.access.assertTaskAccess(user.id, entityId, isAdmin);
        return;
      case 'zone':
        await this.access.assertZoneAccess(user.id, entityId, isAdmin);
        return;
    }
  }

  private emitError(
    client: Socket,
    event: string,
    message: string,
    target?: { entityType: EntityType; entityId: number },
  ) {
    client.emit('message:error', { event, message, ...(target ?? {}) });
  }
}

function parseEntity(data: unknown): { entityType: EntityType; entityId: number } | null {
  const d = (data ?? {}) as { entityType?: unknown; entityId?: unknown };
  const entityType = d.entityType as EntityType;
  const entityId = Number(d.entityId);
  if (!ENTITY_TYPES.includes(entityType)) return null;
  if (!Number.isInteger(entityId) || entityId <= 0) return null;
  return { entityType, entityId };
}

function roomFor(entityType: EntityType, entityId: number): string {
  return `entity-${entityType}-${entityId}`;
}
