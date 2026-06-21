import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Grid3X3, FolderKanban, MapPin, AlertTriangle, AlertCircle, Calendar, Clock } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { TaskDrawer } from '@/features/tasks/task-drawer';
import { useDrawerRoute } from '@/components/nav/use-drawer-route';
import { MultiSelectFilter } from '@/components/shared/multi-select-filter';
import { getTaskHealth, aggregateHealth, type TaskHealth } from '@/lib/task-health';
import { STATUS_DOT, STATUS_PILL, STATUS_LABEL, formatShortDate } from '@/lib/task-constants';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { getTaskPhaseName, getTaskServiceName } from './execution-board.util';

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
  /** Nullable — a task may live at the project root with no parent zone. */
  zoneId: number | null;
  projectId: number;
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

export function ExecutionBoardPage({ forcedProjectId }: { forcedProjectId?: number } = {}) {
  // When the page is rendered as a project tab (forcedProjectId set),
  // the project selector at the top is hidden and the page is locked
  // to that single project. The standalone /execution-board route
  // passes nothing and gets the cross-project view it always had.
  // Multi-select set of project IDs — empty = no filter (all projects).
  // When embedded inside a Project page (`forcedProjectId` set), we lock
  // the page to that single project by initializing the set with it AND
  // hiding the filter widget. When standalone, the set is initially empty
  // (= all projects) and the user picks any subset via the multi-select.
  const [projectIds, setProjectIds] = useState<Set<number>>(
    forcedProjectId != null ? new Set([forcedProjectId]) : new Set(),
  );
  useEffect(() => {
    if (forcedProjectId != null) setProjectIds(new Set([forcedProjectId]));
  }, [forcedProjectId]);
  // Backwards-compat alias for the cluster of legacy reads below
  // (matrix grouping, header visibility, API call optimization). Single
  // value when EXACTLY one project is selected; null otherwise (all or
  // multiple — both render with project breakdown rows).
  const projectId: number | null = projectIds.size === 1 ? Array.from(projectIds)[0] : null;
  // View-mode tab inside Execution Board:
  //   • "matrix" — zone × deliverable matrix (task chips per cell)
  //   • "status" — project × deliverable status board (completion %)
  //   • "tasks"  — project × deliverable board listing task TITLES as
  //                status-colored chips in each cell.
  // All three share the same filter state so swapping views keeps context.
  const [viewMode, setViewMode] = useState<'matrix' | 'status' | 'tasks' | 'zone-tasks'>('matrix');
  // Deliverable + Service filters are MULTI-SELECT sets of names — empty
  // set means "no filter (all)". Migrated from single-value strings as
  // part of #50 so users can compare several services or deliverables at
  // once. The matrix narrows to the OR of selected values. `serviceFilter`
  // keeps its name (it's the deliverable-column filter) to avoid a wider
  // rename; the displayed label is "Deliverables".
  const [serviceFilter, setServiceFilter] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [expandedZones, setExpandedZones] = useState<Set<number>>(new Set());
  // Track newly-expanded rows so we can scroll their expanded content into
  // view — without this, expanding a row near the bottom of the viewport
  // makes the new task cards render off-screen and the user thinks
  // 'nothing happened'.
  const rowRefs = useRef<Map<number, HTMLTableRowElement | null>>(new Map());
  const prevExpandedZones = useRef<Set<number>>(new Set());
  useEffect(() => {
    for (const id of expandedZones) {
      if (prevExpandedZones.current.has(id)) continue;
      const row = rowRefs.current.get(id);
      if (!row) continue;
      const rect = row.getBoundingClientRect();
      // Only scroll if the row's bottom is below the viewport.
      if (rect.bottom > window.innerHeight - 80) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    prevExpandedZones.current = new Set(expandedZones);
  }, [expandedZones]);
  // Drawer ID in ?task=N so back/refresh/outbound-return restores it.
  const { drawerId: drawerTaskId, openDrawer: setDrawerTaskId, closeDrawer } = useDrawerRoute('task');
  // Due-date filters (#3.3). `dueFrom`/`dueTo` accept ISO yyyy-mm-dd
  // (matches `<input type=date>`). `onlyWithDue` hides tasks that have
  // no end date at all — useful for cleaning up the "TODO without due"
  // grey blob from the planning view.
  const [dueFrom, setDueFrom] = useState<string>('');
  const [dueTo, setDueTo] = useState<string>('');
  const [onlyWithDue, setOnlyWithDue] = useState(false);
  // General task-status filter ('' = all). Applies across all three views.
  const [statusFilter, setStatusFilter] = useState<string>('');
  // Service (Phase) filter ('' = all). Resolved via getTaskServiceName so it
  // honors the project-owned deliverable's service link first, then falls
  // back to the task's phase / legacy serviceType.
  // Multi-select set of service names — empty = no filter (all services).
  // See `serviceFilter` above for the parallel deliverable-name set.
  const [phaseFilter, setPhaseFilter] = useState<Set<string>>(new Set());
  const didAutoExpand = useRef(false);

  // Don't pass serviceId to the server anymore; we filter client-side.
  // For projectId, pass the forcedProjectId only (embedded mode); the
  // multi-select filter is client-side so the API always returns the
  // user's full project list — that way the multi-select options stay
  // populated regardless of how many are selected.
  const { data, isLoading } = useExecutionBoard(forcedProjectId ?? null, null);

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

  // When a filter turns active, force-expand EVERY project + zone
  // (including nested) so the visibleFlatRows empty-row pruning has the
  // child rows present to evaluate. Without this, a collapsed project
  // has no child rows in flatRows, the "keep project if a child
  // survives" check finds nothing, and every project gets dropped —
  // which is exactly the "all rows vanish on filter" bug. Recursive so
  // deeply-nested zones with matches also surface.
  useEffect(() => {
    // Inline the filter-active check (the memoized isFilterActive const
    // is declared later in the component — referencing it here would hit
    // its TDZ during render).
    const filterActive = projectIds.size > 0 || serviceFilter.size > 0 || !!dueFrom || !!dueTo || onlyWithDue || !!statusFilter || phaseFilter.size > 0;
    if (!filterActive || !data) return;
    const keys = new Set<string>();
    const addZones = (nodes: ZoneNode[]) => {
      for (const z of nodes) {
        keys.add(`zone-${z.id}`);
        if (z.children?.length) addZones(z.children);
      }
    };
    for (const project of data.projects) {
      keys.add(`project-${project.id}`);
      addZones(data.zones[project.id] ?? []);
    }
    setExpandedIds((prev) => new Set([...prev, ...keys]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIds, serviceFilter, dueFrom, dueTo, onlyWithDue, statusFilter, phaseFilter, data]);

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

  // The dropdown filters by DELIVERABLE — the small pill below each column
  // header.
  //
  // Deliverable name → Service-name map, derived from templates alone so it
  // can be used by the Service-filter pipeline (availablePhases + filter
  // predicate) without a dependency cycle. Mirrors the lookup the
  // column-header badges use, so a task that shows up under a
  // "BIM Coordination" column resolves to "BIM Coordination" for the
  // filter too — even when its own FK chain doesn't carry the service
  // link (ad-hoc project deliverables, legacy rows).
  //
  // Declared HERE — above availablePhases / filteredTasks — because both
  // useMemo deps arrays reference it. A TDZ-shaped bug was introduced
  // once before (commit 8fcaaff) by declaring a similar map after the
  // memos that read it.
  const deliverableNameToService = useMemo(() => {
    const m = new Map<string, string>();
    for (const tpl of data?.templates ?? []) {
      if (tpl.phase?.name) m.set(tpl.name, tpl.phase.name);
    }
    return m;
  }, [data?.templates]);

  // X3 — narrow the option list to deliverables that ACTUALLY appear in
  // the projects currently in scope. Previously the dropdown was built
  // from ALL tasks across ALL projects; picking a name that exists only
  // in some unrelated project then matched zero tasks and the user
  // saw "all rows vanish". Now the dropdown only offers values that
  // can actually produce a result.
  const availableServices = useMemo(() => {
    const allTasks = (data?.tasks ?? []).filter((t: any) =>
      projectIds.size === 0 ? true : projectIds.has(t.projectId),
    );
    const templates = data?.templates ?? [];

    // CRITICAL — the dropdown must offer EXACTLY the deliverable column
    // values the board actually renders, i.e. getTaskPhaseName(task).
    // That same function keys the matrix columns AND (below) the filter
    // matcher, so dropdown ≡ column ≡ filter. Listing phase.name here
    // (the previous behaviour) drifted from the marker/serviceType-driven
    // columns and produced false positives — e.g. zone מרתף surfacing
    // under a deliverable it has no tasks in.
    const present = new Set<string>();
    for (const t of allTasks) {
      const n = getTaskPhaseName(t);
      if (n) present.add(n);
    }

    // Order to match the board's column ordering: templates first (catalog
    // order), then any remaining names in insertion order.
    const ordered: string[] = [];
    for (const tpl of templates) {
      if (present.has(tpl.name) && !ordered.includes(tpl.name)) ordered.push(tpl.name);
    }
    for (const n of present) {
      if (!ordered.includes(n)) ordered.push(n);
    }

    return ordered;
  }, [data?.tasks, data?.templates, projectIds]);

  // Same construction as availableServices but resolved via getTaskServiceName
  // — the Service filter only offers values that actually appear on tasks
  // currently in scope. Picks up the project-owned deliverable's service
  // (post-refactor) and falls back to the task's phase / serviceType.
  const availablePhases = useMemo(() => {
    const allTasks = (data?.tasks ?? []).filter((t: any) =>
      projectIds.size === 0 ? true : projectIds.has(t.projectId),
    );
    const present = new Set<string>();
    for (const t of allTasks) {
      const n = getTaskServiceName(t, deliverableNameToService);
      if (n) present.add(n);
    }
    // Order by the services list returned alongside the board (catalog
    // sortOrder), then any remaining names alphabetically.
    const ordered: string[] = [];
    for (const s of data?.services ?? []) {
      if (present.has(s.name) && !ordered.includes(s.name)) ordered.push(s.name);
    }
    for (const n of Array.from(present).sort((a, b) => a.localeCompare(b))) {
      if (!ordered.includes(n)) ordered.push(n);
    }
    return ordered;
  }, [data?.tasks, data?.services, projectIds, deliverableNameToService]);

  // Apply client-side filters before the matrix is built. Order matters:
  // deliverable filter narrows by template-phase; date filters trim by endDate.
  const filteredTasks = useMemo(() => {
    const all = data?.tasks ?? [];
    return all.filter((t: any) => {
      // Project multi-select: empty set = no filter (all projects). Otherwise
      // the task must belong to one of the selected projects. This filter
      // used to be missing entirely — tasks flowed through unfiltered and
      // every downstream view (Status / Task / Matrix / Zone Tasks) showed
      // all projects regardless of selection (bug, 2026-06-21).
      if (projectIds.size > 0 && !projectIds.has(t.projectId)) return false;
      if (statusFilter && t.status !== statusFilter) return false;
      if (phaseFilter.size > 0 && !phaseFilter.has(getTaskServiceName(t, deliverableNameToService) ?? '__none__')) return false;
      if (onlyWithDue && !t.endDate) return false;
      if (dueFrom || dueTo) {
        if (!t.endDate) return false;
        const d = String(t.endDate).slice(0, 10);
        if (dueFrom && d < dueFrom) return false;
        if (dueTo && d > dueTo) return false;
      }
      if (serviceFilter.size > 0) {
        // serviceFilter is a SET of deliverable column values straight from
        // the multi-select. Match STRICTLY on the same dimension the board
        // uses to build columns, so the filter is exactly consistent with
        // what's rendered. A zone only survives if it genuinely owns a task
        // in any of the selected columns — no phase-vs-marker false
        // positives (the מרתף-under-תאום-מערכות bug).
        if (!serviceFilter.has(getTaskPhaseName(t) ?? '__none__')) return false;
      }
      return true;
    });
  }, [data?.tasks, projectIds, serviceFilter, dueFrom, dueTo, onlyWithDue, statusFilter, phaseFilter, deliverableNameToService]);

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
      // Real-zone tasks key by their zoneId. Root tasks (zoneId=null)
      // are intentionally NOT added to this matrix — they go into the
      // dedicated rootTasksByProject map below so the synthetic
      // 'Project Root' row has a lookup path that doesn't depend on
      // matrix key coercion.
      if (task.zoneId != null) {
        const key = `${task.zoneId}|${phaseName}`;
        if (!matrix.has(key)) matrix.set(key, []);
        matrix.get(key)!.push(task);
      }
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

  // Dedicated per-project bucket for root tasks (zoneId=null). The
  // 'Project Root' synthetic row pulls from here instead of the matrix
  // so the lookup is keyed on a real projectId (number) rather than a
  // negative-id template-string that's easy to mis-cast.
  const rootTasksByProject = useMemo(() => {
    const m = new Map<number, Map<string, Task[]>>();
    for (const t of filteredTasks) {
      if (t.zoneId != null) continue;
      const pid = (t as any).projectId as number;
      if (pid == null) continue;
      const phaseName = getTaskPhaseName(t) ?? '__none__';
      if (!m.has(pid)) m.set(pid, new Map());
      const inner = m.get(pid)!;
      if (!inner.has(phaseName)) inner.set(phaseName, []);
      inner.get(phaseName)!.push(t);
    }
    return m;
  }, [filteredTasks]);

  const getAggregatedTasks = useCallback(
    (zoneId: number, phaseName: string): Task[] => {
      // Synthetic 'Project Root' rows use id = -projectId. Resolve from
      // the dedicated root map.
      if (zoneId < 0) {
        return rootTasksByProject.get(-zoneId)?.get(phaseName) ?? [];
      }
      const descIds = zoneDescendants.get(zoneId) ?? [zoneId];
      const result: Task[] = [];
      for (const id of descIds) {
        const tasks = directMatrix.get(`${id}|${phaseName}`);
        if (tasks) result.push(...tasks);
      }
      return result;
    },
    [zoneDescendants, directMatrix, rootTasksByProject],
  );

  // Aggregate health per project
  const projectHealth = useMemo(() => {
    const map = new Map<number, { critical: number; warning: number; ok: number }>();
    for (const task of data?.tasks ?? []) {
      const h = taskHealths.get(task.id);
      if (!h) continue;
      // Project resolution: root tasks (zoneId=null) attribute directly
      // to task.projectId; zone-scoped tasks resolve via zone-descendants.
      let resolvedProjectId: number | null = null;
      if (task.zoneId == null) {
        resolvedProjectId = task.projectId;
      } else {
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
            resolvedProjectId = project.id;
            break;
          }
        }
      }
      if (resolvedProjectId == null) continue;
      const cur = map.get(resolvedProjectId) ?? { critical: 0, warning: 0, ok: 0 };
      if (h.level === 'critical') cur.critical++;
      else if (h.level === 'warning') cur.warning++;
      else cur.ok++;
      map.set(resolvedProjectId, cur);
    }
    return map;
  }, [data, taskHealths]);

  // Set of project ids that have at least one task at the project root
  // (no parent zone). Drives whether we inject the synthetic 'Project
  // Root' bucket row for that project.
  const projectsWithRootTasks = useMemo(() => {
    const s = new Set<number>();
    for (const t of filteredTasks) {
      if (t.zoneId == null) s.add(t.projectId);
    }
    return s;
  }, [filteredTasks]);

  const flatRows = useMemo(() => {
    if (!data) return [];
    const result: FlatRow[] = [];
    // Project header row visibility. In STANDALONE mode (the dedicated
    // Execution Board page) we always show the header — selecting one
    // project shouldn't make the layout collapse to depth-0 zones with
    // no project label (that was confusing per user feedback 2026-06-21).
    // In EMBEDDED mode (Execution Board rendered as a tab inside a
    // project), the project context is already obvious from the
    // surrounding page so the header would be redundant.
    const showProjects = forcedProjectId == null && data.projects.length > 0;

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

    /** Synthetic 'Project Root' row for tasks with zoneId=null. The id is
     *  -projectId so it doesn't collide with real zones and matches the
     *  key used in directMatrix. */
    function pushRootBucket(projectIdCtx: number, depth: number) {
      result.push({
        type: 'zone',
        id: -projectIdCtx,
        key: `root-${projectIdCtx}`,
        name: 'Project Root',
        depth,
        hasChildren: false,
        isTopLevelZone: true,
        projectId: projectIdCtx,
        zoneType: 'root',
      });
    }

    // Apply the project multi-select to the row iteration. Without this,
    // a Matrix view with 1 project selected (showProjects=false) walked
    // zones of ALL projects at depth 0 — the user saw a mixed jumble of
    // zones that didn't belong to their chosen project.
    const projectsInScope = projectIds.size === 0
      ? data.projects
      : data.projects.filter((p) => projectIds.has(p.id));
    for (const project of projectsInScope) {
      const zoneTree = data.zones[project.id] ?? [];
      const hasRoot = projectsWithRootTasks.has(project.id);
      if (showProjects) {
        const pKey = `project-${project.id}`;
        result.push({
          type: 'project',
          id: project.id,
          key: pKey,
          name: project.name,
          number: project.number,
          depth: 0,
          hasChildren: zoneTree.length > 0 || hasRoot,
        });
        if (expandedIds.has(pKey)) {
          if (hasRoot) pushRootBucket(project.id, 1);
          walkZones(zoneTree, 1, project.id, /* isTopLevel */ true);
        }
      } else {
        if (hasRoot) pushRootBucket(project.id, 0);
        walkZones(zoneTree, 0, project.id, /* isTopLevel */ true);
      }
    }

    return result;
  }, [data, projectId, projectIds, expandedIds, projectsWithRootTasks]);

  // When any client-side filter is active, hide rows that have zero
  // tasks under any phase column. Without this the user picks a filter
  // (e.g. service = "BIM") and still sees every zone with empty cells
  // — exactly what F2 in the bug list called out.
  //
  // A row "has tasks" when at least one phase column returns a non-empty
  // aggregated-tasks list for it. Project rows are kept if any of their
  // child zones survive — collapsing/expanding still works because
  // expandedIds is unaffected.
  const isFilterActive = projectIds.size > 0 || serviceFilter.size > 0 || !!dueFrom || !!dueTo || onlyWithDue || !!statusFilter || phaseFilter.size > 0;
  const visibleFlatRows = useMemo(() => {
    if (!isFilterActive) return flatRows;

    // Survival computed DIRECTLY from the matched tasks — NOT from which
    // rows happen to be present in flatRows. The old version walked
    // flatRows for surviving children, which silently dropped every
    // project when projects were collapsed (their zone children weren't
    // in flatRows yet). Deriving from filteredTasks removes that
    // coupling entirely.
    const projMatch = new Set<number>();        // projects with any match
    const zoneLeafMatch = new Set<number>();    // leaf zones holding a match
    const rootMatchProjects = new Set<number>(); // projects with a matching ROOT task
    for (const t of filteredTasks) {
      if (t.projectId != null) projMatch.add(t.projectId);
      if (t.zoneId != null) zoneLeafMatch.add(t.zoneId);
      else if (t.projectId != null) rootMatchProjects.add(t.projectId);
    }

    const zoneSurvives = (rowId: number) => {
      // Synthetic 'Project Root' rows use id = -projectId.
      if (rowId < 0) return rootMatchProjects.has(-rowId);
      // A real zone survives if it OR any descendant holds a match.
      const desc = zoneDescendants.get(rowId) ?? [rowId];
      return desc.some((id) => zoneLeafMatch.has(id));
    };

    return flatRows.filter((r) => {
      if (r.type === 'project') return projMatch.has(r.id);
      if (r.type === 'zone') return zoneSurvives(r.id);
      return true;
    });
  }, [flatRows, isFilterActive, filteredTasks, zoneDescendants]);

  if (isLoading) return <PageSkeleton />;

  const projectColorMap = new Map<number, (typeof PROJECT_COLORS)[0]>();
  (data?.projects ?? []).forEach((p, i) => projectColorMap.set(p.id, PROJECT_COLORS[i % PROJECT_COLORS.length]));

  return (
    <div className="space-y-5">
      {/* Page header is suppressed when embedded as a project tab — the
          project tab bar already names the surface, a second title is
          redundant. */}
      {forcedProjectId == null && (
        <PageHeader
          title="Execution Board"
          description="Zone × Deliverable task matrix across projects — risk indicators highlight overdue, at-risk, and stale tasks"
        />
      )}

      {/* View tabs — emphasized so it's unmistakably a tab bar: each tab is a
          rounded-top pill that "sits on" the divider; the active one is filled
          blue with a heavier underline, inactive ones reveal a grey fill on
          hover. */}
      <div className="border-b border-slate-200">
        <div className="flex gap-1.5 flex-nowrap overflow-x-auto">
          {([
            { key: 'matrix', label: 'Matrix', sub: 'Zone × Deliverable' },
            { key: 'status', label: 'Status Board', sub: 'Project × Deliverable' },
            { key: 'tasks', label: 'Task Board', sub: 'Project × Task' },
            { key: 'zone-tasks', label: 'Zone Tasks', sub: 'Zone × Task' },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setViewMode(t.key)}
              className={cn(
                '-mb-px rounded-t-lg border border-b-2 px-4 py-2.5 text-sm font-bold transition-colors shrink-0 whitespace-nowrap',
                viewMode === t.key
                  ? 'border-slate-200 border-b-blue-600 bg-blue-50 text-blue-700'
                  : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800',
              )}
            >
              {t.label}
              <span className={cn('ml-2 text-[11px] font-medium', viewMode === t.key ? 'text-blue-500' : 'text-slate-400')}>
                {t.sub}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {/* Project selector hidden when locked to a specific project. */}
        {forcedProjectId == null && (
          // Multi-select per #57. Options come from data.projects (the
          // backend's project list — full set when forcedProjectId is null,
          // which is exactly this branch). When empty = all projects.
          <MultiSelectFilter
            options={(data?.projects ?? []).map((p) => ({
              value: p.id,
              label: p.name,
              hint: p.number ?? undefined,
            }))}
            selected={projectIds}
            onChange={(next) => {
              setProjectIds(next);
              didAutoExpand.current = false;
            }}
            placeholder="Projects"
            title="Filter by project"
            triggerClassName="w-64"
          />
        )}
        {/* Service (Phase) multi-select — narrows the board to tasks
            belonging to any of the selected Services. Resolved via
            getTaskServiceName so it honors the project-owned deliverable's
            service link first. Ordered Project → Service → Deliverable
            (#51); multi-select per #50. */}
        <MultiSelectFilter
          options={availablePhases.map((name) => ({ value: name, label: name }))}
          selected={phaseFilter}
          onChange={setPhaseFilter}
          placeholder="Services"
          title="Filter by service"
        />

        {/* Deliverable multi-select — the small pill under each column
            header. Picking some narrows the matrix to columns whose
            deliverable is in the selection. */}
        <MultiSelectFilter
          options={availableServices.map((name) => ({ value: name, label: name }))}
          selected={serviceFilter}
          onChange={setServiceFilter}
          placeholder="Deliverables"
          title="Filter by deliverable"
        />

        {/* General task-status filter — applies across all three views. */}
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent"
          title="Filter by task status"
        >
          <option value="">All Statuses</option>
          {['not_started', 'in_progress', 'in_review', 'completed', 'on_hold', 'cancelled'].map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>
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

        {/* Collapse All used to live here. It only makes sense for views
            with collapsible zones (Matrix + Zone Tasks), so it now lives
            inside their Zone column header — see below. The button hides
            naturally on Status / Task Board (no Zone header). */}
        {(serviceFilter.size > 0 || dueFrom || dueTo || onlyWithDue || statusFilter || phaseFilter.size > 0) && (
          <button
            type="button"
            onClick={() => { setServiceFilter(new Set()); setDueFrom(''); setDueTo(''); setOnlyWithDue(false); setStatusFilter(''); setPhaseFilter(new Set()); }}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-semibold text-slate-700 hover:border-slate-400"
            title="Clear all filters"
          >
            Clear filters
          </button>
        )}

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
      ) : viewMode === 'status' ? (
        // V8 — Status Board view. Project × Deliverable matrix with
        // completion-percentage cells. Reuses the page's filter state
        // (projectId, serviceFilter) so swapping views respects active
        // filters. Each cell color-codes by completion: green ≥ 100%,
        // amber 1–99%, slate-empty otherwise.
        <ExecutionStatusBoard
          tasks={filteredTasks as any[]}
          projects={data!.projects as any[]}
          forcedProjectId={forcedProjectId}
        />
      ) : viewMode === 'tasks' ? (
        // Task Board view. Same Project × Deliverable layout as the Status
        // Board, but each cell lists the actual task TITLES as status-colored
        // chips (click → task drawer) instead of an aggregate %. Shares the
        // page filter state so swapping views respects active filters.
        <ExecutionTaskBoard
          tasks={filteredTasks as any[]}
          projects={data!.projects as any[]}
          forcedProjectId={forcedProjectId}
          onOpenTask={(id) => setDrawerTaskId(id)}
        />
      ) : viewMode === 'zone-tasks' ? (
        // Zone Tasks view. Rendered inline (not as a separate component) so it
        // can reuse the Matrix's exact zone hierarchy — same visibleFlatRows
        // (project headers + nested zone rows + expand/collapse), same depth
        // indentation, same chevron behavior. Column model mirrors the Task
        // Board (Deliverable ▸ Task code+name with a two-row header); cells
        // show the matching task's status pill via TaskStatusCell.
        (() => {
          const resolveDeliverable = (t: any): string => getTaskPhaseName(t) ?? 'No Deliverable';
          const taskKeyOf = (t: any): string => `${t.code ?? ''}||${t.name ?? ''}`;

          // Build column model (deliverable → distinct tasks across all rows).
          const groupCols = new Map<string, Map<string, { code: string; name: string }>>();
          for (const t of filteredTasks as any[]) {
            const d = resolveDeliverable(t);
            const tk = taskKeyOf(t);
            if (!groupCols.has(d)) groupCols.set(d, new Map());
            if (!groupCols.get(d)!.has(tk)) groupCols.get(d)!.set(tk, { code: t.code ?? '', name: t.name ?? '' });
          }
          const zoneGroups = Array.from(groupCols.entries())
            .sort((a, b) => (a[0] === 'No Deliverable' ? 1 : b[0] === 'No Deliverable' ? -1 : a[0].localeCompare(b[0])))
            .map(([deliverable, colMap]) => ({
              deliverable,
              cols: Array.from(colMap.entries())
                .map(([key, v]) => ({ key, code: v.code, name: v.name }))
                .sort((x, y) => (x.code || x.name).localeCompare(y.code || y.name)),
            }));
          const zoneTotalCols = zoneGroups.reduce((s, g) => s + g.cols.length, 0);

          // Cell map: aggregating self-tasks PLUS descendants so a parent zone
          // row shows the union of its children's tasks per column (matches the
          // Matrix's aggregation semantics).
          const zoneCells = new Map<string, any[]>(); // `${zoneId}|${deliverable}|${taskKey}` → instances
          for (const t of filteredTasks as any[]) {
            const zid = t.zone?.id ?? (-(t.projectId ?? 0)); // mirror "synthetic root row id = -projectId"
            const k = `${zid}|${resolveDeliverable(t)}|${taskKeyOf(t)}`;
            if (!zoneCells.has(k)) zoneCells.set(k, []);
            zoneCells.get(k)!.push(t);
          }
          const cellFor = (rowId: number, deliverable: string, taskKey: string): any[] => {
            const ids = zoneDescendants.get(rowId) ?? [rowId];
            const out: any[] = [];
            for (const id of ids) {
              const arr = zoneCells.get(`${id}|${deliverable}|${taskKey}`);
              if (arr) out.push(...arr);
            }
            // Root rows (id < 0) aren't in zoneDescendants; fall back to the
            // direct lookup so root tasks still appear.
            if (rowId < 0 && ids.length === 1 && ids[0] === rowId) {
              const arr = zoneCells.get(`${rowId}|${deliverable}|${taskKey}`);
              if (arr) out.push(...arr);
            }
            // Dedupe (a task could be picked up twice if both fallback paths fire).
            return Array.from(new Map(out.map((t) => [t.id, t])).values());
          };
          // One uniform vertical grid line between every column — the
          // deliverable grouping is already conveyed by the header row 1
          // spanning each deliverable name across its task columns + its
          // slate background, so layering bold-vs-thin lines here just read
          // as inconsistency. (`ci` is kept in the signature for symmetry
          // with future per-column customisation.)
          const leafBorder = (_ci: number) => 'border-l border-slate-300';

          return zoneTotalCols === 0 || visibleFlatRows.length === 0 ? (
            <div className="rounded-[14px] border border-slate-200 bg-white py-12 text-center text-sm text-slate-400 italic">
              No tasks to display. Try clearing filters or adding tasks under a Deliverable.
            </div>
          ) : (
            <div className="rounded-[14px] border border-slate-200 bg-white overflow-x-auto">
              <table className="w-max text-[12px] border-collapse">
                <thead>
                  <tr className="bg-slate-200/80 text-[11px] uppercase tracking-wider text-slate-800">
                    <th
                      rowSpan={2}
                      className="sticky left-0 top-0 z-30 bg-slate-200/80 px-4 py-2.5 text-left font-bold text-slate-700 min-w-[300px] border-r border-slate-300"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span>Zone</span>
                        <button
                          type="button"
                          onClick={() => { setExpandedZones(new Set()); setExpandedIds(new Set()); }}
                          disabled={expandedZones.size === 0 && expandedIds.size === 0}
                          className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700 normal-case tracking-normal hover:border-slate-400 disabled:opacity-40 disabled:cursor-not-allowed"
                          title="Collapse every zone / sub-zone"
                        >
                          Collapse All
                        </button>
                      </div>
                    </th>
                    {zoneGroups.map((g) => (
                      <th
                        key={g.deliverable}
                        colSpan={g.cols.length}
                        className="sticky top-0 z-20 bg-slate-200/80 px-3 py-2 text-center font-extrabold text-slate-800 border-l border-slate-300"
                        title={g.deliverable}
                      >
                        <span className="block truncate">{g.deliverable}</span>
                      </th>
                    ))}
                  </tr>
                  <tr className="bg-white text-[10px] text-slate-700">
                    {zoneGroups.map((g) =>
                      g.cols.map((c, ci) => (
                        <th
                          key={`${g.deliverable}|${c.key}`}
                          className={cn(
                            'sticky top-[40px] z-20 bg-white px-2 py-2 text-left align-bottom min-w-[110px] max-w-[200px] border-b border-slate-200',
                            leafBorder(ci),
                          )}
                          title={`${c.code ? c.code + ' · ' : ''}${c.name}`}
                        >
                          {c.code && <span className="block font-mono text-[9px] text-slate-500 truncate">{c.code}</span>}
                          <span className="block truncate normal-case font-semibold text-slate-700">{c.name}</span>
                        </th>
                      )),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {visibleFlatRows.map((row) => {
                    if (row.type === 'project') {
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
                            colSpan={zoneTotalCols + 1}
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
                    const zc = ZONE_COLORS[row.zoneType ?? ''] ?? ZONE_COLORS.zone;
                    const anyExpanded = expandedZones.has(row.id) || (row.hasChildren && expandedIds.has(row.key));
                    const expandFully = () => {
                      toggleZoneExpand(row.id);
                      if (row.hasChildren) toggleExpand(row.key);
                    };
                    return (
                      <tr
                        key={row.key}
                        className="group border-t border-slate-100 hover:bg-blue-50/50 transition-colors"
                      >
                        <td
                          className={cn(
                            'sticky left-0 z-10 bg-white group-hover:bg-blue-100/70 px-4 py-2 border-r border-slate-300 border-l-[3px] cursor-pointer transition-colors',
                            zc.border,
                          )}
                          onClick={expandFully}
                          aria-label={anyExpanded ? 'Collapse this zone' : 'Expand this zone'}
                        >
                          <div
                            className="flex items-center gap-1.5"
                            style={{ paddingLeft: `${row.depth * 20}px` }}
                          >
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
                        {zoneGroups.map((g) =>
                          g.cols.map((c, ci) => (
                            <td
                              key={`${g.deliverable}|${c.key}`}
                              className={cn('px-2 py-1.5 text-center align-top border-b border-slate-200', leafBorder(ci))}
                            >
                              <TaskStatusCell tasks={cellFor(row.id, g.deliverable, c.key)} onOpenTask={(id) => setDrawerTaskId(id)} />
                            </td>
                          )),
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })()
      ) : (
        <div className="rounded-[14px] border border-slate-200 bg-white overflow-x-auto">
            {/* w-max + min-w-full: grow to content (so column min-widths are
                respected and the container scrolls horizontally) but still
                fill the width when there are only a few columns. */}
            <table className="w-max min-w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="sticky top-0 left-0 z-30 bg-slate-50 px-4 py-2.5 text-left font-semibold min-w-[300px] border-r border-b border-slate-200">
                    <div className="flex items-center justify-between gap-2">
                      <span>Zone</span>
                      <button
                        type="button"
                        onClick={() => { setExpandedZones(new Set()); setExpandedIds(new Set()); }}
                        disabled={expandedZones.size === 0 && expandedIds.size === 0}
                        className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700 normal-case tracking-normal hover:border-slate-400 disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Collapse every zone / sub-zone"
                      >
                        Collapse All
                      </button>
                    </div>
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
                {visibleFlatRows.map((row) => {
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
                      ref={(el) => { rowRefs.current.set(row.id, el); }}
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
                        // Root rows pull directTasks from the dedicated map,
                        // not the matrix (matrix is keyed by real zoneId only).
                        const directTasks =
                          row.id < 0
                            ? rootTasksByProject.get(-row.id)?.get(phaseName) ?? []
                            : directMatrix.get(`${row.id}|${phaseName}`) ?? [];
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
                            const directTasks =
                              row.id < 0
                                ? rootTasksByProject.get(-row.id)?.get('__none__') ?? []
                                : directMatrix.get(`${row.id}|__none__`) ?? [];
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

      <TaskDrawer taskId={drawerTaskId} onClose={closeDrawer} />
    </div>
  );
}

/**
 * V8 — Status Board view inside Execution Board.
 *
 * Renders a Project × Deliverable matrix. Each cell shows the
 * completion ratio of tasks belonging to that (project, deliverable)
 * pair: green when ≥ 100% complete, amber when partially complete,
 * empty/slate when no tasks. Tooltip on hover shows the raw "N of M
 * done" count.
 *
 * Reads from the already-filtered `tasks` list so the page's active
 * filters (project, service, due date) apply transparently. Columns
 * are derived from whatever deliverables appear in those filtered
 * tasks — admins don't manage a separate column catalog for this view.
 */
function ExecutionStatusBoard({
  tasks,
  projects,
  forcedProjectId,
}: {
  tasks: any[];
  projects: any[];
  forcedProjectId?: number;
}) {
  // Resolve a task's Deliverable label with the SINGLE canonical resolver
  // (getTaskPhaseName) so the status board columns line up exactly with the
  // matrix board, the filter dropdown, and the project task table. Tasks
  // with no deliverable signal fall into "No Deliverable".
  const resolveDeliverable = (t: any): string => getTaskPhaseName(t) ?? 'No Deliverable';

  // Build (projectId, deliverable) → { done, total } from filtered tasks.
  const cells = new Map<string, { done: number; total: number }>();
  const deliverableSet = new Set<string>();
  const projectIdsWithTasks = new Set<number>();
  for (const t of tasks) {
    const pid = t.projectId;
    if (pid == null) continue;
    projectIdsWithTasks.add(pid);
    const d = resolveDeliverable(t);
    deliverableSet.add(d);
    const key = `${pid}|${d}`;
    if (!cells.has(key)) cells.set(key, { done: 0, total: 0 });
    const cell = cells.get(key)!;
    cell.total += 1;
    if (t.status === 'completed') cell.done += 1;
  }

  // Sort columns alphabetically with "No Deliverable" last.
  const deliverables = Array.from(deliverableSet).sort((a, b) => {
    if (a === 'No Deliverable') return 1;
    if (b === 'No Deliverable') return -1;
    return a.localeCompare(b);
  });

  // Restrict rows to projects that (a) have tasks in scope and (b) are
  // not filtered out by forcedProjectId. Projects with zero in-scope
  // tasks are dropped to keep the board readable — consistent with
  // F2's hide-empty-rows behaviour on the matrix view.
  const visibleProjects = (projects ?? []).filter((p) =>
    projectIdsWithTasks.has(p.id) && (forcedProjectId == null || p.id === forcedProjectId),
  );

  if (visibleProjects.length === 0 || deliverables.length === 0) {
    return (
      <div className="rounded-[14px] border border-slate-200 bg-white py-12 text-center text-sm text-slate-400 italic">
        No data to display on the Status Board. Try clearing filters or adding tasks under a Deliverable.
      </div>
    );
  }

  return (
    <div className="rounded-[14px] border border-slate-200 bg-white overflow-x-auto">
      <table className="w-max min-w-full text-[12px]">
        <thead className="bg-slate-50 text-[10px] uppercase text-slate-500 tracking-wider">
          <tr>
            <th className="sticky left-0 z-10 bg-slate-50 px-4 py-2.5 text-left font-semibold min-w-[240px] border-r border-slate-200">
              Project
            </th>
            {deliverables.map((d) => (
              <th key={d} className="px-3 py-2.5 text-center font-semibold min-w-[140px]" title={d}>
                <span className="block truncate">{d}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {visibleProjects.map((p, idx) => (
            <tr key={p.id} className={cn(idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/30')}>
              <td className={cn(
                'sticky left-0 z-10 px-4 py-2 border-r border-slate-200',
                idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/30',
              )}>
                <div className="font-medium text-slate-800 truncate max-w-[220px]" title={p.name}>{p.name}</div>
                {p.number && <div className="text-[10px] font-mono text-slate-400">{p.number}</div>}
              </td>
              {deliverables.map((d) => {
                const cell = cells.get(`${p.id}|${d}`);
                if (!cell || cell.total === 0) {
                  return <td key={d} className="px-3 py-2 text-center text-slate-300">—</td>;
                }
                const pct = cell.total > 0 ? Math.round((cell.done / cell.total) * 100) : 0;
                const tone = pct >= 100 ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
                  : pct > 0 ? 'bg-amber-100 text-amber-700 border-amber-300'
                  : 'bg-slate-100 text-slate-500 border-slate-200';
                return (
                  <td key={d} className="px-3 py-2 text-center">
                    <div
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold tabular-nums',
                        tone,
                      )}
                      title={`${cell.done} of ${cell.total} tasks completed`}
                    >
                      <span>{cell.done}/{cell.total}</span>
                      <span className="text-[10px] opacity-75">· {pct}%</span>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Task Board view — Project (rows) × Task (columns) with a three-level column
 * header: Deliverable ▸ Zone ▸ Task (code + name). Each leaf column is one
 * task in one zone, so the cell shows a single task's STATUS (no cross-zone
 * aggregation). Clicking a cell opens that task's drawer. Uses the same
 * canonical deliverable resolver (getTaskPhaseName) as every other surface.
 */
function ExecutionTaskBoard({
  tasks,
  projects,
  forcedProjectId,
  onOpenTask,
}: {
  tasks: any[];
  projects: any[];
  forcedProjectId?: number;
  onOpenTask: (id: number) => void;
}) {
  const resolveDeliverable = (t: any): string => getTaskPhaseName(t) ?? 'No Deliverable';
  const zoneNameOf = (t: any): string => t.zone?.name ?? 'Project Root';
  const taskKeyOf = (t: any): string => `${t.code ?? ''}||${t.name ?? ''}`;

  // deliverable → zone → task column. Cells keyed by
  // (project|deliverable|zone|taskKey) → instances (normally one).
  const tree = new Map<string, Map<string, Map<string, { code: string; name: string }>>>();
  const cells = new Map<string, any[]>();
  const projectIdsWithTasks = new Set<number>();
  for (const t of tasks) {
    const pid = t.projectId;
    if (pid == null) continue;
    projectIdsWithTasks.add(pid);
    const d = resolveDeliverable(t);
    const z = zoneNameOf(t);
    const tk = taskKeyOf(t);
    if (!tree.has(d)) tree.set(d, new Map());
    if (!tree.get(d)!.has(z)) tree.get(d)!.set(z, new Map());
    if (!tree.get(d)!.get(z)!.has(tk)) tree.get(d)!.get(z)!.set(tk, { code: t.code ?? '', name: t.name ?? '' });
    const ck = `${pid}|${d}|${z}|${tk}`;
    if (!cells.has(ck)) cells.set(ck, []);
    cells.get(ck)!.push(t);
  }

  // Order: deliverables alpha (No Deliverable last); zones alpha (Project Root
  // last); tasks by code then name.
  const groups = Array.from(tree.entries())
    .sort((a, b) => (a[0] === 'No Deliverable' ? 1 : b[0] === 'No Deliverable' ? -1 : a[0].localeCompare(b[0])))
    .map(([deliverable, zoneMap]) => {
      const zones = Array.from(zoneMap.entries())
        .sort((a, b) => (a[0] === 'Project Root' ? 1 : b[0] === 'Project Root' ? -1 : a[0].localeCompare(b[0])))
        .map(([zoneName, colMap]) => ({
          zoneName,
          cols: Array.from(colMap.entries())
            .map(([key, v]) => ({ key, code: v.code, name: v.name }))
            .sort((x, y) => (x.code || x.name).localeCompare(y.code || y.name)),
        }));
      const colCount = zones.reduce((s, z) => s + z.cols.length, 0);
      return { deliverable, zones, colCount };
    });

  const totalCols = groups.reduce((s, g) => s + g.colCount, 0);

  const visibleProjects = (projects ?? []).filter((p) =>
    projectIdsWithTasks.has(p.id) && (forcedProjectId == null || p.id === forcedProjectId),
  );

  if (visibleProjects.length === 0 || totalCols === 0) {
    return (
      <div className="rounded-[14px] border border-slate-200 bg-white py-12 text-center text-sm text-slate-400 italic">
        No tasks to display. Try clearing filters or adding tasks under a Deliverable.
      </div>
    );
  }

  // Left-border weight for a leaf column: thick at each deliverable start,
  // light at each (non-first) zone start, none between tasks of a zone.
  const leafBorder = (zoneIdx: number, colIdx: number) =>
    zoneIdx === 0 && colIdx === 0 ? 'border-l-2 border-slate-300'
    : colIdx === 0 ? 'border-l border-slate-200'
    : '';

  return (
    // w-max (no min-w-full): the table is sized to its content, so when only a
    // few columns are in scope they stay content-width instead of stretching
    // to fill; when there are many it overflows and the container scrolls.
    <div className="rounded-[14px] border border-slate-200 bg-white overflow-x-auto">
      <table className="w-max text-[12px] border-collapse">
        <thead>
          {/* Row 1 — deliverable group headers. */}
          <tr className="bg-slate-200/80 text-[11px] uppercase tracking-wider text-slate-800">
            <th
              rowSpan={3}
              className="sticky left-0 z-20 bg-slate-200/80 px-3 py-2.5 text-left font-bold text-slate-700 w-[160px] min-w-[140px] max-w-[200px] border-r border-slate-300"
            >
              Project
            </th>
            {groups.map((g) => (
              <th
                key={g.deliverable}
                colSpan={g.colCount}
                className="px-3 py-2 text-center font-extrabold text-slate-800 border-l-2 border-slate-300"
                title={g.deliverable}
              >
                <span className="block truncate">{g.deliverable}</span>
              </th>
            ))}
          </tr>
          {/* Row 2 — zone sub-headers under each deliverable. */}
          <tr className="bg-slate-100 text-[10px] uppercase tracking-wider text-slate-700">
            {groups.map((g) =>
              g.zones.map((z, zi) => (
                <th
                  key={`${g.deliverable}|${z.zoneName}`}
                  colSpan={z.cols.length}
                  className={cn(
                    'px-2 py-1.5 text-center font-bold text-slate-700',
                    zi === 0 ? 'border-l-2 border-slate-300' : 'border-l border-slate-200',
                  )}
                  title={z.zoneName}
                >
                  <span className="block truncate normal-case">{z.zoneName}</span>
                </th>
              )),
            )}
          </tr>
          {/* Row 3 — individual task columns (code + name). White so the task
              headers pop against the grey deliverable/zone group rows. */}
          <tr className="bg-white text-[10px] text-slate-700">
            {groups.map((g) =>
              g.zones.map((z, zi) =>
                z.cols.map((c, ci) => (
                  <th
                    key={`${g.deliverable}|${z.zoneName}|${c.key}`}
                    className={cn(
                      'px-2 py-2 text-left align-bottom min-w-[96px] max-w-[200px] border-b border-slate-200',
                      leafBorder(zi, ci),
                    )}
                    title={`${c.code ? c.code + ' · ' : ''}${c.name}`}
                  >
                    {c.code && <span className="block font-mono text-[9px] text-slate-500 truncate">{c.code}</span>}
                    <span className="block truncate normal-case font-semibold text-slate-700">{c.name}</span>
                  </th>
                )),
              ),
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {visibleProjects.map((p, idx) => (
            <tr key={p.id} className={cn(idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/30')}>
              <td className={cn(
                'sticky left-0 z-10 px-3 py-2 border-r border-slate-300 align-top',
                idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/30',
              )}>
                <div className="font-semibold text-slate-800 truncate max-w-[180px]" title={p.name}>{p.name}</div>
                {p.number && <div className="text-[10px] font-mono text-slate-500">{p.number}</div>}
              </td>
              {groups.map((g) =>
                g.zones.map((z, zi) =>
                  z.cols.map((c, ci) => {
                    const inst = cells.get(`${p.id}|${g.deliverable}|${z.zoneName}|${c.key}`) ?? [];
                    return (
                      <td
                        key={`${g.deliverable}|${z.zoneName}|${c.key}`}
                        className={cn('px-2 py-2 text-center align-top', leafBorder(zi, ci))}
                      >
                        <TaskStatusCell tasks={inst} onOpenTask={onOpenTask} />
                      </td>
                    );
                  }),
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Status "advancement" ordering — used to pick the worst (least-advanced)
// status when a task column aggregates several zone instances.
const STATUS_ADVANCE: Record<string, number> = {
  not_started: 0, on_hold: 1, in_progress: 2, in_review: 3, completed: 4, cancelled: 5,
};

/**
 * One Task Board cell — the status of a task for a project. When the task has
 * multiple zone instances, shows the WORST (least-advanced) status plus a
 * done/total count, and colors by the worst health (overdue/at-risk) across
 * instances. Clicking opens the worst instance's drawer.
 */
function TaskStatusCell({ tasks, onOpenTask }: { tasks: any[]; onOpenTask: (id: number) => void }) {
  if (tasks.length === 0) return <span className="text-slate-300">—</span>;

  // Worst (least-advanced) instance for the displayed status + drawer target.
  let worst = tasks[0];
  for (const t of tasks) {
    if ((STATUS_ADVANCE[t.status] ?? 0) < (STATUS_ADVANCE[worst.status] ?? 0)) worst = t;
  }
  const done = tasks.filter((t) => t.status === 'completed').length;
  const allDone = done === tasks.length;
  const displayStatus = allDone ? 'completed' : worst.status;

  const anyCritical = tasks.some((t) => getTaskHealth(t).level === 'critical');
  const anyWarning = tasks.some((t) => getTaskHealth(t).level === 'warning');
  const tone = anyCritical ? 'bg-red-100 text-red-700 border-red-300 hover:bg-red-200'
    : anyWarning ? 'bg-amber-100 text-amber-700 border-amber-300 hover:bg-amber-200'
    : displayStatus === 'completed' ? 'bg-emerald-100 text-emerald-700 border-emerald-300 hover:bg-emerald-200'
    : displayStatus === 'in_progress' ? 'bg-blue-100 text-blue-700 border-blue-300 hover:bg-blue-200'
    : displayStatus === 'in_review' ? 'bg-violet-100 text-violet-700 border-violet-300 hover:bg-violet-200'
    : 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200';

  const title = tasks.length > 1
    ? `${tasks.length} instances across zones — ${done}/${tasks.length} completed`
    : (worst.zone?.name ? `Zone: ${worst.zone.name}` : 'Project Root');

  return (
    <button
      type="button"
      onClick={() => onOpenTask(worst.id)}
      title={title}
      className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors', tone)}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', STATUS_DOT[displayStatus] ?? 'bg-slate-400')} />
      <span>{STATUS_LABEL[displayStatus] ?? displayStatus}</span>
      {tasks.length > 1 && (
        <span className="font-normal normal-case opacity-70 tabular-nums">· {done}/{tasks.length}</span>
      )}
    </button>
  );
}

