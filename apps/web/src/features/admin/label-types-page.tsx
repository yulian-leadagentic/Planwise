import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { toast } from 'sonner';

export function LabelTypesPage() {
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
      toast.success('Label type created');
      setShowForm(false);
      setName('');
      setColor('#3B82F6');
      setIcon('');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to create label type'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/admin/config/label-types/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'label-types'] });
      toast.success('Label type deleted');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to delete'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({ name: name.trim(), color, icon: icon.trim() || undefined });
  };

  const labelTypes = data ?? [];

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
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-9 w-12 rounded border border-input cursor-pointer"
                />
                <input
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
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
        <p className="py-8 text-center text-sm text-muted-foreground">No label types configured yet. Click "Add Label Type" to create one.</p>
      ) : (
        <div className="rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Color</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Icon</th>
                <th className="px-4 py-3 font-medium">Order</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {labelTypes.map((lt: any) => (
                <tr key={lt.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <span className="inline-block h-4 w-4 rounded-full" style={{ backgroundColor: lt.color }} />
                  </td>
                  <td className="px-4 py-3 font-medium">{lt.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{lt.icon ?? '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{lt.sortOrder}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => { if (confirm(`Delete "${lt.name}"?`)) deleteMutation.mutate(lt.id); }}
                      className="text-xs text-red-600 hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
