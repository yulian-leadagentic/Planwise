import client from './client';
import type { ApiResponse, User, UserListItem, PaginationQuery } from '@/types';

export interface UserQuery extends PaginationQuery {
  userType?: string;
  isActive?: boolean;
  search?: string;
  roleId?: number;
}

export interface CreateUserPayload {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string;
  roleId: number;
  userType: string;
  position?: string;
  department?: string;
  companyName?: string;
  taxId?: string;
  address?: string;
  website?: string;
}

export const usersApi = {
  list: (params?: UserQuery) =>
    client.get<ApiResponse<UserListItem[]>>('/users', { params }).then((r) => r.data),

  get: (id: number) =>
    client.get<ApiResponse<User>>(`/users/${id}`).then((r) => r.data.data),

  create: (payload: CreateUserPayload) =>
    client.post<ApiResponse<User>>('/users', payload).then((r) => r.data.data),

  update: (id: number, payload: Partial<CreateUserPayload>) =>
    client.patch<ApiResponse<User>>(`/users/${id}`, payload).then((r) => r.data.data),

  delete: (id: number) =>
    client.delete(`/users/${id}`).then((r) => r.data),

  activate: (id: number) =>
    client.patch<ApiResponse<User>>(`/users/${id}/activate`).then((r) => r.data.data),

  deactivate: (id: number) =>
    client.patch<ApiResponse<User>>(`/users/${id}/deactivate`).then((r) => r.data.data),
};
