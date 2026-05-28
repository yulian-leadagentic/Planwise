import { Module } from '@nestjs/common';
import { ProjectDeliverablesController } from './project-deliverables.controller';
import { ProjectDeliverablesService } from './project-deliverables.service';
import { AuthorizationModule } from '../../common/authorization.module';

@Module({
  imports: [AuthorizationModule],
  controllers: [ProjectDeliverablesController],
  providers: [ProjectDeliverablesService],
  exports: [ProjectDeliverablesService],
})
export class ProjectDeliverablesModule {}
