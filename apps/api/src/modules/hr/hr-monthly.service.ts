import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AbsenceUnit,
  BucketCreditMode,
  CalendarDayType,
  MonthlyStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * HR Phase C2 (2026-10-16) — monthly attendance engine per
 * docs/bm2/planwise-hr-module-spec.md §4 + §10.
 *
 * Pure + deterministic by design. The only clock side-effect is `new
 * Date()` fed into the row's `computedAt` column at write time; every
 * math branch below is in-memory over DB rows pulled upfront. That
 * lets the C2 spec harness feed canned inputs without needing an
 * actual DB connection (see hr-monthly.service.spec.ts).
 *
 * Algorithm (per-day):
 *   1. day standard from CalendarDay row (REGULAR implicit if none)
 *   2. if any AbsenceRecord covers the day → "absence day"
 *        → absence credits sum into weighted; TimeEntry hours IGNORED
 *          for that day (approved rule: "absence wins, no double-credit")
 *        → classify to sickDays / vacationDays by AbsenceType.code
 *        → day does NOT count toward daysOffice/Home/Site
 *   3. otherwise:
 *        → sum TimeEntry.minutes → actualHoursForDay
 *        → apply B·AUTO deduction (eligibility.dailyAmount per active
 *          AUTO-mode B grant) but only if actualHoursForDay > 0
 *          (person didn't work ⇒ no deduction)
 *        → if 0 < actualHoursForDay < HrSettings.minHoursPerDay the
 *          hours still contribute to actualHours but the day does
 *          NOT count toward daysOffice/Home/Site (not a "work day")
 *        → otherwise tally the location of the earliest TimeEntry
 *          (ties broken by createdAt ASC); null location defaults to
 *          daysOffice (safest default per approved rule)
 *   4. monthlyStandard = Σ dayStandard · actualHours = Σ actualHoursForDay
 *      weightedHours = actualHours + Σ absenceCreditForDay
 *      deviation = weightedHours − monthlyStandard
 *
 * sick/vacation classification (approved):
 *   - sick: AbsenceType.code === 'sick' OR AbsenceType.deductsFromSick
 *     (so `special_child_care_day` rolls into the sick ledger per the
 *     seed's `deductsFromSick=true` flag)
 *   - vacation: code ∈ {vacation, holiday_eve_leave, chol_hamoed_leave}
 *   - everything else (reserve_duty, bereavement_1st_degree,
 *     reservist_spouse, user-defined codes): advances neither counter.
 *   - amount: for unit=DAY the raw record.amount (0.5 or 1.0); for
 *     unit=HOUR we add `amount / dayStandard` to the counter so an
 *     HR analyst can still see "approximate sick-days consumed" if
 *     a future AbsenceType ships with hour granularity (today all 8
 *     seeded types are DAY-unit; the formula is forward-compatible).
 *
 * Upsert policy:
 *   - OPEN rows are overwritten.
 *   - APPROVED / LOCKED rows return `{ skipped }` without a throw so a
 *     batch recompute never dies on one approved user.
 *   - On overwrite, status is kept at OPEN; approvedBy / approvedAt are
 *     cleared (any prior approval was already OPEN).
 */
@Injectable()
export class HrMonthlyService {
  private readonly log = new Logger(HrMonthlyService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Public API ────────────────────────────────────────────────────

  /**
   * Compute & upsert one (userId, year, month) row. Returns the row
   * on write, or `{ skipped }` when the existing row is
   * APPROVED/LOCKED (recompute refuses).
   */
  async computeMonth(args: {
    userId: number;
    year: number;
    month: number;
  }): Promise<
    | ComputedMonthlyAttendance
    | { skipped: { reason: 'approved' | 'locked'; existing: ComputedMonthlyAttendance } }
  > {
    const { userId, year, month } = args;

    const existing = await this.prisma.monthlyAttendance.findUnique({
      where: { userId_year_month: { userId, year, month } },
    });
    if (existing && (existing.status === 'APPROVED' || existing.status === 'LOCKED')) {
      return {
        skipped: {
          reason: existing.status === 'APPROVED' ? 'approved' : 'locked',
          existing: decimalRow(existing),
        },
      };
    }

    const inputs = await this.loadInputs(userId, year, month);
    const computed = this.aggregateMonth(inputs);

    const written = await this.prisma.monthlyAttendance.upsert({
      where: { userId_year_month: { userId, year, month } },
      update: {
        monthlyStandard: computed.monthlyStandard,
        actualHours: computed.actualHours,
        weightedHours: computed.weightedHours,
        deviation: computed.deviation,
        sickDays: computed.sickDays,
        vacationDays: computed.vacationDays,
        daysOffice: computed.daysOffice,
        daysHome: computed.daysHome,
        daysSite: computed.daysSite,
        status: MonthlyStatus.OPEN,
        approvedById: null,
        approvedAt: null,
        computedAt: new Date(),
      },
      create: {
        userId,
        year,
        month,
        monthlyStandard: computed.monthlyStandard,
        actualHours: computed.actualHours,
        weightedHours: computed.weightedHours,
        deviation: computed.deviation,
        sickDays: computed.sickDays,
        vacationDays: computed.vacationDays,
        daysOffice: computed.daysOffice,
        daysHome: computed.daysHome,
        daysSite: computed.daysSite,
        status: MonthlyStatus.OPEN,
      },
    });

    return decimalRow(written);
  }

  /**
   * Batch wrapper. Per-user transaction so one bad user doesn't tank
   * the batch (per Phase C spec). Returns the written rows + a list of
   * skipped-with-reason entries.
   */
  async computeMonthForMany(args: {
    userIds: number[];
    year: number;
    month: number;
  }): Promise<{
    computed: ComputedMonthlyAttendance[];
    skipped: Array<{ userId: number; reason: string }>;
  }> {
    const { userIds, year, month } = args;
    const computed: ComputedMonthlyAttendance[] = [];
    const skipped: Array<{ userId: number; reason: string }> = [];

    for (const userId of userIds) {
      try {
        const r = await this.computeMonth({ userId, year, month });
        if ('skipped' in r) {
          skipped.push({ userId, reason: r.skipped.reason });
        } else {
          computed.push(r);
        }
      } catch (e: any) {
        this.log.warn(
          `[hr/monthly] computeMonth(user=${userId}, ${year}-${month}) failed: ${e?.message ?? e}`,
        );
        skipped.push({ userId, reason: `error: ${e?.message ?? 'unknown'}` });
      }
    }
    return { computed, skipped };
  }

  /**
   * Per-day breakdown used by the HR review drawer + the self-service
   * `/time/my-monthly-summary`. Shares the exact engine inputs with
   * `computeMonth`; the day-level rows are what the UI tabulates.
   */
  async getDailyBreakdown(
    userId: number,
    year: number,
    month: number,
  ): Promise<DailyBreakdownRow[]> {
    const inputs = await this.loadInputs(userId, year, month);
    return this.buildDailyRows(inputs);
  }

  // ─── List + fetch ───────────────────────────────────────────────────

  /**
   * HR Phase C3 roster list. Returns every row for the (year, month)
   * joined with the display fields the review table needs
   * (name + accountingEmployeeNumber). Does NOT recompute; callers hit
   * `/hr/monthly/recompute` first.
   */
  async listMonth(year: number, month: number) {
    const rows = await this.prisma.monthlyAttendance.findMany({
      where: { year, month },
      orderBy: [{ user: { lastName: 'asc' } }, { user: { firstName: 'asc' } }],
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            firstNameHe: true,
            lastNameHe: true,
            accountingEmployeeNumber: true,
          },
        },
        approvedBy: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
    return rows.map((r) => ({ ...decimalRow(r), user: r.user, approvedBy: r.approvedBy }));
  }

  /**
   * Row + day-by-day breakdown for the review drawer. If no row has
   * been computed yet, we still return a DRAFT compute so the drawer
   * can render; no row is written.
   */
  async getMonthForUser(userId: number, year: number, month: number) {
    const existing = await this.prisma.monthlyAttendance.findUnique({
      where: { userId_year_month: { userId, year, month } },
      include: {
        approvedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    const dailyBreakdown = await this.getDailyBreakdown(userId, year, month);

    if (existing) {
      return {
        row: { ...decimalRow(existing), approvedBy: existing.approvedBy },
        dailyBreakdown,
      };
    }

    // DRAFT: compute the aggregate in-memory without a write — lets
    // the drawer render immediately for a user whose month hasn't
    // been recomputed yet.
    const inputs = await this.loadInputs(userId, year, month);
    const totals = this.aggregateMonth(inputs);
    return {
      row: {
        id: 0,
        userId,
        year,
        month,
        ...totals,
        status: 'DRAFT' as const,
        approvedById: null,
        approvedBy: null,
        approvedAt: null,
        computedAt: null,
      },
      dailyBreakdown,
    };
  }

  // ─── Approve + reopen ───────────────────────────────────────────────

  async approve(args: {
    userId: number;
    year: number;
    month: number;
    approverId: number;
  }) {
    const row = await this.prisma.monthlyAttendance.findUnique({
      where: {
        userId_year_month: {
          userId: args.userId,
          year: args.year,
          month: args.month,
        },
      },
    });
    if (!row) {
      throw new BadRequestException({
        message:
          'Monthly row not computed yet — click "חישוב מחדש" before approving.',
        code: 'MONTHLY_NOT_YET_COMPUTED',
      });
    }
    if (row.status === 'LOCKED') {
      throw new BadRequestException(
        'Row is LOCKED (post-export) — a locked row cannot be approved.',
      );
    }
    if (row.status === 'APPROVED') {
      // Idempotent — surface the existing row so the FE can refresh.
      return decimalRow(row);
    }
    const updated = await this.prisma.monthlyAttendance.update({
      where: { id: row.id },
      data: {
        status: MonthlyStatus.APPROVED,
        approvedById: args.approverId,
        approvedAt: new Date(),
      },
    });
    return decimalRow(updated);
  }

  /**
   * HR Phase D1 (2026-10-18, §13 optional lock) — flip a month to
   * LOCKED after export. Semantics:
   *   • no row yet → compute first (writes OPEN), then flip to LOCKED
   *   • row APPROVED → lock directly (do NOT recompute; computeMonth
   *     refuses APPROVED/LOCKED and would short-circuit)
   *   • row LOCKED → no-op (idempotent)
   *   • row OPEN → flip to LOCKED
   *
   * We repurpose `approvedBy*` as the locker record because the schema
   * has no dedicated `lockedBy*` columns. This matches the Phase C
   * approve path's audit trail.
   */
  async lockMonth(args: {
    userId: number;
    year: number;
    month: number;
    lockerId: number;
  }): Promise<ComputedMonthlyAttendance> {
    const { userId, year, month, lockerId } = args;

    const existing = await this.prisma.monthlyAttendance.findUnique({
      where: { userId_year_month: { userId, year, month } },
    });

    if (!existing) {
      // No row yet — compute first. computeMonth writes an OPEN row;
      // we then flip it to LOCKED below (two writes, but a fresh row
      // is a rare case for the lock endpoint).
      const r = await this.computeMonth({ userId, year, month });
      if ('skipped' in r) {
        // Shouldn't happen for a fresh row, but tolerate: fall through
        // to a direct lock using the surfaced existing row.
        return this.flipToLocked(r.skipped.existing.id, lockerId);
      }
      return this.flipToLocked(r.id, lockerId);
    }

    if (existing.status === 'LOCKED') {
      // Idempotent: already locked.
      return decimalRow(existing);
    }

    // APPROVED or OPEN — flip directly. computeMonth refuses APPROVED
    // rows (returns `{ skipped }`), so we must NOT recompute here.
    return this.flipToLocked(existing.id, lockerId);
  }

  private async flipToLocked(
    id: number,
    lockerId: number,
  ): Promise<ComputedMonthlyAttendance> {
    const updated = await this.prisma.monthlyAttendance.update({
      where: { id },
      data: {
        status: MonthlyStatus.LOCKED,
        approvedById: lockerId,
        approvedAt: new Date(),
      },
    });
    return decimalRow(updated);
  }

  async reopen(args: { userId: number; year: number; month: number }) {
    const row = await this.prisma.monthlyAttendance.findUnique({
      where: {
        userId_year_month: {
          userId: args.userId,
          year: args.year,
          month: args.month,
        },
      },
    });
    if (!row) {
      throw new NotFoundException('No MonthlyAttendance row to reopen');
    }
    if (row.status === 'LOCKED') {
      throw new BadRequestException(
        'Row is LOCKED — a locked row cannot be reopened without a Phase D export rollback.',
      );
    }
    if (row.status === 'OPEN') return decimalRow(row);
    const updated = await this.prisma.monthlyAttendance.update({
      where: { id: row.id },
      data: {
        status: MonthlyStatus.OPEN,
        approvedById: null,
        approvedAt: null,
      },
    });
    return decimalRow(updated);
  }

  // ─── Self-service summary (/time/my-monthly-summary) ────────────────

  /**
   * HR Phase C3 — self-service: caller's own month row + daily
   * breakdown + their absences in-month + per-C-bucket YTD usage.
   *
   * No `hr:*` guard: this is "the view of my own numbers". Returns a
   * DRAFT compute if no row has been written yet (we never write from
   * this endpoint).
   */
  async getMySummary(userId: number, year: number, month: number) {
    const [{ row, dailyBreakdown }, monthlyAbsences, cBuckets] = await Promise.all([
      this.getMonthForUser(userId, year, month),
      // Absences overlapping the month.
      this.prisma.absenceRecord.findMany({
        where: {
          userId,
          dateFrom: { lt: new Date(year, month, 1) },
          dateTo: { gte: new Date(year, month - 1, 1) },
        },
        include: {
          absenceType: {
            select: { id: true, code: true, nameHe: true, unit: true },
          },
        },
        orderBy: { dateFrom: 'asc' },
      }),
      // Caller-side C-bucket YTD usage: hours reported this YEAR per C-bucket.
      // Aggregated server-side via groupBy so the FE just renders bars.
      this.prisma.timeEntry.groupBy({
        by: ['specialHourBucketId'],
        where: {
          userId,
          deletedAt: null,
          date: {
            gte: new Date(year, 0, 1),
            lt: new Date(year + 1, 0, 1),
          },
          specialHourBucketId: { not: null },
          specialHourBucket: { behavior: 'C' },
        },
        _sum: { minutes: true },
      }),
    ]);

    // Fetch the matching bucket catalog rows so the FE can show the
    // bucket name + maxPerYear next to each counter.
    const bucketIds = cBuckets
      .map((r) => r.specialHourBucketId)
      .filter((id): id is number => id != null);
    const bucketRows = bucketIds.length
      ? await this.prisma.specialHourBucket.findMany({
          where: { id: { in: bucketIds } },
          select: {
            id: true,
            code: true,
            nameHe: true,
            unit: true,
            maxPerYear: true,
            behavior: true,
          },
        })
      : [];

    const cBucketUsage = cBuckets.map((r) => {
      const bucket = bucketRows.find((b) => b.id === r.specialHourBucketId);
      const usedHours = (r._sum.minutes ?? 0) / 60;
      const maxPerYear = bucket?.maxPerYear != null ? Number(bucket.maxPerYear) : null;
      return {
        bucketId: r.specialHourBucketId,
        code: bucket?.code ?? null,
        nameHe: bucket?.nameHe ?? null,
        unit: bucket?.unit ?? null,
        used: round2(usedHours),
        maxPerYear,
        // The UI colors the bar: orange ≥80%, red ≥100%. Server returns
        // the raw used/max so the FE threshold stays in one place.
      };
    });

    return {
      row,
      dailyBreakdown,
      monthlyAbsences: monthlyAbsences.map((a) => ({
        ...a,
        amount: Number(a.amount),
      })),
      cBucketUsage,
    };
  }

  // ─── Engine input loader ───────────────────────────────────────────

  /**
   * Pull every DB row the engine needs for the given month upfront.
   * Kept in one method so the test harness can replace the whole DB
   * side with canned inputs via a jest-mocked PrismaService.
   */
  private async loadInputs(
    userId: number,
    year: number,
    month: number,
  ): Promise<EngineInputs> {
    // Month boundaries, local-midnight. Prisma stores TimeEntry.date as
    // a plain DateTime (callers write it as `new Date(y, m-1, d)`),
    // while `@db.Date` columns (CalendarDay.date, AbsenceRecord.date*,
    // EmployeeBucketEligibility.*Date) land as UTC midnight. We compare
    // the two with date-component equality below (`sameYMD`) so the
    // mismatch never leaks into math.
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 1); // exclusive

    const [user, hrSettings, calendarDays, timeEntries, absenceRecords, eligibilities] =
      await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, dailyStandardHours: true },
        }),
        this.prisma.hrSettings.findUnique({ where: { id: 1 } }),
        this.prisma.calendarDay.findMany({
          where: { date: { gte: monthStart, lt: monthEnd } },
        }),
        this.prisma.timeEntry.findMany({
          where: {
            userId,
            deletedAt: null,
            date: { gte: monthStart, lt: monthEnd },
          },
          orderBy: [{ createdAt: 'asc' }],
        }),
        this.prisma.absenceRecord.findMany({
          where: {
            userId,
            // Overlap: record's [dateFrom, dateTo] intersects the month.
            dateFrom: { lt: monthEnd },
            dateTo: { gte: monthStart },
          },
          include: { absenceType: true },
        }),
        this.prisma.employeeBucketEligibility.findMany({
          where: {
            userId,
            active: true,
            startDate: { lt: monthEnd },
            endDate: { gte: monthStart },
          },
          include: { bucket: true },
        }),
      ]);

    return {
      userId,
      year,
      month,
      dailyStandard: user?.dailyStandardHours != null ? Number(user.dailyStandardHours) : 0,
      hrSettings: {
        shortDayHoursHolidayEve: hrSettings
          ? Number(hrSettings.shortDayHoursHolidayEve)
          : 5,
        shortDayHoursCholHamoed: hrSettings
          ? Number(hrSettings.shortDayHoursCholHamoed)
          : 5,
        minHoursPerDay: hrSettings ? Number(hrSettings.minHoursPerDay) : 5,
      },
      calendarDays: calendarDays.map((c) => ({
        date: c.date,
        type: c.type,
      })),
      timeEntries: timeEntries.map((t) => ({
        id: t.id,
        date: t.date,
        startTime: t.startTime,
        minutes: t.minutes,
        location: t.location,
        createdAt: t.createdAt,
      })),
      absenceRecords: absenceRecords.map((a) => ({
        id: a.id,
        dateFrom: a.dateFrom,
        dateTo: a.dateTo,
        amount: Number(a.amount),
        unit: a.absenceType.unit,
        typeCode: a.absenceType.code,
        deductsFromSick: a.absenceType.deductsFromSick,
      })),
      eligibilities: eligibilities.map((e) => ({
        id: e.id,
        startDate: e.startDate,
        endDate: e.endDate,
        dailyAmount: Number(e.dailyAmount),
        bucketBehavior: e.bucket.behavior,
        resolvedMode: (e.creditMode ?? e.bucket.defaultCreditMode) as BucketCreditMode,
      })),
    };
  }

  // ─── Pure math ─────────────────────────────────────────────────────

  /** The day-by-day engine — returned by `getDailyBreakdown`. */
  private buildDailyRows(inputs: EngineInputs): DailyBreakdownRow[] {
    const daysInMonth = new Date(inputs.year, inputs.month, 0).getDate();
    const rows: DailyBreakdownRow[] = [];

    for (let d = 1; d <= daysInMonth; d += 1) {
      const date = new Date(inputs.year, inputs.month - 1, d);
      rows.push(this.computeDay(inputs, date));
    }
    return rows;
  }

  /** Aggregate the day rows into the monthly roll-up. */
  private aggregateMonth(inputs: EngineInputs): ComputedTotals {
    const days = this.buildDailyRows(inputs);
    const totals: ComputedTotals = {
      monthlyStandard: 0,
      actualHours: 0,
      weightedHours: 0,
      deviation: 0,
      sickDays: 0,
      vacationDays: 0,
      daysOffice: 0,
      daysHome: 0,
      daysSite: 0,
    };

    for (const d of days) {
      totals.monthlyStandard += d.dayStandard;
      totals.actualHours += d.actualHours;
      totals.weightedHours += d.actualHours + d.absenceCredit;
      totals.sickDays += d.sickCredit;
      totals.vacationDays += d.vacationCredit;
      if (d.locationBucket === 'office') totals.daysOffice += 1;
      else if (d.locationBucket === 'home') totals.daysHome += 1;
      else if (d.locationBucket === 'site') totals.daysSite += 1;
    }

    // 2-decimal rounding keeps the engine stable against float noise
    // on the ×60 minute → hour conversion. The DB column is
    // DECIMAL(7,2) so anything past the 2nd place would be truncated
    // on write anyway.
    totals.monthlyStandard = round2(totals.monthlyStandard);
    totals.actualHours = round2(totals.actualHours);
    totals.weightedHours = round2(totals.weightedHours);
    totals.sickDays = round2(totals.sickDays);
    totals.vacationDays = round2(totals.vacationDays);
    totals.deviation = round2(totals.weightedHours - totals.monthlyStandard);
    return totals;
  }

  /**
   * Compute one day. All DB-side rows that cover the given date are
   * considered. No side effects.
   */
  private computeDay(inputs: EngineInputs, date: Date): DailyBreakdownRow {
    const cal = inputs.calendarDays.find((c) => sameYMD(c.date, date));
    const dayType: CalendarDayType = cal?.type ?? CalendarDayType.REGULAR;

    // 1) Base day standard.
    //    HOLIDAY / REST → 0 (person is off; no standard credit either).
    //    HOLIDAY_EVE / CHOL_HAMOED → short-day knob from HrSettings.
    //    REGULAR → user.dailyStandardHours (0 when the user has none).
    let dayStandard = 0;
    if (dayType === CalendarDayType.HOLIDAY_EVE) {
      dayStandard = inputs.hrSettings.shortDayHoursHolidayEve;
    } else if (dayType === CalendarDayType.CHOL_HAMOED) {
      dayStandard = inputs.hrSettings.shortDayHoursCholHamoed;
    } else if (
      dayType === CalendarDayType.REGULAR ||
      // Defensive: a REGULAR row shouldn't exist in the DB (service
      // rejects it), but tolerate one if it ever does.
      !cal
    ) {
      dayStandard = inputs.dailyStandard;
    }
    // HOLIDAY / REST ⇒ dayStandard stays 0.

    // 2) Absence check — "absence day" if ANY AbsenceRecord covers it.
    const coveringAbsences = inputs.absenceRecords.filter(
      (a) => withinInclusive(date, a.dateFrom, a.dateTo),
    );

    // 3a) Absence day — approved rule: absence wins, no double-credit.
    if (coveringAbsences.length > 0) {
      let absenceCredit = 0;
      let sickCredit = 0;
      let vacationCredit = 0;
      for (const a of coveringAbsences) {
        // Per spec §4: unit=DAY credits `amount × dayStandard`; unit=HOUR
        // credits `amount` directly.
        const credit =
          a.unit === AbsenceUnit.DAY ? a.amount * dayStandard : a.amount;
        absenceCredit += credit;

        // Classification: sick vs vacation per approved rule.
        const isSick = a.typeCode === 'sick' || a.deductsFromSick;
        const isVacation =
          a.typeCode === 'vacation' ||
          a.typeCode === 'holiday_eve_leave' ||
          a.typeCode === 'chol_hamoed_leave';

        if (isSick) {
          sickCredit +=
            a.unit === AbsenceUnit.DAY
              ? a.amount
              : // HOUR-unit → convert back to day-fraction using
                // dayStandard so the counter stays comparable. If
                // dayStandard is 0 (HOLIDAY/REST absence day — rare
                // but legal) treat it as 0 so we don't /0.
                dayStandard > 0
                ? a.amount / dayStandard
                : 0;
        } else if (isVacation) {
          vacationCredit +=
            a.unit === AbsenceUnit.DAY
              ? a.amount
              : dayStandard > 0
                ? a.amount / dayStandard
                : 0;
        }
      }

      return {
        date,
        dayType,
        dayStandard,
        actualHours: 0, // TimeEntry on an absence day is intentionally ignored.
        absenceCredit,
        sickCredit,
        vacationCredit,
        locationBucket: null,
        autoDeduction: 0,
      };
    }

    // 3b) Non-absence day.
    const dayEntries = inputs.timeEntries.filter((t) => sameYMD(t.date, date));
    const actualHoursForDay =
      dayEntries.reduce((s, t) => s + t.minutes, 0) / 60;

    // 4) B·AUTO deduction — only when the person actually worked. If
    // they didn't work, no deduction fires (approved rule).
    let autoDeduction = 0;
    if (actualHoursForDay > 0) {
      for (const e of inputs.eligibilities) {
        if (e.bucketBehavior !== 'B') continue;
        if (e.resolvedMode !== BucketCreditMode.AUTO) continue;
        if (!withinInclusive(date, e.startDate, e.endDate)) continue;
        autoDeduction += e.dailyAmount;
      }
    }
    const effectiveStandard = Math.max(0, dayStandard - autoDeduction);

    // 5) Work-day location tally. Sub-min-hours days do NOT count
    //    toward daysOffice/Home/Site (approved rule — the hours still
    //    contribute to actualHours though).
    let locationBucket: 'office' | 'home' | 'site' | null = null;
    if (
      actualHoursForDay >= inputs.hrSettings.minHoursPerDay &&
      dayEntries.length > 0
    ) {
      // "First entry of the day wins": earliest startTime, tiebreak by
      // createdAt ASC (which the DB load already sorted by).
      const picked = pickEarliestEntry(dayEntries);
      locationBucket = normalizeLocation(picked?.location ?? null);
    }

    return {
      date,
      dayType,
      dayStandard: effectiveStandard,
      actualHours: actualHoursForDay,
      absenceCredit: 0,
      sickCredit: 0,
      vacationCredit: 0,
      locationBucket,
      autoDeduction,
    };
  }
}

// ─── Types ───────────────────────────────────────────────────────────

export interface DailyBreakdownRow {
  date: Date;
  dayType: CalendarDayType;
  dayStandard: number;
  actualHours: number;
  absenceCredit: number;
  sickCredit: number;
  vacationCredit: number;
  locationBucket: 'office' | 'home' | 'site' | null;
  autoDeduction: number;
}

export interface ComputedMonthlyAttendance {
  id: number;
  userId: number;
  year: number;
  month: number;
  monthlyStandard: number;
  actualHours: number;
  weightedHours: number;
  deviation: number;
  sickDays: number;
  vacationDays: number;
  daysOffice: number;
  daysHome: number;
  daysSite: number;
  status: MonthlyStatus;
  approvedById: number | null;
  approvedAt: Date | null;
  computedAt: Date;
}

interface ComputedTotals {
  monthlyStandard: number;
  actualHours: number;
  weightedHours: number;
  deviation: number;
  sickDays: number;
  vacationDays: number;
  daysOffice: number;
  daysHome: number;
  daysSite: number;
}

interface EngineInputs {
  userId: number;
  year: number;
  month: number;
  dailyStandard: number;
  hrSettings: {
    shortDayHoursHolidayEve: number;
    shortDayHoursCholHamoed: number;
    minHoursPerDay: number;
  };
  calendarDays: Array<{ date: Date; type: CalendarDayType }>;
  timeEntries: Array<{
    id: number;
    date: Date;
    startTime: string | null;
    minutes: number;
    location: string | null;
    createdAt: Date;
  }>;
  absenceRecords: Array<{
    id: number;
    dateFrom: Date;
    dateTo: Date;
    amount: number;
    unit: AbsenceUnit;
    typeCode: string;
    deductsFromSick: boolean;
  }>;
  eligibilities: Array<{
    id: number;
    startDate: Date;
    endDate: Date;
    dailyAmount: number;
    bucketBehavior: 'A' | 'B' | 'C';
    resolvedMode: BucketCreditMode;
  }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Hours → 2-decimal rounded number. Shields against float accumulation. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Date-component equality — Y/M/D only, independent of hours / tz. */
function sameYMD(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Inclusive "date in [from, to]" check at day granularity. */
function withinInclusive(date: Date, from: Date, to: Date): boolean {
  const d = ymdInt(date);
  return d >= ymdInt(from) && d <= ymdInt(to);
}

function ymdInt(d: Date): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/**
 * "First entry of the day wins". Sort by startTime ("HH:MM" string;
 * lexicographic compare matches numeric compare for the valid 00-23
 * window). Null startTime falls to the end so a timed entry always
 * wins over a day-level ambient row.
 */
function pickEarliestEntry<
  T extends { startTime: string | null; createdAt: Date },
>(entries: T[]): T | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => {
    const as = a.startTime ?? '~'; // '~' > any 'HH:MM'
    const bs = b.startTime ?? '~';
    if (as !== bs) return as < bs ? -1 : 1;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return sorted[0];
}

/**
 * Clamp the free-form `location` string to one of {office, home,
 * site}. Null / unknown → 'office' per approved rule (safest default
 * — a work-day row never gets lost from the roll-up).
 */
function normalizeLocation(
  raw: string | null,
): 'office' | 'home' | 'site' {
  const v = (raw ?? '').toLowerCase();
  if (v === 'home') return 'home';
  if (v === 'site') return 'site';
  if (v === 'office') return 'office';
  return 'office';
}

/** Prisma Decimal column → plain number for the output DTO. */
function decimalRow(row: Prisma.MonthlyAttendanceGetPayload<{}>): ComputedMonthlyAttendance {
  return {
    id: row.id,
    userId: row.userId,
    year: row.year,
    month: row.month,
    monthlyStandard: Number(row.monthlyStandard),
    actualHours: Number(row.actualHours),
    weightedHours: Number(row.weightedHours),
    deviation: Number(row.deviation),
    sickDays: Number(row.sickDays),
    vacationDays: Number(row.vacationDays),
    daysOffice: row.daysOffice,
    daysHome: row.daysHome,
    daysSite: row.daysSite,
    status: row.status,
    approvedById: row.approvedById,
    approvedAt: row.approvedAt,
    computedAt: row.computedAt,
  };
}
