import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskChecklistService } from './task-checklist.service';
import { AuthorizationModule } from '../../common/authorization.module';

@Module({
  imports: [AuthorizationModule],
  controllers: [TasksController],
  providers: [TasksService, TaskChecklistService],
  exports: [TasksService, TaskChecklistService],
})
export class TasksModule {}
