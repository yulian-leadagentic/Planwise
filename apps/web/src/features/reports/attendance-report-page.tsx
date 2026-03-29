import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Download } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';

export function AttendanceReportPage() {
  const today = new Date();
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [year, setYear] = useState(today.getFullYear());

  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'attendance', month, year],
    queryFn: () => client.get('/reports/attendance/summary', { params: { month, year } }).then((r) => r.data.data),
  });

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Attendance Report"
        description="Presence, absence, sick days, and leave"
        actions={
          <button className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">
            <Download className="h-4 w-4" /> Export
          </button>
        }
      />

      <div className="flex flex-wrap gap-3">
        <div>
          <label className="block text-xs text-muted-foreground">Month</label>
          <select value={month} onChange={(e) => setMonth(+e.target.value)} className="mt-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm">
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i + 1} value={i + 1}>{new Date(2000, i).toLocaleString('default', { month: 'long' })}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground">Year</label>
          <input type="number" value={year} onChange={(e) => setYear(+e.target.value)} className="mt-1 w-24 rounded-md border border-input bg-background px-3 py-1.5 text-sm" />
        </div>
      </div>

      {isLoading ? (
        <TableSkeleton rows={8} cols={6} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No attendance data for this period.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Employee</th>
                <th className="px-4 py-3 text-center font-medium">Present</th>
                <th className="px-4 py-3 text-center font-medium">Sick</th>
                <th className="px-4 py-3 text-center font-medium">Leave</th>
                <th className="px-4 py-3 text-center font-medium">Absent</th>
                <th className="px-4 py-3 text-center font-medium">Late</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row: any) => (
                <tr key={row.userId} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{row.userName}</td>
                  <td className="px-4 py-3 text-center">{row.daysPresent}</td>
                  <td className="px-4 py-3 text-center">{row.daysSick}</td>
                  <td className="px-4 py-3 text-center">{row.daysLeave}</td>
                  <td className="px-4 py-3 text-center">{row.daysAbsent}</td>
                  <td className="px-4 py-3 text-center">{row.daysLate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
