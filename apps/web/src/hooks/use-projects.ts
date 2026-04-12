import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notify } from '@/lib/notify';
import { projectsApi } from '@/api/projects.api';
import type { ProjectQuery, CreateProjectPayload, AddMemberPayload } from '@/api/projects.api';

export function useProjects(params?: ProjectQuery) {
  return useQuery({
    queryKey: ['projects', params],
    queryFn: () => projectsApi.list(params),
  });
}

export function useProject(id: number) {
  return useQuery({
    queryKey: ['projects', id],
    queryFn: () => projectsApi.get(id),
    enabled: !!id,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateProjectPayload) => projectsApi.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      notify.success('Project created', { code: 'PROJECT-CREATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to create project');
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...payload }: Partial<CreateProjectPayload> & { id: number }) =>
      projectsApi.update(id, payload),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects', variables.id] });
      notify.success('Project updated', { code: 'PROJECT-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to update project');
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => projectsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      notify.success('Project deleted', { code: 'PROJECT-DELETE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to delete project');
    },
  });
}

export function useProjectMembers(projectId: number) {
  return useQuery({
    queryKey: ['projects', projectId, 'members'],
    queryFn: () => projectsApi.listMembers(projectId),
    enabled: !!projectId,
  });
}

export function useAddProjectMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectId, ...payload }: AddMemberPayload & { projectId: number }) =>
      projectsApi.addMember(projectId, payload),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['projects', variables.projectId, 'members'] });
      // Also invalidate planning data so assignee pickers pick up the new member
      queryClient.invalidateQueries({ queryKey: ['planning', variables.projectId] });
      notify.success('Member added', { code: 'PROJECT-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to add member');
    },
  });
}

export function useRemoveProjectMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectId, memberId }: { projectId: number; memberId: number }) =>
      projectsApi.removeMember(projectId, memberId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['projects', variables.projectId, 'members'] });
      queryClient.invalidateQueries({ queryKey: ['planning', variables.projectId] });
      notify.success('Member removed', { code: 'PROJECT-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to remove member');
    },
  });
}

export function useProjectTypes() {
  return useQuery({
    queryKey: ['project-types'],
    queryFn: () => projectsApi.listTypes(),
    staleTime: 30 * 60 * 1000,
  });
}
