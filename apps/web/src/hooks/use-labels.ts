import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
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
      toast.success('Label created');
    },
    onError: () => {
      toast.error('Failed to create label');
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
      toast.success('Label updated');
    },
    onError: () => {
      toast.error('Failed to update label');
    },
  });
}

export function useDeleteLabel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => labelsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['labels'] });
      toast.success('Label deleted');
    },
    onError: () => {
      toast.error('Failed to delete label');
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
      toast.success('Label moved');
    },
    onError: () => {
      toast.error('Failed to move label');
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
