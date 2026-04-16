import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users, ChevronLeft, ChevronRight, BarChart3 } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { format, addDays, startOfWeek } from '@/lib/date-utils';

function getUtilColor(pct: number): string {
  if (pct === 0) return 'bg-slate-100 text-slate-400';
  if (pct <= 50) return 'bg-green-100 text-green-700';
  if (pct <= 80) return 'bg-blue-100 text-blue-700';
  if (pct <= 100) return 'bg-amber-100 text-amber-700';
  return 'bg-red-200 text-red-700';
}

function getBarWidth(pct: number): string {
  return `${Math.min(100, pct)}%`;
}

export function WorkloadDashboardPage() {
  const [weekOffset, setWeekOffset] = useState(0);
  const [viewMode, setViewMode] = useState<'utilization' | 'hours'>('utilization');

  const weekStart = useMemo(() => {
    const today = new Date();
    const start = startOfWeek(today, { weekStartsOn: 1 });
    return addDays(start, weekOffset * 7);
  }, [weekOffset]);

  const from = format(weekStart, 'yyyy-MM-dd');
  const to = format(addDays(weekStart, 4), 'yyyy-MM-dd'); // Mon-Fri

  // Fetch all users with active task assignments
  const { data: usersData = [] } = useQuery({
    queryKey: ['users-active'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/users?isActive=true').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
  });

  // Fetch workload per user (we'll batch-fetch for each user)
  const { data: workloads, isLoading } = useQuery({
    queryKey: ['workload', 'all-users', from, to],
    staleTime: 2 * 60 * 1000,
    queryFn: async () => {
      const results: any[] = [];
      for (const user of usersData.slice(0, 30)) {
        try {
          const r = await client.get(`/workload/user/${user.id}`, { params: { from, to } });
          const d = r.data?.data ?? r.data;
          results.push({ user, workload: d });
        } catch { /* skip */ }
      }
      return results;
    },
    enabled: usersData.length > 0,
  });

  const days = Array.from({ length: 5 }, (_, i) => addDays(weekStart, i));

  if (isLoading && !workloads) return <PageSkeleton />;

  const members = workloads ?? [];

  // Summary stats
  const avgUtil = members.length > 0
    ? Math.round(members.reduce((s, m) => s + (m.workload?.summary?.avgUtilization ?? 0), 0) / members.length)
    : 0;
  const overloaded = members.filter((m) => (m.workload?.summary?.avgUtilization ?? 0) > 100).length;
  const underutil = members.filter((m) => (m.workload?.summary?.avgUtilization ?? 0) < 50 && (m.workload?.summary?.avgUtilization ?? 0) > 0).length;

  return (
    <div className="space-y-6">
      <PageHeader title="Team Workload" description="Cross-project resource utilization and capacity planning" />

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-[14px] border border-slate-200 bg-white p-4 text-center">
          <p className="text-2xl font-bold text-slate-900">{members.length}</p>
          <p className="text-[11px] text-slate-500">Team Members</p>
        </div>
        <div className="rounded-[14px] border border-slate-200 bg-white p-4 text-center">
          <p className={cn('text-2xl font-bold', avgUtil > 100 ? 'text-red-600' : avgUtil > 80 ? 'text-amber-600' : 'text-blue-600')}>{avgUtil}%</p>
          <p className="text-[11px] text-slate-500">Avg Utilization</p>
        </div>
        <div className="rounded-[14px] border border-slate-200 bg-white p-4 text-center">
          <p className={cn('text-2xl font-bold', overloaded > 0 ? 'text-red-600' : 'text-slate-400')}>{overloaded}</p>
          <p className="text-[11px] text-slate-500">Overloaded (&gt;100%)</p>
        </div>
        <div className="rounded-[14px] border border-slate-200 bg-white p-4 text-center">
          <p className={cn('text-2xl font-bold', underutil > 0 ? 'text-amber-600' : 'text-slate-400')}>{underutil}</p>
          <p className="text-[11px] text-slate-500">Under-utilized (&lt;50%)</p>
        </div>
      </div>

      {/* Week navigation */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={() => setWeekOffset((o) => o - 1)} className="rounded-md p-1.5 hover:bg-slate-100"><ChevronLeft className="h-5 w-5" /></button>
          <span className="text-sm font-semibold text-slate-700">{format(weekStart, 'MMM d')} — {format(addDays(weekStart, 4), 'MMM d, yyyy')}</span>
          <button onClick={() => setWeekOffset((o) => o + 1)} className="rounded-md p-1.5 hover:bg-slate-100"><ChevronRight className="h-5 w-5" /></button>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
          <button onClick={() => setViewMode('utilization')} className={cn('px-3 py-1 rounded-md text-[12px] font-semibold', viewMode === 'utilization' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500')}>Utilization %</button>
          <button onClick={() => setViewMode('hours')} className={cn('px-3 py-1 rounded-md text-[12px] font-semibold', viewMode === 'hours' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500')}>Hours</button>
        </div>
      </div>

      {/* Utilization Table */}
      <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
              <th className="px-4 py-3 text-left font-semibold w-48">User</th>
              {days.map((d) => (
                <th key={format(d, 'yyyy-MM-dd')} className="px-2 py-3 text-center font-semibold">
                  {format(d, 'EEE')}<br />{format(d, 'dd/MM')}
                </th>
              ))}
              <th className="px-3 py-3 text-center font-semibold">Planned</th>
              <th className="px-3 py-3 text-center font-semibold">Capacity</th>
              <th className="px-3 py-3 text-center font-semibold">Logged</th>
              <th className="px-3 py-3 text-center font-semibold w-28">Avg Util.</th>
            </tr>
          </thead>
          <tbody>
            {members.length === 0 ? (
              <tr><td colSpan={10} className="py-8 text-center text-slate-400">No workload data</td></tr>
            ) : (
              members.map((m: any) => {
                const user = m.user;
                const wl = m.workload;
                const daily = wl?.dailyData ?? [];
                const summary = wl?.summary ?? {};

                return (
                  <tr key={user?.id} className="border-t border-slate-100 hover:bg-slate-50/50">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-600 text-[10px] font-semibold flex items-center justify-center shrink-0">
                          {(user?.firstName?.[0] ?? '') + (user?.lastName?.[0] ?? '')}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-slate-700 truncate">{user?.firstName} {user?.lastName}</p>
                          {user?.position && <p className="text-[10px] text-slate-400 truncate">{user.position}</p>}
                        </div>
                      </div>
                    </td>
                    {days.map((d) => {
                      const dateStr = format(d, 'yyyy-MM-dd');
                      const dayData = daily.find((dd: any) => dd.date === dateStr);
                      const util = dayData?.utilizationPct ?? 0;
                      const planned = dayData?.plannedHours ?? 0;
                      const capacity = dayData?.capacityHours ?? 0;

                      return (
                        <td key={dateStr} className="px-2 py-2.5 text-center">
                          {capacity === 0 ? (
                            <span className="text-[10px] text-slate-300">Off</span>
                          ) : viewMode === 'utilization' ? (
                            <div className="space-y-1">
                              <div className={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold', getUtilColor(util))}>
                                {util}%
                              </div>
                              <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                <div className={cn('h-full rounded-full', util > 100 ? 'bg-red-500' : util > 80 ? 'bg-amber-500' : 'bg-blue-500')} style={{ width: getBarWidth(util) }} />
                              </div>
                            </div>
                          ) : (
                            <div className="text-[11px]">
                              <span className="font-medium text-slate-700">{planned.toFixed(1)}h</span>
                              <span className="text-slate-400">/{capacity.toFixed(0)}h</span>
                            </div>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2.5 text-center font-medium text-slate-700">{(summary.totalPlanned ?? 0).toFixed(1)}h</td>
                    <td className="px-3 py-2.5 text-center text-slate-500">{(summary.totalCapacity ?? 0).toFixed(0)}h</td>
                    <td className="px-3 py-2.5 text-center text-slate-500">{(summary.totalActual ?? 0).toFixed(1)}h</td>
                    <td className="px-3 py-2.5 text-center">
                      <div className="flex items-center gap-2 justify-center">
                        <div className="w-16 h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div className={cn('h-full rounded-full', (summary.avgUtilization ?? 0) > 100 ? 'bg-red-500' : (summary.avgUtilization ?? 0) > 80 ? 'bg-amber-500' : 'bg-blue-500')}
                            style={{ width: getBarWidth(summary.avgUtilization ?? 0) }} />
                        </div>
                        <span className={cn('text-[11px] font-bold', (summary.avgUtilization ?? 0) > 100 ? 'text-red-600' : 'text-slate-700')}>
                          {summary.avgUtilization ?? 0}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
