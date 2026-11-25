import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskChecklistService } from './task-checklist.service';
import { AuthorizationModule } from '../../common/authorization.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProjectDeliverablesModule } from '../project-deliverables/project-deliverables.module';
import { ProjectPartnerRolesModule } from '../project-partner-roles/project-partner-roles.module';
import { TaskAssigneePolicyService } from './task-assignee-policy.service';

@Module({
  // NotificationsModule is imported so TasksService can notify each
  // assignee when a task's attachments change (per user feedback
  // 2026-06-22 — added/removed files often slip past the assignees
  // who actually own the work).
  //
  // ProjectDeliverablesModule is imported so TasksService.create can
  // call `materializeFromTasks` as a defensive hook after any task
  // create that sets `deliverableTemplateId` without a matching
  // `projectDeliverableId` (DP-EMPTY-3, 2026-11-08). Keeps the
  // invariant "every task with a template link has a PD" intact for
  // every future task-create surface.
  //
  // ProjectPartnerRolesModule (QA6) — TaskAssigneePolicyService adds a
  // `participant` Team role when the leader / an Admin assigns someone
  // who is not on the project's Team yet.
  imports: [AuthorizationModule, NotificationsModule, ProjectDeliverablesModule, ProjectPartnerRolesModule],
  controllers: [TasksController],
  providers: [TasksService, TaskChecklistService, TaskAssigneePolicyService],
  exports: [TasksService, TaskChecklistService],
})
export class TasksModule {}
