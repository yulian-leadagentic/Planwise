import { useNavigate } from 'react-router-dom';
import { Plus, FolderKanban } from 'lucide-react';
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
];

export function ProjectListPage() {
  const navigate = useNavigate();
  const { projectSearch, projectStatus, setProjectFilters } = useFilterStore();
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
            <div className="rounded-lg border border-border bg-background p-4 hover:bg-muted/50">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-medium">{project.name}</h3>
                  {project.number && (
                    <p className="text-xs text-muted-foreground">{project.number}</p>
                  )}
                </div>
                <StatusBadge status={project.status} />
              </div>
              {project.budget != null && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Budget: {formatCurrency(project.budget)}
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
