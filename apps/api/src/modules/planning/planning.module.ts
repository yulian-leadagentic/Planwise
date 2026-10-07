import { Module } from '@nestjs/common';
import { PlanningController, PlanningAdminController } from './planning.controller';
import { PlanningService } from './planning.service';
import { AuthorizationModule } from '../../common/authorization.module';

@Module({
  imports: [AuthorizationModule],
  controllers: [PlanningController, PlanningAdminController],
  providers: [PlanningService],
  exports: [PlanningService],
})
export class PlanningModule {}
