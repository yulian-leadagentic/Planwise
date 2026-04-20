import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Grid3X3, FolderKanban, MapPin } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { ProjectSelect } from '@/components/shared/project-select';
import { EmptyState } from '@/components/shared/empty-state';
import { TaskDrawer } from '@/features/tasks/task-drawer';
import { cn } from '@/lib/utils';
import client from '@/api/client';

const SERVICE_RE = /^\[SERVICE:(.+)\]$/;

interface TemplateRef {
  id: number;
  name: string;
  code: string | null;
  phaseId: number | null;
}

interface Service {
  id: number;
  name: string;
  code: string | null;
  color: string | null;
}

interface Assignee {
  user: { id: number; firstName: string; lastName: string; avatarUrl: string | null };
}

interface Task {
  id: number;
  code: string;
  name: string;
  description: string | null;
  status: string;
  completionPct: number;
  zoneId: number;
  serviceTypeId: number | null;
  phaseId: number | null;
  serviceType: { id: number; name: string; code: string | null; color: string | null } | null;
  phase: Service | null;
  assignees: Assignee[];
}

interface ZoneNode {
  id: number;
  name: string;
  zoneType: string;
  projectId: number;
  parentId: number | null;
  children: ZoneNode[];
}

interface Project {
  id: number;
  name: string;
  number: string | null;
  status: string;
}

interface BoardData {
  projects: Project[];
  zones: Record<number, ZoneNode[]>;
  tasks: Task[];
  services: Service[];
  templates: TemplateRef[];
}

interface FlatRow {
  type: 'project' | 'zone';
  id: number;
  key: string;
  name: string;
  depth: number;
  hasChildren: boolean;
  projectId?: number;
  zoneType?: string;
  number?: string | null;
}

function getTaskPhaseName(task: Task): string | null {
  if (task.serviceType?.name) return task.serviceType.name;
  const m = task.description?.match(SERVICE_RE);
  return m ? m[1] : null;
}

function useExecutionBoard(projectId?: number | null, serviceId?: number | null) {
  return useQuery<BoardData>({
    queryKey: ['execution-board', projectId, serviceId],
    queryFn: () =>
      client
        .get('/execution-board', {
          params: {
            ...(projectId ? { projectId } : {}),
            ...(serviceId ? { serviceId } : {}),
          },
        })
        .then((r) => r.data?.data ?? r.data),
  });
}

const STATUS_DOT: Record<string, string> = {
  not_started: 'bg-slate-400',
  in_progress: 'bg-blue-500',
  in_review: 'bg-violet-500',
  completed: 'bg-emerald-500',
  on_hold: 'bg-amber-500',
  cancelled: 'bg-red-500',
};

const STATUS_BG: Record<string, string> = {
  not_started: 'border-slate-200 bg-slate-50/50',
  in_progress: 'border-blue-200 bg-blue-50/40',
  in_review: 'border-violet-200 bg-violet-50/40',
  completed: 'border-emerald-200 bg-emerald-50/40',
  on_hold: 'border-amber-200 bg-amber-50/40',
  cancelled: 'border-red-200 bg-red-50/30',
};

const ZONE_COLORS: Record<string, { border: string; badge: string; text: string }> = {
  zone:     { border: 'border-l-blue-400',   badge: 'bg-blue-100 text-blue-700',     text: 'text-blue-700' },
  building: { border: 'border-l-indigo-400', badge: 'bg-indigo-100 text-indigo-700', text: 'text-indigo-700' },
  floor:    { border: 'border-l-teal-400',   badge: 'bg-teal-100 text-teal-700',     text: 'text-teal-700' },
  area:     { border: 'border-l-amber-400',  badge: 'bg-amber-100 text-amber-700',   text: 'text-amber-700' },
  wing:     { border: 'border-l-pink-400',   badge: 'bg-pink-100 text-pink-700',     text: 'text-pink-700' },
  section:  { border: 'border-l-cyan-400',   badge: 'bg-cyan-100 text-cyan-700',     text: 'text-cyan-700' },
};

const PROJECT_COLORS = [
  { bg: 'bg-blue-50', border: 'border-blue-200', icon: 'text-blue-500' },
  { bg: 'bg-violet-50', border: 'border-violet-200', icon: 'text-violet-500' },
  { bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'text-emerald-500' },
  { bg: 'bg-amber-50', border: 'border-amber-200', icon: 'text-amber-500' },
  { bg: 'bg-rose-50', border: 'border-rose-200', icon: 'text-rose-500' },
  { bg: 'bg-cyan-50', border: 'border-cyan-200', icon: 'text-cyan-500' },
];

function CellSummary({ tasks, isAggregate }: { tasks: Task[]; isAggregate: boolean }) {
  if (tasks.length === 0) return null;
  const avg = Math.round(tasks.reduce((s, t) => s + t.completionPct, 0) / tasks.length);
  const color =
    avg >= 100 ? 'bg-emerald-500' : avg >= 60 ? 'bg-blue-500' : avg >= 30 ? 'bg-amber-500' : 'bg-slate-300';
  const textColor =
    avg >= 100 ? 'text-emerald-600' : avg >= 60 ? 'text-blue-600' : avg >= 30 ? 'text-amber-600' : 'text-slate-500';
  return (
    <div className={cn('px-0.5', isAggregate ? '' : 'mb-1.5')}>
      <div className="flex items-center gap-1.5">
        <div className="flex-1 h-[4px] bg-slate-200 rounded-full overflow-hidden">
          <div className={cn('h-full rounded-full', color)} style={{ width: `${Math.min(avg, 100)}%` }} />
        </div>
        <span className={cn('text-[10px] font-bold tabular-nums shrink-0', textColor)}>{avg}%</span>
      </div>
      {isAggregate && (
        <span className="text-[10px] text-slate-400">{tasks.length} tasks</span>
      )}
    </div>
  );
}

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  const statusBg = STATUS_BG[task.status] ?? STATUS_BG.not_started;
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full rounded-md border px-2.5 py-1.5 text-left shadow-sm transition-all hover:shadow-md',
        statusBg,
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[task.status] ?? 'bg-slate-400')} />
        <span className="flex-1 truncate text-[12px] font-medium text-slate-700">{task.name}</span>
        <span className="shrink-0 text-[11px] font-semibold text-slate-400">{task.completionPct}%</span>
      </div>
      {task.assignees.length > 0 && (
        <div className="mt-1 flex -space-x-1.5">
          {task.assignees.slice(0, 3).map((a) => (
            <div
              key={a.user.id}
              className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-[9px] font-bold text-white ring-1 ring-white"
              title={`${a.user.firstName} ${a.user.lastName}`}
            >
              {(a.user.firstName?.[0] ?? '')}{(a.user.lastName?.[0] ?? '')}
            </div>
          ))}
          {task.assignees.length > 3 && (
            <div className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-300 text-[9px] font-bold text-slate-600 ring-1 ring-white">
              +{task.assignees.length - 3}
            </div>
          )}
        </div>
      )}
    </button>
  );
}

export function ExecutionBoardPage() {
  const [projectId, setProjectId] = useState<number | null>(null);
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [drawerTaskId, setDrawerTaskId] = useState<number | null>(null);
  const didAutoExpand = useRef(false);

  const { data, isLoading } = useExecutionBoard(projectId, serviceId);

  // Auto-expand all projects + first-level zones on initial load
  useEffect(() => {
    if (!data || didAutoExpand.current) return;
    didAutoExpand.current = true;
    const keys = new Set<string>();
    for (const project of data.projects) {
      keys.add(`project-${project.id}`);
      for (const zone of data.zones[project.id] ?? []) {
        keys.add(`zone-${zone.id}`);
      }
    }
    setExpandedIds(keys);
  }, [data]);

  const toggleExpand = useCallback((key: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const services = data?.services ?? [];

  // Build zoneId → all descendant zone IDs (including self)
  const zoneDescendants = useMemo(() => {
    if (!data) return new Map<number, number[]>();
    const map = new Map<number, number[]>();

    function collect(node: ZoneNode): number[] {
      const ids = [node.id];
      for (const child of node.children ?? []) {
        ids.push(...collect(child));
      }
      map.set(node.id, ids);
      return ids;
    }

    for (const project of data.projects) {
      for (const root of data.zones[project.id] ?? []) {
        collect(root);
      }
    }
    return map;
  }, [data]);

  // Build direct task matrix: zoneId|phaseName → tasks
  const { phaseColumns, directMatrix, hasNoPhase } = useMemo(() => {
    const tasks = data?.tasks ?? [];
    const templates = data?.templates ?? [];

    const nameToHasTasks = new Set<string>();
    let _hasNoPhase = false;

    const matrix = new Map<string, Task[]>();
    for (const task of tasks) {
      const phaseName = getTaskPhaseName(task) ?? '__none__';
      if (phaseName === '__none__') _hasNoPhase = true;
      else nameToHasTasks.add(phaseName);
      const key = `${task.zoneId}|${phaseName}`;
      if (!matrix.has(key)) matrix.set(key, []);
      matrix.get(key)!.push(task);
    }

    const orderedColumns: string[] = [];
    for (const tpl of templates) {
      if (nameToHasTasks.has(tpl.name)) orderedColumns.push(tpl.name);
    }
    for (const name of nameToHasTasks) {
      if (!orderedColumns.includes(name)) orderedColumns.push(name);
    }

    return { phaseColumns: orderedColumns, directMatrix: matrix, hasNoPhase: _hasNoPhase };
  }, [data?.tasks, data?.templates]);

  const getAggregatedTasks = useCallback(
    (zoneId: number, phaseName: string): Task[] => {
      const descIds = zoneDescendants.get(zoneId) ?? [zoneId];
      const result: Task[] = [];
      for (const id of descIds) {
        const tasks = directMatrix.get(`${id}|${phaseName}`);
        if (tasks) result.push(...tasks);
      }
      return result;
    },
    [zoneDescendants, directMatrix],
  );

  const flatRows = useMemo(() => {
    if (!data) return [];
    const result: FlatRow[] = [];
    const showProjects = !projectId && data.projects.length > 0;

    function walkZones(nodes: ZoneNode[], baseDepth: number, projectIdCtx: number) {
      for (const z of nodes) {
        const hasChildren = z.children?.length > 0;
        const key = `zone-${z.id}`;
        result.push({
          type: 'zone',
          id: z.id,
          key,
          name: z.name,
          depth: baseDepth,
          hasChildren,
          projectId: projectIdCtx,
          zoneType: z.zoneType,
        });
        if (hasChildren && expandedIds.has(key)) {
          walkZones(z.children, baseDepth + 1, projectIdCtx);
        }
      }
    }

    for (const project of data.projects) {
      const zoneTree = data.zones[project.id] ?? [];
      if (showProjects) {
        const pKey = `project-${project.id}`;
        result.push({
          type: 'project',
          id: project.id,
          key: pKey,
          name: project.name,
          number: project.number,
          depth: 0,
          hasChildren: zoneTree.length > 0,
        });
        if (expandedIds.has(pKey)) {
          walkZones(zoneTree, 1, project.id);
        }
      } else {
        walkZones(zoneTree, 0, project.id);
      }
    }

    return result;
  }, [data, projectId, expandedIds]);

  if (isLoading) return <PageSkeleton />;

  const projectColorMap = new Map<number, (typeof PROJECT_COLORS)[0]>();
  (data?.projects ?? []).forEach((p, i) => projectColorMap.set(p.id, PROJECT_COLORS[i % PROJECT_COLORS.length]));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Execution Board"
        description="Zone × Phase task matrix across projects"
      />

      <div className="flex flex-wrap items-center gap-3">
        <ProjectSelect
          value={projectId}
          onChange={(id) => {
            setProjectId(id);
            didAutoExpand.current = false;
          }}
          placeholder="All Projects"
          className="w-64"
        />
        <select
          value={serviceId ?? ''}
          onChange={(e) => setServiceId(e.target.value ? +e.target.value : null)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent"
        >
          <option value="">All Services</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {flatRows.length === 0 ? (
        <EmptyState
          icon={Grid3X3}
          title={data?.projects.length === 0 ? 'No active projects' : 'No data to display'}
          description={
            data?.projects.length === 0
              ? 'There are no active or on-hold projects to show.'
              : 'Select a project or adjust filters to see the execution board.'
          }
        />
      ) : (
        <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="sticky left-0 z-10 bg-slate-50 px-4 py-2.5 text-left font-semibold min-w-[300px] border-r border-slate-200">
                    Zone
                  </th>
                  {phaseColumns.map((name) => (
                    <th
                      key={name}
                      className="px-3 py-2.5 text-center font-semibold min-w-[180px] border-r border-slate-100 last:border-r-0"
                    >
                      {name}
                    </th>
                  ))}
                  {hasNoPhase && (
                    <th className="px-3 py-2.5 text-center font-semibold min-w-[180px] text-slate-400">
                      No Phase
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {flatRows.map((row) => {
                  if (row.type === 'project') {
                    const totalCols = phaseColumns.length + (hasNoPhase ? 2 : 1);
                    const pc = projectColorMap.get(row.id) ?? PROJECT_COLORS[0];
                    return (
                      <tr
                        key={row.key}
                        className={cn('border-t border-slate-200 cursor-pointer hover:brightness-95 transition-all', pc.bg)}
                        onClick={() => toggleExpand(row.key)}
                      >
                        <td
                          className={cn('sticky left-0 z-10 px-4 py-2.5 border-r', pc.bg, pc.border)}
                          colSpan={totalCols}
                        >
                          <div className="flex items-center gap-2">
                            <ChevronRight
                              className={cn(
                                'h-4 w-4 text-slate-400 transition-transform duration-150',
                                expandedIds.has(row.key) && 'rotate-90',
                              )}
                            />
                            <FolderKanban className={cn('h-4 w-4', pc.icon)} />
                            <span className="font-semibold text-slate-700">{row.name}</span>
                            {row.number && (
                              <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', pc.border, pc.bg === 'bg-blue-50' ? 'text-blue-600' : 'text-slate-500')}>
                                {row.number}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  }

                  const isParent = row.hasChildren;
                  const zc = ZONE_COLORS[row.zoneType ?? ''] ?? ZONE_COLORS.zone;

                  return (
                    <tr
                      key={row.key}
                      className="border-t border-slate-100 hover:bg-slate-50/40"
                    >
                      <td className={cn('sticky left-0 z-10 bg-white px-4 py-2 border-r border-slate-200 border-l-[3px]', zc.border)}>
                        <div
                          className="flex items-center gap-1.5 cursor-pointer"
                          style={{ paddingLeft: `${row.depth * 20}px` }}
                          onClick={() => row.hasChildren && toggleExpand(row.key)}
                        >
                          {row.hasChildren ? (
                            <ChevronRight
                              className={cn(
                                'h-3.5 w-3.5 text-slate-400 transition-transform duration-150 shrink-0',
                                expandedIds.has(row.key) && 'rotate-90',
                              )}
                            />
                          ) : (
                            <MapPin className="h-3 w-3 text-slate-300 shrink-0" />
                          )}
                          <span
                            className={cn(
                              'truncate text-[13px]',
                              row.hasChildren ? 'font-semibold text-slate-700' : 'text-slate-600',
                            )}
                          >
                            {row.name}
                          </span>
                          {row.zoneType && (
                            <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium capitalize shrink-0', zc.badge)}>
                              {row.zoneType}
                            </span>
                          )}
                        </div>
                      </td>
                      {phaseColumns.map((phaseName) => {
                        const aggTasks = getAggregatedTasks(row.id, phaseName);
                        const directTasks = directMatrix.get(`${row.id}|${phaseName}`) ?? [];
                        return (
                          <td
                            key={phaseName}
                            className="px-2 py-1.5 align-top border-r border-slate-100 last:border-r-0"
                          >
                            {aggTasks.length > 0 && (
                              <div className="flex flex-col gap-1">
                                <CellSummary tasks={aggTasks} isAggregate={isParent} />
                                {directTasks.map((task) => (
                                  <TaskCard
                                    key={task.id}
                                    task={task}
                                    onClick={() => setDrawerTaskId(task.id)}
                                  />
                                ))}
                              </div>
                            )}
                          </td>
                        );
                      })}
                      {hasNoPhase && (
                        <td className="px-2 py-1.5 align-top">
                          {(() => {
                            const aggTasks = getAggregatedTasks(row.id, '__none__');
                            const directTasks = directMatrix.get(`${row.id}|__none__`) ?? [];
                            if (aggTasks.length === 0) return null;
                            return (
                              <div className="flex flex-col gap-1">
                                <CellSummary tasks={aggTasks} isAggregate={isParent} />
                                {directTasks.map((task) => (
                                  <TaskCard
                                    key={task.id}
                                    task={task}
                                    onClick={() => setDrawerTaskId(task.id)}
                                  />
                                ))}
                              </div>
                            );
                          })()}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Task detail drawer */}
      <TaskDrawer taskId={drawerTaskId} onClose={() => setDrawerTaskId(null)} />
    </div>
  );
}
