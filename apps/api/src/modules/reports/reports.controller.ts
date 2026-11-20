import { Controller, Get, Query, UseGuards, Res, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Response } from 'express';

import { ReportsService, scrubTimesheetCost, isCostExportType } from './reports.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ReportQueryDto } from './dto/report-query.dto';
// `canSeeFinance` — explicit finance:read, no admin short-circuit
// (finance is in the RolesGuard's NO_ADMIN_BYPASS). Shared helper since
// permissions round 2.
import { AMOUNT_KEYS, canSeeFinance, omitKeys } from '../../common/finance/finance-access';

@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  // Detailed (row-level) Employee Timesheets — replaces the legacy
  // aggregate report on the Reports page. Returns one row per
  // TimeEntry + per-currency totals. UI handles grouping client-side
  // (no Group / Day / Week / Month / Employee / Project / Zone).
  //
  // Cost visibility is gated by the Finance module. Users with
  // reports:read but no finance:read get the same report with cost +
  // currency fields stripped — they can still consume the hours data.
  @Get('timesheet/detailed')
  @RequirePermissions({ module: 'reports', action: 'read' })
  @ApiOperation({ summary: 'Detailed Employee Timesheets (one row per entry; cost requires finance:read)' })
  async timesheetDetailed(@CurrentUser() user: any, @Query() query: ReportQueryDto) {
    const result = await this.reportsService.timesheetDetailed(query);
    if (canSeeFinance(user)) return result;
    // Scrub cost-bearing fields when the caller lacks finance:read.
    // The rows still surface hours / employee / project / etc. Same
    // scrub the Excel export uses (permissions round 2, B-02).
    return scrubTimesheetCost(result);
  }

  @Get('timesheet/by-project')
  @RequirePermissions({ module: 'reports', action: 'read' })
  @ApiOperation({ summary: 'Timesheet report grouped by project' })
  timesheetByProject(@Query() query: ReportQueryDto) {
    return this.reportsService.timesheetByProject(query);
  }

  @Get('timesheet/by-label')
  @RequirePermissions({ module: 'reports', action: 'read' })
  @ApiOperation({ summary: 'Timesheet report grouped by label' })
  timesheetByLabel(@Query() query: ReportQueryDto) {
    return this.reportsService.timesheetByLabel(query);
  }

  @Get('timesheet/today')
  @RequirePermissions({ module: 'reports', action: 'read' })
  @ApiOperation({ summary: 'Today timesheet summary' })
  timesheetToday() {
    return this.reportsService.timesheetToday();
  }

  @Get('timesheet/activity')
  @RequirePermissions({ module: 'reports', action: 'read' })
  @ApiOperation({ summary: 'Timesheet activity report' })
  timesheetActivity(@Query() query: ReportQueryDto) {
    return this.reportsService.timesheetActivity(query);
  }

  @Get('attendance/summary')
  @RequirePermissions({ module: 'reports', action: 'read' })
  @ApiOperation({ summary: 'Attendance summary report' })
  attendanceSummary(@Query() query: ReportQueryDto) {
    return this.reportsService.attendanceSummary(query);
  }

  @Get('overtime')
  @RequirePermissions({ module: 'reports', action: 'read' })
  @ApiOperation({ summary: 'Overtime report' })
  overtime(@Query() query: ReportQueryDto) {
    return this.reportsService.overtimeReport(query);
  }

  @Get('late-arrivals')
  @RequirePermissions({ module: 'reports', action: 'read' })
  @ApiOperation({ summary: 'Late arrivals report' })
  lateArrivals(@Query() query: ReportQueryDto) {
    return this.reportsService.lateArrivalsReport(query);
  }

  // Cost reports are gated behind the Finance module (Item 1).
  // Users without finance:read get a 403; admins toggle access per
  // role via /admin/roles.
  @Get('cost/by-task')
  @RequirePermissions({ module: 'finance', action: 'read' })
  @ApiOperation({ summary: 'Cost report grouped by task (requires finance:read)' })
  costByTask(@Query() query: ReportQueryDto) {
    return this.reportsService.costByTask(query);
  }

  @Get('cost/by-label')
  @RequirePermissions({ module: 'finance', action: 'read' })
  @ApiOperation({ summary: 'Cost report grouped by label (requires finance:read)' })
  costByLabel(@Query() query: ReportQueryDto) {
    return this.reportsService.costByLabel(query);
  }

  @Get('cost/by-project')
  @RequirePermissions({ module: 'finance', action: 'read' })
  @ApiOperation({ summary: 'Cost report grouped by project (requires finance:read)' })
  costByProject(@Query() query: ReportQueryDto) {
    return this.reportsService.costByProject(query);
  }

  @Get('milestones')
  @RequirePermissions({ module: 'reports', action: 'read' })
  @ApiOperation({ summary: 'Milestones report' })
  async milestones(@CurrentUser() user: any, @Query() query: ReportQueryDto) {
    const rows = await this.reportsService.milestonesReport(query);
    // Permissions round 2 (B-19) — `LabelMilestone.amount` is a payment
    // value; ambiguous name, so stripped here for non-finance callers.
    return canSeeFinance(user) ? rows : omitKeys(rows, AMOUNT_KEYS);
  }

  @Get('export')
  @RequirePermissions({ module: 'reports', action: 'export' })
  @ApiOperation({ summary: 'Export report as Excel or PDF' })
  async exportReport(
    @CurrentUser() user: any,
    @Query('type') type: string,
    @Query('format') format: 'excel' | 'pdf',
    @Query() query: ReportQueryDto,
    @Res() res: Response,
  ) {
    // Permissions round 2 (B-02 / B-03) — files bypass the response
    // interceptor, so the export enforces the finance rule itself:
    //   - cost-* types are cost reports: finance:read or 403 (the JSON
    //     /reports/cost/* routes are finance-gated the same way);
    //   - timesheet-detailed drops the Cost / Currency columns and the
    //     per-currency totals for callers without finance:read.
    const showFinance = canSeeFinance(user);
    if (isCostExportType(type) && !showFinance) {
      throw new ForbiddenException('Cost reports require finance:read permission.');
    }
    const result = await this.reportsService.exportReport(type, format, query, {
      canSeeFinance: showFinance,
    });

    if (format === 'excel') {
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${type}-report.xlsx"`,
      });
    } else {
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${type}-report.pdf"`,
      });
    }

    res.send(result);
  }
}
