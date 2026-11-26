import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { AuthorizationModule } from '../../common/authorization.module';
import { TasksModule } from '../tasks/tasks.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ExecutionPlanningModule } from '../execution-planning/execution-planning.module';
import { WorkloadAssignController } from './workload-assign.controller';
import { TaskReassignService } from './task-reassign.service';

/**
 * QA6 package 4 (PR-063) — drag-and-drop task assignment in
 * Operations › Workload: POST /tasks/:id/reassign and
 * /workload/reassignments. TasksModule provides the QA6 assignee policy,
 * ExecutionPlanningModule the workload rows the responses carry.
 */
@Module({
  imports: [PrismaModule, AuthorizationModule, TasksModule, NotificationsModule, ExecutionPlanningModule],
  controllers: [WorkloadAssignController],
  providers: [TaskReassignService],
})
export class WorkloadAssignModule {}
