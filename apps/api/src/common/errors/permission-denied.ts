/**
 * One clear, consistent "you may not do this" answer (permission
 * messages, 2026-11-20).
 *
 * Every refusal that is about WHO the caller is — a missing grant in the
 * Roles matrix, an Admin-only / HR-only rule, "only your own …", not a
 * member of the project — throws `PermissionDeniedException`. The global
 * HttpExceptionFilter turns it into
 *
 *   403 { success: false, error: { code: 'PERMISSION_DENIED', message, details } }
 *
 * with `details` = `{ module, action }` for matrix grants, `{ field }`
 * for protected-field rules and `{ reason }` for the rest. The web client
 * renders it as a "No permission" alert instead of an error.
 *
 * Messages are for end users: plain English, one sentence plus a hint
 * on who can help. Never put permission keys (`finance:write`), module
 * routes or raw field names (`budgetAmount`) into the message — the
 * machine-readable part goes into `details`.
 *
 * A 403 that is NOT about the caller (a built-in role that can't be
 * renamed, a read-only system preset, an SSO configuration problem)
 * stays a plain `ForbiddenException` — optionally with its own `code`.
 */
import { ForbiddenException, HttpStatus } from '@nestjs/common';

export const PERMISSION_DENIED = 'PERMISSION_DENIED';

export type PermissionAction = 'read' | 'write' | 'delete' | 'approve' | 'export';

export interface PermissionDeniedDetails {
  /** Roles-matrix module key, e.g. `finance`, `admin/roles`. */
  module?: string;
  action?: PermissionAction;
  /** The protected field a field rule refused (first one when several). */
  field?: string;
  /** Every refused field, when more than one. */
  fields?: string[];
  /** Machine-readable reason for rules outside the matrix, e.g. `NOT_PROJECT_MEMBER`. */
  reason?: string;
}

export class PermissionDeniedException extends ForbiddenException {
  readonly details: PermissionDeniedDetails;

  constructor(message: string, details: PermissionDeniedDetails = {}) {
    super({
      statusCode: HttpStatus.FORBIDDEN,
      error: 'Forbidden',
      code: PERMISSION_DENIED,
      message,
      details,
    });
    this.details = details;
  }
}

/** Default hint appended to matrix refusals. */
export const ASK_ADMIN = 'Ask your administrator for access.';

/**
 * Human name of each Roles-matrix module, written to read after a verb
 * ("You don't have permission to view <area>"). Keys are the module
 * routes without the leading slash, as seeded in `prisma/seed.ts`,
 * `seed-runner.js` and the module migrations, plus the keys controllers
 * pass to `@RequirePermissions` / `userHasModulePermission`.
 */
export const MODULE_LABELS: Readonly<Record<string, string>> = {
  '': 'the dashboard',
  dashboard: 'the dashboard',
  tasks: 'tasks',
  'tasks/edit-due-date': 'task due dates',
  'task-approval': 'task approvals',
  'task-reassignment': 'task reassignment',
  time: 'time entries',
  'time-approval': 'time approvals',
  projects: 'projects',
  'projects/files': 'project files',
  'project-planning': 'project planning',
  contracts: 'contracts',
  partners: 'people & contacts',
  people: 'people',
  reports: 'reports',
  templates: 'templates',
  'templates/task-catalog': 'the task catalog',
  'templates/deliverables': 'deliverable templates',
  'templates/zone': 'zone templates',
  'templates/team': 'team templates',
  'templates/services': 'services',
  'templates/types': 'template types',
  'task-templates': 'task templates',
  'zone-templates': 'zone templates',
  admin: 'admin settings',
  'admin/roles': 'roles and permissions',
  roles: 'roles and permissions',
  'admin/partner-types': 'partner types',
  'admin/number-ranges': 'number ranges',
  'admin/object-numbering': 'object numbering',
  'admin/work-schedules': 'work schedules',
  'admin/project-role-types': 'project role types',
  'admin/calendar': 'the work calendar',
  calendar: 'the work calendar',
  'admin/activity-log': 'the activity log',
  'admin/currencies': 'currencies',
  'admin/notification-settings': 'notification settings',
  'admin/clock-dashboard': 'the team clock dashboard',
  'personal-data': 'personal data',
  org: 'the organization structure',
  hr: 'HR data',
  finance: 'financial data',
  'data-import': 'data imports',
  'data-import/users': 'employee imports',
  'data-import/partners': 'partner imports',
  'data-import/contacts': 'contact imports',
  'data-import/projects': 'project imports',
};

/** Verb per matrix action. */
const ACTION_VERBS: Readonly<Record<PermissionAction, string>> = {
  read: 'view',
  write: 'change',
  delete: 'delete',
  approve: 'approve',
  export: 'export',
};

/** Whole phrases where "<verb> <area>" would read badly. */
const PHRASE_OVERRIDES: Readonly<Record<string, string>> = {
  'finance:approve': 'approve billings',
  'hr:approve': 'approve monthly HR reviews',
  'hr:export': 'export HR reports',
  'time:approve': 'approve time records',
  'data-import:write': 'run data imports',
  'data-import:delete': 'roll back data imports',
  'data-import/users:write': 'import employees',
  'data-import/partners:write': 'import partners',
  'data-import/contacts:write': 'import contacts',
  'data-import/projects:write': 'import projects',
};

function normalizeModule(module: string | null | undefined): string {
  return String(module ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/**
 * Human name of a module ("financial data", "roles and permissions").
 * Unknown keys fall back to their last path segment, prettified
 * (`admin/label-types` → "label types").
 */
export function describeModule(module: string | null | undefined): string {
  const key = normalizeModule(module);
  const known = MODULE_LABELS[key];
  if (known !== undefined) return known;
  const last = key.split('/').filter(Boolean).pop() ?? '';
  const pretty = last.replace(/[-_]+/g, ' ').trim();
  return pretty || 'this area';
}

/** "view HR data", "change financial data", "approve billings". */
export function describePermission(module: string | null | undefined, action: string): string {
  const key = normalizeModule(module);
  const override = PHRASE_OVERRIDES[`${key}:${action}`];
  if (override) return override;
  const verb = ACTION_VERBS[action as PermissionAction] ?? 'use';
  return `${verb} ${describeModule(key)}`;
}

/** "You don't have permission to change financial data. Ask your administrator for access." */
export function permissionDeniedMessage(module: string | null | undefined, action: string): string {
  return `You don't have permission to ${describePermission(module, action)}. ${ASK_ADMIN}`;
}

/** The standard matrix refusal for `module` / `action`. */
export function permissionDenied(module: string, action: PermissionAction): PermissionDeniedException {
  return new PermissionDeniedException(permissionDeniedMessage(module, action), {
    module: normalizeModule(module),
    action,
  });
}

/** "a", "a and b", "a, b and c". */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** `someFieldName` → "some field name" (fallback for unmapped fields). */
export function prettifyFieldName(field: string): string {
  return field
    .replace(/Id$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase();
}
