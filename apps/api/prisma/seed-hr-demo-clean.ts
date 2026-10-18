/**
 * HR Phase D3 (2026-10-18) — companion of `seed-hr-demo.ts`. Removes
 * ONLY the demo rows written by that script.
 *
 * Demo users are identified by the email prefix `demo.hr` on the
 * `@maimoni.local` suffix; demo CalendarDay rows carry
 * `notes = '[demo-hr]'`.
 *
 * Safe to run repeatedly: if no demo rows exist, the script prints
 * "nothing to do" and exits cleanly.
 */
import { PrismaClient } from '@prisma/client';

if (process.env.NODE_ENV === 'production') {
  // eslint-disable-next-line no-console
  console.error(
    '[seed-hr-demo-clean] refuses to run with NODE_ENV=production.',
  );
  process.exit(1);
}
const dbUrl = process.env.DATABASE_URL || '';
if (/\bprod\b/i.test(dbUrl) || /production/i.test(dbUrl)) {
  // eslint-disable-next-line no-console
  console.error(
    '[seed-hr-demo-clean] refuses to run — DATABASE_URL contains "prod" or "production".',
  );
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  const demos = await prisma.user.findMany({
    where: {
      email: { startsWith: 'demo.hr', endsWith: '@maimoni.local' },
    },
    select: { id: true, email: true },
  });
  const userIds = demos.map((u) => u.id);

  // Scrub demo-tagged CalendarDay rows even if the users are already gone
  // (so a previous half-run doesn't leave orphan holiday rows behind).
  const calDays = await prisma.calendarDay.deleteMany({
    where: { notes: '[demo-hr]' },
  });

  if (userIds.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[seed-hr-demo-clean] no demo users found; removed ${calDays.count} calendar days.`,
    );
    return;
  }

  // Dependency order: child rows first, then the users themselves.
  const timeEntries = await prisma.timeEntry.deleteMany({
    where: { userId: { in: userIds } },
  });
  const absences = await prisma.absenceRecord.deleteMany({
    where: { userId: { in: userIds } },
  });
  const eligibilities = await prisma.employeeBucketEligibility.deleteMany({
    where: { userId: { in: userIds } },
  });
  const monthly = await prisma.monthlyAttendance.deleteMany({
    where: { userId: { in: userIds } },
  });
  const users = await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  // eslint-disable-next-line no-console
  console.log(
    `[seed-hr-demo-clean] removed ${users.count} users, ${timeEntries.count} time entries, ${absences.count} absences, ${eligibilities.count} eligibilities, ${monthly.count} monthly rows, ${calDays.count} calendar days.`,
  );
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[seed-hr-demo-clean] failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
