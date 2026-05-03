import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { BusinessPartnerRelationshipsModule } from '../business-partner-relationships/business-partner-relationships.module';

@Module({
  imports: [BusinessPartnerRelationshipsModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
