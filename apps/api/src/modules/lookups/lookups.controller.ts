import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessPartnersService } from '../business-partners/business-partners.service';
import { OrgUnitService } from '../../common/services/org-unit.service';

/**
 * B4 (P0, 2026-10-20) — read-only lookups for the New Project form,
 * gated behind `projects:write`.
 *
 * Problem recap: `project-form-page.tsx` loads 3 reference lists that
 * are gated to ADMIN-only perms (admin:read / partners:read / org:read)
 * while project creation itself only requires `projects:write`. A tester
 * with `projects:write` alone used to hit 403 on all three fetches,
 * leaving the two required dropdowns (Category + Customer) un-fillable
 * and the form un-submittable.
 *
 * The fix is deliberately isolated: three NEW routes, each guarded by
 * `projects:write` and each delegating to the SAME service / Prisma
 * query the existing admin controller uses. No logic is duplicated,
 * no permission matrix changes — admin surfaces continue to point at
 * their original endpoints. The POST / PATCH / DELETE sides of the
 * admin controllers remain admin-only.
 */
@ApiTags('Lookups')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class LookupsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly partners: BusinessPartnersService,
    private readonly orgUnits: OrgUnitService,
  ) {}

  /**
   * Project types (categories) for the Category chip picker. Same
   * findMany as `ConfigController.getProjectTypes` minus the `_count`
   * include — the admin surface shows "N projects use this" per row,
   * but the project-create picker only reads id/name/code/color.
   * Ordering matches the admin endpoint (name asc) so the two call
   * sites render the same list in the same order.
   */
  @Get('lookups/project-types')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Project types for the create-project form (projects:write).' })
  async listProjectTypes() {
    return this.prisma.projectType.findMany({
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Customer organizations for the Customer picker. Delegates to
   * `BusinessPartnersService.findAll` with the same filter shape the
   * admin endpoint (`GET /business-partners?partnerType=organization&
   * roleType=customer&perPage=200`) exposes — same WHERE, same
   * include, same `{data, meta}` envelope. The "Internal" home org is
   * surfaced by the same enrichment the admin endpoint uses, so an
   * internal project without an external customer is still selectable.
   */
  @Get('lookups/customer-orgs')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Customer organizations for the create-project form (projects:write).' })
  async listCustomerOrgs() {
    return this.partners.findAll({
      partnerType: 'organization',
      roleType: 'customer',
      perPage: 200,
    } as any);
  }

  /**
   * Org units tree for the Organizational Unit picker. Returns the
   * SAME flat list as `OrgUnitsController.list` (also powered by
   * `OrgUnitService.getTree()`). Shape includes
   * `id, name, parentId, assignableToProjects` — the FE filters by
   * `assignableToProjects === true` and builds the tree client-side
   * with the shared `buildTree` helper.
   */
  @Get('lookups/org-units')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Org units tree for the create-project form (projects:write).' })
  async listOrgUnits() {
    return this.orgUnits.getTree();
  }
}
