import { Injectable } from '@nestjs/common';

import type { ReportPayload } from './hr-reports.service';

/**
 * HR Phase D1 (2026-10-18) — XLSX writer for the consolidated
 * accounting report (§5). Produces a workbook with:
 *
 *   • Sheet 00 "סיכום" — one row per employee with the header totals.
 *   • One sheet per employee named `<lastName> <firstName>` (truncated
 *     to Excel's 31-char limit), with KV header rows + the day-by-day
 *     table.
 *
 * RTL: the workbook is marked `rightToLeft: true` so Hebrew content
 * reads correctly on open. ExcelJS supports this at the workbook view
 * level — no per-cell flipping needed.
 *
 * The uses here mirror the shape in `reports.service.ts` (the legacy
 * timesheet XLSX) so the two export surfaces share the same patterns.
 */
@Injectable()
export class HrReportXlsxService {
  async write(payload: ReportPayload): Promise<Buffer> {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Planwise';
    workbook.created = new Date();
    // RTL lives on the WORKSHEET view (not the workbook view) in
    // exceljs; apply it to every sheet below via `rtlView()`.

    // ─── Sheet 00 — summary ────────────────────────────────────────
    const summary = workbook.addWorksheet('סיכום', { views: [rtlView()] });
    summary.columns = [
      { header: 'שם', key: 'name', width: 24 },
      { header: 'מס\' הנהח"ש', key: 'payroll', width: 14 },
      { header: 'תקן', key: 'standard', width: 10 },
      { header: 'בפועל', key: 'actual', width: 10 },
      { header: 'משוקלל', key: 'weighted', width: 10 },
      { header: 'סטייה', key: 'deviation', width: 10 },
      { header: 'ימי מחלה', key: 'sick', width: 10 },
      { header: 'ימי חופש', key: 'vacation', width: 10 },
    ];
    styleHeaderRow(summary.getRow(1));

    // Running totals
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
        name: displayName(emp.user),
        payroll: emp.user.accountingEmployeeNumber ?? '',
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
    }
    const sumRow = summary.addRow({
      name: 'סה"כ',
      payroll: '',
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
    // Number format with 2-decimal on hour columns.
    (['standard', 'actual', 'weighted', 'deviation', 'sick', 'vacation'] as const)
      .forEach((key) => {
        summary.getColumn(key).numFmt = '0.00';
      });

    // ─── One sheet per employee ────────────────────────────────────
    for (const emp of payload.employees) {
      const name = displayName(emp.user);
      // Excel sheet name max 31 chars; strip \[]*?/\\: (reserved).
      const sheetName = sanitizeSheetName(
        name.length > 0 ? name : `עובד ${emp.user.id}`,
      );
      const sheet = workbook.addWorksheet(sheetName, { views: [rtlView()] });

      // KV header block.
      const kv: Array<[string, string | number]> = [
        ['שם', displayName(emp.user)],
        ['מס\' הנהח"ש', emp.user.accountingEmployeeNumber ?? ''],
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
      // Column widths after header is added (ExcelJS fills columns on
      // sheet growth; this reaches past the KV block above).
      const tableColWidths = [12, 10, 10, 10, 10, 24];
      tableColWidths.forEach((w, i) => {
        const col = sheet.getColumn(i + 1);
        col.width = Math.max(col.width ?? 0, w);
      });

      // Day rows.
      for (const d of emp.days) {
        const row = sheet.addRow([
          d.date,
          d.dayOfWeek,
          d.startTime ?? '',
          d.endTime ?? '',
          d.totalHours,
          d.dayType,
        ]);
        // Hours as 2-decimal number.
        row.getCell(5).numFmt = '0.00';
      }
    }

    const out = await workbook.xlsx.writeBuffer();
    return Buffer.from(out);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function displayName(u: {
  firstName: string;
  lastName: string;
  firstNameHe: string | null;
  lastNameHe: string | null;
}): string {
  // Prefer Hebrew name when either half is present — the sheet is RTL
  // and that's what the Nahchas expects.
  const heFirst = u.firstNameHe?.trim() || '';
  const heLast = u.lastNameHe?.trim() || '';
  if (heFirst || heLast) {
    return `${heLast} ${heFirst}`.trim();
  }
  return `${u.lastName ?? ''} ${u.firstName ?? ''}`.trim();
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
