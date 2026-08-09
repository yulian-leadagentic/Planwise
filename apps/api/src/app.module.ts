import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoggerModule } from 'nestjs-pino';
import * as crypto from 'crypto';

import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { LabelsModule } from './modules/labels/labels.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { TimeModule } from './modules/time/time.module';
import { ContractsModule } from './modules/contracts/contracts.module';
import { UsersModule } from './modules/users/users.module';
import { ReportsModule } from './modules/reports/reports.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { FilesModule } from './modules/files/files.module';
import { ProjectFilesModule } from './modules/project-files/project-files.module';
import { BusinessPartnersModule } from './modules/business-partners/business-partners.module';
import { BusinessPartnerRelationshipsModule } from './modules/business-partner-relationships/business-partner-relationships.module';
import { PartnerTypesModule } from './modules/partner-types/partner-types.module';
import { AdminModule } from './modules/admin/admin.module';
import { OrgModule } from './modules/org/org.module';
import { ZonesModule } from './modules/zones/zones.module';
import { PlanningModule } from './modules/planning/planning.module';
import { ServiceTypesModule } from './modules/service-types/service-types.module';
import { PhasesModule } from './modules/phases/phases.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { MessagesModule } from './modules/messages/messages.module';
import { ExecutionPlanningModule } from './modules/execution-planning/execution-planning.module';
import { ExecutionBoardModule } from './modules/execution-board/execution-board.module';
import { HealthModule } from './modules/health/health.module';
import { PresenceModule } from './modules/presence/presence.module';
import { NumberRangesModule } from './modules/number-ranges/number-ranges.module';
import { EntityKindsModule } from './modules/entity-kinds/entity-kinds.module';
import { PartnerRelationshipsModule } from './modules/partner-relationships/partner-relationships.module';
import { ProjectRoleTypesModule } from './modules/project-role-types/project-role-types.module';
import { ProjectPartnerRolesModule } from './modules/project-partner-roles/project-partner-roles.module';
import { DataImportModule } from './modules/data-import/data-import.module';
import { ProjectStatusBoardModule } from './modules/project-status-board/project-status-board.module';
import { ProjectDeliverablesModule } from './modules/project-deliverables/project-deliverables.module';
import { ActivityLogModule } from './common/services/activity-log.module';
import { SecretCryptoModule } from './common/secret-crypto.module';
import { SsoAdminModule } from './modules/sso-admin/sso-admin.module';
import { DriveAdminModule } from './modules/drive-admin/drive-admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../../.env',
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
        // Pretty-print in dev; JSON in prod for log aggregators
        transport: process.env.NODE_ENV === 'production'
          ? undefined
          : { target: require.resolve('pino-pretty'), options: { singleLine: true, translateTime: 'HH:MM:ss.l' } },
        // Redact obvious secrets; extend this list as needed
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.currentPassword',
            'req.body.newPassword',
            'req.body.refreshToken',
            'res.headers["set-cookie"]',
          ],
          censor: '[REDACTED]',
        },
        // Add a request-id to every log line so a request can be traced end-to-end
        genReqId: (req) => (req.headers['x-request-id'] as string) ?? crypto.randomUUID(),
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
        customProps: (req: any) => ({
          userId: req.user?.id,
        }),
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    PrismaModule,
    ActivityLogModule,
    SecretCryptoModule,
    AuthModule,
    ProjectsModule,
    LabelsModule,
    TasksModule,
    TimeModule,
    ContractsModule,
    UsersModule,
    ReportsModule,
    NotificationsModule,
    FilesModule,
    ProjectFilesModule,
    BusinessPartnersModule,
    BusinessPartnerRelationshipsModule,
    PartnerTypesModule,
    AdminModule,
    OrgModule,
    ZonesModule,
    PlanningModule,
    ServiceTypesModule,
    PhasesModule,
    TemplatesModule,
    MessagesModule,
    ExecutionPlanningModule,
    ExecutionBoardModule,
    HealthModule,
    PresenceModule,
    NumberRangesModule,
    EntityKindsModule,
    PartnerRelationshipsModule,
    ProjectRoleTypesModule,
    ProjectPartnerRolesModule,
    DataImportModule,
    ProjectStatusBoardModule,
    ProjectDeliverablesModule,
    SsoAdminModule,
    DriveAdminModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
