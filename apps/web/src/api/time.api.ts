import client from './client';
import type {
  ApiResponse,
  TimeClock,
  TimeEntry,
  ClockStatusResponse,
  WeeklyGrid,
  DailyBreakdown,
  WorkSchedule,
  CalendarDay,
  TeamClockDashboard,
} from '@/types';

export interface ClockInPayload {
  clockType?: string;
  note?: string;
}

export interface ClockOutPayload {
  breakMinutes?: number;
  note?: string;
}

export interface TimeEntryPayload {
  taskId?: number;
  projectId?: number;
  date: string;
  startTime?: string;
  endTime?: string;
  minutes: number;
  note?: string;
  isBillable?: boolean;
  location?: string;
  completionPct?: number;
}

export interface WeeklyGridQuery {
  weekStart: string;
  projectId?: number;
}

export interface CalendarDayPayload {
  date: string;
  name: string;
  type: string;
  halfDayUntil?: string;
  appliesTo?: string;
  isRecurring?: boolean;
  notes?: string;
}

export interface WorkSchedulePayload {
  userId: number;
  name: string;
  dayOfWeek: number;
  shiftStart: string;
  shiftEnd: string;
  breakMinutes?: number;
  effectiveFrom: string;
  effectiveUntil?: string;
}

export const timeApi = {
  // Clock — backend: TimeClockController at /time-clock
  clockStatus: () =>
    client.get<ApiResponse<ClockStatusResponse>>('/time-clock/status').then((r) => r.data.data),

  clockIn: (payload?: ClockInPayload) =>
    client.post<ApiResponse<TimeClock>>('/time-clock/clock-in', payload).then((r) => r.data.data),

  clockOut: (payload?: ClockOutPayload) =>
    client.post<ApiResponse<TimeClock>>('/time-clock/clock-out', payload).then((r) => r.data.data),

  // Time entries — backend: TimeEntriesController at /time-entries
  listEntries: (params?: { date?: string; weekStart?: string; projectId?: number; taskId?: number }) =>
    client.get<ApiResponse<TimeEntry[]>>('/time-entries', { params }).then((r) => r.data),

  createEntry: (payload: TimeEntryPayload) =>
    client.post<ApiResponse<TimeEntry>>('/time-entries', payload).then((r) => r.data.data),

  updateEntry: (id: number, payload: Partial<TimeEntryPayload>) =>
    client.patch<ApiResponse<TimeEntry>>(`/time-entries/${id}`, payload).then((r) => r.data.data),

  deleteEntry: (id: number) =>
    client.delete(`/time-entries/${id}`).then((r) => r.data),

  // Weekly grid — backend: GET /time-entries/weekly
  weeklyGrid: (params: WeeklyGridQuery) =>
    client.get('/time-entries/weekly', { params }).then((r) => {
      const d = r.data;
      // Handle both wrapped { success, data: {...} } and direct response
      if (d?.data?.rows) return d.data;
      if (d?.rows) return d;
      return d?.data ?? d;
    }),

  // Daily breakdown — backend: GET /time-entries/daily
  dailyBreakdown: (params: { weekStart: string }) =>
    client.get<ApiResponse<DailyBreakdown[]>>('/time-entries/daily', { params }).then((r) => r.data.data),

  // Work schedules — backend: WorkSchedulesController at /work-schedules
  listSchedules: (userId?: number) =>
    client.get<ApiResponse<WorkSchedule[]>>('/work-schedules', { params: { userId } }).then((r) => r.data.data),

  createSchedule: (payload: WorkSchedulePayload) =>
    client.post<ApiResponse<WorkSchedule>>('/work-schedules', payload).then((r) => r.data.data),

  updateSchedule: (id: number, payload: Partial<WorkSchedulePayload>) =>
    client.patch<ApiResponse<WorkSchedule>>(`/work-schedules/${id}`, payload).then((r) => r.data.data),

  deleteSchedule: (id: number) =>
    client.delete(`/work-schedules/${id}`).then((r) => r.data),

  // Calendar days — backend: CalendarController at /calendar
  listCalendarDays: (params?: { year?: number; month?: number }) =>
    client.get<ApiResponse<CalendarDay[]>>('/calendar', { params }).then((r) => r.data.data),

  createCalendarDay: (payload: CalendarDayPayload) =>
    client.post<ApiResponse<CalendarDay>>('/calendar', payload).then((r) => r.data.data),

  updateCalendarDay: (id: number, payload: Partial<CalendarDayPayload>) =>
    client.patch<ApiResponse<CalendarDay>>(`/calendar/${id}`, payload).then((r) => r.data.data),

  deleteCalendarDay: (id: number) =>
    client.delete(`/calendar/${id}`).then((r) => r.data),

  // Team clock dashboard — backend: GET /time-clock/today
  teamDashboard: () =>
    client.get<ApiResponse<TeamClockDashboard>>('/time-clock/today').then((r) => r.data.data),
};
