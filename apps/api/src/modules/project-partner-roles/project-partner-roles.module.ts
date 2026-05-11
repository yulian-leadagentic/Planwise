import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../../common/authorization.module';
import { ProjectPartnerRolesController } from './project-partner-roles.controller';
import { ProjectPartnerRolesService } from './project-partner-roles.service';

@Module({
  imports: [AuthorizationModule],
  controllers: [ProjectPartnerRolesController],
  providers: [ProjectPartnerRolesService],
  exports: [ProjectPartnerRolesService],
})
export class ProjectPartnerRolesModule {}
