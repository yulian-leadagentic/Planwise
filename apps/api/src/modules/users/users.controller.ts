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
import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly seniorityHistory: UserSenioritiesService,
  ) {}

  @Post()
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({ summary: 'Create a new user' })
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
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

  @Get()
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiPaginated()
  @ApiOperation({ summary: 'List people with filters' })
  findAll(@Query() query: QueryUsersDto) {
    return this.usersService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({ summary: 'Get user by ID' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({ summary: 'Update a user' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {
    return this.usersService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'partners', action: 'delete' })
  @ApiOperation({ summary: 'Soft delete a user' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.remove(id);
  }

  // ─── Seniority history (date-effective) ────────────────────────────
  // Replaces the single users.seniority_level_id column with a chain
  // of [startDate, endDate] intervals so the project cost calculation
  // can resolve the seniority that was active when each TimeEntry
  // was logged. The legacy column is auto-synced via the service.

  @Get(':id/seniorities')
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({ summary: "List a user's seniority history (newest first)" })
  listSeniorities(@Param('id', ParseIntPipe) id: number) {
    return this.seniorityHistory.listForUser(id);
  }

  @Post(':id/seniorities')
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({ summary: "Add a seniority entry. Open-ended adds auto-close the prior open row at startDate-1." })
  addSeniority(@Param('id', ParseIntPipe) id: number, @Body() dto: AddSeniorityEntryDto) {
    return this.seniorityHistory.addEntry(id, dto);
  }

  @Patch(':id/seniorities/:entryId')
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({ summary: 'Update a seniority entry (overlap-checked)' })
  updateSeniority(
    @Param('id', ParseIntPipe) _userId: number,
    @Param('entryId', ParseIntPipe) entryId: number,
    @Body() dto: UpdateSeniorityEntryDto,
  ) {
    return this.seniorityHistory.updateEntry(entryId, dto);
  }

  @Delete(':id/seniorities/:entryId')
  @RequirePermissions({ module: 'partners', action: 'delete' })
  @ApiOperation({ summary: 'Remove a seniority entry. Auto-syncs the user.seniority_level_id column.' })
  removeSeniority(
    @Param('id', ParseIntPipe) _userId: number,
    @Param('entryId', ParseIntPipe) entryId: number,
  ) {
    return this.seniorityHistory.removeEntry(entryId);
  }
}
