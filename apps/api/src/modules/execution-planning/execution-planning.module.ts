import { Module } from '@nestjs/common';
import { ExecutionPlanningController } from './execution-planning.controller';
import { ExecutionPlanningService } from './execution-planning.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthorizationModule } from '../../common/authorization.module';

@Module({
  imports: [PrismaModule, AuthorizationModule],
  controllers: [ExecutionPlanningController],
  providers: [ExecutionPlanningService],
  exports: [ExecutionPlanningService],
})
export class ExecutionPlanningModule {}
