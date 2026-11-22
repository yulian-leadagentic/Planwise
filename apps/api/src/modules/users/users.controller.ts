import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { UsersService } from './users.service';
import { UserSenioritiesService, AddSeniorityEntryDto, UpdateSeniorityEntryDto } from './user-seniorities.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';
import { assertFinanceAccess } from '../../common/finance/finance-access';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { assertCanReadPeopleDirectory, userFieldAccess } from './user-visibility';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly seniorityHistory: UserSenioritiesService,
  ) {}

  /**
   * Permissions round 1 (2026-11-20) — Admin or HR (`hr:write`) only;
   * `partners:write` alone is no longer enough. A non-admin may only
   * assign a non-admin role. The check lives in UsersService.create
   * (manual, not `@RequirePermissions`: HR roles hold `hr` but not
   * `partners`, and `hr` is not bypassable for Admins in the guard).
   */
  @Post()
  @ApiOperation({ summary: 'Create a new user (Admin or HR only)' })
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: any) {
    return this.usersService.create(dto, actor);
  }

  /**
   * One-shot maintenance: walk every user's `position` (the People admin's
   * "Job Title" text field) and ensure the matching Profession is linked
   * on their BusinessPartner. Idempotent — repeated calls are safe.
   *
   * Why it lives here: the project-role pickers + their backend validator
   * filter candidates by `business_partner_professions`, but the People
   * admin only writes `User.position` as a plain string. Existing users
   * (like Moran Pinto whose Job Title was "BIM Coordinator" but whose
   * BP had no professions) didn't show up in the picker. Going forward
   * the sync is automatic on update/create — this endpoint catches up
   * everyone created before the sync existed.
   */
  @Post('admin/backfill-positions-to-professions')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary: 'Sync every user\'s Job Title onto their BusinessPartner.professions (one-shot, idempotent)',
  })
  backfillPositionsToProfessions() {
    return this.usersService.backfillPositionsToProfessions();
  }

  /**
   * Permissions round 3 (privacy, 2026-11-22) — the fields each row
   * carries depend on the caller (user-visibility.ts): directory tier for
   * everyone; account tier (employee no., role, active state, last
   * login, labor category) for Admin / HR; personal tier (employment
   * dates, tax ID, address, …) for HR. Only Admin / HR may pass
   * `isActive=false|all` or `roleId`.
   *
   * Gate (round 3 follow-up): Admin, `partners:read` OR `hr:read` —
   * checked by hand (see `canReadPeopleDirectory`), not with
   * `@RequirePermissions`, whose entries are ANDed and which would lose
   * the Admin bypass once `hr` (NO_ADMIN_BYPASS) is named.
   */
  @Get()
  @ApiPaginated()
  @ApiOperation({ summary: 'List people with filters (Admin, partners:read or hr:read; fields depend on the caller)' })
  findAll(@Query() query: QueryUsersDto, @CurrentUser() actor: any) {
    assertCanReadPeopleDirectory(actor);
    return this.usersService.findAll(query, actor);
  }

  /**
   * Round 3 — as the list, plus the user himself gets the account and
   * personal tiers on his own record; `role.roleModules` only for Admin
   * or the user himself. Same gate as the list.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get user by ID (Admin, partners:read or hr:read; fields depend on the caller)' })
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: any) {
    assertCanReadPeopleDirectory(actor);
    return this.usersService.findOne(id, actor);
  }

  /**
   * Permissions round 1 (2026-11-20) — open to Admin, `partners:write`
   * or `hr:write` (checked in UsersService.update, since decorator
   * entries are ANDed). Protected fields, enforced there too:
   * `password` / `roleId` → Admin only; `email` / `isActive` → Admin or
   * HR; `orgUnitId` → Admin, HR or `org:write`; nobody changes their
   * own role, active state or org unit unless Admin.
   * Sending a protected field with its stored value is allowed.
   */
  @Patch(':id')
  @ApiOperation({ summary: 'Update a user (protected fields: password/roleId Admin only, email/isActive Admin or HR)' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto, @CurrentUser() actor: any) {
    return this.usersService.update(id, dto, actor);
  }

  /** Admin or HR only; nobody deletes their own account. Hard delete. */
  @Delete(':id')
  @ApiOperation({ summary: 'Delete a user (Admin or HR only)' })
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: any) {
    return this.usersService.remove(id, actor);
  }

  // ─── Seniority history (date-effective) ────────────────────────────
  // Replaces the single users.seniority_level_id column with a chain
  // of [startDate, endDate] intervals so the project cost calculation
  // can resolve the seniority that was active when each TimeEntry
  // was logged. The legacy column is auto-synced via the service.
  //
  // Permissions round 2 (B-14) — adding / editing / removing an entry
  // moves the employee's cost tier, so it also needs finance:write
  // (checked by hand so the Admin bypass on `partners` still applies;
  // finance itself is never bypassed). The read keeps partners:read —
  // `seniorityLevel.defaultHourlyCost` in it is removed by the global
  // finance interceptor for callers without finance:read.
  //
  // Permissions round 3 (privacy) — the labor category is account-tier
  // data (Admin / HR / the user himself), so its history is too. The
  // route gate is the people-directory gate (Admin, partners:read or
  // hr:read), so the People edit modal works for HR roles without
  // `partners`.

  @Get(':id/seniorities')
  @ApiOperation({ summary: "List a user's seniority history (newest first; Admin, HR or the user himself)" })
  listSeniorities(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    assertCanReadPeopleDirectory(user);
    if (!userFieldAccess(user, id).account) {
      throw new PermissionDeniedException(
        "Only an Admin or HR can view a person's labor category history.",
        { reason: 'ADMIN_OR_HR_ONLY' },
      );
    }
    return this.seniorityHistory.listForUser(id);
  }

  @Post(':id/seniorities')
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({ summary: "Add a seniority entry. Open-ended adds auto-close the prior open row at startDate-1." })
  addSeniority(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddSeniorityEntryDto,
  ) {
    assertFinanceAccess(user, 'write');
    return this.seniorityHistory.addEntry(id, dto);
  }

  @Patch(':id/seniorities/:entryId')
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({ summary: 'Update a seniority entry (overlap-checked)' })
  updateSeniority(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) _userId: number,
    @Param('entryId', ParseIntPipe) entryId: number,
    @Body() dto: UpdateSeniorityEntryDto,
  ) {
    assertFinanceAccess(user, 'write');
    return this.seniorityHistory.updateEntry(entryId, dto);
  }

  @Delete(':id/seniorities/:entryId')
  @RequirePermissions({ module: 'partners', action: 'delete' })
  @ApiOperation({ summary: 'Remove a seniority entry. Auto-syncs the user.seniority_level_id column.' })
  removeSeniority(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) _userId: number,
    @Param('entryId', ParseIntPipe) entryId: number,
  ) {
    assertFinanceAccess(user, 'write');
    return this.seniorityHistory.removeEntry(entryId);
  }
}
