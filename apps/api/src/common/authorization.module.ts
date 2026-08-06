import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectAccessService } from './services/project-access.service';
import { StageTransitionService } from './services/stage-transition.service';
import { ResourceOverrideService } from './services/resource-override.service';
import { OrgUnitService } from './services/org-unit.service';

@Module({
  imports: [PrismaModule],
  providers: [ProjectAccessService, StageTransitionService, ResourceOverrideService, OrgUnitService],
  exports: [ProjectAccessService, StageTransitionService, ResourceOverrideService, OrgUnitService],
})
export class AuthorizationModule {}
