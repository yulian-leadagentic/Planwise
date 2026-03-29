import { useQuery } from '@tanstack/react-query';
import { Tag, Plus } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';

export function LabelTypesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'label-types'],
    queryFn: () => client.get('/admin/config/label-types').then((r) => r.data.data),
  });

  const labelTypes = data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Label Types"
        description="Configure label type categories and colors"
        actions={
          <button className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" /> Add Label Type
          </button>
        }
      />

      {isLoading ? (
        <TableSkeleton rows={5} cols={4} />
      ) : labelTypes.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No label types configured yet.</p>
      ) : (
        <div className="rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Color</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Icon</th>
                <th className="px-4 py-3 font-medium">Order</th>
              </tr>
            </thead>
            <tbody>
              {labelTypes.map((lt: any) => (
                <tr key={lt.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <span
                      className="inline-block h-4 w-4 rounded-full"
                      style={{ backgroundColor: lt.color }}
                    />
                  </td>
                  <td className="px-4 py-3 font-medium">{lt.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{lt.icon ?? '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{lt.sortOrder}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
