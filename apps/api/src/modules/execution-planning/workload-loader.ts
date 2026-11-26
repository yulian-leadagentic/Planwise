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
  /**
   * Whose absences reduce capacity ('all' for hr:read | the caller's
   * round-3 `visibleUserIds`: self + manager chain). An absence is HR
   * data: for everyone else no AbsenceRecord is read and capacity is
   * computed WITHOUT absences, so a shorter day can never reveal one.
   * Required, so every caller has to decide.
   */
  absencesFor: VisibleUserIds;
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
  const absenceIds = opts.absencesFor === 'all' ? ids : ids.filter((id) => isUserVisible(opts.absencesFor ?? [], id));

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
    absenceIds.length === 0
      ? Promise.resolve([] as any[])
      : prisma.absenceRecord.findMany({
          where: { userId: { in: absenceIds }, dateFrom: { lte: to }, dateTo: { gte: from } },
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
      select: { userId: true, task: { select: WORKLOAD_TASK_SELECT } },
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
  const facts = await loadTaskFacts(prisma, taskIds);

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
    out.get(a.userId)?.tasks.push(toWorkloadTask(t, facts));
  }
  for (const r of (logged ?? []) as any[]) {
    const map = out.get(r.userId)?.loggedByDate;
    const key = keyOf(r.date);
    if (!map || !key) continue;
    map.set(key, (map.get(key) ?? 0) + Number(r._sum?.minutes ?? 0) / 60);
  }
  return out;
}

// ─── QA6 PR-063: task facts shared with the Workload tray ─────────────

/** The task columns `toWorkloadTask` reads (GET /workload/team and /workload/tray). */
export const WORKLOAD_TASK_SELECT = {
  id: true, code: true, name: true, budgetHours: true,
  estimatedStartDate: true, startDate: true, endDate: true,
  projectId: true, project: { select: { name: true } },
  // QA6 PR-063 — the Workload drag-and-drop `tasks` index.
  status: true, dueDateOverridden: true, isPersonal: true, phaseId: true,
  projectDeliverable: { select: { serviceId: true } },
  deliverableTemplate: { select: { phaseId: true } },
} as const;

export interface TaskFacts {
  /** Live assignee count per task. */
  countByTask: Map<number, number>;
  /** Live assignee ids per task. */
  assigneeIdsByTask: Map<number, number[]>;
  /** Hours logged on the task by anyone. */
  loggedByTask: Map<number, number>;
  /** Hours logged on the task per user (only users with hours > 0). */
  loggedByTaskUser: Map<number, Map<number, number>>;
}

/**
 * Live assignees and logged hours of `taskIds`, in two grouped queries.
 * QA6 PR-063 — grouped per (task, user), so the same two queries give
 * the assignee ids and who logged how much (the drag-and-drop ⏱ flag).
 */
export async function loadTaskFacts(prisma: PrismaService, taskIds: number[]): Promise<TaskFacts> {
  const facts: TaskFacts = {
    countByTask: new Map(),
    assigneeIdsByTask: new Map(),
    loggedByTask: new Map(),
    loggedByTaskUser: new Map(),
  };
  if (taskIds.length === 0) return facts;
  const [counts, perTask] = await Promise.all([
    prisma.taskAssignee.groupBy({
      by: ['taskId', 'userId'],
      where: { taskId: { in: taskIds }, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.timeEntry.groupBy({
      by: ['taskId', 'userId'],
      where: { taskId: { in: taskIds }, deletedAt: null },
      _sum: { minutes: true },
    }),
  ]);
  for (const c of (counts ?? []) as any[]) {
    if (c.taskId == null) continue;
    if (c.userId != null) {
      facts.countByTask.set(c.taskId, (facts.countByTask.get(c.taskId) ?? 0) + 1);
      facts.assigneeIdsByTask.set(c.taskId, [...(facts.assigneeIdsByTask.get(c.taskId) ?? []), Number(c.userId)]);
    } else {
      // A grouping per task only (older callers / test doubles): the count as given.
      facts.countByTask.set(c.taskId, (facts.countByTask.get(c.taskId) ?? 0) + Number(c._count?._all ?? c._count ?? 0));
    }
  }
  for (const r of (perTask ?? []) as any[]) {
    if (r.taskId == null) continue;
    const hours = Number(r._sum?.minutes ?? 0) / 60;
    facts.loggedByTask.set(r.taskId, (facts.loggedByTask.get(r.taskId) ?? 0) + hours);
    if (r.userId != null && hours > 0) {
      const byUser = facts.loggedByTaskUser.get(r.taskId) ?? new Map<number, number>();
      byUser.set(Number(r.userId), (byUser.get(Number(r.userId)) ?? 0) + hours);
      facts.loggedByTaskUser.set(r.taskId, byUser);
    }
  }
  return facts;
}

/** A task row (`WORKLOAD_TASK_SELECT`) + its facts → the engine's WorkloadTask. */
export function toWorkloadTask(t: any, facts: TaskFacts): WorkloadTask {
  return {
    id: t.id,
    code: t.code ?? null,
    name: t.name,
    projectId: t.projectId ?? null,
    projectName: t.project?.name ?? null,
    budgetHours: Number(t.budgetHours ?? 0),
    loggedHours: facts.loggedByTask.get(t.id) ?? 0,
    assigneeCount: Math.max(1, facts.countByTask.get(t.id) ?? 1),
    estimatedStartDate: t.estimatedStartDate ?? null,
    startDate: t.startDate ?? null,
    endDate: t.endDate ?? null,
    status: t.status ?? null,
    dueDateOverridden: t.dueDateOverridden === true,
    isPersonal: t.isPersonal === true,
    phaseId: t.phaseId ?? null,
    deliverableServiceId: t.projectDeliverable?.serviceId ?? null,
    templatePhaseId: t.deliverableTemplate?.phaseId ?? null,
    assigneeIds: [...(facts.assigneeIdsByTask.get(t.id) ?? [])].sort((x, y) => x - y),
    loggedByUser: facts.loggedByTaskUser.get(t.id) ?? new Map<number, number>(),
  };
}
