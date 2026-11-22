import { UserType } from './enums';

/**
 * Permissions round 3 (privacy, 2026-11-22) — `GET /users[/:id]` returns
 * a different set of fields per caller (apps/api users/user-visibility.ts):
 *
 *   • directory (everyone with the route): id, names (+ Hebrew), email,
 *     phone, avatarUrl, userType, position, orgUnitId/orgUnit,
 *     companyName, businessPartnerId;
 *   • account (Admin, HR, the user himself): code, roleId/role/roleName,
 *     isActive, lastLoginAt, createdAt, seniorityLevelId/seniorityLevel;
 *   • personal (HR, the user himself): employment dates, daily standard
 *     hours, employee category, employment type, payroll number, taxId,
 *     address, website.
 *
 * So every account / personal field is optional here: "absent" means
 * "you may not see it", not "empty". Never default an absent field into
 * a write (the edit modal sends only fields it loaded AND changed).
 */

/** Personal tier — HR (`hr:read`) and the user himself only. */
export interface UserPersonalFields {
  employmentDate?: string | null;
  employmentEndDate?: string | null;
  /** Decimal — serialized as a string ("8.4") by the users routes. */
  dailyStandardHours?: string | number | null;
  employeeCategory?: string | null;
  employmentType?: 'GLOBAL' | 'HOURLY' | null;
  accountingEmployeeNumber?: string | null;
  taxId?: string | null;
  address?: string | null;
  website?: string | null;
}

export interface User extends UserPersonalFields {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  firstNameHe?: string | null;
  lastNameHe?: string | null;
  phone: string | null;
  avatarUrl: string | null;
  /** Account tier (Admin / HR / himself). */
  code?: string | null;
  /** Account tier (Admin / HR / himself); always present on `/auth/me`. */
  roleId?: number;
  roleName?: string;
  userType: UserType;
  position: string | null;
  /**
   * Retire-User.department Step 3/3 (2026-09-28) — free-text
   * `department` is retired. Org membership lives on the `orgUnit`
   * relation only.
   */
  orgUnitId?: number | null;
  orgUnit?: { id: number; name: string } | null;
  companyName: string | null;
  businessPartnerId?: number | null;
  /** Account tier (Admin / HR / himself). */
  isActive?: boolean;
  lastLoginAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  seniorityLevelId?: number | null;
  seniorityLevel?: { id: number; code?: string; name: string; currency?: string | null } | null;
  /**
   * §14 RBAC multi-role (2026-10-18) — every role granted to this
   * user. Rendered as chips in the admin user-edit modal; permission
   * reads use the merged `roleModules` array below (OR union across
   * these roles). Legacy `roleId` is kept as the "primary (legacy)"
   * display chip and never gates runtime permissions on its own.
   */
  roles?: Array<{ id: number; name: string }>;
  /**
   * §14 — merged OR-union of every granted role's `role_modules`.
   * The permission hook reads this; pre-handover it still mirrors
   * the single-role list the server used to send.
   */
  roleModules?: Array<{
    moduleId: number;
    canRead: boolean;
    canWrite: boolean;
    canDelete: boolean;
    canApprove: boolean;
    canExport: boolean;
    module?: { id: number; name: string; route: string };
  }>;
  /** §14 — true when any granted role is named 'Admin'. */
  isAdmin?: boolean;
}

/** A `GET /users` row — see the tier note on `User` above. */
export interface UserListItem extends UserPersonalFields {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  firstNameHe?: string | null;
  lastNameHe?: string | null;
  phone?: string | null;
  avatarUrl: string | null;
  userType: UserType;
  position: string | null;
  /** See User — free-text `department` retired; `orgUnit` is the source of truth. */
  orgUnitId?: number | null;
  orgUnit?: { id: number; name: string } | null;
  companyName: string | null;
  /** Account tier (Admin / HR). */
  code?: string | null;
  roleId?: number;
  roleName?: string | null;
  isActive?: boolean;
  lastLoginAt?: string | null;
  createdAt?: string;
  seniorityLevelId?: number | null;
  seniorityLevel?: { id: number; code?: string; name: string; currency?: string | null } | null;
  /** Admin / HR with finance:read only. */
  effectiveHourlyCost?: number | null;
  rateSource?: 'override' | 'level' | 'default' | null;
  /**
   * QA4 JT-3b-2 (2026-09-29) — linked BusinessPartner id, when present.
   * The People edit modal uses this to edit the person's Qualifications
   * (`business_partner_professions`) alongside their User fields. Kept
   * optional because non-employee users (rare, and the auth flow tends
   * to auto-link one) may not have a BP.
   */
  businessPartnerId?: number | null;
}
