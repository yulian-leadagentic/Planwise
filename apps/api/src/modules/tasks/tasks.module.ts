import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskChecklistService } from './task-checklist.service';
import { AuthorizationModule } from '../../common/authorization.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // NotificationsModule is imported so TasksService can notify each
  // assignee when a task's attachments change (per user feedback
  // 2026-06-22 — added/removed files often slip past the assignees
  // who actually own the work).
  imports: [AuthorizationModule, NotificationsModule],
  controllers: [TasksController],
  providers: [TasksService, TaskChecklistService],
  exports: [TasksService, TaskChecklistService],
})
export class TasksModule {}
