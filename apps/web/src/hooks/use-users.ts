import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notify } from '@/lib/notify';
import { usersApi } from '@/api/users.api';
import type { UserQuery, CreateUserPayload } from '@/api/users.api';

export function useUsers(params?: UserQuery) {
  return useQuery({
    queryKey: ['users', params],
    queryFn: () => usersApi.list(params),
  });
}

export function useUser(id: number) {
  return useQuery({
    queryKey: ['users', id],
    queryFn: () => usersApi.get(id),
    enabled: !!id,
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateUserPayload) => usersApi.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      notify.success('User created', { code: 'USER-CREATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to create user');
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...payload }: Partial<CreateUserPayload> & { id: number }) =>
      usersApi.update(id, payload),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['users', variables.id] });
      notify.success('User updated', { code: 'USER-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to update user');
    },
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => usersApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      notify.success('User deleted', { code: 'USER-DELETE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to delete user');
    },
  });
}

export function useToggleUserActive() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      isActive ? usersApi.deactivate(id) : usersApi.activate(id),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['users', variables.id] });
      notify.success(variables.isActive ? 'User deactivated' : 'User activated', { code: 'USER-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to update user status');
    },
  });
}
