/**
 * SSO admin controller — org-management surface for the
 * Admin → SSO/Identity page.
 *
 * Every route is gated by JwtAuth + Roles + `org:write` (org:manage
 * doesn't exist as an action code in this codebase — 'write' is what
 * the OrgUnits admin uses for mutations under the `org` module).
 * A caller with `org:read` can view configs (secret omitted); a
 * caller with `org:write` can rotate secrets, toggle enabled, and
 * run the test-connection flow.
 *
 * The one endpoint kept out of this file is
 * `GET /auth/oidc/providers` — that's public (unauthenticated) so
 * the login page can render the Sign-in-with-X button. It lives on
 * the OIDC controller in modules/auth/oidc/.
 */
import { Body, Controller, Get, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { SsoAdminService } from './sso-admin.service';
import { UpsertSsoConfigDto } from './dto/upsert-sso-config.dto';
import { EnableSsoConfigDto } from './dto/enable-sso-config.dto';

function ipOf(req: Request): string | null {
  const raw = req.headers['x-forwarded-for'];
  if (typeof raw === 'string') return raw.split(',')[0]?.trim() || null;
  return req.ip ?? null;
}

@ApiTags('Admin - SSO')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/sso')
export class SsoAdminController {
  constructor(private readonly svc: SsoAdminService) {}

  @Get()
  @RequirePermissions({ module: 'org', action: 'read' })
  @ApiOperation({ summary: 'List every provider config (secret omitted)' })
  async list() {
    return this.svc.list();
  }

  @Put(':provider')
  @RequirePermissions({ module: 'org', action: 'write' })
  @ApiOperation({ summary: 'Create or update the config for a provider. secret is write-only.' })
  async upsert(@Param('provider') provider: string, @Body() dto: UpsertSsoConfigDto, @Req() req: Request) {
    const user = req.user as { id: number };
    return this.svc.upsert(provider, dto, user.id, ipOf(req));
  }

  @Patch(':provider/enable')
  @RequirePermissions({ module: 'org', action: 'write' })
  @ApiOperation({ summary: 'Toggle enabled without touching other fields' })
  async enable(@Param('provider') provider: string, @Body() dto: EnableSsoConfigDto, @Req() req: Request) {
    const user = req.user as { id: number };
    return this.svc.setEnabled(provider, dto.enabled, user.id, ipOf(req));
  }

  @Post(':provider/test')
  @RequirePermissions({ module: 'org', action: 'write' })
  @ApiOperation({ summary: 'Discover + client-credentials-grant to verify credentials. Secret never leaves the server.' })
  async test(@Param('provider') provider: string, @Req() req: Request) {
    const user = req.user as { id: number };
    return this.svc.test(provider, user.id, ipOf(req));
  }
}
