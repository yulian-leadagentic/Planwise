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
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';

import { HrService } from './hr.service';
import { HrMonthlyService } from './hr-monthly.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UpdateHrEmployeeDto } from './dto/update-employee.dto';
import { CreateEligibilityDto } from './dto/create-eligibility.dto';
import { UpdateEligibilityDto } from './dto/update-eligibility.dto';
import { UpdateHrSettingsDto } from './dto/update-hr-settings.dto';
// §15 R2 (2026-10-18) — calendar-day CRUD DTOs removed with the
// endpoints; Admin → Calendar is the single source of truth now.
import {
  CreateAbsenceTypeDto,
  UpdateAbsenceTypeDto,
} from './dto/absence-type.dto';
import {
  CreateAbsenceRecordDto,
  UpdateAbsenceRecordDto,
} from './dto/absence-record.dto';
import {
  CreateSpecialHourBucketDto,
  UpdateSpecialHourBucketDto,
} from './dto/bucket.dto';
import { ApproveMonthDto, RecomputeMonthDto } from './dto/monthly.dto';

/**
 * HR Phase A3+B3 (2026-10-15) — `/hr/*` surface. Every route is gated
 * by the `hr` module permission; `NO_ADMIN_BYPASS` on the guard blocks
 * the standard admin shortcut, so only roles with an explicit HR grant
 * (HR Manager + HR Clerk by default per the Phase A2 seed; plus any
 * other role an admin wires up) can call these endpoints.
 *
 * Permission convention (matches eligibility CRUD from A3):
 *   • GET on the catalog (buckets, absence types, calendar days,
 *     settings) → `hr:read` — HR Clerk may browse.
 *   • Any write (POST/PATCH/DELETE) on the catalog → `hr:write`.
 *   • GET on another employee's personal HR data (absences,
 *     attachments) → `hr:write` to match the eligibility route's
 *     stance in A3. Rationale: anyone who can list a worker's
 *     medical notes should also be able to edit them; otherwise we'd
 *     need two drawers.
 */
@ApiTags('HR')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('hr')
export class HrController {
  constructor(
    private readonly hr: HrService,
    private readonly monthly: HrMonthlyService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── HR settings (singleton) ────────────────────────────────────────

  @Get('settings')
  @RequirePermissions({ module: 'hr', action: 'read' })
  @ApiOperation({ summary: 'Get the HrSettings singleton (create on first read).' })
  getSettings() {
    return this.hr.getSettings();
  }

  @Patch('settings')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'Patch the HrSettings singleton.' })
  updateSettings(@CurrentUser() user: any, @Body() dto: UpdateHrSettingsDto) {
    return this.hr.updateSettings(dto, user.id);
  }

  // §15 R2 (2026-10-18) — CalendarDay CRUD under /hr/calendar-days was
  // removed. Admin → Calendar (`/calendar/*`) is the sole source of
  // truth for calendar exceptions now; the HR engine still reads the
  // same `CalendarDay` table via PrismaService, so the enum remap
  // (HOLIDAY / HOLIDAY_EVE / CHOL_HAMOED / REST) stays intact.

  // ─── AbsenceType admin CRUD ─────────────────────────────────────────

  @Get('absence-types')
  @RequirePermissions({ module: 'hr', action: 'read' })
  @ApiOperation({ summary: 'List the AbsenceType catalog.' })
  @ApiQuery({ name: 'activeOnly', required: false, type: Boolean })
  listAbsenceTypes(@Query('activeOnly') activeOnlyRaw?: string) {
    const activeOnly =
      activeOnlyRaw === 'true' || activeOnlyRaw === '1' ? true : undefined;
    return this.hr.listAbsenceTypes({ activeOnly });
  }

  @Post('absence-types')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'Create a non-system absence type.' })
  createAbsenceType(
    @CurrentUser() user: any,
    @Body() dto: CreateAbsenceTypeDto,
  ) {
    return this.hr.createAbsenceType(dto, user.id);
  }

  @Patch('absence-types/:id')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'Patch an absence type (system rows: partial-locked per Q10).' })
  updateAbsenceType(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAbsenceTypeDto,
  ) {
    return this.hr.updateAbsenceType(id, dto, user.id);
  }

  @Delete('absence-types/:id')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'Soft-delete via active=false (system rows blocked with 409).' })
  deleteAbsenceType(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.hr.deleteAbsenceType(id, user.id);
  }

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
    const activeOnly =
      activeOnlyRaw === 'true' || activeOnlyRaw === '1'
        ? true
        : activeOnlyRaw === 'false' || activeOnlyRaw === '0'
          ? false
          : undefined;
    return this.hr.listBuckets({ behavior, activeOnly });
  }

  @Post('buckets')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'Create a non-system special-hour bucket.' })
  createBucket(
    @CurrentUser() user: any,
    @Body() dto: CreateSpecialHourBucketDto,
  ) {
    return this.hr.createBucket(dto, user.id);
  }

  @Patch('buckets/:id')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'Patch a bucket (system rows: partial-locked per Q10).' })
  updateBucket(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSpecialHourBucketDto,
  ) {
    return this.hr.updateBucket(id, dto, user.id);
  }

  @Delete('buckets/:id')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'Soft-delete a bucket (system rows blocked with 409).' })
  deleteBucket(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.hr.deleteBucket(id, user.id);
  }

  // ─── Caller-scoped pickable buckets (§9.1) ──────────────────────────
  // Intentionally NO `@RequirePermissions` — this endpoint is the one
  // route on the HR controller any authenticated user can call. The
  // admin catalog at `GET /hr/buckets` stays `hr:read`; this returns
  // only "the buckets *I* can report against" (A + C active + B when I
  // have an active REPORTED eligibility covering today). The real
  // server-side enforcement lives on `TimeEntry` create/update — this
  // route is UX only. See HrService.listPickableBucketsForCaller.
  @Get('me/pickable-buckets')
  @ApiOperation({
    summary:
      'Caller-scoped pickable SpecialHourBuckets: A + C active + B only when the caller has an active REPORTED eligibility covering today.',
  })
  listMyPickableBuckets(@CurrentUser() user: any) {
    return this.hr.listPickableBucketsForCaller(user.id);
  }

  // ─── Self-service (any authenticated user, acting for themselves) ──
  //
  // G2.2 (2026-10-20) — the HR-manager endpoints under /hr/employees/:id
  // are gated by hr:write AND assert `userType === 'employee'`, which
  // correctly blocks on-behalf logging but prevents an admin (or any
  // non-'employee' userType) from reporting their own time-off. These
  // `/hr/me/*` paths intentionally bypass both: they always act for the
  // caller and never for someone else, so the hr:write gate is not the
  // right primitive here.

  @Post('me/absences')
  @ApiOperation({ summary: 'Caller logs their own absence record.' })
  createMyAbsence(
    @CurrentUser() user: any,
    @Body() dto: CreateAbsenceRecordDto,
  ) {
    return this.hr.createMyAbsence(user.id, dto);
  }

  @Post('me/attachments')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOperation({ summary: 'Caller uploads a document to their own HR attachment store.' })
  uploadMyAttachment(
    @CurrentUser() user: any,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.hr.uploadMyAttachment(user.id, file);
  }

  // ─── Unified time-category catalog (F5, 2026-10-19) ─────────────────
  // Flat list of pickable time categories for the caller, each tagged
  // with a `kind` discriminator (ABSENCE / WORK_NON_PROJECT / QUOTA)
  // derived from the existing AbsenceType and SpecialHourBucket tables.
  // No DB migration. Intentionally NOT gated on `hr:*` — every logged-in
  // user needs the picker to log their own time/absences. QUOTA (C) is
  // further filtered to users who have an active bucket eligibility
  // covering today (privacy). ENTITLEMENT (B) is auto-credited and never
  // returned here. See HrService.listTimeCategoriesForCaller.
  @Get('time-categories')
  @ApiOperation({
    summary:
      'Unified time-category catalog for the caller (ABSENCE + WORK_NON_PROJECT + QUOTA, derived from existing data).',
  })
  listTimeCategories(@CurrentUser() user: any) {
    return this.hr.listTimeCategoriesForCaller(user.id);
  }

  // ─── Employee roster ────────────────────────────────────────────────

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

  // ─── Absences on an employee ────────────────────────────────────────

  @Get('employees/:id/absences')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'List absences for an employee (optional year + typeId filter).' })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'typeId', required: false, type: Number })
  listAbsences(
    @Param('id', ParseIntPipe) userId: number,
    @Query('year') yearRaw?: string,
    @Query('typeId') typeIdRaw?: string,
  ) {
    const year = yearRaw ? Number(yearRaw) : undefined;
    const typeId = typeIdRaw ? Number(typeIdRaw) : undefined;
    return this.hr.listAbsencesForEmployee(userId, {
      year: Number.isFinite(year) ? year : undefined,
      typeId: Number.isFinite(typeId) ? typeId : undefined,
    });
  }

  @Post('employees/:id/absences')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'Create an absence record (bereavement auto-expands to 7 days).' })
  createAbsence(
    @Param('id', ParseIntPipe) userId: number,
    @CurrentUser() user: any,
    @Body() dto: CreateAbsenceRecordDto,
  ) {
    return this.hr.createAbsence(userId, dto, user.id);
  }

  @Patch('employees/:id/absences/:recordId')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'Patch an absence record.' })
  updateAbsence(
    @Param('id', ParseIntPipe) userId: number,
    @Param('recordId', ParseIntPipe) recordId: number,
    @CurrentUser() user: any,
    @Body() dto: UpdateAbsenceRecordDto,
  ) {
    return this.hr.updateAbsence(userId, recordId, dto, user.id);
  }

  @Delete('employees/:id/absences/:recordId')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'Hard-delete an absence record (event-sourced; audit log retains).' })
  deleteAbsence(
    @Param('id', ParseIntPipe) userId: number,
    @Param('recordId', ParseIntPipe) recordId: number,
    @CurrentUser() user: any,
  ) {
    return this.hr.deleteAbsence(userId, recordId, user.id);
  }

  // ─── EmployeeAttachment upload ──────────────────────────────────────

  @Get('employees/:id/attachments')
  @RequirePermissions({ module: 'hr', action: 'read' })
  @ApiOperation({ summary: 'List HR attachments for an employee.' })
  listAttachments(@Param('id', ParseIntPipe) userId: number) {
    return this.hr.listEmployeeAttachments(userId);
  }

  @Post('employees/:id/attachments')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOperation({ summary: 'Upload an HR document for an employee.' })
  uploadAttachment(
    @Param('id', ParseIntPipe) userId: number,
    @CurrentUser() user: any,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.hr.uploadEmployeeAttachment(userId, user.id, file);
  }

  @Delete('employees/:id/attachments/:attachmentId')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({ summary: 'Delete an HR attachment (ON DELETE SET NULL unlinks absences/eligibilities).' })
  deleteAttachment(
    @Param('id', ParseIntPipe) userId: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @CurrentUser() user: any,
  ) {
    return this.hr.deleteEmployeeAttachment(userId, attachmentId, user.id);
  }

  // ─── Monthly Attendance (Phase C3) ──────────────────────────────────

  /**
   * HR Phase C3 — batch recompute. When `userIds` is omitted the
   * controller resolves it to every active employee server-side so
   * the FE never needs the roster upfront. Each user runs in its own
   * try/catch inside the engine; one bad user never tanks the batch.
   */
  @Post('monthly/recompute')
  @RequirePermissions({ module: 'hr', action: 'write' })
  @ApiOperation({
    summary:
      'Recompute MonthlyAttendance for the given month (optionally scoped to a userIds list; defaults to all active employees).',
  })
  async recomputeMonthly(@Body() dto: RecomputeMonthDto) {
    let userIds = dto.userIds;
    if (!userIds || userIds.length === 0) {
      const employees = await this.prisma.user.findMany({
        where: { userType: 'employee', isActive: true, deletedAt: null },
        select: { id: true },
      });
      userIds = employees.map((e) => e.id);
    }
    return this.monthly.computeMonthForMany({
      userIds,
      year: dto.year,
      month: dto.month,
    });
  }

  @Get('monthly')
  @RequirePermissions({ module: 'hr', action: 'read' })
  @ApiOperation({ summary: 'List MonthlyAttendance rows for the given month.' })
  @ApiQuery({ name: 'year', required: true, type: Number })
  @ApiQuery({ name: 'month', required: true, type: Number })
  listMonthly(
    @Query('year') yearRaw: string,
    @Query('month') monthRaw: string,
  ) {
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    if (!Number.isFinite(year) || !Number.isFinite(month)) {
      throw new BadRequestException('year and month are required integers');
    }
    return this.monthly.listMonth(year, month);
  }

  @Get('monthly/:userId')
  @RequirePermissions({ module: 'hr', action: 'read' })
  @ApiOperation({
    summary:
      'Row + day-by-day breakdown for one employee. Returns a DRAFT compute if no row has been written yet.',
  })
  @ApiQuery({ name: 'year', required: true, type: Number })
  @ApiQuery({ name: 'month', required: true, type: Number })
  getMonthlyForUser(
    @Param('userId', ParseIntPipe) userId: number,
    @Query('year') yearRaw: string,
    @Query('month') monthRaw: string,
  ) {
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    if (!Number.isFinite(year) || !Number.isFinite(month)) {
      throw new BadRequestException('year and month are required integers');
    }
    return this.monthly.getMonthForUser(userId, year, month);
  }

  @Post('monthly/:userId/approve')
  @RequirePermissions({ module: 'hr', action: 'approve' })
  @ApiOperation({
    summary:
      'Approve an employee\'s MonthlyAttendance row (idempotent on already-APPROVED).',
  })
  approveMonthly(
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() user: any,
    @Body() dto: ApproveMonthDto,
  ) {
    return this.monthly.approve({
      userId,
      year: dto.year,
      month: dto.month,
      approverId: user.id,
    });
  }

  @Post('monthly/:userId/reopen')
  @RequirePermissions({ module: 'hr', action: 'approve' })
  @ApiOperation({
    summary: 'Reopen an APPROVED row (clears approvedBy*; LOCKED rows refuse).',
  })
  reopenMonthly(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: ApproveMonthDto,
  ) {
    return this.monthly.reopen({ userId, year: dto.year, month: dto.month });
  }

  /**
   * HR Phase D1 (2026-10-18, §13 optional lock) — flip a month to
   * LOCKED after a consolidated export. Idempotent on already-locked
   * rows; computes-then-locks if no row exists yet; locks APPROVED
   * rows directly (no recompute, since computeMonth refuses APPROVED).
   * Gated on `hr:export` so whoever can export can also lock.
   */
  @Post('monthly/:userId/lock')
  @RequirePermissions({ module: 'hr', action: 'export' })
  @ApiOperation({
    summary:
      "Lock an employee's MonthlyAttendance row (idempotent; computes-then-locks when no row exists).",
  })
  lockMonthly(
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() user: any,
    @Body() dto: ApproveMonthDto,
  ) {
    return this.monthly.lockMonth({
      userId,
      year: dto.year,
      month: dto.month,
      lockerId: user.id,
    });
  }
}
