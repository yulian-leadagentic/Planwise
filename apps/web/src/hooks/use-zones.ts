import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { zonesApi } from '@/api/zones.api';

export function useZoneTree(projectId: number) {
  return useQuery({
    queryKey: ['zones', 'tree', projectId],
    queryFn: () => zonesApi.getTree(projectId),
    enabled: !!projectId,
  });
}

export function useCreateZone() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Parameters<typeof zonesApi.create>[0]) => zonesApi.create(data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['zones', 'tree', variables.projectId] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', variables.projectId] });
      toast.success('Zone created');
    },
    onError: () => {
      toast.error('Failed to create zone');
    },
  });
}

export function useUpdateZone(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: { id: number } & Parameters<typeof zonesApi.update>[1]) =>
      zonesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['zones', 'tree', projectId] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      toast.success('Zone updated');
    },
    onError: () => {
      toast.error('Failed to update zone');
    },
  });
}

export function useDeleteZone(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => zonesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['zones', 'tree', projectId] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      toast.success('Zone deleted');
    },
    onError: () => {
      toast.error('Failed to delete zone');
    },
  });
}

export function useCopyZoneStructure(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, parentId }: { id: number; parentId: number }) =>
      zonesApi.copyStructure(id, parentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['zones', 'tree', projectId] });
      toast.success('Zone structure copied');
    },
    onError: () => {
      toast.error('Failed to copy zone structure');
    },
  });
}

export function useExplodeTypical(projectId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => zonesApi.explodeTypical(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['zones', 'tree', projectId] });
      queryClient.invalidateQueries({ queryKey: ['planning-data', projectId] });
      toast.success('Typical zone exploded');
    },
    onError: () => {
      toast.error('Failed to explode typical zone');
    },
  });
}
