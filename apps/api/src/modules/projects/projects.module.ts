import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { BusinessPartnerRelationshipsModule } from '../business-partner-relationships/business-partner-relationships.module';
import { UsersModule } from '../users/users.module';

@Module({
  // UsersModule is imported for UserSenioritiesService — the project
  // labor-cost calc needs to resolve each TimeEntry's date-effective
  // seniority. Heavy module but the dependency is just one service.
  imports: [BusinessPartnerRelationshipsModule, UsersModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
