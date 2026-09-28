import {
  BadRequestException,
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TeamTemplatesService } from './team-templates.service';

/**
 * Phase 4 · Stage 4 follow-up (2026-09-28) — apply flow endpoint.
 *
 * The Team Templates CRUD lives on `admin/config/team-templates/*`
 * (see admin/config.controller.ts); this controller only owns the
 * apply-to-project operation, which conceptually belongs to the
 * "operate on a project's team" surface rather than admin-config.
 * Gated by `partners:write` — same permission the Team-tab add flow
 * uses, so an admin who can add a person to a project's team can
 * apply a template of them.
 */
@ApiTags('Team Templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('team-templates')
export class TeamTemplatesController {
  constructor(private readonly service: TeamTemplatesService) {}

  @Post(':templateId/apply')
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({
    summary:
      'Apply a Team Template to a project — creates ProjectPartnerRole rows via M3 eligibility. Never throws on partial failure; returns applied + skipped(with reasons).',
  })
  async apply(
    @CurrentUser() user: any,
    @Param('templateId', ParseIntPipe) templateId: number,
    @Body() body: { projectId?: number | string },
  ) {
    const projectId = Number(body?.projectId);
    if (!Number.isFinite(projectId) || projectId <= 0) {
      throw new BadRequestException('projectId is required (positive integer)');
    }
    return this.service.apply(templateId, projectId, user?.id);
  }
}
