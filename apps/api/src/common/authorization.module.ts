import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectAccessService } from './services/project-access.service';
import { StageTransitionService } from './services/stage-transition.service';
import { ResourceOverrideService } from './services/resource-override.service';
import { OrgUnitService } from './services/org-unit.service';
import { EmployeeScopeService } from './services/employee-scope.service';

@Module({
  imports: [PrismaModule],
  providers: [ProjectAccessService, StageTransitionService, ResourceOverrideService, OrgUnitService, EmployeeScopeService],
  exports: [ProjectAccessService, StageTransitionService, ResourceOverrideService, OrgUnitService, EmployeeScopeService],
})
export class AuthorizationModule {}
