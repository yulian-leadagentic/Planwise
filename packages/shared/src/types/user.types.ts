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
}
