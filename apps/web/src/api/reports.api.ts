import client from './client';
import type { ApiResponse, TimesheetReport, AttendanceReport, CostReport } from '@/types';

export interface ReportQuery {
  dateFrom: string;
  dateTo: string;
  projectId?: number;
  userId?: number;
  groupBy?: string;
}

export interface OvertimeReport {
  rows: {
    userId: number;
    userName: string;
    totalOvertimeMinutes: number;
    dates: Record<string, number>;
  }[];
}

export const reportsApi = {
  timesheet: (params: ReportQuery) =>
    client.get<ApiResponse<TimesheetReport>>('/reports/timesheet', { params }).then((r) => r.data.data),

  attendance: (params: ReportQuery) =>
    client.get<ApiResponse<AttendanceReport>>('/reports/attendance', { params }).then((r) => r.data.data),

  cost: (params: ReportQuery) =>
    client.get<ApiResponse<CostReport>>('/reports/cost', { params }).then((r) => r.data.data),

  overtime: (params: ReportQuery) =>
    client.get<ApiResponse<OvertimeReport>>('/reports/overtime', { params }).then((r) => r.data.data),

  exportCsv: (report: string, params: ReportQuery) =>
    client.get(`/reports/${report}/export`, { params, responseType: 'blob' }).then((r) => r.data),
};
