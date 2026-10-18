/**
 * HR Phase D3 (2026-10-18) — standalone demo-data seeder per
 * docs/bm2/planwise-hr-module-spec.md §13.
 *
 * This is NOT part of `prisma seed` / `seed.ts` / `seed-runner.js`.
 * It is invoked manually on staging/dev to lay down a thin slice of
 * fixtures that exercise the HR module end-to-end:
 *
 *   - 3 demo employees (emails prefix `demo.hr`) with varied
 *     accountingEmployeeNumber (including null → null-sort test) and
 *     varied dailyStandardHours.
 *   - TimeEntry rows across the current month (weekday only) including
 *     a short-day edge case and an HOLIDAY_EVE short-day.
 *   - AbsenceRecord rows (sick + half-day vacation).
 *   - EmployeeBucketEligibility rows (REPORTED + AUTO modes).
 *   - CalendarDay rows (HOLIDAY_EVE + HOLIDAY) tagged `notes='[demo-hr]'`
 *     so the companion `seed-hr-demo-clean.ts` can scrub them precisely.
 *   - MonthlyAttendance recompute via HrMonthlyService for the three
 *     demo users.
 *
 * Idempotent — re-running is a no-op (upserts users on email; nukes +
 * re-inserts the children keyed on the demo user ids). The prod-guard
 * at the top bails before touching anything if NODE_ENV=production or
 * DATABASE_URL smells like a prod URL.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

import { HrMonthlyService } from '../src/modules/hr/hr-monthly.service';

// ─── Prod guard (MANDATORY — bail if any smell of prod) ────────────
if (process.env.NODE_ENV === 'production') {
  // eslint-disable-next-line no-console
  console.error(
    '[seed-hr-demo] refuses to run with NODE_ENV=production.',
  );
  process.exit(1);
}
const dbUrl = process.env.DATABASE_URL || '';
if (/\bprod\b/i.test(dbUrl) || /production/i.test(dbUrl)) {
  // eslint-disable-next-line no-console
  console.error(
    '[seed-hr-demo] refuses to run — DATABASE_URL contains "prod" or "production".',
  );
  process.exit(1);
}

const prisma = new PrismaClient();

// ─── Config (override at the top of the file as needed) ────────────
const TARGET_YEAR = new Date().getFullYear();
const TARGET_MONTH = new Date().getMonth() + 1; // 1..12

// Mid-month fixed days used across the fixtures. Days 14/15 always
// exist in every real-world month so no edge-handling needed.
const HOLIDAY_EVE_DAY = 14;
const HOLIDAY_DAY = 15;
const SHORT_DAY = 10;

const DEMO_PASSWORD_PLAIN = 'DemoHr@2026';
const DEMO_EMAIL_SUFFIX = '@maimoni.local';
const DEMO_CAL_NOTE = '[demo-hr]';

type DemoSpec = {
  key: 'hr1' | 'hr2' | 'hr3';
  email: string;
  firstName: string;
  lastName: string;
  firstNameHe: string;
  lastNameHe: string;
  dailyStandardHours: number;
  accountingEmployeeNumber: string | null;
};

const DEMO_USERS: DemoSpec[] = [
  {
    key: 'hr1',
    email: `demo.hr1${DEMO_EMAIL_SUFFIX}`,
    firstName: 'Alex',
    lastName: 'Demo-One',
    firstNameHe: 'אלכס',
    lastNameHe: 'דמו-אחד',
    dailyStandardHours: 8.4,
    accountingEmployeeNumber: '1001',
  },
  {
    key: 'hr2',
    email: `demo.hr2${DEMO_EMAIL_SUFFIX}`,
    firstName: 'Beth',
    lastName: 'Demo-Two',
    firstNameHe: 'בת',
    lastNameHe: 'דמו-שתיים',
    dailyStandardHours: 7,
    accountingEmployeeNumber: '1002',
  },
  {
    key: 'hr3',
    email: `demo.hr3${DEMO_EMAIL_SUFFIX}`,
    firstName: 'Carl',
    lastName: 'Demo-Three',
    firstNameHe: 'קארל',
    lastNameHe: 'דמו-שלוש',
    dailyStandardHours: 6,
    accountingEmployeeNumber: null,
  },
];

// Rotating location mix for TimeEntry — matches §13's "mix home/office/site".
const LOCATION_ROTATION = ['office', 'home', 'site', 'office', 'office'] as const;

// ─── Helpers ───────────────────────────────────────────────────────

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function hoursToEndTime(startHHmm: string, hours: number): string {
  const [sh, sm] = startHHmm.split(':').map((x) => parseInt(x, 10));
  const totalMins = sh * 60 + sm + Math.round(hours * 60);
  const eh = Math.floor(totalMins / 60) % 24;
  const em = totalMins % 60;
  return `${pad2(eh)}:${pad2(em)}`;
}

function dateUtc(year: number, month1: number, day: number): Date {
  // Use UTC midnight so Prisma writes the exact calendar date into @db.Date
  // regardless of the host timezone. Matches the engine's own date math.
  return new Date(Date.UTC(year, month1 - 1, day));
}

function lastDayOfMonth(year: number, month1: number): number {
  // new Date(y, m, 0) → last day of month m (1-based) in local time; we
  // only need the day number so timezone doesn't matter.
  return new Date(year, month1, 0).getDate();
}

function isWeekday(year: number, month1: number, day: number): boolean {
  // Sun-Thu are workdays in Israel. Fri=5, Sat=6 in JS getDay() (0=Sun).
  const dow = new Date(year, month1 - 1, day).getDay();
  return dow !== 5 && dow !== 6;
}

function hoursForDay(dailyStd: number, day: number): number {
  if (day === HOLIDAY_DAY) return 0; // off
  if (day === HOLIDAY_EVE_DAY) return 5; // short-day HOLIDAY_EVE
  if (day === SHORT_DAY) return 4; // explicit <5h edge case for all employees
  return dailyStd;
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  const monthLabel = `${TARGET_YEAR}-${pad2(TARGET_MONTH)}`;
  // eslint-disable-next-line no-console
  console.log(`[seed-hr-demo] seeding demo HR data for ${monthLabel} ...`);

  // 1) Role lookup — prefer Employee, fall back to any role.
  const employeeRole = await prisma.role.findFirst({
    where: { name: 'Employee' },
  });
  const fallbackRole = employeeRole
    ? employeeRole
    : await prisma.role.findFirst();
  if (!fallbackRole) {
    throw new Error(
      '[seed-hr-demo] no Role rows found — run `pnpm prisma:seed` first.',
    );
  }
  if (!employeeRole) {
    // eslint-disable-next-line no-console
    console.warn(
      `[seed-hr-demo] "Employee" role not found; using role "${fallbackRole.name}" (id=${fallbackRole.id}).`,
    );
  }
  const roleId = fallbackRole.id;

  // 2) Admin user (for createdBy / createdById fields). Fall back to first demo user after we create them.
  const adminRole = await prisma.role.findFirst({ where: { name: 'Admin' } });
  const adminUser = adminRole
    ? await prisma.user.findFirst({ where: { roleId: adminRole.id, isActive: true } })
    : null;

  // 3) Upsert the 3 demo users.
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD_PLAIN, 10);
  const createdUsers: Record<DemoSpec['key'], number> = { hr1: 0, hr2: 0, hr3: 0 };

  for (const spec of DEMO_USERS) {
    const mutable = {
      firstName: spec.firstName,
      lastName: spec.lastName,
      firstNameHe: spec.firstNameHe,
      lastNameHe: spec.lastNameHe,
      roleId,
      userType: 'employee' as const,
      isActive: true,
      employmentType: 'GLOBAL' as const,
      dailyStandardHours: spec.dailyStandardHours,
      accountingEmployeeNumber: spec.accountingEmployeeNumber,
      password: passwordHash,
    };
    const user = await prisma.user.upsert({
      where: { email: spec.email },
      create: { email: spec.email, ...mutable },
      update: mutable,
    });
    createdUsers[spec.key] = user.id;
  }

  const demoIds = [createdUsers.hr1, createdUsers.hr2, createdUsers.hr3];
  const createdById = adminUser?.id ?? createdUsers.hr1;

  // 4) CalendarDay rows for HOLIDAY_EVE + HOLIDAY in the target month.
  //    Upsert on `date` unique → idempotent. Tagged `notes='[demo-hr]'`
  //    so the clean script can target them precisely.
  const calDaysSpecs = [
    {
      date: dateUtc(TARGET_YEAR, TARGET_MONTH, HOLIDAY_EVE_DAY),
      name: 'ערב חג דמה',
      type: 'HOLIDAY_EVE' as const,
    },
    {
      date: dateUtc(TARGET_YEAR, TARGET_MONTH, HOLIDAY_DAY),
      name: 'חג דמה',
      type: 'HOLIDAY' as const,
    },
  ];
  let calDaysWritten = 0;
  for (const c of calDaysSpecs) {
    await prisma.calendarDay.upsert({
      where: { date: c.date },
      create: {
        date: c.date,
        name: c.name,
        type: c.type,
        appliesTo: 'all',
        notes: DEMO_CAL_NOTE,
        createdBy: createdById,
      },
      update: {
        name: c.name,
        type: c.type,
        appliesTo: 'all',
        notes: DEMO_CAL_NOTE,
      },
    });
    calDaysWritten += 1;
  }

  // 5) TimeEntry — nuke the window for demo users, then re-insert.
  const monthStart = dateUtc(TARGET_YEAR, TARGET_MONTH, 1);
  const nextMonth = TARGET_MONTH === 12 ? 1 : TARGET_MONTH + 1;
  const nextYear = TARGET_MONTH === 12 ? TARGET_YEAR + 1 : TARGET_YEAR;
  const monthEnd = dateUtc(nextYear, nextMonth, 1);

  await prisma.timeEntry.deleteMany({
    where: {
      userId: { in: demoIds },
      date: { gte: monthStart, lt: monthEnd },
    },
  });

  const timeEntryRows: Array<{
    userId: number;
    date: Date;
    startTime: string;
    endTime: string;
    minutes: number;
    location: string;
  }> = [];
  const lastDay = lastDayOfMonth(TARGET_YEAR, TARGET_MONTH);
  let locIdx = 0;
  for (const spec of DEMO_USERS) {
    const userId = createdUsers[spec.key];
    for (let d = 1; d <= lastDay; d += 1) {
      if (!isWeekday(TARGET_YEAR, TARGET_MONTH, d)) continue;
      const hours = hoursForDay(spec.dailyStandardHours, d);
      if (hours <= 0) continue;
      const startTime = '09:00';
      const endTime = hoursToEndTime(startTime, hours);
      const location = LOCATION_ROTATION[locIdx % LOCATION_ROTATION.length];
      locIdx += 1;
      timeEntryRows.push({
        userId,
        date: dateUtc(TARGET_YEAR, TARGET_MONTH, d),
        startTime,
        endTime,
        minutes: Math.round(hours * 60),
        location,
      });
    }
  }
  if (timeEntryRows.length > 0) {
    await prisma.timeEntry.createMany({ data: timeEntryRows });
  }

  // 6) AbsenceRecord — nuke the window for demo users, then re-insert.
  await prisma.absenceRecord.deleteMany({
    where: {
      userId: { in: demoIds },
      dateFrom: { gte: monthStart, lt: monthEnd },
    },
  });

  const sickType = await prisma.absenceType.findUnique({ where: { code: 'sick' } });
  const vacationType = await prisma.absenceType.findUnique({
    where: { code: 'vacation' },
  });
  const absenceRows: Array<{
    userId: number;
    absenceTypeId: number;
    dateFrom: Date;
    dateTo: Date;
    amount: number;
    createdById: number;
  }> = [];
  if (sickType) {
    absenceRows.push({
      userId: createdUsers.hr1,
      absenceTypeId: sickType.id,
      dateFrom: dateUtc(TARGET_YEAR, TARGET_MONTH, 8),
      dateTo: dateUtc(TARGET_YEAR, TARGET_MONTH, 8),
      amount: 1,
      createdById,
    });
  } else {
    // eslint-disable-next-line no-console
    console.warn('[seed-hr-demo] AbsenceType code=sick not found; skipping sick row.');
  }
  if (vacationType) {
    absenceRows.push({
      userId: createdUsers.hr1,
      absenceTypeId: vacationType.id,
      dateFrom: dateUtc(TARGET_YEAR, TARGET_MONTH, HOLIDAY_EVE_DAY),
      dateTo: dateUtc(TARGET_YEAR, TARGET_MONTH, HOLIDAY_EVE_DAY),
      amount: 0.5,
      createdById,
    });
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      '[seed-hr-demo] AbsenceType code=vacation not found; skipping vacation row.',
    );
  }
  if (absenceRows.length > 0) {
    await prisma.absenceRecord.createMany({ data: absenceRows });
  }

  // 7) EmployeeBucketEligibility — delete all for demo users, re-insert fresh.
  await prisma.employeeBucketEligibility.deleteMany({
    where: { userId: { in: demoIds } },
  });

  const nursingBucket = await prisma.specialHourBucket.findUnique({
    where: { code: 'nursing_parenting' },
  });
  const reservistSpouseBucket = await prisma.specialHourBucket.findUnique({
    where: { code: 'reservist_spouse_bucket' },
  });

  const monthLastDay = lastDayOfMonth(TARGET_YEAR, TARGET_MONTH);
  const windowStart = dateUtc(TARGET_YEAR, TARGET_MONTH, 1);
  const windowEnd = dateUtc(TARGET_YEAR, TARGET_MONTH, monthLastDay);

  const eligibilityRows: Array<{
    userId: number;
    bucketId: number;
    dailyAmount: number;
    startDate: Date;
    endDate: Date;
    active: boolean;
    creditMode: 'REPORTED' | 'AUTO';
    createdById: number;
  }> = [];
  if (nursingBucket) {
    eligibilityRows.push({
      userId: createdUsers.hr1,
      bucketId: nursingBucket.id,
      dailyAmount: 1,
      startDate: windowStart,
      endDate: windowEnd,
      active: true,
      creditMode: 'REPORTED',
      createdById,
    });
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      '[seed-hr-demo] SpecialHourBucket code=nursing_parenting not found; skipping.',
    );
  }
  if (reservistSpouseBucket) {
    eligibilityRows.push({
      userId: createdUsers.hr2,
      bucketId: reservistSpouseBucket.id,
      dailyAmount: 1,
      startDate: windowStart,
      endDate: windowEnd,
      active: true,
      creditMode: 'AUTO',
      createdById,
    });
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      '[seed-hr-demo] SpecialHourBucket code=reservist_spouse_bucket not found; skipping.',
    );
  }
  if (eligibilityRows.length > 0) {
    await prisma.employeeBucketEligibility.createMany({ data: eligibilityRows });
  }

  // 8) Recompute MonthlyAttendance for the three demo users via the real
  //    engine. HrMonthlyService only uses the plain `.`-methods on its
  //    `prisma` member (user / hrSettings / calendarDay / timeEntry /
  //    absenceRecord / employeeBucketEligibility / monthlyAttendance),
  //    all of which exist on PrismaClient directly — the cast is safe.
  const monthly = new HrMonthlyService(prisma as any);
  const recomputeResult = await monthly.computeMonthForMany({
    userIds: demoIds,
    year: TARGET_YEAR,
    month: TARGET_MONTH,
  });

  // 9) Summary
  const emails = DEMO_USERS.map((u) => u.email).join(', ');
  // eslint-disable-next-line no-console
  console.log(
    `[seed-hr-demo] Seeded 3 demo HR users (${emails}), ${timeEntryRows.length} time entries, ${absenceRows.length} absences, ${eligibilityRows.length} eligibilities, ${calDaysWritten} calendar days.`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[seed-hr-demo] MonthlyAttendance computed: ${recomputeResult.computed.length} rows written, ${recomputeResult.skipped.length} skipped.`,
  );
  if (recomputeResult.skipped.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[seed-hr-demo] skipped details: ${JSON.stringify(recomputeResult.skipped)}`,
    );
  }
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[seed-hr-demo] failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
