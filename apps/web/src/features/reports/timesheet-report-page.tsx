import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Download } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { LoadingSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { minutesToDisplay } from '@amec/shared';

export function TimesheetReportPage() {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
  const lastOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];

  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(lastOfMonth);

  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'timesheet', from, to],
    queryFn: () => client.get('/reports/timesheet/by-project', { params: { from, to } }).then((r) => r.data.data),
  });

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Timesheet Report"
        description="Hours logged by user and project"
        actions={
          <button className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">
            <Download className="h-4 w-4" /> Export
          </button>
        }
      />

      <div className="flex flex-wrap gap-3">
        <div>
          <label className="block text-xs text-muted-foreground">From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground">To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm" />
        </div>
      </div>

      {isLoading ? (
        <LoadingSkeleton lines={8} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No timesheet data for this period.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Project</th>
                <th className="px-4 py-3 font-medium">Total Hours</th>
                <th className="px-4 py-3 font-medium">Billable</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row: any, i: number) => (
                <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{row.userName}</td>
                  <td className="px-4 py-3">{row.projectName ?? '—'}</td>
                  <td className="px-4 py-3">{minutesToDisplay(row.totalMinutes)}</td>
                  <td className="px-4 py-3">{minutesToDisplay(row.billableMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
