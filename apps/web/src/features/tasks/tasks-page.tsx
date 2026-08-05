import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notify } from '@/lib/notify';
import { PageHeader } from '@/components/shared/page-header';
import { FilterBar } from '@/components/shared/filter-bar';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge } from '@/components/shared/status-badge';
import { PriorityBadge } from '@/components/shared/priority-badge';
import { UserAvatar } from '@/components/shared/user-avatar';
import { TaskCard } from './task-card';
import { CreateTaskModal } from './create-task-modal';
import { tasksApi } from '@/api/tasks.api';
import client from '@/api/client';
import { useFilterStore } from '@/stores/filter.store';
import { useDebounce } from '@/hooks/use-debounce';
import { cn } from '@/lib/utils';
import type { ColumnDef } from '@tanstack/react-table';

type Tab = 'mine' | 'all' | 'archived';

interface TaskRow {
  id: number;
  code: string;
  name: string;
  status: string;
  priority: string;
  budgetHours: string | null;
  budgetAmount: string | null;
  completionPct: number;
  zone: { id: number; name: string } | null;
  project: { id: number; name: string } | null;
  serviceType: { id: number; name: string; code: string; color: string } | null;
  phase: { id: number; name: string } | null;
  assignees: Array<{
    id: number;
    user: { firstName: string; lastName: string; avatarUrl?: string };
  }>;
  [key: string]: unknown;
}

const columns: ColumnDef<TaskRow, unknown>[] = [
  {
    accessorKey: 'code',
    header: 'Code',
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-xs font-mono text-muted-foreground">
        {row.original.code}
      </span>
    ),
  },
  {
    accessorKey: 'name',
    header: 'Name',
    // truncate on inline <span> doesn't clip without a width constraint —
    // long task names were overflowing the cell on the all-tasks page.
    // `block max-w-[260px]` gives truncate something to clip against;
    // the title attribute keeps full text discoverable on hover.
    cell: ({ row }) => (
      <span className="block max-w-[260px] truncate font-medium" title={row.original.name}>
        {row.original.name}
      </span>
    ),
  },
  {
    accessorKey: 'project',
    header: 'Project',
    cell: ({ row }) => (
      <span className="block max-w-[200px] truncate text-sm" title={row.original.project?.name ?? ''}>
        {row.original.project?.name ?? '-'}
      </span>
    ),
  },
  {
    accessorKey: 'zone',
    header: 'Zone',
    cell: ({ row }) => (
      <span className="block max-w-[180px] truncate text-sm" title={row.original.zone?.name ?? ''}>
        {row.original.zone?.name ?? '-'}
      </span>
    ),
  },
  {
    accessorKey: 'serviceType',
    header: 'Service Type',
    cell: ({ row }) => {
      const st = row.original.serviceType;
      if (!st) return <span className="text-sm text-muted-foreground">-</span>;
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: st.color }}
          />
          {st.name}
        </span>
      );
    },
    enableSorting: false,
  },
  {
    accessorKey: 'phase',
    header: 'Phase',
    cell: ({ row }) => (
      <span className="truncate text-sm">
        {row.original.phase?.name ?? '-'}
      </span>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    accessorKey: 'priority',
    header: 'Priority',
    cell: ({ row }) => <PriorityBadge priority={row.original.priority} />,
  },
  {
    accessorKey: 'budgetHours',
    header: 'Hours',
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.budgetHours != null ? row.original.budgetHours : '-'}
      </span>
    ),
  },
  {
    accessorKey: 'budgetAmount',
    header: 'Amount',
    cell: ({ row }) => {
      const amt = row.original.budgetAmount;
      if (amt == null) return <span className="text-sm">-</span>;
      return (
        <span className="text-sm">
          {Number(amt).toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2,
          })}
        </span>
      );
    },
  },
  {
    accessorKey: 'completionPct',
    header: '%',
    cell: ({ row }) => {
      const pct = row.original.completionPct ?? 0;
      return (
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-brand-500 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground">{pct}%</span>
        </div>
      );
    },
  },
  {
    accessorKey: 'assignees',
    header: 'Assignees',
    cell: ({ row }) => (
      <div className="flex -space-x-1">
        {(row.original.assignees ?? []).slice(0, 3).map((a) => (
          <UserAvatar
            key={a.id}
            firstName={a.user?.firstName ?? ''}
            lastName={a.user?.lastName ?? ''}
            avatarUrl={a.user?.avatarUrl}
            size="xs"
            className="ring-2 ring-background"
          />
        ))}
        {(row.original.assignees?.length ?? 0) > 3 && (
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium ring-2 ring-background">
            +{(row.original.assignees?.length ?? 0) - 3}
          </div>
        )}
      </div>
    ),
    enableSorting: false,
  },
];

export function TasksPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Deep-link support: ?tab=archived lands the user directly on the
  // Archived tab so the "Archived" button on the planning toolbar can
  // navigate straight to the right view.
  const initialTab = (searchParams.get('tab') as Tab) || 'mine';
  const [tab, setTab] = useState<Tab>(
    ['mine', 'all', 'archived'].includes(initialTab as string) ? initialTab : 'mine',
  );
  const [showCreate, setShowCreate] = useState(false);

  const {
    taskSearch,
    taskStatus,
    taskPriority,
    taskProjectId,
    setTaskFilters,
  } = useFilterStore();

  const debouncedSearch = useDebounce(taskSearch, 300);

  // Build filter params for All Tasks
  const [serviceTypeFilter, setServiceTypeFilter] = useState<string>('');
  const [phaseFilter, setPhaseFilter] = useState<string>('');

  const filters: Record<string, unknown> = {};
  if (debouncedSearch) filters.search = debouncedSearch;
  if (taskStatus.length) filters.status = taskStatus[0];
  if (taskPriority.length) filters.priority = taskPriority[0];
  if (taskProjectId) filters.projectId = taskProjectId;
  if (serviceTypeFilter) filters.serviceTypeId = Number(serviceTypeFilter);
  if (phaseFilter) filters.phaseId = Number(phaseFilter);

  // All tasks
  const { data: allData, isLoading: allLoading } = useQuery({
    queryKey: ['tasks', 'all', filters],
    queryFn: () => tasksApi.list(filters),
    enabled: tab === 'all',
  });

  // Archived tasks. Same filter set as All Tasks but with archived=true
  // so the backend flips the predicate from "deletedAt IS NULL" to
  // "deletedAt IS NOT NULL". Restoring a row invalidates this key so
  // the list refreshes without a manual refetch.
  const queryClient = useQueryClient();
  const archivedFilters = { ...filters, archived: true };
  const { data: archivedData, isLoading: archivedLoading } = useQuery({
    queryKey: ['tasks', 'archived', archivedFilters],
    queryFn: () => tasksApi.list(archivedFilters),
    enabled: tab === 'archived',
  });
  const restoreMutation = useMutation({
    mutationFn: (id: number) => tasksApi.restore(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      notify.success('Task restored', { code: 'TASK-RESTORE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to restore task'),
  });

  // My tasks
  const { data: myData, isLoading: myLoading } = useQuery({
    queryKey: ['tasks', 'mine'],
    queryFn: () => tasksApi.mine(),
  });

  // Lookup data for filter dropdowns
  const { data: serviceTypes } = useQuery({
    queryKey: ['service-types'],
    queryFn: () => client.get('/service-types').then((r) => r.data.data ?? r.data),
    enabled: tab === 'all',
  });

  const { data: phases } = useQuery({
    queryKey: ['phases'],
    queryFn: () => client.get('/phases').then((r) => r.data.data ?? r.data),
    enabled: tab === 'all',
  });

  const { data: projects } = useQuery({
    queryKey: ['projects-list'],
    queryFn: () =>
      client.get('/projects').then((r) => {
        const d = r.data.data ?? r.data;
        return d.data ?? d;
      }),
    enabled: tab === 'all',
  });

  const allTasks: TaskRow[] = allData?.data ?? allData ?? [];
  const myTasks: TaskRow[] = myData?.data ?? myData ?? [];

  const tabs: { key: Tab; label: string }[] = [
    { key: 'mine', label: 'My Tasks' },
    { key: 'all', label: 'All Tasks' },
    { key: 'archived', label: 'Archived' },
  ];

  const resetAllFilters = () => {
    setTaskFilters({
      taskSearch: '',
      taskStatus: [],
      taskPriority: [],
      taskProjectId: null,
      taskAssigneeId: null,
    });
    setServiceTypeFilter('');
    setPhaseFilter('');
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        description="Manage and track all tasks"
        actions={
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" />
            New Task
          </button>
        }
      />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              tab === t.key
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* All Tasks tab */}
      {tab === 'all' && (
        <>
          <FilterBar
            search={taskSearch}
            onSearchChange={(v) => setTaskFilters({ taskSearch: v })}
            searchPlaceholder="Search tasks..."
            filters={[
              {
                key: 'project',
                label: 'Project',
                value: taskProjectId ? String(taskProjectId) : '',
                onChange: (v) =>
                  setTaskFilters({
                    taskProjectId: v ? Number(v) : null,
                  }),
                options: (projects ?? []).map((p: { id: number; name: string }) => ({
                  label: p.name,
                  value: String(p.id),
                })),
              },
              {
                key: 'serviceType',
                label: 'Service Type',
                value: serviceTypeFilter,
                onChange: (v) => setServiceTypeFilter(v as string),
                options: (serviceTypes ?? []).map((s: { id: number; name: string }) => ({
                  label: s.name,
                  value: String(s.id),
                })),
              },
              {
                key: 'phase',
                label: 'Phase',
                value: phaseFilter,
                onChange: (v) => setPhaseFilter(v as string),
                options: (phases ?? []).map((p: { id: number; name: string }) => ({
                  label: p.name,
                  value: String(p.id),
                })),
              },
              {
                key: 'status',
                label: 'Status',
                value: taskStatus,
                onChange: (v) => setTaskFilters({ taskStatus: v as string[] }),
                multiple: true,
                options: [
                  // Labels mirror STATUS_LABEL so the filter wording matches
                  // the badges shown on each task row / card.
                  { label: 'To Do', value: 'not_started' },
                  { label: 'In Progress', value: 'in_progress' },
                  { label: 'In Review', value: 'in_review' },
                  { label: 'Done', value: 'completed' },
                  { label: 'On Hold', value: 'on_hold' },
                ],
              },
              {
                key: 'priority',
                label: 'Priority',
                value: taskPriority,
                onChange: (v) => setTaskFilters({ taskPriority: v as string[] }),
                multiple: true,
                options: [
                  { label: 'Low', value: 'low' },
                  { label: 'Medium', value: 'medium' },
                  { label: 'High', value: 'high' },
                  { label: 'Critical', value: 'critical' },
                ],
              },
            ]}
            onReset={resetAllFilters}
          />

          <DataTable
            columns={columns}
            data={allTasks}
            isLoading={allLoading}
            onRowClick={(task) => navigate(`/tasks/${task.id}`)}
            renderCard={(task) => <TaskCard task={task as never} />}
            emptyMessage="No tasks found"
          />
        </>
      )}

      {/* My Tasks tab */}
      {tab === 'mine' && (
        <div className="space-y-3">
          {myLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : myTasks.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No tasks assigned to you
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {myTasks.map((task) => (
                <div
                  key={task.id}
                  onClick={() => navigate(`/tasks/${task.id}`)}
                  className="cursor-pointer"
                >
                  <div className="rounded-lg border border-border bg-background p-4 transition-colors hover:bg-muted/50">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-mono text-muted-foreground">{task.code}</p>
                        <h3 className="mt-0.5 truncate text-sm font-medium">{task.name}</h3>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {task.project?.name ?? ''}
                          {/* zone breadcrumb if present, else explicit
                              "Project Root" marker so root tasks (with
                              zoneId=null) aren't silently anonymous. */}
                          {task.zone
                            ? ` / ${task.zone.name}`
                            : ' / Project Root'}
                        </p>
                      </div>
                      <PriorityBadge priority={task.priority} />
                    </div>

                    {task.serviceType && (
                      <div className="mt-2">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ backgroundColor: task.serviceType.color }}
                          />
                          {task.serviceType.name}
                        </span>
                      </div>
                    )}

                    <div className="mt-3 flex items-center gap-2">
                      <StatusBadge status={task.status} />
                      {task.phase && (
                        <span className="text-xs text-muted-foreground">
                          {task.phase.name}
                        </span>
                      )}
                    </div>

                    {/* Progress bar */}
                    {task.completionPct > 0 && (
                      <div className="mt-3">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>Progress</span>
                          <span>{task.completionPct}%</span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-brand-500 transition-all"
                            style={{ width: `${task.completionPct}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {task.assignees && task.assignees.length > 0 && (
                      <div className="mt-3 flex -space-x-1">
                        {task.assignees.slice(0, 5).map((a) => (
                          <UserAvatar
                            key={a.id}
                            firstName={a.user?.firstName ?? ''}
                            lastName={a.user?.lastName ?? ''}
                            avatarUrl={a.user?.avatarUrl}
                            size="xs"
                            className="ring-2 ring-background"
                          />
                        ))}
                        {task.assignees.length > 5 && (
                          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium ring-2 ring-background">
                            +{task.assignees.length - 5}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Archived tab — shows soft-deleted tasks with a Restore button.
          Reuses the same backend list endpoint (with archived=true) so
          the table is consistent with All Tasks. Restoring invalidates
          the tasks query keys so the row vanishes from Archived and
          reappears under All Tasks immediately. */}
      {tab === 'archived' && (
        <div className="space-y-4">
          {archivedLoading ? (
            <p className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">Loading…</p>
          ) : !archivedData || (archivedData?.data ?? archivedData ?? []).length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-400 dark:text-slate-500 italic">
              No archived tasks. Deleted tasks land here.
            </p>
          ) : (
            <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
              <table className="w-full text-[13px]">
                <thead className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-2 text-left">Code</th>
                    <th className="px-4 py-2 text-left">Name</th>
                    <th className="px-4 py-2 text-left">Project</th>
                    <th className="px-4 py-2 text-left">Zone</th>
                    <th className="px-4 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {((archivedData as any)?.data ?? archivedData ?? []).map((t: any) => (
                    <tr key={t.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
                      <td className="px-4 py-2 font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">{t.code}</td>
                      <td className="px-4 py-2 max-w-[260px]">
                        <span className="block truncate font-medium text-slate-700 dark:text-slate-200" title={t.name}>
                          {t.name}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-slate-600 dark:text-slate-300 truncate max-w-[200px]" title={t.project?.name ?? ''}>
                        {t.project?.name ?? '—'}
                      </td>
                      <td className="px-4 py-2 text-slate-600 dark:text-slate-300 truncate max-w-[180px]" title={t.zone?.name ?? ''}>
                        {t.zone?.name ?? 'Project Root'}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button
                          onClick={() => restoreMutation.mutate(t.id)}
                          disabled={restoreMutation.isPending}
                          className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {showCreate && (
        <CreateTaskModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => navigate(`/tasks/${id}`)}
        />
      )}
    </div>
  );
}
