import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Grid3X3, FolderKanban, MapPin, AlertTriangle, AlertCircle, Calendar, Clock } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { ProjectSelect } from '@/components/shared/project-select';
import { EmptyState } from '@/components/shared/empty-state';
import { TaskDrawer } from '@/features/tasks/task-drawer';
import { getTaskHealth, aggregateHealth, type TaskHealth } from '@/lib/task-health';
import { STATUS_DOT, STATUS_PILL, STATUS_LABEL, formatShortDate } from '@/lib/task-constants';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { getTaskPhaseName } from './execution-board.util';

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
  /**
   * True for zone rows that have no parent ZONE above them (i.e. they sit
   * directly under a project, not under another zone). Used to decide whether
   * to render the progress bar — only top-level zones do, sub-zones get just
   * the % + health badge. We can't infer this from `depth` alone because
   * `depth=0` is the project row in multi-project view (zones start at depth=1
   * there) but the top zone in single-project view (depth=0).
   */
  isTopLevelZone?: boolean;
  projectId?: number;
  zoneType?: string;
  number?: string | null;
}


function useExecutionBoard(projectId?: number | null, serviceId?: number | null) {
  return useQuery<BoardData>({
    queryKey: queryKeys.executionBoard.with(projectId ?? null, serviceId ?? null),
    queryFn: () =>
      client
        .get('/execution-board', {
          params: {
            ...(projectId ? { projectId } : {}),
            ...(serviceId ? { serviceId } : {}),
          },
        })
        .then((r) => r.data?.data ?? r.data),
    // Treat data as stale immediately so any invalidation (e.g., after
    // updating a task in the drawer) triggers a refetch without waiting
    // out the global 5-minute staleTime.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
}

// STATUS_DOT, STATUS_PILL, STATUS_LABEL imported from '@/lib/task-constants'

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

function CellSummary({
  tasks,
  healths,
  isAggregate,
  expanded,
  onToggle,
  /**
   * Whether to render the visual progress bar. Only the top-level zones in
   * the execution board do — sub-zones show just `% + health` so the eye
   * isn't pulled away from the parent zone's overall progress.
   */
  showBar = true,
}: { tasks: Task[]; healths: TaskHealth[]; isAggregate: boolean; expanded: boolean; onToggle: () => void; showBar?: boolean }) {
  if (tasks.length === 0) return null;

  // Completion = sum of estimated hours for COMPLETED tasks / sum of all
  // estimated hours. A task is only "done" when its status is 'completed' —
  // logged hours alone do not count as 100%.
  let completedHours = 0;
  let totalHours = 0;
  let completedCount = 0;
  for (const task of tasks) {
    const est = Number(task.budgetHours) || 0;
    totalHours += est;
    if (task.status === 'completed') {
      completedHours += est;
      completedCount++;
    }
  }
  const pct = totalHours > 0
    ? Math.round((completedHours / totalHours) * 100)
    : Math.round((completedCount / tasks.length) * 100);

  const agg = aggregateHealth(healths);
  const color =
    pct >= 100 ? 'bg-emerald-500' : pct >= 60 ? 'bg-blue-500' : pct >= 30 ? 'bg-amber-500' : 'bg-slate-300';
  const textColor =
    pct >= 100 ? 'text-emerald-600' : pct >= 60 ? 'text-blue-600' : pct >= 30 ? 'text-amber-600' : 'text-slate-500';

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'w-full text-left px-1 py-0.5 rounded hover:bg-slate-50 transition-colors',
        isAggregate ? '' : 'mb-1',
      )}
      aria-expanded={expanded}
      aria-label={`${pct}% complete, ${tasks.length} tasks. Click to ${expanded ? 'collapse' : 'expand'}.`}
    >
      <div className="flex items-center gap-1.5">
        <ChevronRight
          className={cn(
            'h-3 w-3 text-slate-400 shrink-0 transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        {showBar ? (
          <div className="flex-1 h-[4px] bg-slate-200 rounded-full overflow-hidden">
            <div className={cn('h-full rounded-full', color)} style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
        ) : (
          // Sub-zones: spacer keeps the % + health badge pushed right, in
          // visual line with their parent's bar — but no bar of their own.
          <div className="flex-1" />
        )}
        <span className={cn('text-[10px] font-bold tabular-nums shrink-0', textColor)}>{pct}%</span>
        <HealthBadge agg={agg} />
      </div>
      <div className="flex items-center gap-2 text-[10px] text-slate-500 mt-0.5 pl-4">
        <span>{completedCount}/{tasks.length} done</span>
        {totalHours > 0 && <span>· {totalHours}h est.</span>}
      </div>
    </button>
  );
}

function TaskCard({ task, health, onClick }: { task: Task; health: TaskHealth; onClick: () => void }) {
  // Status-driven card styling per spec:
  //  - TODO ('not_started') WITH a due date → light blue card, full detail
  //  - TODO without a due date            → grey, just the title with "-"
  //  - IN PROGRESS                        → darker blue
  //  - other statuses inherit risk-level styling as before.
  const isTodo = task.status === 'not_started';
  const isInProgress = task.status === 'in_progress';
  const hasDue = !!task.endDate;
  const isBareTodo = isTodo && !hasDue;        // grey, title-only
  const isBlueTodo = isTodo && hasDue;         // light-blue, full detail
  const showDetails = !isBareTodo;

  const baseBorder =
    health.level === 'critical'
      ? 'border-red-300 bg-red-50 ring-1 ring-red-200'
      : health.level === 'warning'
        ? 'border-amber-300 bg-amber-50/60'
        : isInProgress
          ? 'border-blue-400 bg-blue-100/70'
          : isBlueTodo
            ? 'border-sky-300 bg-sky-50'
            : isBareTodo
              ? 'border-slate-200 bg-slate-100/60'
              : 'border-slate-200 bg-white';

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full rounded-md border px-2 py-2 text-left shadow-sm transition-all hover:shadow-md',
        showDetails ? 'space-y-1.5' : 'space-y-0',
        baseBorder,
      )}
      title={health.reasons.length > 0 ? health.reasons.join(' • ') : undefined}
    >
      {/* Line 1: task name + risk icon. Bare-TODO cards add an inline "-"
          marker per spec ("title with '-' no other details, in grey"). */}
      <div className="flex items-start gap-1.5">
        <span className={cn('h-2 w-2 mt-1 shrink-0 rounded-full', STATUS_DOT[task.status] ?? 'bg-slate-400')} />
        <span className={cn(
          'flex-1 text-[12px] leading-tight break-words',
          isBareTodo ? 'text-slate-500 font-medium' : 'font-semibold text-slate-800',
        )}>
          {task.name}{isBareTodo && <span className="text-slate-400 ml-1">—</span>}
        </span>
        {health.level === 'critical' && <AlertCircle className="h-3.5 w-3.5 text-red-600 shrink-0" />}
        {health.level === 'warning' && <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
      </div>

      {showDetails && (
        <div className="flex items-center gap-1.5">
          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider', STATUS_PILL[task.status] ?? STATUS_PILL.not_started)}>
            {STATUS_LABEL[task.status] ?? task.status}
          </span>
        </div>
      )}

      {/* Hours + due date — hidden on bare-TODO cards, per spec. */}
      {showDetails && (
        <div className="flex items-center gap-1 text-[10px] text-slate-600">
          <Clock className="h-2.5 w-2.5 shrink-0" />
          <span className="tabular-nums font-medium">
            {health.loggedHours}h {health.estimatedHours > 0 ? `/ ${health.estimatedHours}h est.` : 'logged'}
          </span>
        </div>
      )}

      {/* Due date — only when we're showing details (i.e. not a bare TODO). */}
      {showDetails && task.endDate && (
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

      {showDetails && task.assignees.length > 0 && (
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
  // Service filter is now a STRING (the service name from getTaskPhaseName)
  // and applied client-side — see the explanation in execution-board.service.ts.
  const [serviceFilter, setServiceFilter] = useState<string>('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [expandedZones, setExpandedZones] = useState<Set<number>>(new Set());
  const [drawerTaskId, setDrawerTaskId] = useState<number | null>(null);
  // Due-date filters (#3.3). `dueFrom`/`dueTo` accept ISO yyyy-mm-dd
  // (matches `<input type=date>`). `onlyWithDue` hides tasks that have
  // no end date at all — useful for cleaning up the "TODO without due"
  // grey blob from the planning view.
  const [dueFrom, setDueFrom] = useState<string>('');
  const [dueTo, setDueTo] = useState<string>('');
  const [onlyWithDue, setOnlyWithDue] = useState(false);
  const didAutoExpand = useRef(false);

  // Don't pass serviceId to the server anymore; we filter client-side.
  const { data, isLoading } = useExecutionBoard(projectId, null);

  const toggleZoneExpand = useCallback((zoneId: number) => {
    setExpandedZones((prev) => {
      const next = new Set(prev);
      if (next.has(zoneId)) next.delete(zoneId);
      else next.add(zoneId);
      return next;
    });
  }, []);

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

  // Apply client-side filters before the matrix is built. Order matters:
  // service filter narrows by column-name; date filters trim by endDate.
  const filteredTasks = useMemo(() => {
    const all = data?.tasks ?? [];
    return all.filter((t: any) => {
      if (onlyWithDue && !t.endDate) return false;
      if (dueFrom || dueTo) {
        if (!t.endDate) return false;
        const d = String(t.endDate).slice(0, 10);
        if (dueFrom && d < dueFrom) return false;
        if (dueTo && d > dueTo) return false;
      }
      if (serviceFilter) {
        // getTaskPhaseName covers serviceType.name, phase.name, [SERVICE:xxx].
        const name = getTaskPhaseName(t);
        if ((name ?? '__none__') !== serviceFilter) return false;
      }
      return true;
    });
  }, [data?.tasks, serviceFilter, dueFrom, dueTo, onlyWithDue]);

  // Filter dropdown options = the DELIVERABLE TEMPLATES the admin designed
  // (data.templates is type='task_list' templates) that actually have at
  // least one task in scope. Aligned with the visible column headers, plus
  // any "rogue" service names from tasks that don't match a template.
  // Computed from UNFILTERED tasks so the option list doesn't shrink as the
  // user picks.
  const availableServices = useMemo(() => {
    const allTasks = data?.tasks ?? [];
    const templates = data?.templates ?? [];
    const namesWithTasks = new Set<string>();
    let hasNone = false;
    for (const t of allTasks) {
      const n = getTaskPhaseName(t);
      if (n) namesWithTasks.add(n);
      else hasNone = true;
    }
    // Deliverable templates first (in their configured order), then any
    // task service names that don't match a template ("rogue" services).
    const ordered: string[] = [];
    for (const tpl of templates) {
      if (namesWithTasks.has(tpl.name)) ordered.push(tpl.name);
    }
    for (const n of namesWithTasks) {
      if (!ordered.includes(n)) ordered.push(n);
    }
    if (hasNone) ordered.push('__none__');
    return ordered;
  }, [data?.tasks, data?.templates]);

  const { phaseColumns, directMatrix, hasNoPhase, phaseToService } = useMemo(() => {
    const tasks = filteredTasks;
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
  }, [filteredTasks, data?.templates]);

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

    function walkZones(nodes: ZoneNode[], baseDepth: number, projectIdCtx: number, isTopLevel: boolean) {
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
          isTopLevelZone: isTopLevel,
          projectId: projectIdCtx,
          zoneType: z.zoneType,
        });
        if (hasChildren && expandedIds.has(key)) {
          walkZones(z.children, baseDepth + 1, projectIdCtx, /* isTopLevel */ false);
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
          walkZones(zoneTree, 1, project.id, /* isTopLevel */ true);
        }
      } else {
        walkZones(zoneTree, 0, project.id, /* isTopLevel */ true);
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
        {/* Service dropdown — populated client-side from the service names
            actually present in the data. Avoids the previous bug where the
            list was driven from the Phase catalog and most options had no
            matching tasks. */}
        <select
          value={serviceFilter}
          onChange={(e) => setServiceFilter(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent"
          title="Filter by service / deliverable"
        >
          <option value="">All Services</option>
          {availableServices.map((name) => (
            <option key={name} value={name}>
              {name === '__none__' ? '— No service —' : name}
            </option>
          ))}
        </select>

        {/* Due-date range + only-with-due toggle (#3.3). */}
        <div className="flex items-center gap-1.5 text-[12px] text-slate-600">
          <span className="font-semibold uppercase text-[10px] tracking-wider text-slate-400">Due</span>
          <input
            type="date"
            value={dueFrom}
            onChange={(e) => setDueFrom(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-[12px]"
            title="Earliest due date"
          />
          <span className="text-slate-400">→</span>
          <input
            type="date"
            value={dueTo}
            onChange={(e) => setDueTo(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-[12px]"
            title="Latest due date"
          />
        </div>
        <label className="flex items-center gap-1.5 text-[12px] text-slate-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={onlyWithDue}
            onChange={(e) => setOnlyWithDue(e.target.checked)}
            className="rounded border-slate-300"
          />
          Only with due date
        </label>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { setExpandedZones(new Set()); setExpandedIds(new Set()); }}
            disabled={expandedZones.size === 0 && expandedIds.size === 0}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-semibold text-slate-700 hover:border-slate-400 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Collapse every zone / sub-zone"
          >
            Collapse All
          </button>
          {(serviceFilter || dueFrom || dueTo || onlyWithDue) && (
            <button
              type="button"
              onClick={() => { setServiceFilter(''); setDueFrom(''); setDueTo(''); setOnlyWithDue(false); }}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-semibold text-slate-700 hover:border-slate-400"
              title="Clear all filters"
            >
              Clear filters
            </button>
          )}
        </div>

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
                            <span className="text-[9px] text-slate-500 normal-case tracking-normal">— no service —</span>
                          )}
                        </div>
                      </th>
                    );
                  })}
                  {hasNoPhase && (
                    <th className="sticky top-0 z-20 bg-slate-50 px-3 py-2.5 text-center font-semibold min-w-[200px] text-slate-600 border-b border-slate-100">
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
                  const zoneExpanded = expandedZones.has(row.id);

                  // One unified chevron now: a single click on the row toggles
                  // BOTH sub-zone visibility (tree) AND task-card expansion. The
                  // two used to live as separate chevrons, but users found the
                  // double-icon confusing.
                  const expandFully = () => {
                    toggleZoneExpand(row.id);
                    if (row.hasChildren) toggleExpand(row.key);
                  };
                  // Whether the row currently shows ANY expanded state — drives
                  // the chevron rotation.
                  const anyExpanded = zoneExpanded || (row.hasChildren && expandedIds.has(row.key));

                  return (
                    <tr
                      key={row.key}
                      className="group border-t border-slate-100 hover:bg-blue-50/50 transition-colors"
                    >
                      <td
                        className={cn(
                          // sticky-left cell defaults to bg-white so it stays opaque
                          // when scrolled; group-hover paints it the same blue as the
                          // rest of the row so the whole line lights up together.
                          'sticky left-0 z-10 bg-white group-hover:bg-blue-100/70 px-4 py-2 border-r border-slate-200 border-l-[3px] cursor-pointer transition-colors',
                          zc.border,
                        )}
                        onClick={expandFully}
                        aria-label={anyExpanded ? 'Collapse this zone' : 'Expand this zone'}
                      >
                        <div
                          className="flex items-center gap-1.5"
                          style={{ paddingLeft: `${row.depth * 20}px` }}
                        >
                          {/* Single combined chevron — rotates when either state is expanded. */}
                          <ChevronRight
                            className={cn(
                              'h-3.5 w-3.5 shrink-0 transition-transform duration-150',
                              anyExpanded ? 'rotate-90 text-blue-600' : 'text-slate-400',
                            )}
                          />
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
                                <CellSummary
                                  tasks={aggTasks}
                                  healths={aggHealths}
                                  isAggregate={isParent}
                                  expanded={zoneExpanded}
                                  onToggle={() => toggleZoneExpand(row.id)}
                                  showBar={!!row.isTopLevelZone}
                                />
                                {zoneExpanded && directTasks.map((task) => (
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
                                <CellSummary
                                  tasks={aggTasks}
                                  healths={aggHealths}
                                  isAggregate={isParent}
                                  expanded={zoneExpanded}
                                  onToggle={() => toggleZoneExpand(row.id)}
                                  showBar={!!row.isTopLevelZone}
                                />
                                {zoneExpanded && directTasks.map((task) => (
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
