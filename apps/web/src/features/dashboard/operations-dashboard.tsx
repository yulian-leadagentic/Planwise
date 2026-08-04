import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronRight, Users, Zap, UserCheck, MessageSquare, ExternalLink, Search, Filter } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { DiscussionDrawer } from '@/features/messaging/discussion-drawer';
import { TaskDrawer } from '@/features/tasks/task-drawer';
import { useDrawerRoute } from '@/components/nav/use-drawer-route';
import { useNavigateWithReturn } from '@/components/nav/return-route';
import { cn } from '@/lib/utils';
import client from '@/api/client';

const STATUS_CFG: Record<string, { label: string; dot: string; bg: string; border: string; text: string }> = {
  critical: { label: 'Critical', dot: 'bg-red-600', bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700' },
  high:     { label: 'At Risk', dot: 'bg-amber-600', bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700' },
  medium:   { label: 'Monitor', dot: 'bg-blue-600', bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' },
  ok:       { label: 'OK', dot: 'bg-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700' },
};

const PRI_COLORS: Record<string, string> = { critical: 'bg-red-600', high: 'bg-amber-600', medium: 'bg-blue-600', low: 'bg-slate-400' };

function Avatar({ firstName, lastName, size = 24 }: { firstName?: string; lastName?: string; size?: number }) {
  const initials = `${(firstName ?? '')[0] ?? ''}${(lastName ?? '')[0] ?? ''}`.toUpperCase();
  return (
    <div className="rounded-full bg-blue-600 text-white flex items-center justify-center shrink-0 font-semibold"
      style={{ width: size, height: size, fontSize: size * 0.35 }}>
      {initials}
    </div>
  );
}

function LoadBar({ used, capacity }: { used: number; capacity: number }) {
  const pct = capacity > 0 ? Math.round(used / capacity * 100) : 0;
  const color = pct > 110 ? 'bg-red-600' : pct > 100 ? 'bg-red-500' : pct > 90 ? 'bg-amber-500' : pct > 60 ? 'bg-blue-500' : 'bg-emerald-500';
  const textColor = pct > 110 ? 'text-red-600' : pct > 100 ? 'text-red-500' : pct > 90 ? 'text-amber-500' : pct > 60 ? 'text-blue-500' : 'text-emerald-500';
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-[4px] bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden min-w-[40px]">
        <div className={cn('h-full rounded-full transition-all duration-300', color)} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className={cn('text-[11px] font-bold font-mono min-w-[30px] text-right', textColor)}>{pct}%</span>
    </div>
  );
}

function Chev({ open, size = 14 }: { open: boolean; size?: number }) {
  return <ChevronRight className={cn('text-slate-400 dark:text-slate-500 transition-transform duration-150 shrink-0', open && 'rotate-90')} style={{ width: size, height: size }} />;
}

/**
 * Operations Dashboard (client feedback 2026-08-02).
 *
 * Split into two tabs:
 *   - Risk & Review — projects at risk (existing) + review queue
 *     (tasks currently in in_review). Managers use this to triage.
 *   - Team by Department — capacity heat-map, grouped by department
 *     then by member; opt-in "my dept only" scoping + employee name
 *     filter.
 *
 * Grouping stays dept → member → tasks (unchanged); filter box narrows
 * the visible members without changing the group structure. "My
 * department only" flips a query flag so the SERVER excludes people
 * outside the caller's department.
 */
type OpsTab = 'risk' | 'team';

export function OperationsDashboardPage() {
  const navigate = useNavigate();
  const navWithReturn = useNavigateWithReturn();

  const [tab, setTab] = useState<OpsTab>('risk');
  const [expandedProjects, setExpandedProjects] = useState<Record<number, boolean>>({});
  const [expandedDepts, setExpandedDepts] = useState<Record<string, boolean>>({});
  const [expandedMembers, setExpandedMembers] = useState<Record<number, boolean>>({});
  const [chat, setChat] = useState<{ type: 'project' | 'task'; id: number; title: string } | null>(null);
  const { drawerId: drawerTaskId, openDrawer: setDrawerTaskId, closeDrawer } = useDrawerRoute('task');

  // "My department only" toggle — managers use it to hide people
  // outside their department. Filter is applied server-side so hours
  // and overdue counts reflect the scoped view accurately.
  const [myDeptOnly, setMyDeptOnly] = useState(false);
  // Employee-name search on the Team tab.
  const [memberSearch, setMemberSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', 'operations', { myDeptOnly }],
    queryFn: () => client
      .get('/dashboard/operations', { params: myDeptOnly ? { myDeptOnly: true } : {} })
      .then((r) => r.data?.data ?? r.data),
    staleTime: 60 * 1000,
  });

  // NB: derived values + hooks below must live BEFORE any early
  // return so the hook count stays constant across renders. Reading
  // from `data` (possibly undefined during initial fetch) is fine —
  // the ?? fallbacks keep everything safe until data arrives.
  const summary = data?.summary ?? { totalOverdue: 0, totalBlocked: 0, overloadedCount: 0, availableCount: 0, availableHours: 0, reviewCount: 0 };
  const projects: any[] = data?.projects ?? [];
  const departments: any[] = data?.departments ?? [];
  const reviewQueue: any[] = data?.reviewQueue ?? [];
  const scope = data?.scope ?? { myDeptOnly: false, deptName: null };

  // Team-tab member filter — narrows without changing structure.
  const departmentsFiltered = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return departments;
    return departments
      .map((d: any) => ({
        ...d,
        members: (d.members ?? []).filter((m: any) => {
          const name = `${m.firstName ?? ''} ${m.lastName ?? ''}`.toLowerCase();
          const pos = (m.position ?? '').toLowerCase();
          return name.includes(q) || pos.includes(q);
        }),
      }))
      .filter((d: any) => (d.members ?? []).length > 0);
  }, [departments, memberSearch]);

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="space-y-5">
      <PageHeader title="Operations Dashboard" description="Project risks · Review queue · Team workload" />

      {/* ═══ SUMMARY CARDS ═══ */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[
          { n: summary.totalOverdue, label: 'Overdue', sub: `Blocking ${summary.totalBlocked} tasks`, bg: 'bg-red-50', border: 'border-red-200', iconBg: 'bg-red-600', textDark: 'text-red-900', textLight: 'text-red-700' },
          { n: summary.totalBlocked, label: 'Blocked', sub: 'Waiting on dependencies', bg: 'bg-amber-50', border: 'border-amber-200', iconBg: 'bg-amber-600', textDark: 'text-amber-900', textLight: 'text-amber-700' },
          { n: summary.reviewCount ?? 0, label: 'In Review', sub: 'Awaiting your call', bg: 'bg-indigo-50', border: 'border-indigo-200', iconBg: 'bg-indigo-600', textDark: 'text-indigo-900', textLight: 'text-indigo-700' },
          { n: summary.overloadedCount, label: 'Overloaded', sub: 'Above capacity this week', bg: summary.overloadedCount > 0 ? 'bg-red-50' : 'bg-emerald-50', border: summary.overloadedCount > 0 ? 'border-red-200' : 'border-emerald-200', iconBg: summary.overloadedCount > 0 ? 'bg-red-600' : 'bg-emerald-600', textDark: summary.overloadedCount > 0 ? 'text-red-900' : 'text-emerald-900', textLight: summary.overloadedCount > 0 ? 'text-red-700' : 'text-emerald-700' },
          { n: summary.availableCount, label: 'Available', sub: `${summary.availableHours}h free capacity`, bg: 'bg-emerald-50', border: 'border-emerald-200', iconBg: 'bg-emerald-600', textDark: 'text-emerald-900', textLight: 'text-emerald-700' },
        ].map((s, i) => (
          <div key={i} className={cn('rounded-xl border p-3 flex items-center gap-3', s.bg, s.border)}>
            <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center text-white shrink-0', s.iconBg)}>
              <span className="text-base font-bold">{s.n}</span>
            </div>
            <div className="min-w-0">
              <p className={cn('text-[13px] font-bold', s.textDark)}>{s.label}</p>
              <p className={cn('text-[11px]', s.textLight)}>{s.sub}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ═══ TAB STRIP ═══ */}
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-700">
        <button
          type="button"
          onClick={() => setTab('risk')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-[13px] font-semibold border-b-2 -mb-px transition-colors',
            tab === 'risk' ? 'border-red-600 text-red-700' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100',
          )}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          Risk &amp; Review
          <span className="ml-1 text-[10px] font-bold rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-2 py-0.5">{projects.length + reviewQueue.length}</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('team')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-[13px] font-semibold border-b-2 -mb-px transition-colors',
            tab === 'team' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100',
          )}
        >
          <Users className="h-3.5 w-3.5" />
          Team by Department
          <span className="ml-1 text-[10px] font-bold rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-2 py-0.5">{departments.reduce((s: number, d: any) => s + (d.members?.length ?? 0), 0)}</span>
        </button>

        {/* Scope toggle — visible on both tabs, controls the query */}
        <label className="ml-auto flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={myDeptOnly}
            onChange={(e) => setMyDeptOnly(e.target.checked)}
            className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
          />
          <span className="font-medium">My department only</span>
          {scope.myDeptOnly && scope.deptName && (
            <span className="text-[11px] text-blue-600 font-semibold">({scope.deptName})</span>
          )}
        </label>
      </div>

      {/* ═══ TAB: RISK & REVIEW ═══ */}
      {tab === 'risk' && (
        <div className="space-y-5">
          {/* Review queue — sits on top since it needs the fastest turnaround. */}
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
                            onClick={() => setDrawerTaskId(r.id)}
                            className="text-left font-semibold text-slate-800 dark:text-slate-100 hover:text-indigo-700 hover:underline truncate max-w-[280px] block"
                          >
                            {r.name}
                          </button>
                          <span className="text-[10px] text-slate-400 dark:text-slate-500">{r.zone}</span>
                        </td>
                        <td className="px-4 py-2">
                          <button
                            onClick={() => navWithReturn(`/projects/${r.projectId}`, 'Operations')}
                            className="text-[12px] text-slate-700 dark:text-slate-200 hover:text-indigo-700 hover:underline truncate max-w-[180px]"
                          >
                            {r.projectName}
                          </button>
                        </td>
                        <td className="px-4 py-2">
                          {r.submitter ? (
                            <div className="flex items-center gap-2 min-w-0">
                              <Avatar firstName={r.submitter.firstName} lastName={r.submitter.lastName} size={22} />
                              <span className="text-[12px] text-slate-700 dark:text-slate-200 truncate">{r.submitter.firstName} {r.submitter.lastName?.[0]}.</span>
                            </div>
                          ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {r.returnCount > 0 ? (
                            <span className="inline-flex items-center rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-[10px] font-bold tabular-nums">
                              ×{r.returnCount}
                            </span>
                          ) : <span className="text-slate-300 dark:text-slate-600 tabular-nums">0</span>}
                        </td>
                        <td className="px-4 py-2 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                          {r.submittedAt ? new Date(r.submittedAt).toISOString().slice(0, 10) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Projects at Risk — existing block, kept as-is. */}
          {projects.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="w-1 h-5 rounded-sm bg-red-600" />
                <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Projects at Risk</h2>
                <span className="text-[12px] font-medium text-slate-400 dark:text-slate-500">— sorted by severity</span>
              </div>

              <div className="space-y-2">
                {projects.map((project: any) => {
                  const cfg = STATUS_CFG[project.status] ?? STATUS_CFG.ok;
                  const isExp = !!expandedProjects[project.id];
                  const overdueTasks: any[] = project.overdueTasks ?? [];

                  return (
                    <div key={project.id} className={cn('rounded-[14px] border bg-white dark:bg-slate-900 overflow-hidden transition-colors', isExp ? cfg.border : 'border-slate-200 dark:border-slate-700')}>
                      <div
                        onClick={() => setExpandedProjects((prev) => ({ ...prev, [project.id]: !prev[project.id] }))}
                        className={cn('flex items-center gap-2.5 px-4 py-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/80 transition-colors border-l-[4px]',
                          project.status === 'critical' ? 'border-l-red-600' : project.status === 'high' ? 'border-l-amber-500' : 'border-l-blue-500')}>
                        <Chev open={isExp} />
                        <span className={cn('rounded-[5px] px-2 py-0.5 text-[11px] font-bold shrink-0 border', cfg.bg, cfg.text, cfg.border)}>{cfg.label}</span>
                        <div className="flex-1 min-w-0 flex items-center gap-2">
                          <span className="text-sm font-bold text-slate-900 dark:text-slate-100">{project.name}</span>
                          <span className="font-mono text-[11px] text-slate-400 dark:text-slate-500">{project.number}</span>
                          <button onClick={(e) => { e.stopPropagation(); navWithReturn(`/projects/${project.id}`, 'Operations'); }}
                            className="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                            title="Open project">
                            <ExternalLink className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); setChat({ type: 'project', id: project.id, title: project.name }); }}
                            className="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                            title="Project discussion">
                            <MessageSquare className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="flex items-center gap-2.5 shrink-0 text-[11px]">
                          {overdueTasks.length > 0 && <span className="font-semibold text-red-600">{overdueTasks.length} overdue</span>}
                          <span className="w-px h-4 bg-slate-200 dark:bg-slate-700" />
                          <span className={cn('font-mono font-semibold', project.budgetPct > 85 ? 'text-red-600' : 'text-slate-500 dark:text-slate-400')}>budget {project.budgetPct}%</span>
                          <span className={cn('font-mono font-semibold', project.daysLeft < 0 ? 'text-red-600' : project.daysLeft < 30 ? 'text-amber-600' : 'text-slate-500 dark:text-slate-400')}>
                            {project.daysLeft < 0 ? `${Math.abs(project.daysLeft)}d overdue` : project.daysLeft != null ? `${project.daysLeft}d left` : '—'}
                          </span>
                          {project.leader && <Avatar firstName={project.leader.firstName} lastName={project.leader.lastName} size={22} />}
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
                                  <div className={cn('w-[3px] h-8 rounded-sm shrink-0', PRI_COLORS[task.priority] ?? 'bg-slate-400 dark:bg-slate-500')} />
                                  <div className="w-6 h-6 rounded-md bg-red-50 flex items-center justify-center text-[11px] font-bold text-red-600 shrink-0">!</div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5">
                                      <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">{task.code}</span>
                                      <button onClick={() => setDrawerTaskId(task.id)}
                                        className="text-[13px] font-semibold text-slate-900 dark:text-slate-100 hover:text-blue-600 hover:underline transition-colors">
                                        {task.name}
                                      </button>
                                      {task.blockedTasks > 0 && (
                                        <span className="text-[10px] font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded border border-red-200">blocks {task.blockedTasks}</span>
                                      )}
                                    </div>
                                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{task.zone} · {task.hoursLeft}h left</p>
                                  </div>
                                  {task.assignee && (
                                    <div className="flex items-center gap-1 shrink-0">
                                      <Avatar firstName={task.assignee.firstName} lastName={task.assignee.lastName} size={20} />
                                      <span className="text-[11px] text-slate-500 dark:text-slate-400">{task.assignee.firstName} {task.assignee.lastName?.[0]}.</span>
                                    </div>
                                  )}
                                  <span className="text-sm font-bold font-mono text-red-600 min-w-[36px] text-center shrink-0">{task.daysOverdue}d</span>
                                  <button onClick={(e) => { e.stopPropagation(); setDrawerTaskId(task.id); }}
                                    className="w-7 h-7 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-blue-600 hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100"
                                    title="Open task">
                                    <ExternalLink className="h-3.5 w-3.5" />
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); setChat({ type: 'task', id: task.id, title: `${task.code} ${task.name}` }); }}
                                    className="w-7 h-7 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-blue-600 hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100"
                                    title="Task discussion">
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

          {/* Both queues empty */}
          {projects.length === 0 && reviewQueue.length === 0 && (
            <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-16 text-center">
              <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">All clear</p>
              <p className="text-[13px] text-slate-400 dark:text-slate-500 mt-1">No projects at risk, no items awaiting review</p>
            </div>
          )}
        </div>
      )}

      {/* ═══ TAB: TEAM BY DEPARTMENT ═══ */}
      {tab === 'team' && (
        <div className="space-y-3">
          {/* Filter toolbar — employee name search. */}
          <div className="flex items-center gap-2 rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2">
            <Search className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
            <input
              type="text"
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder="Filter by name or position…"
              className="flex-1 text-[12px] outline-none placeholder:text-slate-400"
            />
            {memberSearch && (
              <button
                type="button"
                onClick={() => setMemberSearch('')}
                className="text-[11px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200"
              >
                clear
              </button>
            )}
            <span className="text-[11px] text-slate-400 dark:text-slate-500 border-l border-slate-200 dark:border-slate-700 pl-3">
              {departmentsFiltered.reduce((s: number, d: any) => s + (d.members?.length ?? 0), 0)} people
            </span>
          </div>

          {departmentsFiltered.length === 0 ? (
            <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-16 text-center">
              <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">No matches</p>
              <p className="text-[13px] text-slate-400 dark:text-slate-500 mt-1">
                {memberSearch ? `No people matching "${memberSearch}"` : myDeptOnly ? 'Your department has no active employees' : 'No team data available'}
              </p>
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
                      <Chev open={isExp} />
                      <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center text-[13px] font-bold shrink-0">
                        {members.length}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-slate-900 dark:text-slate-100">{dept.name}</p>
                      </div>
                      <div className="flex items-center gap-2.5 shrink-0">
                        {dept.totalOverdue > 0 && <span className="text-[11px] font-semibold text-red-600">{dept.totalOverdue} overdue</span>}
                        <div className="w-[80px]"><LoadBar used={dept.totalHours} capacity={dept.totalCapacity} /></div>
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
                                {hasTasks ? <Chev open={isMExp} size={12} /> : <span className="w-3" />}
                                <Avatar firstName={member.firstName} lastName={member.lastName} size={28} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">{member.firstName} {member.lastName}</span>
                                    {isOver && <span className="text-[10px] font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded border border-red-200">OVERLOADED</span>}
                                    {isLow && <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">AVAILABLE</span>}
                                  </div>
                                  <span className="text-[11px] text-slate-400 dark:text-slate-500">{member.position} · {member.tasks} tasks</span>
                                </div>
                                {member.overdueTasks > 0 && (
                                  <span className="w-5 h-5 rounded-[5px] bg-red-50 flex items-center justify-center text-[10px] font-bold text-red-600 shrink-0">{member.overdueTasks}</span>
                                )}
                                <span className={cn('text-[13px] font-bold font-mono shrink-0', isOver ? 'text-red-600' : isLow ? 'text-emerald-600' : 'text-slate-700 dark:text-slate-200')}>
                                  {member.hoursWeek}h<span className="text-[11px] text-slate-400 dark:text-slate-500 font-normal">/{member.capacity}h</span>
                                </span>
                                <div className="w-[70px] shrink-0"><LoadBar used={member.hoursWeek} capacity={member.capacity} /></div>
                              </button>

                              {isMExp && hasTasks && (
                                <div className="bg-slate-50 dark:bg-slate-800/80">
                                  {memberTasks.map((task: any) => {
                                    const isOverdue = task.daysOverdue != null && task.daysOverdue > 0;
                                    return (
                                      <div key={task.id} className="flex items-center gap-2 py-1.5 px-4 pl-[76px] border-b border-slate-100 dark:border-slate-800 last:border-b-0 text-[12px] group hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors">
                                        <div className={cn('w-[3px] h-6 rounded-sm shrink-0', isOverdue ? 'bg-red-500' : 'bg-slate-200 dark:bg-slate-700')} />
                                        <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500 min-w-[50px]">{task.code}</span>
                                        <button onClick={() => setDrawerTaskId(task.id)}
                                          className="flex-1 text-left font-medium text-slate-800 dark:text-slate-100 hover:text-blue-600 hover:underline truncate transition-colors">
                                          {task.name}
                                        </button>
                                        <button onClick={() => navWithReturn(`/projects/${task.projectId}`, 'Operations')}
                                          className="text-[10px] text-slate-400 dark:text-slate-500 hover:text-blue-600 hover:underline truncate max-w-[120px] transition-colors">
                                          {task.projectName}
                                        </button>
                                        {isOverdue && (
                                          <span className="text-[10px] font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded border border-red-100 shrink-0">{task.daysOverdue}d late</span>
                                        )}
                                        <button onClick={() => setDrawerTaskId(task.id)}
                                          className="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-blue-600 hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100 shrink-0"
                                          title="Open task">
                                          <ExternalLink className="h-3 w-3" />
                                        </button>
                                        <button onClick={() => setChat({ type: 'task', id: task.id, title: `${task.code} ${task.name}` })}
                                          className="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-blue-600 hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100 shrink-0"
                                          title="Task discussion">
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

      {/* Discussion Drawer */}
      {chat && (
        <DiscussionDrawer
          open={!!chat}
          onClose={() => setChat(null)}
          entityType={chat.type}
          entityId={chat.id}
          title={chat.title}
        />
      )}

      {/* Task Drawer — manager mode (Time tab hidden) */}
      {drawerTaskId && (
        <TaskDrawer taskId={drawerTaskId} onClose={closeDrawer} hideTimeTab />
      )}
    </div>
  );
}
