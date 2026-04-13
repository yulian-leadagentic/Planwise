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
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  },
  namespace: '/messaging',
})
export class MessagesGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MessagesGateway.name);
  private userSockets = new Map<number, Set<string>>();

  handleConnection(client: Socket) {
    const userId = this.extractUserId(client);
    if (userId) {
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)!.add(client.id);
      this.logger.log(`Messaging client connected: ${client.id} (user: ${userId})`);
    }
  }

  handleDisconnect(client: Socket) {
    const userId = this.extractUserId(client);
    if (userId && this.userSockets.has(userId)) {
      this.userSockets.get(userId)!.delete(client.id);
      if (this.userSockets.get(userId)!.size === 0) {
        this.userSockets.delete(userId);
      }
    }
  }

  @SubscribeMessage('message:join')
  handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { entityType: string; entityId: number },
  ) {
    const room = `entity-${data.entityType}-${data.entityId}`;
    client.join(room);
    this.logger.debug(`Client ${client.id} joined room ${room}`);
  }

  @SubscribeMessage('message:leave')
  handleLeaveRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { entityType: string; entityId: number },
  ) {
    const room = `entity-${data.entityType}-${data.entityId}`;
    client.leave(room);
  }

  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { entityType: string; entityId: number },
  ) {
    const userId = this.extractUserId(client);
    const room = `entity-${data.entityType}-${data.entityId}`;
    this.server.to(room).emit('typing:start', { userId });

    // Auto-stop typing after 3 seconds
    setTimeout(() => {
      this.server.to(room).emit('typing:stop', { userId });
    }, 3000);
  }

  // ─── Event listeners for real-time message broadcasting ─────────────────

  @OnEvent('message.created')
  handleMessageCreated(payload: { message: any; entityType: string; entityId: number }) {
    const room = `entity-${payload.entityType}-${payload.entityId}`;
    this.server.to(room).emit('message:new', { message: payload.message });
  }

  @OnEvent('message.updated')
  handleMessageUpdated(payload: { message: any; entityType: string; entityId: number }) {
    const room = `entity-${payload.entityType}-${payload.entityId}`;
    this.server.to(room).emit('message:updated', { message: payload.message });
  }

  @OnEvent('message.deleted')
  handleMessageDeleted(payload: { messageId: number; entityType: string; entityId: number }) {
    const room = `entity-${payload.entityType}-${payload.entityId}`;
    this.server.to(room).emit('message:deleted', { messageId: payload.messageId });
  }

  private extractUserId(client: Socket): number | null {
    const userId = client.handshake.query.userId;
    return userId ? Number(userId) : null;
  }
}
