import { UserType } from './enums';

export interface User {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  avatarUrl: string | null;
  roleId: number;
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
  taxId: string | null;
  address: string | null;
  website: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface UserListItem {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  userType: UserType;
  position: string | null;
  /** See User — free-text `department` retired; `orgUnit` is the source of truth. */
  orgUnitId?: number | null;
  orgUnit?: { id: number; name: string } | null;
  companyName: string | null;
  roleId: number;
  roleName: string;
  isActive: boolean;
  /**
   * QA4 JT-3b-2 (2026-09-29) — linked BusinessPartner id, when present.
   * The People edit modal uses this to edit the person's Qualifications
   * (`business_partner_professions`) alongside their User fields. Kept
   * optional because non-employee users (rare, and the auth flow tends
   * to auto-link one) may not have a BP.
   */
  businessPartnerId?: number | null;
}
