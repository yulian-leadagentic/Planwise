import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { BusinessPartnerRelationshipsModule } from '../business-partner-relationships/business-partner-relationships.module';
import { UsersModule } from '../users/users.module';
import { NumberRangesModule } from '../number-ranges/number-ranges.module';
import { AuthorizationModule } from '../../common/authorization.module';

@Module({
  // UsersModule is imported for UserSenioritiesService — the project
  // labor-cost calc needs to resolve each TimeEntry's date-effective
  // seniority. Heavy module but the dependency is just one service.
  // NumberRangesModule provides auto/manual project-number allocation.
  // AuthorizationModule provides ProjectAccessService — used to scope the
  // project list to projects the current user can access.
  imports: [BusinessPartnerRelationshipsModule, UsersModule, NumberRangesModule, AuthorizationModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
