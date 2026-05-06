import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pencil, Save, X } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
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

  const cancelEdit = () => {
    setEditingId(null);
  };

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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Zone Types"
        description="Customise the display label, colour, icon, and order of zone types. The list itself is fixed by the system — types cannot be added or removed because zones in projects reference these values."
      />

      {isLoading ? (
        <TableSkeleton rows={5} cols={5} />
      ) : zoneTypes.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No zone types found. Run database migrations to seed them.</p>
      ) : (
        <div className="rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium w-16">Color</th>
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Label</th>
                <th className="px-4 py-3 font-medium">Icon</th>
                <th className="px-4 py-3 font-medium w-20">Order</th>
                <th className="px-4 py-3 font-medium w-32 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {zoneTypes.map((zt) => {
                const isEditing = editingId === zt.id;
                return (
                  <tr key={zt.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      {isEditing ? (
                        <ColorPalettePicker value={editColor} onChange={setEditColor} />
                      ) : (
                        <span className="inline-block h-4 w-4 rounded-full" style={{ backgroundColor: zt.color }} />
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{zt.code}</td>
                    <td className="px-4 py-3 font-medium">
                      {isEditing ? (
                        <input
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                          className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      ) : (
                        zt.label
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {isEditing ? (
                        <input
                          value={editIcon}
                          onChange={(e) => setEditIcon(e.target.value)}
                          placeholder="lucide name"
                          className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      ) : (
                        zt.icon ?? '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {isEditing ? (
                        <input
                          type="number"
                          value={editSortOrder}
                          onChange={(e) => setEditSortOrder(Number(e.target.value))}
                          className="w-16 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      ) : (
                        zt.sortOrder
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {isEditing ? (
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => saveEdit(zt.id)}
                            disabled={updateMutation.isPending || !editLabel.trim()}
                            className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                          >
                            <Save className="h-3 w-3" /> Save
                          </button>
                          <button
                            onClick={cancelEdit}
                            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent"
                          >
                            <X className="h-3 w-3" /> Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => startEdit(zt)}
                          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                        >
                          <Pencil className="h-3 w-3" /> Edit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
