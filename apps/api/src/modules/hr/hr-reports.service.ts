import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CalendarDayType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { HrMonthlyService } from './hr-monthly.service';
import type { ReportScope } from './dto/report.dto';

/**
 * HR Phase D1 (2026-10-18) — consolidated accounting report assembler
 * (§5 of the HR spec). Pulls:
 *
 *   • the (user × year × month) MonthlyAttendance header totals
 *     (gates on status === APPROVED; refuses any employee not approved)
 *   • a full calendar view (every day of the month, even "no activity")
 *     joining TimeEntry start/end/hours + AbsenceRecord + CalendarDay
 *
 * The result is a plain `ReportPayload` the format writers (XLSX /
 * PDF) consume. Shared by `/hr/reports/preview` too — the preview
 * endpoint hits the same APPROVED gate so the user is told BEFORE
 * they click "Export".
 *
 * Scope resolution:
 *   - all-active   → every active employee (userType=employee)
 *   - org-unit     → the unit AND its subtree (via materialised path)
 *   - manual       → explicit userIds, intersected with active employees
 *
 * Sort order:
 *   accountingEmployeeNumber ASC NULLS LAST, lastName, firstName.
 *   (Deterministic so the XLSX sheet-tabs + the PDF pages match the
 *   summary row order.)
 *
 * No schema change / no migration / no backfill — pure read.
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
    scope: ReportScope;
  }): Promise<ReportPayload> {
    const { year, month, scope } = args;

    // 1) Resolve the user set.
    const users = await this.resolveScope(scope);
    if (users.length === 0) {
      throw new BadRequestException({
        message: 'No employees matched the selected scope.',
        code: 'EMPTY_SCOPE',
      });
    }

    // 2) APPROVED gate (critical). Reject the whole export if even
    //    one user is missing / OPEN / LOCKED. The FE renders the
    //    blocker list and links to /hr/review.
    const headers = await this.prisma.monthlyAttendance.findMany({
      where: {
        year,
        month,
        userId: { in: users.map((u) => u.id) },
      },
    });
    const headerByUser = new Map(headers.map((h) => [h.userId, h]));
    const blockers: Array<{
      userId: number;
      firstName: string;
      lastName: string;
      status: 'OPEN' | 'LOCKED' | 'MISSING';
    }> = [];
    for (const u of users) {
      const row = headerByUser.get(u.id);
      if (!row) {
        blockers.push({
          userId: u.id,
          firstName: u.firstName,
          lastName: u.lastName,
          status: 'MISSING',
        });
      } else if (row.status !== 'APPROVED') {
        blockers.push({
          userId: u.id,
          firstName: u.firstName,
          lastName: u.lastName,
          // LOCKED here is a corner-case: once a row is locked (post-
          // export in a future phase) it's immutable; we still block
          // the export the same way as OPEN so the row isn't quietly
          // bundled into a fresh file. If LOCKED should be re-exportable
          // we can flip this check without changing the FE contract.
          status: row.status as 'OPEN' | 'LOCKED',
        });
      }
    }
    if (blockers.length > 0) {
      throw new BadRequestException({
        error: 'MONTHLY_NOT_APPROVED',
        message:
          'All selected employees must have an APPROVED monthly review for this month. Approve from /hr/review first.',
        blockers,
      });
    }

    // 3) Build per-employee day rows. The engine's `getDailyBreakdown`
    //    emits one row per calendar day already; we join start/end + a
    //    Hebrew day-type label for the accounting sheet.
    const employees: ReportPayload['employees'] = [];
    for (const u of users) {
      const header = headerByUser.get(u.id)!;
      const [daily, timeEntries, absenceRecords] = await Promise.all([
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

      const days: ReportPayloadDay[] = daily.map((d) => {
        const key = ymdKey(d.date);
        const sameDayEntries = (entriesByYMD.get(key) ?? [])
          .slice()
          .sort((a, b) =>
            (a.startTime ?? '~').localeCompare(b.startTime ?? '~'),
          );
        const first = sameDayEntries[0] ?? null;
        const last = sameDayEntries[sameDayEntries.length - 1] ?? null;
        // Absence record covering the day (if any)
        const absence = absenceRecords.find((a) =>
          withinInclusive(d.date, a.dateFrom, a.dateTo),
        );

        return {
          date: ymdKey(d.date),
          dayOfWeek: HE_DOW_FULL[d.date.getDay()],
          startTime: first?.startTime ?? null,
          endTime: last?.endTime ?? null,
          totalHours: round2(d.actualHours + d.absenceCredit),
          dayType: dayTypeLabel(d.dayType, absence?.absenceType.nameHe ?? null),
        };
      });

      employees.push({
        user: {
          id: u.id,
          firstName: u.firstName,
          lastName: u.lastName,
          firstNameHe: u.firstNameHe,
          lastNameHe: u.lastNameHe,
          accountingEmployeeNumber: u.accountingEmployeeNumber,
        },
        header: {
          monthlyStandard: Number(header.monthlyStandard),
          actualHours: Number(header.actualHours),
          weightedHours: Number(header.weightedHours),
          deviation: Number(header.deviation),
          sickDays: Number(header.sickDays),
          vacationDays: Number(header.vacationDays),
        },
        days,
      });
    }

    return { year, month, employees };
  }

  // ─── Scope resolution ──────────────────────────────────────────────

  private async resolveScope(scope: ReportScope): Promise<EmployeeRow[]> {
    if (!scope || typeof scope !== 'object' || !('kind' in scope)) {
      throw new BadRequestException(
        'scope must be { kind: "all-active" | "org-unit" | "manual", ... }',
      );
    }

    if (scope.kind === 'all-active') {
      return this.loadEmployees({
        userType: 'employee',
        isActive: true,
        deletedAt: null,
      });
    }

    if (scope.kind === 'org-unit') {
      if (!Number.isInteger(scope.orgUnitId)) {
        throw new BadRequestException(
          'scope.orgUnitId is required when scope.kind=org-unit',
        );
      }
      // OrgUnit.path is a materialised path "/1/5/12/" that includes
      // the unit's own id. Members of the subtree are any user whose
      // homeUnit's path startsWith the target unit's path — this
      // picks up descendants without a recursive CTE.
      const anchor = await this.prisma.orgUnit.findUnique({
        where: { id: scope.orgUnitId! },
        select: { id: true, path: true },
      });
      if (!anchor) {
        throw new BadRequestException(
          `OrgUnit ${scope.orgUnitId} not found`,
        );
      }
      const unitIds = await this.prisma.orgUnit.findMany({
        where: { path: { startsWith: anchor.path } },
        select: { id: true },
      });
      return this.loadEmployees({
        userType: 'employee',
        isActive: true,
        deletedAt: null,
        orgUnitId: { in: unitIds.map((u) => u.id) },
      });
    }

    // manual
    if (
      !Array.isArray(scope.userIds) ||
      scope.userIds.length === 0 ||
      scope.userIds.some((n) => !Number.isInteger(n))
    ) {
      throw new BadRequestException(
        'scope.userIds must be a non-empty integer list when scope.kind=manual',
      );
    }
    return this.loadEmployees({
      id: { in: scope.userIds },
      userType: 'employee',
      isActive: true,
      deletedAt: null,
    });
  }

  private async loadEmployees(where: any): Promise<EmployeeRow[]> {
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
        // fall through
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

export interface ReportPayloadDay {
  date: string; // yyyy-MM-dd
  dayOfWeek: string; // Hebrew: ראשון/שני/.../שבת
  startTime: string | null;
  endTime: string | null;
  totalHours: number;
  dayType: string;
}

export interface ReportPayload {
  year: number;
  month: number;
  employees: Array<{
    user: {
      id: number;
      firstName: string;
      lastName: string;
      firstNameHe: string | null;
      lastNameHe: string | null;
      accountingEmployeeNumber: string | null;
    };
    header: {
      monthlyStandard: number;
      actualHours: number;
      weightedHours: number;
      deviation: number;
      sickDays: number;
      vacationDays: number;
    };
    days: ReportPayloadDay[];
  }>;
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
