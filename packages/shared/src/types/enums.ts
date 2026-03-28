export const PROJECT_STATUSES = ['draft', 'active', 'on_hold', 'completed', 'cancelled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TASK_STATUSES = [
  'not_started',
  'in_progress',
  'in_review',
  'completed',
  'on_hold',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const CONTRACT_STATUSES = ['draft', 'active', 'completed', 'cancelled'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const BILLING_STATUSES = ['draft', 'sent', 'approved', 'paid', 'rejected'] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const BILLING_TYPES = ['generated', 'requested'] as const;
export type BillingType = (typeof BILLING_TYPES)[number];

export const USER_TYPES = ['employee', 'partner', 'both'] as const;
export type UserType = (typeof USER_TYPES)[number];

export const EXPENSE_TYPES = [
  'material',
  'labor',
  'travel',
  'equipment',
  'subcontractor',
  'other',
] as const;
export type ExpenseType = (typeof EXPENSE_TYPES)[number];

export const CLOCK_STATUSES = [
  'clocked_in',
  'completed',
  'auto_closed',
  'edited',
  'absent',
  'leave',
  'sick',
] as const;
export type ClockStatus = (typeof CLOCK_STATUSES)[number];

export const CLOCK_TYPES = ['regular', 'overtime', 'remote', 'field'] as const;
export type ClockType = (typeof CLOCK_TYPES)[number];

export const CALENDAR_DAY_TYPES = ['holiday', 'company_day_off', 'half_day', 'special'] as const;
export type CalendarDayType = (typeof CALENDAR_DAY_TYPES)[number];

export const ACTIVITY_CATEGORIES = [
  'auth',
  'project',
  'task',
  'time',
  'contract',
  'user',
  'system',
  'admin',
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const SEVERITY_LEVELS = ['info', 'warn', 'error', 'critical'] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

export const ATTENDANCE_APPLIES_TO = ['all', 'employees_only', 'partners_only'] as const;
export type AttendanceAppliesTo = (typeof ATTENDANCE_APPLIES_TO)[number];
