import { Injectable } from '@nestjs/common';

import type { ReportPayload, ReportPayloadEmployee } from './hr-reports.service';

/**
 * HR Phase D1 rework (2026-10-18, §13) — XLSX writer for the
 * consolidated accounting report. Produces:
 *
 *   • Sheet 00 "סיכום" — one row per employee with header totals + status.
 *   • One sheet per employee named `<lastName> <firstName>` (truncated
 *     to Excel's 31-char limit), with KV header rows + day-by-day table.
 *
 * The report payload is now flat: `employee.header` carries userId +
 * names + accountingEmployeeNumber + totals + status directly (no
 * nested `user` object). The compute is on-the-fly so an employee with
 * no data still appears with zero totals and `status: 'DRAFT'`; an
 * employee whose compute errored carries `header.error` and lands with
 * an "ERROR" row at the top of its own sheet so the Nahchas sees why.
 *
 * RTL: `rightToLeft: true` lives on the WORKSHEET view in exceljs — set
 * on every sheet via `rtlView()`. Hebrew content reads correctly on
 * open with no per-cell flipping.
 */
@Injectable()
export class HrReportXlsxService {
  async write(payload: ReportPayload): Promise<Buffer> {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Planwise';
    workbook.created = new Date();

    // ─── Sheet 00 — summary ────────────────────────────────────────
    const summary = workbook.addWorksheet('סיכום', { views: [rtlView()] });
    summary.columns = [
      { header: 'שם', key: 'name', width: 24 },
      { header: 'מס\' הנהח"ש', key: 'payroll', width: 14 },
      { header: 'סטטוס', key: 'status', width: 12 },
      { header: 'תקן', key: 'standard', width: 10 },
      { header: 'בפועל', key: 'actual', width: 10 },
      { header: 'משוקלל', key: 'weighted', width: 10 },
      { header: 'סטייה', key: 'deviation', width: 10 },
      { header: 'ימי מחלה', key: 'sick', width: 10 },
      { header: 'ימי חופש', key: 'vacation', width: 10 },
    ];
    styleHeaderRow(summary.getRow(1));

    const totals = {
      standard: 0,
      actual: 0,
      weighted: 0,
      deviation: 0,
      sick: 0,
      vacation: 0,
    };

    for (const emp of payload.employees) {
      const row = summary.addRow({
        name: displayName(emp.header),
        payroll: emp.header.accountingEmployeeNumber ?? '',
        status: statusLabel(emp.header.status),
        standard: emp.header.monthlyStandard,
        actual: emp.header.actualHours,
        weighted: emp.header.weightedHours,
        deviation: emp.header.deviation,
        sick: emp.header.sickDays,
        vacation: emp.header.vacationDays,
      });
      totals.standard += emp.header.monthlyStandard;
      totals.actual += emp.header.actualHours;
      totals.weighted += emp.header.weightedHours;
      totals.deviation += emp.header.deviation;
      totals.sick += emp.header.sickDays;
      totals.vacation += emp.header.vacationDays;
      // Red font for negative deviation (approved rule).
      if (emp.header.deviation < 0) {
        row.getCell('deviation').font = { color: { argb: 'FFDC2626' } };
      }
      // Error rows get a red status cell so the Nahchas spots them fast.
      if (emp.header.error) {
        row.getCell('status').font = { color: { argb: 'FFDC2626' }, bold: true };
      }
    }
    const sumRow = summary.addRow({
      name: 'סה"כ',
      payroll: '',
      status: '',
      standard: round2(totals.standard),
      actual: round2(totals.actual),
      weighted: round2(totals.weighted),
      deviation: round2(totals.deviation),
      sick: round2(totals.sick),
      vacation: round2(totals.vacation),
    });
    sumRow.font = { bold: true };
    sumRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2E8F0' }, // slate-200
    };
    (['standard', 'actual', 'weighted', 'deviation', 'sick', 'vacation'] as const)
      .forEach((key) => {
        summary.getColumn(key).numFmt = '0.00';
      });

    // ─── One sheet per employee ────────────────────────────────────
    for (const emp of payload.employees) {
      const name = displayName(emp.header);
      const sheetName = sanitizeSheetName(
        name.length > 0 ? name : `עובד ${emp.header.userId}`,
      );
      const sheet = workbook.addWorksheet(sheetName, { views: [rtlView()] });

      // Compute failure gets a visible banner at the top so the person
      // reading the sheet in Excel doesn't miss it.
      if (emp.header.error) {
        const errRow = sheet.addRow(['שגיאה בחישוב', emp.header.error]);
        errRow.font = { bold: true, color: { argb: 'FFDC2626' } };
      }

      // KV header block (status included so a LOCKED/DRAFT sheet reads clearly).
      const kv: Array<[string, string | number]> = [
        ['שם', displayName(emp.header)],
        ['מס\' הנהח"ש', emp.header.accountingEmployeeNumber ?? ''],
        ['סטטוס', statusLabel(emp.header.status)],
        ['תקן חודשי', emp.header.monthlyStandard],
        ['בפועל', emp.header.actualHours],
        ['משוקלל', emp.header.weightedHours],
        ['סטייה', emp.header.deviation],
        ['סך ימי מחלה', emp.header.sickDays],
        ['סך ימי חופש', emp.header.vacationDays],
      ];
      for (const [label, value] of kv) {
        const r = sheet.addRow([label, value]);
        r.getCell(1).font = { bold: true };
        if (
          label === 'סטייה' &&
          typeof value === 'number' &&
          value < 0
        ) {
          r.getCell(2).font = { color: { argb: 'FFDC2626' } };
        }
      }
      sheet.getColumn(1).width = 20;
      sheet.getColumn(2).width = 20;

      // Blank row.
      sheet.addRow([]);

      // Table header.
      const headerCells = [
        'תאריך',
        'יום',
        'התחלה',
        'סיום',
        'סך שעות',
        'סוג יום',
      ];
      const headerRow = sheet.addRow(headerCells);
      styleHeaderRow(headerRow);
      const tableColWidths = [12, 10, 10, 10, 10, 24];
      tableColWidths.forEach((w, i) => {
        const col = sheet.getColumn(i + 1);
        col.width = Math.max(col.width ?? 0, w);
      });

      // Day rows.
      for (const d of emp.rows) {
        const row = sheet.addRow([
          d.date,
          d.weekday,
          d.startTime ?? '',
          d.endTime ?? '',
          d.totalHours,
          d.dayType,
        ]);
        row.getCell(5).numFmt = '0.00';
      }
    }

    const out = await workbook.xlsx.writeBuffer();
    return Buffer.from(out);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function displayName(h: ReportPayloadEmployee['header']): string {
  // Prefer Hebrew name when either half is present — the sheet is RTL
  // and that's what the Nahchas expects.
  const heFirst = h.firstNameHe?.trim() || '';
  const heLast = h.lastNameHe?.trim() || '';
  if (heFirst || heLast) {
    return `${heLast} ${heFirst}`.trim();
  }
  return `${h.lastName ?? ''} ${h.firstName ?? ''}`.trim();
}

function statusLabel(
  s: ReportPayloadEmployee['header']['status'],
): string {
  switch (s) {
    case 'OPEN':
      return 'פתוח';
    case 'APPROVED':
      return 'מאושר';
    case 'LOCKED':
      return 'נעול';
    case 'DRAFT':
      return 'טיוטה';
    default:
      return String(s);
  }
}

function sanitizeSheetName(name: string): string {
  // Excel: sheet name max 31 chars, reserved chars: : \ / ? * [ ].
  const cleaned = name.replace(/[\\\/\?\*\[\]:]/g, ' ').trim();
  return cleaned.slice(0, 31) || 'Sheet';
}

function styleHeaderRow(row: any): void {
  row.font = { bold: true, color: { argb: 'FF0F172A' } };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE2E8F0' }, // slate-200
  };
  row.alignment = { vertical: 'middle' };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * ExcelJS's TypeScript definitions model Worksheet views as a tagged
 * union (`WorksheetViewNormal | WorksheetViewFrozen | WorksheetViewSplit`).
 * The `rightToLeft` flag lives on `WorksheetViewCommon`, which every
 * union member extends — but TS can't widen the literal object below
 * to the union without a hint, so we cast to the common view shape.
 */
function rtlView() {
  return { state: 'normal', rightToLeft: true } as any;
}
