/**
 * Google Drive admin controller — Admin → Integrations → Google Drive.
 *
 * All routes are gated by JwtAuth + Roles + org:read/org:write.
 * `write` is the mutation gate (matches the SsoAdmin controller
 * convention — `manage` is NOT a valid action code in this codebase;
 * see common/decorators/roles.decorator.ts).
 *
 * The service-account JSON key is write-only across the API surface.
 * GET returns { hasKey, keyHint } — never the plaintext. PUT accepts a
 * key value (which gets encrypted via SecretCryptoService and stored)
 * OR a blank/omitted value (which keeps the existing key).
 */

import { Body, Controller, Get, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { DriveAdminService } from './drive-admin.service';
import { UpsertDriveConfigDto } from './dto/upsert-drive-config.dto';
import { EnableDriveConfigDto } from './dto/enable-drive-config.dto';

function ipOf(req: Request): string | null {
  const raw = req.headers['x-forwarded-for'];
  if (typeof raw === 'string') return raw.split(',')[0]?.trim() || null;
  return req.ip ?? null;
}

@ApiTags('Admin - Drive')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/drive')
export class DriveAdminController {
  constructor(private readonly svc: DriveAdminService) {}

  @Get()
  @RequirePermissions({ module: 'org', action: 'read' })
  @ApiOperation({
    summary:
      'Fetch the Google Drive configuration (SA key omitted; keyHint fingerprint only)',
  })
  async get() {
    return this.svc.get();
  }

  @Put()
  @RequirePermissions({ module: 'org', action: 'write' })
  @ApiOperation({
    summary:
      'Create or update the Google Drive configuration. serviceAccountKey is write-only; omit to preserve the current key.',
  })
  async upsert(@Body() dto: UpsertDriveConfigDto, @Req() req: Request) {
    const user = req.user as { id: number };
    return this.svc.upsert(dto, user.id, ipOf(req));
  }

  @Patch('enable')
  @RequirePermissions({ module: 'org', action: 'write' })
  @ApiOperation({ summary: 'Toggle enabled without touching other fields' })
  async enable(@Body() dto: EnableDriveConfigDto, @Req() req: Request) {
    const user = req.user as { id: number };
    return this.svc.setEnabled(dto.enabled, user.id, ipOf(req));
  }

  @Post('test')
  @RequirePermissions({ module: 'org', action: 'write' })
  @ApiOperation({
    summary:
      'Authenticate as the service account and verify the configured Shared Drive is reachable. Key never leaves the server.',
  })
  async test(@Req() req: Request) {
    const user = req.user as { id: number };
    return this.svc.test(user.id, ipOf(req));
  }
}
