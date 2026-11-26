import { useState, useMemo, useEffect, useCallback, Fragment } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import { useDrawerRoute } from '@/components/nav/use-drawer-route';
import { OpsErrorBanner, opsErrorMessage } from './parts/ops-shared';
import { WorkloadDayHeaders } from './parts/workload-day-headers';
import { TaskChip, chipTitle } from './parts/workload-chip';
import {
  DraggableChip,
  DropTd,
  WORKLOAD_AUTO_SCROLL,
  WORKLOAD_MEASURING,
  workloadCollision,
  workloadKeyboardCoordinates,
  type DragData,
  type DropTarget,
} from './parts/workload-dnd';
import { CellPreview, WorkloadPersonCell, type RowReason } from './parts/workload-drag-feedback';
import { WorkloadTray } from './parts/workload-tray';
import {
  canDragChip,
  dayLabel,
  dropCheck,
  dropReasonText,
  mergeAssignProjects,
  overloadCausing,
  previewPct,
  reassignBody,
  trayLandingDays,
  type DragSource,
  type DropCheck,
} from './workload-assign';
import { EMPTY_ASSIGN, normalizeTeamWorkload, normalizeTray, type WorkloadTaskEntry, type WorkloadTray as Tray } from './workload-contract';
import { useWorkloadAssign } from './use-workload-assign';
import { dragVia, useStuckDragRecovery } from './workload-drag-recovery';
import {
  BOARD_MOVED_TEXT,
  answerTeamConfirm,
  dropTargetAtPoint,
  handleDrop,
  releasePoint,
  useHoldWhileDragging,
  useLastPointer,
  type CellTarget,
  type TeamConfirmText,
} from './workload-drop-guards';
import { WorkloadTeamConfirm } from './parts/workload-team-confirm';
import {
  dayTasksTitle,
  formatWorkRange,
  groupByDepartment,
  shiftDateKey,
  utilizationPct,
  type TeamWorkload,
  type TeamWorkloadPerson,
} from './workload-range';

function getUtilColor(pct: number): string {
  if (pct === 0) return 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500';
  if (pct <= 50) return 'bg-green-100 text-green-700';
  if (pct <= 80) return 'bg-blue-100 text-blue-700';
  if (pct <= 100) return 'bg-amber-100 text-amber-700';
  return 'bg-red-200 text-red-700';
}

function getBarWidth(pct: number): string {
  return `${Math.min(100, pct)}%`;
}

/**
 * Legacy /dashboard/workload entry point.
 *
 * Consolidated in ux/breadcrumbs-dash — the Workload view now lives
 * as a tab inside the Operations dashboard (see operations-dashboard.tsx),
 * since both surfaces spoke to team capacity. This route is kept alive
 * as a redirect so bookmarks and external links keep resolving; the
 * body of the old page moved into <WorkloadPanel /> below and is
 * rendered by Operations when tab === 'workload'.
 */
export function WorkloadDashboardPage() {
  return <Navigate to="/operations?tab=workload" replace />;
}

const LOGGED_HIDDEN_TITLE = 'Logged hours are visible only for people you manage';
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const personName = (p: TeamWorkloadPerson | undefined | null) =>
  p ? p.name || [p.firstName, p.lastName].filter(Boolean).join(' ') : '';

/** Round 3 guard 4: a drop held until the team confirm answers. */
type TeamConfirmRequest = { drag: DragData; target: CellTarget; check: DropCheck; text: TeamConfirmText };

/** Unique tasks in a person's lane (masked chips counted apart). */
function laneCounts(p: TeamWorkloadPerson): { tasks: number; hidden: number } {
  const ids = new Set<number>();
  let hidden = 0;
  for (const d of p.days) {
    for (const c of d.tasks) {
      if (c.taskId != null && !c.masked) ids.add(c.taskId);
      else hidden++;
    }
  }
  return { tasks: ids.size, hidden };
}

/**
 * WorkloadPanel — the daily-per-user utilization table. Rendered by
 * the Operations dashboard's Workload tab. No PageHeader here — the
 * hosting page owns the header + summary strip.
 *
 * QA6 P3 (PR-073) — ONE call to `GET /workload/team` for every active
 * employee (it was a request per person, the first 30 only, errors
 * swallowed). The days are the API's: the org work week, Sunday first.
 * Department filter + group-by come from the org tree the same call
 * returns; "My department only" on the page narrows it server-side.
 *
 * QA6 P4 (PR-063) — drag-and-drop assignment. A chevron opens a person's
 * lane: his task chips in their day columns. A manager drags a chip to
 * another person's day (reassign), to another day in the same row
 * (reschedule), from the tray (assign) or onto the tray (unassign).
 * While dragging, every day cell previews before→after %, and rows the
 * task may not go to are dimmed with the reason. A cross-department move
 * waits for approval. Rules: workload-assign.ts; writes:
 * use-workload-assign.ts; wire contract: workload-contract.ts.
 */
export function WorkloadPanel({ myDeptOnly = false }: { myDeptOnly?: boolean }) {
  // A task-move notification opens this tab on the week of the move.
  const [searchParams] = useSearchParams();
  const urlWeekOf = searchParams.get('weekOf');
  const focusApprovals = searchParams.get('approvals') === '1';
  const [weekOf, setWeekOf] = useState<string | null>(urlWeekOf && YMD.test(urlWeekOf) ? urlWeekOf : null); // null = this week
  useEffect(() => {
    if (urlWeekOf && YMD.test(urlWeekOf)) setWeekOf(urlWeekOf);
  }, [urlWeekOf]);
  const [viewMode, setViewMode] = useState<'utilization' | 'hours'>('utilization');
  const [orgUnitId, setOrgUnitId] = useState<string>('');
  const [groupByDept, setGroupByDept] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [active, setActive] = useState<DragData | null>(null);
  const { openDrawer: setDrawerTaskId } = useDrawerRoute('task');

  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (weekOf) p.weekOf = weekOf;
    if (myDeptOnly) p.myDeptOnly = 'true';
    else if (orgUnitId) p.orgUnitId = orgUnitId;
    return p;
  }, [weekOf, myDeptOnly, orgUnitId]);
  const teamKey = useMemo(() => ['workload', 'team', params] as const, [params]);
  const trayKey = useMemo(() => ['workload', 'tray', params] as const, [params]);

  const teamQuery = useQuery<TeamWorkload>({
    queryKey: teamKey,
    staleTime: 2 * 60 * 1000,
    retry: 1,
    placeholderData: (prev) => prev,
    queryFn: () => client.get('/workload/team', { params }).then((r) => normalizeTeamWorkload(r.data?.data ?? r.data)),
  });

  // PR-063 tray: Unassigned + Overdue + the moves waiting for my approval.
  const trayQuery = useQuery<Tray>({
    queryKey: trayKey,
    staleTime: 60 * 1000,
    retry: 1,
    placeholderData: (prev) => prev,
    queryFn: () => client.get('/workload/tray', { params }).then((r) => normalizeTray(r.data?.data ?? r.data)),
  });

  // Round 3 (26.11) guard 3: while a chip is dragged the board shows, and
  // drops are checked against, what it showed when the drag started. A
  // refetch or realtime update that lands meanwhile only reaches the
  // screen when the drag ends (see holdWhileDragging).
  const board = useHoldWhileDragging(
    {
      data: teamQuery.data,
      isError: teamQuery.isError,
      error: teamQuery.error,
      isFetching: teamQuery.isFetching,
      tray: trayQuery.data,
      trayLoading: trayQuery.isLoading,
      trayError: trayQuery.isError,
    },
    active != null,
  );
  const { data, isError, error, isFetching } = board;
  const { isLoading, refetch } = teamQuery;

  const people: TeamWorkloadPerson[] = data?.people ?? [];
  const days = data?.days ?? [];
  const tasks = data?.tasks ?? {};
  const assign = data?.assign ?? EMPTY_ASSIGN;
  const restDays = data?.workWeek?.restDays ?? [];
  const rangeLabel = formatWorkRange(days.map((d) => d.date));
  const groups = useMemo(() => (groupByDept ? groupByDepartment(people) : null), [groupByDept, people]);
  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const dayByDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const overload = useMemo(() => overloadCausing(people, tasks), [people, tasks]);
  const view = data ? { from: data.range.from, to: data.range.to } : null;
  const { move, decide } = useWorkloadAssign({ view, teamKey });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: workloadKeyboardCoordinates }),
  );

  const canDragFor = useCallback(
    (task: WorkloadTaskEntry | null, fromUserId: number | null) =>
      canDragChip(task, fromUserId == null ? null : peopleById.get(fromUserId) ?? null),
    [peopleById],
  );

  // A tray task's project may be missing from the board's index: the drop
  // check reads both `assign.projects` blocks.
  const trayProjects = board.tray?.assign.projects;
  const dropAssign = useMemo(
    () => ({ projects: mergeAssignProjects(assign.projects, trayProjects), services: assign.services }),
    [assign.projects, assign.services, trayProjects],
  );

  const checkFor = useCallback(
    (a: DragData, p: TeamWorkloadPerson, toDay: string | null): DropCheck =>
      dropCheck(p, a.task, {
        source: a.source,
        toDay,
        assign: dropAssign,
        fromPerson: a.source.fromUserId != null ? peopleById.get(a.source.fromUserId) ?? null : null,
        day: toDay ? dayByDate.get(toDay) ?? null : null,
      }),
    [dropAssign, peopleById, dayByDate],
  );

  /** Hours the dragged chip would add to `date` (a tray chip lands by the D6 rule). */
  const dragHoursOn = useCallback(
    (a: DragData, date: string) => {
      if (a.source.fromDay != null) return a.source.hours;
      return trayLandingDays(a.task, date, restDays).find((l) => l.date === date)?.hours ?? a.source.hours;
    },
    [restDays],
  );

  const submit = (a: DragData, target: { userId: number; day: string } | null, check: DropCheck | null) => {
    if (!view) return;
    const fromUserId = a.source.fromUserId;
    const fromPerson = fromUserId != null ? peopleById.get(fromUserId) : undefined;
    const overdueName = (a.task as WorkloadTaskEntry & { assigneeName?: string | null }).assigneeName ?? null;
    const fromName = fromUserId != null ? personName(fromPerson) || overdueName || 'the current person' : null;
    const toName = target ? personName(peopleById.get(target.userId)) || 'the new person' : null;
    const otherAssigneeNames = a.task.assigneeIds
      .filter((uid) => uid !== fromUserId && uid !== target?.userId)
      .map((uid) => personName(peopleById.get(uid)) || 'another assignee');
    move.mutate({
      body: reassignBody(a.source, target, view),
      move: { task: a.task, fromUserId, toUserId: target?.userId ?? null, fromDay: a.source.fromDay, toDay: target?.day ?? null },
      origin: a.source.origin,
      predictPending: check?.needsApproval ?? false,
      teamKey,
      trayKey,
      names: { taskLabel: a.task.code ?? a.task.name, fromName, toName, otherAssigneeNames },
    });
    if (target && !check?.needsApproval) setExpanded((prev) => new Set(prev).add(target.userId));
  };

  // Round 2 (26.11): a drag that starts and ends inside one frame never
  // gets dnd-kit's onDragEnd. If a release / Escape is not followed by an
  // end within 300 ms, drop the drag and remount the DndContext.
  const [dndKey, setDndKey] = useState(0);
  const dragWatchdog = useStuckDragRecovery(() => {
    setActive(null);
    setDndKey((k) => k + 1);
  });

  const onDragStart = (e: DragStartEvent) => {
    dragWatchdog.started(dragVia(e.activatorEvent), e.activatorEvent?.timeStamp);
    setActive((e.active.data.current as DragData | undefined) ?? null);
  };
  const onDragCancel = () => {
    dragWatchdog.ended();
    setActive(null);
  };
  // Round 3 (26.11) guard 1: the release point of a pointer drag, from the
  // document's own pointer events (see releasePoint).
  const lastPointer = useLastPointer();

  // Round 3 (26.11) guard 4: a drop that would add the person to the
  // project Team waits here until the dialog answers; nothing is written
  // before "Add and assign".
  const [teamConfirm, setTeamConfirm] = useState<TeamConfirmRequest | null>(null);
  const answerTeam = (answer: 'add' | 'cancel') => {
    const request = teamConfirm;
    setTeamConfirm(null);
    answerTeamConfirm(request, answer, (r) => submit(r.drag, r.target, r.check));
  };

  const onDragEnd = (e: DragEndEvent) => {
    dragWatchdog.ended();
    const a = (e.active.data.current as DragData | undefined) ?? active;
    setActive(null);
    if (!a) return;
    const over = (e.over?.data.current as { target?: DropTarget } | undefined)?.target ?? null;
    // A pointer drop acts only on the cell under the released pointer. A
    // keyboard drag has no pointer: its target is the cell it moved to.
    const pointer =
      over && dragVia(e.activatorEvent) === 'pointer'
        ? dropTargetAtPoint(releasePoint(lastPointer.current, e.activatorEvent, e.delta))
        : over;
    handleDrop(
      {
        source: a.source,
        over,
        pointer,
        checkCell: (t) => {
          const person = peopleById.get(t.userId);
          return person ? checkFor(a, person, t.day) : null;
        },
      },
      {
        boardMoved: () => notify.warning(BOARD_MOVED_TEXT, { duration: 6000 }),
        blocked: (reason, t) =>
          notify.warning(dropReasonText(reason, a.task), {
            description: `${personName(peopleById.get(t.userId))} can't take ${a.task.code ?? a.task.name}.`,
            duration: 5000,
          }),
        confirmTeam: (t, check) =>
          setTeamConfirm({
            drag: a,
            target: t,
            check,
            text: {
              personName: personName(peopleById.get(t.userId)),
              projectName: a.task.projectName ?? '',
              task: { code: a.task.code, name: a.task.name },
              day: dayLabel(t.day),
              needsApproval: check.needsApproval,
            },
          }),
        submit: (t, check) => submit(a, t, check),
      },
    );
  };

  const announcements: Announcements = useMemo(() => {
    const label = (a: unknown) => {
      const d = (a as { data?: { current?: DragData } })?.data?.current;
      return d ? d.task.code ?? d.task.name : 'task';
    };
    const where = (over: unknown) => {
      const t = (over as { data?: { current?: { target?: DropTarget } } })?.data?.current?.target;
      if (!t) return null;
      return t.kind === 'tray' ? 'the tray (unassign)' : `${personName(peopleById.get(t.userId))}, ${dayLabel(t.day)}`;
    };
    return {
      onDragStart: ({ active: a }) => `Picked up ${label(a)}. Use the arrow keys to choose a person and day, Space to drop, Escape to cancel.`,
      onDragOver: ({ active: a, over }) => (where(over) ? `${label(a)} over ${where(over)}.` : `${label(a)} is not over a drop target.`),
      onDragEnd: ({ active: a, over }) => (where(over) ? `${label(a)} dropped on ${where(over)}.` : `${label(a)} was not moved.`),
      onDragCancel: ({ active: a }) => `Moving ${label(a)} was cancelled.`,
    };
  }, [peopleById]);

  if (isLoading && !data) return <PageSkeleton />;

  // Summary stats. Kept as a slim strip inside the panel so the
  // Workload-specific numbers (avg utilization, overloaded count,
  // under-utilized count) remain visible even when this component
  // is embedded inside the Operations page — Operations' own summary
  // strip covers different metrics (overdue, blocked, in-review,
  // free capacity), so we still add value here.
  const avgUtil = data?.totals.utilizationPct ?? 0;
  const overloaded = people.filter((p) => p.totals.utilizationPct > 100).length;
  const underutil = people.filter((p) => p.totals.utilizationPct < 50 && p.totals.utilizationPct > 0).length;
  const allOpen = people.length > 0 && people.every((p) => expanded.has(p.id));
  const firstOpenId = (groups ? groups.flatMap((g) => g.people) : people).find((p) => expanded.has(p.id))?.id ?? null;
  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderRow = (p: TeamWorkloadPerson) => {
    const util = p.totals.utilizationPct;
    const open = expanded.has(p.id);
    const name = personName(p);
    const rowCheck = active ? checkFor(active, p, null) : null;
    const isSource = active?.source.fromUserId === p.id;
    const counts = open ? laneCounts(p) : null;
    // Round 2 (26.11): the reason is a badge over the person's fixed second
    // line, never a new line (that made rows grow when a drag started).
    const rowReason: RowReason | null =
      active && rowCheck && !isSource
        ? rowCheck.ok
          ? rowCheck.needsApproval
            ? { tone: 'approval', text: 'Needs approval' }
            : rowCheck.addsToTeam
              ? { tone: 'team', text: 'Joins the project team' }
              : null
          : rowCheck.reason
            ? { tone: 'blocked', text: dropReasonText(rowCheck.reason, active.task) }
            : null
        : null;

    const preview = (date: string, d: TeamWorkloadPerson['days'][number], isOver: boolean) => {
      if (!active) return null;
      const check = checkFor(active, p, date);
      if (check.reason === 'same-cell') return <CellPreview variant="now" />;
      const sameTaskHours = d.tasks.filter((c) => c.taskId === active.task.id).reduce((s, c) => s + c.hours, 0);
      const pv = previewPct({ planned: d.planned, capacity: d.capacity, sameTaskHours }, dragHoursOn(active, date));
      return (
        <CellPreview variant="preview" isOver={isOver} bad={!check.ok || pv.over}>
          {!check.ok && isOver && check.reason ? (
            <span className="font-sans text-[9px]">{dropReasonText(check.reason, active.task)}</span>
          ) : pv.off ? (
            `Off +${Math.round(dragHoursOn(active, date) * 10) / 10}h`
          ) : (
            `${pv.before}→${pv.after}%`
          )}
        </CellPreview>
      );
    };

    return (
      <Fragment key={p.id}>
        <tr
          className={cn(
            'border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-opacity duration-150',
            rowCheck && !rowCheck.ok && 'opacity-40',
          )}
        >
          <td className="w-8 py-2.5 pl-2 pr-0 text-center">
            <button
              type="button"
              onClick={() => toggle(p.id)}
              aria-expanded={open}
              aria-label={open ? `Hide the tasks of ${name}` : `Show the tasks of ${name}`}
              title={open ? 'Hide tasks' : 'Show tasks'}
              className="rounded-[7px] p-1 text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-200"
            >
              <ChevronRight className={cn('h-3.5 w-3.5 transition-transform duration-150', open && 'rotate-90 text-blue-600 dark:text-blue-400')} aria-hidden="true" />
            </button>
          </td>
          <td className="px-3 py-2.5">
            <WorkloadPersonCell
              initials={(p.firstName?.[0] ?? '') + (p.lastName?.[0] ?? '')}
              name={`${p.firstName ?? ''} ${p.lastName ?? ''}`.trim()}
              subtitle={[p.position, groupByDept ? null : p.orgUnit?.name].filter(Boolean).join(' · ') || null}
              reason={rowReason}
            />
          </td>
          {p.days.map((d) => {
            const dayUtil = utilizationPct(d.planned, d.capacity);
            const title = dayTasksTitle(d.tasks);
            return (
              <DropTd
                key={d.date}
                id={`cell:${p.id}:${d.date}`}
                target={{ kind: 'cell', userId: p.id, day: d.date }}
                className="relative px-2 py-2.5 text-center"
                title={active ? undefined : title || undefined}
              >
                {(isOver) => (
                  <>
                    {d.capacity === 0 ? (
                      d.planned > 0 ? (
                        <span className="text-[10px] font-semibold text-red-600" title={`Not working this day, ${d.planned}h planned${title ? `\n${title}` : ''}`}>
                          Off · <span className="font-mono tabular-nums">{d.planned.toFixed(1)}h</span>
                        </span>
                      ) : (
                        <span className="text-[10px] text-slate-300 dark:text-slate-600">Off</span>
                      )
                    ) : viewMode === 'utilization' ? (
                      <div className="space-y-1">
                        <div className={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold font-mono tabular-nums', getUtilColor(dayUtil))}>
                          {dayUtil}%
                        </div>
                        <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                          <div className={cn('h-full rounded-full', dayUtil > 100 ? 'bg-red-500' : dayUtil > 80 ? 'bg-amber-500' : 'bg-blue-500')} style={{ width: getBarWidth(dayUtil) }} />
                        </div>
                      </div>
                    ) : (
                      <div className="text-[11px] font-mono tabular-nums">
                        <span className="font-medium text-slate-700 dark:text-slate-200">{d.planned.toFixed(1)}h</span>
                        <span className="text-slate-400 dark:text-slate-500">/{d.capacity.toFixed(0)}h</span>
                      </div>
                    )}
                    {preview(d.date, d, isOver)}
                  </>
                )}
              </DropTd>
            );
          })}
          <td className="px-3 py-2.5 text-center font-medium text-slate-700 dark:text-slate-200">
            <span className="font-mono tabular-nums">{p.totals.planned.toFixed(1)}h</span>
            {p.totals.undatedHours > 0 && (
              <p className="text-[10px] font-normal text-slate-400 dark:text-slate-500" title="Hours of tasks with no due date. They are not on any day.">
                +<span className="font-mono tabular-nums">{p.totals.undatedHours.toFixed(1)}h</span> no date
              </p>
            )}
          </td>
          <td className="px-3 py-2.5 text-center text-slate-500 dark:text-slate-400 font-mono tabular-nums">{p.totals.capacity.toFixed(0)}h</td>
          <td className="px-3 py-2.5 text-center text-slate-500 dark:text-slate-400 font-mono tabular-nums" title={p.totals.logged == null ? LOGGED_HIDDEN_TITLE : undefined}>
            {p.totals.logged == null ? <span className="font-sans text-[11px] text-slate-300 dark:text-slate-600">Hidden</span> : `${p.totals.logged.toFixed(1)}h`}
          </td>
          <td className="px-3 py-2.5 text-center">
            <div className="flex items-center gap-2 justify-center">
              <div className="w-16 h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                <div className={cn('h-full rounded-full', util > 100 ? 'bg-red-500' : util > 80 ? 'bg-amber-500' : 'bg-blue-500')}
                  style={{ width: getBarWidth(util) }} />
              </div>
              <span className={cn('text-[11px] font-bold font-mono tabular-nums', util > 100 ? 'text-red-600' : 'text-slate-700 dark:text-slate-200')}>
                {util}%
              </span>
            </div>
          </td>
        </tr>

        {/* PR-063 lane: the person's task chips in their day columns. */}
        {open && (
          <tr className={cn('border-t border-slate-100 dark:border-slate-800 bg-[#FAFBFC] dark:bg-slate-800/30', rowCheck && !rowCheck.ok && 'opacity-40')} data-testid={`workload-lane-${p.id}`}>
            <td />
            <td className="px-3 py-2 align-top text-[11px] text-slate-400 dark:text-slate-500">
              <span className="font-mono">{counts?.tasks ?? 0}</span> {counts?.tasks === 1 ? 'task' : 'tasks'}
              {(counts?.hidden ?? 0) > 0 && (
                <span title="Tasks on projects you can't open, or personal tasks"> · <span className="font-mono">{counts?.hidden}</span> hidden</span>
              )}
            </td>
            {p.days.map((d) => {
              const cellCheck = active ? checkFor(active, p, d.date) : null;
              return (
                <DropTd
                  key={d.date}
                  id={`lane:${p.id}:${d.date}`}
                  target={{ kind: 'cell', userId: p.id, day: d.date }}
                  className="border-l border-dashed border-slate-200 dark:border-slate-700 px-1.5 py-1.5 align-top transition-all duration-150"
                  overClassName={cellCheck && !cellCheck.ok ? 'bg-red-50 dark:bg-red-500/10' : 'bg-blue-50 dark:bg-blue-500/10'}
                >
                  <div className="flex min-h-[34px] min-w-0 flex-col gap-1">
                    {d.tasks.map((c, i) => {
                      const entry = c.taskId != null && !c.masked ? tasks[String(c.taskId)] ?? null : null;
                      const source: DragSource = { taskId: c.taskId ?? -(i + 1), fromUserId: p.id, fromDay: d.date, hours: c.hours, origin: 'lane' };
                      return (
                        <DraggableChip
                          key={`${c.taskId ?? 'm'}-${i}`}
                          layout="stack"
                          source={source}
                          task={entry}
                          view={{
                            code: c.code,
                            name: c.name,
                            hours: c.hours,
                            masked: !!c.masked,
                            pending: !!entry?.pending,
                            overdue: !!entry?.overdue,
                            logged: (entry?.loggedUserIds.length ?? 0) > 0,
                          }}
                          canDrag={canDragFor(entry, p.id)}
                          sibling={!!active && c.taskId != null && active.task.id === c.taskId && !(active.source.fromUserId === p.id && active.source.fromDay === d.date)}
                          title={entry ? chipTitle(entry, { personId: p.id }) : c.masked ? `${c.name} · ${c.hours}h` : `${c.code ? `${c.code} ` : ''}${c.name}`}
                          onOpen={c.taskId != null && !c.masked ? () => setDrawerTaskId(c.taskId as number) : undefined}
                        />
                      );
                    })}
                  </div>
                </DropTd>
              );
            })}
            <td colSpan={4} className="px-3 py-2 align-top text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              {/* The hint once, on the first open lane. */}
              {p.id === firstOpenId &&
                (assign.canAssign
                  ? 'Drag a chip to another person\'s day to reassign it, or to another day in this row to move it. ⏱ Hours already logged stay with the current person.'
                  : 'View only. Moving tasks needs Admin, project leader or manager rights.')}
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  const colSpan = days.length + 6;

  return (
    <DndContext
      key={dndKey}
      sensors={sensors}
      collisionDetection={workloadCollision}
      measuring={WORKLOAD_MEASURING}
      autoScroll={WORKLOAD_AUTO_SCROLL}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
      accessibility={{ announcements }}
    >
    <div className="space-y-4">
      {isError && (
        <OpsErrorBanner title="Could not load the team workload" message={opsErrorMessage(error)} onRetry={() => refetch()} />
      )}

      {/* Panel summary — Workload-specific numbers only. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-center">
          <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">{people.length}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Team Members</p>
        </div>
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-center">
          <p className={cn('text-2xl font-bold', avgUtil > 100 ? 'text-red-600' : avgUtil > 80 ? 'text-amber-600' : 'text-blue-600')}>{avgUtil}%</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Avg Utilization</p>
        </div>
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-center">
          <p className={cn('text-2xl font-bold', overloaded > 0 ? 'text-red-600' : 'text-slate-400 dark:text-slate-500')}>{overloaded}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Overloaded (&gt;100%)</p>
        </div>
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-center">
          <p className={cn('text-2xl font-bold', underutil > 0 ? 'text-amber-600' : 'text-slate-400 dark:text-slate-500')}>{underutil}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Under-utilized (&lt;50%)</p>
        </div>
      </div>

      {/* Week navigation + filters */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => data && setWeekOf(shiftDateKey(data.range.from, -7))}
            aria-label="Previous week"
            className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-200" data-testid="workload-range">{rangeLabel}</span>
          <button
            type="button"
            onClick={() => data && setWeekOf(shiftDateKey(data.range.from, 7))}
            aria-label="Next week"
            className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
          {weekOf && (
            <button type="button" onClick={() => setWeekOf(null)} className="text-[12px] font-semibold text-blue-600 hover:underline">
              This week
            </button>
          )}
          {isFetching && !isLoading && <span className="text-[11px] text-slate-400 dark:text-slate-500">Refreshing…</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={myDeptOnly ? '' : orgUnitId}
            onChange={(e) => setOrgUnitId(e.target.value)}
            disabled={myDeptOnly}
            aria-label="Filter by department"
            title={myDeptOnly ? 'Showing your department ("My department only" is on)' : undefined}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-[12px] text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none disabled:opacity-60"
          >
            <option value="">{myDeptOnly && data?.scope.deptName ? data.scope.deptName : 'All departments'}</option>
            {(data?.orgUnits ?? []).map((u) => (
              <option key={u.id} value={String(u.id)}>{`${'  '.repeat(u.depth ?? 0)}${u.name}`}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={groupByDept}
              onChange={(e) => setGroupByDept(e.target.checked)}
              className="rounded border-slate-300 dark:border-slate-600 text-blue-600"
            />
            <span className="font-medium">Group by department</span>
          </label>
          <button
            type="button"
            onClick={() => setExpanded(allOpen ? new Set() : new Set(people.map((p) => p.id)))}
            disabled={people.length === 0}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500 disabled:opacity-50"
          >
            {allOpen ? 'Hide all tasks' : 'Show all tasks'}
          </button>
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
            <button onClick={() => setViewMode('utilization')} className={cn('px-3 py-1 rounded-md text-[12px] font-semibold', viewMode === 'utilization' ? 'bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400')}>Utilization %</button>
            <button onClick={() => setViewMode('hours')} className={cn('px-3 py-1 rounded-md text-[12px] font-semibold', viewMode === 'hours' ? 'bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400')}>Hours</button>
          </div>
        </div>
      </div>
      <p className="text-[11px] text-slate-500 dark:text-slate-400 -mt-2">
        Planned hours (remaining task hours spread over each task's dates) against capacity from work schedules, holidays and absences. Logged hours show only for people you manage.
        {assign.canAssign && ' Open a row with the arrow to see its tasks, then drag a task to another person or day.'}
      </p>

      {/* PR-063 · the tray replaces the "Overload Tasks" panel on this tab
          (D13). The scheduler list stays on Risk & Review and on the
          project workload panel. */}
      <WorkloadTray
        tray={board.tray}
        trayLoading={board.trayLoading}
        trayError={board.trayError}
        onRetry={() => trayQuery.refetch()}
        overload={overload}
        tasks={tasks}
        peopleById={peopleById}
        canDrag={canDragFor}
        active={active}
        approvalsCount={board.tray ? board.tray.approvals.length : assign.approvalsWaitingForMe}
        onOpenTask={(taskId) => setDrawerTaskId(taskId)}
        onApprove={(r) => decide.mutate({ r, decision: 'approve' })}
        onReject={(r) => decide.mutate({ r, decision: 'reject' })}
        deciding={decide.isPending ? decide.variables?.r.id ?? null : null}
        focusApprovals={focusApprovals}
      />

      {/* Utilization Table */}
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
        <table className="w-full min-w-[1040px] table-fixed text-[12px]">
          <thead>
            <tr className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <th className="w-8 py-3 pl-2 pr-0" aria-label="Show tasks" />
              <th className="px-3 py-3 text-left font-semibold w-48">User</th>
              <WorkloadDayHeaders days={days} />
              <th className="w-[84px] px-3 py-3 text-center font-semibold">Planned</th>
              <th className="w-[76px] px-3 py-3 text-center font-semibold">Capacity</th>
              <th className="w-[72px] px-3 py-3 text-center font-semibold">Logged</th>
              <th className="px-3 py-3 text-center font-semibold w-28">Avg Util.</th>
            </tr>
          </thead>
          <tbody>
            {people.length === 0 ? (
              <tr><td colSpan={colSpan} className="py-8 text-center text-slate-400 dark:text-slate-500">{isError ? 'Workload could not be loaded' : 'No workload data'}</td></tr>
            ) : groups ? (
              groups.map((g) => {
                const cap = g.people.reduce((s, p) => s + p.totals.capacity, 0);
                const planned = g.people.reduce((s, p) => s + p.totals.planned, 0);
                const pct = utilizationPct(planned, cap);
                return (
                  <Fragment key={g.key}>
                    <tr className="border-t border-slate-200 dark:border-slate-700 bg-[#FAFBFC] dark:bg-slate-800/40">
                      <td colSpan={colSpan} className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-bold text-slate-800 dark:text-slate-100">{g.name}</span>
                          <span className="text-[11px] text-slate-400 dark:text-slate-500"><span className="font-mono tabular-nums">{g.people.length}</span> people</span>
                          <span className="ml-auto text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                            {planned.toFixed(1)}h / {cap.toFixed(0)}h · <span className={cn('font-bold', pct > 100 ? 'text-red-600' : 'text-slate-700 dark:text-slate-200')}>{pct}%</span>
                          </span>
                        </div>
                      </td>
                    </tr>
                    {g.people.map(renderRow)}
                  </Fragment>
                );
              })
            ) : (
              people.map(renderRow)
            )}
          </tbody>
        </table>
      </div>
    </div>
    <DragOverlay dropAnimation={null}>
      {active ? (
        <TaskChip
          overlay
          code={active.task.code}
          name={active.task.name}
          hours={active.source.hours}
          logged={active.task.loggedUserIds.length > 0}
          overdue={active.task.overdue}
          className="w-[220px]"
        />
      ) : null}
    </DragOverlay>
    <WorkloadTeamConfirm request={teamConfirm?.text ?? null} onCancel={() => answerTeam('cancel')} onConfirm={() => answerTeam('add')} />
    </DndContext>
  );
}
