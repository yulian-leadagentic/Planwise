/**
 * Centralized TanStack Query key factory. Using this over ad-hoc inline
 * keys prevents:
 *   - typos that silently make two components use different caches
 *   - over-broad invalidations (invalidateQueries({ queryKey: ['tasks'] })
 *     nuking the drawer's single-task query when you only meant the list)
 *
 * Each key is a const tuple — TanStack Query does prefix matching, so
 * passing a parent key invalidates all children.
 */

export const queryKeys = {
  // ─── Tasks ─────────────────────────────────────────────────────────
  tasks: {
    all: ['tasks'] as const,
    lists: () => [...queryKeys.tasks.all, 'list'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.tasks.lists(), filters ?? {}] as const,
    mine: () => [...queryKeys.tasks.all, 'mine'] as const,
    details: () => [...queryKeys.tasks.all, 'detail'] as const,
    detail: (id: number) => [...queryKeys.tasks.details(), id] as const,
    comments: (taskId: number) => [...queryKeys.tasks.detail(taskId), 'comments'] as const,
    attachments: (taskId: number) => [...queryKeys.tasks.detail(taskId), 'attachments'] as const,
  },

  // ─── Projects / Planning ──────────────────────────────────────────
  projects: {
    all: ['projects'] as const,
    lists: () => [...queryKeys.projects.all, 'list'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.projects.lists(), filters ?? {}] as const,
    details: () => [...queryKeys.projects.all, 'detail'] as const,
    detail: (id: number) => [...queryKeys.projects.details(), id] as const,
    members: (projectId: number) => [...queryKeys.projects.detail(projectId), 'members'] as const,
  },
  planning: {
    all: ['planning'] as const,
    byProject: (projectId: number) => [...queryKeys.planning.all, projectId] as const,
  },
  feasibility: {
    byProject: (projectId: number) => ['feasibility', projectId] as const,
  },
  progress: {
    byProject: (projectId: number) => ['progress', projectId] as const,
  },

  // ─── Execution Board ──────────────────────────────────────────────
  executionBoard: {
    all: ['execution-board'] as const,
    with: (projectId: number | null, serviceId: number | null) =>
      [...queryKeys.executionBoard.all, projectId, serviceId] as const,
  },

  // ─── Time Entries ──────────────────────────────────────────────────
  time: {
    all: ['time'] as const,
    entries: (params?: Record<string, unknown>) =>
      [...queryKeys.time.all, 'entries', params ?? {}] as const,
    entriesByTask: (taskId: number) => [...queryKeys.time.all, 'entries', 'task', taskId] as const,
  },

  // ─── Zones ─────────────────────────────────────────────────────────
  zones: {
    all: ['zones'] as const,
    byProject: (projectId: number) => [...queryKeys.zones.all, 'project', projectId] as const,
    tree: (projectId: number) => [...queryKeys.zones.all, 'tree', projectId] as const,
    detail: (id: number) => [...queryKeys.zones.all, 'detail', id] as const,
  },

  // ─── Templates / Catalog ──────────────────────────────────────────
  templates: {
    all: ['templates'] as const,
    list: (type?: string) => [...queryKeys.templates.all, 'list', type ?? 'all'] as const,
    detail: (id: number) => [...queryKeys.templates.all, 'detail', id] as const,
  },

  // ─── Lookups ──────────────────────────────────────────────────────
  users: {
    all: ['users'] as const,
    list: () => [...queryKeys.users.all, 'list'] as const,
  },
  phases: { all: ['phases'] as const },
  services: { all: ['services'] as const },
  serviceTypes: { all: ['service-types'] as const },

  // ─── Messages ─────────────────────────────────────────────────────
  messages: {
    all: ['messages'] as const,
    byTask: (taskId: number) => [...queryKeys.messages.all, 'task', taskId] as const,
    byProject: (projectId: number) => [...queryKeys.messages.all, 'project', projectId] as const,
  },
} as const;
