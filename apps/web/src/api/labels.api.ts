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
  listByProject: (projectId: number) =>
    client.get<ApiResponse<Label[]>>(`/projects/${projectId}/labels`).then((r) => r.data.data),

  tree: (projectId: number) =>
    client.get<ApiResponse<Label[]>>(`/projects/${projectId}/labels/tree`).then((r) => r.data.data),

  get: (id: number) =>
    client.get<ApiResponse<Label>>(`/labels/${id}`).then((r) => r.data.data),

  create: (payload: CreateLabelPayload) =>
    client.post<ApiResponse<Label>>('/labels', payload).then((r) => r.data.data),

  update: (id: number, payload: Partial<CreateLabelPayload>) =>
    client.patch<ApiResponse<Label>>(`/labels/${id}`, payload).then((r) => r.data.data),

  delete: (id: number) =>
    client.delete(`/labels/${id}`).then((r) => r.data),

  move: (id: number, payload: MoveLabelPayload) =>
    client.patch<ApiResponse<Label>>(`/labels/${id}/move`, payload).then((r) => r.data.data),

  // Label types
  listTypes: () =>
    client.get<ApiResponse<LabelType[]>>('/label-types').then((r) => r.data.data),
};
