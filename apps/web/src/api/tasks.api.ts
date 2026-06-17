import client from './client';

export interface TaskQuery {
  projectId?: number;
  zoneId?: number;
  serviceTypeId?: number;
  phaseId?: number;
  status?: string | string[];
  priority?: string;
  assigneeId?: number;
  search?: string;
  page?: number;
  perPage?: number;
  /** When true, show only archived (soft-deleted) tasks. Default false. */
  archived?: boolean;
}

export interface CreateTaskPayload {
  zoneId: number;
  serviceTypeId?: number;
  code: string;
  name: string;
  description?: string;
  budgetHours?: number;
  budgetAmount?: number;
  phaseId?: number;
  priority?: string;
}

export interface UpdateTaskPayload {
  code?: string;
  name?: string;
  description?: string;
  budgetHours?: number;
  budgetAmount?: number;
  phaseId?: number;
  serviceTypeId?: number;
  /** Legacy catalog Template link (kept synced with projectDeliverableId). */
  deliverableTemplateId?: number | null;
  /** First-class, project-owned Deliverable link (authoritative). */
  projectDeliverableId?: number | null;
  status?: string;
  priority?: string;
  completionPct?: number;
  startDate?: string;
  endDate?: string;
  isArchived?: boolean;
}

export const tasksApi = {
  list: (params?: TaskQuery) =>
    client.get('/tasks', { params: params ? { ...params, status: Array.isArray(params.status) ? params.status[0] : params.status } : {} }).then((r) => r.data),

  mine: () =>
    client.get('/tasks/mine').then((r) => r.data),

  get: (id: number) =>
    client.get(`/tasks/${id}`).then((r) => r.data?.data ?? r.data),

  create: (payload: CreateTaskPayload) =>
    client.post('/tasks', payload).then((r) => r.data),

  update: (id: number, payload: UpdateTaskPayload) =>
    client.patch(`/tasks/${id}`, payload).then((r) => r.data),

  delete: (id: number) =>
    client.delete(`/tasks/${id}`).then((r) => r.data),

  restore: (id: number) =>
    client.post(`/tasks/${id}/restore`).then((r) => r.data),

  // Assignees
  addAssignee: (taskId: number, payload: { userId: number; role?: string; hourlyRate?: number }) =>
    client.post(`/tasks/${taskId}/assignees`, payload).then((r) => r.data),

  removeAssignee: (taskId: number, userId: number) =>
    client.delete(`/tasks/${taskId}/assignees/${userId}`).then((r) => r.data),

  // Attachments
  getAttachments: (taskId: number) =>
    client.get(`/tasks/${taskId}/attachments`).then((r) => r.data),

  addAttachment: (taskId: number, payload: { fileName: string; fileUrl: string; fileSize?: number; mimeType?: string }) =>
    client.post(`/tasks/${taskId}/attachments`, payload).then((r) => r.data),

  removeAttachment: (attachmentId: number) =>
    client.delete(`/tasks/attachments/${attachmentId}`).then((r) => r.data),

  uploadFile: (file: File, folder?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    if (folder) formData.append('folder', folder);
    return client.post('/files/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data?.data ?? r.data);
  },

  // Reorder
  reorder: (items: { id: number; sortOrder: number; zoneId?: number }[]) =>
    client.post('/tasks/reorder', { items }).then((r) => r.data),

  // Checklist (Todo) — sub-items inside a task. NOT separate tasks: no
  // due date, no logged hours. The list API returns a plain array (the
  // controller wraps it in the response interceptor envelope, so we
  // unwrap both shapes the same way comments does).
  getChecklist: (taskId: number) =>
    client.get(`/tasks/${taskId}/checklist`).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  addChecklistItem: (taskId: number, text: string) =>
    client.post(`/tasks/${taskId}/checklist`, { text }).then((r) => r.data?.data ?? r.data),
  updateChecklistItem: (
    itemId: number,
    patch: { text?: string; isDone?: boolean },
  ) =>
    client.patch(`/tasks/checklist/${itemId}`, patch).then((r) => r.data?.data ?? r.data),
  removeChecklistItem: (itemId: number) =>
    client.delete(`/tasks/checklist/${itemId}`).then((r) => r.data),
  reorderChecklist: (items: { id: number; sortOrder: number }[]) =>
    client.post(`/tasks/checklist/reorder`, { items }).then((r) => r.data),

  // Comments
  // Unwrap the API envelope (`{ data, meta }`) so callers always receive a
  // plain array. Without this, `comments.filter` crashes in task-discussion
  // because `r.data` is the envelope, not the array.
  getComments: (taskId: number) =>
    client.get(`/tasks/${taskId}/comments`).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),

  addComment: (taskId: number, payload: { content: string; parentId?: number }) =>
    client.post(`/tasks/${taskId}/comments`, payload).then((r) => r.data),
};
