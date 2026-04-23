import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectAccessService } from './services/project-access.service';
import { StageTransitionService } from './services/stage-transition.service';
import { ResourceOverrideService } from './services/resource-override.service';

@Module({
  imports: [PrismaModule],
  providers: [ProjectAccessService, StageTransitionService, ResourceOverrideService],
  exports: [ProjectAccessService, StageTransitionService, ResourceOverrideService],
})
export class AuthorizationModule {}
