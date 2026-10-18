import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { HrReportsService } from './hr-reports.service';
import { HrReportXlsxService } from './hr-report-xlsx.service';
import { HrReportPdfService } from './hr-report-pdf.service';
import {
  ConsolidatedReportExportQueryDto,
  ConsolidatedReportQueryDto,
} from './dto/report.dto';

/**
 * HR Phase D1 rework (2026-10-18, §13) — consolidated accounting-report
 * endpoints.
 *
 *   • GET /hr/reports/consolidated           (hr:export) — JSON payload
 *   • GET /hr/reports/consolidated/export    (hr:export) — XLSX / PDF blob
 *
 * No APPROVED gate. The report is on-the-fly and empty-state friendly
 * per Yulian's 2026-10-16 principle; status (OPEN/APPROVED/LOCKED/DRAFT)
 * is surfaced as a badge, not a block.
 *
 * Isolated on its own controller so the Phase D surface stays easy to
 * audit against §13 of the HR spec.
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

  @Get('consolidated')
  @RequirePermissions({ module: 'hr', action: 'export' })
  @ApiOperation({
    summary:
      'Consolidated accounting report (on-the-fly, no gate, empty-state friendly). ' +
      'userIds is a CSV of user ids; omit for every active employee.',
  })
  @ApiQuery({ name: 'year', type: Number, required: true })
  @ApiQuery({ name: 'month', type: Number, required: true })
  @ApiQuery({ name: 'userIds', type: String, required: false })
  async consolidated(@Query() q: ConsolidatedReportQueryDto) {
    const userIds = parseUserIdsCsv(q.userIds);
    return this.reports.buildReport({ year: q.year, month: q.month, userIds });
  }

  @Get('consolidated/export')
  @RequirePermissions({ module: 'hr', action: 'export' })
  @ApiOperation({
    summary:
      'Download the consolidated report as XLSX (sheet-per-employee + summary) or PDF (page-per-employee). ' +
      'Same on-the-fly compute as the JSON endpoint.',
  })
  @ApiQuery({ name: 'year', type: Number, required: true })
  @ApiQuery({ name: 'month', type: Number, required: true })
  @ApiQuery({ name: 'userIds', type: String, required: false })
  @ApiQuery({ name: 'format', enum: ['xlsx', 'pdf'], required: true })
  async consolidatedExport(
    @Query() q: ConsolidatedReportExportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    if (q.format !== 'xlsx' && q.format !== 'pdf') {
      throw new BadRequestException('format must be one of xlsx | pdf');
    }
    const userIds = parseUserIdsCsv(q.userIds);
    const payload = await this.reports.buildReport({
      year: q.year,
      month: q.month,
      userIds,
    });

    const monthLabel = `${q.year}-${String(q.month).padStart(2, '0')}`;
    const filename = `hr-report-${monthLabel}.${q.format}`;

    if (q.format === 'xlsx') {
      const buf = await this.xlsx.write(payload);
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
      return;
    }

    const buf = await this.pdf.write(payload);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }
}

/**
 * Parse the `userIds` CSV query param into a number[]. Empty / missing
 * → undefined (= "every active employee"). An entry that doesn't parse
 * is a 400 — we'd rather fail loudly than quietly skip a stale id.
 */
function parseUserIdsCsv(raw: string | undefined): number[] | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const ids: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n <= 0) {
      throw new BadRequestException(
        `userIds contains a non-integer value: "${p}"`,
      );
    }
    ids.push(n);
  }
  return ids;
}
