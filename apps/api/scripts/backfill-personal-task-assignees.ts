/**
 * Backfill personal-task assignees.
 *
 *   npx ts-node scripts/backfill-personal-task-assignees.ts
 *
 * Personal tasks are "for yourself" — the create path was fixed to
 * auto-assign the creator so `/tasks/mine` finds them. Personal tasks
 * created BEFORE that fix have no assignee and stay invisible in My
 * Tasks. This one-off script inserts a TaskAssignee(taskId, createdBy)
 * for every personal task with no active assignee.
 *
 * Idempotent: skips tasks that already have any active assignee, and
 * upserts on the unique (taskId, userId) so a soft-deleted row for the
 * same pair is restored rather than duplicated.
 *
 * Non-personal tasks are never touched.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const targets = await prisma.task.findMany({
    where: {
      isPersonal: true,
      deletedAt: null,
      assignees: { none: { deletedAt: null } },
    },
    select: { id: true, createdBy: true },
  });

  let fixed = 0;
  for (const t of targets) {
    await prisma.taskAssignee.upsert({
      where: { taskId_userId: { taskId: t.id, userId: t.createdBy } },
      update: { deletedAt: null },
      create: { taskId: t.id, userId: t.createdBy },
    });
    fixed++;
  }

  console.log(
    `Backfill complete — fixed ${fixed} personal task(s) with no active assignee ` +
      `(assigned to task.createdBy).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
