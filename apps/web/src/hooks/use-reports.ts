import { useQuery } from '@tanstack/react-query';
import { reportsApi } from '@/api/reports.api';
import type { ReportQuery } from '@/api/reports.api';

export function useTimesheetReport(params: ReportQuery) {
  return useQuery({
    queryKey: ['reports', 'timesheet', params],
    queryFn: () => reportsApi.timesheet(params),
    enabled: !!params.dateFrom && !!params.dateTo,
  });
}

export function useAttendanceReport(params: ReportQuery) {
  return useQuery({
    queryKey: ['reports', 'attendance', params],
    queryFn: () => reportsApi.attendance(params),
    enabled: !!params.dateFrom && !!params.dateTo,
  });
}

export function useCostReport(params: ReportQuery) {
  return useQuery({
    queryKey: ['reports', 'cost', params],
    queryFn: () => reportsApi.cost(params),
    enabled: !!params.dateFrom && !!params.dateTo,
  });
}

export function useOvertimeReport(params: ReportQuery) {
  return useQuery({
    queryKey: ['reports', 'overtime', params],
    queryFn: () => reportsApi.overtime(params),
    enabled: !!params.dateFrom && !!params.dateTo,
  });
}
