import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Project Status Board — the Notion-style table where rows = projects
 * and columns = stage milestones (URS, Architectural Review, Stage 1,
 * …). One endpoint pulls everything needed to render the board so the
 * client doesn't have to fan out N+1 calls.
 *
 * Toggle endpoint flips a single milestone for a single project; it
 * upserts the (project, milestone) row so the first click creates it
 * and subsequent clicks update.
 */
@ApiTags('Project Status Board')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('project-status-board')
export class ProjectStatusBoardController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the board payload: ordered milestone columns + every
   * project's per-milestone completion status. The frontend renders
   * directly off this shape — no further mapping needed.
   */
  @Get()
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Fetch the project × milestone status board' })
  async getBoard() {
    const [milestones, projects, statuses] = await Promise.all([
      this.prisma.projectStageMilestone.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.project.findMany({
        where: { deletedAt: null, isArchived: false },
        select: {
          id: true,
          name: true,
          number: true,
          status: true,
          startDate: true,
          endDate: true,
        },
        orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
      }),
      // Pull ALL statuses in one query — for any reasonable project
      // count (low thousands) this is faster than per-project lookups.
      this.prisma.projectMilestoneStatus.findMany({
        select: {
          projectId: true,
          milestoneId: true,
          isCompleted: true,
          completedAt: true,
        },
      }),
    ]);

    // Index statuses by projectId for O(1) lookup on the client.
    const byProject: Record<number, Record<number, { isCompleted: boolean; completedAt: string | null }>> = {};
    for (const s of statuses) {
      if (!byProject[s.projectId]) byProject[s.projectId] = {};
      byProject[s.projectId][s.milestoneId] = {
        isCompleted: s.isCompleted,
        completedAt: s.completedAt ? s.completedAt.toISOString() : null,
      };
    }

    return {
      milestones,
      projects: projects.map((p) => ({
        ...p,
        year: p.startDate ? p.startDate.getFullYear() : null,
        statuses: byProject[p.id] ?? {},
      })),
    };
  }

  // ─── Catalog admin (milestone CRUD) ───────────────────────────────
  //
  // Listing / inserting / renaming / soft-deleting milestone columns.
  // Powers the /admin/project-stage-milestones admin page. Gated by
  // admin module write so only org admins can change the catalog —
  // the board itself is gated only by projects:read.

  @Get('milestones')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'List the full milestone catalog (incl. inactive)' })
  async listMilestones() {
    return this.prisma.projectStageMilestone.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  }

  @Post('milestones')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Create a new milestone column' })
  async createMilestone(@Body() body: { code: string; name: string; description?: string; sortOrder?: number }) {
    return this.prisma.projectStageMilestone.create({
      data: {
        code: body.code.trim(),
        name: body.name.trim(),
        description: body.description?.trim() || null,
        sortOrder: body.sortOrder ?? 0,
        isActive: true,
      },
    });
  }

  @Patch('milestones/:id')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Update a milestone column' })
  async updateMilestone(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Partial<{ code: string; name: string; description: string | null; sortOrder: number; isActive: boolean }>,
  ) {
    const existing = await this.prisma.projectStageMilestone.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Milestone not found');
    return this.prisma.projectStageMilestone.update({
      where: { id },
      data: {
        code: body.code?.trim(),
        name: body.name?.trim(),
        description: body.description ?? undefined,
        sortOrder: body.sortOrder,
        isActive: body.isActive,
      },
    });
  }

  @Delete('milestones/:id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  @ApiOperation({ summary: 'Hard-delete a milestone (with all per-project statuses)' })
  async deleteMilestone(@Param('id', ParseIntPipe) id: number) {
    const existing = await this.prisma.projectStageMilestone.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Milestone not found');
    // Cascade DELETE on the FK takes the statuses with it. We hard-
    // delete (not soft) because a column with no value across all
    // projects has no historical signal worth keeping; admins should
    // toggle isActive=false to hide without losing data instead.
    await this.prisma.projectStageMilestone.delete({ where: { id } });
    return { message: 'Milestone deleted', id };
  }

  // ─── Per-cell toggle ──────────────────────────────────────────────

  /**
   * Toggle a single (project, milestone) cell. Upserts so the first
   * click creates the row at isCompleted=true; subsequent flips
   * mutate. Tracks who completed it + when for audit.
   */
  @Post('toggle/:projectId/:milestoneId')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Toggle a milestone cell for a project' })
  async toggle(
    @CurrentUser() user: any,
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('milestoneId', ParseIntPipe) milestoneId: number,
    @Body('isCompleted') isCompleted?: boolean,
  ) {
    // If isCompleted not supplied, read the current value and flip.
    const existing = await this.prisma.projectMilestoneStatus.findUnique({
      where: { projectId_milestoneId: { projectId, milestoneId } },
    });
    const nextCompleted = isCompleted === undefined ? !(existing?.isCompleted ?? false) : !!isCompleted;
    return this.prisma.projectMilestoneStatus.upsert({
      where: { projectId_milestoneId: { projectId, milestoneId } },
      create: {
        projectId,
        milestoneId,
        isCompleted: nextCompleted,
        completedAt: nextCompleted ? new Date() : null,
        completedBy: nextCompleted ? user.id : null,
      },
      update: {
        isCompleted: nextCompleted,
        completedAt: nextCompleted ? new Date() : null,
        completedBy: nextCompleted ? user.id : null,
      },
    });
  }
}
