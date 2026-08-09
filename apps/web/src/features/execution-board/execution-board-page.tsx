import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { ChevronRight, Grid3X3, FolderKanban, MapPin, AlertTriangle, AlertCircle, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { TaskDrawer } from '@/features/tasks/task-drawer';
import { useDrawerRoute } from '@/components/nav/use-drawer-route';
import { MultiSelectFilter } from '@/components/shared/multi-select-filter';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';
import { useMe } from '@/hooks/use-auth';
import { getTaskHealth, type TaskHealth } from '@/lib/task-health';
import { STATUS_LABEL } from '@/lib/task-constants';
import { cn } from '@/lib/utils';
import { getTaskPhaseName, getTaskServiceName } from './execution-board.util';
import type { Task, ZoneNode, FlatRow } from './parts/types';
import { ZONE_COLORS, PROJECT_COLORS } from './parts/constants';
import { useExecutionBoard } from './parts/use-execution-board';
import { HealthBadge } from './parts/health-badge';
import { CellSummary } from './parts/cell-summary';
import { TaskCard } from './parts/task-card';
import { TaskStatusCell } from './parts/task-status-cell';

// STATUS_DOT, STATUS_PILL, STATUS_LABEL imported from '@/lib/task-constants'

export function ExecutionBoardPage({ forcedProjectId }: { forcedProjectId?: number } = {}) {
  // One sticky-h-scroll ref per inline table view (Matrix and Zone Tasks).
  // Only one is rendered at a time (the view tab switch unmounts the
  // other), so we don't worry about ref collisions.
  const matrixScrollRef = useStickyHScroll();
  const zoneTasksScrollRef = useStickyHScroll();
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
  // Status Board + Task Board removed per client meeting 2026-08-04 —
  // Amit flagged them as no longer relevant. Kept the union tight so
  // any stale reference is a compile error, not a silent no-op.
  const [viewMode, setViewMode] = useState<'matrix' | 'zone-tasks'>('matrix');
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
  // Once the user changes the Service filter, stop overriding it with the
  // Zone Tasks view's department default (Ops backlog #3, 2026-08-08).
  // Reset to false only when the user explicitly clears filters — see
  // "Clear filters" below.
  const [phaseFilterTouched, setPhaseFilterTouched] = useState(false);
  const setPhaseFilterUserPick = useCallback((next: Set<string>) => {
    setPhaseFilterTouched(true);
    setPhaseFilter(next);
  }, []);
  const didAutoExpand = useRef(false);
  // Current user (department drives the Zone Tasks default Service filter).
  const { data: me } = useMe();

  // Don't pass serviceId to the server anymore; we filter client-side.
  // For projectId, pass the forcedProjectId only (embedded mode); the
  // multi-select filter is client-side so the API always returns the
  // user's full project list — that way the multi-select options stay
  // populated regardless of how many are selected.
  //
  // isError / error / refetch drive the retryable error state — a
  // failed fetch used to render as a silent EmptyState "no data",
  // indistinguishable from an actual empty project set.
  const { data, isLoading, isError, error, refetch, isFetching } = useExecutionBoard(forcedProjectId ?? null, null);

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
      void viewMode; // referenced below via the status-filter guard
      // Project multi-select: empty set = no filter (all projects). Otherwise
      // the task must belong to one of the selected projects. This filter
      // used to be missing entirely — tasks flowed through unfiltered and
      // every downstream view (Status / Task / Matrix / Zone Tasks) showed
      // all projects regardless of selection (bug, 2026-06-21).
      if (projectIds.size > 0 && !projectIds.has(t.projectId)) return false;
      // Status filter is removed from the Zone Tasks view (Ops backlog
      // #3(b), 2026-08-08). Skip it there even if a stale value lingers
      // from switching from Matrix view.
      if (viewMode !== 'zone-tasks' && statusFilter && t.status !== statusFilter) return false;
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
  }, [data?.tasks, projectIds, serviceFilter, dueFrom, dueTo, onlyWithDue, statusFilter, phaseFilter, deliverableNameToService, viewMode]);

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

  // Aggregated-task lookup, keyed `${zoneId}|${phaseName}`. Built once
  // per data change (used to be a per-cell useCallback that walked
  // zoneDescendants + directMatrix on EVERY render — rows × columns
  // times, plus a fresh array allocation per cell).
  //
  // Coverage:
  //   • real zones — one entry per (zone in tree, phaseName seen among
  //     descendants), unioned from the descendant leaves.
  //   • synthetic 'Project Root' rows (id = -projectId) — mirrored from
  //     rootTasksByProject using the negative-id convention flatRows
  //     emits for those synthetic rows.
  const aggregatedTasksByKey = useMemo(() => {
    // Pre-index directMatrix by leafZoneId so the union-per-phase step
    // touches each leaf O(1) instead of scanning directMatrix per key.
    const leafToPhaseTasks = new Map<number, Map<string, Task[]>>();
    for (const [key, tasks] of directMatrix.entries()) {
      const sep = key.indexOf('|');
      if (sep < 0) continue;
      const leafId = Number(key.slice(0, sep));
      const phaseName = key.slice(sep + 1);
      if (!leafToPhaseTasks.has(leafId)) leafToPhaseTasks.set(leafId, new Map());
      leafToPhaseTasks.get(leafId)!.set(phaseName, tasks);
    }

    const out = new Map<string, Task[]>();
    // Real zones — union descendant-leaf tasks per phase.
    for (const [zoneId, descIds] of zoneDescendants.entries()) {
      const perPhase = new Map<string, Task[]>();
      for (const id of descIds) {
        const phases = leafToPhaseTasks.get(id);
        if (!phases) continue;
        for (const [phaseName, tasks] of phases.entries()) {
          const existing = perPhase.get(phaseName);
          if (existing) existing.push(...tasks);
          // Copy the leaf array so appending onto `existing` in a later
          // iteration can't mutate directMatrix's stored arrays.
          else perPhase.set(phaseName, tasks.slice());
        }
      }
      for (const [phaseName, tasks] of perPhase.entries()) {
        out.set(`${zoneId}|${phaseName}`, tasks);
      }
    }
    // Synthetic 'Project Root' rows.
    for (const [pid, perPhase] of rootTasksByProject.entries()) {
      for (const [phaseName, tasks] of perPhase.entries()) {
        out.set(`${-pid}|${phaseName}`, tasks);
      }
    }
    return out;
  }, [zoneDescendants, directMatrix, rootTasksByProject]);

  // Cheap lookup — replaces the per-cell walker. Same signature as the
  // old function so call sites don't need to change.
  const getAggregatedTasks = useCallback(
    (zoneId: number, phaseName: string): Task[] =>
      aggregatedTasksByKey.get(`${zoneId}|${phaseName}`) ?? [],
    [aggregatedTasksByKey],
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

  // Zone Tasks view — preconfigure the Service filter to the current
  // user's DEPARTMENT service(s) by default (Ops backlog #3(a),
  // 2026-08-08). Matches user.department (free-text) against the
  // service names loaded on-screen (case-insensitive substring —
  // Department table doesn't link to Phase, so this is the best signal
  // we have without a schema change). Only fires when:
  //   • viewMode === 'zone-tasks'
  //   • the user hasn't already touched the Service filter (once
  //     they change it, we never override again)
  //   • the current filter is empty (no clobbering of the primary
  //     view's user picks)
  //   • the user has a department set
  //   • at least one service name matches
  useEffect(() => {
    if (viewMode !== 'zone-tasks') return;
    if (phaseFilterTouched) return;
    if (phaseFilter.size > 0) return;
    const dept = (me as any)?.department;
    if (!dept || typeof dept !== 'string' || !dept.trim()) return;
    const deptLower = dept.trim().toLowerCase();
    const matched = availablePhases.filter((name) =>
      name.toLowerCase().includes(deptLower) || deptLower.includes(name.toLowerCase()),
    );
    if (matched.length === 0) return;
    setPhaseFilter(new Set(matched));
    // Not marking as "touched" — this is a system-applied default, not
    // a user pick. The next user change flips the touched flag.
  }, [viewMode, phaseFilterTouched, phaseFilter, me, availablePhases]);

  // When any client-side filter is active, hide rows that have zero
  // tasks under any phase column. Without this the user picks a filter
  // (e.g. service = "BIM") and still sees every zone with empty cells
  // — exactly what F2 in the bug list called out.
  //
  // A row "has tasks" when at least one phase column returns a non-empty
  // aggregated-tasks list for it. Project rows are kept if any of their
  // child zones survive — collapsing/expanding still works because
  // expandedIds is unaffected.
  // Status filter is inactive on Zone Tasks — mirror the filteredTasks
  // guard so the "any filter active" check doesn't spuriously flip the
  // empty-row pruning on a stale status.
  const statusFilterActive = viewMode !== 'zone-tasks' && !!statusFilter;
  const isFilterActive = projectIds.size > 0 || serviceFilter.size > 0 || !!dueFrom || !!dueTo || onlyWithDue || statusFilterActive || phaseFilter.size > 0;
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

  // Palette lookup for the project-header row. Rebuilt only when the
  // project list changes; the previous version allocated a fresh Map on
  // every render (i.e., every keystroke in a filter input).
  const projectColorMapMemo = useMemo(() => {
    const map = new Map<number, (typeof PROJECT_COLORS)[0]>();
    (data?.projects ?? []).forEach((p, i) => map.set(p.id, PROJECT_COLORS[i % PROJECT_COLORS.length]));
    return map;
  }, [data?.projects]);

  if (isLoading) return <PageSkeleton />;

  // Fetch failed — surface the error with a Retry so the user isn't
  // staring at an empty matrix wondering whether they actually have
  // zero projects or the request just died. `isError` is React Query's
  // authoritative failure flag (any queryFn throw or 4xx/5xx after
  // retries are exhausted). Rendered inside the page shell so the tab
  // bar + filters stay in place if the user wants to change scope
  // before retrying.
  if (isError) {
    const msg = (error as any)?.response?.data?.message
      ?? (error as any)?.message
      ?? 'The execution board could not be loaded.';
    return (
      <div className="space-y-5">
        {forcedProjectId == null && (
          <PageHeader
            title="Execution Board"
            description="Zone × Deliverable task matrix across projects — risk indicators highlight overdue, at-risk, and stale tasks"
          />
        )}
        <div
          role="alert"
          className="rounded-[14px] border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-6 py-8 flex flex-col items-center text-center gap-3"
        >
          <AlertCircle className="h-8 w-8 text-red-500 dark:text-red-400" aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-red-800 dark:text-red-200">
              Failed to load the execution board
            </p>
            <p className="text-[12px] text-red-700 dark:text-red-300 max-w-md">{msg}</p>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-300 dark:border-red-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[13px] font-semibold text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/50 disabled:opacity-50"
            aria-label="Retry loading the execution board"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} aria-hidden="true" />
            {isFetching ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      </div>
    );
  }

  // Palette lookup for the project-header row background/border/icon.
  // Rebuilt only when the project list changes — was previously a fresh
  // Map on every render (allocating 6+ Map entries per keystroke).
  const projectColorMap = projectColorMapMemo;

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
      <div className="border-b border-slate-200 dark:border-slate-700">
        <div className="flex gap-1.5 flex-nowrap overflow-x-auto">
          {([
            { key: 'matrix', label: 'Matrix', sub: 'Zone × Deliverable' },
            { key: 'zone-tasks', label: 'Zone Tasks', sub: 'Zone × Task' },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setViewMode(t.key)}
              className={cn(
                '-mb-px rounded-t-lg border border-b-2 px-4 py-2.5 text-sm font-bold transition-colors shrink-0 whitespace-nowrap',
                viewMode === t.key
                  ? 'border-slate-200 dark:border-slate-700 border-b-blue-600 bg-blue-50 text-blue-700'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-100',
              )}
            >
              {t.label}
              <span className={cn('ml-2 text-[11px] font-medium', viewMode === t.key ? 'text-blue-500' : 'text-slate-400 dark:text-slate-500')}>
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
          onChange={setPhaseFilterUserPick}
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

        {/* General task-status filter — applies to Matrix only. Removed
            from Zone Tasks per Ops backlog #3(b): the view is redundant
            there since each cell already renders the task's status pill. */}
        {viewMode !== 'zone-tasks' && (
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
        )}

        {/* Due-date range + only-with-due toggle (#3.3). */}
        <div className="flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300">
          <span className="font-semibold uppercase text-[10px] tracking-wider text-slate-400 dark:text-slate-500">Due</span>
          <input
            type="date"
            value={dueFrom}
            onChange={(e) => setDueFrom(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-[12px]"
            title="Earliest due date"
          />
          <span className="text-slate-400 dark:text-slate-500">→</span>
          <input
            type="date"
            value={dueTo}
            onChange={(e) => setDueTo(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-[12px]"
            title="Latest due date"
          />
        </div>
        <label className="flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={onlyWithDue}
            onChange={(e) => setOnlyWithDue(e.target.checked)}
            className="rounded border-slate-300 dark:border-slate-600"
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
            onClick={() => {
              setServiceFilter(new Set());
              setDueFrom('');
              setDueTo('');
              setOnlyWithDue(false);
              setStatusFilter('');
              setPhaseFilter(new Set());
              // Reset the touched flag so the Zone Tasks department default
              // re-applies on the next render, matching a fresh visit.
              setPhaseFilterTouched(false);
            }}
            className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
            title="Clear all filters"
          >
            Clear filters
          </button>
        )}

        <div className="ml-auto flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
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
          const leafBorder = (_ci: number) => 'border-l border-slate-300 dark:border-slate-600';

          return zoneTotalCols === 0 || visibleFlatRows.length === 0 ? (
            <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-12 text-center text-sm text-slate-400 dark:text-slate-500 italic">
              No tasks to display. Try clearing filters or adding tasks under a Deliverable.
            </div>
          ) : (
            <div ref={zoneTasksScrollRef} className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
              <table className="w-max text-[12px] border-collapse">
                <thead>
                  <tr className="bg-slate-200/80 dark:bg-slate-700/80 text-[11px] uppercase tracking-wider text-slate-800 dark:text-slate-100">
                    <th
                      rowSpan={2}
                      className="sticky left-0 top-0 z-30 bg-slate-200/80 dark:bg-slate-700/80 px-4 py-2.5 text-left font-bold text-slate-700 dark:text-slate-200 min-w-[300px] border-r border-slate-300 dark:border-slate-600"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span>Zone</span>
                        <button
                          type="button"
                          onClick={() => { setExpandedZones(new Set()); setExpandedIds(new Set()); }}
                          disabled={expandedZones.size === 0 && expandedIds.size === 0}
                          className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-0.5 text-[10px] font-semibold text-slate-700 dark:text-slate-200 normal-case tracking-normal hover:border-slate-400 dark:hover:border-slate-500 disabled:opacity-40 disabled:cursor-not-allowed"
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
                        className="sticky top-0 z-20 bg-slate-200/80 dark:bg-slate-700/80 px-3 py-2 text-center font-extrabold text-slate-800 dark:text-slate-100 border-l border-slate-300 dark:border-slate-600"
                        title={g.deliverable}
                      >
                        <span className="block truncate">{g.deliverable}</span>
                      </th>
                    ))}
                  </tr>
                  <tr className="bg-white dark:bg-slate-900 text-[10px] text-slate-700 dark:text-slate-200">
                    {zoneGroups.map((g) =>
                      g.cols.map((c, ci) => (
                        <th
                          key={`${g.deliverable}|${c.key}`}
                          className={cn(
                            'sticky top-[40px] z-20 bg-white dark:bg-slate-900 px-2 py-2 text-left align-bottom min-w-[110px] max-w-[200px] border-b border-slate-200 dark:border-slate-700',
                            leafBorder(ci),
                          )}
                          title={`${c.code ? c.code + ' · ' : ''}${c.name}`}
                        >
                          {c.code && <span className="block font-mono text-[9px] text-slate-500 dark:text-slate-400 truncate">{c.code}</span>}
                          <span className="block truncate normal-case font-semibold text-slate-700 dark:text-slate-200">{c.name}</span>
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
                          className={cn('border-t border-slate-200 dark:border-slate-700 cursor-pointer hover:brightness-95 transition-all', pc.bg)}
                          onClick={() => toggleExpand(row.key)}
                        >
                          <td
                            className={cn('sticky left-0 z-10 px-0 py-2.5 border-r', pc.bg, pc.border)}
                            colSpan={zoneTotalCols + 1}
                          >
                            {/* Double-sticky: see comment on the Matrix view
                                project header. Inner div pins to viewport
                                left while the outer TD fills the colSpan. */}
                            <div className="sticky left-0 inline-flex items-center gap-2 px-4">
                              <ChevronRight
                                className={cn(
                                  'h-4 w-4 text-slate-400 dark:text-slate-500 transition-transform duration-150',
                                  expandedIds.has(row.key) && 'rotate-90',
                                )}
                              />
                              <FolderKanban className={cn('h-4 w-4', pc.icon)} />
                              <span className="font-semibold text-slate-700 dark:text-slate-200">{row.name}</span>
                              {row.number && (
                                <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium border', pc.border, 'text-slate-600 dark:text-slate-300 bg-white/60')}>
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
                        className="group border-t border-slate-100 dark:border-slate-800 hover:bg-blue-50/50 transition-colors"
                      >
                        <td
                          className={cn(
                            'relative sticky left-0 z-10 bg-white dark:bg-slate-900 group-hover:bg-blue-100/70 px-4 py-2 border-r border-slate-300 dark:border-slate-600 cursor-pointer transition-colors',
                          )}
                          onClick={expandFully}
                          aria-label={anyExpanded ? 'Collapse this zone' : 'Expand this zone'}
                        >
                          {/* Colored zone-accent stripe — painted as an
                              absolute overlay because `border-left` on a
                              sticky TD inside a border-collapse table
                              disappears once the user scrolls horizontally.
                              See ZONE_COLORS for the source of zc.bg. */}
                          <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', zc.bg)} />
                          <div
                            className="flex items-center gap-1.5"
                            style={{ paddingLeft: `${row.depth * 20}px` }}
                          >
                            <ChevronRight
                              className={cn(
                                'h-3.5 w-3.5 shrink-0 transition-transform duration-150',
                                anyExpanded ? 'rotate-90 text-blue-600' : 'text-slate-400 dark:text-slate-500',
                              )}
                            />
                            <span
                              className={cn(
                                'truncate text-[13px]',
                                row.hasChildren ? 'font-semibold text-slate-700 dark:text-slate-200' : 'text-slate-600 dark:text-slate-300',
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
                              className={cn('px-2 py-1.5 text-center align-top border-b border-slate-200 dark:border-slate-700', leafBorder(ci))}
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
        <div ref={matrixScrollRef} className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
            {/* w-max + min-w-full: grow to content (so column min-widths are
                respected and the container scrolls horizontally) but still
                fill the width when there are only a few columns. */}
            <table className="w-max min-w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/50 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="sticky top-0 left-0 z-30 bg-slate-50 dark:bg-slate-800/50 px-4 py-2.5 text-left font-semibold min-w-[300px] border-r border-b border-slate-200 dark:border-slate-700">
                    <div className="flex items-center justify-between gap-2">
                      <span>Zone</span>
                      <button
                        type="button"
                        onClick={() => { setExpandedZones(new Set()); setExpandedIds(new Set()); }}
                        disabled={expandedZones.size === 0 && expandedIds.size === 0}
                        className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-0.5 text-[10px] font-semibold text-slate-700 dark:text-slate-200 normal-case tracking-normal hover:border-slate-400 dark:hover:border-slate-500 disabled:opacity-40 disabled:cursor-not-allowed"
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
                        className="sticky top-0 z-20 bg-slate-50 dark:bg-slate-800/50 px-3 py-2 text-center font-semibold min-w-[200px] border-r border-b border-slate-100 dark:border-slate-800 last:border-r-0"
                      >
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="text-slate-700 dark:text-slate-200">{name}</span>
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
                            <span className="text-[9px] text-slate-500 dark:text-slate-400 normal-case tracking-normal">— no service —</span>
                          )}
                        </div>
                      </th>
                    );
                  })}
                  {hasNoPhase && (
                    <th className="sticky top-0 z-20 bg-slate-50 dark:bg-slate-800/50 px-3 py-2.5 text-center font-semibold min-w-[200px] text-slate-600 dark:text-slate-300 border-b border-slate-100 dark:border-slate-800">
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
                        className={cn('border-t border-slate-200 dark:border-slate-700 cursor-pointer hover:brightness-95 transition-all', pc.bg)}
                        onClick={() => toggleExpand(row.key)}
                      >
                        <td
                          className={cn('sticky left-0 z-10 px-0 py-2.5 border-r', pc.bg, pc.border)}
                          colSpan={totalCols}
                        >
                          {/* Wrap the content in its own `position: sticky; left:0`
                              layer so it stays pinned to the viewport's left
                              edge as the row scrolls horizontally. The outer
                              <td> uses colSpan to fill the full table width,
                              which means `sticky left:0` on it alone doesn't
                              keep the INNER text visible — sticky on the wide
                              TD only fixes the cell box, not its content. The
                              double-sticky pattern (td + inner div) is the
                              canonical fix for "row-header inside a wide
                              colSpan TD". (User feedback 2026-06-28.) */}
                          <div className="sticky left-0 inline-flex items-center gap-2 px-4">
                            <ChevronRight
                              className={cn(
                                'h-4 w-4 text-slate-400 dark:text-slate-500 transition-transform duration-150',
                                expandedIds.has(row.key) && 'rotate-90',
                              )}
                            />
                            <FolderKanban className={cn('h-4 w-4', pc.icon)} />
                            <span className="font-semibold text-slate-700 dark:text-slate-200">{row.name}</span>
                            {row.number && (
                              <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium border', pc.border, 'text-slate-600 dark:text-slate-300 bg-white/60')}>
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
                      className="group border-t border-slate-100 dark:border-slate-800 hover:bg-blue-50/50 transition-colors"
                    >
                      <td
                        className={cn(
                          // sticky-left cell defaults to bg-white dark:bg-slate-900 so it stays opaque
                          // when scrolled; group-hover paints it the same blue as the
                          // rest of the row so the whole line lights up together.
                          // `relative` anchors the zone-accent overlay span below.
                          'relative sticky left-0 z-10 bg-white dark:bg-slate-900 group-hover:bg-blue-100/70 px-4 py-2 border-r border-slate-200 dark:border-slate-700 cursor-pointer transition-colors',
                        )}
                        onClick={expandFully}
                        aria-label={anyExpanded ? 'Collapse this zone' : 'Expand this zone'}
                      >
                        {/* Colored zone-accent stripe — painted as an overlay
                            because `border-left` on a sticky TD inside a
                            border-collapse table disappears once the user
                            scrolls horizontally. */}
                        <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', zc.bg)} />
                        <div
                          className="flex items-center gap-1.5"
                          style={{ paddingLeft: `${row.depth * 20}px` }}
                        >
                          {/* Single combined chevron — rotates when either state is expanded. */}
                          <ChevronRight
                            className={cn(
                              'h-3.5 w-3.5 shrink-0 transition-transform duration-150',
                              anyExpanded ? 'rotate-90 text-blue-600' : 'text-slate-400 dark:text-slate-500',
                            )}
                          />
                          <span
                            className={cn(
                              'truncate text-[13px]',
                              row.hasChildren ? 'font-semibold text-slate-700 dark:text-slate-200' : 'text-slate-600 dark:text-slate-300',
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
                            className="px-2 py-1.5 align-top border-r border-slate-100 dark:border-slate-800 last:border-r-0"
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
