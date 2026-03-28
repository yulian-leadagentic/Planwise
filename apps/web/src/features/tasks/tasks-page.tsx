import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { FilterBar } from '@/components/shared/filter-bar';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge } from '@/components/shared/status-badge';
import { PriorityBadge } from '@/components/shared/priority-badge';
import { UserAvatar } from '@/components/shared/user-avatar';
import { TaskCard } from './task-card';
import { useTasks } from '@/hooks/use-tasks';
import { useFilterStore } from '@/stores/filter.store';
import { useDebounce } from '@/hooks/use-debounce';
import { formatDate } from '@/lib/date-utils';
import { minutesToDisplay } from '@/types';
import type { Task } from '@/types';
import type { ColumnDef } from '@tanstack/react-table';

const columns: ColumnDef<Task, unknown>[] = [
  {
    accessorKey: 'name',
    header: 'Task',
    cell: ({ row }) => (
      <div className="min-w-0">
        <p className="truncate font-medium">{row.original.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {row.original.label?.projectName} / {row.original.label?.name}
        </p>
      </div>
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
  {
    accessorKey: 'loggedMinutes',
    header: 'Logged',
    cell: ({ row }) =>
      row.original.loggedMinutes ? minutesToDisplay(row.original.loggedMinutes) : '-',
  },
  {
    accessorKey: 'endDate',
    header: 'Due Date',
    cell: ({ row }) => (row.original.endDate ? formatDate(row.original.endDate) : '-'),
  },
];

export function TasksPage() {
  const navigate = useNavigate();
  const {
    taskSearch,
    taskStatus,
    taskPriority,
    taskProjectId,
    setTaskFilters,
  } = useFilterStore();

  const debouncedSearch = useDebounce(taskSearch, 300);

  const { data, isLoading } = useTasks({
    search: debouncedSearch || undefined,
    status: taskStatus.length ? taskStatus : undefined,
    priority: taskPriority.length ? taskPriority : undefined,
    projectId: taskProjectId ?? undefined,
  });

  const tasks = data?.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        description="Manage and track all tasks"
        actions={
          <button
            onClick={() => {/* TODO: open create dialog */}}
            className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" />
            New Task
          </button>
        }
      />

      <FilterBar
        search={taskSearch}
        onSearchChange={(v) => setTaskFilters({ taskSearch: v })}
        searchPlaceholder="Search tasks..."
        filters={[
          {
            key: 'status',
            label: 'Status',
            value: taskStatus,
            onChange: (v) => setTaskFilters({ taskStatus: v as string[] }),
            multiple: true,
            options: [
              { label: 'Not Started', value: 'not_started' },
              { label: 'In Progress', value: 'in_progress' },
              { label: 'In Review', value: 'in_review' },
              { label: 'Completed', value: 'completed' },
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
        onReset={() =>
          setTaskFilters({
            taskSearch: '',
            taskStatus: [],
            taskPriority: [],
            taskProjectId: null,
            taskAssigneeId: null,
          })
        }
      />

      <DataTable
        columns={columns}
        data={tasks}
        isLoading={isLoading}
        onRowClick={(task) => navigate(`/tasks/${task.id}`)}
        renderCard={(task) => <TaskCard task={task} />}
        emptyMessage="No tasks found"
      />
    </div>
  );
}
