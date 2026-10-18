import { Module } from '@nestjs/common';

import { HrController } from './hr.controller';
import { HrReportsController } from './hr-reports.controller';
import { HrService } from './hr.service';
import { HrMonthlyService } from './hr-monthly.service';
import { HrReportsService } from './hr-reports.service';
import { HrReportXlsxService } from './hr-report-xlsx.service';
import { HrReportPdfService } from './hr-report-pdf.service';
import { FilesModule } from '../files/files.module';

/**
 * HR Phase A3+B3+C2+D1 (2026-10-18) — mounts the `/hr/*` controllers +
 * their services (catalog/employee CRUD + monthly engine + consolidated
 * accounting-report writers).
 *
 * FilesModule is imported so HrService can inject FilesService for the
 * EmployeeAttachment multipart upload path. ActivityLogService is
 * provided globally by ActivityLogModule.
 *
 * Phase D1 adds:
 *   • HrReportsController ← /hr/reports/{preview,export/xlsx,export/pdf}
 *   • HrReportsService    ← payload assembler + APPROVED gate
 *   • HrReportXlsxService ← exceljs writer (sheet-per-employee + summary)
 *   • HrReportPdfService  ← pdfkit writer (page-per-employee, bundled
 *                           NotoSansHebrew font)
 *
 * HrMonthlyService stays exported for any future module that wants to
 * reuse the engine (unchanged from Phase C2).
 */
@Module({
  imports: [FilesModule],
  controllers: [HrController, HrReportsController],
  providers: [
    HrService,
    HrMonthlyService,
    HrReportsService,
    HrReportXlsxService,
    HrReportPdfService,
  ],
  exports: [HrMonthlyService],
})
export class HrModule {}
