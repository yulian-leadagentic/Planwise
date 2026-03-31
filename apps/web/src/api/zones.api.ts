import client from './client';

export const zonesApi = {
  getTree: (projectId: number) =>
    client.get(`/zones/tree/${projectId}`).then((r) => r.data.data),

  create: (data: { projectId: number; parentId?: number | null; zoneType?: string; name: string; code?: string; areaSqm?: number; isTypical?: boolean; typicalCount?: number }) =>
    client.post('/zones', data).then((r) => r.data.data),

  update: (id: number, data: Partial<{ name: string; code: string; areaSqm: number; isTypical: boolean; typicalCount: number; sortOrder: number }>) =>
    client.patch(`/zones/${id}`, data).then((r) => r.data.data),

  remove: (id: number) =>
    client.delete(`/zones/${id}`).then((r) => r.data.data),

  copyStructure: (id: number, parentId: number) =>
    client.post(`/zones/${id}/copy-structure`, { parentId }).then((r) => r.data.data),

  explodeTypical: (id: number) =>
    client.post(`/zones/${id}/explode-typical`).then((r) => r.data.data),
};
