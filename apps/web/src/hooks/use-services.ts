import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notify } from '@/lib/notify';
import { servicesApi, deliverablesApi, assignmentsApi, planningApi } from '@/api/services.api';

// ─── Services ──────────────────────────────────────────────────────────────

export function useServices(projectId: number) {
  return useQuery({
    queryKey: ['services', projectId],
    queryFn: () => servicesApi.getByProject(projectId),
    enabled: !!projectId,
  });
}

export function useCreateService(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Parameters<typeof servicesApi.create>[1]) =>
      servicesApi.create(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['services', projectId] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      notify.success('Service created', { code: 'SERVICE-CREATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to create service');
    },
  });
}

export function useUpdateService(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: { id: number } & Parameters<typeof servicesApi.update>[1]) =>
      servicesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['services', projectId] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      notify.success('Service updated', { code: 'SERVICE-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to update service');
    },
  });
}

export function useDeleteService(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => servicesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['services', projectId] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      notify.success('Service deleted', { code: 'SERVICE-DELETE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to delete service');
    },
  });
}

// ─── Deliverables ──────────────────────────────────────────────────────────

export function useDeliverables(serviceId: number) {
  return useQuery({
    queryKey: ['deliverables', serviceId],
    queryFn: () => deliverablesApi.getByService(serviceId),
    enabled: !!serviceId,
  });
}

export function useCreateDeliverable(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ serviceId, ...data }: { serviceId: number } & Parameters<typeof deliverablesApi.create>[1]) =>
      deliverablesApi.create(serviceId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deliverables'] });
      queryClient.invalidateQueries({ queryKey: ['services', projectId] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      notify.success('Deliverable created', { code: 'SERVICE-CREATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to create deliverable');
    },
  });
}

export function useUpdateDeliverable(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: { id: number } & Parameters<typeof deliverablesApi.update>[1]) =>
      deliverablesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deliverables'] });
      queryClient.invalidateQueries({ queryKey: ['services', projectId] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      notify.success('Deliverable updated', { code: 'SERVICE-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to update deliverable');
    },
  });
}

export function useDeleteDeliverable(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => deliverablesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deliverables'] });
      queryClient.invalidateQueries({ queryKey: ['services', projectId] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      notify.success('Deliverable deleted', { code: 'SERVICE-DELETE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to delete deliverable');
    },
  });
}

export function useLinkZones(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ deliverableId, zoneIds }: { deliverableId: number; zoneIds: number[] }) =>
      deliverablesApi.linkZones(deliverableId, zoneIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deliverables'] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      notify.success('Zones linked', { code: 'SERVICE-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to link zones');
    },
  });
}

export function useInstantiateDeliverable(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (deliverableId: number) => deliverablesApi.instantiate(deliverableId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assignments'] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      notify.success('Assignments instantiated', { code: 'SERVICE-CREATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to instantiate deliverable');
    },
  });
}

// ─── Assignments ───────────────────────────────────────────────────────────

export function useAssignments(params: Parameters<typeof assignmentsApi.getAll>[0]) {
  return useQuery({
    queryKey: ['assignments', params],
    queryFn: () => assignmentsApi.getAll(params),
    enabled: !!params.projectId,
  });
}

export function useCreateAssignment(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Parameters<typeof assignmentsApi.create>[0]) =>
      assignmentsApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assignments'] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      notify.success('Assignment created', { code: 'SERVICE-CREATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to create assignment');
    },
  });
}

export function useUpdateAssignment(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: { id: number } & Parameters<typeof assignmentsApi.update>[1]) =>
      assignmentsApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assignments'] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      notify.success('Assignment updated', { code: 'SERVICE-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to update assignment');
    },
  });
}

export function useDeleteAssignment(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => assignmentsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assignments'] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      notify.success('Assignment deleted', { code: 'SERVICE-DELETE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to delete assignment');
    },
  });
}

export function useAddAssignee(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ assignmentId, ...data }: { assignmentId: number; userId: number; role?: string; hourlyRate?: number }) =>
      assignmentsApi.addAssignee(assignmentId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assignments'] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      notify.success('Assignee added', { code: 'SERVICE-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to add assignee');
    },
  });
}

export function useRemoveAssignee(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ assignmentId, userId }: { assignmentId: number; userId: number }) =>
      assignmentsApi.removeAssignee(assignmentId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assignments'] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      notify.success('Assignee removed', { code: 'SERVICE-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to remove assignee');
    },
  });
}

// ─── Planning Data (aggregated) ────────────────────────────────────────────

export function usePlanningData(projectId: number) {
  return useQuery({
    queryKey: ['planning-data', projectId],
    queryFn: () => planningApi.getData(projectId),
    enabled: !!projectId,
  });
}
