import { Test } from '@nestjs/testing';

import { HrMonthlyService } from './hr-monthly.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * HR Phase C2 (2026-10-16) — the 8 approved spec cases for the monthly
 * engine. These test the pure math branches of `HrMonthlyService` via
 * a jest-mocked PrismaService — no DB needed.
 *
 * Each test calls `computeMonth`, which pulls six query results and
 * then upserts the row. The mock controls all six; the test asserts on
 * the `upsert.update` payload (or `create`, depending on whether the
 * mock pretends a prior row exists). All 8 lock the engine against
 * silent regressions documented in docs/bm2/planwise-hr-module-spec.md
 * §4 and the Phase C work order.
 */
describe('HrMonthlyService — monthly engine (HR §4 / Phase C2)', () => {
  let service: HrMonthlyService;

  // Mutable mock state — reassigned in each `beforeEach`.
  let prisma: {
    user: { findUnique: jest.Mock };
    hrSettings: { findUnique: jest.Mock };
    calendarDay: { findMany: jest.Mock };
    timeEntry: { findMany: jest.Mock };
    absenceRecord: { findMany: jest.Mock };
    employeeBucketEligibility: { findMany: jest.Mock };
    monthlyAttendance: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
    };
  };

  const USER_ID = 42;
  // Pick a known month: October 2026 — 22 Sun→Thu working days in the
  // standard Israeli work-week, 0 by default under our engine (we don't
  // skip weekends; the test cases set the TimeEntries explicitly on
  // the exact days we want to count).
  const YEAR = 2026;
  const MONTH = 10;

  // The engine's row-ingest reads `TimeEntry.date` + `createdAt`, so the
  // factory stamps both. We don't exercise overlap / tz branches here —
  // the service's `sameYMD` compares by Y/M/D only.
  function te(
    day: number,
    opts: Partial<{
      startTime: string | null;
      minutes: number;
      location: string | null;
      createdAt: Date;
    }> = {},
  ) {
    return {
      id: day,
      date: new Date(YEAR, MONTH - 1, day),
      startTime: opts.startTime ?? '09:00',
      minutes: opts.minutes ?? 60 * 8.4, // 504 min = 8.4h
      location: opts.location ?? 'office',
      createdAt: opts.createdAt ?? new Date(YEAR, MONTH - 1, day, 9, 0, 0),
    };
  }

  function absence(
    typeCode: string,
    dateFrom: Date,
    dateTo: Date,
    amount: number,
    opts: Partial<{ unit: 'DAY' | 'HOUR'; deductsFromSick: boolean }> = {},
  ) {
    return {
      id: typeCode + dateFrom.toISOString(),
      dateFrom,
      dateTo,
      amount,
      absenceType: {
        code: typeCode,
        unit: opts.unit ?? 'DAY',
        deductsFromSick: opts.deductsFromSick ?? false,
      },
    };
  }

  function elig(
    behavior: 'A' | 'B' | 'C',
    dailyAmount: number,
    mode: 'REPORTED' | 'AUTO' | null,
    defaultMode: 'REPORTED' | 'AUTO' = 'REPORTED',
  ) {
    return {
      id: 1,
      startDate: new Date(YEAR, 0, 1),
      endDate: new Date(YEAR, 11, 31),
      dailyAmount,
      creditMode: mode,
      bucket: { behavior, defaultCreditMode: defaultMode },
    };
  }

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: USER_ID, dailyStandardHours: 8.4 }),
      },
      hrSettings: {
        findUnique: jest.fn().mockResolvedValue({
          // HR Wave 2 G2 (2026-10-19) — shortDayHours* keys dropped
          // from HrSettings. Per-day working hours now live on
          // CalendarDay.workingHours; tests that need HOLIDAY_EVE /
          // CHOL_HAMOED math include `workingHours: 5` on the row.
          minHoursPerDay: 5,
          // HR F3a (2026-10-19) — Tests 1–8 pre-date the weekly-rest
          // feature and assert on 31 implicit REGULAR days (no
          // weekend subtraction). Default this mock to `[]` so those
          // tests keep passing on their original math; the real-DB
          // default is `[5, 6]` (seeded by the F3a migration) and
          // Test 9 overrides this to exercise every branch.
          weeklyRestDays: [],
        }),
      },
      calendarDay: { findMany: jest.fn().mockResolvedValue([]) },
      timeEntry: { findMany: jest.fn().mockResolvedValue([]) },
      absenceRecord: { findMany: jest.fn().mockResolvedValue([]) },
      employeeBucketEligibility: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      monthlyAttendance: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockImplementation(({ create }: any) => ({
          id: 1,
          ...create,
          approvedById: null,
          approvedAt: null,
          computedAt: new Date(),
        })),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        HrMonthlyService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(HrMonthlyService);
  });

  function upsertCreateData(): any {
    expect(prisma.monthlyAttendance.upsert).toHaveBeenCalledTimes(1);
    return prisma.monthlyAttendance.upsert.mock.calls[0][0].create;
  }

  // ─── Test 1 ─────────────────────────────────────────────────────────
  it('full REGULAR month at 8.4 h/day', async () => {
    // 22 working days laid down on Oct 4-11,14-18,21-25,28,29. Pick
    // any 22 distinct days; the engine doesn't care which 22.
    const workDays = Array.from({ length: 22 }, (_, i) => i + 1); // days 1..22
    prisma.timeEntry.findMany.mockResolvedValue(
      workDays.map((d) => te(d)),
    );

    await service.computeMonth({ userId: USER_ID, year: YEAR, month: MONTH });

    const data = upsertCreateData();
    // 31 REGULAR days × 8.4 standard = 260.4
    expect(data.monthlyStandard).toBeCloseTo(260.4, 2);
    expect(data.actualHours).toBeCloseTo(184.8, 2);
    expect(data.weightedHours).toBeCloseTo(184.8, 2);
    // deviation = weighted - standard. Standard counts every REGULAR
    // day because dailyStandardHours is per CALENDAR day in our model.
    expect(data.deviation).toBeCloseTo(184.8 - 260.4, 2);
  });

  // ─── Test 2 ─────────────────────────────────────────────────────────
  it('holiday-eve + chol-hamoed at 5h adjust the day-standard', async () => {
    const holidayEve = new Date(YEAR, MONTH - 1, 2);
    const cholHamoed = new Date(YEAR, MONTH - 1, 3);
    prisma.calendarDay.findMany.mockResolvedValue([
      { date: holidayEve, type: 'HOLIDAY_EVE', workingHours: 5 },
      { date: cholHamoed, type: 'CHOL_HAMOED', workingHours: 5 },
    ]);
    // No time entries — we only assert on monthlyStandard.
    await service.computeMonth({ userId: USER_ID, year: YEAR, month: MONTH });
    const data = upsertCreateData();

    // 29 REGULAR days × 8.4 + 2 short days × 5h = 243.6 + 10 = 253.6
    expect(data.monthlyStandard).toBeCloseTo(29 * 8.4 + 2 * 5, 2);
  });

  // ─── Test 3 ─────────────────────────────────────────────────────────
  it('B·AUTO deducts only on worked days, not on vacation or HOLIDAY', async () => {
    // Set up: 10 worked days, 5 vacation days (code=vacation), 1 HOLIDAY.
    const workDays = [1, 2, 5, 6, 7, 8, 9, 12, 13, 14];
    const vacationStart = new Date(YEAR, MONTH - 1, 15);
    const vacationEnd = new Date(YEAR, MONTH - 1, 19);
    const holiday = new Date(YEAR, MONTH - 1, 22);

    prisma.timeEntry.findMany.mockResolvedValue(workDays.map((d) => te(d)));
    prisma.calendarDay.findMany.mockResolvedValue([
      { date: holiday, type: 'HOLIDAY', workingHours: 0 },
    ]);
    prisma.absenceRecord.findMany.mockResolvedValue([
      absence('vacation', vacationStart, vacationEnd, 1),
    ]);
    prisma.employeeBucketEligibility.findMany.mockResolvedValue([
      elig('B', 1, 'AUTO'), // deducts 1 hour per worked day
    ]);

    await service.computeMonth({ userId: USER_ID, year: YEAR, month: MONTH });
    const data = upsertCreateData();

    // Standard without AUTO: 30 REGULAR × 8.4 + 1 HOLIDAY × 0 = 252
    // AUTO deducts 1h × 10 worked days = 10
    // Final monthlyStandard = 252 - 10 = 242
    //
    // Not reduced for the 5 vacation days (person didn't work) nor for
    // the 1 HOLIDAY (also didn't work).
    expect(data.monthlyStandard).toBeCloseTo(252 - 10, 2);
  });

  // ─── Test 4 ─────────────────────────────────────────────────────────
  it('B·REPORTED counted in actualHours; standard unchanged', async () => {
    // User reports a 1h bucket entry on 5 days.
    const reportDays = [1, 2, 3, 4, 7];
    prisma.timeEntry.findMany.mockResolvedValue(
      reportDays.map((d) => te(d, { minutes: 60 })),
    );
    prisma.employeeBucketEligibility.findMany.mockResolvedValue([
      elig('B', 1, 'REPORTED'),
    ]);

    await service.computeMonth({ userId: USER_ID, year: YEAR, month: MONTH });
    const data = upsertCreateData();

    // No AUTO → standard not reduced. 31 REGULAR × 8.4 = 260.4
    expect(data.monthlyStandard).toBeCloseTo(31 * 8.4, 2);
    // 5 × 1h = 5h actual
    expect(data.actualHours).toBeCloseTo(5, 2);
  });

  // ─── Test 5 ─────────────────────────────────────────────────────────
  it('half-day absence on HOLIDAY_EVE credits 0.5 × 5 = 2.5', async () => {
    const dateStr = new Date(YEAR, MONTH - 1, 2);
    prisma.calendarDay.findMany.mockResolvedValue([
      { date: dateStr, type: 'HOLIDAY_EVE', workingHours: 5 },
    ]);
    prisma.absenceRecord.findMany.mockResolvedValue([
      absence('holiday_eve_leave', dateStr, dateStr, 0.5),
    ]);

    await service.computeMonth({ userId: USER_ID, year: YEAR, month: MONTH });
    const data = upsertCreateData();

    // Monthly standard: 30 REGULAR × 8.4 + 1 HOLIDAY_EVE × 5 = 257
    expect(data.monthlyStandard).toBeCloseTo(30 * 8.4 + 5, 2);
    // Absence contributes 0.5 × 5 = 2.5 to weighted
    expect(data.actualHours).toBeCloseTo(0, 2);
    expect(data.weightedHours).toBeCloseTo(2.5, 2);
    // vacation_eve_leave classifies to vacation
    expect(data.vacationDays).toBeCloseTo(0.5, 2);
    expect(data.sickDays).toBeCloseTo(0, 2);
  });

  // ─── Test 6 ─────────────────────────────────────────────────────────
  it('bereavement 7-day span credits every day at REGULAR standard', async () => {
    // Oct 11 2026 is a Sunday — our engine does not know "weekend", so
    // a 7-day span lands on 7 REGULAR calendar days (no CalendarDay
    // rows exist for Fri/Sat, which is how AMEC runs the Israeli
    // week: Sun-Thu is the work week; weekends are implicit REGULAR
    // in the DB and we treat them that way per spec).
    const from = new Date(YEAR, MONTH - 1, 11); // Sun
    const to = new Date(YEAR, MONTH - 1, 17); // Sat (7 days inclusive)

    prisma.absenceRecord.findMany.mockResolvedValue([
      absence('bereavement_1st_degree', from, to, 1),
    ]);

    await service.computeMonth({ userId: USER_ID, year: YEAR, month: MONTH });
    const data = upsertCreateData();

    // Weighted = 7 days × 8.4 (dayStandard for each REGULAR implicit
    // day) × 1 (amount) = 58.8
    expect(data.weightedHours).toBeCloseTo(7 * 8.4, 2);
    // Classification: bereavement is neither sick nor vacation
    expect(data.sickDays).toBeCloseTo(0, 2);
    expect(data.vacationDays).toBeCloseTo(0, 2);
  });

  // ─── Test 7 ─────────────────────────────────────────────────────────
  it('sub-min-hours day: hours counted but no location tally', async () => {
    // Single day with 3h entry, min = 5
    prisma.timeEntry.findMany.mockResolvedValue([
      te(1, { minutes: 180, location: 'office' }),
    ]);

    await service.computeMonth({ userId: USER_ID, year: YEAR, month: MONTH });
    const data = upsertCreateData();

    expect(data.actualHours).toBeCloseTo(3, 2);
    // The day does NOT count toward daysOffice (3h < 5h min)
    expect(data.daysOffice).toBe(0);
    expect(data.daysHome).toBe(0);
    expect(data.daysSite).toBe(0);
  });

  // ─── Test 8 ─────────────────────────────────────────────────────────
  it('no double-credit: AbsenceRecord + TimeEntry on same day → absence wins', async () => {
    const day = new Date(YEAR, MONTH - 1, 5);
    prisma.timeEntry.findMany.mockResolvedValue([
      te(5, { minutes: 360, location: 'office' }), // 6h would normally count
    ]);
    prisma.absenceRecord.findMany.mockResolvedValue([
      absence('vacation', day, day, 1),
    ]);

    await service.computeMonth({ userId: USER_ID, year: YEAR, month: MONTH });
    const data = upsertCreateData();

    // Absence wins: actualHours for this day is 0, weighted gets the
    // full-day credit (1 × 8.4 = 8.4), vacationDays += 1.
    expect(data.actualHours).toBeCloseTo(0, 2);
    expect(data.weightedHours).toBeCloseTo(8.4, 2);
    expect(data.vacationDays).toBeCloseTo(1, 2);
    expect(data.sickDays).toBeCloseTo(0, 2);
    // And the day does NOT appear in daysOffice (absence day).
    expect(data.daysOffice).toBe(0);
  });

  // ─── Test 8b — HR F7 (2026-10-19) ────────────────────────────────────
  // vacation_unpaid (חל"ת) must classify to vacationDays just like the
  // paid `vacation` code — the engine treats paid/unpaid identically;
  // the distinction is a payroll concern surfaced on the reports page
  // by AbsenceType.nameHe.
  it('F7: vacation_unpaid (חל"ת) classifies to vacationDays like vacation', async () => {
    const day = new Date(YEAR, MONTH - 1, 6);
    prisma.absenceRecord.findMany.mockResolvedValue([
      absence('vacation_unpaid', day, day, 1),
    ]);

    await service.computeMonth({ userId: USER_ID, year: YEAR, month: MONTH });
    const data = upsertCreateData();

    // Same math as a 1-day `vacation`: full-day credit (1 × 8.4) +
    // vacationDays += 1, sickDays untouched.
    expect(data.weightedHours).toBeCloseTo(8.4, 2);
    expect(data.vacationDays).toBeCloseTo(1, 2);
    expect(data.sickDays).toBeCloseTo(0, 2);
  });

  // ─── Test 9 — HR F3a (2026-10-19) ────────────────────────────────────
  // Weekly rest days exclude Fri+Sat from monthly standard. Dates with no
  // CalendarDay row AND whose JS `Date.getDay()` falls in
  // `HrSettings.weeklyRestDays` are treated as implicit REST (dayStandard
  // = 0). A materialized CalendarDay row still wins.
  describe('F3a — HrSettings.weeklyRestDays excludes weekly rest from standard', () => {
    // October 2026 Day-of-Week breakdown (JS Date.getDay(), Sun=0):
    //   Fridays (dow=5):   2, 9, 16, 23, 30   → 5 days
    //   Saturdays (dow=6): 3, 10, 17, 24, 31  → 5 days
    //   Sundays (dow=0):   4, 11, 18, 25      → 4 days
    //   Working (Sun-Thu): 31 − 10 Fri/Sat    = 21 days

    it('default [5, 6] (Fri + Sat): standard = 21 × 8.4 for Oct 2026', async () => {
      prisma.hrSettings.findUnique.mockResolvedValue({
        minHoursPerDay: 5,
        weeklyRestDays: [5, 6],
      });

      await service.computeMonth({ userId: USER_ID, year: YEAR, month: MONTH });
      const data = upsertCreateData();

      // 5 Fri + 5 Sat = 10 implicit REST days at 0h; remaining 21 days
      // × 8.4 = 176.4. monthlyStandard excludes the weekend.
      expect(data.monthlyStandard).toBeCloseTo(21 * 8.4, 2);
    });

    it('empty [] (7-day work week): standard = 31 × 8.4', async () => {
      prisma.hrSettings.findUnique.mockResolvedValue({
        minHoursPerDay: 5,
        weeklyRestDays: [],
      });

      await service.computeMonth({ userId: USER_ID, year: YEAR, month: MONTH });
      const data = upsertCreateData();

      // Every day of the week counts as REGULAR — matches Tests 1-8's
      // historical default. 31 × 8.4 = 260.4.
      expect(data.monthlyStandard).toBeCloseTo(31 * 8.4, 2);
    });

    it('Sunday only [0] (some orgs): standard excludes 4 Sundays for Oct 2026', async () => {
      prisma.hrSettings.findUnique.mockResolvedValue({
        minHoursPerDay: 5,
        weeklyRestDays: [0],
      });

      await service.computeMonth({ userId: USER_ID, year: YEAR, month: MONTH });
      const data = upsertCreateData();

      // 4 Sundays in Oct 2026 at 0h; remaining 27 days × 8.4 = 226.8.
      expect(data.monthlyStandard).toBeCloseTo(27 * 8.4, 2);
    });

    it('explicit CalendarDay row overrides implicit weekly rest', async () => {
      // Admin materialized a HOLIDAY_EVE row on a Friday (Oct 2, dow=5).
      // Expected: that Fri counts as 5h (HOLIDAY_EVE short-day), NOT 0
      // (would be the case if weekly rest overrode CalendarDay rows).
      const friday = new Date(YEAR, MONTH - 1, 2);
      prisma.calendarDay.findMany.mockResolvedValue([
        { date: friday, type: 'HOLIDAY_EVE', workingHours: 5 },
      ]);
      prisma.hrSettings.findUnique.mockResolvedValue({
        minHoursPerDay: 5,
        weeklyRestDays: [5, 6],
      });

      await service.computeMonth({ userId: USER_ID, year: YEAR, month: MONTH });
      const data = upsertCreateData();

      // 21 implicit REGULAR Sun-Thu × 8.4
      //  + 4 implicit-rest Fri (Oct 9, 16, 23, 30) × 0
      //  + 5 implicit-rest Sat × 0
      //  + 1 explicit HOLIDAY_EVE on Fri Oct 2 × 5
      //  = 176.4 + 0 + 0 + 5 = 181.4
      expect(data.monthlyStandard).toBeCloseTo(21 * 8.4 + 5, 2);
    });
  });
});
