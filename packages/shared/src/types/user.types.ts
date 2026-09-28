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
   * Retire-User.department Step 2/3 (2026-09-28) — org membership now
   * comes from `orgUnit` (id + name). `department` is the legacy
   * free-text string kept as a fallback for one release; Step 3/3
   * drops it entirely and simplifies every `?? department ?? '—'`
   * fallback down to `orgUnit?.name ?? '—'`.
   */
  department: string | null;
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
  /** See User — retirement in progress, `orgUnit` is the source of truth. */
  department: string | null;
  orgUnitId?: number | null;
  orgUnit?: { id: number; name: string } | null;
  companyName: string | null;
  roleId: number;
  roleName: string;
  isActive: boolean;
}
