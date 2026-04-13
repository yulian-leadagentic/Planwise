import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle, Clock, FolderKanban, ListChecks, TrendingUp, XCircle, BarChart3 } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { cn } from '@/lib/utils';
import client from '@/api/client';

const feasibilityColors = {
  OK: { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'On Track' },
  AT_RISK: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'At Risk' },
  IMPOSSIBLE: { bg: 'bg-red-100', text: 'text-red-700', label: 'Impossible' },
  UNKNOWN: { bg: 'bg-slate-100', text: 'text-slate-500', label: 'Unknown' },
};

export function ManagerDashboard() {
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', 'manager'],
    queryFn: () => client.get('/dashboard/manager').then((r) => r.data?.data ?? r.data),
    staleTime: 60 * 1000,
  });

  if (isLoading) return <PageSkeleton />;

  const dashboard = data ?? { projects: [], kpis: {} };
  const kpis = dashboard.kpis ?? {};

  const kpiCards = [
    { label: 'Projects', value: kpis.totalProjects ?? 0, icon: FolderKanban, color: 'text-blue-600 bg-blue-100' },
    { label: 'Total Tasks', value: kpis.totalTasks ?? 0, icon: ListChecks, color: 'text-indigo-600 bg-indigo-100' },
    { label: 'Overdue', value: kpis.overdueTasks ?? 0, icon: Clock, color: kpis.overdueTasks > 0 ? 'text-red-600 bg-red-100' : 'text-slate-500 bg-slate-100' },
    { label: 'Blocked', value: kpis.blockedTasks ?? 0, icon: XCircle, color: kpis.blockedTasks > 0 ? 'text-amber-600 bg-amber-100' : 'text-slate-500 bg-slate-100' },
    { label: 'At Risk', value: kpis.atRiskProjects ?? 0, icon: AlertTriangle, color: kpis.atRiskProjects > 0 ? 'text-amber-600 bg-amber-100' : 'text-slate-500 bg-slate-100' },
    { label: 'Impossible', value: kpis.impossibleProjects ?? 0, icon: XCircle, color: kpis.impossibleProjects > 0 ? 'text-red-600 bg-red-100' : 'text-slate-500 bg-slate-100' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Manager Dashboard"
        description="Project health, workload, and execution feasibility"
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpiCards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="rounded-[14px] border border-slate-200 bg-white p-4">
              <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg mb-2', card.color)}>
                <Icon className="h-4.5 w-4.5" />
              </div>
              <p className="text-2xl font-bold text-slate-900">{card.value}</p>
              <p className="text-[11px] font-medium text-slate-400 mt-0.5">{card.label}</p>
            </div>
          );
        })}
      </div>

      {/* Project Health Cards */}
      <div className="space-y-3">
        <h3 className="text-[15px] font-bold text-slate-900">Project Health</h3>
        {(dashboard.projects ?? []).length === 0 ? (
          <div className="rounded-[14px] border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
            No projects found. Create a project to see health data.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {(dashboard.projects as any[]).map((p: any) => {
              const f = feasibilityColors[(p.feasibility as keyof typeof feasibilityColors)] ?? feasibilityColors.UNKNOWN;
              return (
                <div
                  key={p.project.id}
                  className="rounded-[14px] border border-slate-200 bg-white p-5 hover:border-blue-300 cursor-pointer transition-colors"
                  onClick={() => navigate(`/projects/${p.project.id}`)}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h4 className="text-sm font-semibold text-slate-900">{p.project.name}</h4>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        {p.counts?.tasks ?? 0} tasks · {p.counts?.members ?? 0} members
                      </p>
                    </div>
                    <span className={cn('rounded-[5px] px-2 py-0.5 text-[10px] font-bold', f.bg, f.text)}>
                      {f.label}
                    </span>
                  </div>

                  {/* Progress bar */}
                  <div className="mb-2">
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="text-slate-500">Progress</span>
                      <span className="font-semibold text-slate-700">{p.progress ?? 0}%</span>
                    </div>
                    <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          p.progress >= 80 ? 'bg-emerald-500' : p.progress >= 50 ? 'bg-blue-500' : p.progress >= 25 ? 'bg-amber-500' : 'bg-red-500',
                        )}
                        style={{ width: `${Math.min(100, p.progress ?? 0)}%` }}
                      />
                    </div>
                  </div>

                  {/* Status breakdown */}
                  <div className="flex items-center gap-2 text-[10px]">
                    {Object.entries(p.statusCounts ?? {}).map(([status, count]) => (
                      <span key={status} className="rounded-full bg-slate-100 px-1.5 py-0.5 text-slate-500">
                        {status.replace(/_/g, ' ')}: {count as number}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
