import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsGateway } from './notifications.gateway';
import { WsAuthModule } from '../../common/ws-auth.module';
import { MessagesModule } from '../messages/messages.module';

@Module({
  // WsAuthModule — handshake token verification for the gateway.
  // MessagesModule — MessageAccessService for `canOpenEntity` on the list.
  imports: [WsAuthModule, MessagesModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsGateway],
  exports: [NotificationsService],
})
export class NotificationsModule {}
