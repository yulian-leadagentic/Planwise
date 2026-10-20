import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { AuthorizationModule } from '../../common/authorization.module';
import { ExecutionPlanningModule } from '../execution-planning/execution-planning.module';
import { SchedulerService } from './scheduler.service';
import { SchedulingController } from './scheduling.controller';

/**
 * T3 · Working-Day Scheduling Engine module.
 * Imports ExecutionPlanningModule so the SchedulerService can reuse
 * `countWorkingDays` instead of duplicating the closed-form loop.
 */
@Module({
  imports: [PrismaModule, AuthorizationModule, ExecutionPlanningModule],
  controllers: [SchedulingController],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulingModule {}
