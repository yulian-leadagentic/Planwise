import client from './client';
import type { ApiResponse, Project, ProjectMember, ProjectType, PaginationQuery } from '@/types';

export interface ProjectQuery extends PaginationQuery {
  status?: string;
  search?: string;
  isArchived?: boolean;
  /** Filter to projects where this user is leader OR active member. */
  memberId?: number;
  /**
   * Include CLOSED projects in the result. Defaults to false on the API
   * — pass true behind a UI toggle when admins need to browse the
   * archive. (T3.6+7, 2026-06-28)
   */
  includeClosed?: boolean;
  /**
   * Filter to ONLY closed projects. Takes precedence over `includeClosed`.
   * Wired to the "Closed" option in the project-list status dropdown.
   * (T3.6 follow-up, 2026-06-29)
   */
  closedOnly?: boolean;
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

  /** Mark project as closed — keeps all data but hides from default list. */
  close: (id: number) =>
    client.post<ApiResponse<{ closedAt: string }>>(`/projects/${id}/close`).then((r) => r.data),

  /** Re-open a previously-closed project. */
  reopen: (id: number) =>
    client.post<ApiResponse<{ message: string }>>(`/projects/${id}/reopen`).then((r) => r.data),

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
