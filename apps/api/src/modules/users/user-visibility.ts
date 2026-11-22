/**
 * Who sees which User fields on the `/users` routes (permissions round 3
 * — privacy, 2026-11-22).
 *
 * Owner decisions, three tiers:
 *
 *   • Directory — everyone who may open the route: name (+ Hebrew),
 *     email, phone (the owner counts phone as directory info), avatar,
 *     user type, position, org unit, company name, linked partner id.
 *   • Account — Admin and HR (`hr:read`) additionally: employee number
 *     (`code`), access role, active state, last login, created at, labor
 *     category (its cost still goes through the global finance
 *     redaction). Only they may list inactive users or filter by role.
 *   • Personal — HR (`hr:read`) and the user himself additionally:
 *     employment dates, daily standard hours, employee category,
 *     employment type, payroll number, tax ID, address, website. An
 *     Admin WITHOUT `hr` does not get this tier (except on his own
 *     record) — `hr` is in the RolesGuard's NO_ADMIN_BYPASS set.
 *
 * `role.roleModules` (a user's whole permission matrix) on
 * `GET /users/:id`: Admin or the user himself only.
 *
 * The user himself also gets the account tier on his own record (it is
 * the same data `/auth/me` already returns to him).
 *
 * Shaping is done here, in the users service, by building the Prisma
 * `select` per caller — never by stripping key names in an interceptor,
 * which cannot tell a user's phone from a contact's phone. Fields a
 * caller may not see are not even loaded.
 *
 * Write side: personal-tier fields change only with `hr:write`
 * (`assertPersonalFieldWrites` in UsersService); sending the stored
 * value back passes silently.
 */
import { isAdminUser, userHasModulePermission } from '../../common/guards/roles.guard';
import { permissionDenied } from '../../common/errors/permission-denied';

/** Directory tier — every caller of `GET /users[/:id]`. */
export const USER_DIRECTORY_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  // T3.3 — Hebrew names, for the bilingual pickers and the edit modal.
  firstNameHe: true,
  lastNameHe: true,
  email: true,
  phone: true,
  avatarUrl: true,
  userType: true,
  position: true,
  // Retire-User.department Step 3/3 — OrgUnit is the sole source of
  // truth for org-tree membership.
  orgUnitId: true,
  orgUnit: { select: { id: true, name: true } },
  companyName: true,
  // QA4 JT-3b-2 — the edit modal edits Qualifications on the linked BP;
  // the partners page resolves `?focus=<userId>` through it.
  businessPartnerId: true,
} as const;

/** Account tier — Admin, HR (`hr:read`) and the user himself. */
export const USER_ACCOUNT_SELECT = {
  code: true,
  roleId: true,
  role: { select: { id: true, name: true } },
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  seniorityLevelId: true,
  // `defaultHourlyCost` is removed by the global FinanceRedactionInterceptor
  // for callers without finance:read.
  seniorityLevel: { select: { id: true, code: true, name: true, defaultHourlyCost: true, currency: true } },
} as const;

/** Personal tier — HR (`hr:read`) and the user himself. */
export const USER_PERSONAL_SELECT = {
  employmentDate: true,
  employmentEndDate: true,
  dailyStandardHours: true,
  employeeCategory: true,
  employmentType: true,
  accountingEmployeeNumber: true,
  taxId: true,
  address: true,
  website: true,
} as const;

/**
 * Personal-tier fields `PATCH /users/:id` / `POST /users` accept
 * (`employmentType` and `accountingEmployeeNumber` are written only by the
 * HR module's `/hr/employees/:id`). Changing any of them needs `hr:write`.
 */
export const USER_PERSONAL_WRITE_FIELDS = [
  'employmentDate',
  'employmentEndDate',
  'dailyStandardHours',
  'employeeCategory',
  'taxId',
  'address',
  'website',
] as const;
export type UserPersonalWriteField = (typeof USER_PERSONAL_WRITE_FIELDS)[number];

/** End-user names, written to read after "You can't change …". */
export const USER_PERSONAL_FIELD_LABELS: Readonly<Record<UserPersonalWriteField, string>> = {
  employmentDate: 'the employment start date',
  employmentEndDate: 'the employment end date',
  dailyStandardHours: 'the daily standard hours',
  employeeCategory: 'the employee category',
  taxId: 'the tax ID',
  address: 'the address',
  website: 'the website',
};

export interface UserFieldAccess {
  /** code, role, active state, last login, created at, labor category. */
  account: boolean;
  /** employment dates, daily standard, payroll no., tax ID, address, website. */
  personal: boolean;
  /** the role's whole permission matrix (`role.roleModules`). */
  roleModules: boolean;
}

function isHrReader(actor: any): boolean {
  return userHasModulePermission(actor, 'hr', 'read');
}

/**
 * Who may open the people directory — `GET /users`, `GET /users/:id`
 * (and the labor-category history): Admin, `partners:read` or `hr:read`
 * (round 3 follow-up: HR roles hold `hr` but not `partners`).
 *
 * Checked by hand, not with `@RequirePermissions`: decorator entries are
 * ANDed, and `hr` is in the RolesGuard's NO_ADMIN_BYPASS set, so a
 * decorator naming `hr` would also switch the Admin bypass off. The
 * Admin bypass here is the guard's own rule for `partners` (isAdminUser).
 */
export function canReadPeopleDirectory(actor: any): boolean {
  if (!actor) return false;
  return isAdminUser(actor) || userHasModulePermission(actor, 'partners', 'read') || isHrReader(actor);
}

/** 403 "You don't have permission to view people & contacts…" unless allowed. */
export function assertCanReadPeopleDirectory(actor: any): void {
  if (!canReadPeopleDirectory(actor)) throw permissionDenied('partners', 'read');
}

/**
 * Which tiers `actor` sees on the record of user `targetId`. Pass no
 * target for a list: a list never applies the "himself" rule per row.
 */
export function userFieldAccess(actor: any, targetId?: number | null): UserFieldAccess {
  const self = targetId != null && actor?.id != null && actor.id === targetId;
  const admin = isAdminUser(actor);
  const hrRead = isHrReader(actor);
  return {
    account: admin || hrRead || self,
    personal: hrRead || self,
    roleModules: admin || self,
  };
}

/** Admin or HR (`hr:read`) — may list inactive users and filter by role. */
export function canSeeAccountDirectory(actor: any): boolean {
  return isAdminUser(actor) || isHrReader(actor);
}

/** HR (`hr:write`) — may change personal-tier fields. No Admin bypass. */
export function canWritePersonalFields(actor: any): boolean {
  return userHasModulePermission(actor, 'hr', 'write');
}

/**
 * The Prisma `select` for one caller. `roleModules` swaps the account
 * tier's `{ id, name }` role for the full role row with its grants.
 */
export function buildUserSelect(access: UserFieldAccess): Record<string, unknown> {
  return {
    ...USER_DIRECTORY_SELECT,
    ...(access.account ? USER_ACCOUNT_SELECT : {}),
    ...(access.account && access.roleModules
      ? { role: { include: { roleModules: { include: { module: true } } } } }
      : {}),
    ...(access.personal ? USER_PERSONAL_SELECT : {}),
  };
}

// ─── Personal-field change detection ────────────────────────────────

function normalizeText(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s === '' ? null : s;
}

/** `Date` (Prisma @db.Date) or "yyyy-mm-dd[…]" → "yyyy-mm-dd"; empty → null. */
function normalizeDate(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

function normalizeNumber(v: unknown): number | string | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : String(v);
}

function samePersonalValue(field: UserPersonalWriteField, incoming: unknown, stored: unknown): boolean {
  if (field === 'employmentDate' || field === 'employmentEndDate') {
    return normalizeDate(incoming) === normalizeDate(stored);
  }
  if (field === 'dailyStandardHours') {
    // An explicit null is dropped by the service (NOT NULL column) — a no-op.
    if (incoming === null) return true;
    const a = normalizeNumber(incoming);
    const b = normalizeNumber(stored);
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.005;
    return a === b;
  }
  return normalizeText(incoming) === normalizeText(stored);
}

/**
 * The personal-tier fields `incoming` would change compared with
 * `existing` (null for a create: every non-empty value is a change).
 * A field counts only when `incoming` carries it with a defined value.
 */
export function findPersonalFieldChanges(
  incoming: Record<string, any> | null | undefined,
  existing: Record<string, any> | null | undefined,
): UserPersonalWriteField[] {
  if (!incoming || typeof incoming !== 'object') return [];
  const base = existing ?? {};
  return USER_PERSONAL_WRITE_FIELDS.filter(
    (f) =>
      Object.prototype.hasOwnProperty.call(incoming, f) &&
      incoming[f] !== undefined &&
      !samePersonalValue(f, incoming[f], existing ? base[f] : null),
  );
}
