import client from './client';

export interface CreateMessagePayload {
  entityType: 'project' | 'task' | 'zone';
  entityId: number;
  parentId?: number;
  content: string;
  mentionedUserIds?: number[];
}

export const messagesApi = {
  list: (params: { entityType: string; entityId: number; page?: number; perPage?: number }) =>
    client.get('/messages', { params }).then((r) => r.data),

  get: (id: number) =>
    client.get(`/messages/${id}`).then((r) => r.data),

  create: (payload: CreateMessagePayload) =>
    client.post('/messages', payload).then((r) => r.data),

  update: (id: number, content: string) =>
    client.patch(`/messages/${id}`, { content }).then((r) => r.data),

  delete: (id: number) =>
    client.delete(`/messages/${id}`).then((r) => r.data),

  inbox: (params?: { page?: number; perPage?: number }) =>
    client.get('/messages/inbox', { params }).then((r) => r.data),

  // Resolve/unresolve
  resolve: (id: number) =>
    client.post(`/messages/${id}/resolve`).then((r) => r.data),
  unresolve: (id: number) =>
    client.post(`/messages/${id}/unresolve`).then((r) => r.data),

  // Search
  search: (params: { q: string; entityType?: string; page?: number; perPage?: number }) =>
    client.get('/messages/search/query', { params }).then((r) => r.data),

  // Analytics
  analytics: (projectId?: number) =>
    client.get('/messages/analytics/overview', { params: projectId ? { projectId } : {} }).then((r) => r.data),

  // AI features
  suggestRecipients: (entityType: string, entityId: number) =>
    client.get(`/messages/suggest-recipients/${entityType}/${entityId}`).then((r) => r.data),
  summarize: (id: number) =>
    client.get(`/messages/${id}/summarize`).then((r) => r.data),
};
