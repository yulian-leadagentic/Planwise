import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { PrismaModule } from '../../prisma/prisma.module';
import { WsAuthModule } from '../../common/ws-auth.module';
import { AuthorizationModule } from '../../common/authorization.module';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeEventsListener } from './realtime-events.listener';
import { RealtimeInvalidationInterceptor } from './realtime.interceptor';
import { RealtimeTargetsService } from './realtime-targets.service';

/**
 * QA6 P10 · PR-079 — live task / project invalidations across tabs.
 * WsAuthModule: handshake token; AuthorizationModule: the project-access
 * rule for room joins and every broadcast. The interceptor is global
 * (APP_INTERCEPTOR) and only acts on the writes in REALTIME_ROUTES.
 */
@Module({
  imports: [PrismaModule, WsAuthModule, AuthorizationModule],
  providers: [
    RealtimeGateway,
    RealtimeEventsListener,
    RealtimeTargetsService,
    { provide: APP_INTERCEPTOR, useClass: RealtimeInvalidationInterceptor },
  ],
})
export class RealtimeModule {}
