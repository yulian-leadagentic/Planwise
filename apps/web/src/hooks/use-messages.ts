import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { messagesApi, type CreateMessagePayload } from '@/api/messages.api';
import { notify } from '@/lib/notify';

export function useMessages(entityType: string, entityId: number, page = 1) {
  return useQuery({
    queryKey: ['messages', entityType, entityId, page],
    queryFn: () => messagesApi.list({ entityType, entityId, page }),
    enabled: !!entityType && !!entityId,
  });
}

export function useMessage(id: number) {
  return useQuery({
    queryKey: ['messages', id],
    queryFn: () => messagesApi.get(id),
    enabled: !!id,
  });
}

export function useCreateMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateMessagePayload) => messagesApi.create(payload),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['messages', variables.entityType, variables.entityId],
      });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to send message'),
  });
}

export function useUpdateMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, content }: { id: number; content: string }) =>
      messagesApi.update(id, content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      notify.success('Message updated');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update'),
  });
}

export function useDeleteMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => messagesApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      notify.success('Message deleted');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete'),
  });
}

export function useInbox(page = 1) {
  return useQuery({
    queryKey: ['messages', 'inbox', page],
    queryFn: () => messagesApi.inbox({ page }),
  });
}
