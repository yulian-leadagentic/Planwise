import { Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'fs';
import { join } from 'path';

import type { ReportPayload, ReportPayloadEmployee } from './hr-reports.service';

/**
 * HR Phase D1 rework (2026-10-18, §13) — PDF writer for the
 * consolidated accounting report. Page-per-employee with a bundled
 * Hebrew font (NotoSansHebrew-Regular + Bold).
 *
 * The payload is now flat: `employee.header` carries userId + names +
 * accountingEmployeeNumber + totals + status directly, and may carry an
 * `error` string when the per-employee compute threw. We print the
 * status next to the name on each page header; errors land as a red
 * strip at the top of the page.
 *
 * Known limitation — pdfkit does NOT do Unicode bidirectional
 * reordering natively, so a Hebrew-only line renders in LOGICAL
 * (storage) order while the Nahchas expects visual RTL. We mitigate
 * by:
 *   • reversing Hebrew-only strings before `doc.text` so they render
 *     visually right-to-left on the page
 *   • mixed Hebrew/Latin or numeric lines stay as-is — reversing them
 *     would scramble the Latin side (approved tradeoff: XLSX is the
 *     primary accounting deliverable, PDF is a secondary preview)
 *
 * The Hebrew font is loaded from `./fonts/NotoSansHebrew-Regular.ttf`
 * (and the Bold variant). nest-cli.json copies that folder into
 * `dist/modules/hr/fonts/` on build so the same relative path works
 * in prod. If the font file is missing at runtime we fall back to
 * Helvetica + log a warning (prevents a 500 for an op pack that
 * forgot the asset).
 */
@Injectable()
export class HrReportPdfService {
  private readonly log = new Logger(HrReportPdfService.name);

  async write(payload: ReportPayload): Promise<Buffer> {
    // Lazy import so cold boots that never touch /hr/reports don't
    // pay the pdfkit module-load cost.
    const PDFDocument = (await import('pdfkit')).default;

    const fontDir = join(__dirname, 'fonts');
    const regularPath = join(fontDir, 'NotoSansHebrew-Regular.ttf');
    const boldPath = join(fontDir, 'NotoSansHebrew-Bold.ttf');
    const hasHebrewFont = existsSync(regularPath);
    if (!hasHebrewFont) {
      this.log.warn(
        `[hr/reports] Hebrew font missing at ${regularPath} — falling back to Helvetica. PDF Hebrew will render as missing glyphs.`,
      );
    }

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          margin: 50,
          size: 'A4',
          layout: 'portrait',
          bufferPages: true,
        });
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        if (hasHebrewFont) {
          doc.registerFont('heb', regularPath);
          if (existsSync(boldPath)) doc.registerFont('heb-bold', boldPath);
          else doc.registerFont('heb-bold', regularPath);
        }
        const regularFont = hasHebrewFont ? 'heb' : 'Helvetica';
        const boldFont = hasHebrewFont ? 'heb-bold' : 'Helvetica-Bold';

        const monthLabel = `${payload.year}-${String(payload.month).padStart(2, '0')}`;

        // Empty payload: still emit a one-page "no data" sheet so the
        // response body is a valid PDF (never 500 on empty-state).
        if (payload.employees.length === 0) {
          doc.font(boldFont).fontSize(16);
          doc.text(revHe('אין נתונים לחודש'), 50, 80, {
            width: doc.page.width - 100,
            align: 'right',
          });
          doc.font(regularFont).fontSize(10).fillColor('#64748B');
          doc.moveDown(0.4);
          doc.text(`${revHe('חודש')}: ${monthLabel}`, {
            width: doc.page.width - 100,
            align: 'right',
          });
          doc.fillColor('black');
          doc.end();
          return;
        }

        payload.employees.forEach((emp, idx) => {
          if (idx > 0) doc.addPage();

          const pageWidth = doc.page.width;
          const left = 50;
          const right = pageWidth - 50;

          // Error strip (if any) — red bar at the very top so a
          // compute failure is impossible to miss.
          if (emp.header.error) {
            doc.font(boldFont).fontSize(10).fillColor('#DC2626');
            doc.text(
              `${revHe('שגיאה בחישוב')}: ${emp.header.error}`,
              left,
              40,
              { width: right - left, align: 'right' },
            );
            doc.fillColor('black');
          }

          // ─ Header: name + status + month in big bold on the right (RTL feel) ─
          const name = displayName(emp.header);
          doc.font(boldFont).fontSize(20);
          doc.text(revHe(name), left, 60, {
            width: right - left,
            align: 'right',
          });
          doc.moveDown(0.2);
          doc.font(regularFont).fontSize(10).fillColor('#64748B'); // slate-500
          doc.text(
            `${revHe('חודש')}: ${monthLabel}  ·  ${revHe('מס\' הנהח"ש')}: ${
              emp.header.accountingEmployeeNumber ?? '—'
            }  ·  ${revHe('סטטוס')}: ${revHe(statusLabel(emp.header.status))}`,
            { width: right - left, align: 'right' },
          );
          doc.fillColor('black');
          doc.moveDown(0.6);

          // ─ Summary KV grid ──────────────────────────────────────
          const kv: Array<[string, string, boolean]> = [
            ['תקן חודשי', fmtHours(emp.header.monthlyStandard), false],
            ['בפועל', fmtHours(emp.header.actualHours), false],
            ['משוקלל', fmtHours(emp.header.weightedHours), false],
            [
              'סטייה',
              `${emp.header.deviation >= 0 ? '+' : ''}${fmtHours(
                emp.header.deviation,
              )}`,
              emp.header.deviation < 0,
            ],
            ['סך ימי מחלה', String(emp.header.sickDays), false],
            ['סך ימי חופש', String(emp.header.vacationDays), false],
          ];
          const kvY = doc.y;
          const kvCols = 3;
          const kvRows = Math.ceil(kv.length / kvCols);
          const colW = (right - left) / kvCols;
          doc.fontSize(10);
          kv.forEach(([label, value, highlight], i) => {
            const r = Math.floor(i / kvCols);
            const c = i % kvCols;
            // RTL layout feel: first column on the right.
            const x = right - (c + 1) * colW;
            const y = kvY + r * 32;
            doc.font(regularFont).fillColor('#64748B');
            doc.text(revHe(label), x + 8, y, {
              width: colW - 16,
              align: 'right',
            });
            doc.font(boldFont);
            if (highlight) doc.fillColor('#DC2626');
            else doc.fillColor('black');
            doc.text(revHe(value), x + 8, y + 14, {
              width: colW - 16,
              align: 'right',
            });
          });
          doc.fillColor('black');
          doc.y = kvY + kvRows * 32 + 10;

          // ─ Days table ──────────────────────────────────────────
          const headers = [
            'תאריך',
            'יום',
            'התחלה',
            'סיום',
            'סה"כ שעות',
            'סוג יום',
          ];
          const colWeights = [1.2, 0.8, 0.8, 0.8, 1, 2];
          const totalW = right - left;
          const sumWeight = colWeights.reduce((a, b) => a + b, 0);
          const colWidths = colWeights.map((w) => (w / sumWeight) * totalW);
          // Reverse column widths for RTL (first column on the right)
          const rtlColWidths = [...colWidths].reverse();
          const rtlHeaders = [...headers].reverse();

          const tableTop = doc.y;
          doc.rect(left, tableTop, totalW, 20).fill('#E2E8F0'); // slate-200
          doc.fillColor('black').font(boldFont).fontSize(10);
          let xCursor = left;
          rtlHeaders.forEach((h, i) => {
            doc.text(revHe(h), xCursor + 4, tableTop + 5, {
              width: rtlColWidths[i] - 8,
              align: 'right',
              lineBreak: false,
            });
            xCursor += rtlColWidths[i];
          });
          doc.y = tableTop + 22;

          // Rows (text pre-reversed for Hebrew; dates/times stay LTR
          // because they're numeric and look wrong when reversed).
          doc.font(regularFont).fontSize(9);
          const rowH = 16;
          const pageBottom = doc.page.height - 50;
          for (const d of emp.rows) {
            // Page-break guard: new sheet for the SAME employee if we
            // run out of vertical space on a particularly long month.
            if (doc.y + rowH > pageBottom) {
              doc.addPage();
            }
            const rtlCells = [
              revHe(d.dayType),
              fmtHours(d.totalHours),
              d.endTime ?? '',
              d.startTime ?? '',
              revHe(d.weekday),
              d.date,
            ];
            xCursor = left;
            const rowY = doc.y;
            rtlCells.forEach((cell, i) => {
              doc.text(cell, xCursor + 4, rowY + 3, {
                width: rtlColWidths[i] - 8,
                align: 'right',
                lineBreak: false,
              });
              xCursor += rtlColWidths[i];
            });
            doc
              .strokeColor('#E2E8F0')
              .lineWidth(0.5)
              .moveTo(left, rowY + rowH)
              .lineTo(right, rowY + rowH)
              .stroke()
              .strokeColor('black');
            doc.y = rowY + rowH;
          }
        });

        // Footer: page X of N
        const range = (doc as any).bufferedPageRange();
        for (let i = range.start; i < range.start + range.count; i++) {
          doc.switchToPage(i);
          doc.font(regularFont).fontSize(8).fillColor('#64748B');
          doc.text(
            `${revHe('עמוד')} ${i + 1 - range.start} / ${range.count}`,
            50,
            doc.page.height - 30,
            {
              width: doc.page.width - 100,
              align: 'center',
            },
          );
          doc.fillColor('black');
        }

        doc.end();
      } catch (e) {
        reject(e);
      }
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * pdfkit does not reorder RTL text — a Hebrew string "שלום" rendered
 * via `doc.text` stays in logical order "ש·ל·ו·ם", which an RTL
 * reader expects to see "ם·ו·ל·ש". We pre-reverse Hebrew-only strings
 * so the on-page order visually matches. Mixed-script strings keep
 * their logical order (reversing would scramble the Latin half).
 */
function revHe(s: string): string {
  if (!s) return s;
  // Detect Hebrew: U+0590–U+05FF covers all consonants + niqqud.
  const hasHebrew = /[֐-׿]/.test(s);
  const hasLatin = /[A-Za-z]/.test(s);
  if (!hasHebrew) return s;
  if (hasLatin) return s; // mixed: leave logical order, best we can do
  // Reverse char-by-char. Noto Sans Hebrew is non-connecting so this
  // is a clean visual flip without needing shaping.
  return s.split('').reverse().join('');
}

function displayName(h: ReportPayloadEmployee['header']): string {
  const heFirst = h.firstNameHe?.trim() || '';
  const heLast = h.lastNameHe?.trim() || '';
  if (heFirst || heLast) return `${heLast} ${heFirst}`.trim();
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

function fmtHours(n: number): string {
  return n.toFixed(2);
}
