/**
 * DriveController — endpoints to open/create Drive folders for a
 * project/zone/deliverable and to attach existing Drive files.
 *
 * Every mutation is gated by JwtAuth + Roles + projects:read (for the
 * folder-ensure endpoints — "opening" is read intent) or projects:write
 * (for attach — creates a project_files row). Every request also
 * checks project access via ProjectAccessService.
 *
 * Rate-limited via @Throttle — attach and ensure-folder call out to
 * Google, and we don't want a runaway loop to hammer the SA quota.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DriveService } from './drive.service';

interface AttachDriveDto {
  driveUrl?: string;
}

@ApiTags('Drive')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class DriveController {
  constructor(
    private readonly drive: DriveService,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Status probe ──────────────────────────────────────────────────

  /**
   * Lightweight status endpoint so the client can gate Drive UI (buttons,
   * attach dialogs) without needing admin permissions on the config
   * route. Returns ONLY two booleans — no key, no Shared Drive id, no
   * other secret. `enabled` = a config row exists AND its enabled
   * toggle is on; `configured` = a config row exists at all. Any
   * signed-in user with basic project-read access can call it.
   */
  @Get('drive/status')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Report whether Google Drive is configured and enabled.' })
  async getStatus(): Promise<{ enabled: boolean; configured: boolean }> {
    return this.drive.getStatus();
  }

  // ─── Folder ensure ─────────────────────────────────────────────────

  @Post('projects/:id/drive/folder')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Ensure the Drive folder for a project + return its link.' })
  async ensureProjectFolder(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) projectId: number,
  ) {
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    return this.drive.ensureProjectFolder(projectId);
  }

  @Post('zones/:id/drive/folder')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Ensure the Drive folder for a zone + return its link.' })
  async ensureZoneFolder(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) zoneId: number,
  ) {
    await this.access.assertZoneAccess(user.id, zoneId, user.roleId);
    return this.drive.ensureZoneFolder(zoneId);
  }

  @Post('deliverables/:id/drive/folder')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Ensure the Drive folder for a deliverable + return its link.' })
  async ensureDeliverableFolder(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) deliverableId: number,
  ) {
    const del = await this.prisma.projectDeliverable.findFirst({
      where: { id: deliverableId, deletedAt: null },
      select: { projectId: true },
    });
    if (!del) throw new NotFoundException('Deliverable not found');
    await this.access.assertProjectAccess(user.id, del.projectId, user.roleId);
    return this.drive.ensureDeliverableFolder(deliverableId);
  }

  @Get('projects/:id/drive/folder')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({
    summary:
      'Return the cached Drive folder link for a project without auto-creating it.',
  })
  async getProjectFolder(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) projectId: number,
  ) {
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    return (await this.drive.getFolderLink('project', projectId)) ?? null;
  }

  // ─── Attach existing Drive file by URL ─────────────────────────────

  @Post('tasks/:id/drive/attach')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Attach an existing Google Drive file to a task. The file must live in the configured Shared Drive.',
  })
  async attachToTask(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) taskId: number,
    @Body() dto: AttachDriveDto,
  ) {
    if (!dto?.driveUrl || dto.driveUrl.trim().length === 0) {
      throw new BadRequestException('driveUrl is required');
    }
    const projectId = await this.access.assertTaskAccess(user.id, taskId, user.roleId);
    if (projectId == null) {
      // Personal task (no projectId). We don't support Drive attach on
      // personal tasks yet — needs a per-user Drive config we haven't
      // designed. Reject cleanly.
      throw new BadRequestException(
        'Personal tasks (not linked to a project) cannot yet be attached to Google Drive files.',
      );
    }
    return this.drive.attachDriveFile({
      projectId,
      taskId,
      deliverableId: null,
      driveUrlOrId: dto.driveUrl,
      uploadedBy: user.id,
    });
  }

  @Post('deliverables/:id/drive/attach')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Attach an existing Google Drive file to a deliverable. The file must live in the configured Shared Drive.',
  })
  async attachToDeliverable(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) deliverableId: number,
    @Body() dto: AttachDriveDto,
  ) {
    if (!dto?.driveUrl || dto.driveUrl.trim().length === 0) {
      throw new BadRequestException('driveUrl is required');
    }
    const del = await this.prisma.projectDeliverable.findFirst({
      where: { id: deliverableId, deletedAt: null },
      select: { projectId: true },
    });
    if (!del) throw new NotFoundException('Deliverable not found');
    await this.access.assertProjectAccess(user.id, del.projectId, user.roleId);
    return this.drive.attachDriveFile({
      projectId: del.projectId,
      taskId: null,
      deliverableId,
      driveUrlOrId: dto.driveUrl,
      uploadedBy: user.id,
    });
  }
}
