import client from './client';
import type {
  ApiResponse,
  Task,
  TaskAssignee,
  TaskComment,
  TaskPlanTime,
  PaginationQuery,
} from '@/types';

export interface TaskQuery extends PaginationQuery {
  status?: string | string[];
  priority?: string | string[];
  projectId?: number;
  labelId?: number;
  assigneeId?: number;
  search?: string;
  isArchived?: boolean;
}

export interface CreateTaskPayload {
  labelId: number;
  name: string;
  description?: string;
  status?: string;
  priority?: string;
  budgetHours?: number;
  budgetAmount?: number;
  startDate?: string;
  endDate?: string;
}

export interface AssigneePayload {
  userId: number;
  role?: string;
  hourlyRate?: number;
  startDate?: string;
  endDate?: string;
}

export interface CommentPayload {
  content: string;
  parentId?: number | null;
}

export interface PlanTimePayload {
  roleTitle: string;
  plannedHours: number;
}

export const tasksApi = {
  list: (params?: TaskQuery) =>
    client.get<ApiResponse<Task[]>>('/tasks', { params }).then((r) => r.data),

  get: (id: number) =>
    client.get<ApiResponse<Task>>(`/tasks/${id}`).then((r) => r.data.data),

  create: (payload: CreateTaskPayload) =>
    client.post<ApiResponse<Task>>('/tasks', payload).then((r) => r.data.data),

  update: (id: number, payload: Partial<CreateTaskPayload>) =>
    client.patch<ApiResponse<Task>>(`/tasks/${id}`, payload).then((r) => r.data.data),

  delete: (id: number) =>
    client.delete(`/tasks/${id}`).then((r) => r.data),

  // Assignees
  listAssignees: (taskId: number) =>
    client.get<ApiResponse<TaskAssignee[]>>(`/tasks/${taskId}/assignees`).then((r) => r.data.data),

  addAssignee: (taskId: number, payload: AssigneePayload) =>
    client.post<ApiResponse<TaskAssignee>>(`/tasks/${taskId}/assignees`, payload).then((r) => r.data.data),

  removeAssignee: (taskId: number, assigneeId: number) =>
    client.delete(`/tasks/${taskId}/assignees/${assigneeId}`).then((r) => r.data),

  // Comments
  listComments: (taskId: number) =>
    client.get<ApiResponse<TaskComment[]>>(`/tasks/${taskId}/comments`).then((r) => r.data.data),

  createComment: (taskId: number, payload: CommentPayload) =>
    client.post<ApiResponse<TaskComment>>(`/tasks/${taskId}/comments`, payload).then((r) => r.data.data),

  updateComment: (taskId: number, commentId: number, payload: { content: string }) =>
    client.patch<ApiResponse<TaskComment>>(`/tasks/${taskId}/comments/${commentId}`, payload).then((r) => r.data.data),

  deleteComment: (taskId: number, commentId: number) =>
    client.delete(`/tasks/${taskId}/comments/${commentId}`).then((r) => r.data),

  // Plan times
  listPlanTimes: (taskId: number) =>
    client.get<ApiResponse<TaskPlanTime[]>>(`/tasks/${taskId}/plan-times`).then((r) => r.data.data),

  setPlanTimes: (taskId: number, payload: PlanTimePayload[]) =>
    client.put<ApiResponse<TaskPlanTime[]>>(`/tasks/${taskId}/plan-times`, { items: payload }).then((r) => r.data.data),
};
