import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { HrReportsService } from './hr-reports.service';
import { HrReportXlsxService } from './hr-report-xlsx.service';
import { HrReportPdfService } from './hr-report-pdf.service';
import { BuildReportDto } from './dto/report.dto';

/**
 * HR Phase D1 (2026-10-18) — consolidated accounting report endpoints.
 *
 *   • POST /hr/reports/preview       (hr:export) — JSON payload for the
 *     FE's day-by-day preview panel.
 *   • POST /hr/reports/export/xlsx   (hr:export) — XLSX download.
 *   • POST /hr/reports/export/pdf    (hr:export) — PDF download.
 *
 * All three gate on `hr:export`. HR Clerk + HR Manager hold it per the
 * Phase A seed; Employee does not (403); Admin without an explicit
 * `hr` grant is bounced by the hr-module NO_ADMIN_BYPASS rule.
 *
 * The service's `buildReport` is called by all three — it also
 * enforces the APPROVED-only gate and throws a 400 with a
 * `MONTHLY_NOT_APPROVED` payload listing every blocker so the FE can
 * render a "N employees not yet approved — approve from /hr/review"
 * banner before the user bothers with the download.
 *
 * Mounted on its own controller (not folded into the big HrController)
 * so the Phase D surface is isolated and easy to audit.
 */
@ApiTags('HR - Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('hr/reports')
export class HrReportsController {
  constructor(
    private readonly reports: HrReportsService,
    private readonly xlsx: HrReportXlsxService,
    private readonly pdf: HrReportPdfService,
  ) {}

  @Post('preview')
  @HttpCode(200)
  @RequirePermissions({ module: 'hr', action: 'export' })
  @ApiOperation({
    summary:
      'Preview the consolidated accounting report (same APPROVED gate as the export endpoints).',
  })
  async preview(@Body() body: BuildReportDto) {
    this.validate(body);
    return this.reports.buildReport({
      year: body.year,
      month: body.month,
      scope: body.scope,
    });
  }

  @Post('export/xlsx')
  @HttpCode(200)
  @RequirePermissions({ module: 'hr', action: 'export' })
  @ApiOperation({
    summary:
      'Download the consolidated accounting report as XLSX (one sheet per employee + summary).',
  })
  async exportXlsx(
    @Body() body: BuildReportDto,
    @Res() res: Response,
  ): Promise<void> {
    this.validate(body);
    const payload = await this.reports.buildReport({
      year: body.year,
      month: body.month,
      scope: body.scope,
    });
    const buf = await this.xlsx.write(payload);
    const filename = `hr-report-${body.year}-${String(body.month).padStart(2, '0')}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }

  @Post('export/pdf')
  @HttpCode(200)
  @RequirePermissions({ module: 'hr', action: 'export' })
  @ApiOperation({
    summary:
      'Download the consolidated accounting report as PDF (page per employee).',
  })
  async exportPdf(
    @Body() body: BuildReportDto,
    @Res() res: Response,
  ): Promise<void> {
    this.validate(body);
    const payload = await this.reports.buildReport({
      year: body.year,
      month: body.month,
      scope: body.scope,
    });
    const buf = await this.pdf.write(payload);
    const filename = `hr-report-${body.year}-${String(body.month).padStart(2, '0')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }

  // ─── Local DTO sanity ──────────────────────────────────────────────

  /**
   * `scope` is a discriminated union — class-validator's shallow
   * check can't walk `kind` without a transformer. Re-check here so
   * the service layer gets a well-shaped object.
   */
  private validate(body: BuildReportDto): void {
    const { year, month, scope } = body;
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year must be an integer in [2000, 2100]');
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException('month must be an integer in [1, 12]');
    }
    if (!scope || typeof scope !== 'object') {
      throw new BadRequestException('scope is required');
    }
    const kind = (scope as any).kind;
    if (!['all-active', 'org-unit', 'manual'].includes(kind)) {
      throw new BadRequestException(
        'scope.kind must be one of all-active | org-unit | manual',
      );
    }
    if (kind === 'org-unit' && !Number.isInteger((scope as any).orgUnitId)) {
      throw new BadRequestException(
        'scope.orgUnitId is required for scope.kind=org-unit',
      );
    }
    if (kind === 'manual') {
      const ids = (scope as any).userIds;
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.some((n: any) => !Number.isInteger(n))
      ) {
        throw new BadRequestException(
          'scope.userIds must be a non-empty integer list for scope.kind=manual',
        );
      }
    }
  }
}
