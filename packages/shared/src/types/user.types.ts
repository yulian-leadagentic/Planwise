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
  department: string | null;
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
  department: string | null;
  companyName: string | null;
  roleName: string;
  isActive: boolean;
}
