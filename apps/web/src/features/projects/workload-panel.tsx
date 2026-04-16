import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { format, addDays, startOfWeek } from '@/lib/date-utils';

export function WorkloadPanel({ projectId }: { projectId: number }) {
  const [weekOffset, setWeekOffset] = useState(0);

  const weekStart = useMemo(() => {
    const today = new Date();
    const start = startOfWeek(today, { weekStartsOn: 1 });
    return addDays(start, weekOffset * 7);
  }, [weekOffset]);

  const from = format(weekStart, 'yyyy-MM-dd');
  const to = format(addDays(weekStart, 6), 'yyyy-MM-dd');

  const { data, isLoading } = useQuery({
    queryKey: ['workload', 'project', projectId, from, to],
    queryFn: () => client.get(`/projects/${projectId}/workload`, { params: { from, to } }).then((r) => r.data?.data ?? r.data),
    staleTime: 60 * 1000,
  });

  const members = (data as any)?.members ?? [];
  const days = Array.from({ length: 5 }, (_, i) => addDays(weekStart, i)); // Mon-Fri

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-blue-600" />
          <h3 className="text-sm font-semibold text-slate-700">Team Workload</h3>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setWeekOffset((o) => o - 1)} className="rounded-md p-1 hover:bg-slate-100"><ChevronLeft className="h-4 w-4" /></button>
          <span className="text-[12px] text-slate-500">{format(weekStart, 'MMM d')} - {format(addDays(weekStart, 4), 'MMM d')}</span>
          <button onClick={() => setWeekOffset((o) => o + 1)} className="rounded-md p-1 hover:bg-slate-100"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      {isLoading ? (
        <div className="py-6 text-center text-sm text-slate-400">Loading workload...</div>
      ) : members.length === 0 ? (
        <div className="py-6 text-center text-sm text-slate-400">No team members</div>
      ) : (
        <div className="rounded-[14px] border border-slate-200 overflow-hidden">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2 text-left font-semibold w-32">Team Member</th>
                {days.map((d) => (
                  <th key={format(d, 'yyyy-MM-dd')} className="px-2 py-2 text-center font-semibold">
                    {format(d, 'EEE')}<br />{format(d, 'dd/MM')}
                  </th>
                ))}
                <th className="px-3 py-2 text-center font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m: any) => {
                const user = m.user;
                const workload = m.workload;
                const dailyData = workload?.dailyData ?? [];
                const summary = workload?.summary ?? {};

                return (
                  <tr key={user?.id} className="border-t border-slate-100 hover:bg-slate-50/50">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-600 text-[9px] font-semibold flex items-center justify-center">
                          {(user?.firstName?.[0] ?? '') + (user?.lastName?.[0] ?? '')}
                        </div>
                        <span className="font-medium text-slate-700 truncate">{user?.firstName} {user?.lastName}</span>
                      </div>
                    </td>
                    {days.map((d) => {
                      const dateStr = format(d, 'yyyy-MM-dd');
                      const dayData = dailyData.find((dd: any) => dd.date === dateStr);
                      const util = dayData?.utilizationPct ?? 0;
                      const planned = dayData?.plannedHours ?? 0;
                      const capacity = dayData?.capacityHours ?? 0;

                      return (
                        <td key={dateStr} className="px-2 py-2 text-center">
                          <div className={cn(
                            'rounded-md px-1 py-1 text-[11px] font-medium',
                            capacity === 0 ? 'bg-slate-100 text-slate-400' :
                            util > 100 ? 'bg-red-100 text-red-700' :
                            util > 80 ? 'bg-amber-100 text-amber-700' :
                            util > 50 ? 'bg-blue-100 text-blue-700' :
                            'bg-green-100 text-green-700',
                          )}>
                            {capacity === 0 ? 'Off' : `${planned.toFixed(1)}h`}
                          </div>
                          {capacity > 0 && (
                            <div className="mt-0.5 text-[9px] text-slate-400">{util}%</div>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-center">
                      <span className={cn('font-semibold', summary.avgUtilization > 100 ? 'text-red-600' : 'text-slate-700')}>
                        {summary.totalPlanned?.toFixed(1) ?? 0}h
                      </span>
                      <div className="text-[9px] text-slate-400">{summary.avgUtilization ?? 0}% avg</div>
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
