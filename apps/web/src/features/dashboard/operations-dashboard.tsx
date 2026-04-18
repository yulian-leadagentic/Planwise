import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronRight, Clock, Users, Zap, UserCheck } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
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
      <div className="flex-1 h-[4px] bg-slate-200 rounded-full overflow-hidden min-w-[40px]">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className={cn('text-[11px] font-bold font-mono min-w-[30px] text-right', textColor)}>{pct}%</span>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return <ChevronRight className={cn('h-3.5 w-3.5 text-slate-400 transition-transform duration-150', open && 'rotate-90')} />;
}

export function OperationsDashboardPage() {
  const navigate = useNavigate();
  const [expandedProjects, setExpandedProjects] = useState<Record<number, boolean>>({});
  const [expandedDepts, setExpandedDepts] = useState<Record<string, boolean>>({});
  const [expandedMembers, setExpandedMembers] = useState<Record<number, boolean>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', 'operations'],
    queryFn: () => client.get('/dashboard/operations').then((r) => r.data?.data ?? r.data),
    staleTime: 60 * 1000,
  });

  if (isLoading) return <PageSkeleton />;

  const summary = data?.summary ?? { totalOverdue: 0, totalBlocked: 0, overloadedCount: 0, availableCount: 0, availableHours: 0 };
  const projects: any[] = data?.projects ?? [];
  const departments: any[] = data?.departments ?? [];

  const toggleProject = (id: number) => setExpandedProjects((p) => ({ ...p, [id]: !p[id] }));
  const toggleDept = (name: string) => setExpandedDepts((p) => ({ ...p, [name]: !p[name] }));
  const toggleMember = (id: number) => setExpandedMembers((p) => ({ ...p, [id]: !p[id] }));

  return (
    <div className="space-y-5">
      <PageHeader title="Operations Dashboard" description="Project risks · Team workload · Task reassignment" />

      {/* ═══ SUMMARY CARDS ═══ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { n: summary.totalOverdue, label: 'Overdue', sub: `Blocking ${summary.totalBlocked} tasks`, bg: 'bg-red-50', border: 'border-red-200', iconBg: 'bg-red-600', textDark: 'text-red-900', textLight: 'text-red-700', Icon: AlertTriangle },
          { n: summary.totalBlocked, label: 'Blocked', sub: 'Waiting on dependencies', bg: 'bg-amber-50', border: 'border-amber-200', iconBg: 'bg-amber-600', textDark: 'text-amber-900', textLight: 'text-amber-700', Icon: Zap },
          { n: summary.overloadedCount, label: 'Overloaded', sub: 'Above capacity this week', bg: summary.overloadedCount > 0 ? 'bg-red-50' : 'bg-emerald-50', border: summary.overloadedCount > 0 ? 'border-red-200' : 'border-emerald-200', iconBg: summary.overloadedCount > 0 ? 'bg-red-600' : 'bg-emerald-600', textDark: summary.overloadedCount > 0 ? 'text-red-900' : 'text-emerald-900', textLight: summary.overloadedCount > 0 ? 'text-red-700' : 'text-emerald-700', Icon: Users },
          { n: summary.availableCount, label: 'Available', sub: `${summary.availableHours}h free capacity`, bg: 'bg-emerald-50', border: 'border-emerald-200', iconBg: 'bg-emerald-600', textDark: 'text-emerald-900', textLight: 'text-emerald-700', Icon: UserCheck },
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

      {/* ═══ SECTION 1: PROJECTS AT RISK ═══ */}
      {projects.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-1 h-5 rounded-sm bg-red-600" />
            <h2 className="text-base font-bold text-slate-900">Projects at Risk</h2>
            <span className="text-[12px] font-medium text-slate-400">— sorted by severity</span>
          </div>

          <div className="space-y-2">
            {projects.map((project: any) => {
              const cfg = STATUS_CFG[project.status] ?? STATUS_CFG.ok;
              const isExp = expandedProjects[project.id];
              const overdueTasks: any[] = project.overdueTasks ?? [];

              return (
                <div key={project.id} className={cn('rounded-[14px] border bg-white overflow-hidden transition-colors', isExp ? cfg.border : 'border-slate-200')}>
                  {/* Project header */}
                  <div onClick={() => toggleProject(project.id)}
                    className={cn('flex items-center gap-2.5 px-4 py-3 cursor-pointer hover:bg-slate-50/80 transition-colors border-l-[4px]',
                      project.status === 'critical' ? 'border-l-red-600' : project.status === 'high' ? 'border-l-amber-500' : 'border-l-blue-500')}>
                    <Chevron open={!!isExp} />
                    <span className={cn('rounded-[5px] px-2 py-0.5 text-[11px] font-bold shrink-0', cfg.bg, cfg.text, 'border', cfg.border)}>{cfg.label}</span>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-bold text-slate-900">{project.name}</span>
                      <span className="ml-2 font-mono text-[11px] text-slate-400">{project.number}</span>
                    </div>
                    <div className="flex items-center gap-2.5 shrink-0 text-[11px]">
                      {overdueTasks.length > 0 && <span className="font-semibold text-red-600">{overdueTasks.length} overdue</span>}
                      <span className="w-px h-4 bg-slate-200" />
                      <span className={cn('font-mono font-semibold', project.budgetPct > 85 ? 'text-red-600' : 'text-slate-500')}>budget {project.budgetPct}%</span>
                      <span className={cn('font-mono font-semibold', project.daysLeft < 0 ? 'text-red-600' : project.daysLeft < 30 ? 'text-amber-600' : 'text-slate-500')}>
                        {project.daysLeft < 0 ? `${Math.abs(project.daysLeft)}d overdue` : project.daysLeft != null ? `${project.daysLeft}d left` : '—'}
                      </span>
                      {project.leader && <Avatar firstName={project.leader.firstName} lastName={project.leader.lastName} size={22} />}
                    </div>
                  </div>

                  {/* Expanded content */}
                  {isExp && (
                    <div className="animate-fade-in">
                      {/* Risk factors */}
                      {project.riskFactors?.length > 0 && (
                        <div className={cn('px-4 py-2 border-t border-b flex gap-4 flex-wrap', cfg.bg, cfg.border)}>
                          {project.riskFactors.map((rf: any, i: number) => (
                            <span key={i} className={cn('text-[12px] flex items-center gap-1.5', cfg.text)}>
                              <span className={cn('w-1.5 h-1.5 rounded-full', cfg.dot)} />{rf.text}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Overdue tasks */}
                      {overdueTasks.length > 0 && (
                        <>
                          <div className="px-4 pt-2 pb-1 text-[12px] font-bold text-red-600 flex items-center gap-1.5">
                            <span className="w-[7px] h-[7px] rounded-full bg-red-600" />Overdue — immediate action needed
                          </div>
                          {overdueTasks.map((task: any) => (
                            <div key={task.id} className="flex items-center gap-2 px-4 py-2 border-b border-slate-50 hover:bg-slate-50/50">
                              <div className={cn('w-[3px] h-8 rounded-sm shrink-0', PRI_COLORS[task.priority] ?? 'bg-slate-400')} />
                              <div className="w-6 h-6 rounded-md bg-red-50 flex items-center justify-center text-[11px] font-bold text-red-600 shrink-0">!</div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-mono text-[11px] text-slate-500">{task.code}</span>
                                  <span className="text-[13px] font-semibold text-slate-900">{task.name}</span>
                                  {task.blockedTasks > 0 && (
                                    <span className="text-[10px] font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded border border-red-200">blocks {task.blockedTasks}</span>
                                  )}
                                </div>
                                <p className="text-[11px] text-slate-400 mt-0.5">{task.zone} · {task.hoursLeft}h left</p>
                              </div>
                              {task.assignee && (
                                <div className="flex items-center gap-1 shrink-0">
                                  <Avatar firstName={task.assignee.firstName} lastName={task.assignee.lastName} size={20} />
                                  <span className="text-[11px] text-slate-500">{task.assignee.firstName} {task.assignee.lastName?.[0]}.</span>
                                </div>
                              )}
                              <span className="text-sm font-bold font-mono text-red-600 min-w-[36px] text-center shrink-0">{task.daysOverdue}d</span>
                              <button onClick={(e) => { e.stopPropagation(); navigate(`/projects/${project.id}`); }}
                                className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-500 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-colors shrink-0">
                                View
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

      {/* ═══ SECTION 2: TEAM LOAD BY DEPARTMENT ═══ */}
      {departments.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-1 h-5 rounded-sm bg-blue-600" />
            <h2 className="text-base font-bold text-slate-900">Team Load by Department</h2>
          </div>

          <div className="space-y-2">
            {departments.map((dept: any) => {
              const isExp = expandedDepts[dept.name];
              return (
                <div key={dept.name} className={cn('rounded-[14px] border bg-white overflow-hidden', isExp ? 'border-slate-300' : 'border-slate-200')}>
                  {/* Dept header */}
                  <div onClick={() => toggleDept(dept.name)}
                    className={cn('flex items-center gap-2.5 px-4 py-3 cursor-pointer transition-colors', isExp ? 'bg-slate-50/80' : 'hover:bg-slate-50/50')}>
                    <Chevron open={!!isExp} />
                    <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center text-[13px] font-bold shrink-0">
                      {dept.members?.length ?? 0}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-bold text-slate-900">{dept.name}</p>
                    </div>
                    <div className="flex items-center gap-2.5 shrink-0">
                      {dept.totalOverdue > 0 && <span className="text-[11px] font-semibold text-red-600">{dept.totalOverdue} overdue</span>}
                      <div className="w-[80px]"><LoadBar used={dept.totalHours} capacity={dept.totalCapacity} /></div>
                    </div>
                  </div>

                  {/* Members */}
                  {isExp && (
                    <div className="border-t border-slate-200 animate-fade-in">
                      {(dept.members ?? []).map((member: any) => {
                        const pct = member.capacity > 0 ? Math.round(member.hoursWeek / member.capacity * 100) : 0;
                        const isOver = pct > 100;
                        const isLow = pct < 60;
                        const isMExp = expandedMembers[member.id];

                        return (
                          <div key={member.id} className="border-b border-slate-100 last:border-b-0">
                            <div onClick={() => toggleMember(member.id)}
                              className={cn('flex items-center gap-2 px-4 py-2 pl-11 cursor-pointer hover:bg-slate-50/80 transition-colors border-l-[3px]',
                                isOver ? 'border-l-red-500' : isLow ? 'border-l-emerald-500' : 'border-l-transparent')}>
                              <Chevron open={!!isMExp} />
                              <Avatar firstName={member.firstName} lastName={member.lastName} size={28} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[13px] font-semibold text-slate-900">{member.firstName} {member.lastName}</span>
                                  {isOver && <span className="text-[10px] font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded border border-red-200">OVERLOADED</span>}
                                  {isLow && <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">AVAILABLE</span>}
                                </div>
                                <span className="text-[11px] text-slate-400">{member.position} · {member.tasks} tasks</span>
                              </div>
                              {member.overdueTasks > 0 && (
                                <span className="w-5 h-5 rounded-[5px] bg-red-50 flex items-center justify-center text-[10px] font-bold text-red-600">{member.overdueTasks}</span>
                              )}
                              <span className={cn('text-[13px] font-bold font-mono', isOver ? 'text-red-600' : isLow ? 'text-emerald-600' : 'text-slate-700')}>
                                {member.hoursWeek}h<span className="text-[11px] text-slate-400 font-normal">/{member.capacity}h</span>
                              </span>
                              <div className="w-[70px]"><LoadBar used={member.hoursWeek} capacity={member.capacity} /></div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {projects.length === 0 && departments.length === 0 && !isLoading && (
        <div className="rounded-[14px] border border-slate-200 bg-white py-16 text-center">
          <p className="text-sm font-semibold text-slate-500">No active projects or team data</p>
          <p className="text-[13px] text-slate-400 mt-1">Operations data will appear once projects are active</p>
        </div>
      )}
    </div>
  );
}
