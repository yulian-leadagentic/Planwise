import client from './client';

export const zonesApi = {
  getTree: (projectId: number) =>
    client.get(`/zones/tree/${projectId}`).then((r) => r.data),

  create: (data: { projectId: number; parentId?: number | null; zoneType?: string; name: string; code?: string; areaSqm?: number; isTypical?: boolean; typicalCount?: number }) =>
    client.post('/zones', data).then((r) => r.data),

  update: (id: number, data: Partial<{ name: string; code: string; zoneType: string; areaSqm: number; isTypical: boolean; typicalCount: number; sortOrder: number }>) =>
    client.patch(`/zones/${id}`, data).then((r) => r.data),

  remove: (id: number) =>
    client.delete(`/zones/${id}`).then((r) => r.data),

  copyStructure: (id: number, parentId: number) =>
    client.post(`/zones/${id}/copy-structure`, { parentId }).then((r) => r.data),

  explodeTypical: (id: number) =>
    client.post(`/zones/${id}/explode-typical`).then((r) => r.data),

  applyTaskTemplate: (zoneId: number, templateId: number) =>
    client.post(`/zones/${zoneId}/apply-task-template`, { templateId }).then((r) => r.data),

  duplicate: (zoneId: number, newName: string) =>
    client.post(`/zones/${zoneId}/duplicate`, { newName }).then((r) => r.data),
};

export const serviceTypesApi = {
  list: () =>
    client.get('/service-types').then((r) => r.data),

  create: (data: { name: string; code?: string; color?: string; sortOrder?: number }) =>
    client.post('/service-types', data).then((r) => r.data),

  update: (id: number, data: Partial<{ name: string; code: string; color: string; sortOrder: number }>) =>
    client.patch(`/service-types/${id}`, data).then((r) => r.data),

  remove: (id: number) =>
    client.delete(`/service-types/${id}`).then((r) => r.data),
};

export const phasesApi = {
  list: () =>
    client.get('/phases').then((r) => r.data),

  create: (data: { name: string; sortOrder?: number }) =>
    client.post('/phases', data).then((r) => r.data),

  update: (id: number, data: Partial<{ name: string; sortOrder: number }>) =>
    client.patch(`/phases/${id}`, data).then((r) => r.data),

  remove: (id: number) =>
    client.delete(`/phases/${id}`).then((r) => r.data),
};

export const templatesApi = {
  list: (type?: string) =>
    client.get('/templates', { params: type ? { type } : {} }).then((r) => r.data),

  get: (id: number) =>
    client.get(`/templates/${id}`).then((r) => r.data),

  create: (data: { code?: string; name: string; type: string; category?: string; description?: string; tasks?: any[] }) =>
    client.post('/templates', data).then((r) => r.data),

  update: (id: number, data: any) =>
    client.patch(`/templates/${id}`, data).then((r) => r.data),

  remove: (id: number) =>
    client.delete(`/templates/${id}`).then((r) => r.data),

  addTask: (templateId: number, data: any) =>
    client.post(`/templates/${templateId}/tasks`, data).then((r) => r.data),

  updateTask: (taskId: number, data: any) =>
    client.patch(`/templates/tasks/${taskId}`, data).then((r) => r.data),

  removeTask: (taskId: number) =>
    client.delete(`/templates/tasks/${taskId}`).then((r) => r.data),

  duplicate: (id: number, data: { name: string; code: string }) =>
    client.post(`/templates/${id}/duplicate`, data).then((r) => r.data),
};

export const budgetApi = {
  getSummary: (projectId: number) =>
    client.get(`/projects/${projectId}/budget-summary`).then((r) => r.data),
};

export const planningApi = {
  getData: (projectId: number) =>
    client.get(`/projects/${projectId}/planning-data`).then((r) => r.data),
};
