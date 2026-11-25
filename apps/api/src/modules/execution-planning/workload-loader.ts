/**
 * QA6 P3 — the DB side of the workload engine. Batched: a fixed number
 * of queries for any number of people (no per-person round trips).
 */
import type { PrismaService } from '../../prisma/prisma.service';
import { VisibleUserIds, isUserVisible } from '../../common/services/employee-scope.service';
import {
  AbsenceRow,
  OrgCalendar,
  PersonInput,
  ScheduleRow,
  WorkloadTask,
  addDaysYmd,
  buildOrgCalendar,
  keyOf,
  parseYmd,
} from './workload-engine';

/** Today's date in Israel (the org's calendar), as YYYY-MM-DD. */
export function todayKey(now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jerusalem',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Org rest days + every org calendar row (a small table — the scheduler reads it whole too). */
export async function loadOrgCalendar(prisma: PrismaService): Promise<OrgCalendar> {
  const [hr, rows] = await Promise.all([
    prisma.hrSettings.findFirst({ select: { weeklyRestDays: true } }),
    prisma.calendarDay.findMany({
      where: { appliesTo: { in: ['all', 'employees_only'] } },
      select: { date: true, type: true, workingHours: true, name: true },
    }),
  ]);
  return buildOrgCalendar(hr?.weeklyRestDays, (rows ?? []) as any[]);
}

export interface LoadPeopleOptions {
  /** Whose logged hours per day to load ('all' | ids). Others get `loggedByDate: null`. */
  loggedFor: VisibleUserIds;
  /** dailyStandardHours already known (saves the user query). */
  dailyStandardHours?: Map<number, number | null>;
}

/**
 * Inputs of `computePersonWorkload` for each user, over [fromKey, toKey].
 * Tasks: live assignments on open (not completed / cancelled), live,
 * non-archived tasks, outside deleted projects.
 */
export async function loadPeopleInputs(
  prisma: PrismaService,
  userIds: number[],
  fromKey: string,
  toKey: string,
  opts: LoadPeopleOptions,
): Promise<Map<number, PersonInput>> {
  const out = new Map<number, PersonInput>();
  const ids = [...new Set(userIds.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return out;

  const from = parseYmd(fromKey);
  const toExclusive = parseYmd(addDaysYmd(toKey, 1));
  const to = parseYmd(toKey);
  const loggedIds = opts.loggedFor === 'all' ? ids : ids.filter((id) => isUserVisible(opts.loggedFor, id));

  const [users, schedules, absences, assignments, logged] = await Promise.all([
    opts.dailyStandardHours
      ? Promise.resolve(null)
      : prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, dailyStandardHours: true } }),
    prisma.workSchedule.findMany({
      where: {
        userId: { in: ids },
        isActive: true,
        effectiveFrom: { lt: toExclusive },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: from } }],
      },
      select: { userId: true, dayOfWeek: true, shiftStart: true, shiftEnd: true, breakMinutes: true, effectiveFrom: true },
    }),
    prisma.absenceRecord.findMany({
      where: { userId: { in: ids }, dateFrom: { lte: to }, dateTo: { gte: from } },
      select: { userId: true, dateFrom: true, dateTo: true, amount: true, absenceType: { select: { unit: true } } },
    }),
    prisma.taskAssignee.findMany({
      where: {
        userId: { in: ids },
        deletedAt: null,
        task: {
          deletedAt: null,
          isArchived: false,
          status: { notIn: ['completed', 'cancelled'] },
          OR: [{ projectId: null }, { project: { deletedAt: null } }],
        },
      },
      select: {
        userId: true,
        task: {
          select: {
            id: true, code: true, name: true, budgetHours: true,
            estimatedStartDate: true, startDate: true, endDate: true,
            projectId: true, project: { select: { name: true } },
          },
        },
      },
    }),
    loggedIds.length === 0
      ? Promise.resolve([] as any[])
      : prisma.timeEntry.groupBy({
          by: ['userId', 'date'],
          where: { userId: { in: loggedIds }, deletedAt: null, date: { gte: from, lt: toExclusive } },
          _sum: { minutes: true },
        }),
  ]);

  // Per-task: live assignee count + hours logged by anyone.
  const taskIds = [...new Set((assignments ?? []).map((a: any) => a.task?.id).filter((v: any) => v != null))] as number[];
  const [counts, perTask] = taskIds.length === 0
    ? [[], []]
    : await Promise.all([
        prisma.taskAssignee.groupBy({
          by: ['taskId'],
          where: { taskId: { in: taskIds }, deletedAt: null },
          _count: { _all: true },
        }),
        prisma.timeEntry.groupBy({
          by: ['taskId'],
          where: { taskId: { in: taskIds }, deletedAt: null },
          _sum: { minutes: true },
        }),
      ]);
  const countByTask = new Map<number, number>();
  for (const c of (counts ?? []) as any[]) if (c.taskId != null) countByTask.set(c.taskId, Number(c._count?._all ?? c._count ?? 0));
  const loggedByTask = new Map<number, number>();
  for (const r of (perTask ?? []) as any[]) if (r.taskId != null) loggedByTask.set(r.taskId, Number(r._sum?.minutes ?? 0) / 60);

  const std = opts.dailyStandardHours ?? new Map<number, number | null>(
    ((users ?? []) as any[]).map((u) => [u.id, u.dailyStandardHours == null ? null : Number(u.dailyStandardHours)]),
  );

  for (const id of ids) {
    out.set(id, {
      userId: id,
      dailyStandardHours: std.get(id) ?? null,
      schedules: [],
      absences: [],
      tasks: [],
      loggedByDate: loggedIds.includes(id) ? new Map<string, number>() : null,
    });
  }
  for (const s of (schedules ?? []) as any[]) out.get(s.userId)?.schedules.push(s as ScheduleRow);
  for (const a of (absences ?? []) as any[]) {
    out.get(a.userId)?.absences.push({
      dateFrom: a.dateFrom,
      dateTo: a.dateTo,
      unit: a.absenceType?.unit ?? 'DAY',
      amount: Number(a.amount ?? 0),
    } as AbsenceRow);
  }
  for (const a of (assignments ?? []) as any[]) {
    const t = a.task;
    if (!t) continue;
    out.get(a.userId)?.tasks.push({
      id: t.id,
      code: t.code ?? null,
      name: t.name,
      projectId: t.projectId ?? null,
      projectName: t.project?.name ?? null,
      budgetHours: Number(t.budgetHours ?? 0),
      loggedHours: loggedByTask.get(t.id) ?? 0,
      assigneeCount: Math.max(1, countByTask.get(t.id) ?? 1),
      estimatedStartDate: t.estimatedStartDate ?? null,
      startDate: t.startDate ?? null,
      endDate: t.endDate ?? null,
    } as WorkloadTask);
  }
  for (const r of (logged ?? []) as any[]) {
    const map = out.get(r.userId)?.loggedByDate;
    const key = keyOf(r.date);
    if (!map || !key) continue;
    map.set(key, (map.get(key) ?? 0) + Number(r._sum?.minutes ?? 0) / 60);
  }
  return out;
}
