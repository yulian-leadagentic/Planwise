import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Qa6OperationsGrantsService, parseQa6OperationsGrantsBody } from './qa6-operations-grants.service';

/**
 * QA6 P7 (PR-056) — `POST /admin/backfills/qa6-operations-grants`.
 *
 * Same convention as `p1-copies-to-refs` (abac635): DRY-RUN IS THE
 * DEFAULT and the switch is in the body — only `{ "dryRun": false }`
 * writes. Kept in its own controller under the same `admin/backfills`
 * prefix (BackfillsController is shared by several QA6 branches; this
 * keeps them from colliding). Guarded by `admin:write` like every
 * backfill. Contract: Qa6OperationsGrantsService.
 */
@ApiTags('Admin - Backfills')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/backfills')
export class Qa6OperationsGrantsController {
  constructor(private readonly grants: Qa6OperationsGrantsService) {}

  @Post('qa6-operations-grants')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'QA6 P7 · grant operations:read to the roles named exactly "Admin", "Depatment lead", "BIM leader". Body { dryRun?: boolean (default TRUE — only false writes) }. Idempotent; lists role ids / names and the names not found.',
  })
  async run(@CurrentUser() user: { id?: number } | undefined, @Body() body?: { dryRun?: boolean }) {
    const { dryRun } = parseQa6OperationsGrantsBody(body);
    return this.grants.run({ dryRun, actorId: user?.id ?? null });
  }
}
