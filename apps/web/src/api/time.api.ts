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
  minutes: number;
  note?: string;
  isBillable?: boolean;
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
  // Clock
  clockStatus: () =>
    client.get<ApiResponse<ClockStatusResponse>>('/time/clock/status').then((r) => r.data.data),

  clockIn: (payload?: ClockInPayload) =>
    client.post<ApiResponse<TimeClock>>('/time/clock/in', payload).then((r) => r.data.data),

  clockOut: (payload?: ClockOutPayload) =>
    client.post<ApiResponse<TimeClock>>('/time/clock/out', payload).then((r) => r.data.data),

  // Time entries
  listEntries: (params?: { date?: string; weekStart?: string; projectId?: number; taskId?: number }) =>
    client.get<ApiResponse<TimeEntry[]>>('/time/entries', { params }).then((r) => r.data),

  createEntry: (payload: TimeEntryPayload) =>
    client.post<ApiResponse<TimeEntry>>('/time/entries', payload).then((r) => r.data.data),

  updateEntry: (id: number, payload: Partial<TimeEntryPayload>) =>
    client.patch<ApiResponse<TimeEntry>>(`/time/entries/${id}`, payload).then((r) => r.data.data),

  deleteEntry: (id: number) =>
    client.delete(`/time/entries/${id}`).then((r) => r.data),

  // Weekly grid
  weeklyGrid: (params: WeeklyGridQuery) =>
    client.get<ApiResponse<WeeklyGrid>>('/time/weekly-grid', { params }).then((r) => r.data.data),

  // Daily breakdown
  dailyBreakdown: (params: { weekStart: string }) =>
    client.get<ApiResponse<DailyBreakdown[]>>('/time/daily-breakdown', { params }).then((r) => r.data.data),

  // Work schedules
  listSchedules: (userId?: number) =>
    client.get<ApiResponse<WorkSchedule[]>>('/time/schedules', { params: { userId } }).then((r) => r.data.data),

  createSchedule: (payload: WorkSchedulePayload) =>
    client.post<ApiResponse<WorkSchedule>>('/time/schedules', payload).then((r) => r.data.data),

  updateSchedule: (id: number, payload: Partial<WorkSchedulePayload>) =>
    client.patch<ApiResponse<WorkSchedule>>(`/time/schedules/${id}`, payload).then((r) => r.data.data),

  deleteSchedule: (id: number) =>
    client.delete(`/time/schedules/${id}`).then((r) => r.data),

  // Calendar days
  listCalendarDays: (params?: { year?: number; month?: number }) =>
    client.get<ApiResponse<CalendarDay[]>>('/time/calendar-days', { params }).then((r) => r.data.data),

  createCalendarDay: (payload: CalendarDayPayload) =>
    client.post<ApiResponse<CalendarDay>>('/time/calendar-days', payload).then((r) => r.data.data),

  updateCalendarDay: (id: number, payload: Partial<CalendarDayPayload>) =>
    client.patch<ApiResponse<CalendarDay>>(`/time/calendar-days/${id}`, payload).then((r) => r.data.data),

  deleteCalendarDay: (id: number) =>
    client.delete(`/time/calendar-days/${id}`).then((r) => r.data),

  // Team clock dashboard
  teamDashboard: () =>
    client.get<ApiResponse<TeamClockDashboard>>('/time/clock/dashboard').then((r) => r.data.data),
};
