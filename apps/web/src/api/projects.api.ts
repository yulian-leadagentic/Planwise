import client from './client';
import type { ApiResponse, Project, ProjectMember, ProjectType, PaginationQuery } from '@/types';

/**
 * One entry in the unified assignee-candidate list — the task-tree
 * picker's data source post-BP-refactor. `canAssign` is false for
 * external contacts (BusinessPartner with no linked User row); the
 * picker still renders them so the user knows the person exists on
 * the project, but disables the click with a clear tooltip.
 * (Branch 2 · fix/assignee-source.)
 */
export interface AssigneeCandidate {
  userId: number | null;
  partyId: number | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  /** Role name from ProjectRoleType — comma-joined when the person holds several. */
  role: string | null;
  /** titleInProject from the role assignment, or User.position/department. */
  discipline: string | null;
  /** True iff `userId` is set (TaskAssignee.userId writes require a User). */
  canAssign: boolean;
}

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

  /**
   * Unified assignable-candidate list — internal Users on the project
   * PLUS project-partner-role holders (person parties + contact
   * persons on org roles), deduped. The task-tree AssigneePicker and
   * task-drawer AssigneeManager both read this so the picker's set
   * matches the Team tab. External contacts appear with
   * `canAssign: false`. (Branch 2 · fix/assignee-source.)
   */
  listAssigneeCandidates: (projectId: number) =>
    client.get<ApiResponse<AssigneeCandidate[]>>(`/projects/${projectId}/assignee-candidates`)
      .then((r) => r.data.data ?? (r.data as unknown as AssigneeCandidate[])),

  // Project types
  listTypes: () =>
    client.get<ApiResponse<ProjectType[]>>('/admin/config/project-types').then((r) => r.data.data),
};
