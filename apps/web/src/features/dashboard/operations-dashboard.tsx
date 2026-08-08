import { useState, useMemo, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Activity, AlertTriangle, BarChart3, ClipboardList, ExternalLink, MessageSquare, Search, ShieldCheck, Users } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { DiscussionDrawer } from '@/features/messaging/discussion-drawer';
import { TaskDrawer } from '@/features/tasks/task-drawer';
import { useDrawerRoute } from '@/components/nav/use-drawer-route';
import { useNavigateWithReturn } from '@/components/nav/return-route';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { WorkloadPanel } from './workload-dashboard';
import { OpsAvatar, OpsChevron, OpsLoadBar, OpsErrorBanner, opsErrorMessage, OPS_STATUS_CFG, OPS_PRI_COLORS } from './parts/ops-shared';
import { BimLeaderTab } from './parts/bim-leader-tab';
import { ActiveProjectsTab } from './parts/active-projects-tab';
import { ExecutiveReviewTab } from './parts/executive-review-tab';
import { EmployeesAtRiskPanel } from './parts/employees-at-risk-panel';
import { ServiceIntensityPanel } from './parts/service-intensity-panel';

/**
 * Operations Dashboard.
 *
 * Six tabs (feat/ops-complete, 2026-08):
 *   • Risk & Review — projects at risk + review queue + Employees at
 *     Risk panel (overloaded AND overdue) + service-intensity load.
 *   • Team by Department — capacity heat-map with per-dept and
 *     per-member project/deliverable/task counts.
 *   • BIM Leader — projects grouped by their BIM Leader with
 *     per-leader counts. Expandable to project rows.
 *   • Active Projects — activity-model flag (ACTIVE / DORMANT) with
 *     upcoming due count, 14-day hours, last activity date.
 *   • Workload — daily-per-user utilization (unchanged; ported from
 *     the standalone /dashboard/workload page).
 *   • Executive Review — capped task list with a Comment column
 *     persisted per task (TaskOpsNote), CSV export, group-by.
 *
 * "My department only" toggle scopes every tab server-side so the
 * numbers displayed always match the visible rows. Every task row
 * opens the Task drawer; every project row deep-links to
 * /projects/:id via navWithReturn so the ReturnPill lands back here.
 */

type OpsTab = 'risk' | 'team' | 'bim' | 'active' | 'workload' | 'executive';
const VALID_TABS: OpsTab[] = ['risk', 'team', 'bim', 'active', 'workload', 'executive'];

export function OperationsDashboardPage() {
  const navWithReturn = useNavigateWithReturn();

  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as OpsTab) ?? 'risk';
  const [tab, setTabState] = useState<OpsTab>(VALID_TABS.includes(initialTab) ? initialTab : 'risk');
  useEffect(() => {
    const fromUrl = (searchParams.get('tab') as OpsTab) ?? null;
    if (fromUrl && VALID_TABS.includes(fromUrl) && fromUrl !== tab) {
      setTabState(fromUrl);
    }
  }, [searchParams, tab]);
  const setTab = useCallback((next: OpsTab) => {
    setTabState(next);
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next === 'risk') p.delete('tab');
      else p.set('tab', next);
      return p;
    }, { replace: true });
  }, [setSearchParams]);

  const [expandedProjects, setExpandedProjects] = useState<Record<number, boolean>>({});
  const [expandedDepts, setExpandedDepts] = useState<Record<string, boolean>>({});
  const [expandedMembers, setExpandedMembers] = useState<Record<number, boolean>>({});
  const [chat, setChat] = useState<{ type: 'project' | 'task'; id: number; title: string } | null>(null);
  const { drawerId: drawerTaskId, openDrawer: setDrawerTaskId, closeDrawer } = useDrawerRoute('task');

  const [myDeptOnly, setMyDeptOnly] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');

  const openProject = useCallback(
    (projectId: number) => navWithReturn(`/projects/${projectId}`, 'Operations'),
    [navWithReturn],
  );
  const openTask = useCallback((taskId: number) => setDrawerTaskId(taskId), [setDrawerTaskId]);

  // ── Main dashboard query. Owns everything Risk & Team need. The
  // BIM / Active / Executive tabs each own their own query so a slow
  // BIM aggregate never blocks the Risk view. `retry: 1` gives the
  // user one automatic retry on flakes before the error banner appears.
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['dashboard', 'operations', { myDeptOnly }],
    queryFn: () => client
      .get('/dashboard/operations', { params: myDeptOnly ? { myDeptOnly: true } : {} })
      .then((r) => r.data?.data ?? r.data),
    staleTime: 60 * 1000,
    retry: 1,
  });

  const summary = data?.summary ?? { totalOverdue: 0, totalBlocked: 0, overloadedCount: 0, availableCount: 0, availableHours: 0, reviewCount: 0, employeesAtRiskCount: 0 };
  const projects: any[] = data?.projects ?? [];
  const departments: any[] = data?.departments ?? [];
  const reviewQueue: any[] = data?.reviewQueue ?? [];
  const employeesAtRisk: any[] = data?.employeesAtRisk ?? [];
  const services: any[] = data?.services ?? [];
  const scope = data?.scope ?? { myDeptOnly: false, deptName: null };

  const departmentsFiltered = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return departments;
    return departments
      .map((d) => ({
        ...d,
        members: (d.members ?? []).filter((m: any) => {
          const name = `${m.firstName ?? ''} ${m.lastName ?? ''}`.toLowerCase();
          const pos = (m.position ?? '').toLowerCase();
          return name.includes(q) || pos.includes(q);
        }),
      }))
      .filter((d) => (d.members ?? []).length > 0);
  }, [departments, memberSearch]);

  // Loading + error take precedence over the tab content so we never
  // silently render a half-populated page.
  const showMainLoading = isLoading && (tab === 'risk' || tab === 'team');
  const showMainError = isError && (tab === 'risk' || tab === 'team');

  if (showMainLoading) return <PageSkeleton />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Operations Dashboard"
        description="Risk & Review · Team · BIM Leader · Active Projects · Workload · Executive Review"
      />

      {/* Global error banner — main query only. Tab-specific queries
          render their own banner inside the tab body so a BIM failure
          doesn't hide the Risk data the user came here to see. */}
      {showMainError && (
        <OpsErrorBanner
          title="Could not load Operations data"
          message={opsErrorMessage(error)}
          onRetry={() => refetch()}
        />
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[
          { n: summary.totalOverdue, label: 'Overdue', sub: `Blocking ${summary.totalBlocked} tasks`, bg: 'bg-red-50', border: 'border-red-200', iconBg: 'bg-red-600', textDark: 'text-red-900', textLight: 'text-red-700' },
          { n: summary.totalBlocked, label: 'Blocked', sub: 'Waiting on dependencies', bg: 'bg-amber-50', border: 'border-amber-200', iconBg: 'bg-amber-600', textDark: 'text-amber-900', textLight: 'text-amber-700' },
          { n: summary.reviewCount ?? 0, label: 'In Review', sub: 'Awaiting your call', bg: 'bg-indigo-50', border: 'border-indigo-200', iconBg: 'bg-indigo-600', textDark: 'text-indigo-900', textLight: 'text-indigo-700' },
          { n: summary.overloadedCount, label: 'Overloaded', sub: `${summary.employeesAtRiskCount ?? 0} at risk`, bg: summary.overloadedCount > 0 ? 'bg-red-50' : 'bg-emerald-50', border: summary.overloadedCount > 0 ? 'border-red-200' : 'border-emerald-200', iconBg: summary.overloadedCount > 0 ? 'bg-red-600' : 'bg-emerald-600', textDark: summary.overloadedCount > 0 ? 'text-red-900' : 'text-emerald-900', textLight: summary.overloadedCount > 0 ? 'text-red-700' : 'text-emerald-700' },
          { n: summary.availableCount, label: 'Available', sub: `${summary.availableHours}h free capacity`, bg: 'bg-emerald-50', border: 'border-emerald-200', iconBg: 'bg-emerald-600', textDark: 'text-emerald-900', textLight: 'text-emerald-700' },
        ].map((s, i) => (
          <div key={i} className={cn('rounded-xl border p-3 flex items-center gap-3', s.bg, s.border)}>
            <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center text-white shrink-0', s.iconBg)}>
              <span className="text-base font-bold font-mono tabular-nums">{s.n}</span>
            </div>
            <div className="min-w-0">
              <p className={cn('text-[13px] font-bold', s.textDark)}>{s.label}</p>
              <p className={cn('text-[11px]', s.textLight)}>{s.sub}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Tab strip */}
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 overflow-x-auto">
        <button
          type="button"
          onClick={() => setTab('risk')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-[13px] font-semibold border-b-2 -mb-px transition-colors whitespace-nowrap',
            tab === 'risk' ? 'border-red-600 text-red-700' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100',
          )}
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          Risk &amp; Review
          <span className="ml-1 text-[10px] font-bold rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-2 py-0.5 font-mono tabular-nums">{projects.length + reviewQueue.length + (employeesAtRisk.length > 0 ? 1 : 0)}</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('team')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-[13px] font-semibold border-b-2 -mb-px transition-colors whitespace-nowrap',
            tab === 'team' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100',
          )}
        >
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          Team by Department
          <span className="ml-1 text-[10px] font-bold rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-2 py-0.5 font-mono tabular-nums">{departments.reduce((s: number, d: any) => s + (d.members?.length ?? 0), 0)}</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('bim')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-[13px] font-semibold border-b-2 -mb-px transition-colors whitespace-nowrap',
            tab === 'bim' ? 'border-violet-600 text-violet-700' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100',
          )}
        >
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          BIM Leader
        </button>
        <button
          type="button"
          onClick={() => setTab('active')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-[13px] font-semibold border-b-2 -mb-px transition-colors whitespace-nowrap',
            tab === 'active' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100',
          )}
        >
          <Activity className="h-3.5 w-3.5" aria-hidden="true" />
          Active Projects
        </button>
        <button
          type="button"
          onClick={() => setTab('workload')}
          title="Daily-per-user utilization heat-map — moved here from /dashboard/workload."
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-[13px] font-semibold border-b-2 -mb-px transition-colors whitespace-nowrap',
            tab === 'workload' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100',
          )}
        >
          <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
          Workload
        </button>
        <button
          type="button"
          onClick={() => setTab('executive')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-[13px] font-semibold border-b-2 -mb-px transition-colors whitespace-nowrap',
            tab === 'executive' ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100',
          )}
        >
          <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
          Executive Review
        </button>

        <label className="ml-auto flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300 cursor-pointer whitespace-nowrap">
          <input
            type="checkbox"
            checked={myDeptOnly}
            onChange={(e) => setMyDeptOnly(e.target.checked)}
            className="rounded border-slate-300 dark:border-slate-600 text-blue-600"
            aria-label="Limit view to my department"
          />
          <span className="font-medium">My department only</span>
          {scope.myDeptOnly && scope.deptName && (
            <span className="text-[11px] text-blue-600 font-semibold">({scope.deptName})</span>
          )}
        </label>
      </div>

      {/* ─── TAB: RISK & REVIEW ─── */}
      {tab === 'risk' && (
        <div className="space-y-5">
          {isFetching && !isLoading && (
            <p className="text-[11px] text-slate-400 dark:text-slate-500 -mt-2">Refreshing…</p>
          )}

          {/* Employees at Risk — new panel, sits on top so managers see
              people problems before project problems. */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="w-1 h-5 rounded-sm bg-red-500" />
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Employees at Risk</h2>
              <span className="text-[12px] font-medium text-slate-400 dark:text-slate-500">— overloaded AND overdue</span>
            </div>
            <EmployeesAtRiskPanel employees={employeesAtRisk} onOpenTask={openTask} onOpenProject={openProject} />
          </div>

          {/* Service intensity */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="w-1 h-5 rounded-sm bg-blue-500" />
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Service Intensity</h2>
              <span className="text-[12px] font-medium text-slate-400 dark:text-slate-500">— load by service type</span>
            </div>
            <ServiceIntensityPanel services={services} />
          </div>

          {/* Review queue */}
          {reviewQueue.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="w-1 h-5 rounded-sm bg-indigo-600" />
                <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Review Queue</h2>
                <span className="text-[12px] font-medium text-slate-400 dark:text-slate-500">— {reviewQueue.length} awaiting decision</span>
              </div>
              <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
                <table className="w-full text-[12px]">
                  <thead className="bg-[#FAFBFC] border-b border-slate-100 dark:border-slate-800">
                    <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      <th className="px-4 py-2 w-[110px]">Code</th>
                      <th className="px-4 py-2">Task</th>
                      <th className="px-4 py-2">Project</th>
                      <th className="px-4 py-2">Submitter</th>
                      <th className="px-4 py-2 w-[90px] text-right">Returns</th>
                      <th className="px-4 py-2 w-[130px]">Submitted</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {reviewQueue.map((r: any) => (
                      <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60 group">
                        <td className="px-4 py-2 text-slate-500 dark:text-slate-400 font-mono tabular-nums">{r.code ?? '—'}</td>
                        <td className="px-4 py-2 min-w-0">
                          <button
                            onClick={() => openTask(r.id)}
                            className="text-left font-semibold text-slate-800 dark:text-slate-100 hover:text-indigo-700 hover:underline truncate max-w-[280px] block focus-visible:outline-none focus-visible:border-blue-500"
                          >
                            {r.name}
                          </button>
                          <span className="text-[10px] text-slate-400 dark:text-slate-500">{r.zone}</span>
                        </td>
                        <td className="px-4 py-2">
                          <button
                            onClick={() => openProject(r.projectId)}
                            className="text-[12px] text-slate-700 dark:text-slate-200 hover:text-indigo-700 hover:underline truncate max-w-[180px] focus-visible:outline-none focus-visible:border-blue-500"
                          >
                            {r.projectName}
                          </button>
                        </td>
                        <td className="px-4 py-2">
                          {r.submitter ? (
                            <div className="flex items-center gap-2 min-w-0">
                              <OpsAvatar firstName={r.submitter.firstName} lastName={r.submitter.lastName} size={22} />
                              <span className="text-[12px] text-slate-700 dark:text-slate-200 truncate">{r.submitter.firstName} {r.submitter.lastName?.[0]}.</span>
                            </div>
                          ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {r.returnCount > 0 ? (
                            <span className="inline-flex items-center rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-[10px] font-bold font-mono tabular-nums">
                              ×{r.returnCount}
                            </span>
                          ) : <span className="text-slate-300 dark:text-slate-600 font-mono tabular-nums">0</span>}
                        </td>
                        <td className="px-4 py-2 text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                          {r.submittedAt ? new Date(r.submittedAt).toISOString().slice(0, 10) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Projects at Risk */}
          {projects.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="w-1 h-5 rounded-sm bg-red-600" />
                <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Projects at Risk</h2>
                <span className="text-[12px] font-medium text-slate-400 dark:text-slate-500">— sorted by severity</span>
              </div>

              <div className="space-y-2">
                {projects.map((project: any) => {
                  const cfg = OPS_STATUS_CFG[project.status] ?? OPS_STATUS_CFG.ok;
                  const isExp = !!expandedProjects[project.id];
                  const overdueTasks: any[] = project.overdueTasks ?? [];

                  return (
                    <div key={project.id} className={cn('rounded-[14px] border bg-white dark:bg-slate-900 overflow-hidden transition-colors', isExp ? cfg.border : 'border-slate-200 dark:border-slate-700')}>
                      <div
                        onClick={() => setExpandedProjects((prev) => ({ ...prev, [project.id]: !prev[project.id] }))}
                        className={cn('flex items-center gap-2.5 px-4 py-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/80 transition-colors border-l-[4px]',
                          project.status === 'critical' ? 'border-l-red-600' : project.status === 'high' ? 'border-l-amber-500' : 'border-l-blue-500')}>
                        <OpsChevron open={isExp} />
                        <span className={cn('rounded-[5px] px-2 py-0.5 text-[11px] font-bold shrink-0 border', cfg.bg, cfg.text, cfg.border)}>{cfg.label}</span>
                        <div className="flex-1 min-w-0 flex items-center gap-2">
                          <span className="text-sm font-bold text-slate-900 dark:text-slate-100">{project.name}</span>
                          <span className="font-mono tabular-nums text-[11px] text-slate-400 dark:text-slate-500">{project.number}</span>
                          <button onClick={(e) => { e.stopPropagation(); openProject(project.id); }}
                            aria-label={`Open project ${project.name}`}
                            className="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-blue-600 hover:bg-blue-50 transition-colors focus-visible:outline-none focus-visible:border-blue-500">
                            <ExternalLink className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); setChat({ type: 'project', id: project.id, title: project.name }); }}
                            aria-label={`Open project discussion for ${project.name}`}
                            className="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-blue-600 hover:bg-blue-50 transition-colors focus-visible:outline-none focus-visible:border-blue-500">
                            <MessageSquare className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="flex items-center gap-2.5 shrink-0 text-[11px]">
                          {overdueTasks.length > 0 && <span className="font-semibold text-red-600 font-mono tabular-nums">{overdueTasks.length} overdue</span>}
                          <span className="w-px h-4 bg-slate-200 dark:bg-slate-700" />
                          <span className={cn('font-mono tabular-nums font-semibold', project.budgetPct > 85 ? 'text-red-600' : 'text-slate-500 dark:text-slate-400')}>budget {project.budgetPct}%</span>
                          <span className={cn('font-mono tabular-nums font-semibold', project.daysLeft < 0 ? 'text-red-600' : project.daysLeft < 30 ? 'text-amber-600' : 'text-slate-500 dark:text-slate-400')}>
                            {project.daysLeft < 0 ? `${Math.abs(project.daysLeft)}d overdue` : project.daysLeft != null ? `${project.daysLeft}d left` : '—'}
                          </span>
                          {project.leader && <OpsAvatar firstName={project.leader.firstName} lastName={project.leader.lastName} size={22} />}
                        </div>
                      </div>

                      {isExp && (
                        <div>
                          {project.riskFactors?.length > 0 && (
                            <div className={cn('px-4 py-2 border-t border-b flex gap-4 flex-wrap', cfg.bg, cfg.border)}>
                              {project.riskFactors.map((rf: any, i: number) => (
                                <span key={i} className={cn('text-[12px] flex items-center gap-1.5', cfg.text)}>
                                  <span className={cn('w-1.5 h-1.5 rounded-full', cfg.dot)} />{rf.text}
                                </span>
                              ))}
                            </div>
                          )}

                          {overdueTasks.length > 0 && (
                            <>
                              <div className="px-4 pt-2 pb-1 text-[12px] font-bold text-red-600 flex items-center gap-1.5">
                                <span className="w-[7px] h-[7px] rounded-full bg-red-600" />Overdue — immediate action needed
                              </div>
                              {overdueTasks.map((task: any) => (
                                <div key={task.id} className="flex items-center gap-2 px-4 py-2 border-b border-slate-50 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/50 group">
                                  <div className={cn('w-[3px] h-8 rounded-sm shrink-0', OPS_PRI_COLORS[task.priority] ?? 'bg-slate-400 dark:bg-slate-500')} />
                                  <div className="w-6 h-6 rounded-md bg-red-50 flex items-center justify-center text-[11px] font-bold text-red-600 shrink-0">!</div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5">
                                      <span className="font-mono tabular-nums text-[11px] text-slate-500 dark:text-slate-400">{task.code}</span>
                                      <button onClick={() => openTask(task.id)}
                                        className="text-[13px] font-semibold text-slate-900 dark:text-slate-100 hover:text-blue-600 hover:underline transition-colors focus-visible:outline-none focus-visible:border-blue-500">
                                        {task.name}
                                      </button>
                                      {task.blockedTasks > 0 && (
                                        <span className="text-[10px] font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded border border-red-200 font-mono tabular-nums">blocks {task.blockedTasks}</span>
                                      )}
                                    </div>
                                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{task.zone} · <span className="font-mono tabular-nums">{task.hoursLeft}h</span> left</p>
                                  </div>
                                  {task.assignee && (
                                    <div className="flex items-center gap-1 shrink-0">
                                      <OpsAvatar firstName={task.assignee.firstName} lastName={task.assignee.lastName} size={20} />
                                      <span className="text-[11px] text-slate-500 dark:text-slate-400">{task.assignee.firstName} {task.assignee.lastName?.[0]}.</span>
                                    </div>
                                  )}
                                  <span className="text-sm font-bold font-mono tabular-nums text-red-600 min-w-[36px] text-center shrink-0">{task.daysOverdue}d</span>
                                  <button onClick={(e) => { e.stopPropagation(); openTask(task.id); }}
                                    aria-label={`Open task ${task.code}`}
                                    className="w-7 h-7 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-blue-600 hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100 focus-visible:outline-none focus-visible:border-blue-500">
                                    <ExternalLink className="h-3.5 w-3.5" />
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); setChat({ type: 'task', id: task.id, title: `${task.code} ${task.name}` }); }}
                                    aria-label={`Open task discussion for ${task.code}`}
                                    className="w-7 h-7 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-blue-600 hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100 focus-visible:outline-none focus-visible:border-blue-500">
                                    <MessageSquare className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              ))}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* All-clear: projects + reviews + at-risk empty. Services /
              employees at risk already render their own empty state
              above, so this is only reached when the OPS SCREEN as a
              whole is quiet — a real "you're good, nothing to do" moment. */}
          {projects.length === 0 && reviewQueue.length === 0 && employeesAtRisk.length === 0 && (
            <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
              <EmptyState
                icon={ShieldCheck}
                title="All clear"
                description="No projects at risk, no items awaiting review, no overloaded staff."
              />
            </div>
          )}
        </div>
      )}

      {/* ─── TAB: TEAM BY DEPARTMENT ─── */}
      {tab === 'team' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2">
            <Search className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
            <input
              type="text"
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder="Filter by name or position…"
              className="flex-1 text-[12px] outline-none bg-transparent placeholder:text-slate-400"
              aria-label="Filter team members"
            />
            {memberSearch && (
              <button
                type="button"
                onClick={() => setMemberSearch('')}
                aria-label="Clear filter"
                className="text-[11px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200"
              >
                clear
              </button>
            )}
            <span className="text-[11px] text-slate-400 dark:text-slate-500 border-l border-slate-200 dark:border-slate-700 pl-3 font-mono tabular-nums">
              {departmentsFiltered.reduce((s: number, d: any) => s + (d.members?.length ?? 0), 0)} people
            </span>
          </div>

          {departmentsFiltered.length === 0 ? (
            <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
              <EmptyState
                icon={Users}
                title="No matches"
                description={memberSearch ? `No people matching "${memberSearch}".` : myDeptOnly ? 'Your department has no active employees.' : 'No team data available.'}
              />
            </div>
          ) : (
            <div className="space-y-2">
              {departmentsFiltered.map((dept: any) => {
                const isExp = !!expandedDepts[dept.name];
                const members: any[] = dept.members ?? [];

                return (
                  <div key={dept.name} className={cn('rounded-[14px] border bg-white dark:bg-slate-900 overflow-hidden transition-colors', isExp ? 'border-slate-300 dark:border-slate-600' : 'border-slate-200 dark:border-slate-700')}>
                    <button type="button"
                      onClick={() => setExpandedDepts((prev) => ({ ...prev, [dept.name]: !prev[dept.name] }))}
                      className={cn('w-full flex items-center gap-2.5 px-4 py-3 text-left transition-colors', isExp ? 'bg-slate-50 dark:bg-slate-800/80' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50')}>
                      <OpsChevron open={isExp} />
                      <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center text-[13px] font-bold font-mono tabular-nums shrink-0">
                        {members.length}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-slate-900 dark:text-slate-100">{dept.name}</p>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">
                          <span className="font-mono tabular-nums">{dept.projectCount ?? 0}</span> projects ·{' '}
                          <span className="font-mono tabular-nums">{dept.deliverableCount ?? 0}</span> deliverables ·{' '}
                          <span className="font-mono tabular-nums">{dept.openTaskCount ?? 0}</span> open tasks
                        </p>
                      </div>
                      <div className="flex items-center gap-2.5 shrink-0">
                        {dept.totalOverdue > 0 && <span className="text-[11px] font-semibold text-red-600 font-mono tabular-nums">{dept.totalOverdue} overdue</span>}
                        <div className="w-[80px]"><OpsLoadBar used={dept.totalHours} capacity={dept.totalCapacity} /></div>
                      </div>
                    </button>

                    {isExp && (
                      <div className="border-t border-slate-200 dark:border-slate-700">
                        {members.map((member: any) => {
                          const pct = member.capacity > 0 ? Math.round(member.hoursWeek / member.capacity * 100) : 0;
                          const isOver = pct > 100;
                          const isLow = pct < 60;
                          const isMExp = !!expandedMembers[member.id];
                          const memberTasks: any[] = member.taskList ?? [];
                          const hasTasks = memberTasks.length > 0;

                          return (
                            <div key={member.id} className="border-b border-slate-100 dark:border-slate-800 last:border-b-0">
                              <button type="button"
                                onClick={() => hasTasks && setExpandedMembers((prev) => ({ ...prev, [member.id]: !prev[member.id] }))}
                                className={cn('w-full flex items-center gap-2 px-4 py-2 pl-11 text-left transition-colors border-l-[3px]',
                                  hasTasks ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/80' : 'cursor-default',
                                  isOver ? 'border-l-red-500' : isLow ? 'border-l-emerald-500' : 'border-l-transparent')}>
                                {hasTasks ? <OpsChevron open={isMExp} size={12} /> : <span className="w-3" />}
                                <OpsAvatar firstName={member.firstName} lastName={member.lastName} size={28} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">{member.firstName} {member.lastName}</span>
                                    {isOver && <span className="text-[10px] font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded border border-red-200">OVERLOADED</span>}
                                    {isLow && <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">AVAILABLE</span>}
                                  </div>
                                  <span className="text-[11px] text-slate-400 dark:text-slate-500">
                                    {member.position}
                                    {' · '}
                                    <span className="font-mono tabular-nums">{member.projectCount ?? 0}</span> proj ·{' '}
                                    <span className="font-mono tabular-nums">{member.deliverableCount ?? 0}</span> deliv ·{' '}
                                    <span className="font-mono tabular-nums">{member.openTasks ?? member.tasks ?? 0}</span> open
                                  </span>
                                </div>
                                {member.overdueTasks > 0 && (
                                  <span className="w-5 h-5 rounded-[5px] bg-red-50 flex items-center justify-center text-[10px] font-bold text-red-600 font-mono tabular-nums shrink-0">{member.overdueTasks}</span>
                                )}
                                <span className={cn('text-[13px] font-bold font-mono tabular-nums shrink-0', isOver ? 'text-red-600' : isLow ? 'text-emerald-600' : 'text-slate-700 dark:text-slate-200')}>
                                  {member.hoursWeek}h<span className="text-[11px] text-slate-400 dark:text-slate-500 font-normal">/{member.capacity}h</span>
                                </span>
                                <div className="w-[70px] shrink-0"><OpsLoadBar used={member.hoursWeek} capacity={member.capacity} /></div>
                              </button>

                              {isMExp && hasTasks && (
                                <div className="bg-slate-50 dark:bg-slate-800/80">
                                  {memberTasks.map((task: any) => {
                                    const isOverdue = task.daysOverdue != null && task.daysOverdue > 0;
                                    return (
                                      <div key={task.id} className="flex items-center gap-2 py-1.5 px-4 pl-[76px] border-b border-slate-100 dark:border-slate-800 last:border-b-0 text-[12px] group hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors">
                                        <div className={cn('w-[3px] h-6 rounded-sm shrink-0', isOverdue ? 'bg-red-500' : 'bg-slate-200 dark:bg-slate-700')} />
                                        <span className="font-mono tabular-nums text-[10px] text-slate-400 dark:text-slate-500 min-w-[50px]">{task.code}</span>
                                        <button onClick={() => openTask(task.id)}
                                          className="flex-1 text-left font-medium text-slate-800 dark:text-slate-100 hover:text-blue-600 hover:underline truncate transition-colors focus-visible:outline-none focus-visible:border-blue-500">
                                          {task.name}
                                        </button>
                                        <button onClick={() => openProject(task.projectId)}
                                          className="text-[10px] text-slate-400 dark:text-slate-500 hover:text-blue-600 hover:underline truncate max-w-[120px] transition-colors focus-visible:outline-none focus-visible:border-blue-500">
                                          {task.projectName}
                                        </button>
                                        {isOverdue && (
                                          <span className="text-[10px] font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded border border-red-100 shrink-0 font-mono tabular-nums">{task.daysOverdue}d late</span>
                                        )}
                                        <button onClick={() => openTask(task.id)}
                                          aria-label={`Open task ${task.code}`}
                                          className="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-blue-600 hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100 focus-visible:outline-none focus-visible:border-blue-500 shrink-0">
                                          <ExternalLink className="h-3 w-3" />
                                        </button>
                                        <button onClick={() => setChat({ type: 'task', id: task.id, title: `${task.code} ${task.name}` })}
                                          aria-label={`Open task discussion for ${task.code}`}
                                          className="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-blue-600 hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100 focus-visible:outline-none focus-visible:border-blue-500 shrink-0">
                                          <MessageSquare className="h-3 w-3" />
                                        </button>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ─── TAB: BIM LEADER ─── */}
      {tab === 'bim' && (
        <BimLeaderTab myDeptOnly={myDeptOnly} onOpenProject={openProject} />
      )}

      {/* ─── TAB: ACTIVE PROJECTS ─── */}
      {tab === 'active' && (
        <ActiveProjectsTab myDeptOnly={myDeptOnly} onOpenProject={openProject} />
      )}

      {/* ─── TAB: WORKLOAD ─── */}
      {tab === 'workload' && <WorkloadPanel />}

      {/* ─── TAB: EXECUTIVE REVIEW ─── */}
      {tab === 'executive' && (
        <ExecutiveReviewTab myDeptOnly={myDeptOnly} onOpenTask={openTask} onOpenProject={openProject} />
      )}

      {chat && (
        <DiscussionDrawer
          open={!!chat}
          onClose={() => setChat(null)}
          entityType={chat.type}
          entityId={chat.id}
          title={chat.title}
        />
      )}

      {drawerTaskId && (
        <TaskDrawer taskId={drawerTaskId} onClose={closeDrawer} hideTimeTab />
      )}
    </div>
  );
}
