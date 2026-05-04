import client from './client';
import type { ApiResponse, Project, ProjectMember, ProjectType, PaginationQuery } from '@/types';

export interface ProjectQuery extends PaginationQuery {
  status?: string;
  search?: string;
  isArchived?: boolean;
  /** Filter to projects where this user is leader OR active member. */
  memberId?: number;
}

export interface CreateProjectPayload {
  name: string;
  number?: string;
  description?: string;
  projectTypeId: number;
  status?: string;
  budget?: number;
  startDate?: string;
  endDate?: string;
  leaderId?: number;
  memberIds?: number[];
}

export interface AddMemberPayload {
  userId: number;
  role?: string;
}

export const projectsApi = {
  list: (params?: ProjectQuery) =>
    client.get<ApiResponse<Project[]>>('/projects', { params }).then((r) => r.data),

  get: (id: number) =>
    client.get<ApiResponse<Project>>(`/projects/${id}`).then((r) => r.data.data),

  create: (payload: CreateProjectPayload) =>
    client.post<ApiResponse<Project>>('/projects', payload).then((r) => r.data.data),

  update: (id: number, payload: Partial<CreateProjectPayload>) =>
    client.patch<ApiResponse<Project>>(`/projects/${id}`, payload).then((r) => r.data.data),

  delete: (id: number) =>
    client.delete(`/projects/${id}`).then((r) => r.data),

  archive: (id: number) =>
    client.patch<ApiResponse<Project>>(`/projects/${id}/archive`).then((r) => r.data.data),

  // Members
  listMembers: (projectId: number) =>
    client.get<ApiResponse<ProjectMember[]>>(`/projects/${projectId}/members`).then((r) => r.data.data),

  addMember: (projectId: number, payload: AddMemberPayload) =>
    client.post<ApiResponse<ProjectMember>>(`/projects/${projectId}/members`, payload).then((r) => r.data.data),

  removeMember: (projectId: number, memberId: number) =>
    client.delete(`/projects/${projectId}/members/${memberId}`).then((r) => r.data),

  // Project types
  listTypes: () =>
    client.get<ApiResponse<ProjectType[]>>('/admin/config/project-types').then((r) => r.data.data),
};
