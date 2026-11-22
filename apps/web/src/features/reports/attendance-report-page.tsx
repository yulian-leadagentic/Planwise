import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { notify } from '@/lib/notify';

/**
 * One row of GET /reports/attendance/summary — per employee, distinct
 * days in the range. The API returns a plain array and accepts
 * `from` / `to` (YYYY-MM-DD); month / year are UI-only and are turned
 * into that range here (the API's query whitelist rejects them).
 * Since permissions round 3 the rows cover only the employees the
 * caller may see (everyone for HR, otherwise the people he manages).
 */
interface AttendanceRow {
  user: { id: number; firstName: string | null; lastName: string | null };
  totalDays: number;
  presentDays: number;
  absentDays: number;
  sickDays?: number;
  leaveDays?: number;
  lateDays: number;
  totalMinutes: number;
  overtimeMinutes: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** First and last day of a month as YYYY-MM-DD (no timezone shifts). */
function monthRange(year: number, month: number): { from: string; to: string } {
  const lastDay = new Date(year, month, 0).getDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay)}` };
}

export function AttendanceReportPage() {
  const scrollRef = useStickyHScroll();
  const today = new Date();
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [year, setYear] = useState(today.getFullYear());
  const validYear = Number.isInteger(year) && year >= 2000 && year <= 2100;
  const { from, to } = monthRange(validYear ? year : today.getFullYear(), month);

  const { data, isLoading, error } = useQuery<AttendanceRow[]>({
    queryKey: ['reports', 'attendance', from, to],
    queryFn: () =>
      client.get('/reports/attendance/summary', { params: { from, to } }).then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
    enabled: validYear,
  });

  useEffect(() => {
    if (error) notify.apiError(error, 'Failed to load the attendance report');
  }, [error]);

  const rows = data ?? [];

  return (
    <div className="space-y-6">
      {/* Export intentionally omitted until wired to a real endpoint —
          the button was previously inert (no onClick). */}
      <PageHeader
        title="Attendance Report"
        description="Presence, absence, sick days, and leave"
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
        <div ref={scrollRef} className="overflow-x-auto rounded-lg border border-border">
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
              {rows.map((row) => (
                <tr key={row.user.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">
                    {`${row.user.firstName ?? ''} ${row.user.lastName ?? ''}`.trim() || '—'}
                  </td>
                  <td className="px-4 py-3 text-center font-mono">{row.presentDays}</td>
                  <td className="px-4 py-3 text-center font-mono">{row.sickDays ?? '—'}</td>
                  <td className="px-4 py-3 text-center font-mono">{row.leaveDays ?? '—'}</td>
                  <td className="px-4 py-3 text-center font-mono">{row.absentDays}</td>
                  <td className="px-4 py-3 text-center font-mono">{row.lateDays}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
