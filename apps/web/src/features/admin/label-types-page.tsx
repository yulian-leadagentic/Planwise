import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Tag } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import { ColorPalettePicker } from '@/components/shared/color-palette-picker';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';

export function LabelTypesPage() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#3B82F6');
  const [icon, setIcon] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'label-types'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/admin/config/label-types').then((r) => r.data.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; color: string; icon?: string }) =>
      client.post('/admin/config/label-types', data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'label-types'] });
      notify.success('Label type created', { code: 'PROJECT-CREATE-200' });
      setShowForm(false);
      setName('');
      setColor('#3B82F6');
      setIcon('');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create label type'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/admin/config/label-types/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'label-types'] });
      notify.success('Label type deleted', { code: 'PROJECT-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({ name: name.trim(), color, icon: icon.trim() || undefined });
  };

  const labelTypes = data ?? [];

  // Columns for the shared DataTable — sorting off (matches original
  // no-sort behavior; underlying list is server-ordered).
  const columns = useMemo<ColumnDef<any, unknown>[]>(() => [
    { id: 'color', header: 'Color', enableSorting: false, size: 64,
      cell: ({ row }) => (
        <span className="inline-block h-4 w-4 rounded-full" style={{ backgroundColor: row.original.color }} />
      ) },
    { accessorKey: 'name', header: 'Name', enableSorting: false,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
    { accessorKey: 'icon', header: 'Icon', enableSorting: false,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.icon ?? '—'}</span> },
    { accessorKey: 'sortOrder', header: 'Order', enableSorting: false, size: 96,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.sortOrder}</span> },
    { id: 'actions', header: 'Actions', enableSorting: false, size: 96,
      cell: ({ row }) => (
        <button
          onClick={async () => { if (await confirm(`Delete "${row.original.name}"?`)) deleteMutation.mutate(row.original.id); }}
          aria-label={`Delete label type ${row.original.name}`}
          className="text-xs text-red-600 hover:underline"
        >
          Delete
        </button>
      ) },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Label Types"
        description="Configure label type categories and colors"
        actions={
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" /> Add Label Type
          </button>
        }
      />

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Phase, Category"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Color</label>
              <ColorPalettePicker value={color} onChange={setColor} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Icon</label>
              <input
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="e.g. Layers, FolderTree"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <div className="flex gap-2">
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
        <TableSkeleton rows={5} cols={4} />
      ) : labelTypes.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="No label types configured yet"
          description={'Click "Add Label Type" to create one.'}
        />
      ) : (
        <DataTable columns={columns} data={labelTypes} pageSize={1000} />
      )}
    </div>
  );
}
