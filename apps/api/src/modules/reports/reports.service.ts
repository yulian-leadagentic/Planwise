import { Injectable } from '@nestjs/common';
import { startOfDay, endOfDay, parseISO } from 'date-fns';

import { PrismaService } from '../../prisma/prisma.service';
import { ReportQueryDto } from './dto/report-query.dto';

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
  async timesheetDetailed(query: ReportQueryDto) {
    const { from, to } = this.getDateRange(query);

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        deletedAt: null,
        date: { gte: from, lte: to },
        ...(query.userId ? { userId: Number(query.userId) } : {}),
        // Resolve project via the task — entry.projectId is NULL on many
        // historical rows (QuickTimeLog / TaskDrawer didn't always set
        // it), and filtering on it would silently drop those entries.
        ...(query.projectId ? { task: { projectId: Number(query.projectId) } } : {}),
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
            seniorityLevel: { select: { defaultHourlyCost: true, currency: true, name: true } },
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

    // Per-currency totals + flat row list.
    const totalsByCurrency = new Map<string, { totalHours: number; totalCost: number }>();
    let totalHours = 0;

    const rows = entries.map((e) => {
      const hours = e.minutes / 60;
      totalHours += hours;

      const sl = e.user.seniorityLevel;
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
        startTime: e.startTime ?? null,
        endTime: e.endTime ?? null,
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
        seniorityLevelName: sl?.name ?? null,
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

  async timesheetByProject(query: ReportQueryDto) {
    const { from, to } = this.getDateRange(query);

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        date: { gte: from, lte: to },
        ...(query.userId ? { userId: Number(query.userId) } : {}),
        ...(query.projectId ? { projectId: Number(query.projectId) } : {}),
      },
      include: {
        project: { select: { id: true, name: true } },
        user: { select: { id: true, firstName: true, lastName: true } },
        task: { select: { id: true, name: true } },
      },
    });

    // Group by project
    const grouped: Record<number, any> = {};
    for (const entry of entries) {
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

  async timesheetByLabel(query: ReportQueryDto) {
    const { from, to } = this.getDateRange(query);

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        date: { gte: from, lte: to },
        ...(query.userId ? { userId: Number(query.userId) } : {}),
        ...(query.projectId ? { projectId: Number(query.projectId) } : {}),
      },
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
    for (const entry of entries) {
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

  async timesheetToday() {
    const today = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());

    const [clockedIn, entries] = await Promise.all([
      this.prisma.timeClock.findMany({
        where: { date: today },
        include: {
          user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        },
      }),
      this.prisma.timeEntry.findMany({
        where: { date: { gte: today, lte: todayEnd } },
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

  async timesheetActivity(query: ReportQueryDto) {
    const { from, to } = this.getDateRange(query);

    return this.prisma.timeEntry.findMany({
      where: {
        date: { gte: from, lte: to },
        ...(query.userId ? { userId: Number(query.userId) } : {}),
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        project: { select: { id: true, name: true } },
        task: { select: { id: true, name: true } },
      },
      orderBy: { date: 'desc' },
    });
  }

  async attendanceSummary(query: ReportQueryDto) {
    const { from, to } = this.getDateRange(query);

    const records = await this.prisma.timeClock.findMany({
      where: {
        date: { gte: from, lte: to },
        ...(query.userId ? { userId: Number(query.userId) } : {}),
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    // Group by user
    const byUser: Record<number, any> = {};
    for (const record of records) {
      if (!byUser[record.userId]) {
        byUser[record.userId] = {
          user: record.user,
          totalDays: 0,
          presentDays: 0,
          absentDays: 0,
          lateDays: 0,
          totalMinutes: 0,
          overtimeMinutes: 0,
        };
      }
      const u = byUser[record.userId];
      u.totalDays++;
      if (record.status === 'absent') {
        u.absentDays++;
      } else {
        u.presentDays++;
      }
      if (record.isLate) u.lateDays++;
      u.totalMinutes += record.totalMinutes ?? 0;
      u.overtimeMinutes += record.overtimeMinutes ?? 0;
    }

    return Object.values(byUser);
  }

  async overtimeReport(query: ReportQueryDto) {
    const { from, to } = this.getDateRange(query);

    return this.prisma.timeClock.findMany({
      where: {
        date: { gte: from, lte: to },
        overtimeMinutes: { gt: 0 },
        ...(query.userId ? { userId: Number(query.userId) } : {}),
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { date: 'desc' },
    });
  }

  async lateArrivalsReport(query: ReportQueryDto) {
    const { from, to } = this.getDateRange(query);

    return this.prisma.timeClock.findMany({
      where: {
        date: { gte: from, lte: to },
        isLate: true,
        ...(query.userId ? { userId: Number(query.userId) } : {}),
      },
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

  async exportReport(type: string, format: 'excel' | 'pdf', query: ReportQueryDto): Promise<Buffer> {
    // Get report data based on type
    let data: any;
    switch (type) {
      case 'timesheet-by-project':
        data = await this.timesheetByProject(query);
        break;
      case 'attendance':
        data = await this.attendanceSummary(query);
        break;
      case 'overtime':
        data = await this.overtimeReport(query);
        break;
      case 'late-arrivals':
        data = await this.lateArrivalsReport(query);
        break;
      case 'cost-by-project':
        data = await this.costByProject(query);
        break;
      default:
        data = await this.timesheetByProject(query);
    }

    if (format === 'excel') {
      return this.generateExcel(type, data);
    } else {
      return this.generatePdf(type, data);
    }
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
