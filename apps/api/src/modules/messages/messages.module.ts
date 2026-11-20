import { Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { MessagesGateway } from './messages.gateway';
import { SystemMessagesListener } from './system-messages.listener';
import { PrismaModule } from '../../prisma/prisma.module';
import { WsAuthModule } from '../../common/ws-auth.module';
import { AuthorizationModule } from '../../common/authorization.module';

@Module({
  // WsAuthModule — handshake token verification; AuthorizationModule —
  // ProjectAccessService for the gateway's room-join checks.
  imports: [PrismaModule, WsAuthModule, AuthorizationModule],
  controllers: [MessagesController],
  providers: [MessagesService, MessagesGateway, SystemMessagesListener],
  exports: [MessagesService],
})
export class MessagesModule {}
