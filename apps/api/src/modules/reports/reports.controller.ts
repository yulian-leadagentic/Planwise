import { Controller, Get, Query, UseGuards, Res } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Response } from 'express';

import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { ReportQueryDto } from './dto/report-query.dto';

@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

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

  @Get('cost/by-task')
  @RequirePermissions({ module: 'reports', action: 'read' })
  @ApiOperation({ summary: 'Cost report grouped by task' })
  costByTask(@Query() query: ReportQueryDto) {
    return this.reportsService.costByTask(query);
  }

  @Get('cost/by-label')
  @RequirePermissions({ module: 'reports', action: 'read' })
  @ApiOperation({ summary: 'Cost report grouped by label' })
  costByLabel(@Query() query: ReportQueryDto) {
    return this.reportsService.costByLabel(query);
  }

  @Get('cost/by-project')
  @RequirePermissions({ module: 'reports', action: 'read' })
  @ApiOperation({ summary: 'Cost report grouped by project' })
  costByProject(@Query() query: ReportQueryDto) {
    return this.reportsService.costByProject(query);
  }

  @Get('milestones')
  @RequirePermissions({ module: 'reports', action: 'read' })
  @ApiOperation({ summary: 'Milestones report' })
  milestones(@Query() query: ReportQueryDto) {
    return this.reportsService.milestonesReport(query);
  }

  @Get('export')
  @RequirePermissions({ module: 'reports', action: 'read' })
  @ApiOperation({ summary: 'Export report as Excel or PDF' })
  async exportReport(
    @Query('type') type: string,
    @Query('format') format: 'excel' | 'pdf',
    @Query() query: ReportQueryDto,
    @Res() res: Response,
  ) {
    const result = await this.reportsService.exportReport(type, format, query);

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
