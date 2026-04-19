import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronRight, Users, Zap, UserCheck, MessageSquare, ExternalLink } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { DiscussionDrawer } from '@/features/messaging/discussion-drawer';
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
        <div className={cn('h-full rounded-full transition-all duration-300', color)} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className={cn('text-[11px] font-bold font-mono min-w-[30px] text-right', textColor)}>{pct}%</span>
    </div>
  );
}

function Chev({ open, size = 14 }: { open: boolean; size?: number }) {
  return <ChevronRight className={cn('text-slate-400 transition-transform duration-150 shrink-0', open && 'rotate-90')} style={{ width: size, height: size }} />;
}

export function OperationsDashboardPage() {
  const navigate = useNavigate();
  const [expandedProjects, setExpandedProjects] = useState<Record<number, boolean>>({});
  const [expandedDepts, setExpandedDepts] = useState<Record<string, boolean>>({});
  const [expandedMembers, setExpandedMembers] = useState<Record<number, boolean>>({});
  const [chat, setChat] = useState<{ type: 'project' | 'task'; id: number; title: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', 'operations'],
    queryFn: () => client.get('/dashboard/operations').then((r) => r.data?.data ?? r.data),
    staleTime: 60 * 1000,
  });

  if (isLoading) return <PageSkeleton />;

  const summary = data?.summary ?? { totalOverdue: 0, totalBlocked: 0, overloadedCount: 0, availableCount: 0, availableHours: 0 };
  const projects: any[] = data?.projects ?? [];
  const departments: any[] = data?.departments ?? [];

  return (
    <div className="space-y-5">
      <PageHeader title="Operations Dashboard" description="Project risks · Team workload · Task reassignment" />

      {/* ═══ SUMMARY CARDS ═══ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { n: summary.totalOverdue, label: 'Overdue', sub: `Blocking ${summary.totalBlocked} tasks`, bg: 'bg-red-50', border: 'border-red-200', iconBg: 'bg-red-600', textDark: 'text-red-900', textLight: 'text-red-700' },
          { n: summary.totalBlocked, label: 'Blocked', sub: 'Waiting on dependencies', bg: 'bg-amber-50', border: 'border-amber-200', iconBg: 'bg-amber-600', textDark: 'text-amber-900', textLight: 'text-amber-700' },
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

      {/* ═══ PROJECTS AT RISK ═══ */}
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
              const isExp = !!expandedProjects[project.id];
              const overdueTasks: any[] = project.overdueTasks ?? [];

              return (
                <div key={project.id} className={cn('rounded-[14px] border bg-white overflow-hidden transition-colors', isExp ? cfg.border : 'border-slate-200')}>
                  {/* Project header */}
                  <div
                    onClick={() => setExpandedProjects((prev) => ({ ...prev, [project.id]: !prev[project.id] }))}
                    className={cn('flex items-center gap-2.5 px-4 py-3 cursor-pointer hover:bg-slate-50/80 transition-colors border-l-[4px]',
                      project.status === 'critical' ? 'border-l-red-600' : project.status === 'high' ? 'border-l-amber-500' : 'border-l-blue-500')}>
                    <Chev open={isExp} />
                    <span className={cn('rounded-[5px] px-2 py-0.5 text-[11px] font-bold shrink-0 border', cfg.bg, cfg.text, cfg.border)}>{cfg.label}</span>
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      <span className="text-sm font-bold text-slate-900">{project.name}</span>
                      <span className="font-mono text-[11px] text-slate-400">{project.number}</span>
                      {/* Project link */}
                      <button onClick={(e) => { e.stopPropagation(); navigate(`/projects/${project.id}`); }}
                        className="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                        title="Open project">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                      {/* Project chat */}
                      <button onClick={(e) => { e.stopPropagation(); setChat({ type: 'project', id: project.id, title: project.name }); }}
                        className="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                        title="Project discussion">
                        <MessageSquare className="h-3.5 w-3.5" />
                      </button>
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
                    <div>
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
                            <div key={task.id} className="flex items-center gap-2 px-4 py-2 border-b border-slate-50 hover:bg-slate-50/50 group">
                              <div className={cn('w-[3px] h-8 rounded-sm shrink-0', PRI_COLORS[task.priority] ?? 'bg-slate-400')} />
                              <div className="w-6 h-6 rounded-md bg-red-50 flex items-center justify-center text-[11px] font-bold text-red-600 shrink-0">!</div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-mono text-[11px] text-slate-500">{task.code}</span>
                                  <button onClick={() => navigate(`/tasks/${task.id}`)}
                                    className="text-[13px] font-semibold text-slate-900 hover:text-blue-600 hover:underline transition-colors">
                                    {task.name}
                                  </button>
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
                              {/* Task actions: navigate + chat */}
                              <button onClick={(e) => { e.stopPropagation(); navigate(`/tasks/${task.id}`); }}
                                className="w-7 h-7 rounded-md flex items-center justify-center text-slate-300 hover:text-blue-600 hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100"
                                title="Open task">
                                <ExternalLink className="h-3.5 w-3.5" />
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); setChat({ type: 'task', id: task.id, title: `${task.code} ${task.name}` }); }}
                                className="w-7 h-7 rounded-md flex items-center justify-center text-slate-300 hover:text-blue-600 hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100"
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

      {/* ═══ TEAM LOAD BY DEPARTMENT ═══ */}
      {departments.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-1 h-5 rounded-sm bg-blue-600" />
            <h2 className="text-base font-bold text-slate-900">Team Load by Department</h2>
          </div>

          <div className="space-y-2">
            {departments.map((dept: any) => {
              const isExp = !!expandedDepts[dept.name];
              const members: any[] = dept.members ?? [];

              return (
                <div key={dept.name} className={cn('rounded-[14px] border bg-white overflow-hidden transition-colors', isExp ? 'border-slate-300' : 'border-slate-200')}>
                  {/* Dept header — toggles expand */}
                  <button type="button"
                    onClick={() => setExpandedDepts((prev) => ({ ...prev, [dept.name]: !prev[dept.name] }))}
                    className={cn('w-full flex items-center gap-2.5 px-4 py-3 text-left transition-colors', isExp ? 'bg-slate-50/80' : 'hover:bg-slate-50/50')}>
                    <Chev open={isExp} />
                    <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center text-[13px] font-bold shrink-0">
                      {members.length}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-slate-900">{dept.name}</p>
                    </div>
                    <div className="flex items-center gap-2.5 shrink-0">
                      {dept.totalOverdue > 0 && <span className="text-[11px] font-semibold text-red-600">{dept.totalOverdue} overdue</span>}
                      <div className="w-[80px]"><LoadBar used={dept.totalHours} capacity={dept.totalCapacity} /></div>
                    </div>
                  </button>

                  {/* Expanded: member list */}
                  {isExp && (
                    <div className="border-t border-slate-200">
                      {members.map((member: any) => {
                        const pct = member.capacity > 0 ? Math.round(member.hoursWeek / member.capacity * 100) : 0;
                        const isOver = pct > 100;
                        const isLow = pct < 60;
                        const isMExp = !!expandedMembers[member.id];
                        const memberTasks: any[] = member.taskList ?? [];
                        const hasTasks = memberTasks.length > 0;

                        return (
                          <div key={member.id} className="border-b border-slate-100 last:border-b-0">
                            {/* Member row */}
                            <button type="button"
                              onClick={() => hasTasks && setExpandedMembers((prev) => ({ ...prev, [member.id]: !prev[member.id] }))}
                              className={cn('w-full flex items-center gap-2 px-4 py-2 pl-11 text-left transition-colors border-l-[3px]',
                                hasTasks ? 'cursor-pointer hover:bg-slate-50/80' : 'cursor-default',
                                isOver ? 'border-l-red-500' : isLow ? 'border-l-emerald-500' : 'border-l-transparent')}>
                              {hasTasks ? <Chev open={isMExp} size={12} /> : <span className="w-3" />}
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
                                <span className="w-5 h-5 rounded-[5px] bg-red-50 flex items-center justify-center text-[10px] font-bold text-red-600 shrink-0">{member.overdueTasks}</span>
                              )}
                              <span className={cn('text-[13px] font-bold font-mono shrink-0', isOver ? 'text-red-600' : isLow ? 'text-emerald-600' : 'text-slate-700')}>
                                {member.hoursWeek}h<span className="text-[11px] text-slate-400 font-normal">/{member.capacity}h</span>
                              </span>
                              <div className="w-[70px] shrink-0"><LoadBar used={member.hoursWeek} capacity={member.capacity} /></div>
                            </button>

                            {/* Expanded: member's tasks */}
                            {isMExp && hasTasks && (
                              <div className="bg-slate-50/80">
                                {memberTasks.map((task: any) => {
                                  const isOverdue = task.daysOverdue != null && task.daysOverdue > 0;
                                  return (
                                    <div key={task.id} className="flex items-center gap-2 py-1.5 px-4 pl-[76px] border-b border-slate-100 last:border-b-0 text-[12px] group hover:bg-slate-100/60 transition-colors">
                                      <div className={cn('w-[3px] h-6 rounded-sm shrink-0', isOverdue ? 'bg-red-500' : 'bg-slate-200')} />
                                      <span className="font-mono text-[10px] text-slate-400 min-w-[50px]">{task.code}</span>
                                      <button onClick={() => navigate(`/tasks/${task.id}`)}
                                        className="flex-1 text-left font-medium text-slate-800 hover:text-blue-600 hover:underline truncate transition-colors">
                                        {task.name}
                                      </button>
                                      <button onClick={() => navigate(`/projects/${task.projectId}`)}
                                        className="text-[10px] text-slate-400 hover:text-blue-600 hover:underline truncate max-w-[120px] transition-colors">
                                        {task.projectName}
                                      </button>
                                      {isOverdue && (
                                        <span className="text-[10px] font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded border border-red-100 shrink-0">{task.daysOverdue}d late</span>
                                      )}
                                      {/* Task link + chat */}
                                      <button onClick={() => navigate(`/tasks/${task.id}`)}
                                        className="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 hover:text-blue-600 hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100 shrink-0"
                                        title="Open task">
                                        <ExternalLink className="h-3 w-3" />
                                      </button>
                                      <button onClick={() => setChat({ type: 'task', id: task.id, title: `${task.code} ${task.name}` })}
                                        className="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 hover:text-blue-600 hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100 shrink-0"
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
        </div>
      )}

      {/* Empty state */}
      {projects.length === 0 && departments.length === 0 && !isLoading && (
        <div className="rounded-[14px] border border-slate-200 bg-white py-16 text-center">
          <p className="text-sm font-semibold text-slate-500">No active projects or team data</p>
          <p className="text-[13px] text-slate-400 mt-1">Operations data will appear once projects are active</p>
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
    </div>
  );
}
