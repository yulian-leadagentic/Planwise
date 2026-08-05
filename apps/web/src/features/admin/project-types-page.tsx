import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft, FolderKanban } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';

export function ProjectTypesPage() {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'project-types'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/admin/config/project-types').then((r) => r.data.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; code?: string }) =>
      client.post('/admin/config/project-types', data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'project-types'] });
      notify.success('Project type created', { code: 'PROJECT-CREATE-200' });
      setShowForm(false);
      setName('');
      setCode('');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create project type'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/admin/config/project-types/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'project-types'] });
      notify.success('Project type deleted', { code: 'PROJECT-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({ name: name.trim(), code: code.trim() || undefined });
  };

  const types = data ?? [];

  const columns = useMemo<ColumnDef<any, unknown>[]>(() => [
    { accessorKey: 'name', header: 'Type Name', enableSorting: false,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
    { accessorKey: 'code', header: 'Code', enableSorting: false,
      cell: ({ row }) => (
        row.original.code
          ? <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs text-orange-700">{row.original.code}</span>
          : <span className="text-muted-foreground">-</span>
      ) },
    { id: 'actions', header: 'Actions', enableSorting: false, size: 96,
      cell: ({ row }) => (
        <button
          onClick={async () => { if (await confirm(`Delete "${row.original.name}"?`)) deleteMutation.mutate(row.original.id); }}
          aria-label={`Delete project type ${row.original.name}`}
          className="text-xs text-red-600 hover:underline"
        >
          Delete
        </button>
      ) },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/templates')} aria-label="Back to templates" className="rounded-md p-1.5 hover:bg-accent">
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        <PageHeader
          title="Project Types"
          description="Manage project type classifications"
          actions={
            <button
              onClick={() => setShowForm(!showForm)}
              className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" /> Add Type
            </button>
          }
        />
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-background p-4">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">Type Name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Civil Engineering"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                autoFocus
              />
            </div>
            <div className="w-32">
              <label className="block text-sm font-medium mb-1">Code</label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. BIM"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {isLoading ? (
        <TableSkeleton rows={5} cols={1} />
      ) : types.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No project types configured yet"
          description={'Click "Add Type" to create one.'}
        />
      ) : (
        <DataTable columns={columns} data={types} pageSize={1000} />
      )}
    </div>
  );
}
