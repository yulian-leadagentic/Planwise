import { useState, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import { useProjectTabState } from './use-project-tab-state';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Calendar, CalendarClock, Save, RefreshCcw, Layers, LayoutGrid, GanttChart, AlertTriangle, ArrowUpDown, ChevronUp, ChevronDown, ChevronRight, Filter, Lock } from 'lucide-react';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { OpenInDriveButton } from '@/features/drive/open-in-drive-button';
import { MultiSelectFilter } from '@/components/shared/multi-select-filter';
import { EmptyState } from '@/components/shared/empty-state';
import { resolveTaskDeliverableDetailed } from '@/features/planning/resolve-task-deliverable';
import { GroupControl, dpGroupDimLabel, type DPGroupDim } from '@/features/planning/group-control';
import { ZONE_DISPLAY } from '@/features/templates/zone-templates/constants';
import { useDebounce } from '@/hooks/use-debounce';
import {
  hasPredecessorConflict,
  getPredecessorConflictMessage,
} from '@/features/projects/predecessor-conflict';

/**
 * DP-4 parity (2026-10-21) · Zone-type → badge-style map, mirroring the
 * Planning tab's `zoneColors` palette (planning-modal.tsx L3850-3858) so
 * the two surfaces read as the same object: amber for buildings, teal for
 * levels, purple for areas, etc. Values map directly to Tailwind utility
 * classes (bg + text) that compose the pill — dark-mode variants follow
 * the planwise-design status-pill spec
 * (`dark:bg-<color>-900/30 dark:text-<color>-300`), tuned down from the
 * initial 950/40 pass so the pill stays visible in dark mode without
 * drifting into "near-black" territory.
 *
 * Keys cover every value of the Prisma `ZoneType` enum. A zone whose
 * type lives outside this map (future enum values, missing data) renders
 * NO badge at all — the group header falls back to just the zone name
 * instead of a mystery "Zone" fallback pill that gets mistaken for the
 * amber one.
 */
const ZONE_TYPE_BADGE: Record<string, { bg: string; text: string }> = {
  site:    { bg: 'bg-indigo-50 dark:bg-indigo-900/30', text: 'text-indigo-700 dark:text-indigo-300' },
  building:{ bg: 'bg-amber-50 dark:bg-amber-900/30',   text: 'text-amber-700 dark:text-amber-300' },
  level:   { bg: 'bg-teal-50 dark:bg-teal-900/30',     text: 'text-teal-700 dark:text-teal-300' },
  zone:    { bg: 'bg-amber-50 dark:bg-amber-900/30',   text: 'text-amber-600 dark:text-amber-300' },
  area:    { bg: 'bg-purple-50 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-300' },
  floor:   { bg: 'bg-blue-50 dark:bg-blue-900/30',     text: 'text-blue-700 dark:text-blue-300' },
  section: { bg: 'bg-teal-50 dark:bg-teal-900/30',     text: 'text-teal-700 dark:text-teal-300' },
  wing:    { bg: 'bg-pink-50 dark:bg-pink-900/30',     text: 'text-pink-700 dark:text-pink-300' },
};

/**
 * UI-14 · Resolve a row's value under a given group dimension. Returns
 * both a stable string key (used for grouping / collapse-set membership)
 * and a human label (shown in the group header or sub-row). The key is
 * namespaced per-dim so a zoneId and a deliverableId can never collide
 * when the user flips the primary dim mid-session.
 *
 * DPG-1 (2026-10-20) · Zone grouping rolls up to the TOP-LEVEL ancestor
 * — rows carry `topLevelZoneId` + `topLevelZoneName` precomputed by the
 * parent (see `topLevelZoneInfo`), so a sub-zone row buckets under its
 * root zone instead of standing alone. `zoneId=null` rows (orphan root
 * tasks, no-zones projects) key to `zone:root` with label "Project Root".
 */
function rowDimKey(r: any, dim: DPGroupDim): string {
  if (dim === 'deliverable') return `del:${r.deliverableId}`;
  if (dim === 'zone') return `zone:${r.topLevelZoneId ?? 'root'}`;
  // service — Phase name is a string, nullable. Treat null/empty as a
  // dedicated "no service" bucket so rows don't get spread into the
  // default group silently.
  return `svc:${(r.serviceName ?? '').trim() || '(no service)'}`;
}
function rowDimLabel(r: any, dim: DPGroupDim): string {
  if (dim === 'deliverable') return r.deliverableName ?? `Deliverable #${r.deliverableId}`;
  if (dim === 'zone') return r.topLevelZoneName ?? '—';
  return (r.serviceName ?? '').trim() || 'No service';
}

/**
 * Zone-type label map (DP-4). Values mirror the `ZoneType` enum on the
 * schema (site/building/level/floor/zone/area/section/wing). Kept inline
 * here to avoid a shared-module edit that could conflict with the other
 * in-flight agent on this branch.
 */
const ZONE_TYPE_LABELS: Record<string, string> = {
  site: 'Site',
  building: 'Building',
  level: 'Level',
  floor: 'Floor',
  zone: 'Zone',
  area: 'Area',
  section: 'Section',
  wing: 'Wing',
};
const zoneTypeLabel = (type?: string | null): string =>
  (type && ZONE_TYPE_LABELS[type]) || ZONE_TYPE_LABELS.zone;

/**
 * §8e (2026-11-12) · Pure calendar-day shift on an ISO yyyy-mm-dd string.
 * Used by `DeliverableTasksModal` to cascade a single-row Due edit across
 * every sibling task AND the preview target picker (shift-whole-chain
 * semantic). Working-day / holiday arithmetic still happens server-side
 * via the dry-run — this helper only moves the user's typed anchor by
 * Δ calendar days so the shape of the chain follows the drag.
 *
 * Returns the input unchanged on empty/invalid dates so callers can
 * safely map over `drafts[t.id] ?? ''` without guarding each cell.
 */
function addDaysIso(iso: string, days: number): string {
  if (!iso) return iso;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * §8b.1 (2026-11-11) · Mount/unmount animation helper for the two
 * ad-hoc Dialogs in this file (Review modal + DeliverableTasksModal).
 * The DP tab doesn't use shadcn Dialog — modals here are plain
 * `fixed inset-0` overlays that conditionally render — so we drive
 * open/close animation via a `data-state` flip + a deferred unmount.
 *
 * On mount we render with state='closed' then flip to 'open' on the
 * next animation frame so the CSS transition fires; on close we flip
 * back to 'closed' and defer unmount by `exitMs`. OS-flagged users
 * (`prefers-reduced-motion`) get instant transitions via the
 * `motion-reduce:*` modifiers on the elements that consume the state.
 */
function useModalTransition(isOpen: boolean, exitMs = 150) {
  const [shouldRender, setShouldRender] = useState<boolean>(isOpen);
  const [dataState, setDataState] = useState<'open' | 'closed'>('closed');

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      // rAF so the DOM first paints with data-state=closed (opacity-0,
      // scale-98); the flip to 'open' on the next frame triggers the
      // CSS transition. Without the frame delay the element mounts
      // already-open and the animation is skipped.
      const id = requestAnimationFrame(() => setDataState('open'));
      return () => cancelAnimationFrame(id);
    }
    setDataState('closed');
    const t = setTimeout(() => setShouldRender(false), exitMs);
    return () => clearTimeout(t);
  }, [isOpen, exitMs]);

  return { shouldRender, dataState };
}

/**
 * §9 (2026-11-12) · Open/close animation tuned to feel "springy but
 * not playful" — expo-out entry, decisive ease-in exit, slight lift.
 *
 * Open  — 220ms expo-out cubic-bezier(0.16, 1, 0.3, 1): overlay fades in;
 *          card fades in + scales 0.96 → 1.0 + lifts 8px → 0 (translate-y).
 * Close — 140ms ease-in cubic-bezier(0.4, 0, 1, 1): overlay fades out;
 *          card fades out + scales to 0.96 + drops 8px. After the
 *          transition the shell unmounts.
 * Reduced-motion — both layers carry `motion-reduce:transition-none`
 *          (and the card also drops its transform), so the modal
 *          snaps open/closed for users with the OS flag.
 */
function AnimatedModalShell({
  open,
  onBackdropClick,
  overlayClassName,
  cardClassName,
  children,
}: {
  open: boolean;
  onBackdropClick?: () => void;
  overlayClassName?: string;
  cardClassName?: string;
  children: React.ReactNode;
}) {
  const { shouldRender, dataState } = useModalTransition(open, 140);
  if (!shouldRender) return null;
  return (
    <div
      data-state={dataState}
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center',
        'transition-opacity duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
        'data-[state=open]:opacity-100',
        'data-[state=closed]:opacity-0 data-[state=closed]:duration-[140ms] data-[state=closed]:ease-[cubic-bezier(0.4,0,1,1)]',
        overlayClassName ?? 'bg-slate-900/35 backdrop-blur-sm',
      )}
      onClick={onBackdropClick}
    >
      <div
        data-state={dataState}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none motion-reduce:transform-none',
          'data-[state=open]:opacity-100 data-[state=open]:scale-100 data-[state=open]:translate-y-0',
          'data-[state=closed]:opacity-0 data-[state=closed]:scale-[0.96] data-[state=closed]:translate-y-2 data-[state=closed]:duration-[140ms] data-[state=closed]:ease-[cubic-bezier(0.4,0,1,1)]',
          cardClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Deliverable Planning tab (Tier E #10, revised 2026-08-02).
 *
 * Second phase of project setup — set a target date per
 * (zone × deliverable) pair. PM enters an offset in MONTHS from a
 * "base date" (project kickoff / today); the backend snaps FORWARD
 * to the next Sunday (first day of the week in Israel) so the
 * customer promise never lands earlier than "N months from now".
 *
 * On save, task due dates propagate from the (zone × deliverable)
 * target — but only for tasks that haven't been manually overridden.
 * The API returns a list of overridden tasks and the PM sees a
 * prompt: keep manual dates, or overwrite them.
 *
 * Two view modes:
 *   - Table (default): zone × deliverable rows with month input +
 *     computed date pill.
 *   - Gantt: horizontal bar timeline, one row per (zone × deliverable),
 *     bar spanning est-start → due-date.
 */
export function DeliverablePlanningTab({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const todayStr = new Date().toISOString().slice(0, 10);
  // Persisted per-project so switching to the Planning tab (which
  // unmounts this one — project-detail-page gates tab content with
  // `{tab === … && <Tab/>}`) and back keeps the user's toolbar state
  // (2026-11-08). baseDate ties the Gantt grid origin — losing it
  // reset every row's preview months+date pair on tab return.
  const [baseDate, setBaseDate] = useProjectTabState<string>(
    projectId,
    'dp-base-date',
    todayStr,
  );
  const [viewMode, setViewMode] = useProjectTabState<'table' | 'gantt'>(
    projectId,
    'dp-view-mode',
    'table',
  );
  const [filterHasDue, setFilterHasDue] = useProjectTabState<'' | 'yes' | 'no'>(
    projectId,
    'dp-filter-has-due',
    '',
  );
  // PR-012 · Service (aka Phase) multi-select filter for the Deliverable
  // view. Options are the unique service names present on the current
  // rows — sourced from `deliverable.service.name` (ProjectDeliverable →
  // Phase), same lookup the row's "Service" cell already renders.
  // Empty set = no filter (all rows). OR-within-filter; ANDs with the
  // due-date select above and the per-column text filters inside
  // TableView. Persisted as an Array<string> (Sets don't JSON-serialise)
  // and rehydrated into a Set at render-time so every call-site that
  // reads it (`serviceFilter.has(name)`) is unchanged (2026-11-08).
  // UI-only: the save/PERT/date-shift pipeline sees ALL rows (this
  // filter never enters the save payload).
  const [serviceFilterArr, setServiceFilterArr] = useProjectTabState<string[]>(
    projectId,
    'dp-service-filter',
    [],
  );
  const serviceFilter = useMemo(() => new Set(serviceFilterArr), [serviceFilterArr]);
  const setServiceFilter = (v: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    if (typeof v === 'function') {
      setServiceFilterArr((prev) => Array.from(v(new Set(prev))));
    } else {
      setServiceFilterArr(Array.from(v));
    }
  };
  // Once at least one deliverable has a saved target, default to
  // Gantt view (client feedback 2026-08-02, item 6). Persisted per-
  // project so the auto-flip only happens once per project — without
  // it, a tab round-trip would re-fire the effect, undo the user's
  // manual "back to Table" pick, and force-flip to Gantt again
  // (2026-11-08).
  const [defaultedToGantt, setDefaultedToGantt] = useProjectTabState<boolean>(
    projectId,
    'dp-defaulted-to-gantt',
    false,
  );

  // DP-6 · Deliverable-group collapse state, LIFTED here so Table and
  // Gantt share one source of truth (toggling in one view is reflected
  // in the other). A `Set<string>` of collapsed group KEYS (UI-14 —
  // was `Set<number>` of deliverableIds before the primary group dim
  // became configurable). ABSENT = expanded, so brand-new groups
  // default to expanded without a re-init. Persisted per-project to
  // `localStorage` under `planwise:deliv:collapsed:v2:<projectId>`; a
  // missing key = all expanded, and every read is `try/catch`-guarded
  // because private-browsing mode / cleared site data can throw on
  // access. v2 bumped so older number-id payloads don't leak in as
  // bogus string keys — on first mount under v2 everything just
  // defaults to expanded.
  const collapsedKey = `planwise:deliv:collapsed:v2:${projectId}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(collapsedKey);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr.filter((n) => typeof n === 'string') : []);
    } catch { return new Set(); }
  });
  useEffect(() => {
    try {
      localStorage.setItem(collapsedKey, JSON.stringify(Array.from(collapsed)));
    } catch { /* ignore — private mode / blocked storage */ }
  }, [collapsed, collapsedKey]);
  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // UI-14 · Group + sub-group dims. Default primary=deliverable,
  // sub=zone preserves DP-DISP-1's "Deliverable · Zone" ordering (the
  // Gantt label column header reads from these dims). Persisted per-
  // project so returning to the tab keeps the user's pick; stored as a
  // single object under `deliverable-planning.grouping.<projectId>` so
  // a schema bump can migrate in one key, not two.
  const groupingKey = `deliverable-planning.grouping.${projectId}`;
  type GroupingPref = { primary: DPGroupDim | null; secondary: DPGroupDim | null };
  const defaultGrouping: GroupingPref = { primary: 'deliverable', secondary: 'zone' };
  const [grouping, setGrouping] = useState<GroupingPref>(() => {
    try {
      const raw = localStorage.getItem(groupingKey);
      if (!raw) return defaultGrouping;
      const parsed = JSON.parse(raw);
      const dims = new Set<DPGroupDim>(['zone', 'deliverable', 'service']);
      const primary = parsed?.primary && dims.has(parsed.primary) ? parsed.primary : null;
      const secondary = parsed?.secondary && dims.has(parsed.secondary) && parsed.secondary !== primary ? parsed.secondary : null;
      return { primary, secondary };
    } catch { return defaultGrouping; }
  });
  useEffect(() => {
    try { localStorage.setItem(groupingKey, JSON.stringify(grouping)); } catch { /* ignore */ }
  }, [grouping, groupingKey]);
  const outerDim: DPGroupDim = grouping.primary ?? 'deliverable';
  const innerDim: DPGroupDim | null = grouping.secondary;

  // Draft edits keyed by `${deliverableId}:${zoneId}`. Empty string = clear.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Duration drafts (calendar days) — parallel state so target months
  // and duration edits can be saved together in one batch.
  const [durationDrafts, setDurationDrafts] = useState<Record<string, string>>({});
  // Explicit-date drafts (ISO yyyy-mm-dd) — populated by the Gantt
  // drag so week-level precision is preserved (client feedback
  // 2026-08-02 item 4). When present for a row, this OVERRIDES the
  // months draft when saving.
  const [targetDateDrafts, setTargetDateDrafts] = useState<Record<string, string>>({});

  const { data: deliverables = [], isLoading } = useQuery<any[]>({
    queryKey: ['project-deliverables', projectId],
    queryFn: () =>
      client
        .get('/project-deliverables', { params: { projectId } })
        .then((r) => {
          const d = r.data?.data ?? r.data;
          return Array.isArray(d) ? d : [];
        }),
    staleTime: 30 * 1000,
  });

  // DP empty-flip race (2026-11-09): without `placeholderData`, every
  // Planning mutation invalidates this query and `planningData` momentarily
  // becomes `undefined` during the refetch → `tasks=[]` →
  // `connectionsByDeliverable={}` → `rows=[]` → the empty-state screen flashes
  // for one render even though the deliverable row is still there. Keeping
  // the previous payload (react-query v5 API) means `tasks` never empties
  // mid-refetch. Paired with the belt-and-suspenders guard at the empty-screen
  // gate below so neither failure mode alone can surface the false empty.
  const { data: planningData, isLoading: planningIsLoading } = useQuery<any>({
    queryKey: ['planning', projectId],
    queryFn: () => client.get(`/projects/${projectId}/planning-data`).then((r) => r.data?.data ?? r.data),
    enabled: !!projectId,
    staleTime: 60 * 1000,
    placeholderData: keepPreviousData,
  });
  const tasks: any[] = Array.isArray(planningData?.tasks) ? planningData.tasks : [];
  // planningData.zones is a TREE of zone roots (see planning.service.ts).
  // Flatten it so lookups + cross-product row generation see every zone,
  // not just top-level roots (bm2 fix #1: brand-new projects had NO
  // tasks yet, so tasks-driven rows produced an empty grid even with
  // zones + deliverables present).
  // `zoneType` (DP-4) is threaded through so the Table + Gantt can badge
  // each zone with its type. Enum values live on `Zone.zoneType` and are
  // already on the wire — the client just used to drop them.
  type ZoneNode = { id: number; name: string; sortOrder?: number; zoneType?: string; children?: ZoneNode[] };
  const zonesFlat: ZoneNode[] = useMemo(() => {
    const roots: ZoneNode[] = Array.isArray(planningData?.zones) ? planningData.zones : [];
    const out: ZoneNode[] = [];
    const walk = (arr: ZoneNode[]) => {
      for (const z of arr) {
        out.push(z);
        if (Array.isArray(z.children) && z.children.length) walk(z.children);
      }
    };
    walk(roots);
    return out;
  }, [planningData?.zones]);

  // DPG-1 (2026-10-20) · Zone-tree ancestry — maps every zone id to its
  // TOP-LEVEL ancestor's id + name. Deliverable Planning v1 scope: when
  // grouping by Zone, sub-zones (building → level → area) all roll up
  // to the top-level root they descend from, so the Gantt shows one
  // bucket per top-level zone instead of a flat list of every sub-zone.
  // Nested rollups (per-level drill-down) are deferred to v2.
  //
  // Shape: `idMap` has every zone id → its root ancestor's id, `nameMap`
  // has each root id → its own name. Walked from the SAME zone-tree
  // `zonesFlat` reads, so there's no risk of a mismatch between the
  // flattened list and the ancestry decision.
  //
  // DP-4 parity (2026-10-21) — also carry `typeMap` (top-level id →
  // `zoneType`) and `sortOrderMap` (top-level id → sortOrder). The two
  // extra maps feed the Zone-grouping group header: typeMap drives the
  // amber "Building" badge next to the top-level zone name (matching
  // Planning), sortOrderMap drives the group sort order so DP and
  // Planning render top-level zones in the same sequence
  // (Planning uses the API's `[sortOrder: asc, createdAt: asc]` orderBy;
  // we mirror the primary key here and tiebreak on name).
  const topLevelZoneInfo = useMemo(() => {
    const idMap = new Map<number, number>();           // zoneId → top-level ancestor id
    const nameMap = new Map<number, string>();         // top-level id → top-level name
    const typeMap = new Map<number, string | undefined>(); // top-level id → zoneType
    const sortOrderMap = new Map<number, number>();    // top-level id → sortOrder (NaN-safe)
    const roots: ZoneNode[] = Array.isArray(planningData?.zones) ? planningData.zones : [];
    const walk = (z: ZoneNode, topId: number) => {
      idMap.set(z.id, topId);
      if (Array.isArray(z.children) && z.children.length) {
        for (const c of z.children) walk(c, topId);
      }
    };
    for (const r of roots) {
      nameMap.set(r.id, r.name);
      typeMap.set(r.id, r.zoneType);
      sortOrderMap.set(r.id, Number(r.sortOrder ?? 0));
      walk(r, r.id);
    }
    return { idMap, nameMap, typeMap, sortOrderMap };
  }, [planningData?.zones]);

  // Build (zone × deliverable) rows from the CROSS PRODUCT of the
  // project's zones and its deliverables — so every combination shows
  // even before any tasks exist (bm2 fix #1). Task counts still overlay
  // when tasks are present; task-only rows referencing a deliverable
  // that isn't in the deliverables list (or the synthetic root zone)
  // still get emitted so nothing renders as a phantom "0 tasks" gap.
  type Row = {
    key: string;
    deliverableId: number;
    deliverableName: string;
    zoneId: number | null;
    zoneName: string;
    // Zone type enum (DP-4). Optional — the synthetic "Project Root"
    // pseudo-row emitted for projects with no zones has no type.
    zoneType?: string;
    // DPG-1 (2026-10-20) — Top-level zone ancestor id + name. Rows
    // whose zone descends from a root (e.g. "Area 3" under "Building A")
    // share these fields with their root parent so a Zone grouping
    // folds them into one bucket. `zoneId=null` → `topLevelZoneId=null`
    // and `topLevelZoneName='Project Root'`; a root zone's row has
    // these equal to its own `zoneId` + `zoneName`.
    topLevelZoneId: number | null;
    topLevelZoneName: string;
    serviceName: string | null;
    // Current server target (either from zoneTargets[zoneId] or the deliverable-level fallback)
    savedMonths: number | null;
    savedDate: string | null;
    savedDurationWeeks: number | null;
    // Σ of `Task.budgetHours` for every task under this (zone × deliverable).
    // DP-3 — the client used to drop this column even though the wire
    // already carried it. 0 when the group has no tasks.
    hours: number;
    // Aggregate task counts for this (zone × deliverable). Rendered
    // as a badge on each Gantt bar (client feedback 2026-08-02 item 4).
    // "started" = anything past To Do that isn't Done ("in_progress",
    // "in_review", "done" for the started tally); "done" = "done".
    taskTotal: number;
    taskStarted: number;
    taskDone: number;
    // The full task list for this row — feeds the Gantt-bar-click
    // modal (client feedback item 2/3). Kept minimal: id/code/name/end/status.
    // bm2 2026-10-21 — also carries `dependencies` so the Gantt row
    // label can flag predecessor conflicts (any task whose endDate is
    // earlier than one of its predecessors'); see predecessor-conflict.ts.
    taskList: {
      id: number;
      code: string | null;
      name: string;
      endDate: string | null;
      // §5 (2026-11-09) — carry the scheduler's computed start so the
      // chain tooltip can show per-task start→end and the duration edge.
      estimatedStartDate?: string | null;
      status: string;
      // §5 (2026-11-09) — carry the FTS edge metadata too so the Gantt
      // tooltip can render "pred → (N wd|cal) succ" for every link.
      // `lag` + `lagUnit` live on the TaskDependency row itself, which
      // Prisma's `dependencies: { include: { dependsOn: { select } } }`
      // returns alongside the selected `dependsOn` sub-fields.
      dependencies?: Array<{
        dependsOnId?: number;
        lag?: number;
        lagUnit?: 'WORKING_DAYS' | 'CALENDAR_DAYS';
        dependsOn?: { id?: number; code?: string | null; name?: string | null; endDate?: string | null } | null;
      }>;
      // D7-Float (2026-11-03) · Scheduler-computed, surfaces as CP chip
      // on the Gantt row and as a column in the DeliverableTasksModal.
      float?: number | null;
      onCriticalPath?: boolean;
    }[];
    // DP-EMPTY-3 (2026-09-30) — true when this row's deliverable is
    // NOT backed by a real `ProjectDeliverable` row (source was a
    // `deliverableTemplate.name` or a `[SERVICE:<name>]` marker). The
    // grid renders these read-only with a "run the materialize backfill
    // to edit" hint, and they are excluded from save + dirty checks.
    readOnly?: boolean;
    // Explanation for the read-only tooltip when `readOnly === true`.
    readOnlyReason?: string;
  };
  const rows: Row[] = useMemo(() => {
    // Group tasks by (deliverable, TOP-LEVEL zone) so counts + endDate
    // lists overlay onto the (deliverable × top-level-zone) rows the
    // loop below emits.
    //
    // DP-DUPS (2026-10-21) · Prior to this change the loop iterated
    // every zone in zonesFlat (DFS of the whole tree) and this map was
    // keyed by raw (deliverable, zone) — one row per sub-zone, which
    // inflated the grid 3-4× for projects with sub-zones. We now roll
    // every task up to its TOP-LEVEL zone (via topLevelZoneInfo.idMap,
    // which falls back to the zone's own id for a childless root), so
    // sub-zone tasks and top-zone tasks aggregate onto one bucket.
    const grouped = new Map<string, any[]>();
    for (const t of tasks) {
      const dId = t.projectDeliverableId;
      if (dId == null) continue;
      const rawZoneId = t.zoneId ?? null;
      const topZoneId: number | null = rawZoneId == null
        ? null
        : (topLevelZoneInfo.idMap.get(rawZoneId) ?? rawZoneId);
      const key = topZoneId == null ? `${dId}:root` : `${dId}:topzone-${topZoneId}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(t);
    }

    // DP-EMPTY-3 — synthesize deliverables from tasks whose
    // `projectDeliverableId` is NULL but whose deliverable dimension
    // can still be resolved via `deliverableTemplate.name` or the
    // legacy `[SERVICE:<name>]` marker. Without this, projects like
    // #33 (32 tasks, 4 markers, 0 ProjectDeliverable rows) render an
    // empty grid until the DP-EMPTY-1 backfill runs. Synthetic rows
    // are keyed by a stable negative id so real ProjectDeliverable ids
    // never collide, and rendered read-only so the PM can see the
    // shape they're about to materialize but can't accidentally save
    // targets against a row that doesn't exist yet.
    type SyntheticDeliverable = {
      id: number;
      name: string;
      service?: { name: string | null; color: string | null } | null;
      readOnly: true;
      readOnlyReason: string;
    };
    const syntheticByName = new Map<string, SyntheticDeliverable>();
    // Track tasks grouped under each synthetic deliverable so counts +
    // hours + endDates overlay the same as real deliverables.
    const syntheticGrouped = new Map<string, any[]>();
    let nextSyntheticId = -1;
    for (const t of tasks) {
      if (t.projectDeliverableId != null) continue;
      const resolved = resolveTaskDeliverableDetailed(t);
      if (resolved.source !== 'template' && resolved.source !== 'marker') continue;
      let syn = syntheticByName.get(resolved.name);
      if (!syn) {
        syn = {
          id: nextSyntheticId--,
          name: resolved.name,
          // Best-effort service name: prefer the task's own phase (via
          // the read-time include), then the deliverableTemplate's
          // phase. Same fallback the SERVICE column already uses.
          service: t.phase?.name
            ? { name: t.phase.name, color: t.phase.color ?? null }
            : t.deliverableTemplate?.phase?.name
              ? { name: t.deliverableTemplate.phase.name, color: t.deliverableTemplate.phase.color ?? null }
              : null,
          readOnly: true,
          readOnlyReason:
            resolved.source === 'template'
              ? 'Not yet planned — the deliverable lives only on the task template. Run the materialize-project-deliverables backfill to edit target dates here.'
              : 'Not yet planned — the deliverable is a [SERVICE:…] marker. Run the materialize-project-deliverables backfill to edit target dates here.',
        };
        syntheticByName.set(resolved.name, syn);
      }
      const rawZoneId = t.zoneId ?? null;
      // DP-DUPS (2026-10-21) · Match the top-level roll-up used for
      // real deliverables above so synthetic rows also render once per
      // (deliverable × top-zone) instead of once per sub-zone.
      const topZoneId: number | null = rawZoneId == null
        ? null
        : (topLevelZoneInfo.idMap.get(rawZoneId) ?? rawZoneId);
      const gKey = topZoneId == null ? `${syn.id}:root` : `${syn.id}:topzone-${topZoneId}`;
      if (!syntheticGrouped.has(gKey)) syntheticGrouped.set(gKey, []);
      syntheticGrouped.get(gKey)!.push(t);
    }

    // DP-DUPS (2026-10-21) · Inverse of topLevelZoneInfo.idMap — for
    // each top-level zone id, the set of its descendant zone ids
    // (INCLUDING itself — the idMap entry maps `topId → topId` for a
    // root, so a direct ZDT on the top-zone is picked up by the subtree
    // walk). Used by `emit` below to aggregate per-sub-zone
    // ZoneDeliverableTarget rows onto the one top-zone row.
    const descendantsByTopZone = new Map<number, Set<number>>();
    for (const [subId, topId] of topLevelZoneInfo.idMap) {
      let set = descendantsByTopZone.get(topId);
      if (!set) { set = new Set<number>(); descendantsByTopZone.set(topId, set); }
      set.add(subId);
    }

    const list: Row[] = [];
    const emitted = new Set<string>();
    const emit = (
      dId: number,
      // Post DP-DUPS (2026-10-21): `zoneId` is ALWAYS a top-level zone
      // id (or null for the Project Root bucket). The main cross-
      // product loop iterates `topLevelZones` directly; the overlay and
      // synthetic loops below translate their raw task zoneIds to the
      // top-level ancestor before calling emit.
      deliverable: any,
      zoneId: number | null,
      zoneName: string,
      zoneType?: string,
      opts?: { readOnly?: boolean; readOnlyReason?: string; taskOverride?: any[] },
    ) => {
      const key = zoneId == null ? `${dId}:root` : `${dId}:topzone-${zoneId}`;
      if (emitted.has(key)) return;
      emitted.add(key);
      const group = opts?.taskOverride ?? grouped.get(key) ?? [];

      // DP-DUPS (2026-10-21) · Aggregate ZoneDeliverableTarget rows
      // across the top-zone's subtree. Pre-existing per-sub-zone ZDT
      // rows live in the DB from before this change; they stay there
      // untouched (no cleanup, no deletes). Reads fold every ZDT whose
      // zoneId belongs to this top-zone's subtree (incl. the top-zone
      // itself) into one aggregate:
      //   • savedDate            → MIN  (earliest promise wins).
      //   • savedMonths          → MIN  (same order as the date).
      //   • savedDurationWeeks   → MAX  (longest planned span).
      // Fall back to the deliverable-level default when no ZDT in the
      // subtree carries that field. New saves write only against the
      // top-zone id (the save payload uses r.zoneId, which is now the
      // top-zone id by construction), so the aggregation converges to
      // a single row per (deliverable × top-zone) over time.
      const zoneTargets: any[] = Array.isArray(deliverable?.zoneTargets) ? deliverable.zoneTargets : [];
      let aggDate: string | null = null;
      let aggMonths: number | null = null;
      let aggDurationWeeks: number | null = null;
      if (zoneId == null) {
        // Project Root bucket — match on zoneId=null only.
        const match = zoneTargets.find((zt: any) => zt.zoneId == null);
        aggDate = match?.targetDate ? String(match.targetDate).slice(0, 10) : null;
        aggMonths = match?.targetMonths ?? null;
        aggDurationWeeks = match?.estimatedDurationWeeks ?? null;
      } else {
        const descendants = descendantsByTopZone.get(zoneId);
        for (const zt of zoneTargets) {
          if (zt.zoneId == null) continue;
          // In-subtree test: belongs to this top-zone's descendant set
          // OR is the top-zone itself (defensive — a childless root may
          // not appear in idMap, but descendantsByTopZone adds it via
          // the self-mapping idMap entry; keep the explicit top-zone
          // comparison so a stale map still rolls up correctly).
          const inSubtree = zt.zoneId === zoneId || (descendants ? descendants.has(zt.zoneId) : false);
          if (!inSubtree) continue;
          if (zt.targetDate) {
            const d = String(zt.targetDate).slice(0, 10);
            if (aggDate == null || d < aggDate) aggDate = d;
          }
          if (zt.targetMonths != null) {
            const m = Number(zt.targetMonths);
            if (!Number.isNaN(m) && (aggMonths == null || m < aggMonths)) aggMonths = m;
          }
          if (zt.estimatedDurationWeeks != null) {
            const w = Number(zt.estimatedDurationWeeks);
            if (!Number.isNaN(w) && (aggDurationWeeks == null || w > aggDurationWeeks)) aggDurationWeeks = w;
          }
        }
      }
      const savedMonths = aggMonths ?? deliverable?.targetMonths ?? null;
      const savedDate = aggDate ?? deliverable?.targetDate ?? null;
      const savedDurationWeeks = aggDurationWeeks ?? deliverable?.estimatedDurationWeeks ?? null;
      const taskTotal = group.length;
      const taskDone = group.filter((t) => t.status === 'done').length;
      const taskStarted = group.filter((t) => t.status !== 'to_do' && t.status !== 'blocked').length;
      // DP-3 · Σ budgetHours across every task in this (zone × deliverable).
      // Prisma serializes `Decimal` as a string on the wire, so coerce
      // with `Number(...)` and treat null/undefined as 0.
      const hours = group.reduce((acc, t) => acc + Number((t as any).budgetHours || 0), 0);
      const taskList = group.map((t) => ({
        id: t.id,
        code: t.code ?? null,
        name: t.name,
        endDate: t.endDate ? String(t.endDate).slice(0, 10) : null,
        // §5 (2026-11-09) — forward estimatedStartDate so the Gantt
        // tooltip's chain line can print per-task start→end.
        estimatedStartDate: (t as any).estimatedStartDate ? String((t as any).estimatedStartDate).slice(0, 10) : null,
        status: t.status,
        // bm2 2026-10-21 — forward the task's dependencies so DP Gantt
        // can flag rows whose children have "endDate < predecessor's
        // endDate" (planning.service now exposes dependsOn.endDate).
        // §5 (2026-11-09) — the same array also carries `lag` +
        // `lagUnit` straight from the TaskDependency row (returned
        // alongside the dependsOn select), used by the chain tooltip.
        dependencies: Array.isArray((t as any).dependencies) ? (t as any).dependencies : [],
        // D7-Float (2026-11-03) · Scheduler-computed, surfaces as CP chip
        // on the Gantt row and as a column in the DeliverableTasksModal.
        float: (t as any).float ?? null,
        onCriticalPath: Boolean((t as any).onCriticalPath),
      }));
      // DPG-1 · Compute the top-level zone ancestor for this row. The
      // `idMap` falls back to the zone's own id when the zone IS a root
      // (so a root row's topLevelZoneId === zoneId). `zoneId=null` rows
      // (orphan tasks, no-zones projects) bucket to the "Project Root"
      // group — one group label everywhere no matter how many rows have
      // zoneId=null.
      const topLevelId: number | null = zoneId == null
        ? null
        : (topLevelZoneInfo.idMap.get(zoneId) ?? zoneId);
      const topLevelName: string = topLevelId == null
        ? 'Project Root'
        : (topLevelZoneInfo.nameMap.get(topLevelId) ?? zoneName);
      list.push({
        key,
        deliverableId: dId,
        deliverableName: deliverable?.name ?? `Deliverable #${dId}`,
        zoneId,
        zoneName,
        zoneType,
        topLevelZoneId: topLevelId,
        topLevelZoneName: topLevelName,
        // Read-time fallback (2026-09-29): when the ProjectDeliverable
        // row's `service` is null (historical rows created before the
        // Template.phaseId inheritance was reliable), fall back to the
        // source template's phase name. The API now includes it on
        // every ProjectDeliverable read (project-deliverables.service.ts).
        serviceName: deliverable?.service?.name ?? deliverable?.sourceTemplate?.phase?.name ?? null,
        savedMonths,
        savedDate: savedDate ? String(savedDate).slice(0, 10) : null,
        savedDurationWeeks,
        hours,
        taskTotal,
        taskStarted,
        taskDone,
        taskList,
        readOnly: opts?.readOnly,
        readOnlyReason: opts?.readOnlyReason,
      });
    };

    // DP-DUPS (2026-10-21) · Iterate TOP-LEVEL zones only — the prior
    // `zonesFlat` cross-product (which included every sub-zone from the
    // DFS walk) multiplied each deliverable by every zone-tree node,
    // producing 3-4 duplicate rows per deliverable in projects with
    // sub-zones (see docs/bm2/dp-duplicates-investigation.md). Per-sub-
    // zone ZDT rows and per-sub-zone task counts aggregate onto the
    // single top-zone row via the subtree walks earlier in this memo.
    //
    // When the project has no zones at all we still emit a single
    // "Project Root" row per deliverable so the grid isn't empty (bm2
    // fix #1). Orphan tasks with zoneId=null fall through the overlay
    // loop below, which also emits a Project Root row.
    //
    // DP Bug A (2026-10-21) — only emit the Project Root fallback when
    // the planning query has DEFINITIVELY resolved. Previously the
    // fallback also fired when `planningData` was still loading
    // (undefined), which minted a Project Root row per deliverable on
    // the first DP visit after a Planning mutation: the deliverables
    // query is served from its 30s stale cache instantly while the
    // planning query (invalidated by the mutation) is still refetching,
    // so for one render `deliverables.length > 0 && !planningData` — the
    // group header read "Project Root · N deliverables" until the user
    // hard-reloaded. Hard reload masked it because planning data was
    // typically back before paint. Preserving the legitimate "zero
    // zones" fallback by gating on `planningIsLoading` only: once the
    // query is NOT loading (either success with zones:[] or error), the
    // fallback is correct.
    const topLevelZones: ZoneNode[] = Array.isArray(planningData?.zones) ? planningData.zones : [];

    // 2026-10-26 (DP cross-product fix, locked by Yulian) — build a
    // per-deliverable set of ACTUAL top-level zone connections so the
    // main emit loop no longer blankets every (deliverable × top-zone)
    // pair with a row. A deliverable belongs under Zone Y iff:
    //   • one of its Tasks has `zoneId` that resolves (via idMap) to Y, OR
    //   • one of its ZoneDeliverableTarget rows has `zoneId` that
    //     resolves to Y (direct or descendant).
    // Null-zone entries (`null` in the Set) represent orphan tasks or
    // ZDTs with `zoneId=null` → "Project Root" bucket.
    //
    // A deliverable with NO tasks AND NO ZDTs ends up with no entry /
    // empty set; by Yulian's rule (option ב, 2026-10-26) those are
    // hidden entirely from the grid instead of being showered across
    // every zone column.
    //
    // Reuses `topLevelZoneInfo.idMap` already built above, so sub-zone
    // ids resolve to their root ancestor and we don't double-count.
    const connectionsByDeliverable = new Map<number, Set<number | null>>();
    const addConnection = (dId: number, topZoneId: number | null) => {
      let set = connectionsByDeliverable.get(dId);
      if (!set) {
        set = new Set<number | null>();
        connectionsByDeliverable.set(dId, set);
      }
      set.add(topZoneId);
    };
    // Task-driven connections: project deliverable id + task's zoneId.
    for (const t of tasks ?? []) {
      const dId = (t as any).projectDeliverableId;
      if (dId == null) continue;
      const rawZoneId = (t as any).zoneId ?? null;
      const topZoneId: number | null = rawZoneId == null
        ? null
        : (topLevelZoneInfo.idMap.get(rawZoneId) ?? rawZoneId);
      addConnection(dId, topZoneId);
    }
    // 2026-11-04 · B2 lock (Yulian, Option A). Snapshot the
    // (deliverableId, topZoneId) pairs created by the task loop above.
    // The ZDT loop below may only re-assert these pairs — a ZDT alone
    // never invents a new (deliverable, zone) connection. Non-empty
    // ZDTs still carry target data for already-connected pairs; that
    // render path reads `deliverable.zoneTargets[]` directly in `emit`
    // (see the aggregation block ~L483), independent of this map.
    const taskConnectedPairs = new Map<number, Set<number | null>>();
    for (const [dId, set] of connectionsByDeliverable) {
      taskConnectedPairs.set(dId, new Set(set));
    }
    // ZDT-driven connections: pre-task planning intent (PM saved a
    // target for the zone before any task was created). Walk every
    // deliverable's zoneTargets[] and roll each one up to its root.
    for (const d of deliverables) {
      const zts: any[] = Array.isArray((d as any).zoneTargets) ? (d as any).zoneTargets : [];
      for (const zt of zts) {
        // 2026-11-03 · DP empty-ZDT regression (project 40). A ZDT row
        // whose three target fields are ALL null is a ghost — it was
        // written by the old "Save all" grid loop (now fixed in
        // project-deliverables.service.ts) with no actual planning
        // intent. Treat it as "not a connection" so the deliverable
        // falls back to its task-driven zones only. A ZDT with any
        // real value (date, months, or duration) still counts.
        if (zt?.targetDate == null && zt?.targetMonths == null && zt?.estimatedDurationWeeks == null) continue;
        if (zt?.zoneId == null) {
          // B2 gate: only re-assert when a task of this deliverable
          // already sits in Project Root (zoneId=null).
          if (taskConnectedPairs.get(d.id)?.has(null)) addConnection(d.id, null);
        } else {
          const topZoneId = topLevelZoneInfo.idMap.get(zt.zoneId) ?? zt.zoneId;
          // B2 gate: only re-assert when a task of this deliverable
          // already landed in this top-zone.
          if (taskConnectedPairs.get(d.id)?.has(topZoneId)) addConnection(d.id, topZoneId);
        }
      }
    }

    // 2026-10-26 · Filter deliverables to zones with an actual
    // connection (Task.zoneId or ZDT); hide deliverables with no
    // connections at all. See `connectionsByDeliverable` above.
    for (const d of deliverables) {
      const connections = connectionsByDeliverable.get(d.id);
      if (!connections || connections.size === 0) {
        // Deliverable has no tasks AND no ZDT — hide entirely
        // (Yulian 2026-10-26, option ב). The old cross-product behavior
        // emitted a row under every top-zone for this deliverable;
        // option ב collapses it to zero rows.
        continue;
      }

      if (topLevelZones.length === 0) {
        // Project has no zones at all. Preserve the pre-fix "zero
        // zones" fallback: emit a single Project Root row per
        // deliverable (whose only connection is `null` by construction
        // — tasks here can only carry zoneId=null). The planning-load
        // gate stays so the group header doesn't flash while the
        // planning query is still refetching after a mutation (see
        // DP Bug A comment above).
        if (!planningIsLoading) emit(d.id, d, null, 'Project Root');
      } else {
        // Zoned project: emit only (deliverable × top-zone) pairs where
        // the deliverable has a task or ZDT connecting them.
        for (const z of topLevelZones) {
          if (!connections.has(z.id)) continue;
          emit(d.id, d, z.id, z.name, z.zoneType);
        }
        // Project Root sibling row for orphan-task deliverables: a
        // deliverable whose tasks live partly in Zone A and partly in
        // zoneId=null should appear under BOTH Zone A and Project
        // Root. The overlay loop below used to be the ONLY way these
        // orphan rows surfaced; promoting them up here lets the main
        // loop own emission so the overlay stays reserved for
        // deleted-deliverable / missing-zone edge cases.
        if (connections.has(null)) {
          emit(d.id, d, null, 'Project Root');
        }
      }
    }

    // Overlay any task-only groups that didn't match a known deliverable
    // (e.g. deliverable was deleted but tasks still reference it) or
    // that landed on the synthetic root zone even when zones exist —
    // preserves the pre-fix behavior for those edge cases. Because
    // `grouped` is now keyed by top-level zone id (see roll-up above),
    // we translate the task's raw zoneId to its top-level ancestor so
    // the emitted row sits in the right bucket and matches the key
    // format emit uses internally.
    for (const [groupKey, group] of grouped) {
      if (emitted.has(groupKey)) continue;
      const first = group[0];
      const dId: number = first.projectDeliverableId;
      const rawZoneId: number | null = first.zoneId ?? null;
      const topZoneId: number | null = rawZoneId == null
        ? null
        : (topLevelZoneInfo.idMap.get(rawZoneId) ?? rawZoneId);
      const topZone = topZoneId == null ? null : topLevelZones.find((z) => z.id === topZoneId);
      const deliverable = deliverables.find((d) => d.id === dId);
      emit(
        dId,
        deliverable,
        topZoneId,
        topZone?.name ?? (topZoneId == null ? 'Project Root' : `Zone #${topZoneId}`),
        topZone?.zoneType,
      );
    }

    // DP-EMPTY-3 — emit synthetic (read-only) rows for marker/template-
    // only tasks. Zoned tasks get one row per TOP-LEVEL zone that holds
    // a matching task (no cross-product — we don't know which zones
    // the PM intends to plan against until they materialize the row).
    // Root tasks (zoneId=null) get a "Project Root" row.
    //
    // DP-DUPS (2026-10-21) · `syntheticGrouped` is now keyed by top-
    // zone (see roll-up above), so the zone lookup here uses the task's
    // top-level ancestor. Previously a synthetic row was emitted per
    // sub-zone, same multiplier as the real-row bug.
    for (const [gKey, group] of syntheticGrouped) {
      const first = group[0];
      const rawZoneId: number | null = first.zoneId ?? null;
      const topZoneId: number | null = rawZoneId == null
        ? null
        : (topLevelZoneInfo.idMap.get(rawZoneId) ?? rawZoneId);
      const topZone = topZoneId == null ? null : topLevelZones.find((z) => z.id === topZoneId);
      const dId = Number(gKey.split(':')[0]);
      const syn = Array.from(syntheticByName.values()).find((s) => s.id === dId);
      if (!syn) continue;
      emit(
        dId,
        syn,
        topZoneId,
        topZone?.name ?? (topZoneId == null ? 'Project Root' : `Zone #${topZoneId}`),
        topZone?.zoneType,
        {
          readOnly: true,
          readOnlyReason: syn.readOnlyReason,
          taskOverride: group,
        },
      );
    }
    // Sort: Commit 8 · Model B (drag-authoritative). Render order is
    // ProjectDeliverable.sortOrder ASC, then Zone.sortOrder ASC as a
    // tiebreak (so a deliverable's per-zone rows still cluster in a
    // predictable order). "Project Root" rows (zoneId == null) drop
    // below zoned ones inside the same deliverable so per-zone entries
    // surface first. Name tiebreaks last so a run of zero sortOrder
    // (pre-backfill data / fresh row) still renders deterministically.
    //
    // Model B rule: sortOrder is authoritative — a manual drag on
    // planning-modal overrides the initial chronological seed, and this
    // Gantt inherits that same order for its default view. (The Gantt's
    // localStorage row-order layer sits on top and preserves any per-
    // browser drag on THIS screen — see RowsView `rowOrder` state.)
    const dSortOrderById = new Map<number, number>();
    for (const d of deliverables) {
      dSortOrderById.set(d.id, Number(d.sortOrder ?? 0));
    }
    const zSortOrderById = new Map<number, number>();
    for (const z of zonesFlat) {
      zSortOrderById.set(z.id, Number(z.sortOrder ?? 0));
    }
    return list.sort((a, b) => {
      const dA = dSortOrderById.get(a.deliverableId) ?? 0;
      const dB = dSortOrderById.get(b.deliverableId) ?? 0;
      if (dA !== dB) return dA - dB;
      // Same deliverable: zoned rows first, then Project Root last.
      if (a.zoneId == null && b.zoneId != null) return 1;
      if (b.zoneId == null && a.zoneId != null) return -1;
      const zA = a.zoneId != null ? (zSortOrderById.get(a.zoneId) ?? 0) : 0;
      const zB = b.zoneId != null ? (zSortOrderById.get(b.zoneId) ?? 0) : 0;
      if (zA !== zB) return zA - zB;
      const zNc = a.zoneName.localeCompare(b.zoneName);
      if (zNc !== 0) return zNc;
      return a.deliverableName.localeCompare(b.deliverableName);
    });
    // DPG-1 — `topLevelZoneInfo` participates in each row's bucket key
    // (via `topLevelZoneId` / `topLevelZoneName`), so a zone-tree edit
    // (new root / re-parent) invalidates and recomputes rows the same
    // frame the planning payload lands.
  }, [tasks, zonesFlat, deliverables, topLevelZoneInfo, planningIsLoading]);

  // Seed drafts from server values whenever rows change.
  useEffect(() => {
    const initial: Record<string, string> = {};
    const initialDur: Record<string, string> = {};
    for (const r of rows) {
      if (r.savedMonths != null) initial[r.key] = String(r.savedMonths);
      if (r.savedDurationWeeks != null) initialDur[r.key] = String(r.savedDurationWeeks);
    }
    setDrafts(initial);
    setDurationDrafts(initialDur);
    // Reset explicit-date drafts on row refresh — server just told us
    // the authoritative targetDate, so any stale drag draft is void.
    setTargetDateDrafts({});
  }, [rows]);

  // Auto-open in Gantt view once at least one row has a saved target
  // (client feedback 2026-08-02, item 6). Flips once per mount — the
  // user can still switch back to Table manually and it won't be
  // overridden.
  useEffect(() => {
    if (defaultedToGantt) return;
    const anySaved = rows.some((r) => !!r.savedDate);
    if (anySaved) {
      setViewMode('gantt');
      setDefaultedToGantt(true);
    }
  }, [rows, defaultedToGantt]);

  // Client-side preview: match backend snap logic exactly (forward to
  // next Sunday). We NEVER snap backward — customer promise doesn't
  // land earlier than "N months from base".
  const computePreview = (monthsRaw: string): string => {
    if (monthsRaw === '' || monthsRaw == null) return '';
    const months = Number(monthsRaw);
    if (Number.isNaN(months) || months < 0) return '';
    const [by, bm, bd] = baseDate.split('-').map(Number);
    if (!by || !bm || !bd) return '';
    const shifted = new Date(Date.UTC(by, bm - 1, bd));
    shifted.setUTCMonth(shifted.getUTCMonth() + Math.floor(months));
    const day = shifted.getUTCDay(); // Sun=0..Sat=6
    const daysForward = day === 0 ? 0 : 7 - day;
    shifted.setUTCDate(shifted.getUTCDate() + daysForward);
    return shifted.toISOString().slice(0, 10);
  };

  const [overrideConfirm, setOverrideConfirm] = useState<{ taskId: number; taskName: string; currentDue: string | null; targetDate: string | null }[] | null>(null);
  // Per-task conflict prompt for tasks whose current endDate is AFTER
  // the about-to-be-saved deliverable target. Client feedback
  // 2026-08-08: don't block — surface the conflicts, let the PM pick
  // per task whether to overwrite the Due date to the new target or
  // keep it as-is, then finish the save. Previously this was a hard
  // block ("fix task dates first") which forced the PM out of the
  // planning flow.
  type ExceedItem = { taskId: number; code: string | null; taskName: string; endDate: string; targetDate: string; deliverableName: string; zoneName: string };
  const [exceedPrompt, setExceedPrompt] = useState<ExceedItem[] | null>(null);
  // Per-task choice made by the PM in the conflict prompt. 'update' =
  // apply the target to the task's endDate (force-apply after save);
  // 'keep' = leave the task's endDate alone. Default 'update' — the
  // common case per the "notify and update" spec.
  const [exceedChoices, setExceedChoices] = useState<Record<number, 'update' | 'keep'>>({});
  // Loading flag while the sequenced Save + per-task force-apply chain
  // runs. Guards the confirm button and disables per-row toggling.
  const [exceedApplying, setExceedApplying] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      client
        .post('/project-deliverables/targets/batch', {
          baseDate,
          // Client 2026-08-03: never auto-propagate to task endDates.
          // Task due dates are AUTHORITATIVE at the task level once
          // set; the PM manages any downstream adjustments manually.
          applyToTasks: false,
          // DP-EMPTY-3 — synthetic (read-only) rows have negative,
          // non-existent deliverableIds; excluding them from the
          // payload keeps the batch endpoint from 404-ing on their
          // targets. The PM must run the DP-EMPTY-1 backfill to
          // materialize real rows before they become editable.
          items: rows
            .filter((r) => !r.readOnly)
            .map((r) => ({
              id: r.deliverableId,
              zoneId: r.zoneId,
              months: drafts[r.key] === '' || drafts[r.key] == null ? null : Number(drafts[r.key]),
              durationWeeks: durationDrafts[r.key] === '' || durationDrafts[r.key] == null ? null : Number(durationDrafts[r.key]),
              targetDate: targetDateDrafts[r.key] || undefined,
            })),
        })
        .then((r) => r.data),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['project-deliverables', projectId] });
      queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
      const payload = data?.data ?? data;
      notify.success(`Saved ${payload?.updated ?? rows.length} deliverable targets`);
      // Task due-date conflicts are handled up-front by the per-task
      // Update/Keep dialog in attemptSave; a silent success here is
      // the correct outcome when there are no conflicts.
    },
    onError: (err: any) => notify.apiError(err, 'Failed to save target dates'),
  });

  /**
   * Preflight before save: find every task whose current endDate is
   * strictly AFTER its (about-to-be-saved) deliverable target. The
   * conflict prompt (formerly a hard block) surfaces these and lets
   * the PM pick per task whether to overwrite or keep — the save
   * completes either way. Client feedback 2026-08-08.
   */
  const findExceedingTasks = (): ExceedItem[] | null => {
    const offenders: ExceedItem[] = [];
    for (const r of rows) {
      // DP-EMPTY-3 — synthetic read-only rows never enter the save
      // payload, so their tasks can't conflict with a saved target.
      if (r.readOnly) continue;
      const newTargetIso = targetDateDrafts[r.key] || computePreview(drafts[r.key] ?? '') || r.savedDate;
      if (!newTargetIso) continue;
      const targetMs = new Date(newTargetIso).getTime();
      for (const t of r.taskList ?? []) {
        if (!t.endDate) continue;
        if (new Date(t.endDate).getTime() > targetMs) {
          offenders.push({
            taskId: t.id,
            code: t.code ?? null,
            taskName: t.name,
            endDate: String(t.endDate).slice(0, 10),
            targetDate: String(newTargetIso).slice(0, 10),
            deliverableName: r.deliverableName,
            zoneName: r.zoneName,
          });
        }
      }
    }
    return offenders.length > 0 ? offenders : null;
  };

  const attemptSave = () => {
    const offenders = findExceedingTasks();
    if (offenders) {
      // Default every conflicting task to 'update' — the "notify and
      // update" spec's happy path. PM can flip individual rows to
      // 'keep' or use "Keep all" before confirming.
      const defaults: Record<number, 'update' | 'keep'> = {};
      for (const o of offenders) defaults[o.taskId] = 'update';
      setExceedChoices(defaults);
      setExceedPrompt(offenders);
      setExceedNextAction('save');
      return;
    }
    save.mutate();
  };

  /**
   * Confirm handler for the conflict prompt. Sequenced so the new
   * deliverable target is persisted FIRST (batch save), then any tasks
   * the PM chose to update get their endDate force-applied to that
   * target. Force-apply reads the just-saved target on the server, so
   * the ordering is load-bearing.
   *
   * §8a · When the originating button was "Save & update due dates",
   * we SKIP the plain save here (`previewMutation`'s own mutation runs
   * the batch save as step 1) and chain straight into the preview
   * flow after the force-apply pass clears any PM-requested per-task
   * overwrites.
   */
  const confirmExceed = async () => {
    if (!exceedPrompt) return;
    setExceedApplying(true);
    try {
      if (exceedNextAction === 'save') {
        await save.mutateAsync();
      }
      const updateIds = exceedPrompt
        .filter((t) => exceedChoices[t.taskId] === 'update')
        .map((t) => t.taskId);
      // Fire per-task force-apply in parallel — the endpoint is
      // idempotent and each hits a different task row so there's no
      // ordering constraint between them. For the Save & update path
      // we still run this BEFORE the scheduler so the targets the
      // scheduler reads already reflect the PM's per-task overwrites.
      const results = await Promise.allSettled(
        updateIds.map((id) => forceApply.mutateAsync(id)),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        notify.warning(`${updateIds.length - failed} of ${updateIds.length} task due dates updated`);
      } else if (updateIds.length > 0 && exceedNextAction === 'save') {
        // Only announce here when the plain-save flow owns the full
        // user-facing success message. In the Save & update flow the
        // scheduler's own onSuccess summarises the whole run.
        notify.success(`Updated ${updateIds.length} task due date${updateIds.length === 1 ? '' : 's'} to the new target`);
      }
      queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
      if (exceedNextAction === 'saveAndUpdate') {
        setPreviewing(true);
        previewMutation.mutate();
      }
    } finally {
      setExceedApplying(false);
      setExceedPrompt(null);
      setExceedChoices({});
      setExceedNextAction('save');
    }
  };

  const forceApply = useMutation({
    mutationFn: (taskId: number) =>
      client
        .post(`/project-deliverables/tasks/${taskId}/force-apply-target`)
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to overwrite task due date'),
  });

  // §8a · "Save & update due dates" — preview-before-commit flow.
  //
  // Click sequence:
  //   (1) persist deliverable targets via the existing batch endpoint,
  //   (2) call `preview-reschedule` — scheduler runs READ-ONLY and
  //       returns a full per-task diff (before/after + markers), no
  //       database writes,
  //   (3) Review modal renders the diff; PM toggles Apply/Keep per row,
  //   (4) on confirm, call `save-and-update-due-dates` with the
  //       selected `{ taskIds }` filter — the scheduler re-runs under
  //       its own transaction and writes those tasks only. The BE is
  //       the single source of truth for the math; the FE never
  //       simulates dates.
  interface PreviewItem {
    taskId: number;
    code: string;
    name: string;
    beforeStart: string | null;
    beforeEnd: string | null;
    afterStart: string | null;
    afterEnd: string | null;
    delta: { startDays: number | null; endDays: number | null };
    onCriticalPath: boolean;
    willMove: boolean;
    violatesTarget: boolean;
    hoursLogged: boolean;
  }
  interface PreviewResult {
    preview: PreviewItem[];
    projectSummary: {
      earliestStart: string | null;
      latestFinish: string | null;
      movedTasks: number;
    };
  }
  interface SaveAndUpdateResult {
    scannedDeliverables: number;
    autoApplied: Array<{ taskId: number; newStart: string; newEnd: string }>;
    // Always [] on the preview-approved path (the BE skips review
    // classification for tasks in the explicit filter). Kept on the
    // type so the raw BE response shape still typechecks.
    requiresReview: unknown[];
  }

  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewItem[] | null>(null);
  // Per-task PM choice. `apply` toggles whether this row gets written.
  // `end` is kept on the type for parity with the §7 `TasksEditorTable`
  // 'review' mode, but the commit endpoint only consumes `taskIds` — a
  // typed custom end date is ignored in the §8a flow.
  const [reviewChoices, setReviewChoices] = useState<Record<number, { apply: boolean; end: string }>>({});

  const previewMutation = useMutation({
    mutationFn: async (): Promise<PreviewResult> => {
      // Step 1: persist deliverable target changes via the existing
      // batch endpoint — same payload shape as the plain Save button.
      await client.post('/project-deliverables/targets/batch', {
        baseDate,
        applyToTasks: false,
        items: rows
          .filter((r) => !r.readOnly)
          .map((r) => ({
            id: r.deliverableId,
            zoneId: r.zoneId,
            months: drafts[r.key] === '' || drafts[r.key] == null ? null : Number(drafts[r.key]),
            durationWeeks: durationDrafts[r.key] === '' || durationDrafts[r.key] == null ? null : Number(durationDrafts[r.key]),
            targetDate: targetDateDrafts[r.key] || undefined,
          })),
      });
      // Step 2 (§8a): dry-run the project reschedule WITHOUT writing.
      const resp = await client.post(`/scheduling/projects/${projectId}/preview-reschedule`);
      return (resp.data?.data ?? resp.data) as PreviewResult;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['project-deliverables', projectId] });
      // Seed per-row choices: default apply=true for rows that WILL
      // move; non-moving rows start unselected so the "Apply approved
      // (N)" count is accurate from the first render.
      const seed: Record<number, { apply: boolean; end: string }> = {};
      for (const r of data.preview) {
        seed[r.taskId] = {
          apply: r.willMove,
          end: r.afterEnd ?? r.beforeEnd ?? '',
        };
      }
      setReviewChoices(seed);
      setPreview(data.preview);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to preview reschedule'),
    onSettled: () => setPreviewing(false),
  });

  const applyMutation = useMutation({
    mutationFn: async (taskIds: number[]): Promise<SaveAndUpdateResult> => {
      const resp = await client.post(
        `/scheduling/projects/${projectId}/save-and-update-due-dates`,
        { taskIds },
      );
      return (resp.data?.data ?? resp.data) as SaveAndUpdateResult;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-deliverables', projectId] });
      notify.success(
        data.autoApplied.length > 0
          ? `Applied ${data.autoApplied.length} task date${data.autoApplied.length === 1 ? '' : 's'}`
          : 'Review closed · no task dates changed',
      );
      setPreview(null);
      setReviewChoices({});
    },
    onError: (err: any) => notify.apiError(err, 'Failed to apply approved task dates'),
  });

  const confirmReview = () => {
    if (!preview) return;
    const taskIds = preview
      .filter((r) => reviewChoices[r.taskId]?.apply)
      .map((r) => r.taskId);
    if (taskIds.length === 0) {
      // Nothing selected → close the modal without touching the DB.
      setPreview(null);
      setReviewChoices({});
      return;
    }
    applyMutation.mutate(taskIds);
  };

  const attemptSaveAndUpdate = () => {
    // Preflight — same per-task conflict check that the plain Save
    // uses. If any task's current endDate is strictly past the new
    // target, surface the Update/Keep prompt first; the preview
    // runs afterwards (confirmExceed path chains into `previewMutation`).
    const offenders = findExceedingTasks();
    if (offenders) {
      const defaults: Record<number, 'update' | 'keep'> = {};
      for (const o of offenders) defaults[o.taskId] = 'update';
      setExceedChoices(defaults);
      setExceedPrompt(offenders);
      // Mark intent so confirmExceed knows to chain into the preview
      // flow after the conflicts clear.
      setExceedNextAction('saveAndUpdate');
      return;
    }
    setPreviewing(true);
    previewMutation.mutate();
  };

  // When the per-task exceed-prompt confirms, we either stop (plain
  // Save flow) or chain into the scheduling reschedule (Save & update
  // flow). This small state carries the intent between the two
  // modals.
  const [exceedNextAction, setExceedNextAction] = useState<'save' | 'saveAndUpdate'>('save');

  const hasUnsavedChanges = useMemo(() => {
    for (const r of rows) {
      // DP-EMPTY-3 — read-only (synthetic) rows never contribute to
      // dirty state; the inputs are disabled and their draft entries
      // stay at server-null.
      if (r.readOnly) continue;
      const draft = drafts[r.key] ?? '';
      const server = r.savedMonths == null ? '' : String(r.savedMonths);
      if (draft !== server) return true;
      const durDraft = durationDrafts[r.key] ?? '';
      const durServer = r.savedDurationWeeks == null ? '' : String(r.savedDurationWeeks);
      if (durDraft !== durServer) return true;
      // A Gantt target-date drag writes ONLY targetDateDrafts. This dimension
      // was missing from the dirty check, so such a drag left "Save all"
      // disabled and no unsaved banner — the drag was silently lost on refresh.
      // Only a row that was actually dragged has an entry here, so unchanged
      // rows never register as dirty.
      const tgtDraft = targetDateDrafts[r.key];
      if (tgtDraft != null && tgtDraft !== '' && tgtDraft !== (r.savedDate ?? '')) return true;
    }
    return false;
  }, [rows, drafts, durationDrafts, targetDateDrafts]);

  const resetDrafts = () => {
    const initial: Record<string, string> = {};
    const initialDur: Record<string, string> = {};
    for (const r of rows) {
      if (r.savedMonths != null) initial[r.key] = String(r.savedMonths);
      if (r.savedDurationWeeks != null) initialDur[r.key] = String(r.savedDurationWeeks);
    }
    setDrafts(initial);
    setDurationDrafts(initialDur);
    // Discard pending Gantt target-date drags too (pristine state is empty).
    // Previously Reset skipped this, so a dragged-but-reset row still had a
    // stale target-date draft that got persisted on the next save.
    setTargetDateDrafts({});
  };

  // Available service options for the PR-012 multi-select. Unique
  // deliverable service names present on the current rows, in stable
  // order. Rows with no service name go through a synthetic "— No
  // service" bucket so the user can still narrow to them.
  const NO_SERVICE_KEY = '__no_service__';
  const NO_SERVICE_LABEL = '— No service';
  const availableServices = useMemo(() => {
    const seen = new Map<string, string>(); // key → label
    for (const r of rows) {
      const key = r.serviceName ?? NO_SERVICE_KEY;
      const label = r.serviceName ?? NO_SERVICE_LABEL;
      if (!seen.has(key)) seen.set(key, label);
    }
    return Array.from(seen.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);

  // Filtered rows for display (only affects the visible view; save
  // still writes all rows).
  //
  // Filter chain (all AND-composed): due-date select → PR-012 service
  // multi-select (OR-within). PR-012 never touches the save payload —
  // TableView/GanttView receive the filtered list only.
  const visibleRows = useMemo(() => {
    let out = rows;
    if (filterHasDue === 'yes') {
      out = out.filter((r) => (drafts[r.key] ?? r.savedMonths ?? '') !== '' && (drafts[r.key] ?? r.savedMonths ?? '') !== null);
    } else if (filterHasDue === 'no') {
      out = out.filter((r) => (drafts[r.key] ?? r.savedMonths ?? '') === '' || (drafts[r.key] ?? r.savedMonths ?? '') == null);
    }
    if (serviceFilter.size > 0) {
      out = out.filter((r) => serviceFilter.has(r.serviceName ?? NO_SERVICE_KEY));
    }
    return out;
  }, [rows, drafts, filterHasDue, serviceFilter]);

  // DP-6 · Bulk-collapse toolbar handlers. `collapseAll` uses the
  // CURRENTLY VISIBLE rows so a filtered view collapses only what the
  // user can see; `expandAll` clears the set outright (also expands any
  // groups that were collapsed but hidden by filters — the intent of
  // "expand all" is "leave nothing collapsed").
  const collapseAll = () => {
    const keys = new Set<string>();
    for (const r of visibleRows) keys.add(rowDimKey(r, outerDim));
    setCollapsed(keys);
  };
  const expandAll = () => setCollapsed(new Set());

  // Belt-and-suspenders against the empty-flip race: gate on BOTH queries
  // (not just `deliverables`) so "no deliverables yet" cannot render while
  // planning is still loading / refetching and tasks are momentarily empty.
  if (isLoading || planningIsLoading || planningData === undefined) return <div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">Loading deliverables...</div>;
  if (rows.length === 0) {
    return (
      <div className="py-12 text-center">
        <Layers className="mx-auto h-12 w-12 text-slate-300 dark:text-slate-600" />
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">This project has no deliverables yet. Add deliverables in Project Setup — the grid then fills in one row per zone × deliverable, even before any tasks exist.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Per-task conflict prompt (client feedback 2026-08-08).
          Replaces the old hard block with a notify-and-update flow:
          list every task whose current Due is after the new deliverable
          target, let the PM choose per-task whether to overwrite the
          task's Due with the target OR keep it as-is, then continue
          with the save. "Apply to all" (Update / Keep) flips the whole
          list at once. */}
      {exceedPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 backdrop-blur-sm" onClick={() => !exceedApplying && setExceedPrompt(null)}>
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[720px] max-w-[92vw] max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-600" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Some tasks end after the new deliverable target</h3>
                <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Pick per task whether to update the task's Due date to the new deliverable target, or keep it as-is. The save proceeds either way.
                </p>
              </div>
            </div>
            {/* Bulk-toggle bar — "Apply to all" affordance. */}
            <div className="px-5 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2 text-[12px] bg-slate-50/60 dark:bg-slate-800/40">
              <span className="font-semibold text-slate-500 dark:text-slate-400">Apply to all:</span>
              <button
                type="button"
                disabled={exceedApplying}
                onClick={() => {
                  const next: Record<number, 'update' | 'keep'> = {};
                  for (const o of exceedPrompt) next[o.taskId] = 'update';
                  setExceedChoices(next);
                }}
                className="px-2.5 py-1 rounded-md border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 font-semibold disabled:opacity-50"
              >
                Update all to target
              </button>
              <button
                type="button"
                disabled={exceedApplying}
                onClick={() => {
                  const next: Record<number, 'update' | 'keep'> = {};
                  for (const o of exceedPrompt) next[o.taskId] = 'keep';
                  setExceedChoices(next);
                }}
                className="px-2.5 py-1 rounded-md border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold disabled:opacity-50"
              >
                Keep all as-is
              </button>
              <span className="ml-auto text-slate-400 dark:text-slate-500 tabular-nums">
                {exceedPrompt.filter((t) => exceedChoices[t.taskId] === 'update').length} of {exceedPrompt.length} will update
              </span>
            </div>
            <div className="p-5 space-y-2 overflow-auto">
              {exceedPrompt.map((t) => {
                const choice = exceedChoices[t.taskId] ?? 'update';
                return (
                  <div key={t.taskId} className="border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 shrink-0 tabular-nums">{t.code ?? '—'}</span>
                      <span className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate">{t.taskName}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px] text-slate-500 dark:text-slate-400">
                      <span>{t.deliverableName} · {t.zoneName}</span>
                      <span className="text-slate-300 dark:text-slate-600">·</span>
                      <span>current due <span className="font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-200">{t.endDate}</span></span>
                      <span className="text-slate-300 dark:text-slate-600">→ new target</span>
                      <span className="font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-200">{t.targetDate}</span>
                    </div>
                    <div className="mt-2 inline-flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
                      <button
                        type="button"
                        disabled={exceedApplying}
                        onClick={() => setExceedChoices((s) => ({ ...s, [t.taskId]: 'update' }))}
                        className={cn('px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-50', choice === 'update' ? 'bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}
                      >
                        Update to target
                      </button>
                      <button
                        type="button"
                        disabled={exceedApplying}
                        onClick={() => setExceedChoices((s) => ({ ...s, [t.taskId]: 'keep' }))}
                        className={cn('px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-50', choice === 'keep' ? 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}
                      >
                        Keep as-is
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
              <button
                type="button"
                disabled={exceedApplying}
                onClick={() => setExceedPrompt(null)}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={exceedApplying}
                onClick={confirmExceed}
                className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50"
              >
                {exceedApplying ? 'Applying…' : 'Confirm and save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Overridden-tasks confirm modal (Tier E #10) */}
      {overrideConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={() => setOverrideConfirm(null)}>
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[540px] max-w-[92vw] max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Some tasks have manual due dates</h3>
                <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-0.5">
                  These tasks were previously set by their assignee or a manager. Keep the manual date, or overwrite with the new target?
                </p>
              </div>
            </div>
            <div className="p-5 space-y-2">
              {overrideConfirm.map((t) => (
                <div key={t.taskId} className="flex items-center gap-2 text-[13px] border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                  <span className="flex-1 font-medium text-slate-800 dark:text-slate-100 truncate">{t.taskName}</span>
                  <span className="text-slate-400 dark:text-slate-500 tabular-nums">{t.currentDue ?? '—'}</span>
                  <span className="text-slate-300 dark:text-slate-600">→</span>
                  <span className="text-emerald-600 tabular-nums">{t.targetDate ?? '—'}</span>
                  <button
                    type="button"
                    onClick={() => forceApply.mutate(t.taskId)}
                    className="ml-2 bg-amber-600 hover:bg-amber-700 text-white text-[12px] font-semibold px-2.5 py-1 rounded-md"
                  >
                    Overwrite
                  </button>
                </div>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
              <button
                onClick={() => setOverrideConfirm(null)}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
              >
                Keep all manual dates
              </button>
            </div>
          </div>
        </div>
      )}

      {/* §8a · Review modal (Save & update due dates). While the
          preview-reschedule is in flight we show an indeterminate
          pulse bar; once the diff arrives we render the moving tasks
          in the shared `TasksEditorTable`. Each row carries a
          violatesTarget amber dot and a hoursLogged chip when
          relevant. Confirm POSTs the user-selected taskIds to
          `save-and-update-due-dates`, which is the single commit
          endpoint — the scheduler re-runs for those tasks only. */}
      {/* §8b.1 (2026-11-11) · Mount/unmount animation now routed
          through `AnimatedModalShell` (overlay fade + card
          fade+scale, reduced-motion aware). The previous
          `animate-fade-in` / `animate-scale-in` classes didn't exist
          as utilities — the modal popped in with no transition. */}
      <AnimatedModalShell
        open={Boolean(previewing || preview)}
        cardClassName="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[1040px] max-w-[92vw] max-h-[85vh] flex flex-col"
      >
        <>
          <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                סקירת עדכון תאריכים
              </h3>
              <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5" dir="rtl">
                {previewing && !preview
                  ? 'מחשב תצוגה מקדימה…'
                  : (preview?.filter((p) => p.willMove).length ?? 0) === 0
                    ? 'אין שינויים'
                    : `${preview!.filter((p) => p.willMove).length} משימות יזוזו · אשר להחלה`}
              </p>
              {/* Progress bar — indeterminate while previewing,
                  deterministic (100%) once the diff is in hand so the
                  user can see the dry-run completed. */}
              <div className="mt-3 w-full h-1 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                {previewing && !preview ? (
                  <div className="h-full w-full bg-blue-600 rounded-full animate-pulse" />
                ) : (
                  <div
                    className="h-full bg-blue-600 rounded-full transition-all duration-400"
                    style={{ width: '100%' }}
                  />
                )}
              </div>
            </div>

            <div className="p-5 overflow-y-auto">
              {previewing && !preview ? (
                <div className="py-6 text-center text-[12px] text-slate-500 dark:text-slate-400">
                  מחשב תצוגה מקדימה… no database writes yet.
                </div>
              ) : preview && preview.filter((p) => p.willMove).length === 0 ? (
                <div className="py-6 text-center text-[12px] text-slate-500 dark:text-slate-400" dir="rtl">
                  אין שינויים
                </div>
              ) : (
                /* §8a · Preview rows rendered via `TasksEditorTable`
                   (mode='review'). We pass only the moving tasks
                   (`willMove=true`) so the modal focuses the PM on
                   actual changes; the extended row carries
                   violatesTarget + hoursLogged markers in the REASON
                   cell. Columns: CODE · TASK · MARKERS · START · DUE
                   · ACTION. */
                <TasksEditorTable
                  mode="review"
                  tasks={(preview ?? [])
                    .filter((p) => p.willMove)
                    .map((p) => ({
                      taskId: p.taskId,
                      taskCode: p.code,
                      taskName: p.name,
                      context: null,
                      reason: null,
                      currentStart: p.beforeStart,
                      proposedStart: p.afterStart,
                      currentEnd: p.beforeEnd,
                      proposedEnd: p.afterEnd,
                      violatesTarget: p.violatesTarget,
                      hoursLogged: p.hoursLogged,
                    }))}
                  choices={reviewChoices}
                  disabled={applyMutation.isPending}
                  onEdit={(taskId, end) =>
                    setReviewChoices((s) => ({
                      ...s,
                      [Number(taskId)]: { apply: s[Number(taskId)]?.apply ?? true, end },
                    }))
                  }
                  onKeepCurrent={(taskId) =>
                    setReviewChoices((s) => ({
                      ...s,
                      [Number(taskId)]: {
                        apply: false,
                        end: s[Number(taskId)]?.end ?? '',
                      },
                    }))
                  }
                  onApplyProposed={(taskId) =>
                    setReviewChoices((s) => ({
                      ...s,
                      [Number(taskId)]: {
                        apply: true,
                        end: s[Number(taskId)]?.end ?? '',
                      },
                    }))
                  }
                />
              )}
            </div>

            <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
              <button
                type="button"
                disabled={(previewing && !preview) || applyMutation.isPending}
                onClick={() => {
                  setPreview(null);
                  setReviewChoices({});
                }}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg disabled:opacity-50"
              >
                ביטול
              </button>
              <button
                type="button"
                disabled={
                  !preview ||
                  applyMutation.isPending ||
                  (previewing && !preview) ||
                  preview.filter((p) => p.willMove).length === 0 ||
                  preview.filter((p) => reviewChoices[p.taskId]?.apply).length === 0
                }
                onClick={confirmReview}
                className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg border-none disabled:opacity-50"
              >
                {applyMutation.isPending
                  ? 'Applying…'
                  : `החל מאושרים (${preview?.filter((p) => reviewChoices[p.taskId]?.apply).length ?? 0})`}
              </button>
            </div>
          </>
        </AnimatedModalShell>

      {/* Header controls — UI-16 · title/description on top, toolbar
          starts at the page's left gutter on its own row (same left
          edge as the grid header below). Previously the toolbar lived
          on the right of the title row via `ml-auto`, which offset it
          from the grid gutter; split into two rows so the controls
          now align with the grid. Inter-control spacing (gap-2) stays
          as-is. */}
      <div className="space-y-3">
        <div>
          <h2 className="text-[15px] font-bold text-slate-900 dark:text-slate-100">Deliverable Planning</h2>
          <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">
            Set a target date per (zone × deliverable) as "N months from the base date". Dates snap forward to the next Sunday.
          </p>
        </div>
        {/* §8f (2026-11-12) · Compact filter row. Stacked uppercase
            labels above each control were converted to tooltips so the
            whole bar fits on one line down to ~1200px viewports and the
            right-aligned action cluster (Reset / Save / Save & update)
            stops wrapping at 1440px. `items-center` reads better now
            that no child carries a vertical label stack; `flex-wrap`
            stays as a safety net for narrow viewports. */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* UI-14 · Group + sub-group — same control the Planning tab
              uses. Default primary=Deliverable, sub=Zone preserves the
              DP-DISP-1 ordering (Gantt label column reads "Deliverable
              · Zone"); flipping either dim regroups the Table rows
              AND relabels the Gantt row-label header. State is per-
              project in localStorage (see `groupingKey`). §8f: external
              "Grouping" label dropped — GroupControl ships its own
              inline "Group" prefix; wrapper carries the tooltip. */}
          <div className="shrink-0" title="Grouping">
            <GroupControl
              primary={grouping.primary}
              secondary={grouping.secondary}
              onChangePrimary={(p) => setGrouping((g) => {
                // When primary changes to the current secondary, drop
                // the secondary — matches the Planning tab's guard.
                const nextSec = p && g.secondary === p ? null : g.secondary;
                return { primary: p, secondary: p ? nextSec : null };
              })}
              onChangeSecondary={(s) => setGrouping((g) => ({ ...g, secondary: s }))}
            />
          </div>
          {/* PR-012 · Service (Phase) multi-select. Sourced from the
              service names appearing on the current rows so options
              never surface something with zero matches. Composes with
              the Due-date select on the right and the per-column text
              filters inside the table. §8f: trigger narrowed w-52 → w-40. */}
          <div className="shrink-0">
            <MultiSelectFilter
              options={availableServices}
              selected={serviceFilter}
              onChange={setServiceFilter}
              placeholder="Services"
              title="Service — filter by service"
              triggerClassName="w-40"
            />
          </div>
          <div className="shrink-0">
            <select
              value={filterHasDue}
              onChange={(e) => setFilterHasDue(e.target.value as any)}
              title="Due date"
              className="w-24 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
            >
              <option value="">All</option>
              <option value="yes">With target</option>
              <option value="no">Missing target</option>
            </select>
          </div>
          <div className="shrink-0">
            <input
              type="date"
              value={baseDate}
              onChange={(e) => setBaseDate(e.target.value)}
              title="Base date"
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('table')}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold', viewMode === 'table' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}
              title="Table view"
            >
              <LayoutGrid className="h-3.5 w-3.5" /> Table
            </button>
            <button
              type="button"
              onClick={() => setViewMode('gantt')}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold', viewMode === 'gantt' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}
              title="Gantt view"
            >
              <GanttChart className="h-3.5 w-3.5" /> Gantt
            </button>
          </div>
          {/* DP-6 · Collapse / Expand all deliverable groups. Shared
              across the Table + Gantt views because the underlying set
              is lifted to this parent (and persisted per project).
              §8f: icon-only buttons — labels moved into `title` for
              a11y. Saves ~100px so the action cluster stays inline. */}
          <div className="shrink-0 flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
            <button
              type="button"
              onClick={collapseAll}
              aria-label="Collapse all"
              className="w-8 h-8 flex items-center justify-center rounded-md text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-100"
              title="Collapse all — collapse every deliverable group"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={expandAll}
              aria-label="Expand all"
              className="w-8 h-8 flex items-center justify-center rounded-md text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-100"
              title="Expand all — expand every deliverable group"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* §8d (2026-11-12) · Action cluster stays glued together on
              the right edge even when filter chips wrap. The outer
              toolbar is `flex-wrap`, so without this inner `flex-nowrap`
              wrapper the primary "Save & update due dates" button (the
              widest) drops to its own row the moment the toolbar fills
              up. `ml-auto` pushes the whole cluster right. */}
          <div className="ml-auto flex items-end gap-2 flex-nowrap">
            {hasUnsavedChanges && (
              <button
                type="button"
                onClick={resetDrafts}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 text-[13px] font-semibold"
                title="Discard unsaved changes"
              >
                <RefreshCcw className="h-3.5 w-3.5" /> Reset
              </button>
            )}
            {/* D4 · Two save buttons side-by-side (replacing the single
                "Save all" primary). Secondary Save persists deliverable
                targets without touching task dates; primary Save & update
                due dates runs the project-wide reschedule and surfaces
                problematic tasks for PM review. */}
            <button
              type="button"
              onClick={attemptSave}
              disabled={!hasUnsavedChanges || save.isPending || previewing}
              className="flex items-center gap-1.5 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-300 text-[13px] font-semibold px-3.5 py-2 rounded-lg disabled:opacity-50"
              title="Save deliverable targets without previewing a task reschedule"
            >
              <Save className="h-3.5 w-3.5" aria-hidden="true" />
              {save.isPending ? 'Saving...' : 'Save'}
            </button>
            {/* §7.2 (2026-11-11) · `whitespace-nowrap` keeps the Hebrew
                label on a single line when the toolbar gets crowded with
                filters open. The label itself stays untouched. */}
            <button
              type="button"
              onClick={attemptSaveAndUpdate}
              disabled={save.isPending || previewing || previewMutation.isPending || applyMutation.isPending}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg border-none disabled:opacity-50 whitespace-nowrap"
              title="Save deliverable targets and preview every task's proposed new dates before committing (§8a)"
            >
              <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
              {previewing || previewMutation.isPending ? 'Scheduling…' : 'Save & update due dates'}
            </button>
          </div>
        </div>
      </div>

      {/* PR-012 · when the tab-level filters (service + due-date) hide
          every row, fall through to the shared EmptyState so the user
          knows nothing matched and can clear the picks. `rows.length
          > 0` guards this — the "no deliverables yet" path is handled
          earlier and returns before the header renders. */}
      {visibleRows.length === 0 ? (
        <EmptyState
          icon={Filter}
          title="No deliverables match the active filters"
          description="Adjust the Service or Due-date filter above to see more rows, or clear both to see everything."
        />
      ) : viewMode === 'table' ? (
        <TableView
          projectId={projectId}
          rows={visibleRows}
          drafts={drafts}
          setDrafts={setDrafts}
          durationDrafts={durationDrafts}
          setDurationDrafts={setDurationDrafts}
          targetDateDrafts={targetDateDrafts}
          computePreview={computePreview}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          outerDim={outerDim}
          innerDim={innerDim}
          topLevelZoneTypeMap={topLevelZoneInfo.typeMap}
          topLevelZoneSortOrderMap={topLevelZoneInfo.sortOrderMap}
        />
      ) : (
        <GanttView
          projectId={projectId}
          rows={visibleRows}
          drafts={drafts}
          durationDrafts={durationDrafts}
          targetDateDrafts={targetDateDrafts}
          setDrafts={setDrafts}
          setDurationDrafts={setDurationDrafts}
          setTargetDateDrafts={setTargetDateDrafts}
          computePreview={computePreview}
          baseDate={baseDate}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          outerDim={outerDim}
          innerDim={innerDim}
          topLevelZoneTypeMap={topLevelZoneInfo.typeMap}
          topLevelZoneSortOrderMap={topLevelZoneInfo.sortOrderMap}
        />
      )}

      {hasUnsavedChanges && (
        <p className="text-[12px] text-blue-600 font-medium">
          You have unsaved changes. Click <span className="font-bold">Save</span> to persist targets, or <span className="font-bold">Save &amp; update due dates</span> to reschedule tasks too.
        </p>
      )}
    </div>
  );
}

/**
 * Table view — grouped by Deliverable (primary), Zone rows underneath.
 * Every column supports sort + per-column filter. Data rendered as
 * plain text (no chips/pills) per client 2026-08-02 revision.
 */
function TableView({
  projectId,
  rows,
  drafts,
  setDrafts,
  durationDrafts,
  setDurationDrafts,
  targetDateDrafts,
  computePreview,
  collapsed,
  onToggleCollapse,
  outerDim,
  innerDim,
  topLevelZoneTypeMap,
  topLevelZoneSortOrderMap,
}: {
  // Needed for `useProjectTabState` (per-project persistence of sort,
  // per-column filters, open-filter popover). Without it a tab round-
  // trip to Planning and back drops the user's sort + column filters
  // (TableView unmounts with its parent DeliverablePlanningTab).
  projectId: number;
  rows: any[];
  drafts: Record<string, string>;
  setDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  durationDrafts: Record<string, string>;
  setDurationDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  // DP-2 · read-only view of the Gantt drag drafts, so the deliverable-
  // header rollup resolves the latest target date the same way GanttRow
  // does (`targetDateDrafts[r.key] || computePreview(draft) || savedDate`).
  targetDateDrafts: Record<string, string>;
  computePreview: (m: string) => string;
  // DP-6 · Collapse state (shared with GanttView, persisted per-project
  // in the parent). Absent from the set = the group is expanded.
  // UI-14 — now a Set<string> keyed by outer-dim group key.
  collapsed: Set<string>;
  onToggleCollapse: (key: string) => void;
  // UI-14 · Group + sub-group dims flow in from the parent so the Table
  // can regroup by Zone / Deliverable / Service and relabel the first
  // two columns dynamically. Default stays Deliverable · Zone.
  outerDim: DPGroupDim;
  innerDim: DPGroupDim | null;
  // DP-4 parity (2026-10-21) — top-level zone type (for the Building badge)
  // and sort order (for Planning-tab parity) keyed by top-level zone id.
  // Threaded in from the parent's `topLevelZoneInfo` so TableView doesn't
  // have to re-walk the zone tree.
  topLevelZoneTypeMap: Map<number, string | undefined>;
  topLevelZoneSortOrderMap: Map<number, number>;
}) {
  // Per-column filters — arrays of selected values (empty = no filter).
  // A row passes a column filter if its value is IN the selected array.
  // Values are cascading: each column's filter dropdown shows only the
  // values that are still available given the OTHER columns' filters,
  // so users can drill down without seeing dead options.
  // DP-3 · `hours` joined the union so the new Hours column sorts and
  // filters like every other numeric column.
  type ColKey = 'deliverable' | 'zone' | 'service' | 'months' | 'duration' | 'hours' | 'target';
  const ALL_COLS: ColKey[] = ['deliverable', 'zone', 'service', 'months', 'duration', 'hours', 'target'];
  // Persisted per-project so tab round-trips keep the sort + per-column
  // filter picks (2026-11-08). `openFilter` is the popover-open flag and
  // stays in-memory — a dropdown that re-opens on remount surprises the
  // user more than it helps.
  const [colFilters, setColFilters] = useProjectTabState<Record<ColKey, string[]>>(
    projectId,
    'dp-table-col-filters',
    { deliverable: [], zone: [], service: [], months: [], duration: [], hours: [], target: [] },
  );
  const [openFilter, setOpenFilter] = useState<null | ColKey>(null);
  // Sort state — one column at a time; asc/desc toggle.
  const [sort, setSort] = useProjectTabState<{ col: ColKey; dir: 'asc' | 'desc' }>(
    projectId,
    'dp-table-sort',
    { col: 'deliverable', dir: 'asc' },
  );

  // Effective raw values a row contributes to each column (for both
  // the filter matcher and the "available options" derivation).
  const rowValue = (r: any, col: ColKey): string => {
    if (col === 'deliverable') return r.deliverableName ?? '';
    if (col === 'zone') return r.zoneName ?? '';
    if (col === 'service') return r.serviceName ?? '';
    if (col === 'months') {
      const draft = drafts[r.key] ?? '';
      return draft || (r.savedMonths == null ? '' : String(r.savedMonths));
    }
    if (col === 'duration') {
      const draft = durationDrafts[r.key] ?? '';
      return draft || (r.savedDurationWeeks == null ? '' : String(r.savedDurationWeeks));
    }
    if (col === 'hours') {
      // Hours is server-derived (Σ budgetHours per group) — no draft,
      // so the raw row value is the sort/filter key.
      return r.hours != null ? String(r.hours) : '';
    }
    // target
    const draft = drafts[r.key] ?? '';
    return targetDateDrafts[r.key] || computePreview(draft) || r.savedDate || '';
  };

  // Helper: does a row pass the currently selected filter for a given
  // column? Called both by the visible-rows pipeline and by the
  // "available options" builder (which excludes the requesting column).
  const rowPassesCol = (r: any, col: ColKey, filters: Record<ColKey, string[]>): boolean => {
    const sel = filters[col];
    if (!sel || sel.length === 0) return true;
    const v = rowValue(r, col) || '(empty)';
    return sel.includes(v);
  };

  // Visible rows: pass every column filter.
  const filtered = useMemo(
    () => rows.filter((r) => ALL_COLS.every((c) => rowPassesCol(r, c, colFilters))),
    [rows, drafts, durationDrafts, targetDateDrafts, colFilters],
  );

  // For a given column, build the list of distinct values the user
  // CAN currently pick — computed against rows that pass every OTHER
  // filter (cascading). Result is `{ value, selected, count }[]`.
  const optionsFor = (col: ColKey) => {
    const otherCols = ALL_COLS.filter((c) => c !== col);
    const eligible = rows.filter((r) => otherCols.every((c) => rowPassesCol(r, c, colFilters)));
    const counts = new Map<string, number>();
    for (const r of eligible) {
      const v = rowValue(r, col) || '(empty)';
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const sel = new Set(colFilters[col] ?? []);
    return Array.from(counts.entries())
      .map(([value, count]) => ({ value, count, selected: sel.has(value) }))
      .sort((a, b) => a.value.localeCompare(b.value));
  };

  const toggleFilterValue = (col: ColKey, value: string) => {
    setColFilters((s) => {
      const cur = new Set(s[col]);
      if (cur.has(value)) cur.delete(value); else cur.add(value);
      return { ...s, [col]: Array.from(cur) };
    });
  };
  const clearFilter = (col: ColKey) => setColFilters((s) => ({ ...s, [col]: [] }));
  const selectAll = (col: ColKey) => {
    const all = optionsFor(col).map((o) => o.value);
    setColFilters((s) => ({ ...s, [col]: all }));
  };

  // Effective date for sort/display. Uses the SAME resolution order the
  // Gantt bar geometry uses (see line ~1647): explicit-date draft →
  // months preview → saved server value.
  const effectiveDate = (r: any) => {
    const draft = drafts[r.key] ?? '';
    return targetDateDrafts[r.key] || computePreview(draft) || r.savedDate || '';
  };
  const effectiveMonths = (r: any) => {
    const draft = drafts[r.key] ?? '';
    return draft || (r.savedMonths == null ? '' : String(r.savedMonths));
  };
  const effectiveDuration = (r: any) => {
    const draft = durationDrafts[r.key] ?? '';
    return draft || (r.savedDurationWeeks == null ? '' : String(r.savedDurationWeeks));
  };
  const effectiveHours = (r: any) => Number(r.hours || 0);

  // DP-2 · Per-group rollup summary. Iterates the group's zone rows
  // using the same effective-value helpers so it stays honest to whatever
  // the user has drafted; a zero-out row contributes 0, a row with no
  // date at all is skipped for the "latest end date" calculation. Kept
  // inside TableView because it depends on drafts + targetDateDrafts.
  const groupRollup = (zones: any[]): { totalWeeks: number; totalHours: number; latestDate: string | null } => {
    let totalWeeks = 0;
    let totalHours = 0;
    let latestMs = -Infinity;
    for (const r of zones) {
      const w = Number(effectiveDuration(r) || 0);
      if (Number.isFinite(w)) totalWeeks += w;
      totalHours += Number(r.hours || 0);
      const iso = effectiveDate(r);
      if (iso) {
        const ms = new Date(iso).getTime();
        if (Number.isFinite(ms) && ms > latestMs) latestMs = ms;
      }
    }
    const latestDate = latestMs === -Infinity ? null : new Date(latestMs).toISOString().slice(0, 10);
    return { totalWeeks, totalHours, latestDate };
  };

  // Sort within the same group. UI-14 — groups are now bucketed by the
  // configurable outer dim (default: Deliverable). readOnly propagates
  // from the zone row (DP-EMPTY-3) ONLY when outerDim='deliverable' so
  // we keep the "not yet planned" badge honest; the flag has no meaning
  // under a Zone or Service bucketing (a zone/service bucket mixes
  // real and synthetic rows).
  const sortedGroups = useMemo(() => {
    type Group = { key: string; label: string; deliverableId: number; serviceName: string | null; zones: any[]; readOnly: boolean; readOnlyReason: string | null };
    const map = new Map<string, Group>();
    for (const r of filtered) {
      const k = rowDimKey(r, outerDim);
      if (!map.has(k)) {
        map.set(k, {
          key: k,
          label: rowDimLabel(r, outerDim),
          // Keep the first row's deliverableId / serviceName for the
          // Drive button + rollup display; they're only used when the
          // outer dim is 'deliverable' / 'service' respectively.
          deliverableId: r.deliverableId,
          serviceName: r.serviceName,
          zones: [],
          readOnly: outerDim === 'deliverable' ? !!r.readOnly : false,
          readOnlyReason: outerDim === 'deliverable' ? (r.readOnlyReason ?? null) : null,
        });
      }
      map.get(k)!.zones.push(r);
    }
    const groups = Array.from(map.values());

    // Sort the groups
    const sign = sort.dir === 'asc' ? 1 : -1;
    const cmp = (a: string | number, b: string | number) => (a > b ? 1 : a < b ? -1 : 0) * sign;
    // DP-4 parity (2026-10-21) — when grouping by Zone, the default
    // "deliverable" sort (which falls back to label alphabetical) differs
    // from Planning's canonical `sortOrder ASC, name ASC` order. For
    // zone grouping on the default sort, follow Planning: use the top-
    // level zone's `sortOrder` with a name tiebreak. Picking a column
    // explicitly (clicking a header) still overrides this.
    if (outerDim === 'zone' && sort.col === 'deliverable') {
      groups.sort((a, b) => {
        const aTopId = a.zones[0]?.topLevelZoneId as number | null | undefined;
        const bTopId = b.zones[0]?.topLevelZoneId as number | null | undefined;
        const aOrder = aTopId == null ? Number.POSITIVE_INFINITY : (topLevelZoneSortOrderMap.get(aTopId) ?? 0);
        const bOrder = bTopId == null ? Number.POSITIVE_INFINITY : (topLevelZoneSortOrderMap.get(bTopId) ?? 0);
        if (aOrder !== bOrder) return cmp(aOrder, bOrder);
        return cmp(a.label.toLowerCase(), b.label.toLowerCase());
      });
    }
    else if (sort.col === 'deliverable') groups.sort((a, b) => cmp(a.label.toLowerCase(), b.label.toLowerCase()));
    else if (sort.col === 'service') groups.sort((a, b) => cmp((a.serviceName ?? '').toLowerCase(), (b.serviceName ?? '').toLowerCase()));
    else if (sort.col === 'zone') groups.sort((a, b) => cmp((a.zones[0]?.zoneName ?? '').toLowerCase(), (b.zones[0]?.zoneName ?? '').toLowerCase()));
    else if (sort.col === 'months') groups.sort((a, b) => cmp(Number(effectiveMonths(a.zones[0]) || 0), Number(effectiveMonths(b.zones[0]) || 0)));
    else if (sort.col === 'duration') groups.sort((a, b) => cmp(Number(effectiveDuration(a.zones[0]) || 0), Number(effectiveDuration(b.zones[0]) || 0)));
    else if (sort.col === 'hours') groups.sort((a, b) => cmp(effectiveHours(a.zones[0]), effectiveHours(b.zones[0])));
    else if (sort.col === 'target') groups.sort((a, b) => cmp(effectiveDate(a.zones[0]) || '', effectiveDate(b.zones[0]) || ''));

    // DPG-1c (2026-10-20) — Pin "Project Root" (orphan tasks, zoneId=null)
    // to the TOP of a Zone grouping, regardless of the active column sort.
    // The group only EXISTS when at least one row has `topLevelZoneId=null`,
    // so pinning this way never conjures an empty synthetic row: no root
    // tasks ⇒ no `zone:root` group in `map` ⇒ nothing to hoist. Idempotent
    // on repeated sorts because `splice` removes before `unshift` re-adds.
    if (outerDim === 'zone') {
      const rootIdx = groups.findIndex((g) => g.key === 'zone:root');
      if (rootIdx > 0) {
        const [root] = groups.splice(rootIdx, 1);
        groups.unshift(root);
      }
    }

    // Sort zone rows within each group
    for (const g of groups) {
      const zsign = sort.dir === 'asc' ? 1 : -1;
      const zcmp = (a: string | number, b: string | number) => (a > b ? 1 : a < b ? -1 : 0) * zsign;
      if (sort.col === 'zone' || sort.col === 'deliverable' || sort.col === 'service') {
        g.zones.sort((a: any, b: any) => zcmp(a.zoneName.toLowerCase(), b.zoneName.toLowerCase()));
      } else if (sort.col === 'months') {
        g.zones.sort((a: any, b: any) => zcmp(Number(effectiveMonths(a) || 0), Number(effectiveMonths(b) || 0)));
      } else if (sort.col === 'duration') {
        g.zones.sort((a: any, b: any) => zcmp(Number(effectiveDuration(a) || 0), Number(effectiveDuration(b) || 0)));
      } else if (sort.col === 'hours') {
        g.zones.sort((a: any, b: any) => zcmp(effectiveHours(a), effectiveHours(b)));
      } else if (sort.col === 'target') {
        g.zones.sort((a: any, b: any) => zcmp(effectiveDate(a) || '', effectiveDate(b) || ''));
      }
    }
    return groups;
  }, [filtered, sort, drafts, durationDrafts, targetDateDrafts, outerDim, topLevelZoneSortOrderMap]);

  const toggleSort = (col: typeof sort.col) => {
    setSort((s) => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }));
  };

  return (
    // §7.1 (2026-11-11) · Removed the `overflow-x-auto` that used to wrap
    // the Table view. Per the CSS spec, `overflow-x: auto` promotes
    // `overflow-y: visible` to `auto`, which produced a nested vertical
    // scrollbar the moment the inner <table> grew tall — stacking with
    // the window's own scrollbar. The <table> is `w-full` and its column
    // widths all fit the page gutter at the design baseline (~1280px),
    // so any overflow now bubbles up to the one page-level scrollbar.
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
      <table className="w-full text-sm">
        <thead className="bg-[#FAFBFC] border-b border-slate-100 dark:border-slate-800">
          <tr className="text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
            {/* UI-14 — the first column labels the outer group dim; the
                second labels the sub-dim (or stays "Row" when sub=none).
                Sort/filter column keys are kept stable ('deliverable'/
                'zone') since the sort code already knows them — only the
                header LABEL rotates with the dim. */}
            <SortableFilterableHeader
              label={dpGroupDimLabel(outerDim)} width="w-[240px]"
              sort={sort} col="deliverable" onToggleSort={() => toggleSort('deliverable')}
              options={optionsFor('deliverable')} activeCount={colFilters.deliverable.length}
              onToggleValue={(v) => toggleFilterValue('deliverable', v)}
              onClear={() => clearFilter('deliverable')} onSelectAll={() => selectAll('deliverable')}
              open={openFilter === 'deliverable'} onToggleOpen={() => setOpenFilter((c) => c === 'deliverable' ? null : 'deliverable')}
            />
            <SortableFilterableHeader
              label={innerDim ? dpGroupDimLabel(innerDim) : 'Row'}
              sort={sort} col="zone" onToggleSort={() => toggleSort('zone')}
              options={optionsFor('zone')} activeCount={colFilters.zone.length}
              onToggleValue={(v) => toggleFilterValue('zone', v)}
              onClear={() => clearFilter('zone')} onSelectAll={() => selectAll('zone')}
              open={openFilter === 'zone'} onToggleOpen={() => setOpenFilter((c) => c === 'zone' ? null : 'zone')}
            />
            <SortableFilterableHeader
              label="Service"
              sort={sort} col="service" onToggleSort={() => toggleSort('service')}
              options={optionsFor('service')} activeCount={colFilters.service.length}
              onToggleValue={(v) => toggleFilterValue('service', v)}
              onClear={() => clearFilter('service')} onSelectAll={() => selectAll('service')}
              open={openFilter === 'service'} onToggleOpen={() => setOpenFilter((c) => c === 'service' ? null : 'service')}
            />
            <SortableFilterableHeader
              label="Months" width="w-[110px]" align="right"
              sort={sort} col="months" onToggleSort={() => toggleSort('months')}
              options={optionsFor('months')} activeCount={colFilters.months.length}
              onToggleValue={(v) => toggleFilterValue('months', v)}
              onClear={() => clearFilter('months')} onSelectAll={() => selectAll('months')}
              open={openFilter === 'months'} onToggleOpen={() => setOpenFilter((c) => c === 'months' ? null : 'months')}
            />
            <SortableFilterableHeader
              label="Duration (weeks) *" width="w-[140px]" align="right"
              sort={sort} col="duration" onToggleSort={() => toggleSort('duration')}
              options={optionsFor('duration')} activeCount={colFilters.duration.length}
              onToggleValue={(v) => toggleFilterValue('duration', v)}
              onClear={() => clearFilter('duration')} onSelectAll={() => selectAll('duration')}
              open={openFilter === 'duration'} onToggleOpen={() => setOpenFilter((c) => c === 'duration' ? null : 'duration')}
            />
            {/* DP-3 · Hours = Σ Task.budgetHours per (zone × deliverable).
                Right-aligned like the other numeric columns. The wire
                already carried it; the client used to drop it. */}
            <SortableFilterableHeader
              label="Hours" width="w-[100px]" align="right"
              sort={sort} col="hours" onToggleSort={() => toggleSort('hours')}
              options={optionsFor('hours')} activeCount={colFilters.hours.length}
              onToggleValue={(v) => toggleFilterValue('hours', v)}
              onClear={() => clearFilter('hours')} onSelectAll={() => selectAll('hours')}
              open={openFilter === 'hours'} onToggleOpen={() => setOpenFilter((c) => c === 'hours' ? null : 'hours')}
            />
            <SortableFilterableHeader
              label="Target Date" width="w-[160px]"
              sort={sort} col="target" onToggleSort={() => toggleSort('target')}
              options={optionsFor('target')} activeCount={colFilters.target.length}
              onToggleValue={(v) => toggleFilterValue('target', v)}
              onClear={() => clearFilter('target')} onSelectAll={() => selectAll('target')}
              open={openFilter === 'target'} onToggleOpen={() => setOpenFilter((c) => c === 'target' ? null : 'target')}
            />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {sortedGroups.map((g) => {
            const isCollapsed = collapsed.has(g.key);
            const rollup = groupRollup(g.zones);
            const groupBodyId = `deliv-group-${g.key}`;
            const subCount = g.zones.length;
            // Sub-dim affects only the count-label phrasing (e.g.
            // "3 zones" vs "3 deliverables"). When outerDim='zone' or
            // 'service' the Drive button hides because it is only
            // meaningful on a real ProjectDeliverable row.
            const subNoun = outerDim === 'deliverable' ? 'zone' : outerDim === 'zone' ? 'deliverable' : 'row';
            return (
            <FragmentGroup key={g.key}>
              {/* DP-2 · Group header row — rendered ACROSS the column
                  grid (not one merged cell) so the rollup totals line
                  up under Duration / Hours / Target. Chevron + name
                  + N-sub-rows badge in the first cell; Σ weeks in the
                  Duration cell; Σ hours in the Hours cell; latest
                  resolved date in the Target Date cell. UI-14 — the
                  "name" is the outer-dim label; service column is
                  deliberately left empty under outerDim='deliverable'
                  since the same value already reads twice per row and
                  looked like a data leak. */}
              <tr
                className="bg-slate-50/70 dark:bg-slate-800/70 group cursor-pointer select-none hover:bg-slate-100/80 dark:hover:bg-slate-800"
                onClick={() => onToggleCollapse(g.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onToggleCollapse(g.key);
                  }
                }}
                aria-expanded={!isCollapsed}
                aria-controls={groupBodyId}
                tabIndex={0}
              >
                <td className="px-4 py-2 text-[12px] font-bold text-slate-700 dark:text-slate-200">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onToggleCollapse(g.key); }}
                      className="inline-flex items-center justify-center w-5 h-5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400"
                      aria-label={isCollapsed ? `Expand ${g.label}` : `Collapse ${g.label}`}
                      title={isCollapsed ? 'Expand' : 'Collapse'}
                    >
                      {isCollapsed
                        ? <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                        : <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />}
                    </button>
                    <span className="truncate shrink min-w-0">{g.label}</span>
                    {/* DP-4 parity (2026-10-21) · amber "Building" (or
                        matching zone-type) badge next to the top-level
                        zone name — mirrors Planning tab's `ZoneTypePicker`
                        closed pill (planning-modal.tsx L3414-3432). Only
                        renders when:
                          · outer group dim is Zone (sub-row badges live
                            under the row's own zone-type pill below, so
                            doubling here on inner dims is noise);
                          · the group isn't the synthetic `zone:root`
                            bucket (orphan tasks have no zone, so no
                            type);
                          · the top-level zone has a known `zoneType` in
                            `ZONE_TYPE_BADGE` — unknown types render
                            NOTHING, not a mystery slate pill. (Yulian's
                            screenshot showed no badge; the earlier pass
                            rendered a slate "Zone" fallback that drifted
                            visually from Planning's amber pill, so a PM
                            looking for the amber pill read it as
                            "missing".) */}
                    {(() => {
                      if (outerDim !== 'zone' || g.key === 'zone:root') return null;
                      const topId = g.zones[0]?.topLevelZoneId as number | null | undefined;
                      if (topId == null) return null;
                      const zt = topLevelZoneTypeMap.get(topId);
                      const style = zt ? ZONE_TYPE_BADGE[zt] : undefined;
                      if (!zt || !style) return null;
                      const label = ZONE_DISPLAY[zt]?.label ?? zt;
                      return (
                        <span
                          className={cn(
                            'rounded-[5px] px-2 py-0.5 text-[11px] font-bold tracking-[0.05em] whitespace-nowrap shrink-0',
                            style.bg,
                            style.text,
                          )}
                          title={`Zone type: ${label}`}
                        >
                          {label}
                        </span>
                      );
                    })()}
                    <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap tabular-nums">
                      · {subCount} {subNoun}{subCount === 1 ? '' : 's'}
                    </span>
                    {/* DP-EMPTY-3 · read-only badge on synthetic (marker /
                        template-only) deliverable groups. Only meaningful
                        when outerDim='deliverable' (otherwise a zone or
                        service bucket mixes real and synthetic rows). */}
                    {g.readOnly && (
                      <span
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 whitespace-nowrap"
                        title={g.readOnlyReason ?? 'Not yet planned'}
                      >
                        <Lock className="h-3 w-3" aria-hidden="true" />
                        Not yet planned
                      </span>
                    )}
                    <span className="ml-auto" onClick={(e) => e.stopPropagation()}>
                      {/* Open the deliverable's Drive folder (create-if-
                          missing on click). Only renders when outerDim is
                          'deliverable' (the id is a real ProjectDeliverable
                          id in that case) and the group is editable. */}
                      {outerDim === 'deliverable' && !g.readOnly && (
                        <OpenInDriveButton entity="deliverable" id={g.deliverableId} />
                      )}
                    </span>
                  </div>
                </td>
                {/* Zone col (empty) */}
                <td className="px-4 py-2" />
                {/* Service col (empty — see comment above) */}
                <td className="px-4 py-2" />
                {/* Months col (no rollup — months is an offset, not
                    additive; see spec § "Facts that shape the build") */}
                <td className="px-4 py-2" />
                {/* Σ Duration weeks */}
                <td className="px-4 py-2 text-right text-[12px] font-semibold text-slate-600 dark:text-slate-300 tabular-nums whitespace-nowrap">
                  {rollup.totalWeeks > 0 ? `Σ ${rollup.totalWeeks} wk` : <span className="text-slate-300 dark:text-slate-600">—</span>}
                </td>
                {/* Σ Hours */}
                <td className="px-4 py-2 text-right text-[12px] font-semibold text-slate-600 dark:text-slate-300 tabular-nums whitespace-nowrap">
                  {rollup.totalHours > 0 ? `Σ ${rollup.totalHours}h` : <span className="text-slate-300 dark:text-slate-600">—</span>}
                </td>
                {/* Latest resolved target date */}
                <td className="px-4 py-2 text-[12px] font-semibold text-slate-600 dark:text-slate-300 tabular-nums whitespace-nowrap">
                  {rollup.latestDate ? <>ends <span className="font-bold text-slate-700 dark:text-slate-200">{rollup.latestDate}</span></> : <span className="text-slate-300 dark:text-slate-600">—</span>}
                </td>
              </tr>
              {!isCollapsed && g.zones.map((r: any) => {
                const draft = drafts[r.key] ?? '';
                const durDraft = durationDrafts[r.key] ?? '';
                const preview = computePreview(draft);
                const serverMonths = r.savedMonths == null ? '' : String(r.savedMonths);
                const serverDur = r.savedDurationWeeks == null ? '' : String(r.savedDurationWeeks);
                const isDirty = !r.readOnly && (draft !== serverMonths || durDraft !== serverDur);
                const typeLabel = zoneTypeLabel(r.zoneType);
                const hoursNum = Number(r.hours || 0);
                // DP-EMPTY-3 · read-only rows disable both editable
                // inputs and swap the target-date preview for a "not
                // yet planned" hint. The reason string comes from the
                // resolver — it points the PM at the DP-EMPTY-1
                // backfill so they know how to unlock the row.
                const readOnlyHint = r.readOnlyReason ?? 'Not yet planned';
                return (
                  <tr id={groupBodyId} key={r.key} className={cn('hover:bg-slate-50/40 dark:hover:bg-slate-800/40', isDirty && 'bg-blue-50/30 dark:bg-blue-950/20', r.readOnly && 'bg-amber-50/30 dark:bg-amber-950/10')}>
                    <td className="px-4 py-2 text-slate-400 dark:text-slate-500">—</td>
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200">
                      {/* UI-14 — the sub-column label switches to the
                          current innerDim; the zone-type badge only
                          renders when innerDim='zone' (its only honest
                          domain). When no sub-group is picked, show
                          the row's own zone+deliverable identity so the
                          row is still readable. */}
                      <span className="truncate">
                        {innerDim === 'zone' ? r.zoneName
                          : innerDim === 'deliverable' ? r.deliverableName
                          : innerDim === 'service' ? (r.serviceName ?? '—')
                          : `${r.zoneName} · ${r.deliverableName}`}
                      </span>
                      {innerDim === 'zone' && (
                        <span
                          className="ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 whitespace-nowrap"
                          title={`Zone type: ${typeLabel}`}
                        >
                          {typeLabel}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300 text-[13px]">{r.serviceName ?? '—'}</td>
                    <td className="px-4 py-2 text-right">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={draft}
                        onChange={(e) => setDrafts((s) => ({ ...s, [r.key]: e.target.value }))}
                        placeholder="—"
                        disabled={r.readOnly}
                        title={r.readOnly ? readOnlyHint : undefined}
                        className={cn(
                          'w-[86px] px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 tabular-nums text-right focus:border-blue-500 focus:outline-none',
                          r.readOnly && 'cursor-not-allowed bg-slate-50 dark:bg-slate-800/60 text-slate-400 dark:text-slate-500',
                        )}
                      />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={durDraft}
                        onChange={(e) => setDurationDrafts((s) => ({ ...s, [r.key]: e.target.value }))}
                        placeholder="—"
                        disabled={r.readOnly}
                        title={r.readOnly ? readOnlyHint : undefined}
                        className={cn(
                          'w-[86px] px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 tabular-nums text-right focus:border-blue-500 focus:outline-none',
                          r.readOnly && 'cursor-not-allowed bg-slate-50 dark:bg-slate-800/60 text-slate-400 dark:text-slate-500',
                        )}
                      />
                    </td>
                    {/* DP-3 · Hours cell — read-only (server-derived).
                        `120h` when we have any; `—` when zero. */}
                    <td className="px-4 py-2 text-right text-slate-700 dark:text-slate-200 tabular-nums text-[13px]">
                      {hoursNum > 0
                        ? `${hoursNum}h`
                        : <span className="text-slate-300 dark:text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200 tabular-nums">
                      {r.readOnly ? (
                        <span
                          className="text-[12px] text-amber-700 dark:text-amber-400 italic"
                          title={readOnlyHint}
                        >
                          run backfill to plan
                        </span>
                      ) : preview
                        ? preview
                        : r.savedDate
                          ? <span className="text-slate-500 dark:text-slate-400">{r.savedDate}</span>
                          : <span className="text-slate-300 dark:text-slate-600">no target</span>}
                    </td>
                  </tr>
                );
              })}
            </FragmentGroup>
          );
          })}
        </tbody>
      </table>
      {/* Footnote — the Duration column is in CALENDAR days, not
          working hours. Set by the client on 2026-08-02 so the PM
          can draw the Gantt independent of team availability. */}
      <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 italic">
        * Duration is in <span className="font-semibold">calendar weeks</span>, not actual working time.
      </div>
    </div>
  );
}

// Fragment wrapper as a named component so React key prop is legal on it.
function FragmentGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/**
 * Column header — sort (click label) + filter (funnel icon). Filter
 * popover shows a CHECKBOX LIST of the values currently loaded on
 * screen for that column. Cascading — the options reflect the current
 * state of other columns' filters so users can drill down without
 * seeing dead ends. (Tier E #10 revision, 2026-08-02 client update.)
 */
function SortableFilterableHeader({
  label, width, align,
  sort, col, onToggleSort,
  options, activeCount,
  onToggleValue, onClear, onSelectAll,
  open, onToggleOpen,
}: {
  label: string;
  width?: string;
  align?: 'left' | 'right';
  sort: { col: string; dir: 'asc' | 'desc' };
  col: string;
  onToggleSort: () => void;
  options: { value: string; count: number; selected: boolean }[];
  activeCount: number;
  onToggleValue: (v: string) => void;
  onClear: () => void;
  onSelectAll: () => void;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onToggleOpen();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onToggleOpen]);
  useEffect(() => { if (!open) setSearch(''); }, [open]);

  const isSorted = sort.col === col;
  const filteredOptions = search
    ? options.filter((o) => o.value.toLowerCase().includes(search.toLowerCase()))
    : options;
  const hasActive = activeCount > 0;

  return (
    <th className={cn('px-4 py-3 font-semibold', width, align === 'right' ? 'text-right' : 'text-left')}>
      <div ref={ref} className={cn('relative inline-flex items-center gap-1.5', align === 'right' && 'justify-end w-full')}>
        <button
          type="button"
          onClick={onToggleSort}
          className={cn('inline-flex items-center gap-0.5 hover:text-slate-600 dark:hover:text-slate-200 transition-colors', isSorted && 'text-slate-700 dark:text-slate-200')}
          title={`Sort by ${label}`}
        >
          <span>{label}</span>
          <ArrowUpDown className={cn('h-3 w-3', !isSorted && 'opacity-40')} />
          {isSorted && (sort.dir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
        </button>
        <button
          type="button"
          onClick={onToggleOpen}
          className={cn('relative flex items-center justify-center w-4 h-4 rounded transition-colors', hasActive ? 'text-blue-600' : 'text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-100')}
          title={hasActive ? `${label} is filtered (${activeCount})` : `Filter ${label}`}
        >
          <Filter className="h-3 w-3" />
          {hasActive && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[13px] h-[13px] px-0.5 rounded-full bg-blue-600 text-white text-[8px] font-bold flex items-center justify-center">
              {activeCount}
            </span>
          )}
        </button>
        {open && (
          <div className="absolute left-0 top-full z-40 mt-1 w-[260px] rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.12)] border border-black/5 bg-white dark:bg-slate-900">
            {/* Header: search + Select all / Clear */}
            <div className="p-2 border-b border-slate-100 dark:border-slate-800">
              <input
                type="text"
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search…`}
                className="w-full px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 text-[12px] focus:border-blue-500 focus:outline-none"
              />
              <div className="flex items-center justify-between mt-2 text-[11px]">
                <button
                  type="button"
                  onClick={onSelectAll}
                  className="text-blue-600 hover:text-blue-700 font-semibold"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={onClear}
                  className="text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 font-semibold"
                >
                  Clear
                </button>
              </div>
            </div>
            {/* Checkbox list of distinct values (cascading — respects
                other columns' filters). Shows the row count per value
                so users can see how many rows a pick will yield. */}
            <div className="max-h-64 overflow-y-auto py-1">
              {filteredOptions.length === 0 ? (
                <p className="px-3 py-4 text-[11px] text-slate-400 dark:text-slate-500 italic text-center">
                  {search ? 'No matches' : 'No values available'}
                </p>
              ) : (
                filteredOptions.map((o) => (
                  <label
                    key={o.value}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer text-[12px]"
                  >
                    <input
                      type="checkbox"
                      checked={o.selected}
                      onChange={() => onToggleValue(o.value)}
                      className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="flex-1 truncate text-slate-700 dark:text-slate-200" title={o.value}>
                      {o.value === '(empty)' ? <span className="text-slate-400 dark:text-slate-500 italic">(empty)</span> : o.value}
                    </span>
                    <span className="text-[10px] text-slate-400 dark:text-slate-500 tabular-nums">{o.count}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </th>
  );
}

/**
 * Interactive Gantt view (Tier E #10, revised 2026-08-02).
 *
 * Every row is a (zone × deliverable) pair. The bar's RIGHT edge sits
 * at the target date; the LEFT edge sits `estimatedDurationWeeks`
 * calendar days back. Both edges are draggable — drop updates the
 * duration and/or the target date in the draft state (saved on the
 * "Save all" click in the parent). Middle drag moves the bar
 * bodily (target shifts, duration unchanged).
 *
 * Layout uses a proper 2-column grid — the LEFT column holds the
 * zone/deliverable labels and is aligned across the header AND every
 * row. The timeline area is the second column; the year/month bands
 * live only in the timeline column, so labels no longer sit under
 * dates. (Fixes the mid-turn alignment feedback from 2026-08-02.)
 */
function GanttView({
  projectId,
  rows,
  drafts,
  durationDrafts,
  targetDateDrafts,
  setDrafts,
  setDurationDrafts,
  setTargetDateDrafts,
  computePreview,
  baseDate,
  collapsed,
  onToggleCollapse,
  outerDim,
  innerDim,
  topLevelZoneTypeMap,
  topLevelZoneSortOrderMap,
}: {
  projectId: number;
  rows: any[];
  drafts: Record<string, string>;
  durationDrafts: Record<string, string>;
  targetDateDrafts: Record<string, string>;
  setDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  setDurationDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  setTargetDateDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  computePreview: (m: string) => string;
  baseDate: string;
  // DP-5/DP-6 · group collapse state, shared with the Table view
  // (parent owns the Set + persistence). UI-14 — keys are now outer-
  // dim group keys as strings.
  collapsed: Set<string>;
  onToggleCollapse: (key: string) => void;
  // UI-14 · group+sub-group dims. The Gantt label column header reads
  // "<outer> · <sub>" dynamically; rows group by outerDim.
  outerDim: DPGroupDim;
  innerDim: DPGroupDim | null;
  // DP-4 parity (2026-10-21) — top-level zone type (for the Building
  // badge) + sort order (for Planning-tab parity). Keyed by top-level
  // zone id; threaded in from the parent's `topLevelZoneInfo`.
  topLevelZoneTypeMap: Map<number, string | undefined>;
  topLevelZoneSortOrderMap: Map<number, number>;
}) {
  // Row order — persisted per browser via localStorage. Rebuilt from
  // the incoming rows whenever the row set changes, preserving any
  // prior order the user established. New rows get appended at the
  // end. (D&D reorder — client feedback 2026-08-02.)
  const orderKey = 'planwise:gantt:row-order:v1';
  const [rowOrder, setRowOrder] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(orderKey);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch { return []; }
  });
  useEffect(() => {
    // Merge: keep saved order for rows still present; append new ones.
    const present = new Set(rows.map((r) => r.key));
    const kept = rowOrder.filter((k) => present.has(k));
    const added = rows.map((r) => r.key).filter((k) => !kept.includes(k));
    const merged = [...kept, ...added];
    if (merged.length !== rowOrder.length || merged.some((k, i) => k !== rowOrder[i])) {
      setRowOrder(merged);
    }
  }, [rows]);
  useEffect(() => {
    try { localStorage.setItem(orderKey, JSON.stringify(rowOrder)); } catch { /* ignore */ }
  }, [rowOrder]);

  // DPG-4 (2026-10-20) · Timeline-window selector — how many years the
  // Gantt should show at a time (1 / 2 / 3). Replaces the hardcoded
  // `const VISIBLE_YEARS = 3` that used to live further down. Persisted
  // under a NON-per-project key (`planwise:gantt:visible-years`): the
  // user picks a comfortable zoom once and it sticks across projects
  // and sessions. Every localStorage access is try/catch-guarded —
  // private-browsing / cleared site data can throw on access.
  const VISIBLE_YEARS_KEY = 'planwise:gantt:visible-years';
  const [visibleYears, setVisibleYears] = useState<1 | 2 | 3>(() => {
    try {
      const raw = localStorage.getItem(VISIBLE_YEARS_KEY);
      const n = raw ? parseInt(raw, 10) : NaN;
      return n === 1 || n === 2 || n === 3 ? (n as 1 | 2 | 3) : 3;
    } catch { return 3; }
  });
  useEffect(() => {
    try { localStorage.setItem(VISIBLE_YEARS_KEY, String(visibleYears)); } catch { /* ignore */ }
  }, [visibleYears]);

  // DPG-5 (2026-10-20) · Grid granularity — controls the DENSITY of the
  // timeline grid-lines + header ticks. Bars themselves still snap to
  // Sunday (calendar-week resolution), so the FUNCTIONAL geometry of a
  // bar is unchanged across granularities — only the pixel scale and
  // tick labels change:
  //   • month → ~1.14 px/day (one tick per month, label "Oct")
  //   • week  → ~4 px/day   (one tick per week,  label "W40 · Oct 5")
  //   • day   → 24 px/day   (one tick per day,   label "20\nT")
  // The timeline is a single horizontal scroller (sticky left-column
  // labels already); day-view makes it long, user scrolls. Persisted
  // under `planwise:gantt:granularity`, non-per-project (same user
  // preference everywhere).
  type Granularity = 'month' | 'week' | 'day';
  const GRANULARITY_KEY = 'planwise:gantt:granularity';
  const [granularity, setGranularity] = useState<Granularity>(() => {
    try {
      const raw = localStorage.getItem(GRANULARITY_KEY);
      return raw === 'month' || raw === 'week' || raw === 'day' ? raw : 'month';
    } catch { return 'month'; }
  });
  useEffect(() => {
    try { localStorage.setItem(GRANULARITY_KEY, granularity); } catch { /* ignore */ }
  }, [granularity]);

  // §4 (2026-11-10, planwise-DP-predecessor-lag-scheduling-BUG) — Task-bar
  // overlay toggle. When ON (default), each Gantt row renders nested per-
  // task bars positioned by (estimatedStartDate → endDate) plus chain
  // arrows between in-row FTS edges; critical-path bars + arrows are red,
  // non-CP ones blue/slate. When OFF the row collapses to just the
  // deliverable backdrop bar (pre-§4 look) so the PM can hide the
  // per-task layer when the Gantt feels busy. Persisted under
  // `dp-gantt-show-task-bars` — non-per-project, matches the other Gantt
  // display preferences above (user picks once, applies everywhere).
  const SHOW_TASK_BARS_KEY = 'dp-gantt-show-task-bars';
  const [showTaskBars, setShowTaskBars] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(SHOW_TASK_BARS_KEY);
      // Default ON; only explicit "false" string flips it off.
      return raw === null ? true : raw !== 'false';
    } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(SHOW_TASK_BARS_KEY, String(showTaskBars)); } catch { /* ignore */ }
  }, [showTaskBars]);

  // Ordered rows for display, matching rowOrder.
  const orderedRows = useMemo(() => {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const ordered = rowOrder.map((k) => byKey.get(k)).filter(Boolean) as any[];
    // Any rows not yet in the persisted order (shouldn't happen after the effect above, but defensive) get appended.
    const missing = rows.filter((r) => !rowOrder.includes(r.key));
    return [...ordered, ...missing];
  }, [rows, rowOrder]);

  // DP-5 · Group orderedRows by the outer group dim (UI-14 — was a
  // hardcoded `r.deliverableId` before the dim became configurable),
  // preserving the encounter order (so a drag-persisted order still
  // drives which group shows first). Each display slot is either a
  // `group` header (chevron + rollup) or a `zone` bar; the two columns
  // of the Gantt iterate this list in lockstep so the label column and
  // the timeline column stay vertically aligned when groups collapse/
  // expand.
  type GanttGroup = {
    kind: 'group';
    key: string;             // outer-dim group key (collapse-set membership)
    deliverableId: number;   // first row's deliverableId — only honest when outerDim='deliverable'
    label: string;           // outer-dim human label
    zones: any[];
    isCollapsed: boolean;
    zoneCount: number;
    // DP-DUPS (2026-10-21) · Count of DISTINCT deliverables in this
    // bucket. After the per-sub-zone row dedup `zoneCount` should equal
    // this value for Zone-grouping buckets (one row per deliverable),
    // but keep both: the Zone-header pill reads this field so a future
    // regression that re-introduces per-sub-zone rows still shows a
    // sane "N deliverables" count instead of inflated row count.
    uniqueDeliverableCount: number;
    hoursSum: number;
    latestTargetMs: number | null;
    earliestStartMs: number | null;
    latestTargetIso: string | null;
    // DPG-1b (2026-10-20) — Rolled-up task counts across the group's
    // children. Drives the rollup bar's progress fill + "{done}/{total}"
    // label and matches the per-row counts already carried on each Row.
    // `spanWeeks` is the DURATION of the rollup (earliest → latest in
    // calendar weeks), used in the bar label; this is a SPAN, not a sum
    // of per-row durations (sum would double-count parallel work).
    taskTotal: number;
    taskStarted: number;
    taskDone: number;
    spanWeeks: number;
    // DP-EMPTY-3 — true when every row in this group is a synthetic
    // (marker/template-only) row. Only meaningful when outerDim is
    // 'deliverable' (zone/service buckets can mix real + synthetic).
    readOnly: boolean;
    readOnlyReason: string | null;
  };
  type GanttZoneSlot = { kind: 'zone'; r: any; zoneIdx: number };
  type GanttSlot = GanttGroup | GanttZoneSlot;
  const displaySlots: GanttSlot[] = useMemo(() => {
    const groupOrder: string[] = [];
    const groupZones = new Map<string, { z: any; zoneIdx: number }[]>();
    orderedRows.forEach((r, idx) => {
      const k = rowDimKey(r, outerDim);
      if (!groupZones.has(k)) {
        groupOrder.push(k);
        groupZones.set(k, []);
      }
      groupZones.get(k)!.push({ z: r, zoneIdx: idx });
    });
    // DP-4 parity (2026-10-21) — when grouping by Zone, follow Planning
    // tab's canonical order: top-level zone's `sortOrder` ASC (API-side
    // `[sortOrder: asc, createdAt: asc]`), tiebroken by name. Encounter
    // order from `orderedRows` is non-deterministic across projects (it
    // depends on which deliverable's first row happens to land under a
    // given top-level zone), which drove the visible drift between the
    // two tabs. Resorting here keeps DP in lockstep with Planning.
    if (outerDim === 'zone') {
      groupOrder.sort((aKey, bKey) => {
        const aRow = groupZones.get(aKey)![0]?.z;
        const bRow = groupZones.get(bKey)![0]?.z;
        const aTopId = aRow?.topLevelZoneId as number | null | undefined;
        const bTopId = bRow?.topLevelZoneId as number | null | undefined;
        const aOrder = aTopId == null ? Number.POSITIVE_INFINITY : (topLevelZoneSortOrderMap.get(aTopId) ?? 0);
        const bOrder = bTopId == null ? Number.POSITIVE_INFINITY : (topLevelZoneSortOrderMap.get(bTopId) ?? 0);
        if (aOrder !== bOrder) return aOrder - bOrder;
        const aName = (aRow?.topLevelZoneName ?? '').toLowerCase();
        const bName = (bRow?.topLevelZoneName ?? '').toLowerCase();
        return aName < bName ? -1 : aName > bName ? 1 : 0;
      });
    }
    // DPG-1c (2026-10-20) — Pin "Project Root" group (orphan tasks with
    // `topLevelZoneId=null`) to the top of a Zone grouping, so the PM
    // sees unassigned tasks before per-zone rollups. The group only
    // exists when at least one row keyed to `zone:root`, so this never
    // introduces an empty synthetic row. Runs AFTER the sortOrder pass
    // above so Project Root always ends up at index 0.
    if (outerDim === 'zone') {
      const idx = groupOrder.indexOf('zone:root');
      if (idx > 0) {
        groupOrder.splice(idx, 1);
        groupOrder.unshift('zone:root');
      }
    }
    const out: GanttSlot[] = [];
    for (const gKey of groupOrder) {
      const entries = groupZones.get(gKey)!;
      const zonesArr = entries.map((e) => e.z);
      const isCollapsed = collapsed.has(gKey);
      // Rollup: sum hours, find latest resolved target, find earliest
      // resolved start (target − durationWeeks × 7d). Uses the same
      // resolution order as GanttRow (see comment at line ~1647).
      let latestTgt = -Infinity;
      let earliestStart = Infinity;
      let hoursSum = 0;
      // DPG-1b (2026-10-20) · aggregate task counts for the rollup bar's
      // progress fill + "{done}/{total}" chip. Mirrors GanttRow's local
      // `total/started/done`, just summed across the group's children.
      let taskTotal = 0;
      let taskStarted = 0;
      let taskDone = 0;
      for (const z of zonesArr) {
        hoursSum += Number(z.hours || 0);
        taskTotal += Number(z.taskTotal || 0);
        taskStarted += Number(z.taskStarted || 0);
        taskDone += Number(z.taskDone || 0);
        const tIso = targetDateDrafts[z.key] || computePreview(drafts[z.key] ?? '') || z.savedDate;
        if (!tIso) continue;
        const tMs = new Date(tIso).getTime();
        if (!Number.isFinite(tMs)) continue;
        if (tMs > latestTgt) latestTgt = tMs;
        const durWeeks = Number(durationDrafts[z.key] || z.savedDurationWeeks || 0);
        const sMs = tMs - durWeeks * 7 * 86_400_000;
        if (sMs < earliestStart) earliestStart = sMs;
      }
      const latestTargetMs = latestTgt === -Infinity ? null : latestTgt;
      const earliestStartMs = earliestStart === Infinity ? null : earliestStart;
      // Span in calendar weeks (not a sum of per-row durations — that
      // would double-count parallel work and read wrong on the bar).
      const spanWeeks = (latestTargetMs != null && earliestStartMs != null)
        ? Math.max(0, Math.round((latestTargetMs - earliestStartMs) / (7 * 86_400_000)))
        : 0;
      // DP-EMPTY-3 — only honest when outerDim='deliverable'; otherwise
      // zero out so a mixed zone/service bucket doesn't inherit a bogus
      // "not yet planned" badge from its first row.
      const groupReadOnly = outerDim === 'deliverable' && !!zonesArr[0]?.readOnly;
      const groupReadOnlyReason = outerDim === 'deliverable' ? (zonesArr[0]?.readOnlyReason ?? null) : null;
      out.push({
        kind: 'group',
        key: gKey,
        deliverableId: zonesArr[0]?.deliverableId ?? 0,
        label: rowDimLabel(zonesArr[0] ?? {}, outerDim),
        zones: zonesArr,
        isCollapsed,
        zoneCount: zonesArr.length,
        // DP-DUPS (2026-10-21) · Unique deliverable count for the
        // Zone-grouping header pill — see the field comment on
        // GanttGroup for why it's separate from zoneCount.
        uniqueDeliverableCount: new Set(zonesArr.map((z: any) => z.deliverableId)).size,
        hoursSum,
        latestTargetMs,
        earliestStartMs,
        latestTargetIso: latestTargetMs ? new Date(latestTargetMs).toISOString().slice(0, 10) : null,
        taskTotal,
        taskStarted,
        taskDone,
        spanWeeks,
        readOnly: groupReadOnly,
        readOnlyReason: groupReadOnlyReason,
      });
      if (!isCollapsed) {
        for (const { z, zoneIdx } of entries) out.push({ kind: 'zone', r: z, zoneIdx });
      }
    }
    return out;
  }, [orderedRows, collapsed, drafts, durationDrafts, targetDateDrafts, computePreview, outerDim, topLevelZoneSortOrderMap]);

  // DPG-6 (2026-10-21) · Viewport-aware timeline width. The horizontal
  // scroller's `clientWidth` is measured via `ResizeObserver` and the
  // grid stretches to fill it: a 1-year window at month granularity on
  // a 1200px viewport goes from ~833px total (empty right-hand gap) to
  // the full viewport. Also recomputes on window resize, sidebar
  // collapse/expand (anything that resizes the scroller), and
  // `visibleYears` / `granularity` changes.
  //
  // Density floor per granularity so bars stay readable even when the
  // span is longer than the viewport (user scrolls instead of the labels
  // collapsing to unreadable):
  //   month → 8/7 (~1.14 px/day) — matches the pre-DPG-6 default; month
  //           ticks are ~34 px wide at this scale, enough for "Oct".
  //   week  → 4 px/day — one week = 28 px, fits "W40".
  //   day   → 24 px/day — one day = 24 px, fits "20\nT".
  // The stretched value is `viewportWidth / spanDays`; we take the max
  // of that and the floor so day/week never shrink below their natural
  // ticks, while month view can grow (when visibleYears is small enough
  // to let it) to use the whole viewport. First paint has
  // `viewportWidth === 0`, which falls back to the natural density.
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState<number>(0);
  // `useLayoutEffect` seeds the initial width BEFORE the first browser
  // paint, so the first visible frame uses the stretched pxPerDay —
  // no cheap "natural density → stretched" flash on mount. The
  // ResizeObserver then catches every later resize (window, sidebar
  // collapse, viewport zoom, etc.) and triggers a plain re-render.
  useLayoutEffect(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    setViewportWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = (entry.contentRect?.width ?? (entry.target as HTMLElement).clientWidth) || 0;
        // Guard against sub-pixel noise ping-ponging state updates.
        setViewportWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const MIN_PX_PER_DAY = granularity === 'day' ? 24 : granularity === 'week' ? 4 : 8 / 7;

  // DPG-4 (2026-10-20) · `visibleYears` is now component state (1/2/3)
  // persisted to localStorage — see the hook at the top of the component.

  // Compute the timeline span. Base is `baseDate`; end is 3 months
  // past the latest target (or 3 years from base, whichever is bigger)
  // so short-project scroll bars don't rattle around at the end.
  // Prefer explicit-date draft (from Gantt drag) → months draft →
  // saved server value. Same resolution order used inside GanttRow.
  const targets = orderedRows.map((r) => {
    if (targetDateDrafts[r.key]) return targetDateDrafts[r.key];
    const draft = drafts[r.key] ?? '';
    return computePreview(draft) || r.savedDate;
  }).filter(Boolean) as string[];

  // Pad the timeline with 1 year of past-buffer BEFORE baseDate so
  // the "today" marker always has room to sit in the first third of
  // the viewport (client feedback 2026-08-02). Without this buffer,
  // baseDate == today collapses todayPx to 0 and scrollLeft can't go
  // negative — today gets pinned to the left edge.
  const baseDateMs = new Date(baseDate).getTime();
  const PAST_BUFFER_DAYS = 365;
  const startMs = baseDateMs - PAST_BUFFER_DAYS * 86_400_000;
  const latestTargetMs = targets.length ? Math.max(...targets.map((d) => new Date(d).getTime())) : baseDateMs;
  const threeYearMs = baseDateMs + visibleYears * 365 * 86_400_000;
  const endMs = Math.max(latestTargetMs + 90 * 86_400_000, threeYearMs);
  const spanDays = Math.max(30, Math.round((endMs - startMs) / 86_400_000));
  // DPG-6 — stretched pxPerDay = viewportWidth / spanDays, floored at
  // the granularity's natural minimum. `viewportWidth === 0` on first
  // paint (and when the scroller isn't mounted yet, e.g. empty-state
  // branch) → stretched is 0 → the floor wins → natural density.
  const stretchedPxPerDay = viewportWidth > 0 && spanDays > 0
    ? viewportWidth / spanDays
    : 0;
  const PX_PER_DAY = Math.max(MIN_PX_PER_DAY, stretchedPxPerDay);
  const totalTimelineWidth = spanDays * PX_PER_DAY;
  // NB: don't early-return here — hooks below (useRef, useState,
  // useEffect) must run on EVERY render, otherwise React errors with
  // "Rendered fewer hooks than expected" when the row set toggles
  // between empty and non-empty (client feedback 2026-08-02). The
  // empty-state render is done at the bottom of the function.

  // Month + year ticks in PX positions along the total width. Walk
  // from the padded `startMs` (not baseDate) so the past-buffer area
  // gets its year/month labels too (client feedback 2026-08-02).
  // Anchor to the FIRST DAY of the month containing startMs so ticks
  // land on month boundaries, then step month-by-month until we reach
  // the end of the timeline. `monthTicks` always drives the top year-
  // band row regardless of DPG-5 granularity.
  const monthTicks: { px: number; year: number; month: number }[] = [];
  const tickAnchor = new Date(startMs);
  tickAnchor.setUTCDate(1);
  tickAnchor.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i <= Math.ceil(spanDays / 30) + 2; i++) {
    const d = new Date(tickAnchor);
    d.setUTCMonth(d.getUTCMonth() + i);
    const days = (d.getTime() - startMs) / 86_400_000;
    const px = days * PX_PER_DAY;
    if (px >= 0 && px <= totalTimelineWidth) monthTicks.push({ px, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  const yearBands: { year: number; startPx: number; endPx: number }[] = [];
  for (let i = 0; i < monthTicks.length; i++) {
    const t = monthTicks[i];
    const last = yearBands[yearBands.length - 1];
    if (last && last.year === t.year) {
      last.endPx = i + 1 < monthTicks.length ? monthTicks[i + 1].px : totalTimelineWidth;
    } else {
      yearBands.push({ year: t.year, startPx: t.px, endPx: i + 1 < monthTicks.length ? monthTicks[i + 1].px : totalTimelineWidth });
    }
  }
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // DOW_LETTERS indexed by Date.getUTCDay() (0=Sun..6=Sat).
  const DOW_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  // DPG-5 (2026-10-20) · `innerTicks` are the labels for the SECOND
  // header row — month in month-view, week in week-view, day in day-
  // view. Each tick carries a px position (relative to timeline start)
  // and a one- or two-line label. The year band on top uses the SAME
  // `yearBands` array in every granularity, so year context is never
  // lost.
  type InnerTick = { px: number; label: string; sublabel?: string; emphasize?: boolean };
  // Sunday-aligned week number since Jan 1 of the same year. Chosen
  // over ISO (Mon-based) because bars in this Gantt snap to Sunday —
  // the week number the UI shows then matches the bar's start.
  const sundayWeekOf = (d: Date): number => {
    const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
    const dayOfYear = Math.floor((d.getTime() - yearStart) / 86_400_000);
    const yearStartDow = new Date(yearStart).getUTCDay();
    return Math.floor((dayOfYear + yearStartDow) / 7) + 1;
  };
  const innerTicks: InnerTick[] = (() => {
    const out: InnerTick[] = [];
    if (granularity === 'month') {
      for (const t of monthTicks) out.push({ px: t.px, label: MONTH_NAMES[t.month - 1] });
      return out;
    }
    if (granularity === 'week') {
      // Walk Sunday-by-Sunday starting from the Sunday on-or-before
      // startMs. Each tick labels "W{N} · {MMM D}" so the user has
      // both the ordinal (handy for sprint speak) and the calendar
      // anchor on a single line.
      const anchor = new Date(startMs);
      anchor.setUTCHours(0, 0, 0, 0);
      anchor.setUTCDate(anchor.getUTCDate() - anchor.getUTCDay()); // back to Sunday
      const totalDays = Math.ceil(spanDays) + 7;
      for (let i = 0; i < Math.ceil(totalDays / 7) + 1; i++) {
        const d = new Date(anchor);
        d.setUTCDate(d.getUTCDate() + i * 7);
        const px = ((d.getTime() - startMs) / 86_400_000) * PX_PER_DAY;
        if (px < 0 || px > totalTimelineWidth) continue;
        const wk = sundayWeekOf(d);
        out.push({ px, label: `W${wk}`, sublabel: `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}` });
      }
      return out;
    }
    // 'day' — one tick per day. Day-1-of-month gets a bolder label so
    // the user still sees month context without a third header row.
    const dayAnchor = new Date(startMs);
    dayAnchor.setUTCHours(0, 0, 0, 0);
    for (let i = 0; i <= Math.ceil(spanDays) + 1; i++) {
      const d = new Date(dayAnchor);
      d.setUTCDate(d.getUTCDate() + i);
      const px = ((d.getTime() - startMs) / 86_400_000) * PX_PER_DAY;
      if (px < 0 || px > totalTimelineWidth) continue;
      const dayNum = d.getUTCDate();
      const isMonthStart = dayNum === 1;
      out.push({
        px,
        label: isMonthStart ? `${MONTH_NAMES[d.getUTCMonth()]} ${dayNum}` : String(dayNum),
        sublabel: DOW_LETTERS[d.getUTCDay()],
        emphasize: isMonthStart,
      });
    }
    return out;
  })();

  // Today marker (client feedback 2026-08-02).
  const todayMs = Date.now();
  const todayPx = ((todayMs - startMs) / 86_400_000) * PX_PER_DAY;
  const todayInRange = todayPx >= 0 && todayPx <= totalTimelineWidth;

  // Single scroll source of truth: the BODY scroller. The header row
  // (year+month bands) is `overflow-hidden` and its inner content is
  // translated by `-scrollLeftPx`, so both always move together and
  // there is exactly one horizontal scrollbar. This replaces the
  // two-scroller onScroll-mirror trick, which sometimes let the top
  // and bottom drift apart when the top wasn't the active scroller.
  //
  // DPG-6 (2026-10-21) — the ref itself is now hoisted above (next to
  // the ResizeObserver that drives viewport-aware pxPerDay). Only state
  // specific to scroll position + scroll helpers live here.
  const [scrollLeftPx, setScrollLeftPx] = useState(0);
  const scrollByDays = (days: number) => {
    const el = bodyScrollRef.current;
    if (!el) return;
    const dx = days * PX_PER_DAY;
    el.scrollTo({ left: Math.max(0, el.scrollLeft + dx), behavior: 'smooth' });
  };
  const scrollToToday = (smooth: boolean = true) => {
    const el = bodyScrollRef.current;
    if (!el) return;
    // Put "today" in the FIRST THIRD of the viewport (client feedback
    // 2026-08-02) — leaves ~2/3 of horizontal space for future work.
    if (todayInRange) {
      el.scrollTo({ left: Math.max(0, todayPx - el.clientWidth / 3), behavior: smooth ? 'smooth' : 'auto' });
    } else {
      el.scrollTo({ left: 0, behavior: smooth ? 'smooth' : 'auto' });
    }
  };

  // On first paint (and after the timeline width changes), snap the
  // viewport so "today" starts in the first third instead of at the
  // left edge. Runs once per width change, not on every scroll.
  useEffect(() => {
    scrollToToday(false);
  }, [totalTimelineWidth]);

  // Past-date confirmation state (client feedback 2026-08-02).
  const [pastDateConfirm, setPastDateConfirm] = useState<null | { rowKey: string; newTargetMs: number; kind: 'target' | 'duration' | 'move' | 'resize'; apply: () => void }>(null);
  // Task-list modal for a clicked Gantt bar (items 2+3). Shows every
  // task under that (zone × deliverable) with an editable due date.
  const [taskModalRow, setTaskModalRow] = useState<any | null>(null);

  // Row drag state (D&D reorder). We use HTML5 drag events; @dnd-kit
  // is heavier than we need for a linear list.
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropIndicatorIdx, setDropIndicatorIdx] = useState<number | null>(null);

  const handleReorder = (fromKey: string, toIndex: number) => {
    setRowOrder((prev) => {
      const filtered = prev.filter((k) => k !== fromKey);
      const clamped = Math.max(0, Math.min(toIndex, filtered.length));
      return [...filtered.slice(0, clamped), fromKey, ...filtered.slice(clamped)];
    });
  };

  // DPG-3 (2026-10-20) · Rollup-bar drag state. Tracks the group being
  // dragged + the current delta in days so the floating "+N days" badge
  // can render over the dragging bar. `null` means no drag in flight;
  // the badge is only visible while a pointer is down on the bar.
  const [rollupDragInfo, setRollupDragInfo] = useState<null | { groupKey: string; deltaDays: number }>(null);

  // DPG-3 · Start a cascade drag on a group's rollup bar. Every child
  // row with a resolved target gets its target shifted by the SAME
  // delta (snap-to-7-days so bars still land on Sunday), proportions
  // between children preserved by construction. Writes to the existing
  // `targetDateDrafts` map — Save-all persists exactly the same way a
  // single-row drag already does, so no new persistence path.
  //
  //   • Past-date revert: if the earliest resulting target lands before
  //     TODAY, roll every row back to its pre-drag draft and open the
  //     existing PastDateConfirmModal; Confirm re-applies.
  //   • Click vs drag: a near-zero drag (< 3 px) collapses/expands the
  //     group (same affordance the bar had before DPG-3; replaces its
  //     former `onClick={toggle}`).
  //   • Live delta badge: `rollupDragInfo` ticks each move; the floating
  //     "+N days" chip renders inside the bar's track, pointer-events
  //     disabled so it never swallows the pointer.
  const startRollupDrag = (slot: GanttGroup) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Snapshot each child's PRIOR state (resolved target + any explicit
    // draft already in place) so a mid-drag re-render — triggered by
    // our own setTargetDateDrafts — doesn't poison the baseline we add
    // the delta to. Children with no target at all are tracked but
    // skipped on apply (there's nothing to shift).
    const snapshot = slot.zones.map((z: any) => {
      const curTargetIso = targetDateDrafts[z.key] || computePreview(drafts[z.key] ?? '') || z.savedDate;
      const curTargetMs = curTargetIso ? new Date(curTargetIso).getTime() : null;
      const priorDraft = targetDateDrafts[z.key] ?? '';
      return { key: z.key, curTargetMs, priorDraft };
    });
    const initClientX = e.clientX;
    const msPerPx = 86_400_000 / PX_PER_DAY;
    let finalDeltaDays = 0;
    // Last-committed per-child iso map — reused inside the past-date
    // confirm callback so the modal's Apply re-plays the exact deltas
    // the user let go of.
    const appliedTargets = new Map<string, string>();

    const isoDayOf = (ms: number) => {
      const d = new Date(ms);
      d.setUTCHours(0, 0, 0, 0);
      return d.toISOString().slice(0, 10);
    };

    setRollupDragInfo({ groupKey: slot.key, deltaDays: 0 });

    const onMove = (ev: PointerEvent) => {
      const dxPx = ev.clientX - initClientX;
      const dxDays = Math.round((dxPx * msPerPx) / 86_400_000);
      // Snap to the nearest 7 days so every child's new target still
      // lands on a Sunday (bars + server both expect Sunday-aligned
      // dates). A sub-7-day pointer wiggle resolves to 0 — no draft
      // writes, no visible movement.
      const snapped = Math.round(dxDays / 7) * 7;
      if (snapped === finalDeltaDays) return;
      finalDeltaDays = snapped;
      setRollupDragInfo({ groupKey: slot.key, deltaDays: snapped });
      const next: Record<string, string> = {};
      appliedTargets.clear();
      for (const s of snapshot) {
        if (s.curTargetMs == null) continue;
        const newMs = s.curTargetMs + snapped * 86_400_000;
        const iso = isoDayOf(newMs);
        next[s.key] = iso;
        appliedTargets.set(s.key, iso);
      }
      setTargetDateDrafts((prev) => ({ ...prev, ...next }));
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setRollupDragInfo(null);

      // Treat a near-zero drag as a plain click → toggle collapse.
      // CLICK_SLOP matches GanttRow's middle-drag threshold so the
      // feel is consistent between per-row and rollup clicks.
      const CLICK_SLOP = 3;
      const totalDx = Math.abs(ev.clientX - initClientX);
      if (totalDx < CLICK_SLOP && finalDeltaDays === 0) {
        onToggleCollapse(slot.key);
        return;
      }
      if (finalDeltaDays === 0) return;

      // Past-date revert. If any resulting target would land before
      // TODAY, roll every child back to its pre-drag draft and open
      // the existing modal; Confirm re-plays the deltas.
      const todayMs = Date.now();
      let earliestNew = Infinity;
      for (const s of snapshot) {
        if (s.curTargetMs == null) continue;
        const newMs = s.curTargetMs + finalDeltaDays * 86_400_000;
        if (newMs < earliestNew) earliestNew = newMs;
      }
      if (earliestNew < todayMs) {
        setTargetDateDrafts((prev) => {
          const copy = { ...prev };
          for (const s of snapshot) {
            if (s.priorDraft) copy[s.key] = s.priorDraft;
            else delete copy[s.key];
          }
          return copy;
        });
        setPastDateConfirm({
          rowKey: slot.key,
          newTargetMs: earliestNew,
          kind: 'move',
          apply: () => {
            setTargetDateDrafts((prev) => ({ ...prev, ...Object.fromEntries(appliedTargets) }));
          },
        });
      }
      // Otherwise: drafts already written during onMove — nothing else
      // to do here. Save-all picks them up unchanged.
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };


  // Empty state — rendered AFTER all hooks so the hook count stays
  // constant across renders (see note above).
  if (orderedRows.length === 0) {
    return (
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-400 dark:text-slate-500">
        No (zone × deliverable) rows yet — add tasks on the Planning tab first.
      </div>
    );
  }

  return (
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      {pastDateConfirm && (
        <PastDateConfirmModal
          onCancel={() => setPastDateConfirm(null)}
          onConfirm={() => {
            pastDateConfirm.apply();
            setPastDateConfirm(null);
          }}
          newDate={new Date(pastDateConfirm.newTargetMs).toISOString().slice(0, 10)}
        />
      )}
      {taskModalRow && (
        <DeliverableTasksModal
          row={taskModalRow}
          onClose={() => setTaskModalRow(null)}
        />
      )}

      {/* Toolbar — scroll navigation + Today jump. */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 dark:border-slate-800 bg-[#FAFBFC] text-[12px]">
        <span className="text-slate-500 dark:text-slate-400 font-medium">Timeline</span>
        <div className="flex items-center gap-1 ml-2">
          <button type="button" onClick={() => scrollByDays(-365)} className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-600 dark:text-slate-300" title="Scroll back one year">◀ Year</button>
          <button type="button" onClick={() => scrollByDays(-30)} className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-600 dark:text-slate-300" title="Scroll back one month">◀ Month</button>
          <button type="button" onClick={() => scrollToToday(true)} className="flex items-center gap-1 px-2.5 py-1 rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 font-semibold" title="Jump to today">Today</button>
          <button type="button" onClick={() => scrollByDays(30)} className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-600 dark:text-slate-300" title="Scroll forward one month">Month ▶</button>
          <button type="button" onClick={() => scrollByDays(365)} className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-600 dark:text-slate-300" title="Scroll forward one year">Year ▶</button>
        </div>
        {/* DPG-4 (2026-10-20) · Timeline-window selector. Picks how
            many years of calendar the Gantt shows at a time (1 / 2 / 3).
            Persisted via `visibleYears` state above — survives reloads
            under localStorage key `planwise:gantt:visible-years`. */}
        <div className="ml-3 inline-flex items-center gap-1.5" role="group" aria-label="Timeline range in years">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">טווח · Years</span>
          <div className="inline-flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/50 p-0.5">
            {([1, 2, 3] as const).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setVisibleYears(n)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[12px] font-semibold tabular-nums transition-all duration-150',
                  visibleYears === n
                    ? 'bg-white shadow-sm text-slate-900 dark:bg-slate-700/80 dark:text-slate-100'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
                )}
                aria-pressed={visibleYears === n}
                title={`Show ~${n} ${n === 1 ? 'year' : 'years'} at a time`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        {/* DPG-5 (2026-10-20) · Grid granularity selector. Picks the
            density of the timeline grid-lines + header ticks (month /
            week / day). Bar geometry stays calendar-week-based in every
            mode — only the pixel scale and header labels change.
            Persisted via `granularity` state under localStorage key
            `planwise:gantt:granularity`. */}
        <div className="ml-2 inline-flex items-center gap-1.5" role="group" aria-label="Grid granularity">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">גריד · Grid</span>
          <div className="inline-flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/50 p-0.5">
            {([
              { v: 'month', label: 'חודש · Month' },
              { v: 'week', label: 'שבוע · Week' },
              { v: 'day', label: 'יום · Day' },
            ] as const).map(({ v, label }) => (
              <button
                key={v}
                type="button"
                onClick={() => setGranularity(v)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[12px] font-semibold transition-all duration-150',
                  granularity === v
                    ? 'bg-white shadow-sm text-slate-900 dark:bg-slate-700/80 dark:text-slate-100'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
                )}
                aria-pressed={granularity === v}
                title={label}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {/* §4 (2026-11-10) · Task-bar overlay toggle. Flips whether each
            Gantt row renders per-task sub-bars + chain arrows (ON, default)
            or collapses back to the single deliverable backdrop (OFF).
            CP / non-CP bar + arrow palette documented in GanttRow. */}
        <div className="ml-2 inline-flex items-center gap-1.5" role="group" aria-label="Task bars">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">משימות · Tasks</span>
          <button
            type="button"
            onClick={() => setShowTaskBars((v) => !v)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[12px] font-semibold transition-all duration-150 border',
              showTaskBars
                ? 'bg-white shadow-sm text-slate-900 border-slate-200 dark:bg-slate-700/80 dark:text-slate-100 dark:border-slate-600'
                : 'bg-slate-100 text-slate-500 border-slate-200 hover:text-slate-700 dark:bg-slate-800/50 dark:text-slate-400 dark:border-slate-700',
            )}
            aria-pressed={showTaskBars}
            title={showTaskBars ? 'Hide per-task sub-bars + chain arrows' : 'Show per-task sub-bars + chain arrows'}
          >
            {showTaskBars ? 'הצג · Show' : 'הסתר · Hide'}
          </button>
        </div>
        {/* Progress legend — client meeting 2026-08-04. Bars are
            colored by aggregate task status: blue = nothing started,
            amber = at least one in progress, emerald = all done.
            No percentages (misleading on small totals). Past-target
            bars additionally get a red ring — kept subtle so status
            stays the primary signal.
            §7.3 (2026-11-11) · Chips now sit in a 2×2 grid so the
            toolbar stays one row even when the §4 task-bar toggle +
            granularity selector + years selector share the line. Each
            chip keeps its original glyph + label. */}
        <div className="ml-4 flex items-start gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 shrink-0 pt-0.5">Bar:</span>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-500" />Not started</span>
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-amber-500" />In progress</span>
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />Done</span>
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm ring-2 ring-red-300 ring-inset bg-white dark:bg-slate-900" />Past target</span>
          </div>
        </div>
        <span className="ml-auto text-[11px] text-slate-400 dark:text-slate-500">
          Showing ~{visibleYears} {visibleYears === 1 ? 'year' : 'years'} at a time · drag rows to reorder
        </span>
      </div>

      {/* 2-column grid — LEFT: labels (fixed), RIGHT: scrollable timeline. */}
      <div className="grid grid-cols-[260px_1fr]">
        {/* Header row spanning both columns — UI-14 relabels this
            dynamically from the configured outer/sub group dims (was a
            hardcoded "Deliverable · Zone" under DP-DISP-1). */}
        <div className="px-4 py-2 text-[11px] uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 border-r border-b border-slate-200 dark:border-slate-700 bg-[#FAFBFC] flex items-end">
          {dpGroupDimLabel(outerDim)}{innerDim ? ` · ${dpGroupDimLabel(innerDim)}` : ''}
        </div>
        <div
          className="overflow-hidden border-b border-slate-200 dark:border-slate-700 bg-[#FAFBFC]"
        >
          <div
            style={{ width: totalTimelineWidth, position: 'relative', transform: `translateX(${-scrollLeftPx}px)` }}
          >
            <div className="relative h-6 border-b border-slate-100 dark:border-slate-800">
              {yearBands.map((b, i) => (
                <div
                  key={i}
                  className="absolute top-0 h-full flex items-center border-l border-slate-200 dark:border-slate-700 pl-1.5 text-[11px] font-bold text-slate-700 dark:text-slate-200"
                  style={{ left: b.startPx, width: Math.max(0, b.endPx - b.startPx) }}
                >
                  {b.year}
                </div>
              ))}
            </div>
            {/* DPG-5 · Inner tick row. Density + label vary by
                granularity: month names (month), "W40 · Oct 5" (week),
                "20\nT" with month-start emphasis (day). The year band
                above stays identical across all three. */}
            <div className={cn('relative', granularity === 'day' ? 'h-8' : granularity === 'week' ? 'h-8' : 'h-6')}>
              {innerTicks.map((t, i) => (
                <div
                  key={i}
                  className={cn(
                    'absolute top-0 h-full flex flex-col justify-center pl-1 text-[10px] border-l',
                    t.emphasize
                      ? 'font-bold text-slate-700 dark:text-slate-200 border-slate-300 dark:border-slate-600'
                      : 'font-semibold text-slate-500 dark:text-slate-400 border-slate-100 dark:border-slate-800',
                  )}
                  style={{ left: t.px }}
                  title={t.sublabel ? `${t.label} · ${t.sublabel}` : t.label}
                >
                  <span className="leading-tight tabular-nums whitespace-nowrap">{t.label}</span>
                  {t.sublabel && (
                    <span className="leading-tight text-[9px] font-medium text-slate-400 dark:text-slate-500 tabular-nums whitespace-nowrap">
                      {t.sublabel}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Rows body — labels on left, scrollable bars on right. Both
          columns must scroll VERTICALLY in sync (they naturally do
          because both are in the same outer container); the timeline
          column scrolls HORIZONTALLY on its own.

          DP-5 · The two columns iterate `displaySlots` in lockstep so
          a `group` slot's label sits alongside its group track and
          each `zone` slot's label sits alongside its GanttRow.
          DPG-1b (2026-10-20) — the group track now ALWAYS shows a
          slate rollup bar (expanded + collapsed), so the user sees
          the aggregate span whether or not children are visible. */}
      <div className="grid grid-cols-[260px_1fr]">
        {/* Labels column */}
        <div className="divide-y divide-slate-100 dark:divide-slate-800 border-r border-slate-200 dark:border-slate-700">
          {displaySlots.map((slot, i) => {
            if (slot.kind === 'group') {
              const groupBodyId = `deliv-gantt-group-${slot.key}`;
              return (
                <div
                  key={`g-${slot.key}`}
                  className="group h-8 px-3 flex items-center gap-2 text-[12px] bg-slate-50 dark:bg-slate-800/60 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800"
                  onClick={() => onToggleCollapse(slot.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onToggleCollapse(slot.key);
                    }
                  }}
                  aria-expanded={!slot.isCollapsed}
                  aria-controls={groupBodyId}
                  tabIndex={0}
                >
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onToggleCollapse(slot.key); }}
                    className="inline-flex items-center justify-center w-5 h-5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 shrink-0"
                    aria-label={slot.isCollapsed ? `Expand ${slot.label}` : `Collapse ${slot.label}`}
                    title={slot.isCollapsed ? 'Expand' : 'Collapse'}
                  >
                    {slot.isCollapsed
                      ? <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                      : <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />}
                  </button>
                  <span className="font-bold text-slate-800 dark:text-slate-100 truncate shrink min-w-0">{slot.label}</span>
                  {/* DP-4 parity (2026-10-21) · amber "Building" (or
                      matching zone-type) badge — mirrors Planning tab's
                      ZoneTypePicker closed pill (planning-modal.tsx
                      L3414-3432). Same guard as TableView's zone-group
                      header: only when outer dim is Zone, not the
                      synthetic `zone:root` bucket, and the top-level
                      zoneType is known. See the TableView badge comment
                      above for the "no mystery slate pill" rationale. */}
                  {(() => {
                    if (outerDim !== 'zone' || slot.key === 'zone:root') return null;
                    const topId = slot.zones[0]?.topLevelZoneId as number | null | undefined;
                    if (topId == null) return null;
                    const zt = topLevelZoneTypeMap.get(topId);
                    const style = zt ? ZONE_TYPE_BADGE[zt] : undefined;
                    if (!zt || !style) return null;
                    const label = ZONE_DISPLAY[zt]?.label ?? zt;
                    return (
                      <span
                        className={cn(
                          'rounded-[5px] px-2 py-0.5 text-[11px] font-bold tracking-[0.05em] whitespace-nowrap shrink-0',
                          style.bg,
                          style.text,
                        )}
                        title={`Zone type: ${label}`}
                      >
                        {label}
                      </span>
                    );
                  })()}
                  {slot.readOnly && (
                    <span
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 whitespace-nowrap"
                      title={slot.readOnlyReason ?? 'Not yet planned'}
                    >
                      <Lock className="h-2.5 w-2.5" aria-hidden="true" />
                      Not planned
                    </span>
                  )}
                  <span className="ml-auto text-[10px] font-medium text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
                    {/* DP-DUPS (2026-10-21) · For a Zone bucket show
                        the UNIQUE deliverable count (what the PM reads
                        as "N deliverables"); for the other dims
                        (deliverable, service) the row count is the
                        correct quantity. */}
                    {outerDim === 'zone' ? slot.uniqueDeliverableCount : slot.zoneCount}
                    {outerDim === 'deliverable' ? 'z' : ''}
                    {slot.hoursSum > 0 ? ` · ${slot.hoursSum}h` : ''}
                  </span>
                </div>
              );
            }
            // zone slot — UI-14: label text depends on the sub-dim.
            const r = slot.r;
            const typeLabel = zoneTypeLabel(r.zoneType);
            const rowLabel = innerDim === 'zone' ? r.zoneName
              : innerDim === 'deliverable' ? r.deliverableName
              : innerDim === 'service' ? (r.serviceName ?? '—')
              : `${r.zoneName} · ${r.deliverableName}`;
            return (
              <div
                key={r.key}
                draggable
                onDragStart={() => setDragKey(r.key)}
                onDragEnd={() => { setDragKey(null); setDropIndicatorIdx(null); }}
                onDragOver={(e) => { e.preventDefault(); setDropIndicatorIdx(slot.zoneIdx); }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragKey && dragKey !== r.key) handleReorder(dragKey, slot.zoneIdx);
                  setDragKey(null);
                  setDropIndicatorIdx(null);
                }}
                className={cn(
                  'group h-8 pl-6 pr-4 text-[12px] flex items-center gap-2 cursor-grab active:cursor-grabbing hover:bg-slate-50/60 dark:hover:bg-slate-800/60',
                  dragKey === r.key && 'opacity-40',
                  dropIndicatorIdx === slot.zoneIdx && dragKey && dragKey !== r.key && 'border-t-2 border-blue-500',
                )}
                title="Drag to reorder"
                data-slot-index={i}
              >
                <span className="text-slate-300 dark:text-slate-600 group-hover:text-slate-500 leading-none">⋮⋮</span>
                {/* bm2 2026-10-21 — predecessor-conflict signal on the
                    Gantt row label. The DP row represents a (zone ×
                    deliverable) grouping; we flag it if ANY task under
                    it has an endDate earlier than one of its own
                    predecessors' endDate. Tooltip spells out the first
                    offender so the PM knows which task to open. */}
                {(() => {
                  const offender = (r.taskList ?? []).find((t: any) => hasPredecessorConflict(t));
                  if (!offender) return null;
                  const msg = getPredecessorConflictMessage(offender);
                  return (
                    <AlertTriangle
                      className="h-3 w-3 text-amber-500 dark:text-amber-400 shrink-0"
                      aria-label={msg ? `${offender.name}: ${msg}` : 'Predecessor conflict'}
                    />
                  );
                })()}
                <span className="font-medium text-slate-800 dark:text-slate-100 truncate">{rowLabel}</span>
                {/* DP-4 · zone-type badge in the Gantt label column.
                    Only renders when innerDim='zone' (otherwise the
                    badge wouldn't match the shown label). */}
                {innerDim === 'zone' && (
                  <span className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 whitespace-nowrap">
                    {typeLabel}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {/* Timeline column — the ONLY horizontal scroller. Its scroll
            position drives the header's translateX so year/month
            bands and today marker always sit above the correct week.
            Prev/Next-year and Today buttons operate on this ref. */}
        <div
          ref={bodyScrollRef}
          className="overflow-x-auto"
          onScroll={(e) => setScrollLeftPx((e.target as HTMLDivElement).scrollLeft)}
        >
          <div style={{ width: totalTimelineWidth, position: 'relative' }} className="divide-y divide-slate-100 dark:divide-slate-800">
            {/* Today vertical line (only if in range). */}
            {todayInRange && (
              <div
                className="absolute top-0 bottom-0 border-l-2 border-red-500 pointer-events-none z-20"
                style={{ left: todayPx }}
                title={`Today: ${new Date().toISOString().slice(0, 10)}`}
              >
                <span className="absolute -top-5 -translate-x-1/2 left-0 rounded bg-red-500 text-white text-[9px] px-1.5 py-0.5 font-bold whitespace-nowrap">
                  Today
                </span>
              </div>
            )}
            {displaySlots.map((slot) => {
              if (slot.kind === 'group') {
                // DPG-1b (2026-10-20) · Group track = ALWAYS-visible
                // rollup bar spanning earliest start → latest target
                // across the group's children (replaces the DP-5 split
                // where expanded groups rendered an empty divider). The
                // bar reads as a SUMMARY — quieter slate palette, no
                // shadow, lighter progress fill — so it never competes
                // visually with the per-zone bars below.
                //
                // DPG-3 (2026-10-20) · Grabbing the bar starts a cascade
                // drag: every child row shifts by the same delta (snap
                // to 7 days so Sunday alignment holds), proportions
                // preserved by construction. A near-zero drag toggles
                // the group's collapse state — same affordance the
                // label row has on the left column.
                const hasSpan = slot.earliestStartMs != null && slot.latestTargetMs != null;
                const rightPx = hasSpan ? ((slot.latestTargetMs! - startMs) / 86_400_000) * PX_PER_DAY : 0;
                const leftPx = hasSpan ? ((slot.earliestStartMs! - startMs) / 86_400_000) * PX_PER_DAY : 0;
                const widthPx = Math.max(6, rightPx - leftPx);
                const todayMsLocal = Date.now();
                const isPast = hasSpan && slot.latestTargetMs! < todayMsLocal;
                const progressPct = slot.taskTotal > 0
                  ? Math.min(100, Math.max(0, (slot.taskDone / slot.taskTotal) * 100))
                  : 0;
                const isDragging = rollupDragInfo?.groupKey === slot.key;
                return (
                  <div
                    key={`gtrack-${slot.key}`}
                    className="relative h-8 bg-slate-50 dark:bg-slate-800/60"
                  >
                    {hasSpan && (
                      <div
                        className={cn(
                          'absolute top-1.5 h-5 rounded-[5px] overflow-hidden',
                          // planwise-design slate palette — summary bar,
                          // visually quieter than the blue/amber/emerald
                          // per-zone bars below. No shadow (borders +
                          // ring carry the chrome).
                          'bg-slate-200 dark:bg-slate-700',
                          'ring-1 ring-slate-300/70 dark:ring-slate-600/70',
                          'hover:bg-slate-300/70 dark:hover:bg-slate-600 transition-colors duration-150',
                          // DPG-3 — drag handle on the entire bar.
                          // A near-zero drag still toggles collapse (see
                          // startRollupDrag.onUp), so the bar replaces
                          // its pre-DPG-3 `onClick={toggle}` with a
                          // pointer-down drag that falls through to a
                          // toggle on no-move releases.
                          'cursor-grab active:cursor-grabbing select-none',
                          isPast && 'ring-2 ring-red-400/70',
                          isDragging && 'ring-2 ring-blue-500',
                        )}
                        style={{ left: leftPx, width: widthPx }}
                        onPointerDown={startRollupDrag(slot)}
                        title={`${slot.label} — drag to shift all ${slot.zoneCount} rows together · click to ${slot.isCollapsed ? 'expand' : 'collapse'}`}
                      >
                        {/* Progress fill — slate-400/500 so it reads as a
                            quiet aggregate signal, not a status color. */}
                        {slot.taskTotal > 0 && (
                          <div
                            className="absolute inset-y-0 left-0 bg-slate-400/60 dark:bg-slate-500/60 pointer-events-none"
                            style={{ width: `${progressPct}%` }}
                          />
                        )}
                        <div className="relative h-full flex items-center justify-center px-1.5 text-[10px] font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap gap-1.5 truncate pointer-events-none">
                          <span className="truncate">{slot.label}</span>
                          {slot.spanWeeks > 0 && (
                            <span className="font-mono tabular-nums">· {slot.spanWeeks}w</span>
                          )}
                          {slot.taskTotal > 0 && (
                            <span className="font-mono tabular-nums">· {slot.taskDone}/{slot.taskTotal}</span>
                          )}
                        </div>
                      </div>
                    )}
                    {/* DPG-3 · live delta badge. Renders inside the
                        track strip so vertical alignment matches the
                        bar; pointer-events disabled so it never
                        swallows the drag. */}
                    {isDragging && rollupDragInfo && rollupDragInfo.deltaDays !== 0 && (
                      <div
                        className="absolute top-0.5 right-2 rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold tabular-nums bg-blue-600 text-white pointer-events-none z-10"
                      >
                        {rollupDragInfo.deltaDays > 0 ? '+' : ''}{rollupDragInfo.deltaDays} days
                      </div>
                    )}
                  </div>
                );
              }
              // zone slot → per-zone bar
              return (
                <GanttRow
                  key={slot.r.key}
                  r={slot.r}
                  projectId={projectId}
                  drafts={drafts}
                  durationDrafts={durationDrafts}
                  targetDateDrafts={targetDateDrafts}
                  setDrafts={setDrafts}
                  setDurationDrafts={setDurationDrafts}
                  setTargetDateDrafts={setTargetDateDrafts}
                  computePreview={computePreview}
                  startMs={startMs}
                  pxPerDay={PX_PER_DAY}
                  totalWidth={totalTimelineWidth}
                  showTaskBars={showTaskBars}
                  onRequestPastDate={(rowKey, newTargetMs, kind, apply) => setPastDateConfirm({ rowKey, newTargetMs, kind, apply })}
                  onBarClick={() => setTaskModalRow(slot.r)}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 italic flex items-center gap-4 flex-wrap">
        <span>* Bar length reflects <span className="font-semibold">calendar weeks</span> (not working time). Drag either edge to resize (duration changes). Drag the middle to move (target shifts; duration held). Scrolling backwards past today triggers a confirmation.</span>
        <span className="inline-flex items-center gap-1.5 not-italic">
          <span className="inline-block w-3 h-3 rounded border-2 border-red-600 dark:border-red-500 bg-transparent" />
          <span>Critical path (float = 0d)</span>
        </span>
      </div>
    </div>
  );
}

/**
 * §5 (2026-11-09, planwise-DP-predecessor-lag-scheduling-BUG) —
 * Build a human-readable chain summary of (predecessor → lag → successor)
 * edges across the tasks in a DP Gantt row, for use in the roll-up bar's
 * tooltip. The TaskDependency rows arrive on the wire with `lag` +
 * `lagUnit` (WORKING_DAYS = "wd", CALENDAR_DAYS = "cal"), so this helper
 * can render "CRD-002 → (7 wd) CRD-021 → (7 wd) CRD-036" with one line
 * per edge.
 *
 * This is the TOOLTIP FALLBACK path (not full per-task sub-bars). Chosen
 * for v1 because the current Gantt row is a single absolutely-positioned
 * bar with no reserved track for child bars + arrow connectors; adding
 * that would be a larger refactor of GanttView's geometry. The tooltip
 * exposes the chain + lag so the PM can verify the predecessor/lag
 * configuration without opening the task modal.
 *
 * The helper only considers edges whose predecessor is ALSO in the row's
 * taskList — cross-row dependencies are skipped so the chain stays local
 * to the (deliverable × zone) bucket the tooltip describes.
 */
function buildChainSummaryLines(taskList: any[] | null | undefined): string[] {
  if (!Array.isArray(taskList) || taskList.length === 0) return [];
  const byId = new Map<number, any>();
  for (const t of taskList) {
    if (t && typeof t.id === 'number') byId.set(t.id, t);
  }
  const taskLabel = (t: any): string => (t?.code || t?.name || `#${t?.id ?? '?'}`);
  const unitSuffix = (u: string | undefined): string =>
    u === 'CALENDAR_DAYS' ? 'cal' : 'wd';

  // Emit one line per FTS edge whose predecessor is in-row (keeps the
  // chain scoped to this bucket). A task with no in-row predecessor
  // still gets a single "start" line so the chain's head is visible in
  // the tooltip.
  const lines: string[] = [];
  for (const t of taskList) {
    const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
    const inRowDeps = deps.filter((d: any) => {
      const predId = d?.dependsOnId ?? d?.dependsOn?.id;
      return typeof predId === 'number' && byId.has(predId);
    });
    if (inRowDeps.length === 0) {
      lines.push(`• ${taskLabel(t)} (start)`);
      continue;
    }
    for (const d of inRowDeps) {
      const predId = d?.dependsOnId ?? d?.dependsOn?.id;
      const pred = predId != null ? byId.get(predId) : null;
      const lag = Number(d?.lag ?? 0);
      const unit = unitSuffix(d?.lagUnit);
      lines.push(`• ${taskLabel(pred)} → (${lag} ${unit}) → ${taskLabel(t)}`);
    }
  }
  return lines;
}

/**
 * One Gantt row. Renders ONLY the bar (labels live in the fixed left
 * column of GanttView). Positions are absolute px based on `pxPerDay`
 * so the horizontal viewport can scroll independently.
 *
 * Drag handles:
 *   - LEFT edge  → resize (duration grows leftward; target held).
 *   - RIGHT edge → resize (duration grows rightward; target shifts
 *                   so the left edge stays anchored — §8d).
 *   - MIDDLE     → move whole bar (target shifts; duration held).
 *
 * If the drag ends with the target in the past, we open a
 * confirmation modal (via onRequestPastDate); user can approve or
 * revert. Approve logs the change to the activity log (client
 * feedback 2026-08-02).
 */
function GanttRow({
  r,
  projectId,
  drafts,
  durationDrafts,
  targetDateDrafts,
  setDrafts,
  setDurationDrafts,
  setTargetDateDrafts,
  computePreview,
  startMs,
  pxPerDay,
  totalWidth,
  showTaskBars,
  onRequestPastDate,
  onBarClick,
}: {
  r: any;
  projectId: number;
  drafts: Record<string, string>;
  durationDrafts: Record<string, string>;
  targetDateDrafts: Record<string, string>;
  setDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  setDurationDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  setTargetDateDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  computePreview: (m: string) => string;
  startMs: number;
  pxPerDay: number;
  // §4 (2026-11-10) — total timeline width in px (needed to size the
  // per-row SVG overlay that draws task sub-bars + chain arrows) and the
  // toolbar toggle that gates the whole layer.
  totalWidth: number;
  showTaskBars: boolean;
  onRequestPastDate: (rowKey: string, newTargetMs: number, kind: 'target' | 'duration' | 'move' | 'resize', apply: () => void) => void;
  onBarClick: () => void;
}) {
  const draft = drafts[r.key] ?? '';
  const durDraft = durationDrafts[r.key] ?? '';
  // Resolution order for the bar's target date:
  //   1. explicit date from a Gantt drag (targetDateDrafts)
  //   2. months preview (drafts + baseDate)
  //   3. server savedDate
  // Item 1 gives the drag week-level precision (client feedback
  // 2026-08-02 item 4); items 2+3 preserve the classic table edit.
  const targetDate = targetDateDrafts[r.key] || computePreview(draft) || r.savedDate;
  const durationWeeks = Number(durDraft || r.savedDurationWeeks || 0);

  // §4 (2026-11-10) · Hoisted ABOVE the early-return below so hook count
  // stays stable when a row flips between "no target" and "has target"
  // (React's rules-of-hooks would otherwise throw "rendered fewer hooks
  // than expected"). The hook results are only consumed when targetDate
  // is set — see the task-bar overlay further down.
  type TaskBarItem = {
    id: number;
    code: string | null;
    name: string;
    hasSpan: boolean;
    startMs: number;
    endMs: number;
    lane: number;
    onCriticalPath: boolean;
    deps: Array<{ predId: number; lag: number; lagUnit: 'WORKING_DAYS' | 'CALENDAR_DAYS' }>;
  };
  const taskBarItems = useMemo<TaskBarItem[]>(() => {
    if (!showTaskBars) return [];
    const taskList: any[] = Array.isArray(r.taskList) ? r.taskList : [];
    if (taskList.length === 0) return [];
    const items: TaskBarItem[] = taskList.map((t: any) => {
      const sIso = t.estimatedStartDate ?? null;
      const eIso = t.endDate ?? null;
      const sMs = sIso ? new Date(sIso).getTime() : NaN;
      const eMs = eIso ? new Date(eIso).getTime() : NaN;
      const hasSpan = Number.isFinite(sMs) && Number.isFinite(eMs) && eMs >= sMs;
      return {
        id: Number(t.id),
        code: t.code ?? null,
        name: t.name ?? `#${t.id}`,
        hasSpan,
        startMs: hasSpan ? sMs : NaN,
        endMs: hasSpan ? eMs : NaN,
        lane: -1,
        onCriticalPath: Boolean(t.onCriticalPath),
        deps: (Array.isArray(t.dependencies) ? t.dependencies : [])
          .map((d: any) => ({
            predId: Number(d?.dependsOnId ?? d?.dependsOn?.id ?? 0),
            lag: Number(d?.lag ?? 0),
            lagUnit: (d?.lagUnit === 'CALENDAR_DAYS' ? 'CALENDAR_DAYS' : 'WORKING_DAYS') as
              | 'WORKING_DAYS'
              | 'CALENDAR_DAYS',
          }))
          .filter((d: { predId: number }) => d.predId > 0),
      };
    });
    // Greedy lane assignment on tasks with real date spans.
    const sortable = items.filter((i) => i.hasSpan);
    sortable.sort((a, b) => a.startMs - b.startMs);
    const laneEnds: number[] = [];
    for (const it of sortable) {
      let placed = false;
      for (let li = 0; li < laneEnds.length; li++) {
        if (laneEnds[li] <= it.startMs) {
          it.lane = li;
          laneEnds[li] = it.endMs;
          placed = true;
          break;
        }
      }
      if (!placed) {
        it.lane = laneEnds.length;
        laneEnds.push(it.endMs);
      }
    }
    return items;
  }, [showTaskBars, r.taskList]);
  const laneCount = useMemo(
    () => taskBarItems.reduce((m, i) => Math.max(m, i.lane + 1), 0),
    [taskBarItems],
  );
  const byId = useMemo(() => {
    const m = new Map<number, TaskBarItem>();
    for (const it of taskBarItems) m.set(it.id, it);
    return m;
  }, [taskBarItems]);

  if (!targetDate) {
    return (
      <div className="relative h-8 flex items-center text-[11px] text-slate-300 dark:text-slate-600 italic pl-2">
        no target
      </div>
    );
  }

  const targetMs = new Date(targetDate).getTime();
  const durMs = Math.max(0, durationWeeks * 7 * 86_400_000);
  const barStartMs = targetMs - durMs;

  // Pixel positions relative to the timeline start.
  const rightPx = ((targetMs - startMs) / 86_400_000) * pxPerDay;
  const leftPx = ((barStartMs - startMs) / 86_400_000) * pxPerDay;
  const widthPx = Math.max(4, rightPx - leftPx);

  const todayMs = Date.now();
  const isPastTarget = targetMs < todayMs;

  const startDrag = (mode: 'left' | 'right' | 'middle') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const initTargetMs = targetMs;
    const initDurationWeeks = durationWeeks;
    const initDurDraft = durDraft;
    const initTargetDateDraft = targetDateDrafts[r.key] ?? '';
    void draft; // reserved for future use — reads happen through targetDateDrafts now
    const initClientX = e.clientX;
    const msPerPx = 86_400_000 / pxPerDay;
    let finalTargetMs = initTargetMs;
    // Track the last-committed draft values so we can re-apply
    // atomically after the past-date confirmation modal.
    let lastTargetIso: string = initTargetDateDraft;
    let lastDurWeeks: string = initDurDraft;

    // Snap a raw ms timestamp to yyyy-mm-dd (server handles Sunday snap).
    const isoDayOf = (ms: number) => {
      const d = new Date(ms);
      d.setUTCHours(0, 0, 0, 0);
      return d.toISOString().slice(0, 10);
    };

    const onMove = (ev: PointerEvent) => {
      const dxPx = ev.clientX - initClientX;
      const dxMs = dxPx * msPerPx;
      if (mode === 'middle') {
        // MIDDLE drag → move (target shifts; duration held). Writes
        // an explicit ISO date — no more month-rounding round-trip
        // through the months+baseDate hack. Week-level precision
        // survives the save (client feedback 2026-08-02 item 4).
        finalTargetMs = Math.max(0, initTargetMs + dxMs);
        lastTargetIso = isoDayOf(finalTargetMs);
        setTargetDateDrafts((s) => ({ ...s, [r.key]: lastTargetIso }));
      } else if (mode === 'right') {
        // §8d (2026-11-12) · RIGHT edge drag now = resize (duration
        // AND target grow together), so the bar's left edge stays
        // anchored and the right edge follows the cursor. This
        // matches the user's model "both edges resize; middle moves"
        // and symmetrises with left-edge drag.
        // §8g (2026-11-12) · snap dxMs to whole weeks BEFORE computing
        // target, so duration (rounded to weeks) and target (shifted
        // in days) stay in lock-step and the left edge doesn't drift.
        const dxWeeks = Math.round(dxMs / (7 * 86_400_000));
        const snappedDxMs = dxWeeks * 7 * 86_400_000;
        const newDur = Math.max(0, initDurationWeeks + dxWeeks);
        finalTargetMs = Math.max(0, initTargetMs + snappedDxMs);
        lastTargetIso = isoDayOf(finalTargetMs);
        lastDurWeeks = String(newDur);
        setTargetDateDrafts((s) => ({ ...s, [r.key]: lastTargetIso }));
        setDurationDrafts((s) => ({ ...s, [r.key]: lastDurWeeks }));
      } else {
        // LEFT edge drag → change duration (target held). Negative
        // dx grows the bar leftward.
        const newDur = Math.max(0, Math.round(initDurationWeeks - dxMs / (7 * 86_400_000)));
        lastDurWeeks = String(newDur);
        setDurationDrafts((s) => ({ ...s, [r.key]: lastDurWeeks }));
      }
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);

      // Click detection — MIDDLE-mode near-zero drag opens the task
      // list modal instead of committing a target move (client
      // feedback 2026-08-02 items 2+3).
      const CLICK_SLOP = 3;
      const totalDx = Math.abs(ev.clientX - initClientX);
      if (mode === 'middle' && totalDx < CLICK_SLOP) {
        setTargetDateDrafts((s) => ({ ...s, [r.key]: initTargetDateDraft }));
        onBarClick();
        return;
      }

      const kind: 'target' | 'duration' | 'move' | 'resize' =
        mode === 'right' ? 'resize' :
        mode === 'middle' ? 'move' :
        'duration';
      if (mode !== 'left' && finalTargetMs < todayMs && finalTargetMs !== initTargetMs) {
        // Revert the explicit-date draft, then let the modal's
        // Apply callback re-apply. Server-side audit-logging fires
        // later in batchSetTargets when the user clicks Save.
        setTargetDateDrafts((s) => ({ ...s, [r.key]: initTargetDateDraft }));
        onRequestPastDate(r.key, finalTargetMs, kind, () => {
          setTargetDateDrafts((s) => ({ ...s, [r.key]: lastTargetIso }));
          setDurationDrafts((s) => ({ ...s, [r.key]: lastDurWeeks }));
        });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const total = r.taskTotal ?? 0;
  const started = r.taskStarted ?? 0;
  const done = r.taskDone ?? 0;

  // Bar color reflects TASK-STATUS progress (client meeting
  // 2026-08-04, Amit's proposal). Three states — no percentages
  // because those mislead when totals are small or unbalanced:
  //   • blue      — no task has started yet
  //   • amber     — at least one task is in progress
  //   • emerald   — all tasks are done
  //   • slate     — no tasks under this row (nothing to color)
  const barStatus: 'empty' | 'not_started' | 'in_progress' | 'done' =
    total === 0 ? 'empty'
    : done === total ? 'done'
    : started > 0 ? 'in_progress'
    : 'not_started';
  const barColor =
    barStatus === 'done'         ? 'bg-emerald-500/85 hover:bg-emerald-600'
    : barStatus === 'in_progress'? 'bg-amber-500/85 hover:bg-amber-600'
    : barStatus === 'not_started'? 'bg-blue-500/85 hover:bg-blue-600'
    :                              'bg-slate-300 dark:bg-slate-600 hover:bg-slate-400';
  // §8b.4 (2026-11-11) · Legacy darker-tint handle color is no
  // longer used — the two 12px edge hit zones below are invisible
  // until hover (then a neutral amber pill shows), so we no longer
  // need a per-status darker handle tint. Kept here as a comment so
  // the next pass can see the decision instead of hunting for it.
  const barStatusLabel =
    barStatus === 'done' ? 'All tasks done'
    : barStatus === 'in_progress' ? 'In progress'
    : barStatus === 'not_started' ? 'Not started'
    : 'No tasks';
  // Retain past-target hint via a subtle top border since color is
  // now taken by status. Users still see when a deliverable is
  // overdue without losing the progress signal.
  const pastHint = isPastTarget ? 'ring-2 ring-red-300 ring-inset' : '';
  // D7 (2026-11-03) · If any task under this row is on the critical
  // path, flag the whole bar with a red [CP] chip + bar outline.
  const anyCritical = Array.isArray((r as any).taskList)
    ? (r as any).taskList.some((t: any) => t?.onCriticalPath)
    : false;
  const critHint = anyCritical ? 'outline outline-2 outline-red-600/70 dark:outline-red-500/70 outline-offset-[1px]' : '';

  // §5 (2026-11-09) — tooltip fallback for the predecessor/lag chain.
  // Each line is "• predCode → (N wd|cal) → succCode"; chain head
  // tasks (no in-row predecessor) emit "• code (start)". Prepended to
  // the existing summary line via embedded newlines so `<div title>`
  // renders a stacked tooltip in modern browsers.
  const chainLines = buildChainSummaryLines(r.taskList);
  const chainHeader = chainLines.length > 0
    ? `${r.deliverableName}${r.zoneName ? ` · ${r.zoneName}` : ''} — chain + lag:`
    : null;
  const summaryLine = `${r.deliverableName} — ${targetDate} · ${durationWeeks}w · ${barStatusLabel}${isPastTarget ? ' · target past' : ''}${anyCritical ? ' · critical path' : ''} · click to edit tasks`;
  const tooltipTitle = chainHeader
    ? `${summaryLine}\n\n${chainHeader}\n${chainLines.join('\n')}`
    : summaryLine;

  // §4 (2026-11-10) — Per-task sub-bars + chain arrows. Each task in the
  // row's taskList that has BOTH estimatedStartDate + endDate renders as
  // a thin bar on the same weekly scale the deliverable backdrop uses.
  // Tasks on the scheduler's critical path (`onCriticalPath===true`) are
  // red; the rest are blue. Arrows from predecessor's right edge to
  // successor's left edge visualize in-row FTS dependencies (chain scoped
  // to this (deliverable × zone) bucket — cross-row deps are skipped so
  // the chain stays readable). CP arrows are red; non-CP are slate.
  //
  // The underlying `taskBarItems` / `laneCount` / `byId` are computed
  // ABOVE (hoisted past the `!targetDate` early return so hook count
  // stays constant across renders).
  const hasTaskBars = showTaskBars && laneCount > 0;

  // Vertical geometry. Deliverable backdrop keeps its top-2 h-4
  // position (y=8..24); task lanes stack beneath it, 6px bars + 4px
  // gaps, with 4px between the backdrop and the first lane.
  const TASK_BAR_H = 6;
  const TASK_LANE_GAP = 4;
  const TASK_STRIP_TOP = 28; // 8 (top pad) + 16 (backdrop h) + 4 (gap)
  const taskStripHeight = hasTaskBars
    ? laneCount * (TASK_BAR_H + TASK_LANE_GAP) - TASK_LANE_GAP
    : 0;
  const rowHeightPx = hasTaskBars ? TASK_STRIP_TOP + taskStripHeight + 4 : 32;

  // Helper: date-to-px on the ROW's local coordinate system (same scale
  // the deliverable backdrop uses — `leftPx/rightPx` above). Not DRY'd
  // further because the formula is a one-liner and extracting a helper
  // forced an extra prop drill through the Gantt viewport math.
  const msToPx = (ms: number): number => ((ms - startMs) / 86_400_000) * pxPerDay;
  // Lag label — short, Hebrew-flavored suffix to keep the chain readable
  // without ballooning: working-day lags → `+Nימ"ע`, calendar-day lags →
  // `+Nק`. Only emitted when lag > 0; zero-lag arrows stay unlabeled.
  const lagLabel = (lag: number, unit: 'WORKING_DAYS' | 'CALENDAR_DAYS'): string | null => {
    if (!Number.isFinite(lag) || lag <= 0) return null;
    return unit === 'WORKING_DAYS' ? `+${lag}ימ"ע` : `+${lag}ק`;
  };
  const CLIP_PAD = 2;

  return (
    <div
      className="relative select-none"
      style={{ height: rowHeightPx }}
    >
      {/* §8b.3 (2026-11-11) · Tri-mode drag strip. The outer bar
          owns the MIDDLE hit region (cursor-grab → grabbing, shifts
          both ends preserving duration). Two 12px-wide absolute hit
          zones sit over the left and right edges: left → w-resize,
          changes start (duration grows/shrinks from the left); right
          → e-resize, changes end only. Zones are positioned so they
          overlap the outer bar's pointerdown; stopPropagation inside
          `startDrag` keeps the middle handler from firing when an
          edge is grabbed. Day-snap stays in the scheduler path.
          §8b.4 (2026-11-11) · Hover affordances — three subtle
          handles revealed via `group-hover`: 6px pill at each edge
          + a 24×4 center grip. Colors are amber tokens (amber-500/60
          and /50) so they read as drag handles regardless of the
          bar's status color. */}
      <div
        className={cn(
          'group absolute top-2 h-4 rounded-md shadow-sm cursor-grab active:cursor-grabbing flex items-center justify-between overflow-hidden',
          barColor,
          pastHint,
          critHint,
          // When task bars are visible, dim the backdrop so the per-task
          // layer reads as the primary signal. The backdrop still shows
          // aggregate status + past-target + CP outline at a glance.
          hasTaskBars && 'opacity-60',
        )}
        style={{ left: leftPx, width: widthPx }}
        title={tooltipTitle}
        onPointerDown={startDrag('middle')}
      >
        <span className="text-white text-[10px] font-bold tabular-nums whitespace-nowrap px-3 truncate pointer-events-none mx-auto">
          {durationWeeks > 0 ? `${durationWeeks}w · ` : ''}{targetDate}
        </span>
        {/* Center grip (hover-only). pointer-events-none so the
            middle drag still catches clicks over it. */}
        <span
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-1 w-6 rounded bg-amber-500/50 opacity-0 group-hover:opacity-100 transition-opacity motion-reduce:transition-none pointer-events-none"
          aria-hidden="true"
        />
        {/* Left 12px hit zone + hover pill. */}
        <div
          className="absolute left-0 top-0 h-full w-3 cursor-w-resize"
          onPointerDown={startDrag('left')}
          title="Drag to change start (duration)"
        >
          <span
            className="absolute left-[2px] top-1/2 -translate-y-1/2 h-3 w-1.5 rounded-full bg-amber-500/60 opacity-0 group-hover:opacity-100 transition-opacity motion-reduce:transition-none pointer-events-none"
            aria-hidden="true"
          />
        </div>
        {/* Right 12px hit zone + hover pill. */}
        <div
          className="absolute right-0 top-0 h-full w-3 cursor-e-resize"
          onPointerDown={startDrag('right')}
          title="Drag to change target date"
        >
          <span
            className="absolute right-[2px] top-1/2 -translate-y-1/2 h-3 w-1.5 rounded-full bg-amber-500/60 opacity-0 group-hover:opacity-100 transition-opacity motion-reduce:transition-none pointer-events-none"
            aria-hidden="true"
          />
        </div>
      </div>
      {anyCritical && (
        <span
          className="absolute top-2 h-4 inline-flex items-center rounded-[4px] bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-[9px] font-bold tracking-wide px-1 pointer-events-none"
          style={{ left: rightPx + 4 }}
          title="At least one task on this deliverable is on the project's critical path"
        >
          CP
        </span>
      )}
      {/* §4 (2026-11-10) · Task-bar + chain-arrow overlay. Rendered as a
          single SVG so bars, arrows and lag labels share one coordinate
          space (the row's local px, same scale `msToPx` uses above). The
          SVG root is pointer-events-none so empty space passes through to
          the deliverable backdrop; each bar + line opts back in via inline
          `pointerEvents: auto` for its own hover tooltip. */}
      {hasTaskBars && totalWidth > 0 && (
        <svg
          className="absolute left-0"
          style={{ top: 0, width: totalWidth, height: rowHeightPx, pointerEvents: 'none' }}
          width={totalWidth}
          height={rowHeightPx}
          aria-hidden="true"
        >
          <defs>
            <marker
              id={`dp-arrow-cp-${r.key}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-red-500" />
            </marker>
            <marker
              id={`dp-arrow-nc-${r.key}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-slate-400" />
            </marker>
          </defs>
          {/* Task bars first (under arrows) */}
          {taskBarItems.map((it) => {
            if (!it.hasSpan) return null;
            const rawLeft = msToPx(it.startMs);
            const rawRight = msToPx(it.endMs);
            // Skip bars entirely outside the timeline viewport range;
            // bars that straddle the edge are clamped and marked with a
            // small overflow triangle (edge-case per the spec).
            if (rawRight < 0 || rawLeft > totalWidth) return null;
            const clampedLeft = Math.max(rawLeft, 0);
            const clampedRight = Math.min(rawRight, totalWidth);
            const w = Math.max(2, clampedRight - clampedLeft);
            const y = TASK_STRIP_TOP + it.lane * (TASK_BAR_H + TASK_LANE_GAP);
            const barClass = it.onCriticalPath
              ? 'fill-red-100 stroke-red-500 dark:fill-red-500/20 dark:stroke-red-400'
              : 'fill-blue-100 stroke-blue-500 dark:fill-blue-500/20 dark:stroke-blue-400';
            const bodyTitle = `${it.code ? `${it.code} · ` : ''}${it.name}${it.onCriticalPath ? ' · critical path' : ''}`;
            const clippedLeft = rawLeft < -CLIP_PAD;
            const clippedRight = rawRight > totalWidth + CLIP_PAD;
            return (
              <g key={`bar-${it.id}`} style={{ pointerEvents: 'auto' }}>
                <rect
                  x={clampedLeft}
                  y={y}
                  width={w}
                  height={TASK_BAR_H}
                  rx={3}
                  ry={3}
                  strokeWidth={1}
                  className={barClass}
                >
                  <title>{bodyTitle}</title>
                </rect>
                {/* Overflow markers — small triangle on the clipped edge
                    so the PM knows the task extends past the visible
                    timeline. Pointer-events off (visual only). */}
                {clippedLeft && (
                  <path
                    d={`M ${clampedLeft} ${y + TASK_BAR_H / 2} l 4 -3 l 0 6 z`}
                    className={it.onCriticalPath ? 'fill-red-500' : 'fill-blue-500'}
                    style={{ pointerEvents: 'none' }}
                  />
                )}
                {clippedRight && (
                  <path
                    d={`M ${clampedRight} ${y + TASK_BAR_H / 2} l -4 -3 l 0 6 z`}
                    className={it.onCriticalPath ? 'fill-red-500' : 'fill-blue-500'}
                    style={{ pointerEvents: 'none' }}
                  />
                )}
              </g>
            );
          })}
          {/* Chain arrows */}
          {taskBarItems.flatMap((succ) => {
            if (succ.deps.length === 0) return [];
            return succ.deps.map((dep, di) => {
              const pred = byId.get(dep.predId);
              // Cross-row dep — out of scope for this row's chain;
              // handled by the tooltip's `buildChainSummaryLines` list.
              if (!pred) return null;
              const isCP = succ.onCriticalPath && pred.onCriticalPath;
              const strokeClass = isCP
                ? 'stroke-red-500 dark:stroke-red-400'
                : 'stroke-slate-300 dark:stroke-slate-500';
              const strokeW = isCP ? 1.5 : 1;
              const markerId = isCP ? `dp-arrow-cp-${r.key}` : `dp-arrow-nc-${r.key}`;
              const label = lagLabel(dep.lag, dep.lagUnit);
              const labelClass = cn(
                'font-mono text-[10px]',
                isCP ? 'fill-red-600 dark:fill-red-400' : 'fill-slate-500 dark:fill-slate-400',
              );

              // Case A: predecessor has no span — render dashed stub into
              // the successor's left edge so the chain's incoming edge is
              // still visible without inventing a position for the pred.
              if (!pred.hasSpan) {
                if (!succ.hasSpan) return null;
                const sLeftRaw = msToPx(succ.startMs);
                if (sLeftRaw < -CLIP_PAD || sLeftRaw > totalWidth + CLIP_PAD) return null;
                const sLeft = Math.max(0, Math.min(totalWidth, sLeftRaw));
                const sY = TASK_STRIP_TOP + succ.lane * (TASK_BAR_H + TASK_LANE_GAP) + TASK_BAR_H / 2;
                const stubFromX = Math.max(0, sLeft - 14);
                return (
                  <g key={`arr-${succ.id}-${di}`}>
                    <line
                      x1={stubFromX}
                      y1={sY}
                      x2={sLeft - 2}
                      y2={sY}
                      strokeDasharray="2 2"
                      strokeWidth={strokeW}
                      className={strokeClass}
                      markerEnd={`url(#${markerId})`}
                    />
                    {label && (
                      <text
                        x={(stubFromX + sLeft) / 2}
                        y={sY - 2}
                        textAnchor="middle"
                        className={labelClass}
                      >
                        {label}
                      </text>
                    )}
                  </g>
                );
              }
              // Case B: successor has no span — nothing to anchor the
              // arrow to on the right side; the dep is represented in
              // the tooltip chain list only.
              if (!succ.hasSpan) return null;

              // Normal case: pred right edge → succ left edge. If the
              // two bars overlap on X (succ starts before pred ends,
              // which is legal when lag < 0 or in same-day chains), draw
              // the arrow going UP-OVER the pred bar so it still reads as
              // a chain edge rather than a hidden overlap.
              const pRight = msToPx(pred.endMs);
              const sLeft = msToPx(succ.startMs);
              // Skip arrows whose BOTH endpoints are outside the timeline
              // viewport — nothing to draw. One endpoint inside is still
              // worth drawing (clamped) so the chain's edge is visible.
              if (
                (pRight < 0 && sLeft < 0) ||
                (pRight > totalWidth && sLeft > totalWidth)
              ) {
                return null;
              }
              const pY = TASK_STRIP_TOP + pred.lane * (TASK_BAR_H + TASK_LANE_GAP) + TASK_BAR_H / 2;
              const sY = TASK_STRIP_TOP + succ.lane * (TASK_BAR_H + TASK_LANE_GAP) + TASK_BAR_H / 2;
              // Clamp endpoints so a far-off bar still draws its arrow
              // stub at the viewport edge instead of blowing out the SVG.
              const x1 = Math.max(0, Math.min(totalWidth, pRight));
              const x2 = Math.max(0, Math.min(totalWidth, sLeft - 2));
              const mx = (x1 + x2) / 2;
              const my = (pY + sY) / 2;
              // Same-lane straight line; cross-lane gets a simple L-shape
              // via an SVG polyline (horizontal → vertical → horizontal).
              if (pred.lane === succ.lane) {
                return (
                  <g key={`arr-${succ.id}-${di}`}>
                    <line
                      x1={x1}
                      y1={pY}
                      x2={x2}
                      y2={sY}
                      strokeWidth={strokeW}
                      className={strokeClass}
                      markerEnd={`url(#${markerId})`}
                    />
                    {label && (
                      <text
                        x={mx}
                        y={my - 2}
                        textAnchor="middle"
                        className={labelClass}
                      >
                        {label}
                      </text>
                    )}
                  </g>
                );
              }
              // Cross-lane: pred's right → short horizontal → vertical → short horizontal into succ's left.
              const elbowX = Math.max(x1 + 4, x2 - 4);
              return (
                <g key={`arr-${succ.id}-${di}`}>
                  <polyline
                    points={`${x1},${pY} ${elbowX},${pY} ${elbowX},${sY} ${x2},${sY}`}
                    fill="none"
                    strokeWidth={strokeW}
                    className={strokeClass}
                    markerEnd={`url(#${markerId})`}
                  />
                  {label && (
                    <text
                      x={elbowX}
                      y={my - 2}
                      textAnchor="middle"
                      className={labelClass}
                    >
                      {label}
                    </text>
                  )}
                </g>
              );
            });
          })}
        </svg>
      )}
      {/* DPG-2 (2026-10-20) — the 3-numbers badge (total · started · done)
          that used to render to the right of the bar was removed per
          client request. The counts remain available via the row's
          click-to-open task modal (DeliverableTasksModal below) and
          the bar's own color (blue / amber / emerald) already encodes
          aggregate task-status progress. `total`/`started`/`done`
          above are kept because they still drive `barStatus`. */}
    </div>
  );
}

/**
 * Modal shown when a Gantt drag moves the target into the past. The
 * user must explicitly confirm; on confirm the change is applied and
 * logged (via /activity-log). Cancel reverts.
 */
function PastDateConfirmModal({
  newDate,
  onConfirm,
  onCancel,
}: {
  newDate: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="w-[420px] rounded-[14px] bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700 p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
          </div>
          <div className="min-w-0">
            <h3 className="text-[15px] font-bold text-slate-800 dark:text-slate-100">Backdated target</h3>
            <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">You're setting the target to a date in the past.</p>
          </div>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] mb-4 space-y-1">
          <div><span className="text-slate-500 dark:text-slate-400">New target:</span> <span className="font-semibold text-amber-800">{newDate}</span></div>
          <div><span className="text-slate-500 dark:text-slate-400">Today:</span> <span className="font-semibold text-slate-700 dark:text-slate-200">{today}</span></div>
        </div>
        <p className="text-[12px] text-slate-600 dark:text-slate-300 mb-5">
          This change will be recorded in the project's activity log with your name and the previous target date. Continue?
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-[12px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3.5 py-1.5 rounded-lg bg-amber-600 text-white text-[12px] font-semibold hover:bg-amber-700"
          >
            Apply &amp; log
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Deliverable Tasks modal — opens when the user clicks a Gantt bar
 * (client feedback 2026-08-02 items 2 + 3). Lists every task under
 * that (zone × deliverable) with columns: Code, Name, Due date
 * (editable). Save writes each changed row via PATCH /tasks/:id and
 * flips the task's `dueDateOverridden` flag on the server. Refetches
 * planning data on close so the Gantt reflects the change.
 */
function DeliverableTasksModal({ row, onClose }: { row: any; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<number, string>>(() => {
    const seed: Record<number, string> = {};
    for (const t of row.taskList ?? []) seed[t.id] = t.endDate ?? '';
    return seed;
  });
  const [saving, setSaving] = useState(false);
  // §8c (2026-11-12) · Track which task rows the user has typed into
  // manually. Preview-driven draft auto-seeds skip rows in this set so
  // the user's typed value is preserved. Also controls whether the
  // commit payload sets `manualDueDate:true` — only true for rows the
  // user actually edited, since preview-driven dates come from the
  // scheduler and shouldn't fire `dueDateOverridden`.
  const [manualEdits, setManualEdits] = useState<Set<number>>(() => new Set());

  // §8b.1 (2026-11-11) · Open/close animation state. The parent still
  // owns whether the modal is in the tree (`taskModalRow !== null`);
  // this state drives the `AnimatedModalShell` transition. `open`
  // starts false and flips true on mount so the CSS transition fires;
  // `requestClose` defers the parent's `onClose` by 100ms so the exit
  // animation plays before the modal unmounts.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // rAF so the closed→open transition can trigger on the shell. We
    // also keep a mount flag so repeated renders don't restart the
    // animation (StrictMode double-invokes effects in dev).
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const closingRef = useRef(false);
  const requestClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setOpen(false);
    setTimeout(onClose, 120);
  };

  // §8c (2026-11-12) · Preview target picker now routes through the
  // server's working-day scheduler. The §8 spec requires a single
  // source of truth for working-day / holiday arithmetic — it must
  // NOT be duplicated in the FE. Previously this used a naive
  // calendar-day shift, which produced different dates than the
  // actual scheduler and ignored weekends / holidays / dependency
  // lag. We now POST to `/deliverables/:id/schedule/dry-run` with
  // `{ anchorDate }` (debounced), map results by taskId, and render
  // those dates directly.
  const [previewTarget, setPreviewTarget] = useState<string>(row.savedDate ?? '');
  const debouncedTarget = useDebounce(previewTarget, 300);
  const previewQuery = useQuery({
    queryKey: ['deliv-preview', row.deliverableId, debouncedTarget],
    enabled: Boolean(row.deliverableId) && Boolean(debouncedTarget) && debouncedTarget !== row.savedDate,
    queryFn: async () => {
      const r = await client.post(`/deliverables/${row.deliverableId}/schedule/dry-run`, {
        anchorDate: debouncedTarget,
      });
      return r.data as {
        scheduled: Array<{
          taskId: number;
          startDate: string;
          endDate: string;
          infeasible?: boolean;
          infeasibleReason?: string;
        }>;
      };
    },
  });
  const previewByTaskId = useMemo(() => {
    const m = new Map<number, { startDate: string; endDate: string; infeasible?: boolean; infeasibleReason?: string }>();
    if (!previewQuery.data) return m;
    for (const s of previewQuery.data.scheduled ?? []) {
      m.set(Number(s.taskId), {
        startDate: String(s.startDate).slice(0, 10),
        endDate: String(s.endDate).slice(0, 10),
        infeasible: s.infeasible,
        infeasibleReason: s.infeasibleReason,
      });
    }
    return m;
  }, [previewQuery.data]);
  const previewing = previewQuery.isFetching;
  const previewActive = previewTarget !== (row.savedDate ?? '') && Boolean(previewTarget);

  // §8c (2026-11-12) · When the dry-run returns, auto-seed any drafts
  // the user hasn't typed into. The input then shows the preview
  // endDate directly (BUG 2 — users thought "preview only" meant
  // nothing changed because the input was still at the saved value).
  useEffect(() => {
    if (!previewQuery.data) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const s of previewQuery.data!.scheduled ?? []) {
        const id = Number(s.taskId);
        if (manualEdits.has(id)) continue;
        next[id] = String(s.endDate).slice(0, 10);
      }
      return next;
    });
  }, [previewQuery.data, manualEdits]);

  // §8e (2026-11-12) · Shift-whole-chain semantic for per-task Due edits.
  // When the user types a new Due into any single row, compute the
  // calendar-day delta against that row's prior draft (fallback: the
  // task's stored endDate) and shift every OTHER row's draft AND the
  // `previewTarget` picker by the same Δ. This matches the user's
  // mental model that the chain moves as one block — if CRD-036 slides
  // +3 days, CRD-037, CRD-038, … and the deliverable target all slide
  // +3 days too. The real working-day scheduling still happens on the
  // server via the debounced dry-run that the `previewTarget` shift
  // triggers; this helper only moves the user's anchor so the shape
  // follows.
  //
  // All rows are marked as manually edited after the shift so the
  // dry-run auto-seed useEffect (above) does NOT clobber the shifted
  // drafts when the preview response lands. The dry-run response still
  // populates `previewByTaskId` for the amber "pendingShift" visual
  // cue on each row.
  const shiftChainBy = (taskId: number | string, newEnd: string) => {
    const id = Number(taskId);
    const tasks: any[] = row.taskList ?? [];
    const edited = tasks.find((t) => Number(t.id) === id);
    const oldDraft =
      (drafts[id] ?? '') ||
      String(edited?.endDate ?? '').slice(0, 10);

    // Row with no prior draft AND no stored endDate: treat as a plain
    // single-row set (nothing to compute Δ against). This is the
    // edge-case path for a brand-new task with no scheduled Due yet.
    if (!oldDraft || !newEnd) {
      setManualEdits((s) => {
        const next = new Set(s);
        next.add(id);
        return next;
      });
      setDrafts((s) => ({ ...s, [id]: newEnd }));
      return;
    }

    const oldMs = new Date(oldDraft).getTime();
    const newMs = new Date(newEnd).getTime();
    if (!Number.isFinite(oldMs) || !Number.isFinite(newMs)) {
      setManualEdits((s) => {
        const next = new Set(s);
        next.add(id);
        return next;
      });
      setDrafts((s) => ({ ...s, [id]: newEnd }));
      return;
    }
    const deltaDays = Math.round((newMs - oldMs) / 86_400_000);

    if (deltaDays === 0) {
      // User typed back the same date — just mark the row as touched.
      setManualEdits((s) => {
        const next = new Set(s);
        next.add(id);
        return next;
      });
      setDrafts((s) => ({ ...s, [id]: newEnd }));
      return;
    }

    // Shift every row's draft by Δ. The edited row itself lands on the
    // user's exact typed value (no accumulated rounding error).
    setDrafts((prev) => {
      const next = { ...prev };
      for (const t of tasks) {
        const tid = Number(t.id);
        if (tid === id) {
          next[tid] = newEnd;
          continue;
        }
        const currentDraft =
          (prev[tid] ?? '') || String(t.endDate ?? '').slice(0, 10);
        if (!currentDraft) continue;
        next[tid] = addDaysIso(currentDraft, deltaDays);
      }
      return next;
    });

    // Shift the deliverable's preview target by the same Δ so the
    // dry-run that follows anchors to the moved deliverable date, not
    // the original one. Skip when there's no saved target to shift.
    if (row.savedDate) {
      setPreviewTarget((prev) => {
        const base = prev || String(row.savedDate);
        return addDaysIso(base, deltaDays);
      });
    }

    // Flag EVERY row as manually edited so the dry-run auto-seed
    // useEffect leaves the shifted drafts alone when the preview
    // response arrives (the amber per-row preview cue still renders
    // from `previewByTaskId`, independent of `drafts`).
    setManualEdits(new Set(tasks.map((t) => Number(t.id))));
  };

  const dirty = (row.taskList ?? []).some((t: any) => (t.endDate ?? '') !== (drafts[t.id] ?? ''));

  const save = async () => {
    setSaving(true);
    try {
      const changed = (row.taskList ?? []).filter((t: any) => (t.endDate ?? '') !== (drafts[t.id] ?? ''));
      await Promise.all(
        changed.map((t: any) => {
          const nextEnd = drafts[t.id] || null;
          // §B override hardening (2026-11-09) — this modal is the
          // per-task due-date editor opened by clicking a Gantt bar:
          // the PM types a date into a single task's row and saves.
          // That's explicit user intent, so the BE needs the
          // `manualDueDate:true` signal to fire `dueDateOverridden`
          // and stop the scheduler from reshuffling the task later.
          // Clearing the date (nextEnd = null) stays silent — a null
          // never fires override regardless of the flag.
          //
          // §8c (2026-11-12) — Only fire `manualDueDate:true` for rows
          // the user actually typed into. Preview-driven draft values
          // come from the scheduler's own dry-run, so they must NOT
          // force `dueDateOverridden` (that would freeze the task
          // against future reschedules even though the user never
          // typed a value).
          const payload: Record<string, any> = { endDate: nextEnd };
          if (nextEnd && manualEdits.has(Number(t.id))) payload.manualDueDate = true;
          return client.patch(`/tasks/${t.id}`, payload);
        }),
      );
      notify.success(`Updated ${changed.length} due date${changed.length === 1 ? '' : 's'}`);
      // Refresh planning data — the row will pick up the new dates.
      queryClient.invalidateQueries({ queryKey: ['planning'] });
      requestClose();
    } catch (err: any) {
      notify.error(err?.response?.data?.message ?? 'Failed to save due dates');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatedModalShell
      open={open}
      onBackdropClick={requestClose}
      overlayClassName="bg-black/40"
      cardClassName="w-[720px] max-w-[92vw] max-h-[80vh] flex flex-col rounded-[14px] bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700"
    >
      <>
        <div className="flex items-start justify-between border-b border-slate-100 dark:border-slate-800 p-5">
          <div className="min-w-0">
            <h3 className="text-[15px] font-bold text-slate-800 dark:text-slate-100 truncate">{row.deliverableName}</h3>
            <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
              {row.zoneName}
              {row.serviceName ? <span> · {row.serviceName}</span> : null}
              {row.savedDate ? <span> · target {row.savedDate}</span> : null}
            </p>
            {/* §8c (2026-11-12) · Preview target picker. Routes
                through the server scheduler dry-run — the FE no longer
                does calendar-day math (§8 spec: one source of truth for
                working days / holidays). Debounced ~300ms to avoid a
                round-trip per keystroke. Save & update still owns the
                commit. */}
            {row.savedDate ? (
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Preview target
                </label>
                <input
                  type="date"
                  value={previewTarget}
                  onChange={(e) => setPreviewTarget(e.target.value)}
                  disabled={saving}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 px-2 py-1 text-[12px] font-mono tabular-nums bg-white dark:bg-slate-900 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                />
                {previewing ? (
                  <span className="text-[11px] text-slate-500 dark:text-slate-400 italic">
                    previewing…
                  </span>
                ) : previewActive ? (
                  <span className="text-[11px] text-amber-700 dark:text-amber-400">
                    preview only — Save &amp; update to commit
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setPreviewTarget(row.savedDate ?? '');
                      setManualEdits(new Set());
                      setDrafts(() => {
                        const seed: Record<number, string> = {};
                        for (const t of row.taskList ?? []) seed[t.id] = t.endDate ?? '';
                        return seed;
                      });
                    }}
                    disabled={saving || previewTarget === (row.savedDate ?? '')}
                    className="text-[11px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 disabled:opacity-40"
                    title="Reset to saved target"
                  >
                    reset
                  </button>
                )}
              </div>
            ) : null}
          </div>
          <button type="button" onClick={requestClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 text-[18px] leading-none px-1">×</button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {(row.taskList ?? []).length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400 dark:text-slate-500 italic">No tasks under this deliverable.</div>
          ) : (
            /* §7.4 (2026-11-11) · Table body delegated to the shared
               `TasksEditorTable` (mode='tasks-list'). The modal still
               owns `drafts` / `setDrafts` + the footer Save button;
               only the per-row rendering lives in the shared renderer
               so this and the Review modal share columns + styling.
               The `Status` + `CP`/`Float` cells collapse into the
               shared REASON slot (status pill) — the critical-path /
               float breakdown still shows on the Gantt row itself. */
            <TasksEditorTable
              mode="tasks-list"
              tasks={(row.taskList ?? []).map((t: any) => {
                // §8c (2026-11-12) · Preview rows come from the server
                // scheduler dry-run (working-day aware). When no
                // preview is active, fall back to the task's stored
                // scheduler values.
                const pv = previewByTaskId.get(Number(t.id));
                const proposedStart = pv?.startDate ?? (t.estimatedStartDate ?? t.startDate ?? null);
                const proposedEnd = pv?.endDate ?? (t.endDate ?? null);
                const pendingShift = Boolean(
                  pv &&
                    String(pv.endDate).slice(0, 10) !==
                      String(t.endDate ?? '').slice(0, 10),
                );
                return {
                  taskId: t.id,
                  taskCode: t.code ?? null,
                  taskName: t.name,
                  status: t.status ?? null,
                  currentStart: null,
                  proposedStart: proposedStart ? String(proposedStart).slice(0, 10) : null,
                  currentEnd: null,
                  proposedEnd: proposedEnd ? String(proposedEnd).slice(0, 10) : null,
                  pendingShift,
                };
              })}
              drafts={drafts}
              disabled={saving}
              onEdit={(taskId, end) => shiftChainBy(taskId, end)}
              onClear={(taskId) => {
                const id = Number(taskId);
                setManualEdits((s) => {
                  const next = new Set(s);
                  next.add(id);
                  return next;
                });
                setDrafts((s) => ({ ...s, [id]: '' }));
              }}
            />
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 dark:border-slate-800 px-5 py-3 bg-[#FAFBFC]">
          <div className="text-[11px] text-slate-500 dark:text-slate-400">
            {row.taskList?.length ?? 0} tasks · {dirty ? 'unsaved changes' : 'up to date'}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={requestClose}
              className="px-3.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-[12px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-900"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving}
              className="px-3.5 py-1.5 rounded-lg bg-blue-600 text-white text-[12px] font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : 'Save due dates'}
            </button>
          </div>
        </div>
      </>
    </AnimatedModalShell>
  );
}

/**
 * §7.4 (2026-11-11) · Shared task-list table used by BOTH the DP
 * reschedule Review modal and the per-deliverable Tasks modal. Lives
 * below the two modals so the colocation stays obvious — the modals
 * themselves keep their own state + footer actions (the point was to
 * unify the per-row renderer, not merge the modals).
 *
 * Column order is identical in both modes:
 *   CODE · TASK · REASON/STATUS · START · DUE · ACTION
 *
 * The only per-mode differences live inside the cell renderers:
 *   - mode='review'       — strikethrough currentStart / currentEnd
 *                           alongside proposed values; the Action cell
 *                           is a Keep-current / Apply-proposed toggle
 *                           (bulk "Apply approved (N)" stays in the
 *                           modal footer). REASON cell shows the
 *                           scheduler's manual/overload/hoursLogged
 *                           pill.
 *   - mode='tasks-list'   — plain Start/Due, editable Due input, a
 *                           per-row Clear button in Action. REASON
 *                           cell shows the task's status pill.
 *
 * Styling follows planwise-design tokens: codes + dates render in
 * `font-mono`, body at `text-[13px]`, header at `text-[11px] uppercase
 * font-semibold text-slate-400`.
 */
type TasksEditorRow = {
  taskId: number | string;
  taskCode: string | null;
  taskName: string;
  // Optional second line under the task name (review: deliverable · zone).
  context?: string | null;
  // Review mode — scheduler reason pill.
  reason?: 'manual' | 'overload' | 'hours-logged' | null;
  // Tasks-list mode — status pill.
  status?: string | null;
  currentStart?: string | null;
  proposedStart?: string | null;
  currentEnd?: string | null;
  proposedEnd?: string | null;
  // §8a (2026-11-11) · Preview-mode markers rendered alongside the
  // reason pill: amber dot when the scheduler's proposed endDate lands
  // after the deliverable's ZDT target; violet "hours-logged" chip when
  // this task already has reported hours. Both can co-exist. The flags
  // are optional + default false so the tasks-list mode render is
  // unchanged.
  violatesTarget?: boolean;
  hoursLogged?: boolean;
  // §8b.2 (2026-11-11) · Local-only preview shift. When true, the
  // row renders a small amber "pending" caption below the start/due
  // cells so the PM sees the shift is unsaved — committing still
  // goes through the Save & update flow. Kept optional so the review
  // modal's rows stay untouched.
  pendingShift?: boolean;
};

type TasksEditorTableProps = {
  tasks: TasksEditorRow[];
  mode: 'review' | 'tasks-list';
  disabled?: boolean;
  // Edit the Due/End input. Fires in both modes.
  onEdit?: (taskId: number | string, end: string) => void;
  // Review mode — per-row choice state + Keep/Apply handlers.
  choices?: Record<number | string, { apply: boolean; end: string }>;
  onKeepCurrent?: (taskId: number | string) => void;
  onApplyProposed?: (taskId: number | string) => void;
  // Tasks-list mode — draft map drives the Due input value.
  drafts?: Record<number | string, string>;
  onClear?: (taskId: number | string) => void;
};

function TasksEditorTable({
  tasks,
  mode,
  disabled,
  onEdit,
  choices,
  onKeepCurrent,
  onApplyProposed,
  drafts,
  onClear,
}: TasksEditorTableProps) {
  const reasonPill = (reason: TasksEditorRow['reason']) => {
    if (!reason) return null;
    const cls =
      reason === 'manual'
        ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-300'
        : reason === 'overload'
          ? 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300'
          : 'bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300';
    const label =
      reason === 'manual' ? 'ידני' : reason === 'overload' ? 'עומס' : 'שעות דווחו';
    return (
      <span className={cn('inline-flex rounded-[5px] text-[11px] font-bold tracking-wide px-2 py-0.5', cls)}>
        {label}
      </span>
    );
  };

  // §8a (2026-11-11) · Preview-mode reason cell. Combines the
  // violatesTarget amber-dot, the hours-logged chip (reused from the
  // reasonPill palette) and any legacy `reason` pill. When nothing to
  // show, renders the em-dash placeholder — this preserves the cell's
  // visual density across rows.
  const reasonCell = (t: TasksEditorRow) => {
    const pill = reasonPill(t.reason);
    const hoursChip =
      t.hoursLogged && t.reason !== 'hours-logged' ? (
        <span className="inline-flex rounded-[5px] text-[11px] font-bold tracking-wide px-2 py-0.5 bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300">
          שעות דווחו
        </span>
      ) : null;
    const violatesDot = t.violatesTarget ? (
      <span
        className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500 shadow-[0_0_0_2px_rgba(251,191,36,0.2)]"
        title="חורג מיעד"
        aria-label="חורג מיעד"
      />
    ) : null;
    if (!pill && !hoursChip && !violatesDot) {
      return <span className="text-slate-300 dark:text-slate-600">—</span>;
    }
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        {violatesDot}
        {pill}
        {hoursChip}
      </div>
    );
  };

  const statusPill = (status: TasksEditorRow['status']) => {
    if (!status) return <span className="text-slate-300 dark:text-slate-600">—</span>;
    const cls =
      status === 'done' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' :
      status === 'in_progress' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' :
      status === 'in_review' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' :
      status === 'blocked' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' :
      'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300';
    return (
      <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold', cls)}>
        {status}
      </span>
    );
  };

  return (
    <table className="w-full text-[13px]">
      <thead className="bg-[#FAFBFC] sticky top-0 z-10">
        <tr className="text-left text-[11px] uppercase font-semibold tracking-wider text-slate-400 dark:text-slate-500">
          <th className="px-3 py-2 w-[108px]">Code</th>
          <th className="px-3 py-2">Task</th>
          <th className="px-3 py-2 w-[110px]">{mode === 'review' ? 'Reason' : 'Status'}</th>
          <th className="px-3 py-2 w-[110px]">Start</th>
          <th className={cn('px-3 py-2', mode === 'review' ? 'w-[170px]' : 'w-[200px]')}>{mode === 'review' ? 'תאריך יעד (Due)' : 'Due'}</th>
          <th className="px-3 py-2 w-[180px]">Action</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
        {tasks.map((t) => {
          const seedEnd = t.proposedEnd ?? t.currentEnd ?? '';
          const choice = choices?.[t.taskId] ?? { apply: true, end: seedEnd };
          const draftEnd = drafts?.[t.taskId] ?? '';
          return (
            <tr key={t.taskId} className="align-top hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
              <td className="px-3 py-2 font-mono text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                {t.taskCode || '—'}
              </td>
              <td className="px-3 py-2">
                <div className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate" title={t.taskName}>
                  {t.taskName}
                </div>
                {t.context ? (
                  <div className="text-[11px] text-slate-400 dark:text-slate-500 truncate">{t.context}</div>
                ) : null}
              </td>
              <td className="px-3 py-2">
                {mode === 'review' ? reasonCell(t) : statusPill(t.status)}
              </td>
              <td className="px-3 py-2">
                <div className="flex items-center gap-1 text-[11px] font-mono tabular-nums">
                  {mode === 'review' && t.currentStart ? (
                    <span className="text-slate-400 line-through">{String(t.currentStart).slice(0, 10)}</span>
                  ) : null}
                  <span className={cn(
                    t.proposedStart ? 'text-slate-700 dark:text-slate-200' : 'text-slate-400 dark:text-slate-500',
                    t.pendingShift && 'text-amber-700 dark:text-amber-400',
                  )}>
                    {t.proposedStart ? String(t.proposedStart).slice(0, 10) : '—'}
                  </span>
                </div>
                {/* §8b.2 (2026-11-11) · Pending preview caption. Fires
                    when the DeliverableTasksModal's preview target has
                    shifted this task; the Save & update flow commits. */}
                {t.pendingShift ? (
                  <div className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                    pending — Save &amp; update to commit
                  </div>
                ) : null}
              </td>
              <td className="px-3 py-2">
                {mode === 'review' ? (
                  /* §8c (2026-11-12) · BUG 3 — stacked vertically so
                     the strikethrough current date + the input fit
                     inside the 170px DUE column. Previously the
                     side-by-side `flex items-center` pushed the cell
                     past 200px, which combined with the ACTION
                     column's 180px overflowed the 760px modal. */
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-xs text-slate-400 line-through tabular-nums">
                      {t.currentEnd ? String(t.currentEnd).slice(0, 10) : '—'}
                    </span>
                    <input
                      type="date"
                      value={choice.end}
                      disabled={!choice.apply || disabled}
                      onChange={(e) => onEdit?.(t.taskId, e.target.value)}
                      className="px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:border-blue-500 focus:outline-none text-[13px] font-mono w-full disabled:opacity-50"
                    />
                  </div>
                ) : (
                  /* §8c (2026-11-12) · The date input now auto-seeds
                     from the server dry-run (see
                     DeliverableTasksModal's preview effect) so the
                     user sees the preview value directly. The amber
                     border remains as the visual cue "this was
                     auto-filled by preview" — the ghost caption
                     below the input has been removed. */
                  <input
                    type="date"
                    value={draftEnd}
                    disabled={disabled}
                    onChange={(e) => onEdit?.(t.taskId, e.target.value)}
                    className={cn(
                      'rounded-lg border px-2 py-1 text-[13px] font-mono tabular-nums w-full focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50',
                      t.pendingShift
                        ? 'border-amber-300 dark:border-amber-700'
                        : 'border-slate-200 dark:border-slate-700',
                    )}
                  />
                )}
              </td>
              <td className="px-3 py-2">
                {mode === 'review' ? (
                  <div className="inline-flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onKeepCurrent?.(t.taskId)}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-50',
                        !choice.apply
                          ? 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200'
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100',
                      )}
                    >
                      Keep current
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onApplyProposed?.(t.taskId)}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-50',
                        choice.apply
                          ? 'bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-400'
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100',
                      )}
                    >
                      Apply proposed
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={disabled || !draftEnd}
                    onClick={() => onClear?.(t.taskId)}
                    className="rounded-md border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 px-2 py-1 disabled:opacity-40"
                    title="Clear this task's due date"
                  >
                    Clear
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
