import { ClockStatus, ClockType, CalendarDayType, AttendanceAppliesTo } from './enums';

export interface WorkSchedule {
  id: number;
  userId: number;
  name: string;
  dayOfWeek: number;
  shiftStart: string;
  shiftEnd: string;
  breakMinutes: number;
  isActive: boolean;
  effectiveFrom: string;
  effectiveUntil: string | null;
}

export interface CalendarDay {
  id: number;
  date: string;
  name: string;
  type: CalendarDayType;
  halfDayUntil: string | null;
  appliesTo: AttendanceAppliesTo;
  isRecurring: boolean;
  notes: string | null;
}

export interface TimeClock {
  id: number;
  userId: number;
  date: string;
  clockIn: string;
  clockOut: string | null;
  breakMinutes: number;
  status: ClockStatus;
  clockType: ClockType;
  note: string | null;
  documentUrl: string | null;
  approvedBy: number | null;
  approvedAt: string | null;
  editedBy: number | null;
  editedReason: string | null;
  totalMinutes: number | null;
  expectedMinutes: number | null;
  overtimeMinutes: number | null;
  isLate: boolean;
  lateMinutes: number;
  user?: {
    id: number;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
  };
}

export interface TimeEntry {
  id: number;
  userId: number;
  timeClockId: number | null;
  projectId: number | null;
  taskId: number | null;
  date: string;
  minutes: number;
  note: string | null;
  isBillable: boolean;
  createdAt: string;
  task?: {
    id: number;
    name: string;
    label?: { name: string; projectName?: string };
  };
  project?: {
    id: number;
    name: string;
  };
}

export interface ClockStatusResponse {
  isClockedIn: boolean;
  clockInAt?: string;
  elapsedMinutes?: number;
  expectedMinutes?: number;
  todayRecord?: TimeClock;
}

export interface WeeklyGrid {
  weekStart: string;
  rows: WeeklyGridRow[];
  clock: Record<string, { clockIn: string; clockOut: string | null; totalMinutes: number | null; expectedMinutes: number | null }>;
  dailyTotals: Record<string, { logged: number; clocked: number | null; diff: number | null }>;
  weekSummary: {
    totalLogged: number;
    totalClocked: number;
    totalExpected: number;
    overtimeMinutes: number;
    missingMinutes: number;
  };
}

export interface WeeklyGridRow {
  type: 'task' | 'project';
  taskId?: number;
  projectId?: number;
  taskName?: string;
  projectName: string;
  labelPath?: string;
  days: Record<string, { id: number; minutes: number } | null>;
  weekTotalMinutes: number;
  budgetHours?: number;
}

export interface DailyBreakdown {
  date: string;
  clock: TimeClock | null;
  expected: { shiftStart: string; shiftEnd: string; breakMinutes: number; expectedMinutes: number } | null;
  entries: TimeEntry[];
  totalLogged: number;
  difference: number | null;
  isBalanced: boolean;
}

export interface TeamClockDashboard {
  clockedIn: (TimeClock & { user: { id: number; firstName: string; lastName: string; avatarUrl: string | null } })[];
  notYet: { user: { id: number; firstName: string; lastName: string }; expectedShiftStart: string }[];
  late: (TimeClock & { user: { id: number; firstName: string; lastName: string } })[];
  onLeave: (TimeClock & { user: { id: number; firstName: string; lastName: string } })[];
}
