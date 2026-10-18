import { Injectable, Logger } from '@nestjs/common';
import { CalendarDayType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { HrMonthlyService } from './hr-monthly.service';

/**
 * HR Phase D1 rework (2026-10-18, §13) — consolidated accounting-report
 * assembler. Yulian's 2026-10-16 principle: "הדוח נפתח ריק (empty-state)
 * ועובד גם בלי נתונים… מחושב on-the-fly… status מוצג כ-badge בלבד."
 *
 * No gate, no blockers, no 500 on empty. Every per-employee header is
 * computed via `HrMonthlyService.getMonthForUser` (read-only — a DRAFT
 * compute when the row hasn't been written yet). The FE shows OPEN /
 * APPROVED / LOCKED / DRAFT as a badge; nothing is refused.
 *
 * Scope resolution:
 *   - userIds given → that intersection with active employees
 *   - userIds omitted → every `userType IN (employee, both)` user that's
 *     active and not soft-deleted
 *
 * Sort: accountingEmployeeNumber ASC NULLS LAST (numeric compare when
 * both halves parse as numbers, lexicographic fallback), then lastName,
 * firstName — deterministic so XLSX sheet-tabs and PDF pages match the
 * summary row order.
 *
 * Error isolation: one bad user's compute (bad DB row, missing calendar,
 * etc.) MUST NOT tank the whole report. Each employee is wrapped — on
 * throw we emit a stub row with `error`, `status: 'DRAFT'` and zero
 * totals so the Nahchas still sees the person on the sheet.
 */
@Injectable()
export class HrReportsService {
  private readonly log = new Logger(HrReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly monthly: HrMonthlyService,
  ) {}

  // ─── Public API ────────────────────────────────────────────────────

  async buildReport(args: {
    year: number;
    month: number;
    userIds?: number[];
  }): Promise<ReportPayload> {
    const { year, month, userIds } = args;

    // 1) Resolve the user set. Empty resolution → empty payload (never
    //    a 500; the FE shows the empty-state card).
    const users = await this.resolveUsers(userIds);
    if (users.length === 0) {
      return { year, month, employees: [] };
    }

    // 2) Per-employee compute. Each run in its own try/catch so one bad
    //    user never pulls the rest down.
    const employees: ReportPayloadEmployee[] = [];
    for (const u of users) {
      try {
        const emp = await this.buildOneEmployee(u, year, month);
        employees.push(emp);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        this.log.warn(
          `[hr/reports] compute failed for userId=${u.id} ${year}-${month}: ${msg}`,
        );
        employees.push({
          header: {
            userId: u.id,
            firstName: u.firstName,
            lastName: u.lastName,
            firstNameHe: u.firstNameHe,
            lastNameHe: u.lastNameHe,
            accountingEmployeeNumber: u.accountingEmployeeNumber,
            monthlyStandard: 0,
            actualHours: 0,
            weightedHours: 0,
            deviation: 0,
            sickDays: 0,
            vacationDays: 0,
            status: 'DRAFT',
            error: msg,
          },
          rows: [],
        });
      }
    }

    return { year, month, employees };
  }

  // ─── Per-employee compute ──────────────────────────────────────────

  private async buildOneEmployee(
    u: EmployeeRow,
    year: number,
    month: number,
  ): Promise<ReportPayloadEmployee> {
    // on-the-fly: `getMonthForUser` returns the real row when one
    // exists (with its real status), or a DRAFT compute (no write)
    // when it doesn't. Pure read.
    const [{ row }, daily, timeEntries, absenceRecords] = await Promise.all([
      this.monthly.getMonthForUser(u.id, year, month),
      this.monthly.getDailyBreakdown(u.id, year, month),
      this.prisma.timeEntry.findMany({
        where: {
          userId: u.id,
          deletedAt: null,
          date: {
            gte: new Date(year, month - 1, 1),
            lt: new Date(year, month, 1),
          },
        },
        select: {
          id: true,
          date: true,
          startTime: true,
          endTime: true,
          minutes: true,
        },
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.absenceRecord.findMany({
        where: {
          userId: u.id,
          dateFrom: { lt: new Date(year, month, 1) },
          dateTo: { gte: new Date(year, month - 1, 1) },
        },
        include: {
          absenceType: { select: { nameHe: true, code: true, unit: true } },
        },
      }),
    ]);

    // Index TimeEntries by YMD so the per-day join is O(1).
    const entriesByYMD = new Map<string, typeof timeEntries>();
    for (const t of timeEntries) {
      const key = ymdKey(t.date);
      const arr = entriesByYMD.get(key) ?? [];
      arr.push(t);
      entriesByYMD.set(key, arr);
    }

    const rows: ReportPayloadRow[] = daily.map((d) => {
      const key = ymdKey(d.date);
      const sameDayEntries = (entriesByYMD.get(key) ?? [])
        .slice()
        .sort((a, b) =>
          (a.startTime ?? '~').localeCompare(b.startTime ?? '~'),
        );
      const first = sameDayEntries[0] ?? null;
      const last = sameDayEntries[sameDayEntries.length - 1] ?? null;
      // Absence record covering the day (if any) → its Hebrew label
      // wins over the CalendarDay type in the "סוג יום" column.
      const absence = absenceRecords.find((a) =>
        withinInclusive(d.date, a.dateFrom, a.dateTo),
      );
      return {
        date: ymdKey(d.date),
        weekday: HE_DOW_FULL[d.date.getDay()],
        startTime: first?.startTime ?? null,
        endTime: last?.endTime ?? null,
        totalHours: round2(d.actualHours + d.absenceCredit),
        dayType: dayTypeLabel(d.dayType, absence?.absenceType.nameHe ?? null),
      };
    });

    return {
      header: {
        userId: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        firstNameHe: u.firstNameHe,
        lastNameHe: u.lastNameHe,
        accountingEmployeeNumber: u.accountingEmployeeNumber,
        monthlyStandard: Number(row.monthlyStandard),
        actualHours: Number(row.actualHours),
        weightedHours: Number(row.weightedHours),
        deviation: Number(row.deviation),
        sickDays: Number(row.sickDays),
        vacationDays: Number(row.vacationDays),
        status: row.status,
      },
      rows,
    };
  }

  // ─── Scope resolution ──────────────────────────────────────────────

  /**
   * Resolve the sorted employee set. If `userIds` is supplied we
   * intersect with the active employee filter (same `userType IN
   * (employee, both)` + active + not-deleted) so a stale id can't leak
   * through. If missing, we return every active employee.
   */
  private async resolveUsers(userIds?: number[]): Promise<EmployeeRow[]> {
    const where: any = {
      userType: { in: ['employee', 'both'] },
      isActive: true,
      deletedAt: null,
    };
    if (userIds && userIds.length > 0) {
      where.id = { in: userIds };
    }
    const rows = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        firstNameHe: true,
        lastNameHe: true,
        accountingEmployeeNumber: true,
      },
    });
    // Sort: accountingEmployeeNumber ASC NULLS LAST, lastName, firstName.
    // Numeric compare when both are numeric strings; lexicographic otherwise.
    rows.sort((a, b) => {
      const aNum = a.accountingEmployeeNumber;
      const bNum = b.accountingEmployeeNumber;
      if (aNum == null && bNum == null) {
        // fall through to name tiebreak
      } else if (aNum == null) {
        return 1; // nulls last
      } else if (bNum == null) {
        return -1;
      } else {
        const an = Number(aNum);
        const bn = Number(bNum);
        if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) {
          return an - bn;
        }
        if (aNum !== bNum) return aNum < bNum ? -1 : 1;
      }
      if ((a.lastName ?? '') !== (b.lastName ?? ''))
        return (a.lastName ?? '') < (b.lastName ?? '') ? -1 : 1;
      return (a.firstName ?? '') < (b.firstName ?? '') ? -1 : 1;
    });
    return rows;
  }
}

// ─── Types ───────────────────────────────────────────────────────────

interface EmployeeRow {
  id: number;
  firstName: string;
  lastName: string;
  firstNameHe: string | null;
  lastNameHe: string | null;
  accountingEmployeeNumber: string | null;
}

export interface ReportPayloadRow {
  /** yyyy-MM-dd */
  date: string;
  /** Hebrew: ראשון/שני/.../שבת */
  weekday: string;
  startTime: string | null;
  endTime: string | null;
  totalHours: number;
  dayType: string;
}

export interface ReportPayloadEmployee {
  header: {
    userId: number;
    firstName: string;
    lastName: string;
    firstNameHe: string | null;
    lastNameHe: string | null;
    accountingEmployeeNumber: string | null;
    monthlyStandard: number;
    actualHours: number;
    weightedHours: number;
    deviation: number;
    sickDays: number;
    vacationDays: number;
    status: 'OPEN' | 'APPROVED' | 'LOCKED' | 'DRAFT';
    /** Set only when the per-employee compute threw. */
    error?: string;
  };
  rows: ReportPayloadRow[];
}

export interface ReportPayload {
  year: number;
  month: number;
  employees: ReportPayloadEmployee[];
}

// ─── Helpers ─────────────────────────────────────────────────────────

const HE_DOW_FULL = [
  'ראשון',
  'שני',
  'שלישי',
  'רביעי',
  'חמישי',
  'שישי',
  'שבת',
];

const DAY_TYPE_HE: Record<CalendarDayType, string> = {
  REGULAR: 'עבודה רגילה',
  HOLIDAY: 'חג',
  HOLIDAY_EVE: 'ערב חג',
  CHOL_HAMOED: 'חוה״מ',
  REST: 'מנוחה',
};

/**
 * If the day has an AbsenceRecord covering it, prefer its Hebrew
 * label (e.g. "חופשה", "מחלה") — that's what the Nahchas (accounting)
 * sheet wants in the "סוג יום" column. Otherwise, fall back to the
 * CalendarDay type label.
 */
function dayTypeLabel(
  type: CalendarDayType,
  absenceLabel: string | null,
): string {
  if (absenceLabel) return absenceLabel;
  return DAY_TYPE_HE[type] ?? DAY_TYPE_HE.REGULAR;
}

function ymdKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function withinInclusive(date: Date, from: Date, to: Date): boolean {
  const d = ymdInt(date);
  return d >= ymdInt(from) && d <= ymdInt(to);
}

function ymdInt(d: Date): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
