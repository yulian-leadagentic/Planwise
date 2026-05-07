import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { PresenceService } from './presence.service';

@ApiTags('Presence')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('presence')
export class PresenceController {
  constructor(
    private readonly presence: PresenceService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Refresh the caller's presence on a project. Idempotent — call every
   * ~20s while the user has the page open. The TTL on the server is 60s
   * so missing one heartbeat is OK.
   */
  @Post('heartbeat')
  @ApiOperation({ summary: 'Heartbeat to mark this user as present on a project' })
  heartbeat(@Body() body: { projectId: number }, @Req() req: any) {
    const userId = req.user?.id;
    if (!userId || !body?.projectId) return { ok: false };
    this.presence.heartbeat(Number(body.projectId), Number(userId));
    return { ok: true };
  }

  /**
   * Best-effort "leave" called via sendBeacon on page unmount. The TTL
   * sweep would handle this anyway, but explicit leave makes the
   * indicator update faster for everyone else watching.
   */
  @Post('leave')
  @ApiOperation({ summary: 'Mark this user as gone from a project page' })
  leave(@Body() body: { projectId: number }, @Req() req: any) {
    const userId = req.user?.id;
    if (!userId || !body?.projectId) return { ok: false };
    this.presence.leave(Number(body.projectId), Number(userId));
    return { ok: true };
  }

  /**
   * List who's currently on a project page (active in the last 60s).
   * Returns user records with avatar so the frontend can render the
   * presence indicator without a second roundtrip.
   */
  @Get('project/:id')
  @ApiOperation({ summary: 'List users currently active on a project page' })
  async listForProject(@Param('id', ParseIntPipe) projectId: number) {
    const users = await this.presence.listActiveUsers(projectId, this.prisma);
    return users;
  }
}
