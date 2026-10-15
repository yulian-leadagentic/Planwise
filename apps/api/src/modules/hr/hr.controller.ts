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
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';

import { HrService } from './hr.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UpdateHrEmployeeDto } from './dto/update-employee.dto';
import { CreateEligibilityDto } from './dto/create-eligibility.dto';
import { UpdateEligibilityDto } from './dto/update-eligibility.dto';

/**
 * HR Phase A3 (2026-10-15) — `/hr/*` surface. Every route is gated by
 * the `hr` module permission; `NO_ADMIN_BYPASS` on the guard blocks
 * the standard admin shortcut, so only roles with an explicit HR grant
 * (HR Manager + HR Clerk by default per the Phase A2 seed; plus any
 * other role an admin wires up) can call these endpoints.
 */
@ApiTags('HR')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('hr')
export class HrController {
  constructor(private readonly hr: HrService) {}

  // ─── SpecialHourBucket catalog ──────────────────────────────────────
  @Get('buckets')
  @RequirePermissions({ module: 'hr', action: 'read' })
  @ApiOperation({ summary: 'List SpecialHourBucket catalog (optional behavior + active filters)' })
  @ApiQuery({ name: 'behavior', required: false, enum: ['A', 'B', 'C'] })
  @ApiQuery({ name: 'activeOnly', required: false, type: Boolean })
  listBuckets(
    @Query('behavior') behavior?: 'A' | 'B' | 'C',
    @Query('activeOnly') activeOnlyRaw?: string,
  ) {
    // Query strings arrive as `"true"` / `"false"` strings — coerce
    // explicitly so a stray `?activeOnly=0` doesn't become truthy.
    const activeOnly =
      activeOnlyRaw === 'true' || activeOnlyRaw === '1'
        ? true
        : activeOnlyRaw === 'false' || activeOnlyRaw === '0'
          ? false
          : undefined;
    return this.hr.listBuckets({ behavior, activeOnly });
  }

  @Get('employees')
  @RequirePermissions({ module: 'hr', action: 'read' })
  @ApiOperation({ summary: 'List every employee (userType=employee) for the HR roster' })
  listEmployees() {
    return this.hr.listEmployees();
  }

  @Get('employees/:id')
  @RequirePermissions({ module: 'hr', action: 'read' })
  @ApiOperation({ summary: 'Get one employee with their embedded bucket eligibilities' })
  getEmployee(@Param('id', ParseIntPipe) id: number) {
    return this.hr.getEmployee(id);
  }

  @Patch('employees/:id')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'Update HR employment fields on an employee' })
  updateEmployee(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateHrEmployeeDto,
  ) {
    return this.hr.updateEmployee(id, dto);
  }

  // ─── Eligibility CRUD ───────────────────────────────────────────────
  // Per spec §7, the "list eligibilities" endpoint lives under the
  // employee resource and is gated on hr:write — anyone who can see
  // the list is implicitly allowed to add/remove rows. HR Clerk gets
  // read-only via /hr/employees/:id (bucketEligibilities embedded).

  @Get('employees/:id/eligibilities')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'List active + inactive bucket eligibilities for an employee' })
  listEligibilities(@Param('id', ParseIntPipe) userId: number) {
    return this.hr.listEligibilities(userId);
  }

  @Post('employees/:id/eligibilities')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'Grant a SpecialHourBucket eligibility to an employee (startDate=today, endDate=Dec 31 by default)' })
  createEligibility(
    @Param('id', ParseIntPipe) userId: number,
    @CurrentUser() user: any,
    @Body() dto: CreateEligibilityDto,
  ) {
    return this.hr.createEligibility(userId, user.id, dto);
  }

  @Patch('employees/:id/eligibilities/:eligibilityId')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'Patch an eligibility (dates, amount, credit mode, active)' })
  updateEligibility(
    @Param('id', ParseIntPipe) userId: number,
    @Param('eligibilityId', ParseIntPipe) eligibilityId: number,
    @Body() dto: UpdateEligibilityDto,
  ) {
    return this.hr.updateEligibility(userId, eligibilityId, dto);
  }

  @Delete('employees/:id/eligibilities/:eligibilityId')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'Soft-delete an eligibility (sets active=false; preserves history)' })
  deactivateEligibility(
    @Param('id', ParseIntPipe) userId: number,
    @Param('eligibilityId', ParseIntPipe) eligibilityId: number,
  ) {
    return this.hr.deactivateEligibility(userId, eligibilityId);
  }
}
