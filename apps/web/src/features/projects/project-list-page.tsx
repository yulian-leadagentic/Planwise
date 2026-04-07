import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, FolderKanban, Trash2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/shared/page-header';
import { FilterBar } from '@/components/shared/filter-bar';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { useProjects } from '@/hooks/use-projects';
import { useFilterStore } from '@/stores/filter.store';
import { useDebounce } from '@/hooks/use-debounce';
import { formatDate } from '@/lib/date-utils';
import { formatCurrency } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import type { Project } from '@/types';
import type { ColumnDef } from '@tanstack/react-table';

const columns: ColumnDef<Project, unknown>[] = [
  {
    accessorKey: 'name',
    header: 'Project',
    cell: ({ row }) => (
      <div>
        <p className="font-medium">{row.original.name}</p>
        {row.original.number && (
          <p className="text-xs text-muted-foreground">{row.original.number}</p>
        )}
      </div>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    accessorKey: 'projectTypeName',
    header: 'Type',
    cell: ({ row }) => row.original.projectTypeName ?? '-',
  },
  {
    accessorKey: 'budget',
    header: 'Budget',
    cell: ({ row }) =>
      row.original.budget != null ? formatCurrency(row.original.budget) : '-',
  },
  {
    accessorKey: 'startDate',
    header: 'Start',
    cell: ({ row }) => (row.original.startDate ? formatDate(row.original.startDate) : '-'),
  },
  {
    accessorKey: 'endDate',
    header: 'End',
    cell: ({ row }) => (row.original.endDate ? formatDate(row.original.endDate) : '-'),
  },
  {
    id: 'actions',
    header: '',
    cell: ({ row }) => (
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (confirm(`Delete "${row.original.name}"?`)) {
            // Will be handled by the component
          }
        }}
        className="opacity-0 group-hover:opacity-100 w-[30px] h-[30px] rounded-[7px] hover:bg-red-50 flex items-center justify-center text-slate-300 hover:text-red-600 transition-all duration-150"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    ),
    enableSorting: false,
  },
];

export function ProjectListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { projectSearch, projectStatus, setProjectFilters } = useFilterStore();
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const deleteProject = useMutation({
    mutationFn: (id: number) => client.delete(`/projects/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      notify.success('Project deleted', { code: 'PROJECT-DELETE-200' });
      setDeletingId(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete project'),
  });

  const handleDelete = (e: React.MouseEvent, project: any) => {
    e.stopPropagation();
    if (confirm(`Delete project "${project.name}"? This action cannot be undone.`)) {
      deleteProject.mutate(project.id);
    }
  };
  const debouncedSearch = useDebounce(projectSearch, 300);

  const { data, isLoading } = useProjects({
    search: debouncedSearch || undefined,
    status: projectStatus.length ? projectStatus[0] : undefined,
  });

  const projects = data?.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        description="Manage your projects"
        actions={
          <button
            onClick={() => navigate('/projects/new')}
            className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" />
            New Project
          </button>
        }
      />

      <FilterBar
        search={projectSearch}
        onSearchChange={(v) => setProjectFilters({ projectSearch: v })}
        searchPlaceholder="Search projects..."
        filters={[
          {
            key: 'status',
            label: 'Status',
            value: projectStatus,
            onChange: (v) => setProjectFilters({ projectStatus: v as string[] }),
            multiple: true,
            options: [
              { label: 'Draft', value: 'draft' },
              { label: 'Active', value: 'active' },
              { label: 'On Hold', value: 'on_hold' },
              { label: 'Completed', value: 'completed' },
              { label: 'Cancelled', value: 'cancelled' },
            ],
          },
        ]}
        onReset={() => setProjectFilters({ projectSearch: '', projectStatus: [] })}
      />

      {!isLoading && projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Create your first project to get started"
          action={
            <button
              onClick={() => navigate('/projects/new')}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Create Project
            </button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          data={projects}
          isLoading={isLoading}
          onRowClick={(project) => navigate(`/projects/${project.id}`)}
          renderCard={(project) => (
            <div className="rounded-[14px] border border-slate-200 bg-white p-4 hover:bg-slate-50 group">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-[13px] font-semibold text-slate-900">{project.name}</h3>
                  {project.number && (
                    <p className="text-xs font-mono text-slate-400">{project.number}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={project.status} />
                  <button
                    onClick={(e) => handleDelete(e, project)}
                    className="opacity-0 group-hover:opacity-100 w-[30px] h-[30px] rounded-[7px] hover:bg-red-50 flex items-center justify-center text-slate-300 hover:text-red-600 transition-all duration-150"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {project.budget != null && (
                <p className="mt-2 text-[13px] text-slate-500">
                  Budget: <span className="font-mono text-xs font-semibold text-slate-700">{formatCurrency(project.budget)}</span>
                </p>
              )}
            </div>
          )}
          emptyMessage="No projects found"
        />
      )}
    </div>
  );
}
