import { Module } from '@nestjs/common';
import { ExecutionPlanningController } from './execution-planning.controller';
import { ExecutionPlanningService } from './execution-planning.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ExecutionPlanningController],
  providers: [ExecutionPlanningService],
  exports: [ExecutionPlanningService],
})
export class ExecutionPlanningModule {}
