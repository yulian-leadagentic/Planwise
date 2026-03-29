import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { LoadingSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';

export function ProjectTypesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'project-types'],
    queryFn: () => client.get('/admin/config/project-types').then((r) => r.data.data),
  });

  const types = data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Project Types"
        description="Manage project type classifications"
        actions={
          <button className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" /> Add Type
          </button>
        }
      />

      {isLoading ? (
        <LoadingSkeleton lines={5} />
      ) : types.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No project types configured yet.</p>
      ) : (
        <div className="rounded-lg border border-border">
          {types.map((t: any, i: number) => (
            <div
              key={t.id}
              className={`flex items-center justify-between px-4 py-3 ${i < types.length - 1 ? 'border-b border-border' : ''} hover:bg-muted/30`}
            >
              <span className="font-medium text-sm">{t.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
