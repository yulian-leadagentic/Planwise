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
import { ServicesModule } from './modules/services/services.module';
import { DeliverablesModule } from './modules/deliverables/deliverables.module';
import { AssignmentsModule } from './modules/assignments/assignments.module';
import { PlanningModule } from './modules/planning/planning.module';

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
    ServicesModule,
    DeliverablesModule,
    AssignmentsModule,
    PlanningModule,
  ],
})
export class AppModule {}
