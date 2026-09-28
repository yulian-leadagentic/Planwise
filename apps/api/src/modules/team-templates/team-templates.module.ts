import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../../common/authorization.module';
import { ProjectPartnerRolesModule } from '../project-partner-roles/project-partner-roles.module';
import { TeamTemplatesController } from './team-templates.controller';
import { TeamTemplatesService } from './team-templates.service';

/**
 * Phase 4 · Stage 4 follow-up (2026-09-28). Owns the apply-flow only
 * (POST /team-templates/:templateId/apply). CRUD stays on
 * admin/config.controller.ts for one release — a follow-up ticket
 * consolidates once the free-text `role` column retires.
 */
@Module({
  imports: [AuthorizationModule, ProjectPartnerRolesModule],
  controllers: [TeamTemplatesController],
  providers: [TeamTemplatesService],
})
export class TeamTemplatesModule {}
