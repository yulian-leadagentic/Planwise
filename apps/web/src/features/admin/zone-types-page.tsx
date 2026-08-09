import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Pencil, Save, X, Layers } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { DataTable } from '@/components/shared/data-table';
import { ColorPalettePicker } from '@/components/shared/color-palette-picker';
import client from '@/api/client';
import { notify } from '@/lib/notify';

// Zone Types are backed by a Prisma enum (site/building/level/floor/wing/
// section/area/zone). Adding or deleting them would break the enum and
// orphan zones, so the admin can only EDIT the displayed label / color /
// icon / sort order. Add and Delete actions are intentionally absent.

type ZoneTypeRow = {
  id: number;
  code: string;
  label: string;
  color: string;
  icon: string | null;
  sortOrder: number;
};

export function ZoneTypesPage() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editColor, setEditColor] = useState('#3B82F6');
  const [editIcon, setEditIcon] = useState('');
  const [editSortOrder, setEditSortOrder] = useState(0);

  const { data, isLoading } = useQuery<ZoneTypeRow[]>({
    queryKey: ['admin', 'zone-types'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/admin/config/zone-types').then((r) => r.data?.data ?? r.data),
  });

  const updateMutation = useMutation({
    mutationFn: (vars: { id: number; label: string; color: string; icon: string | null; sortOrder: number }) =>
      client.patch(`/admin/config/zone-types/${vars.id}`, {
        label: vars.label,
        color: vars.color,
        icon: vars.icon,
        sortOrder: vars.sortOrder,
      }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'zone-types'] });
      notify.success('Zone type updated', { code: 'ZONE-UPDATE-200' });
      setEditingId(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update zone type'),
  });

  const startEdit = (zt: ZoneTypeRow) => {
    setEditingId(zt.id);
    setEditLabel(zt.label);
    setEditColor(zt.color);
    setEditIcon(zt.icon ?? '');
    setEditSortOrder(zt.sortOrder);
  };

  const cancelEdit = () => setEditingId(null);

  const saveEdit = (id: number) => {
    if (!editLabel.trim()) return;
    updateMutation.mutate({
      id,
      label: editLabel.trim(),
      color: editColor,
      icon: editIcon.trim() || null,
      sortOrder: editSortOrder,
    });
  };

  const zoneTypes = Array.isArray(data) ? data : [];

  const columns = useMemo<ColumnDef<ZoneTypeRow, unknown>[]>(() => [
    { id: 'color', header: 'Color', enableSorting: false, size: 80,
      cell: ({ row }) => {
        const zt = row.original;
        if (editingId === zt.id) return <ColorPalettePicker value={editColor} onChange={setEditColor} />;
        return <span className="inline-block h-4 w-4 rounded-full" style={{ backgroundColor: zt.color }} />;
      } },
    { accessorKey: 'code', header: 'Code', enableSorting: false,
      cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.code}</span> },
    { accessorKey: 'label', header: 'Label', enableSorting: false,
      cell: ({ row }) => {
        const zt = row.original;
        if (editingId === zt.id) {
          return (
            <input
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          );
        }
        return <span className="font-medium">{zt.label}</span>;
      } },
    { accessorKey: 'icon', header: 'Icon', enableSorting: false,
      cell: ({ row }) => {
        const zt = row.original;
        if (editingId === zt.id) {
          return (
            <input
              value={editIcon}
              onChange={(e) => setEditIcon(e.target.value)}
              placeholder="lucide name"
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          );
        }
        return <span className="text-muted-foreground">{zt.icon ?? '—'}</span>;
      } },
    { accessorKey: 'sortOrder', header: 'Order', enableSorting: false, size: 96,
      cell: ({ row }) => {
        const zt = row.original;
        if (editingId === zt.id) {
          return (
            <input
              type="number"
              value={editSortOrder}
              onChange={(e) => setEditSortOrder(Number(e.target.value))}
              className="w-16 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          );
        }
        return <span className="text-muted-foreground">{zt.sortOrder}</span>;
      } },
    { id: 'actions', header: 'Actions', enableSorting: false, size: 160,
      cell: ({ row }) => {
        const zt = row.original;
        if (editingId === zt.id) {
          return (
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => saveEdit(zt.id)}
                disabled={updateMutation.isPending || !editLabel.trim()}
                aria-label={`Save ${zt.code}`}
                className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                <Save className="h-3 w-3" aria-hidden="true" /> Save
              </button>
              <button
                onClick={cancelEdit}
                aria-label="Cancel edit"
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent"
              >
                <X className="h-3 w-3" aria-hidden="true" /> Cancel
              </button>
            </div>
          );
        }
        return (
          <div className="text-right">
            <button
              onClick={() => startEdit(zt)}
              aria-label={`Edit ${zt.code}`}
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
            >
              <Pencil className="h-3 w-3" aria-hidden="true" /> Edit
            </button>
          </div>
        );
      } },
  ], [editingId, editLabel, editColor, editIcon, editSortOrder, updateMutation.isPending]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Zone Types"
        description="Customise the display label, colour, icon, and order of zone types. The list itself is fixed by the system — types cannot be added or removed because zones in projects reference these values."
      />

      {isLoading ? (
        <TableSkeleton rows={5} cols={5} />
      ) : zoneTypes.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No zone types found"
          description="Run database migrations to seed them."
        />
      ) : (
        <DataTable columns={columns} data={zoneTypes} pageSize={1000} />
      )}
    </div>
  );
}
