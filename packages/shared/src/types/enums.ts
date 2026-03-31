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

// ─── V6 Enums (Zone/Service model) ──────────────────────────────────────

export const DELIVERABLE_SCOPES = ['project', 'per_zone', 'per_building'] as const;
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

export const PRICING_METHODS = ['fixed_fee', 'time_materials', 'recurring'] as const;
export type PricingMethod = (typeof PRICING_METHODS)[number];

export const PAYMENT_TRIGGERS = ['upon_invoice', 'completion', 'milestones', 'monthly'] as const;
export type PaymentTrigger = (typeof PAYMENT_TRIGGERS)[number];

export const CHANGE_ORDER_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number];

export const REVIEW_STATUSES = ['pending', 'approved', 'changes_requested'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

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

export const TEMPLATE_TYPES = ['combined', 'zone_only', 'service_only', 'deliverable_only'] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

// ─── V7 Enums (Zone types as constants) ─────────────────────────────────────

export const ZONE_TYPES = ['site', 'building', 'level', 'zone', 'area', 'section', 'wing', 'floor'] as const;
export type ZoneType = (typeof ZONE_TYPES)[number];

export const ZONE_DISPLAY: Record<ZoneType, { icon: string; color: string }> = {
  site: { icon: 'MapPin', color: '#6B7280' },
  building: { icon: 'Building2', color: '#3B82F6' },
  level: { icon: 'Layers', color: '#10B981' },
  zone: { icon: 'Grid3x3', color: '#F59E0B' },
  area: { icon: 'Square', color: '#8B5CF6' },
  section: { icon: 'LayoutGrid', color: '#14B8A6' },
  wing: { icon: 'ArrowLeftRight', color: '#EC4899' },
  floor: { icon: 'Minus', color: '#6B7280' },
};
