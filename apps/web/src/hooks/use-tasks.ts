import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notify } from '@/lib/notify';
import { tasksApi } from '@/api/tasks.api';
import type { TaskQuery, CreateTaskPayload, UpdateTaskPayload } from '@/api/tasks.api';

export function useTasks(params?: TaskQuery) {
  return useQuery({
    queryKey: ['tasks', params],
    queryFn: () => tasksApi.list(params),
  });
}

export function useTask(id: number) {
  return useQuery({
    queryKey: ['tasks', id],
    queryFn: () => tasksApi.get(id),
    enabled: !!id,
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateTaskPayload) => tasksApi.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['planning'] });
      notify.success('Task created', { code: 'TASK-CREATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to create task');
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...payload }: UpdateTaskPayload & { id: number }) =>
      tasksApi.update(id, payload),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['tasks', variables.id] });
      queryClient.invalidateQueries({ queryKey: ['planning'] });
      notify.success('Task updated', { code: 'TASK-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to update task');
    },
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => tasksApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['planning'] });
      notify.success('Task deleted', { code: 'TASK-DELETE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to delete task');
    },
  });
}

export function useAddTaskAssignee() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, ...payload }: { taskId: number; userId: number; role?: string; hourlyRate?: number }) =>
      tasksApi.addAssignee(taskId, payload),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['tasks', variables.taskId] });
      queryClient.invalidateQueries({ queryKey: ['planning'] });
      notify.success('Assignee added', { code: 'TASK-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to add assignee');
    },
  });
}

export function useRemoveTaskAssignee() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, userId }: { taskId: number; userId: number }) =>
      tasksApi.removeAssignee(taskId, userId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['tasks', variables.taskId] });
      queryClient.invalidateQueries({ queryKey: ['planning'] });
      notify.success('Assignee removed', { code: 'TASK-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to remove assignee');
    },
  });
}

export function useTaskComments(taskId: number) {
  return useQuery({
    queryKey: ['tasks', taskId, 'comments'],
    queryFn: () => tasksApi.getComments(taskId),
    enabled: !!taskId,
  });
}

export function useTaskAssignees(taskId: number) {
  return useQuery({
    queryKey: ['tasks', taskId, 'assignees'],
    queryFn: () => tasksApi.get(taskId).then((r: any) => (r?.data ?? r)?.assignees ?? []),
    enabled: !!taskId,
  });
}

export function useCreateComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, ...payload }: { taskId: number; content: string; parentId?: number }) =>
      tasksApi.addComment(taskId, payload),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['tasks', variables.taskId, 'comments'] });
      notify.success('Comment added', { code: 'TASK-CREATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to add comment');
    },
  });
}

export function useDeleteComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, commentId }: { taskId: number; commentId: number }) =>
      tasksApi.delete(commentId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['tasks', variables.taskId, 'comments'] });
      notify.success('Comment deleted', { code: 'TASK-DELETE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to delete comment');
    },
  });
}
