import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notify } from '@/lib/notify';
import { labelsApi } from '@/api/labels.api';
import type { CreateLabelPayload, MoveLabelPayload } from '@/api/labels.api';

export function useLabels(projectId: number) {
  return useQuery({
    queryKey: ['labels', projectId],
    queryFn: () => labelsApi.listByProject(projectId),
    enabled: !!projectId,
  });
}

export function useLabelTree(projectId: number) {
  return useQuery({
    queryKey: ['labels', projectId, 'tree'],
    queryFn: () => labelsApi.tree(projectId),
    enabled: !!projectId,
  });
}

export function useCreateLabel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateLabelPayload) => labelsApi.create(payload),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['labels', variables.projectId] });
      notify.success('Label created', { code: 'LABEL-CREATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to create label');
    },
  });
}

export function useUpdateLabel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...payload }: Partial<CreateLabelPayload> & { id: number }) =>
      labelsApi.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['labels'] });
      notify.success('Label updated', { code: 'LABEL-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to update label');
    },
  });
}

export function useDeleteLabel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => labelsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['labels'] });
      notify.success('Label deleted', { code: 'LABEL-DELETE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to delete label');
    },
  });
}

export function useMoveLabel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...payload }: MoveLabelPayload & { id: number }) =>
      labelsApi.move(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['labels'] });
      notify.success('Label moved', { code: 'LABEL-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to move label');
    },
  });
}

export function useLabelTypes() {
  return useQuery({
    queryKey: ['label-types'],
    queryFn: () => labelsApi.listTypes(),
    staleTime: 30 * 60 * 1000,
  });
}
