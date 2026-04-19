import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';

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
import { AdminModule } from './modules/admin/admin.module';
import { ZonesModule } from './modules/zones/zones.module';
import { PlanningModule } from './modules/planning/planning.module';
import { ServiceTypesModule } from './modules/service-types/service-types.module';
import { PhasesModule } from './modules/phases/phases.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { MessagesModule } from './modules/messages/messages.module';
import { ExecutionPlanningModule } from './modules/execution-planning/execution-planning.module';
import { ExecutionBoardModule } from './modules/execution-board/execution-board.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../../.env',
    }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    PrismaModule,
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
    AdminModule,
    ZonesModule,
    PlanningModule,
    ServiceTypesModule,
    PhasesModule,
    TemplatesModule,
    MessagesModule,
    ExecutionPlanningModule,
    ExecutionBoardModule,
  ],
})
export class AppModule {}
