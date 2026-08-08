import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { OpsAvatar, OpsErrorBanner, opsErrorMessage } from './ops-shared';

/**
 * Active Projects tab (feat/ops-complete).
 *
 * BM Activity model: a project is ACTIVE if it has an open task due
 * within the next 30 days OR any timeEntry / ActivityLog in the last
 * 14 days. Everything else is DORMANT (still shown — operators want
 * to see the coverage gap). All aggregations live server-side to
 * keep this list one round-trip regardless of project count.
 *
 * Per project: last activity date, upcoming-due count, logged hours
 * (last 14d), a clear ACTIVE / DORMANT flag, and a deep-link to the
 * project detail page.
 */

type ActiveProject = {
  id: number; name: string; number: string | null;
  status: string; endDate: string | null;
  leader: { id: number; firstName: string | null; lastName: string | null; avatarUrl: string | null } | null;
  department: { id: number; name: string } | null;
  lastActivityDate: string | null;
  upcomingDueCount: number;
  loggedHours14d: number;
  flag: 'active' | 'dormant';
};

type ActiveProjectsResponse = {
  projects: ActiveProject[];
  totalCount: number;
  activeCount: number;
  dormantCount: number;
  scope: { myDeptOnly: boolean; deptName: string | null };
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return '—';
  }
}

function daysSince(iso: string | null, now: Date): string {
  if (!iso) return 'no activity';
  const d = new Date(iso);
  const diff = Math.max(0, Math.round((now.getTime() - d.getTime()) / 86400000));
  return diff === 0 ? 'today' : diff === 1 ? '1d ago' : `${diff}d ago`;
}

export function ActiveProjectsTab({
  myDeptOnly,
  onOpenProject,
}: {
  myDeptOnly: boolean;
  onOpenProject: (projectId: number) => void;
}) {
  const [search, setSearch] = useState('');
  const [flagFilter, setFlagFilter] = useState<'all' | 'active' | 'dormant'>('all');
  const now = useMemo(() => new Date(), []);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<ActiveProjectsResponse>({
    queryKey: ['dashboard', 'operations', 'active-projects', { myDeptOnly }],
    queryFn: () => client
      .get('/dashboard/operations/active-projects', { params: myDeptOnly ? { myDeptOnly: true } : {} })
      .then((r) => r.data?.data ?? r.data),
    staleTime: 60 * 1000,
    retry: 1,
  });

  if (isLoading) return <PageSkeleton />;
  if (isError) {
    return (
      <OpsErrorBanner
        title="Could not load active projects"
        message={opsErrorMessage(error)}
        onRetry={() => refetch()}
      />
    );
  }

  const projects = data?.projects ?? [];
  const filtered = projects.filter((p) => {
    if (flagFilter !== 'all' && p.flag !== flagFilter) return false;
    if (search) {
      const q = search.trim().toLowerCase();
      const hay = `${p.name} ${p.number ?? ''} ${p.department?.name ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-3">
      {/* Filter strip */}
      <div className="flex items-center gap-2 rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2">
        <Search className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by project name, number or department…"
          className="flex-1 text-[12px] outline-none bg-transparent placeholder:text-slate-400"
          aria-label="Filter active projects"
        />
        <div className="flex items-center gap-1 border-l border-slate-200 dark:border-slate-700 pl-3">
          {(['all', 'active', 'dormant'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFlagFilter(f)}
              className={cn(
                'text-[11px] font-semibold px-2 py-1 rounded-[5px] transition-colors focus-visible:outline-none focus-visible:border-blue-500',
                flagFilter === f
                  ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800',
              )}
            >
              {f === 'all' ? `All (${data?.totalCount ?? 0})` : f === 'active' ? `Active (${data?.activeCount ?? 0})` : `Dormant (${data?.dormantCount ?? 0})`}
            </button>
          ))}
        </div>
      </div>

      {isFetching && (
        <p className="text-[11px] text-slate-400 dark:text-slate-500 -mt-1">Refreshing…</p>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
          <EmptyState
            icon={Activity}
            title="No projects match"
            description={search ? `No projects matching "${search}".` : 'No projects to show for the current filter.'}
          />
        </div>
      ) : (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] min-w-[720px]">
              <thead className="bg-[#FAFBFC] dark:bg-slate-800/60 border-b border-slate-100 dark:border-slate-800">
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="px-4 py-2 w-[90px]">Flag</th>
                  <th className="px-4 py-2">Project</th>
                  <th className="px-4 py-2 w-[140px]">Department</th>
                  <th className="px-4 py-2 w-[140px]">Leader</th>
                  <th className="px-4 py-2 w-[110px] text-right">Upcoming due</th>
                  <th className="px-4 py-2 w-[110px] text-right">14d hours</th>
                  <th className="px-4 py-2 w-[150px]">Last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filtered.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60 group">
                    <td className="px-4 py-2">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-[10px] font-bold tracking-wide',
                          p.flag === 'active'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800'
                            : 'bg-slate-100 text-slate-500 border border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
                        )}
                      >
                        <span className={cn('w-1.5 h-1.5 rounded-full', p.flag === 'active' ? 'bg-emerald-500' : 'bg-slate-400')} aria-hidden="true" />
                        {p.flag === 'active' ? 'ACTIVE' : 'DORMANT'}
                      </span>
                    </td>
                    <td className="px-4 py-2 min-w-0">
                      <button
                        type="button"
                        onClick={() => onOpenProject(p.id)}
                        className="text-left font-semibold text-slate-800 dark:text-slate-100 hover:text-blue-700 hover:underline truncate max-w-[260px] block focus-visible:outline-none focus-visible:border-blue-500"
                      >
                        {p.name}
                      </button>
                      <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono tabular-nums">{p.number ?? '—'}</span>
                    </td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300 truncate max-w-[140px]">
                      {p.department?.name ?? <span className="text-slate-300 dark:text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-2">
                      {p.leader ? (
                        <div className="flex items-center gap-1.5 min-w-0">
                          <OpsAvatar firstName={p.leader.firstName} lastName={p.leader.lastName} size={20} />
                          <span className="text-[12px] text-slate-700 dark:text-slate-200 truncate">{p.leader.firstName} {p.leader.lastName?.[0]}.</span>
                        </div>
                      ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                    </td>
                    <td className={cn('px-4 py-2 text-right font-mono tabular-nums font-semibold', p.upcomingDueCount > 0 ? 'text-slate-800 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500')}>
                      {p.upcomingDueCount}
                    </td>
                    <td className={cn('px-4 py-2 text-right font-mono tabular-nums font-semibold', p.loggedHours14d > 0 ? 'text-slate-800 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500')}>
                      {p.loggedHours14d}h
                    </td>
                    <td className="px-4 py-2 text-[11px] text-slate-500 dark:text-slate-400">
                      <span className="font-mono tabular-nums">{fmtDate(p.lastActivityDate)}</span>{' '}
                      <span className="text-slate-400 dark:text-slate-500">· {daysSince(p.lastActivityDate, now)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
