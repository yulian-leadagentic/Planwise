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

export const PROJECT_ROLES = [
  'project_leader',
  'bim_manager',
  'bim_lead',
  'mep_coordinator',
  'mep_lead',
  'coordinator',
  'professional_employee',
  'viewer',
] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

// ─── V8 Enums ───────────────────────────────────────────────────────────────

export const ZONE_TYPES = ['site', 'building', 'level', 'zone', 'area', 'section', 'wing', 'floor'] as const;
export type ZoneType = (typeof ZONE_TYPES)[number];

export const ZONE_DISPLAY: Record<ZoneType, { icon: string; color: string; label: string }> = {
  site: { icon: 'MapPin', color: '#6B7280', label: 'Site' },
  building: { icon: 'Building2', color: '#3B82F6', label: 'Building' },
  level: { icon: 'Layers', color: '#10B981', label: 'Level' },
  zone: { icon: 'Grid3x3', color: '#F59E0B', label: 'Zone' },
  area: { icon: 'Square', color: '#8B5CF6', label: 'Area' },
  section: { icon: 'LayoutGrid', color: '#14B8A6', label: 'Section' },
  wing: { icon: 'ArrowLeftRight', color: '#EC4899', label: 'Wing' },
  floor: { icon: 'Minus', color: '#6B7280', label: 'Floor' },
};

export const TEMPLATE_TYPES = ['task_list', 'zone', 'combined'] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

export const SERVICE_TYPE_COLORS: Record<string, string> = {
  BIM: '#3B82F6',
  MEP: '#10B981',
  STR: '#EF4444',
  ARCH: '#8B5CF6',
  INFRA: '#F59E0B',
  FIRE: '#DC2626',
  ACO: '#06B6D4',
};

// ─── V8 Service / Deliverable / Assignment Enums ───────────────────────────
// Used by service.types.ts (Service / Deliverable / Assignment models).
// Kept as string-literal unions so they erase at runtime — no JS overhead.

export const DELIVERABLE_SCOPES = ['project', 'zone'] as const;
export type DeliverableScope = (typeof DELIVERABLE_SCOPES)[number];

export const ASSIGNMENT_STATUSES = [
  'not_started',
  'in_progress',
  'in_review',
  'completed',
  'on_hold',
  'cancelled',
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const ASSIGNMENT_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type AssignmentPriority = (typeof ASSIGNMENT_PRIORITIES)[number];
