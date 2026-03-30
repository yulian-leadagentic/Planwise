import client from './client';
import type { ApiResponse, Label, LabelType } from '@/types';

export interface CreateLabelPayload {
  projectId: number;
  parentId?: number | null;
  labelTypeId: number;
  name: string;
  description?: string;
  color?: string;
  sortOrder?: number;
}

export interface MoveLabelPayload {
  parentId: number | null;
  sortOrder: number;
}

export const labelsApi = {
  // Backend: GET /labels?projectId=X
  listByProject: (projectId: number) =>
    client.get<ApiResponse<Label[]>>('/labels', { params: { projectId } }).then((r) => r.data.data),

  // Backend: GET /labels/tree/:projectId
  tree: (projectId: number) =>
    client.get<ApiResponse<Label[]>>(`/labels/tree/${projectId}`).then((r) => r.data.data),

  get: (id: number) =>
    client.get<ApiResponse<Label>>(`/labels/${id}`).then((r) => r.data.data),

  create: (payload: CreateLabelPayload) =>
    client.post<ApiResponse<Label>>('/labels', payload).then((r) => r.data.data),

  update: (id: number, payload: Partial<CreateLabelPayload>) =>
    client.patch<ApiResponse<Label>>(`/labels/${id}`, payload).then((r) => r.data.data),

  delete: (id: number) =>
    client.delete(`/labels/${id}`).then((r) => r.data),

  // Backend: PATCH /labels/:id/reorder
  move: (id: number, payload: MoveLabelPayload) =>
    client.patch<ApiResponse<Label>>(`/labels/${id}/reorder`, payload).then((r) => r.data.data),

  // Backend: GET /admin/config/label-types
  listTypes: () =>
    client.get<ApiResponse<LabelType[]>>('/admin/config/label-types').then((r) => r.data.data),
};
