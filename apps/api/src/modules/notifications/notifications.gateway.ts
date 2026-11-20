import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

import { WsAuthService } from '../../common/services/ws-auth.service';

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  },
  namespace: '/notifications',
})
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);
  private userSockets = new Map<number, Set<string>>();

  constructor(private readonly wsAuth: WsAuthService) {}

  /**
   * Permissions round 1 (2026-11-20) — the handshake must carry a valid
   * access token (`auth.token` or `Authorization: Bearer`). The user id
   * comes from the token only; `handshake.query.userId` is ignored. A
   * socket that fails authentication is disconnected before it joins
   * any room. The only room a client ever joins here is its own
   * `user-${id}`.
   */
  async handleConnection(client: Socket) {
    const user = await this.wsAuth.authenticate(client);
    if (!user) {
      this.logger.warn(`Rejected unauthenticated notifications socket ${client.id}`);
      client.disconnect(true);
      return;
    }
    client.data.user = user;
    if (!this.userSockets.has(user.id)) {
      this.userSockets.set(user.id, new Set());
    }
    this.userSockets.get(user.id)!.add(client.id);
    client.join(`user-${user.id}`);
    this.logger.log(`Client connected: ${client.id} (user: ${user.id})`);
  }

  handleDisconnect(client: Socket) {
    const userId: number | undefined = client.data?.user?.id;
    if (userId && this.userSockets.has(userId)) {
      this.userSockets.get(userId)!.delete(client.id);
      if (this.userSockets.get(userId)!.size === 0) {
        this.userSockets.delete(userId);
      }
    }
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @OnEvent('notification.created')
  handleNotificationCreated(notification: any) {
    this.server.to(`user-${notification.userId}`).emit('notification', notification);
  }
}
