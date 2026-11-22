import { Injectable } from '@nestjs/common';
import { startOfDay, endOfDay, parseISO } from 'date-fns';

import { PrismaService } from '../../prisma/prisma.service';
import { ReportQueryDto } from './dto/report-query.dto';
import { redactFinanceFields } from '../../common/finance/finance-access';
import { PermissionDeniedException, describePermission } from '../../common/errors/permission-denied';
import {
  NO_TIME_SCOPE,
  TimeEntryScope,
  VisibleUserIds,
  isUserVisible,
  toLeaderView,
} from '../../common/services/employee-scope.service';

/**
 * Permissions round 3 — privacy (2026-11-22). Every per-person report
 * runs inside the caller's scope, which the controller resolves with
 * EmployeeScopeService:
 *
 *   • attendance reports (clock records) — `VisibleUserIds`: everyone
 *     for hr:read, otherwise the caller + the employees he manages;
 *   • time-entry reports — `TimeEntryScope`: the same employees, plus
 *     every entry on a project the caller LEADS, shown in the leader
 *     view (no location / special-hours bucket / clock data).
 *
 * Service methods default to "nobody" so a new caller can't leak
 * hours by omission. Cost reports (finance aggregates, no per-person
 * rows) are not scoped.
 */

/** `/reports/export` types that read clock records (attendance scope). */
const ATTENDANCE_EXPORT_TYPES = new Set(['attendance', 'overtime', 'late-arrivals']);

/** Which scope an export type needs: attendance, time entries, or none (cost aggregates). */
export function exportScopeKind(type: string | null | undefined): 'attendance' | 'entries' | 'none' {
  const t = String(type ?? '').trim().toLowerCase();
  if (ATTENDANCE_EXPORT_TYPES.has(t)) return 'attendance';
  if (t === 'cost-by-project') return 'none';
  return 'entries';
}

/** Prisma `where` for the user ids of a VisibleUserIds (null = no restriction). */
function visibleUserWhere(visible: VisibleUserIds): { userId: { in: number[] } } | null {
  return visible === 'all' ? null : { userId: { in: visible } };
}

/**
 * Prisma `where` for a TimeEntryScope (null = no restriction): the
 * entry's employee is visible, OR the entry is on a project the caller
 * leads — resolved through the entry AND through its task, since
 * `entry.projectId` is NULL on many historical rows.
 */
export function timeEntryScopeWhere(scope: TimeEntryScope): any | null {
  if (scope.visibleUserIds === 'all') return null;
  const or: any[] = [];
  if (scope.visibleUserIds.length > 0) or.push({ userId: { in: scope.visibleUserIds } });
  if (scope.ledProjectIds.length > 0) {
    or.push({ projectId: { in: scope.ledProjectIds } });
    or.push({ task: { projectId: { in: scope.ledProjectIds } } });
  }
  if (or.length === 0) return { userId: { in: [] } };
  return { OR: or };
}

/** True when the row is visible only because the caller leads its project. */
function isLeaderOnlyRow(scope: TimeEntryScope, userId: number): boolean {
  return !isUserVisible(scope.visibleUserIds, userId);
}

/** 403 for a cost-* export without finance:read (controller + service). */
export function costReportsDenied(): PermissionDeniedException {
  return new PermissionDeniedException(
    `You can't export cost reports — that needs permission to ${describePermission('finance', 'read')}. Ask your administrator.`,
    { module: 'finance', action: 'read' },
  );
}

/**
 * `/reports/export` types that are cost reports (finance:read only).
 * Matches every `cost-...` spelling, including ones that would fall
 * through to the default case.
 */
export function isCostExportType(type: string | null | undefined): boolean {
  return String(type ?? '').trim().toLowerCase().startsWith('cost');
}

/**
 * The detailed timesheet for a caller without finance:read: per-row
 * `cost` / `currency` nulled and the per-currency cost totals emptied
 * (cost / hours would give each person's hourly rate). Used by the JSON
 * route and the Excel export alike. Pure, never mutates.
 */
export function scrubTimesheetCost<T extends { rows: any[]; totals: Record<string, any> }>(result: T): T {
  return {
    ...result,
    rows: result.rows.map((r: any) => ({ ...r, cost: null, currency: null })),
    totals: { ...result.totals, byCurrency: [] },
  };
}

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  private getDateRange(query: ReportQueryDto) {
    const from = query.from ? startOfDay(parseISO(query.from)) : startOfDay(new Date());
    const to = query.to ? endOfDay(parseISO(query.to)) : endOfDay(new Date());
    return { from, to };
  }

  /**
   * Detailed employee timesheet — one row per TimeEntry. Mirrors the
   * legacy "Employee Timesheets" report the customer is migrating from.
   * Filters: userId, projectId, from, to (all optional).
   *
   * Each row carries: date, start/end time, hours, employee, project,
   * zone breadcrumb, deliverable name, task name, note, cost + currency.
   * Cost = hours x user.seniorityLevel.defaultHourlyCost (M5 resolver).
   * Entries whose contributor has no resolved rate get cost=null +
   * currency=null so the UI can render an em-dash instead of fake 0s.
   *
   * Totals: per-currency aggregates (no FX conversion — same rule
   * as the M5 labor-cost endpoint).
   */
  async timesheetDetailed(query: ReportQueryDto, scope: TimeEntryScope = NO_TIME_SCOPE) {
    const { from, to } = this.getDateRange(query);

    // Compose the task-level filter — resolve project via the task
    // (entry.projectId is NULL on many historical rows), and apply
    // the personal-task cut when the caller asked for one.
    const taskFilter: any = {};
    if (query.projectId) taskFilter.projectId = Number(query.projectId);
    if (query.personal === 'exclude') taskFilter.isPersonal = false;
    else if (query.personal === 'only') taskFilter.isPersonal = true;

    const scopeWhere = timeEntryScopeWhere(scope);
    const entries = await this.prisma.timeEntry.findMany({
      where: {
        deletedAt: null,
        date: { gte: from, lte: to },
        ...(query.userId ? { userId: Number(query.userId) } : {}),
        ...(Object.keys(taskFilter).length > 0 ? { task: taskFilter } : {}),
        ...(scopeWhere ? { AND: [scopeWhere] } : {}),
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        date: true,
        startTime: true,
        endTime: true,
        minutes: true,
        note: true,
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            // seniorityLevel removed — we resolve the date-effective
            // level per-entry below using user_seniorities so the cost
            // matches what was active when the work was logged, not
            // the user's current level.
          },
        },
        task: {
          select: {
            id: true,
            name: true,
            projectId: true,
            project: { select: { id: true, name: true, number: true } },
            zone: { select: { id: true, name: true, path: true } },
            deliverableTemplate: { select: { id: true, name: true } },
            // M5-fix — "Service" column on the legacy report maps to
            // the Phase relation (DB) which is exposed in the UI as
            // "Service" everywhere else. Sits one level above
            // Deliverable in the work-discipline hierarchy.
            phase: { select: { id: true, name: true } },
          },
        },
      },
    });

    // Pre-resolve every referenced zone id (including ancestors) so we
    // can render full breadcrumbs like "Building 1 > Floor 2 > Unit A".
    // Walking task.zone.path one-by-one would lookup the same parent
    // zone many times; batch it instead.
    const ancestorIds = new Set<number>();
    for (const e of entries) {
      const path = e.task?.zone?.path;
      if (!path) continue;
      for (const seg of path.split('/').filter(Boolean)) {
        const n = Number(seg);
        if (Number.isFinite(n)) ancestorIds.add(n);
      }
    }
    const zoneNameById = new Map<number, string>();
    if (ancestorIds.size > 0) {
      const rows = await this.prisma.zone.findMany({
        where: { id: { in: Array.from(ancestorIds) } },
        select: { id: true, name: true },
      });
      for (const z of rows) zoneNameById.set(z.id, z.name);
    }

    // Pre-load every contributor's seniority history so the per-row
    // effective-level lookup runs in memory (no N+1).
    const tsUserIds = Array.from(new Set(entries.map((e) => e.user.id)));
    const tsHistories = tsUserIds.length === 0 ? [] : await this.prisma.userSeniority.findMany({
      where: { userId: { in: tsUserIds } },
      include: {
        seniorityLevel: { select: { name: true, defaultHourlyCost: true, currency: true } },
      },
      orderBy: { startDate: 'desc' },
    });
    const tsHistoryByUser = new Map<number, typeof tsHistories>();
    for (const h of tsHistories) {
      if (!tsHistoryByUser.has(h.userId)) tsHistoryByUser.set(h.userId, []);
      tsHistoryByUser.get(h.userId)!.push(h);
    }
    const tsEffectiveAt = (userId: number, date: Date) => {
      const list = tsHistoryByUser.get(userId) ?? [];
      for (const row of list) {
        if (row.startDate <= date && (row.endDate === null || row.endDate >= date)) {
          return row.seniorityLevel;
        }
      }
      return null;
    };

    // Per-currency totals + flat row list.
    const totalsByCurrency = new Map<string, { totalHours: number; totalCost: number }>();
    let totalHours = 0;

    const rows = entries.map((e) => {
      const hours = e.minutes / 60;
      totalHours += hours;

      // Resolve the level effective on THIS entry's date — not the
      // user's current level. A user promoted mid-month will see two
      // different cost rows for the same week of entries.
      const sl = tsEffectiveAt(e.user.id, e.date);
      let cost: number | null = null;
      let currency: string | null = null;
      if (sl?.defaultHourlyCost != null) {
        cost = +(hours * Number(sl.defaultHourlyCost)).toFixed(2);
        currency = sl.currency ?? 'UNK';
        const agg = totalsByCurrency.get(currency) ?? { totalHours: 0, totalCost: 0 };
        agg.totalHours += hours;
        agg.totalCost += cost;
        totalsByCurrency.set(currency, agg);
      }

      // Round 3 — a row the caller sees only as the project's leader:
      // date, task, hours, note. No time-of-day window, no seniority.
      const leaderOnly = isLeaderOnlyRow(scope, e.user.id);

      const zonePath = e.task?.zone?.path ?? '';
      const zoneBreadcrumb = zonePath
        ? zonePath
            .split('/')
            .map((s) => Number(s))
            .filter((n) => Number.isFinite(n))
            .map((id) => zoneNameById.get(id))
            .filter((n): n is string => !!n)
        : [];

      return {
        id: e.id,
        date: e.date.toISOString().slice(0, 10),
        startTime: leaderOnly ? null : e.startTime ?? null,
        endTime: leaderOnly ? null : e.endTime ?? null,
        hours: +hours.toFixed(2),
        // Flatten the user shape so the UI doesn't have to dig two
        // levels deep for the most-used display fields.
        user: {
          id: e.user.id,
          firstName: e.user.firstName,
          lastName: e.user.lastName,
          displayName: `${e.user.firstName ?? ''} ${e.user.lastName ?? ''}`.trim(),
        },
        project: e.task?.project
          ? {
              id: e.task.project.id,
              name: e.task.project.name,
              number: e.task.project.number ?? null,
              // Pre-formatted "Number - Name" matches what the customer's
              // legacy report shows; UI can use it as-is.
              displayName: e.task.project.number
                ? `${e.task.project.name} - ${e.task.project.number}`
                : e.task.project.name,
            }
          : null,
        zone: e.task?.zone
          ? {
              id: e.task.zone.id,
              name: e.task.zone.name,
              breadcrumb: zoneBreadcrumb,
            }
          : null,
        // Deliverable + Service: two grouping axes for the work, both
        // rendered as their own columns. Deliverable = the specific
        // deliverable template (the "what"). Service = the parent
        // phase (the broader category).
        deliverable: e.task?.deliverableTemplate
          ? { id: e.task.deliverableTemplate.id, name: e.task.deliverableTemplate.name }
          : null,
        service: e.task?.phase
          ? { id: e.task.phase.id, name: e.task.phase.name }
          : null,
        // "Assignment Name" column -> task name.
        assignmentName: e.task?.name ?? null,
        description: e.note ?? null,
        cost,
        currency,
        seniorityLevelName: leaderOnly ? null : sl?.name ?? null,
      };
    });

    return {
      rows,
      totals: {
        totalHours: +totalHours.toFixed(2),
        rowCount: rows.length,
        byCurrency: Array.from(totalsByCurrency.entries()).map(([currency, t]) => ({
          currency,
          totalHours: +t.totalHours.toFixed(2),
          totalCost: +t.totalCost.toFixed(2),
        })),
      },
    };
  }

  /**
   * Shared `where` of the time-entry reports: live entries in the date
   * range, the optional userId / projectId filters, and the caller's
   * TimeEntryScope.
   */
  private scopedEntryWhere(query: ReportQueryDto, scope: TimeEntryScope, extra: Record<string, any> = {}) {
    const { from, to } = this.getDateRange(query);
    const scopeWhere = timeEntryScopeWhere(scope);
    return {
      deletedAt: null,
      date: { gte: from, lte: to },
      ...(query.userId ? { userId: Number(query.userId) } : {}),
      ...(query.projectId ? { projectId: Number(query.projectId) } : {}),
      ...extra,
      ...(scopeWhere ? { AND: [scopeWhere] } : {}),
    };
  }

  /** The entry as the caller may see it: full, or the leader view. */
  private entryForScope<T extends { userId: number }>(scope: TimeEntryScope, entry: T): T {
    return isLeaderOnlyRow(scope, entry.userId) ? toLeaderView(entry) : entry;
  }

  async timesheetByProject(query: ReportQueryDto, scope: TimeEntryScope = NO_TIME_SCOPE) {
    const entries = await this.prisma.timeEntry.findMany({
      where: this.scopedEntryWhere(query, scope),
      include: {
        project: { select: { id: true, name: true } },
        user: { select: { id: true, firstName: true, lastName: true } },
        task: { select: { id: true, name: true } },
      },
    });

    // Group by project
    const grouped: Record<number, any> = {};
    for (const raw of entries) {
      const entry = this.entryForScope(scope, raw);
      const pid = entry.projectId ?? 0;
      if (!grouped[pid]) {
        grouped[pid] = {
          project: entry.project || { id: 0, name: 'No Project' },
          totalMinutes: 0,
          billableMinutes: 0,
          entries: [],
        };
      }
      grouped[pid].totalMinutes += entry.minutes;
      if (entry.isBillable) grouped[pid].billableMinutes += entry.minutes;
      grouped[pid].entries.push(entry);
    }

    return Object.values(grouped);
  }

  async timesheetByLabel(query: ReportQueryDto, scope: TimeEntryScope = NO_TIME_SCOPE) {
    const entries = await this.prisma.timeEntry.findMany({
      where: this.scopedEntryWhere(query, scope),
      include: {
        task: {
          select: {
            id: true,
            name: true,
            zone: { select: { id: true, name: true, path: true } },
          },
        },
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    const grouped: Record<number, any> = {};
    for (const raw of entries) {
      const entry = this.entryForScope(scope, raw);
      const zoneId = (entry.task as any)?.zone?.id ?? 0;
      if (!grouped[zoneId]) {
        grouped[zoneId] = {
          zone: (entry.task as any)?.zone || { id: 0, name: 'No Zone', path: '' },
          totalMinutes: 0,
          entries: [],
        };
      }
      grouped[zoneId].totalMinutes += entry.minutes;
      grouped[zoneId].entries.push(entry);
    }

    return Object.values(grouped);
  }

  /** Attendance route: clock records + logged totals of the visible employees only. */
  async timesheetToday(visible: VisibleUserIds = []) {
    const today = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());
    const userWhere = visibleUserWhere(visible) ?? {};

    const [clockedIn, entries] = await Promise.all([
      this.prisma.timeClock.findMany({
        where: { date: today, ...userWhere },
        include: {
          user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        },
      }),
      this.prisma.timeEntry.findMany({
        where: { deletedAt: null, date: { gte: today, lte: todayEnd }, ...userWhere },
        include: {
          user: { select: { id: true, firstName: true, lastName: true } },
          project: { select: { id: true, name: true } },
        },
      }),
    ]);

    const activeCount = clockedIn.filter((c) => !c.clockOut).length;
    const totalLoggedMinutes = entries.reduce((s, e) => s + e.minutes, 0);

    return {
      clockRecords: clockedIn,
      activeCount,
      totalClockedIn: clockedIn.length,
      totalLoggedMinutes,
      totalLoggedHours: +(totalLoggedMinutes / 60).toFixed(2),
    };
  }

  async timesheetActivity(query: ReportQueryDto, scope: TimeEntryScope = NO_TIME_SCOPE) {
    // `projectId` is not an activity filter (never was) — keep it out.
    const entries = await this.prisma.timeEntry.findMany({
      where: this.scopedEntryWhere({ ...query, projectId: undefined }, scope),
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        project: { select: { id: true, name: true } },
        task: { select: { id: true, name: true } },
      },
      orderBy: { date: 'desc' },
    });
    return entries.map((e) => this.entryForScope(scope, e));
  }

  /** `where` of the attendance reports: date range, optional userId, visible employees only. */
  private scopedClockWhere(query: ReportQueryDto, visible: VisibleUserIds, extra: Record<string, any> = {}) {
    const { from, to } = this.getDateRange(query);
    const userWhere = visibleUserWhere(visible);
    return {
      date: { gte: from, lte: to },
      ...extra,
      ...(query.userId ? { userId: Number(query.userId) } : {}),
      ...(userWhere ? { AND: [userWhere] } : {}),
    };
  }

  /**
   * Per-employee attendance counts in the range. Days are distinct
   * dates (several clock-ins on one day count once). Round 3: sick and
   * leave days are their own columns and no longer count as present.
   */
  async attendanceSummary(query: ReportQueryDto, visible: VisibleUserIds = []) {
    const records = await this.prisma.timeClock.findMany({
      where: this.scopedClockWhere(query, visible),
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    const dayOf = (d: Date) => new Date(d).toISOString().slice(0, 10);
    const byUser: Record<number, any> = {};
    const days: Record<number, Record<'all' | 'present' | 'absent' | 'sick' | 'leave' | 'late', Set<string>>> = {};
    for (const record of records) {
      if (!byUser[record.userId]) {
        byUser[record.userId] = {
          user: record.user,
          totalDays: 0,
          presentDays: 0,
          absentDays: 0,
          sickDays: 0,
          leaveDays: 0,
          lateDays: 0,
          totalMinutes: 0,
          overtimeMinutes: 0,
        };
        days[record.userId] = {
          all: new Set(), present: new Set(), absent: new Set(), sick: new Set(), leave: new Set(), late: new Set(),
        };
      }
      const u = byUser[record.userId];
      const d = days[record.userId];
      const key = dayOf(record.date);
      d.all.add(key);
      if (record.status === 'absent') d.absent.add(key);
      else if (record.status === 'sick') d.sick.add(key);
      else if (record.status === 'leave') d.leave.add(key);
      else d.present.add(key);
      if (record.isLate) d.late.add(key);
      u.totalMinutes += record.totalMinutes ?? 0;
      u.overtimeMinutes += record.overtimeMinutes ?? 0;
    }

    return Object.entries(byUser).map(([userId, u]) => {
      const d = days[Number(userId)];
      return {
        ...u,
        totalDays: d.all.size,
        presentDays: d.present.size,
        absentDays: d.absent.size,
        sickDays: d.sick.size,
        leaveDays: d.leave.size,
        lateDays: d.late.size,
      };
    });
  }

  async overtimeReport(query: ReportQueryDto, visible: VisibleUserIds = []) {
    return this.prisma.timeClock.findMany({
      where: this.scopedClockWhere(query, visible, { overtimeMinutes: { gt: 0 } }),
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { date: 'desc' },
    });
  }

  async lateArrivalsReport(query: ReportQueryDto, visible: VisibleUserIds = []) {
    return this.prisma.timeClock.findMany({
      where: this.scopedClockWhere(query, visible, { isLate: true }),
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { date: 'desc' },
    });
  }

  async costByTask(query: ReportQueryDto) {
    const { from, to } = this.getDateRange(query);

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        deletedAt: null,
        date: { gte: from, lte: to },
        taskId: { not: null },
        ...(query.projectId ? { projectId: Number(query.projectId) } : {}),
      },
      include: {
        task: {
          include: {
            assignees: { select: { hourlyRate: true, userId: true } },
          },
        },
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    const byTask: Record<number, any> = {};
    for (const entry of entries) {
      const tid = entry.taskId!;
      if (!byTask[tid]) {
        byTask[tid] = {
          task: { id: entry.task?.id, name: entry.task?.name },
          totalMinutes: 0,
          estimatedCost: 0,
        };
      }
      byTask[tid].totalMinutes += entry.minutes;

      // Calculate cost from assignee hourly rate
      const assignee = entry.task?.assignees?.find((a) => a.userId === entry.userId);
      if (assignee?.hourlyRate) {
        byTask[tid].estimatedCost += (entry.minutes / 60) * Number(assignee.hourlyRate);
      }
    }

    return Object.values(byTask);
  }

  async costByLabel(query: ReportQueryDto) {
    const { from, to } = this.getDateRange(query);

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        deletedAt: null,
        date: { gte: from, lte: to },
        task: { isNot: null },
        ...(query.projectId ? { projectId: Number(query.projectId) } : {}),
      },
      include: {
        task: {
          select: {
            zone: { select: { id: true, name: true, path: true } },
            assignees: { select: { hourlyRate: true, userId: true } },
          },
        },
        user: { select: { id: true } },
      },
    });

    const byZone: Record<number, any> = {};
    for (const entry of entries) {
      const zoneId = (entry.task as any)?.zone?.id ?? 0;
      if (!byZone[zoneId]) {
        byZone[zoneId] = {
          zone: (entry.task as any)?.zone || { id: 0, name: 'Unknown' },
          totalMinutes: 0,
          estimatedCost: 0,
        };
      }
      byZone[zoneId].totalMinutes += entry.minutes;

      const assignee = (entry.task as any)?.assignees?.find((a: any) => a.userId === entry.userId);
      if (assignee?.hourlyRate) {
        byZone[zoneId].estimatedCost += (entry.minutes / 60) * Number(assignee.hourlyRate);
      }
    }

    return Object.values(byZone);
  }

  async costByProject(query: ReportQueryDto) {
    const { from, to } = this.getDateRange(query);

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        deletedAt: null,
        date: { gte: from, lte: to },
        ...(query.projectId ? { projectId: Number(query.projectId) } : {}),
      },
      include: {
        project: { select: { id: true, name: true, budget: true } },
        task: {
          select: {
            assignees: { select: { hourlyRate: true, userId: true } },
          },
        },
        user: { select: { id: true } },
      },
    });

    const byProject: Record<number, any> = {};
    for (const entry of entries) {
      const pid = entry.projectId ?? 0;
      if (!byProject[pid]) {
        byProject[pid] = {
          project: entry.project || { id: 0, name: 'No Project' },
          totalMinutes: 0,
          estimatedCost: 0,
          budget: entry.project?.budget ? Number(entry.project.budget) : null,
        };
      }
      byProject[pid].totalMinutes += entry.minutes;

      const assignee = entry.task?.assignees?.find((a) => a.userId === entry.userId);
      if (assignee?.hourlyRate) {
        byProject[pid].estimatedCost += (entry.minutes / 60) * Number(assignee.hourlyRate);
      }
    }

    return Object.values(byProject);
  }

  async milestonesReport(query: ReportQueryDto) {
    const where: any = {};
    if (query.projectId) {
      where.label = { projectId: Number(query.projectId) };
    }

    return this.prisma.labelMilestone.findMany({
      where,
      include: {
        label: { select: { id: true, name: true, path: true, project: { select: { id: true, name: true } } } },
        partner: { select: { id: true, firstName: true, lastName: true, companyName: true } },
      },
      orderBy: { dueDate: 'asc' },
    });
  }

  /**
   * `opts.canSeeFinance` (permissions round 2): false drops every money
   * value from the file: no Cost / Currency columns or cost totals on the
   * detailed timesheet, finance keys removed from the generic dumps. It
   * defaults to false so a new caller can't leak money by omission. The
   * controller refuses cost-* types to non-finance callers before this
   * runs; the check is repeated here so the service is safe on its own.
   *
   * `opts.scope` (permissions round 3): the caller's TimeEntryScope —
   * attendance types use its `visibleUserIds`, time-entry types the
   * whole scope (incl. projects he leads). Missing = nobody (fail
   * closed); `cost-by-project` is a finance aggregate and not scoped.
   */
  async exportReport(
    type: string,
    format: 'excel' | 'pdf',
    query: ReportQueryDto,
    opts: { canSeeFinance: boolean; scope?: TimeEntryScope } = { canSeeFinance: false },
  ): Promise<Buffer> {
    if (isCostExportType(type) && !opts.canSeeFinance) {
      throw costReportsDenied();
    }
    const scope = opts.scope ?? NO_TIME_SCOPE;
    // The detailed timesheet is the customer-facing export — it gets
    // a purpose-built Excel layout with proper columns, currency
    // formatting, and a totals footer. Other types fall through to
    // the generic "dump every scalar field" path below.
    if (type === 'timesheet-detailed') {
      const raw = await this.timesheetDetailed(query, scope);
      const data = opts.canSeeFinance ? raw : scrubTimesheetCost(raw);
      if (format === 'excel') {
        return this.generateTimesheetDetailedExcel(data, { includeCost: opts.canSeeFinance });
      }
      // PDF is intentionally not implemented server-side for this
      // type — the frontend uses window.print() so the browser handles
      // Hebrew/RTL natively. Reaching this branch is a misuse.
      throw new Error('PDF export for timesheet-detailed is handled client-side via window.print()');
    }

    // Get report data based on type
    let data: any;
    switch (type) {
      case 'timesheet-by-project':
        data = await this.timesheetByProject(query, scope);
        break;
      case 'attendance':
        data = await this.attendanceSummary(query, scope.visibleUserIds);
        break;
      case 'overtime':
        data = await this.overtimeReport(query, scope.visibleUserIds);
        break;
      case 'late-arrivals':
        data = await this.lateArrivalsReport(query, scope.visibleUserIds);
        break;
      case 'cost-by-project':
        data = await this.costByProject(query);
        break;
      default:
        data = await this.timesheetByProject(query, scope);
    }

    // Defence in depth for the generic dumps: no money key reaches the
    // file of a caller without finance:read.
    if (!opts.canSeeFinance) data = redactFinanceFields(data);

    if (format === 'excel') {
      return this.generateExcel(type, data);
    } else {
      return this.generatePdf(type, data);
    }
  }

  /**
   * Purpose-built XLSX for the Employee Timesheets report. Mirrors
   * the table the user sees on /reports/timesheet: 13 columns +
   * frozen header row + a totals footer with per-currency aggregates.
   * UTF-8 is preserved end-to-end so Hebrew names / project labels
   * round-trip cleanly into Excel.
   */
  private async generateTimesheetDetailedExcel(
    data: Awaited<ReturnType<typeof this.timesheetDetailed>>,
    opts: { includeCost: boolean },
  ): Promise<Buffer> {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Planwise';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Timesheet', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    // Column widths roughly match the on-screen table.
    sheet.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'From', key: 'from', width: 8 },
      { header: 'To', key: 'to', width: 8 },
      { header: 'Hours', key: 'hours', width: 8 },
      { header: 'Employee', key: 'employee', width: 22 },
      { header: 'Project', key: 'project', width: 32 },
      { header: 'Zone', key: 'zone', width: 32 },
      { header: 'Service', key: 'service', width: 22 },
      { header: 'Deliverable', key: 'deliverable', width: 26 },
      { header: 'Assignment Name', key: 'assignment', width: 30 },
      { header: 'Description', key: 'description', width: 30 },
      // Cost / Currency only for finance:read (permissions round 2, B-02).
      ...(opts.includeCost
        ? [
            { header: 'Cost', key: 'cost', width: 12 },
            { header: 'Currency', key: 'currency', width: 10 },
          ]
        : []),
    ];

    // Bold blue header row matching the in-app summary bar color.
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF3B82F6' }, // tailwind blue-500
    };
    headerRow.alignment = { vertical: 'middle' };

    for (const r of data.rows) {
      sheet.addRow({
        date: r.date,
        from: r.startTime ?? '',
        to: r.endTime ?? '',
        hours: r.hours,
        employee: r.user.displayName,
        project: r.project?.displayName ?? '',
        zone: r.zone ? (r.zone.breadcrumb.length > 0 ? r.zone.breadcrumb.join(' > ') : r.zone.name) : 'Project Root',
        service: r.service?.name ?? '',
        deliverable: r.deliverable?.name ?? '',
        assignment: r.assignmentName ?? '',
        description: r.description ?? '',
        ...(opts.includeCost ? { cost: r.cost ?? '', currency: r.currency ?? '' } : {}),
      });
    }

    // Number format on the cost + hours columns so the workbook
    // sums correctly when the user adds their own totals.
    sheet.getColumn('hours').numFmt = '0.00';
    if (opts.includeCost) sheet.getColumn('cost').numFmt = '#,##0.00';

    // Totals footer — one row per currency for the cost; one
    // grand-total row for hours. Bold + light grey background so
    // it's visually separated from the data.
    if (data.rows.length > 0) {
      sheet.addRow({});
      const totalRow = sheet.addRow({
        employee: 'Total',
        hours: data.totals.totalHours,
      });
      totalRow.font = { bold: true };
      totalRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE2E8F0' }, // slate-200
      };
      for (const c of opts.includeCost ? data.totals.byCurrency : []) {
        const r = sheet.addRow({
          employee: `Total (${c.currency})`,
          hours: c.totalHours,
          cost: c.totalCost,
          currency: c.currency,
        });
        r.font = { bold: true };
        r.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE2E8F0' },
        };
      }
    }

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  private async generateExcel(type: string, data: any[]): Promise<Buffer> {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Report');

    if (data.length > 0) {
      // Auto-generate headers from first item
      const sample = data[0];
      const headers = Object.keys(sample).filter((k) => typeof sample[k] !== 'object');
      sheet.addRow(headers);
      for (const item of data) {
        sheet.addRow(headers.map((h) => item[h]));
      }
    }

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  private async generatePdf(type: string, data: any[]): Promise<Buffer> {
    const PDFDocument = (await import('pdfkit')).default;

    return new Promise((resolve) => {
      const doc = new PDFDocument();
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      doc.fontSize(18).text(`${type} Report`, { align: 'center' });
      doc.moveDown();

      for (const item of data) {
        doc.fontSize(10).text(JSON.stringify(item, null, 2));
        doc.moveDown(0.5);
      }

      doc.end();
    });
  }
}
