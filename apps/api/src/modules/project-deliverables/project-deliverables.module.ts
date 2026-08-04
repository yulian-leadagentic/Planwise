import { Module } from '@nestjs/common';
import { ProjectDeliverablesController } from './project-deliverables.controller';
import { ProjectDeliverablesService } from './project-deliverables.service';
import { AuthorizationModule } from '../../common/authorization.module';
import { ActivityLogModule } from '../../common/services/activity-log.module';

@Module({
  imports: [AuthorizationModule, ActivityLogModule],
  controllers: [ProjectDeliverablesController],
  providers: [ProjectDeliverablesService],
  exports: [ProjectDeliverablesService],
})
export class ProjectDeliverablesModule {}
