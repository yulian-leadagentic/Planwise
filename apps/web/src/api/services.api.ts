import client from './client';

export const servicesApi = {
  getByProject: (projectId: number) =>
    client.get(`/projects/${projectId}/services`).then((r) => r.data.data),

  create: (projectId: number, data: { name: string; code?: string; description?: string }) =>
    client.post(`/projects/${projectId}/services`, data).then((r) => r.data.data),

  update: (id: number, data: Partial<{ name: string; code: string; description: string; sortOrder: number }>) =>
    client.patch(`/services/${id}`, data).then((r) => r.data.data),

  remove: (id: number) =>
    client.delete(`/services/${id}`).then((r) => r.data.data),
};

export const deliverablesApi = {
  getByService: (serviceId: number) =>
    client.get(`/services/${serviceId}/deliverables`).then((r) => r.data.data),

  create: (serviceId: number, data: { name: string; code?: string; scope?: string; percentage?: number; budgetHours?: number }) =>
    client.post(`/services/${serviceId}/deliverables`, data).then((r) => r.data.data),

  update: (id: number, data: Partial<{ name: string; code: string; scope: string; percentage: number; budgetHours: number }>) =>
    client.patch(`/deliverables/${id}`, data).then((r) => r.data.data),

  remove: (id: number) =>
    client.delete(`/deliverables/${id}`).then((r) => r.data.data),

  linkZones: (id: number, zoneIds: number[]) =>
    client.post(`/deliverables/${id}/link-zones`, { zoneIds }).then((r) => r.data.data),

  instantiate: (id: number) =>
    client.post(`/deliverables/${id}/instantiate`).then((r) => r.data.data),
};

export const assignmentsApi = {
  getAll: (params: { projectId?: number; deliverableId?: number; zoneId?: number; status?: string }) =>
    client.get('/assignments', { params }).then((r) => r.data.data),

  create: (data: { deliverableId: number; zoneId?: number; name: string; budgetHours?: number; priority?: string }) =>
    client.post('/assignments', data).then((r) => r.data.data),

  update: (id: number, data: Partial<{ name: string; status: string; budgetHours: number; completionPct: number; priority: string }>) =>
    client.patch(`/assignments/${id}`, data).then((r) => r.data.data),

  remove: (id: number) =>
    client.delete(`/assignments/${id}`).then((r) => r.data.data),

  addAssignee: (id: number, data: { userId: number; role?: string; hourlyRate?: number }) =>
    client.post(`/assignments/${id}/assignees`, data).then((r) => r.data.data),

  removeAssignee: (id: number, userId: number) =>
    client.delete(`/assignments/${id}/assignees/${userId}`).then((r) => r.data.data),
};

export const planningApi = {
  getData: (projectId: number) =>
    client.get(`/projects/${projectId}/planning-data`).then((r) => r.data.data),
};
