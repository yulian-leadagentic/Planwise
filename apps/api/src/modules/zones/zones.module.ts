import { Module } from '@nestjs/common';
import { ZonesController } from './zones.controller';
import { ZonesService } from './zones.service';
import { AuthorizationModule } from '../../common/authorization.module';
import { ProjectDeliverablesModule } from '../project-deliverables/project-deliverables.module';

@Module({
  imports: [AuthorizationModule, ProjectDeliverablesModule],
  controllers: [ZonesController],
  providers: [ZonesService],
  exports: [ZonesService],
})
export class ZonesModule {}
