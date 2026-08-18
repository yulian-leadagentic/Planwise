import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('Admin - Activity Log')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/activity-logs')
export class ActivityLogController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @RequirePermissions({ module: 'admin/activity-log', action: 'read' })
  @ApiOperation({ summary: 'List activity logs with filters' })
  async findAll(
    @Query('page') page?: number,
    @Query('perPage') perPage?: number,
    @Query('category') category?: string,
    @Query('severity') severity?: string,
    @Query('userId') userId?: number,
    @Query('entityType') entityType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const take = Number(perPage) || 50;
    const skip = ((Number(page) || 1) - 1) * take;

    const where: any = {};
    if (category) where.category = category;
    if (severity) where.severity = severity;
    if (userId) where.userId = Number(userId);
    if (entityType) where.entityType = entityType;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const [rows, total] = await Promise.all([
      this.prisma.activityLog.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      }),
      this.prisma.activityLog.count({ where }),
    ]);

    // ActivityLog.id is a BigInt (JSON can't represent 64-bit ints),
    // so stringify to match the per-project endpoint's shape (see
    // projects.service.getActivityLogs). This is redundant with the
    // global BigInt.prototype.toJSON patch in main.ts but stays as a
    // belt-and-suspenders guard: if the global patch is ever removed
    // for isolation reasons, this endpoint still returns 200.
    const data = rows.map((r) => ({ ...r, id: r.id.toString() }));

    return {
      data,
      meta: {
        total,
        page: Number(page) || 1,
        perPage: take,
        totalPages: Math.ceil(total / take),
      },
    };
  }
}
