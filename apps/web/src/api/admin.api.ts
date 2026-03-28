import client from './client';
import type { ApiResponse, ActivityLog, PaginationQuery } from '@/types';

export interface Role {
  id: number;
  name: string;
  permissions: string[];
  isSystem: boolean;
  createdAt: string;
}

export interface RolePayload {
  name: string;
  permissions: string[];
}

export interface ActivityLogQuery extends PaginationQuery {
  userId?: number;
  category?: string;
  severity?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface AppConfig {
  key: string;
  value: string;
  description: string;
}

export const adminApi = {
  // Roles
  listRoles: () =>
    client.get<ApiResponse<Role[]>>('/admin/roles').then((r) => r.data.data),

  getRole: (id: number) =>
    client.get<ApiResponse<Role>>(`/admin/roles/${id}`).then((r) => r.data.data),

  createRole: (payload: RolePayload) =>
    client.post<ApiResponse<Role>>('/admin/roles', payload).then((r) => r.data.data),

  updateRole: (id: number, payload: RolePayload) =>
    client.patch<ApiResponse<Role>>(`/admin/roles/${id}`, payload).then((r) => r.data.data),

  deleteRole: (id: number) =>
    client.delete(`/admin/roles/${id}`).then((r) => r.data),

  // Activity logs
  listActivityLogs: (params?: ActivityLogQuery) =>
    client.get<ApiResponse<ActivityLog[]>>('/admin/activity-logs', { params }).then((r) => r.data),

  // Enums
  getEnums: () =>
    client.get<ApiResponse<Record<string, string[]>>>('/admin/enums').then((r) => r.data.data),

  // Config
  listConfig: () =>
    client.get<ApiResponse<AppConfig[]>>('/admin/config').then((r) => r.data.data),

  updateConfig: (key: string, value: string) =>
    client.patch<ApiResponse<AppConfig>>(`/admin/config/${key}`, { value }).then((r) => r.data.data),
};
