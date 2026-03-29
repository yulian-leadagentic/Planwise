import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { LoadingSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function WorkSchedulesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'work-schedules'],
    queryFn: () => client.get('/work-schedules').then((r) => r.data.data),
  });

  const schedules = data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Work Schedules"
        description="Configure employee work schedules and shifts"
        actions={
          <button className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" /> Add Schedule
          </button>
        }
      />

      {isLoading ? (
        <LoadingSkeleton lines={5} />
      ) : schedules.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No work schedules configured yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Day</th>
                <th className="px-4 py-3 font-medium">Shift Start</th>
                <th className="px-4 py-3 font-medium">Shift End</th>
                <th className="px-4 py-3 font-medium">Break</th>
                <th className="px-4 py-3 font-medium">Active</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s: any) => (
                <tr key={s.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{s.name}</td>
                  <td className="px-4 py-3">{DAYS[s.dayOfWeek] ?? s.dayOfWeek}</td>
                  <td className="px-4 py-3">{s.shiftStart}</td>
                  <td className="px-4 py-3">{s.shiftEnd}</td>
                  <td className="px-4 py-3">{s.breakMinutes}min</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {s.isActive ? 'Active' : 'Inactive'}
                    </span>
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
