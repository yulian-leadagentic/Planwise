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
            label: { select: { id: true, name: true, path: true } },
          },
        },
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    const grouped: Record<number, any> = {};
    for (const entry of entries) {
      const labelId = entry.task?.label?.id ?? 0;
      if (!grouped[labelId]) {
        grouped[labelId] = {
          label: entry.task?.label || { id: 0, name: 'No Label', path: '' },
          totalMinutes: 0,
          entries: [],
        };
      }
      grouped[labelId].totalMinutes += entry.minutes;
      grouped[labelId].entries.push(entry);
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
            label: { select: { id: true, name: true, path: true } },
            assignees: { select: { hourlyRate: true, userId: true } },
          },
        },
        user: { select: { id: true } },
      },
    });

    const byLabel: Record<number, any> = {};
    for (const entry of entries) {
      const labelId = entry.task?.label?.id ?? 0;
      if (!byLabel[labelId]) {
        byLabel[labelId] = {
          label: entry.task?.label || { id: 0, name: 'Unknown' },
          totalMinutes: 0,
          estimatedCost: 0,
        };
      }
      byLabel[labelId].totalMinutes += entry.minutes;

      const assignee = entry.task?.assignees?.find((a) => a.userId === entry.userId);
      if (assignee?.hourlyRate) {
        byLabel[labelId].estimatedCost += (entry.minutes / 60) * Number(assignee.hourlyRate);
      }
    }

    return Object.values(byLabel);
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
