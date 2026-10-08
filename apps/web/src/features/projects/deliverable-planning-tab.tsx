import { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Calendar, Save, RefreshCcw, Layers, LayoutGrid, GanttChart, AlertTriangle, ArrowUpDown, ChevronUp, ChevronDown, ChevronRight, Filter, Lock } from 'lucide-react';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { OpenInDriveButton } from '@/features/drive/open-in-drive-button';
import { MultiSelectFilter } from '@/components/shared/multi-select-filter';
import { EmptyState } from '@/components/shared/empty-state';
import { resolveTaskDeliverableDetailed } from '@/features/planning/resolve-task-deliverable';
import { GroupControl, dpGroupDimLabel, type DPGroupDim } from '@/features/planning/group-control';

/**
 * UI-14 · Resolve a row's value under a given group dimension. Returns
 * both a stable string key (used for grouping / collapse-set membership)
 * and a human label (shown in the group header or sub-row). The key is
 * namespaced per-dim so a zoneId and a deliverableId can never collide
 * when the user flips the primary dim mid-session.
 */
function rowDimKey(r: any, dim: DPGroupDim): string {
  if (dim === 'deliverable') return `del:${r.deliverableId}`;
  if (dim === 'zone') return `zone:${r.zoneId ?? 'root'}`;
  // service — Phase name is a string, nullable. Treat null/empty as a
  // dedicated "no service" bucket so rows don't get spread into the
  // default group silently.
  return `svc:${(r.serviceName ?? '').trim() || '(no service)'}`;
}
function rowDimLabel(r: any, dim: DPGroupDim): string {
  if (dim === 'deliverable') return r.deliverableName ?? `Deliverable #${r.deliverableId}`;
  if (dim === 'zone') return r.zoneName ?? '—';
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
  const [baseDate, setBaseDate] = useState<string>(todayStr);
  const [viewMode, setViewMode] = useState<'table' | 'gantt'>('table');
  const [filterHasDue, setFilterHasDue] = useState<'' | 'yes' | 'no'>('');
  // PR-012 · Service (aka Phase) multi-select filter for the Deliverable
  // view. Options are the unique service names present on the current
  // rows — sourced from `deliverable.service.name` (ProjectDeliverable →
  // Phase), same lookup the row's "Service" cell already renders.
  // Empty set = no filter (all rows). OR-within-filter; ANDs with the
  // due-date select above and the per-column text filters inside
  // TableView. Local state (not URL-backed) to match the other filters
  // on this tab. UI-only: the save/PERT/date-shift pipeline sees ALL
  // rows (this filter never enters the save payload).
  const [serviceFilter, setServiceFilter] = useState<Set<string>>(new Set());
  // Once at least one deliverable has a saved target, default to
  // Gantt view (client feedback 2026-08-02, item 6). Only flips once
  // per mount — the user can still switch back to Table manually.
  const [defaultedToGantt, setDefaultedToGantt] = useState(false);

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

  const { data: planningData } = useQuery<any>({
    queryKey: ['planning', projectId],
    queryFn: () => client.get(`/projects/${projectId}/planning-data`).then((r) => r.data?.data ?? r.data),
    enabled: !!projectId,
    staleTime: 60 * 1000,
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
    taskList: { id: number; code: string | null; name: string; endDate: string | null; status: string }[];
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
    // Group tasks by (deliverable, zone) so counts + endDate lists can
    // overlay onto rows generated from the deliverable × zone cross
    // product below.
    const grouped = new Map<string, any[]>();
    for (const t of tasks) {
      const dId = t.projectDeliverableId;
      if (dId == null) continue;
      const zoneId = t.zoneId ?? null;
      const key = `${dId}:${zoneId ?? 'root'}`;
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
      const zoneId = t.zoneId ?? null;
      const gKey = `${syn.id}:${zoneId ?? 'root'}`;
      if (!syntheticGrouped.has(gKey)) syntheticGrouped.set(gKey, []);
      syntheticGrouped.get(gKey)!.push(t);
    }

    const list: Row[] = [];
    const emitted = new Set<string>();
    const emit = (
      dId: number,
      deliverable: any,
      zoneId: number | null,
      zoneName: string,
      zoneType?: string,
      opts?: { readOnly?: boolean; readOnlyReason?: string; taskOverride?: any[] },
    ) => {
      const key = `${dId}:${zoneId ?? 'root'}`;
      if (emitted.has(key)) return;
      emitted.add(key);
      const group = opts?.taskOverride ?? grouped.get(key) ?? [];
      const zoneTargetRow = deliverable?.zoneTargets?.find((zt: any) => zt.zoneId === zoneId);
      const savedMonths = zoneTargetRow?.targetMonths ?? deliverable?.targetMonths ?? null;
      const savedDate = zoneTargetRow?.targetDate ?? deliverable?.targetDate ?? null;
      const savedDurationWeeks = zoneTargetRow?.estimatedDurationWeeks ?? deliverable?.estimatedDurationWeeks ?? null;
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
        status: t.status,
      }));
      list.push({
        key,
        deliverableId: dId,
        deliverableName: deliverable?.name ?? `Deliverable #${dId}`,
        zoneId,
        zoneName,
        zoneType,
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

    // Cross product of deliverables × zones (bm2 fix #1). When the
    // project has no zones, emit a single "Project Root" row per
    // deliverable so the grid isn't empty.
    for (const d of deliverables) {
      if (zonesFlat.length === 0) {
        emit(d.id, d, null, 'Project Root');
      } else {
        for (const z of zonesFlat) emit(d.id, d, z.id, z.name, z.zoneType);
      }
    }

    // Overlay any task-only groups that didn't match a known deliverable
    // (e.g. deliverable was deleted but tasks still reference it) or
    // that landed on the synthetic root zone even when zones exist —
    // preserves the pre-fix behavior for those edge cases.
    for (const [key, group] of grouped) {
      if (emitted.has(key)) continue;
      const first = group[0];
      const dId: number = first.projectDeliverableId;
      const zoneId: number | null = first.zoneId ?? null;
      const zone = zonesFlat.find((z) => z.id === zoneId);
      const deliverable = deliverables.find((d) => d.id === dId);
      emit(dId, deliverable, zoneId, zone?.name ?? (zoneId == null ? 'Project Root' : `Zone #${zoneId}`), zone?.zoneType);
    }

    // DP-EMPTY-3 — emit synthetic (read-only) rows for marker/template-
    // only tasks. Zoned tasks get one row per zone that actually holds
    // a matching task (no cross-product — we don't know which zones
    // the PM intends to plan against until they materialize the row).
    // Root tasks (zoneId=null) get a "Project Root" row.
    for (const [gKey, group] of syntheticGrouped) {
      const first = group[0];
      const zoneId: number | null = first.zoneId ?? null;
      const zone = zonesFlat.find((z) => z.id === zoneId);
      const dId = Number(gKey.split(':')[0]);
      const syn = Array.from(syntheticByName.values()).find((s) => s.id === dId);
      if (!syn) continue;
      emit(dId, syn, zoneId, zone?.name ?? (zoneId == null ? 'Project Root' : `Zone #${zoneId}`), zone?.zoneType, {
        readOnly: true,
        readOnlyReason: syn.readOnlyReason,
        taskOverride: group,
      });
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
  }, [tasks, zonesFlat, deliverables]);

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
   */
  const confirmExceed = async () => {
    if (!exceedPrompt) return;
    setExceedApplying(true);
    try {
      await save.mutateAsync();
      const updateIds = exceedPrompt
        .filter((t) => exceedChoices[t.taskId] === 'update')
        .map((t) => t.taskId);
      // Fire per-task force-apply in parallel — the endpoint is
      // idempotent and each hits a different task row so there's no
      // ordering constraint between them.
      const results = await Promise.allSettled(
        updateIds.map((id) => forceApply.mutateAsync(id)),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        notify.warning(`${updateIds.length - failed} of ${updateIds.length} task due dates updated`);
      } else if (updateIds.length > 0) {
        notify.success(`Updated ${updateIds.length} task due date${updateIds.length === 1 ? '' : 's'} to the new target`);
      }
      // Refresh planning so the updated task endDates are picked up.
      queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
    } finally {
      setExceedApplying(false);
      setExceedPrompt(null);
      setExceedChoices({});
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

  if (isLoading) return <div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">Loading deliverables...</div>;
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
        <div className="flex items-end gap-2 flex-wrap">
          {/* UI-14 · Group + sub-group — same control the Planning tab
              uses. Default primary=Deliverable, sub=Zone preserves the
              DP-DISP-1 ordering (Gantt label column reads "Deliverable
              · Zone"); flipping either dim regroups the Table rows
              AND relabels the Gantt row-label header. State is per-
              project in localStorage (see `groupingKey`). */}
          <div className="pb-1">
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Grouping</label>
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
              filters inside the table. */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Service</label>
            <MultiSelectFilter
              options={availableServices}
              selected={serviceFilter}
              onChange={setServiceFilter}
              placeholder="Services"
              title="Filter by service"
              triggerClassName="w-52"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Due date</label>
            <select
              value={filterHasDue}
              onChange={(e) => setFilterHasDue(e.target.value as any)}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
            >
              <option value="">All</option>
              <option value="yes">With target</option>
              <option value="no">Missing target</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Base date</label>
            <input
              type="date"
              value={baseDate}
              onChange={(e) => setBaseDate(e.target.value)}
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
              is lifted to this parent (and persisted per project). */}
          <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
            <button
              type="button"
              onClick={collapseAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-100"
              title="Collapse every deliverable group"
            >
              <ChevronRight className="h-3.5 w-3.5" /> Collapse all
            </button>
            <button
              type="button"
              onClick={expandAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-100"
              title="Expand every deliverable group"
            >
              <ChevronDown className="h-3.5 w-3.5" /> Expand all
            </button>
          </div>
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
          <button
            type="button"
            onClick={attemptSave}
            disabled={!hasUnsavedChanges || save.isPending}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-[13px] font-semibold"
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            {save.isPending ? 'Saving...' : 'Save all'}
          </button>
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
        />
      )}

      {hasUnsavedChanges && (
        <p className="text-[12px] text-blue-600 font-medium">
          You have unsaved changes. Click <span className="font-bold">Save all</span> to persist them.
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
}: {
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
  const [colFilters, setColFilters] = useState<Record<ColKey, string[]>>({
    deliverable: [], zone: [], service: [], months: [], duration: [], hours: [], target: [],
  });
  const [openFilter, setOpenFilter] = useState<null | ColKey>(null);
  // Sort state — one column at a time; asc/desc toggle.
  const [sort, setSort] = useState<{ col: ColKey; dir: 'asc' | 'desc' }>({ col: 'deliverable', dir: 'asc' });

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
    if (sort.col === 'deliverable') groups.sort((a, b) => cmp(a.label.toLowerCase(), b.label.toLowerCase()));
    else if (sort.col === 'service') groups.sort((a, b) => cmp((a.serviceName ?? '').toLowerCase(), (b.serviceName ?? '').toLowerCase()));
    else if (sort.col === 'zone') groups.sort((a, b) => cmp((a.zones[0]?.zoneName ?? '').toLowerCase(), (b.zones[0]?.zoneName ?? '').toLowerCase()));
    else if (sort.col === 'months') groups.sort((a, b) => cmp(Number(effectiveMonths(a.zones[0]) || 0), Number(effectiveMonths(b.zones[0]) || 0)));
    else if (sort.col === 'duration') groups.sort((a, b) => cmp(Number(effectiveDuration(a.zones[0]) || 0), Number(effectiveDuration(b.zones[0]) || 0)));
    else if (sort.col === 'hours') groups.sort((a, b) => cmp(effectiveHours(a.zones[0]), effectiveHours(b.zones[0])));
    else if (sort.col === 'target') groups.sort((a, b) => cmp(effectiveDate(a.zones[0]) || '', effectiveDate(b.zones[0]) || ''));

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
  }, [filtered, sort, drafts, durationDrafts, targetDateDrafts, outerDim]);

  const toggleSort = (col: typeof sort.col) => {
    setSort((s) => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }));
  };

  return (
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
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
                    <span className="truncate">{g.label}</span>
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
    hoursSum: number;
    latestTargetMs: number | null;
    earliestStartMs: number | null;
    latestTargetIso: string | null;
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
      for (const z of zonesArr) {
        hoursSum += Number(z.hours || 0);
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
        hoursSum,
        latestTargetMs,
        earliestStartMs,
        latestTargetIso: latestTargetMs ? new Date(latestTargetMs).toISOString().slice(0, 10) : null,
        readOnly: groupReadOnly,
        readOnlyReason: groupReadOnlyReason,
      });
      if (!isCollapsed) {
        for (const { z, zoneIdx } of entries) out.push({ kind: 'zone', r: z, zoneIdx });
      }
    }
    return out;
  }, [orderedRows, collapsed, drafts, durationDrafts, targetDateDrafts, computePreview, outerDim]);

  // Compact scale so 3 years fit in one viewport (client feedback
  // 2026-08-02 item 5). 8 px/week × 156 weeks (3 yr) ≈ 1250px, which
  // fits a typical laptop timeline column (viewport − 260px label
  // column ≈ 1000-1400px). Shorter than the old 30 px/week; users
  // can still pan for anything past 3 yr.
  const PX_PER_WEEK = 8;
  const PX_PER_DAY = PX_PER_WEEK / 7;
  const VISIBLE_YEARS = 3;

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
  const threeYearMs = baseDateMs + VISIBLE_YEARS * 365 * 86_400_000;
  const endMs = Math.max(latestTargetMs + 90 * 86_400_000, threeYearMs);
  const spanDays = Math.max(30, Math.round((endMs - startMs) / 86_400_000));
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
  // the end of the timeline.
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
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
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
  const [pastDateConfirm, setPastDateConfirm] = useState<null | { rowKey: string; newTargetMs: number; kind: 'target' | 'duration' | 'move'; apply: () => void }>(null);
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
        {/* Progress legend — client meeting 2026-08-04. Bars are
            colored by aggregate task status: blue = nothing started,
            amber = at least one in progress, emerald = all done.
            No percentages (misleading on small totals). Past-target
            bars additionally get a red ring — kept subtle so status
            stays the primary signal. */}
        <div className="ml-4 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">Bar:</span>
          <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-500" />Not started</span>
          <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-amber-500" />In progress</span>
          <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />Done</span>
          <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm ring-2 ring-red-300 ring-inset bg-white dark:bg-slate-900" />Past target</span>
        </div>
        <span className="ml-auto text-[11px] text-slate-400 dark:text-slate-500">
          Showing ~{VISIBLE_YEARS} years at a time · drag rows to reorder
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
            <div className="relative h-6">
              {monthTicks.map((t, i) => (
                <div
                  key={i}
                  className="absolute top-0 h-full flex items-center border-l border-slate-100 dark:border-slate-800 pl-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400"
                  style={{ left: t.px }}
                >
                  {MONTH_NAMES[t.month - 1]}
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
          a `group` slot's label sits alongside its group track (rolled-
          up bar when collapsed, empty divider when expanded), and each
          `zone` slot's label sits alongside its GanttRow. */}
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
                  <span className="font-bold text-slate-800 dark:text-slate-100 truncate">{slot.label}</span>
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
                    {slot.zoneCount}{outerDim === 'deliverable' ? 'z' : ''}{slot.hoursSum > 0 ? ` · ${slot.hoursSum}h` : ''}
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
                // DP-5 · Group track. Collapsed → single rolled-up bar
                // spanning earliest start → latest target across the
                // deliverable's zones, styled distinctly (taller, ring
                // + darker fill) so it reads as an aggregate rather
                // than a normal per-zone bar. Expanded → a thin muted
                // divider strip so the label's chevron still lines up
                // with a visible track (the zone bars follow below).
                if (!slot.isCollapsed) {
                  return (
                    <div
                      key={`gtrack-${slot.key}`}
                      className="relative h-8 bg-slate-50 dark:bg-slate-800/60"
                    />
                  );
                }
                const hasSpan = slot.earliestStartMs != null && slot.latestTargetMs != null;
                const rightPx = hasSpan ? ((slot.latestTargetMs! - startMs) / 86_400_000) * PX_PER_DAY : 0;
                const leftPx = hasSpan ? ((slot.earliestStartMs! - startMs) / 86_400_000) * PX_PER_DAY : 0;
                const widthPx = Math.max(6, rightPx - leftPx);
                const todayMsLocal = Date.now();
                const isPast = hasSpan && slot.latestTargetMs! < todayMsLocal;
                return (
                  <div
                    key={`gtrack-${slot.key}`}
                    className="relative h-8 bg-slate-50 dark:bg-slate-800/60 cursor-pointer"
                    onClick={() => onToggleCollapse(slot.key)}
                    title={`${slot.label} — click to expand`}
                  >
                    {hasSpan && (
                      <div
                        className={cn(
                          'absolute top-1.5 h-5 rounded-md shadow-md flex items-center overflow-hidden',
                          'bg-slate-700/90 hover:bg-slate-800 dark:bg-slate-500/90 dark:hover:bg-slate-400',
                          'ring-1 ring-slate-900/20 dark:ring-slate-100/20',
                          isPast && 'ring-2 ring-red-400/70',
                        )}
                        style={{ left: leftPx, width: widthPx }}
                      >
                        <span className="text-white text-[10px] font-bold tabular-nums whitespace-nowrap px-1.5 truncate">
                          {slot.hoursSum > 0 ? `Σ ${slot.hoursSum}h · ` : ''}{slot.latestTargetIso ?? ''}
                        </span>
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
                  onRequestPastDate={(rowKey, newTargetMs, kind, apply) => setPastDateConfirm({ rowKey, newTargetMs, kind, apply })}
                  onBarClick={() => setTaskModalRow(slot.r)}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 italic">
        * Bar length reflects <span className="font-semibold">calendar weeks</span> (not working time). Drag the left edge to change duration, the right edge (or middle) to change the target date. Scrolling backwards past today triggers a confirmation.
      </div>
    </div>
  );
}

/**
 * One Gantt row. Renders ONLY the bar (labels live in the fixed left
 * column of GanttView). Positions are absolute px based on `pxPerDay`
 * so the horizontal viewport can scroll independently.
 *
 * Drag handles:
 *   - LEFT edge → change duration (target held).
 *   - RIGHT edge → change target date (duration held).
 *   - MIDDLE → move whole bar (target shifts, duration held).
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
  onRequestPastDate: (rowKey: string, newTargetMs: number, kind: 'target' | 'duration' | 'move', apply: () => void) => void;
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
      if (mode === 'right' || mode === 'middle') {
        // Target drags (right edge OR middle-move) now write an
        // explicit ISO date — no more month-rounding round-trip
        // through the months+baseDate hack. Week-level precision
        // survives the save (client feedback 2026-08-02 item 4).
        finalTargetMs = Math.max(0, initTargetMs + dxMs);
        lastTargetIso = isoDayOf(finalTargetMs);
        setTargetDateDrafts((s) => ({ ...s, [r.key]: lastTargetIso }));
      } else {
        // Left edge → change duration (target held).
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

      const kind: 'target' | 'duration' | 'move' = mode === 'right' ? 'target' : mode === 'left' ? 'duration' : 'move';
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
  const handleColor =
    barStatus === 'done'         ? 'bg-emerald-700/40 hover:bg-emerald-800'
    : barStatus === 'in_progress'? 'bg-amber-700/40 hover:bg-amber-800'
    : barStatus === 'not_started'? 'bg-blue-700/40 hover:bg-blue-800'
    :                              'bg-slate-500/40 hover:bg-slate-600';
  const barStatusLabel =
    barStatus === 'done' ? 'All tasks done'
    : barStatus === 'in_progress' ? 'In progress'
    : barStatus === 'not_started' ? 'Not started'
    : 'No tasks';
  // Retain past-target hint via a subtle top border since color is
  // now taken by status. Users still see when a deliverable is
  // overdue without losing the progress signal.
  const pastHint = isPastTarget ? 'ring-2 ring-red-300 ring-inset' : '';

  return (
    <div className="relative h-8 select-none">
      <div
        className={cn('absolute top-2 h-4 rounded-md shadow-sm cursor-pointer flex items-center justify-between overflow-hidden', barColor, pastHint)}
        style={{ left: leftPx, width: widthPx }}
        title={`${r.deliverableName} — ${targetDate} · ${durationWeeks}w · ${barStatusLabel}${isPastTarget ? ' · target past' : ''} · click to edit tasks`}
        onPointerDown={startDrag('middle')}
      >
        <div
          className={cn('w-1.5 h-full cursor-ew-resize shrink-0', handleColor)}
          onPointerDown={startDrag('left')}
          title="Drag to change duration"
        />
        <span className="text-white text-[10px] font-bold tabular-nums whitespace-nowrap px-1 truncate">
          {durationWeeks > 0 ? `${durationWeeks}w · ` : ''}{targetDate}
        </span>
        <div
          className={cn('w-1.5 h-full cursor-ew-resize shrink-0', handleColor)}
          onPointerDown={startDrag('right')}
          title="Drag to change target date"
        />
      </div>
      {total > 0 && (
        <div
          className="absolute top-1 flex items-center gap-1 text-[10px] font-bold tabular-nums text-slate-600 dark:text-slate-300 bg-white/90 rounded px-1 pointer-events-none"
          style={{ left: rightPx + 6 }}
          title={`${total} tasks · ${started} started · ${done} done`}
        >
          <span className="text-slate-700 dark:text-slate-200">{total}</span>
          <span className="text-slate-300 dark:text-slate-600">·</span>
          <span className="text-blue-600">{started}</span>
          <span className="text-slate-300 dark:text-slate-600">·</span>
          <span className="text-emerald-600">{done}</span>
        </div>
      )}
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

  const dirty = (row.taskList ?? []).some((t: any) => (t.endDate ?? '') !== (drafts[t.id] ?? ''));

  const save = async () => {
    setSaving(true);
    try {
      const changed = (row.taskList ?? []).filter((t: any) => (t.endDate ?? '') !== (drafts[t.id] ?? ''));
      await Promise.all(
        changed.map((t: any) =>
          client.patch(`/tasks/${t.id}`, { endDate: drafts[t.id] || null }),
        ),
      );
      notify.success(`Updated ${changed.length} due date${changed.length === 1 ? '' : 's'}`);
      // Refresh planning data — the row will pick up the new dates.
      queryClient.invalidateQueries({ queryKey: ['planning'] });
      onClose();
    } catch (err: any) {
      notify.error(err?.response?.data?.message ?? 'Failed to save due dates');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[720px] max-w-[92vw] max-h-[80vh] flex flex-col rounded-[14px] bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-slate-100 dark:border-slate-800 p-5">
          <div className="min-w-0">
            <h3 className="text-[15px] font-bold text-slate-800 dark:text-slate-100 truncate">{row.deliverableName}</h3>
            <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
              {row.zoneName}
              {row.serviceName ? <span> · {row.serviceName}</span> : null}
              {row.savedDate ? <span> · target {row.savedDate}</span> : null}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 text-[18px] leading-none px-1">×</button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {(row.taskList ?? []).length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400 dark:text-slate-500 italic">No tasks under this deliverable.</div>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="bg-[#FAFBFC] sticky top-0 z-10">
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="px-4 py-2 w-[110px]">Code</th>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2 w-[110px]">Status</th>
                  <th className="px-4 py-2 w-[160px]">Due date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {(row.taskList ?? []).map((t: any) => (
                  <tr key={t.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
                    <td className="px-4 py-2 text-slate-500 dark:text-slate-400 tabular-nums">{t.code ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-800 dark:text-slate-100 truncate">{t.name}</td>
                    <td className="px-4 py-2">
                      <span className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
                        t.status === 'done' ? 'bg-emerald-100 text-emerald-700' :
                        t.status === 'in_progress' ? 'bg-blue-100 text-blue-700' :
                        t.status === 'in_review' ? 'bg-amber-100 text-amber-700' :
                        t.status === 'blocked' ? 'bg-red-100 text-red-700' :
                        'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
                      )}>{t.status}</span>
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="date"
                        value={drafts[t.id] ?? ''}
                        onChange={(e) => setDrafts((s) => ({ ...s, [t.id]: e.target.value }))}
                        className="rounded border border-slate-200 dark:border-slate-700 px-2 py-1 text-[12px] tabular-nums w-full focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 dark:border-slate-800 px-5 py-3 bg-[#FAFBFC]">
          <div className="text-[11px] text-slate-500 dark:text-slate-400">
            {row.taskList?.length ?? 0} tasks · {dirty ? 'unsaved changes' : 'up to date'}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
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
      </div>
    </div>
  );
}
