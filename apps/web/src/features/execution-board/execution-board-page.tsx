import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Grid3X3, FolderKanban, MapPin, AlertTriangle, AlertCircle, Calendar, Clock } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { ProjectSelect } from '@/components/shared/project-select';
import { EmptyState } from '@/components/shared/empty-state';
import { TaskDrawer } from '@/features/tasks/task-drawer';
import { getTaskHealth, aggregateHealth, type TaskHealth } from '@/lib/task-health';
import { cn } from '@/lib/utils';
import client from '@/api/client';

const SERVICE_RE = /^\[SERVICE:(.+)\]$/;

interface TemplateRef {
  id: number;
  name: string;
  code: string | null;
  phaseId: number | null;
  phase: { id: number; name: string; color: string | null } | null;
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
  budgetHours: number | null;
  endDate: string | null;
  loggedMinutes: number;
  lastActivityDate: string | null;
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

const STATUS_LABEL: Record<string, string> = {
  not_started: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  completed: 'Done',
  on_hold: 'On Hold',
  cancelled: 'Cancelled',
};

const ZONE_COLORS: Record<string, { border: string; badge: string }> = {
  zone:     { border: 'border-l-blue-400',   badge: 'bg-blue-100 text-blue-700' },
  building: { border: 'border-l-indigo-400', badge: 'bg-indigo-100 text-indigo-700' },
  floor:    { border: 'border-l-teal-400',   badge: 'bg-teal-100 text-teal-700' },
  area:     { border: 'border-l-amber-400',  badge: 'bg-amber-100 text-amber-700' },
  wing:     { border: 'border-l-pink-400',   badge: 'bg-pink-100 text-pink-700' },
  section:  { border: 'border-l-cyan-400',   badge: 'bg-cyan-100 text-cyan-700' },
};

const PROJECT_COLORS = [
  { bg: 'bg-blue-50', border: 'border-blue-200', icon: 'text-blue-500' },
  { bg: 'bg-violet-50', border: 'border-violet-200', icon: 'text-violet-500' },
  { bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'text-emerald-500' },
  { bg: 'bg-amber-50', border: 'border-amber-200', icon: 'text-amber-500' },
  { bg: 'bg-rose-50', border: 'border-rose-200', icon: 'text-rose-500' },
  { bg: 'bg-cyan-50', border: 'border-cyan-200', icon: 'text-cyan-500' },
];

function formatShortDate(iso: string): string {
  const d = new Date(iso.split('T')[0]);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

function HealthBadge({ agg, size = 'sm' }: { agg: { critical: number; warning: number; ok: number }; size?: 'sm' | 'md' }) {
  const { critical, warning } = agg;
  if (critical === 0 && warning === 0) return null;
  const cls = size === 'md' ? 'text-[11px] px-2 py-1' : 'text-[10px] px-1.5 py-0.5';
  const iconSize = size === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3';
  return (
    <div className="flex items-center gap-1 shrink-0">
      {critical > 0 && (
        <span className={cn('flex items-center gap-1 rounded-full bg-red-100 text-red-700 font-bold', cls)}>
          <AlertCircle className={iconSize} />
          {critical}
        </span>
      )}
      {warning > 0 && (
        <span className={cn('flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 font-bold', cls)}>
          <AlertTriangle className={iconSize} />
          {warning}
        </span>
      )}
    </div>
  );
}

function CellSummary({ tasks, healths, isAggregate }: { tasks: Task[]; healths: TaskHealth[]; isAggregate: boolean }) {
  if (tasks.length === 0) return null;
  const avg = Math.round(healths.reduce((s, h) => s + h.computedPct, 0) / healths.length);
  const agg = aggregateHealth(healths);
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
        <HealthBadge agg={agg} />
      </div>
      {isAggregate && (
        <span className="text-[10px] text-slate-400">{tasks.length} tasks</span>
      )}
    </div>
  );
}

const STATUS_PILL: Record<string, string> = {
  not_started: 'bg-slate-100 text-slate-600',
  in_progress: 'bg-blue-100 text-blue-700',
  in_review: 'bg-violet-100 text-violet-700',
  completed: 'bg-emerald-100 text-emerald-700',
  on_hold: 'bg-amber-100 text-amber-700',
  cancelled: 'bg-red-100 text-red-700',
};

function TaskCard({ task, health, onClick }: { task: Task; health: TaskHealth; onClick: () => void }) {
  const borderCls =
    health.level === 'critical'
      ? 'border-red-300 bg-red-50 ring-1 ring-red-200'
      : health.level === 'warning'
        ? 'border-amber-300 bg-amber-50/60'
        : 'border-slate-200 bg-white';

  const pctColor =
    health.computedPct >= 100 ? 'bg-emerald-500' :
    health.computedPct >= 60 ? 'bg-blue-500' :
    health.computedPct >= 30 ? 'bg-amber-500' : 'bg-slate-300';

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full rounded-md border px-2 py-2 text-left shadow-sm transition-all hover:shadow-md space-y-1.5',
        borderCls,
      )}
      title={health.reasons.length > 0 ? health.reasons.join(' • ') : undefined}
    >
      {/* Line 1: task name + risk icon */}
      <div className="flex items-start gap-1.5">
        <span className={cn('h-2 w-2 mt-1 shrink-0 rounded-full', STATUS_DOT[task.status] ?? 'bg-slate-400')} />
        <span className="flex-1 text-[12px] font-semibold text-slate-800 leading-tight break-words">{task.name}</span>
        {health.level === 'critical' && <AlertCircle className="h-3.5 w-3.5 text-red-600 shrink-0" />}
        {health.level === 'warning' && <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
      </div>

      {/* Line 2: Kanban stage pill */}
      <div className="flex items-center gap-1.5">
        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider', STATUS_PILL[task.status] ?? STATUS_PILL.not_started)}>
          {STATUS_LABEL[task.status] ?? task.status}
        </span>
      </div>

      {/* Line 3: completion bar */}
      <div className="flex items-center gap-1.5">
        <div className="flex-1 h-[4px] bg-slate-200 rounded-full overflow-hidden">
          <div className={cn('h-full rounded-full', pctColor)} style={{ width: `${Math.min(health.computedPct, 100)}%` }} />
        </div>
        <span className="text-[10px] font-bold tabular-nums text-slate-700 min-w-[28px] text-right">{health.computedPct}%</span>
      </div>

      {/* Line 4: hours spent */}
      <div className="flex items-center gap-1 text-[10px] text-slate-600">
        <Clock className="h-2.5 w-2.5 shrink-0" />
        <span className="tabular-nums font-medium">
          {health.loggedHours}h {health.estimatedHours > 0 ? `/ ${health.estimatedHours}h est.` : 'logged'}
        </span>
      </div>

      {/* Line 5: due date */}
      {task.endDate && (
        <div className="flex items-center gap-1 text-[10px]">
          <Calendar className={cn('h-2.5 w-2.5 shrink-0', health.isOverdue ? 'text-red-600' : 'text-slate-400')} />
          <span className={cn(
            'tabular-nums',
            health.isOverdue ? 'text-red-600 font-bold' : 'text-slate-500 font-medium',
          )}>
            Due {formatShortDate(task.endDate)}
            {health.isOverdue && ' (overdue)'}
          </span>
        </div>
      )}

      {task.assignees.length > 0 && (
        <div className="flex -space-x-1.5 pt-0.5">
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

  // Compute task health map
  const taskHealths = useMemo(() => {
    const map = new Map<number, TaskHealth>();
    for (const task of data?.tasks ?? []) {
      map.set(task.id, getTaskHealth(task));
    }
    return map;
  }, [data?.tasks]);

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
      for (const root of data.zones[project.id] ?? []) collect(root);
    }
    return map;
  }, [data]);

  const { phaseColumns, directMatrix, hasNoPhase, phaseToService } = useMemo(() => {
    const tasks = data?.tasks ?? [];
    const templates = data?.templates ?? [];
    const nameToHasTasks = new Set<string>();
    let _hasNoPhase = false;

    // Build phase-name → service info from templates and also task.phase (fallback)
    const nameToService = new Map<string, { name: string; color: string | null }>();
    for (const tpl of templates) {
      if (tpl.phase) nameToService.set(tpl.name, { name: tpl.phase.name, color: tpl.phase.color });
    }

    const matrix = new Map<string, Task[]>();
    for (const task of tasks) {
      const phaseName = getTaskPhaseName(task) ?? '__none__';
      if (phaseName === '__none__') _hasNoPhase = true;
      else {
        nameToHasTasks.add(phaseName);
        // Fallback: use task.phase (the DB Phase = UI "Service") when template mapping is missing
        if (!nameToService.has(phaseName) && task.phase) {
          nameToService.set(phaseName, { name: task.phase.name, color: task.phase.color });
        }
      }
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

    return {
      phaseColumns: orderedColumns,
      directMatrix: matrix,
      hasNoPhase: _hasNoPhase,
      phaseToService: nameToService,
    };
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

  // Aggregate health per project
  const projectHealth = useMemo(() => {
    const map = new Map<number, { critical: number; warning: number; ok: number }>();
    for (const task of data?.tasks ?? []) {
      const h = taskHealths.get(task.id);
      if (!h) continue;
      // Find project via zone
      for (const project of data?.projects ?? []) {
        const descIds = data?.zones[project.id]
          ? new Set(
              (function all(nodes: ZoneNode[]): number[] {
                const ids: number[] = [];
                for (const n of nodes) {
                  ids.push(n.id);
                  ids.push(...all(n.children ?? []));
                }
                return ids;
              })(data.zones[project.id] ?? []),
            )
          : new Set<number>();
        if (descIds.has(task.zoneId)) {
          const cur = map.get(project.id) ?? { critical: 0, warning: 0, ok: 0 };
          if (h.level === 'critical') cur.critical++;
          else if (h.level === 'warning') cur.warning++;
          else cur.ok++;
          map.set(project.id, cur);
          break;
        }
      }
    }
    return map;
  }, [data, taskHealths]);

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
        description="Zone × Deliverable task matrix across projects — risk indicators highlight overdue, at-risk, and stale tasks"
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

        {/* Legend */}
        <div className="ml-auto flex items-center gap-3 text-[11px] text-slate-500">
          <span className="flex items-center gap-1"><AlertCircle className="h-3 w-3 text-red-600" />Overdue / critical</span>
          <span className="flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-amber-600" />At risk</span>
        </div>
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
        <div className="rounded-[14px] border border-slate-200 bg-white overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="sticky top-0 left-0 z-30 bg-slate-50 px-4 py-2.5 text-left font-semibold min-w-[300px] border-r border-b border-slate-200">
                    Zone
                  </th>
                  {phaseColumns.map((name) => {
                    const svc = phaseToService.get(name);
                    return (
                      <th
                        key={name}
                        className="sticky top-0 z-20 bg-slate-50 px-3 py-2 text-center font-semibold min-w-[200px] border-r border-b border-slate-100 last:border-r-0"
                      >
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="text-slate-700">{name}</span>
                          {svc ? (
                            <span
                              className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium normal-case tracking-normal"
                              style={{
                                backgroundColor: svc.color ? `${svc.color}22` : '#e0f2fe',
                                color: svc.color ?? '#0369a1',
                              }}
                            >
                              {svc.color && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: svc.color }} />}
                              {svc.name}
                            </span>
                          ) : (
                            <span className="text-[9px] text-slate-300 normal-case tracking-normal">— no service —</span>
                          )}
                        </div>
                      </th>
                    );
                  })}
                  {hasNoPhase && (
                    <th className="sticky top-0 z-20 bg-slate-50 px-3 py-2.5 text-center font-semibold min-w-[200px] text-slate-400 border-b border-slate-100">
                      No Deliverable
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {flatRows.map((row) => {
                  if (row.type === 'project') {
                    const totalCols = phaseColumns.length + (hasNoPhase ? 2 : 1);
                    const pc = projectColorMap.get(row.id) ?? PROJECT_COLORS[0];
                    const agg = projectHealth.get(row.id) ?? { critical: 0, warning: 0, ok: 0 };
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
                              <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium border', pc.border, 'text-slate-600 bg-white/60')}>
                                {row.number}
                              </span>
                            )}
                            <HealthBadge agg={agg} size="md" />
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
                        const aggHealths = aggTasks.map((t) => taskHealths.get(t.id)!).filter(Boolean);
                        return (
                          <td
                            key={phaseName}
                            className="px-2 py-1.5 align-top border-r border-slate-100 last:border-r-0"
                          >
                            {aggTasks.length > 0 && (
                              <div className="flex flex-col gap-1">
                                <CellSummary tasks={aggTasks} healths={aggHealths} isAggregate={isParent} />
                                {directTasks.map((task) => (
                                  <TaskCard
                                    key={task.id}
                                    task={task}
                                    health={taskHealths.get(task.id)!}
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
                            const aggHealths = aggTasks.map((t) => taskHealths.get(t.id)!).filter(Boolean);
                            if (aggTasks.length === 0) return null;
                            return (
                              <div className="flex flex-col gap-1">
                                <CellSummary tasks={aggTasks} healths={aggHealths} isAggregate={isParent} />
                                {directTasks.map((task) => (
                                  <TaskCard
                                    key={task.id}
                                    task={task}
                                    health={taskHealths.get(task.id)!}
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
      )}

      <TaskDrawer taskId={drawerTaskId} onClose={() => setDrawerTaskId(null)} />
    </div>
  );
}
