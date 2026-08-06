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
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { OrgUnitService } from '../../common/services/org-unit.service';

/**
 * Org-tree admin surface. Every endpoint is gated by the `org` module
 * (`org:manage` semantics — read for GETs, write for POST/PATCH,
 * delete for DELETE). Admin-only in the seed; the `Organization`
 * sub-module has to be explicitly granted to any other role.
 *
 * Model reminder — ONE manager per unit, ONE home unit per person.
 * All mutations route through OrgUnitService so the materialised
 * `path`/`depth` invariant and the ProjectAccessService subordinate
 * cache invalidation stay coherent. See the integrity-rule comment
 * on ProjectAccessService for the forbidden shortcuts.
 *
 * The user home-unit endpoint is registered on this controller (via
 * an absolute `@Patch('/users/:id/org-unit')` route) rather than on
 * UsersController so it can share the `org` permission gate — a
 * caller with `users:write` but no `org:manage` shouldn't be able to
 * rewire the org tree, and vice-versa.
 */
@ApiTags('Org - Units')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class OrgUnitsController {
  constructor(private readonly orgUnits: OrgUnitService) {}

  @Get('org-units')
  @RequirePermissions({ module: 'org', action: 'read' })
  @ApiOperation({ summary: 'The org tree — one flat list with per-node member + subtree counts' })
  async list() {
    return this.orgUnits.getTree();
  }

  @Get('org-units/:id/members')
  @RequirePermissions({ module: 'org', action: 'read' })
  @ApiOperation({ summary: "Users whose home unit is exactly this node" })
  async members(@Param('id', ParseIntPipe) id: number) {
    return this.orgUnits.getMembers(id);
  }

  @Post('org-units')
  @RequirePermissions({ module: 'org', action: 'write' })
  @ApiOperation({ summary: 'Create a unit (optionally under a parent, optionally with a manager)' })
  async create(
    @Body() body: { name: string; code?: string | null; parentId?: number | null; managerUserId?: number | null },
  ) {
    return this.orgUnits.create({
      name: body.name,
      code: body.code ?? null,
      parentId: body.parentId ?? null,
      managerUserId: body.managerUserId ?? null,
    });
  }

  @Patch('org-units/:id')
  @RequirePermissions({ module: 'org', action: 'write' })
  @ApiOperation({ summary: 'Rename / change the short code of a unit' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name?: string; code?: string | null },
  ) {
    // Whitelist: only name + code go to the service. Tree topology
    // (parentId/path/depth) is owned by the /move endpoint, manager
    // by /manager. Do NOT spread the raw body into a bare update or
    // a client can rewire the tree via the PATCH shape.
    return this.orgUnits.updateMeta(id, {
      name: body.name,
      code: body.code,
    });
  }

  @Patch('org-units/:id/move')
  @RequirePermissions({ module: 'org', action: 'write' })
  @ApiOperation({ summary: 'Move a unit under a new parent (or to the root with newParentId=null)' })
  async move(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { newParentId: number | null },
  ) {
    // Cycle protection (self-parent, descendant-parent) is enforced
    // inside OrgUnitService.move and returns 400 BadRequest.
    return this.orgUnits.move(id, body.newParentId ?? null);
  }

  @Patch('org-units/:id/manager')
  @RequirePermissions({ module: 'org', action: 'write' })
  @ApiOperation({ summary: 'Set (or clear) the single manager for a unit' })
  async setManager(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { userId: number | null },
  ) {
    // ONE manager per unit. Pass null to clear.
    return this.orgUnits.setManager(id, body.userId ?? null);
  }

  @Delete('org-units/:id')
  @RequirePermissions({ module: 'org', action: 'delete' })
  @ApiOperation({ summary: 'Soft-delete a unit (blocked if it has children or members)' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    // Block-if-has-children keeps the caller in control: cascading
    // soft-delete would silently unassign every user under the
    // subtree from their home unit via the SetNull FK. Service
    // returns 400 with a specific message; the client should
    // reparent or reassign first.
    return this.orgUnits.softDelete(id);
  }

  @Patch('users/:id/org-unit')
  @RequirePermissions({ module: 'org', action: 'write' })
  @ApiOperation({ summary: "Assign a user to a home unit (or clear with orgUnitId=null)" })
  async assignUser(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { orgUnitId: number | null },
  ) {
    // ONE home unit per person. Pass orgUnitId=null to unlink —
    // ProjectAccessService then treats them as pre-org-access
    // (no subordinate widen). Routed through the service so the
    // subordinate cache invalidation hook fires uniformly.
    return this.orgUnits.assignUser(id, body.orgUnitId ?? null);
  }
}
