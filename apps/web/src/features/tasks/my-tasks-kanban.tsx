import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { User as UserIcon, CalendarClock, ListChecks, Columns3, AlertCircle, AlertTriangle, Plus, X } from 'lucide-react';
import { DndContext, DragOverlay, closestCorners, PointerSensor, KeyboardSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { PageHeader } from '@/components/shared/page-header';
import { TaskDrawer } from './task-drawer';
import { useDrawerRoute } from '@/components/nav/use-drawer-route';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { tasksApi } from '@/api/tasks.api';
import client from '@/api/client';
import { STATUS_PILL, STATUS_LABEL } from '@/lib/task-constants';
import { queryKeys } from '@/lib/query-keys';
import { TaskCardBody } from '@/components/shared/task-card-body';
import type { TabMode } from './my-tasks-kanban/types';
import { columns } from './my-tasks-kanban/constants';
import { getTaskScore } from './my-tasks-kanban/helpers';
import { DroppableColumn } from './my-tasks-kanban/droppable-column';
import { UpcomingTab } from './my-tasks-kanban/upcoming-tab';
import { TimeReportingTab } from './my-tasks-kanban/time-reporting-tab';
import { PersonalTaskDialog } from './my-tasks-kanban/personal-task-dialog';

// ─── Kanban Board ──────────────────────────────────────────────────────────

export function MyTasksKanbanPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabMode>('kanban');
  const [showPersonalTaskDialog, setShowPersonalTaskDialog] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // Drawer ID lives in ?task=N so browser-back and outbound-link returns
  // restore the open task automatically. See useDrawerRoute docs.
  const { drawerId: drawerTaskId, openDrawer: setDrawerTaskId, closeDrawer } = useDrawerRoute('task');

  // Filters
  const [filterProjectId, setFilterProjectId] = useState<number | null>(null);
  const [filterServiceId, setFilterServiceId] = useState<number | null>(null);
  const [filterPhaseName, setFilterPhaseName] = useState<string | null>(null);
  // M3 — match the Tasks list filter set. Priority + Due-date filters
  // join the existing Project / Service / Deliverable filters so users
  // working off the Kanban have the same cuts the tasks page provides.
  // We deliberately skip an Assignee filter since /my-tasks is already
  // scoped to the caller.
  const [filterPriority, setFilterPriority] = useState<string>('');
  const [filterDueFrom, setFilterDueFrom] = useState<string>('');
  const [filterDueTo, setFilterDueTo] = useState<string>('');
  // Tier D #1 (personal-tasks) + #6a+b filters — personal task cut and
  // has-due-date cut. Both default to 'any' so the initial view is
  // unfiltered.
  const [filterKind, setFilterKind] = useState<'' | 'personal' | 'project'>('');
  const [filterHasDue, setFilterHasDue] = useState<'' | 'yes' | 'no'>('');
  // "Upcoming/future tasks" toggle (client feedback 2026-08-02 item
  // 5). By default the Kanban hides tasks whose estStart is more
  // than a week away (server sends `isReady=false` for those). Users
  // can opt back in to see the full pipeline.
  const [showFutureTasks, setShowFutureTasks] = useState(false);
  // Reveal tasks the two Kanban-mandatory rules would otherwise hide
  // (no-due-date, future-start). One-click "Reveal hidden" chip
  // flips this and clears any user-controlled has-due filter that's
  // also excluding them. Without this, an all-undated board would
  // show "No tasks assigned to you" even though tasks exist.
  const [revealHiddenKanban, setRevealHiddenKanban] = useState(false);

  const { data: tasksData, isLoading } = useQuery({
    queryKey: queryKeys.tasks.mine(),
    queryFn: () => tasksApi.mine().then((r: any) => {
      const d = r?.data ?? r;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
  });

  const allTasks: any[] = Array.isArray(tasksData) ? tasksData : [];

  // Fetch service (Phase DB model) lookups for filter dropdown
  const { data: servicesData } = useQuery({
    queryKey: queryKeys.phases.all,
    queryFn: () => client.get('/phases').then((r) => r.data?.data ?? r.data),
    staleTime: 10 * 60 * 1000,
  });
  const services: any[] = Array.isArray(servicesData) ? servicesData : [];

  // Derive unique project options from tasks
  const projectOptions = useMemo(() => {
    const map = new Map<number, { id: number; name: string }>();
    for (const t of allTasks) {
      if (t.project?.id && !map.has(t.project.id)) map.set(t.project.id, { id: t.project.id, name: t.project.name });
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [allTasks]);

  // Derive unique phase (template) names used across tasks
  const phaseOptions = useMemo(() => {
    const names = new Set<string>();
    for (const t of allTasks) {
      // Phase-name resolution matches execution-board getTaskPhaseName:
      // serviceType -> [SERVICE:...] marker -> task.phase.name. Without the
      // phase.name fallback, root tasks (which usually have only a phase
      // set, no serviceType) wouldn't expose their phase in this filter.
      const name = t.serviceType?.name || t.description?.match(/^\[SERVICE:(.+)\]$/)?.[1] || t.phase?.name;
      if (name) names.add(name);
    }
    return Array.from(names).sort();
  }, [allTasks]);

  // Apply filters. Kanban view enforces "must have due date" as a
  // hard rule (client feedback 2026-08-02 item 7 — kanban should
  // only show tasks that have a DUE DATE; other task-display
  // surfaces follow the same rule except the Planning grid which
  // stays exhaustive so PMs can still see uncommitted work).
  const tasks = useMemo(() => {
    return allTasks.filter((t) => {
      if (filterProjectId && t.project?.id !== filterProjectId) return false;
      if (filterServiceId && t.phaseId !== filterServiceId) return false;
      if (filterPhaseName) {
        const n = t.serviceType?.name || t.description?.match(/^\[SERVICE:(.+)\]$/)?.[1] || t.phase?.name;
        if (n !== filterPhaseName) return false;
      }
      if (filterPriority && t.priority !== filterPriority) return false;
      if (filterDueFrom || filterDueTo) {
        if (!t.endDate) return false;
        const d = String(t.endDate).slice(0, 10);
        if (filterDueFrom && d < filterDueFrom) return false;
        if (filterDueTo && d > filterDueTo) return false;
      }
      // Personal-task cut (Tier D #1).
      if (filterKind === 'personal' && !t.isPersonal) return false;
      if (filterKind === 'project' && t.isPersonal) return false;
      // Has-due-date cut (Tier D #6b) — user-controlled tri-state.
      if (filterHasDue === 'yes' && !t.endDate) return false;
      if (filterHasDue === 'no' && t.endDate) return false;
      // Kanban view: default-hide tasks without a due date (2026-08-02
      // item 7) — a task without one has nowhere real to sit on a
      // deadline-ordered board. `revealHiddenKanban` bypasses this
      // so the user can see them via the "N hidden" chip.
      if (activeTab === 'kanban' && !revealHiddenKanban && !t.endDate) return false;
      // Kanban view: default-hide future-start tasks unless the user
      // opts in (2026-08-02 item 5). `isReady` is server-computed
      // from estimatedStartDate + a 7-day lead window.
      if (activeTab === 'kanban' && !revealHiddenKanban && !showFutureTasks && t.isReady === false) return false;
      return true;
    });
  }, [allTasks, filterProjectId, filterServiceId, filterPhaseName, filterPriority, filterDueFrom, filterDueTo, filterKind, filterHasDue, activeTab, showFutureTasks, revealHiddenKanban]);

  const hasActiveFilter = !!(filterProjectId || filterServiceId || filterPhaseName || filterPriority || filterDueFrom || filterDueTo || filterKind || filterHasDue);

  // Count of tasks the two Kanban-only rules are excluding right
  // now — feeds the "N hidden — no due date / not started" chip.
  // We re-run the user-controlled filters (all EXCEPT the mandatory
  // Kanban ones), then count what the mandatory rules would drop.
  // Only meaningful on the Kanban tab; other tabs render every task.
  const kanbanHiddenCount = useMemo(() => {
    if (activeTab !== 'kanban') return 0;
    if (revealHiddenKanban) return 0;
    let count = 0;
    for (const t of allTasks) {
      if (filterProjectId && t.project?.id !== filterProjectId) continue;
      if (filterServiceId && t.phaseId !== filterServiceId) continue;
      if (filterPhaseName) {
        const n = t.serviceType?.name || t.description?.match(/^\[SERVICE:(.+)\]$/)?.[1] || t.phase?.name;
        if (n !== filterPhaseName) continue;
      }
      if (filterPriority && t.priority !== filterPriority) continue;
      if (filterDueFrom || filterDueTo) {
        if (!t.endDate) continue;
        const d = String(t.endDate).slice(0, 10);
        if (filterDueFrom && d < filterDueFrom) continue;
        if (filterDueTo && d > filterDueTo) continue;
      }
      if (filterKind === 'personal' && !t.isPersonal) continue;
      if (filterKind === 'project' && t.isPersonal) continue;
      if (filterHasDue === 'yes' && !t.endDate) continue;
      if (filterHasDue === 'no' && t.endDate) continue;
      // Now: WOULD the mandatory Kanban rules drop this one?
      const droppedByNoDueDate = !t.endDate;
      const droppedByFutureStart = !showFutureTasks && t.isReady === false;
      if (droppedByNoDueDate || droppedByFutureStart) count++;
    }
    return count;
  }, [allTasks, filterProjectId, filterServiceId, filterPhaseName, filterPriority, filterDueFrom, filterDueTo, filterKind, filterHasDue, activeTab, showFutureTasks, revealHiddenKanban]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const { columnMap, otherByStatus } = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const col of columns) map[col.id] = [];
    // Statuses that DON'T have a board column go into a read-only
    // "Other" section per-status. Previously they were bucketed into
    // Not Started via `else map.not_started.push(task)` — a drag from
    // that column would then silently overwrite their real status
    // (on_hold → not_started, cancelled → not_started, etc.).
    const other: Record<string, any[]> = {};
    // Cutoff for the "Done" column — only show tasks marked completed
    // (proxy: updatedAt) within the last 7 days so the column doesn't
    // become an ever-growing archive. Older completions are still in
    // the DB and reachable via reports; the kanban is for current work.
    const oneWeekAgo = Date.now() - 7 * 86_400_000;
    for (const task of tasks) {
      const status = task.status || 'not_started';
      if (status === 'completed') {
        const upd = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
        if (upd < oneWeekAgo) continue; // hide stale completions
      }
      if (map[status]) map[status].push(task);
      else {
        if (!other[status]) other[status] = [];
        other[status].push(task);
      }
    }
    map.not_started.sort((a, b) => getTaskScore(b) - getTaskScore(a));
    map.in_progress.sort((a, b) => {
      if (!a.endDate && !b.endDate) return 0;
      if (!a.endDate) return 1;
      if (!b.endDate) return -1;
      return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
    });
    // Newest completions first in the Done column so the freshest
    // finishes float to the top.
    map.completed.sort((a, b) => {
      const au = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bu = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bu - au;
    });
    return { columnMap: map, otherByStatus: other };
  }, [tasks]);

  // Keep the original name so existing consumers below still work.
  const columnTasks = columnMap;

  const moveTask = async (taskId: number, targetStatus: string) => {
    const mineKey = queryKeys.tasks.mine();
    // Snapshot BEFORE mutating so a server error rolls back to the
    // exact prior list — no unnecessary refetch, no flicker. Prior
    // code invalidated `tasks.mine` on error, which triggered a full
    // network round-trip just to restore a value we already had.
    const previous = queryClient.getQueryData(mineKey);
    queryClient.setQueryData(mineKey, (old: any) => {
      if (!Array.isArray(old)) return old;
      return old.map((t: any) => (t.id === taskId ? { ...t, status: targetStatus } : t));
    });
    try {
      await tasksApi.update(taskId, { status: targetStatus });
      // Sync project planning views only. `tasks.all` was previously
      // invalidated too — but it's a PREFIX of `tasks.mine`, so React
      // Query treated our just-set optimistic value as stale and
      // refetched it, wasting a request and briefly flashing the
      // pre-optimistic list. We don't need tasks.all here — no other
      // active query on this page reads it, and cross-page task lists
      // refetch on their own next mount.
      queryClient.invalidateQueries({ queryKey: queryKeys.planning.all });
    } catch (err: any) {
      // True rollback: restore the exact snapshot. Fallback to
      // invalidation only if the snapshot was somehow missing.
      if (previous !== undefined) queryClient.setQueryData(mineKey, previous);
      else queryClient.invalidateQueries({ queryKey: mineKey });
      notify.apiError(err, 'Failed to update status');
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;

    const taskId = Number(String(active.id).replace('task-', ''));
    const targetColumnId = String(over.id);
    const targetCol = columns.find((c) => c.id === targetColumnId);
    if (!targetCol) return;

    const task = tasks.find((t: any) => t.id === taskId);
    if (!task || task.status === targetCol.id) return;

    // Drag to any column (including Done) moves the task immediately.
    // Logging time is decoupled — users can log it separately on the task
    // card or detail view if/when they want to. We deliberately don't
    // force a hours-log modal on drop here.
    await moveTask(taskId, targetCol.id);
  };

  const draggedTask = activeDragId ? tasks.find((t: any) => `task-${t.id}` === activeDragId) : null;

  return (
    <div className="space-y-6">
      {/* Personal-task modal — created lazily so the form only mounts on click. */}
      {showPersonalTaskDialog && (
        <PersonalTaskDialog
          onClose={() => setShowPersonalTaskDialog(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: queryKeys.tasks.mine() });
            setShowPersonalTaskDialog(false);
          }}
        />
      )}
      <div className="flex items-center justify-between gap-3">
        <PageHeader title="My Tasks" description={activeTab === 'time' ? 'List of your tasks with quick time reporting' : 'Drag to change status, click card to view details'} />
        <button
          type="button"
          onClick={() => setShowPersonalTaskDialog(true)}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 shrink-0"
          title="Create a personal task for yourself (no project needed)"
        >
          <Plus className="h-3.5 w-3.5" />
          New personal task
        </button>
        <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
          <button onClick={() => setActiveTab('time')}
            className={cn('flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors',
              activeTab === 'time' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}>
            <ListChecks className="h-3.5 w-3.5" /> List view
          </button>
          <button onClick={() => setActiveTab('kanban')}
            className={cn('flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors',
              activeTab === 'kanban' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}>
            <Columns3 className="h-3.5 w-3.5" /> Kanban
          </button>
          <button onClick={() => setActiveTab('upcoming')}
            className={cn('flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors',
              activeTab === 'upcoming' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}>
            <CalendarClock className="h-3.5 w-3.5" /> Upcoming
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={filterProjectId ?? ''}
          onChange={(e) => setFilterProjectId(e.target.value ? +e.target.value : null)}
          className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[12px] hover:border-slate-300 dark:hover:border-slate-600 focus:outline-none focus:border-blue-400"
        >
          <option value="">All Projects</option>
          {projectOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select
          value={filterServiceId ?? ''}
          onChange={(e) => setFilterServiceId(e.target.value ? +e.target.value : null)}
          className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[12px] hover:border-slate-300 dark:hover:border-slate-600 focus:outline-none focus:border-blue-400"
        >
          <option value="">All Services</option>
          {services.map((s: any) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select
          value={filterPhaseName ?? ''}
          onChange={(e) => setFilterPhaseName(e.target.value || null)}
          className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[12px] hover:border-slate-300 dark:hover:border-slate-600 focus:outline-none focus:border-blue-400"
        >
          <option value="">All Deliverables</option>
          {phaseOptions.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        {/* Priority filter — mirrors the Tasks list page. Short labels
            so the row stays a single line on common viewports. */}
        <select
          value={filterPriority}
          onChange={(e) => setFilterPriority(e.target.value)}
          className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[12px] hover:border-slate-300 dark:hover:border-slate-600 focus:outline-none focus:border-blue-400"
        >
          <option value="">Any Priority</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        {/* Personal-task cut (Tier D #1) + has-due-date cut (#6b). */}
        <select
          value={filterKind}
          onChange={(e) => setFilterKind(e.target.value as '' | 'personal' | 'project')}
          className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[12px] hover:border-slate-300 dark:hover:border-slate-600 focus:outline-none focus:border-blue-400"
          title="Personal-task filter"
        >
          <option value="">Any kind</option>
          <option value="personal">Personal only</option>
          <option value="project">Project only</option>
        </select>
        <select
          value={filterHasDue}
          onChange={(e) => setFilterHasDue(e.target.value as '' | 'yes' | 'no')}
          className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[12px] hover:border-slate-300 dark:hover:border-slate-600 focus:outline-none focus:border-blue-400"
          title="Has due date"
        >
          <option value="">Due date: any</option>
          <option value="yes">Has due date</option>
          <option value="no">Missing due date</option>
        </select>
        {/* Show future-start tasks on the Kanban (client 2026-08-02
            item 5). Off by default — Kanban shows what to work on
            NOW; tasks whose estStart is >7 days out live in the
            underlying pipeline until they get close. */}
        {activeTab === 'kanban' && (
          <label className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[12px] text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showFutureTasks}
              onChange={(e) => setShowFutureTasks(e.target.checked)}
              className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
            />
            Include future tasks
          </label>
        )}
        {/* Due-date range — same control set as the Execution board's
            date filter. Either side optional. */}
        <div className="flex items-center gap-1 text-[12px] text-slate-500 dark:text-slate-400">
          <span className="text-[11px]">Due:</span>
          <input
            type="date"
            value={filterDueFrom}
            onChange={(e) => setFilterDueFrom(e.target.value)}
            className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-[12px] hover:border-slate-300 dark:hover:border-slate-600 focus:outline-none focus:border-blue-400"
            aria-label="Due date from"
          />
          <span className="text-slate-400 dark:text-slate-500">→</span>
          <input
            type="date"
            value={filterDueTo}
            onChange={(e) => setFilterDueTo(e.target.value)}
            className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-[12px] hover:border-slate-300 dark:hover:border-slate-600 focus:outline-none focus:border-blue-400"
            aria-label="Due date to"
          />
        </div>
        {hasActiveFilter && (
          <button
            onClick={() => {
              setFilterProjectId(null);
              setFilterServiceId(null);
              setFilterPhaseName(null);
              setFilterPriority('');
              setFilterDueFrom('');
              setFilterDueTo('');
              setFilterKind('');
              setFilterHasDue('');
            }}
            className="text-[12px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 underline"
          >
            Clear filters
          </button>
        )}
        <span className="ml-auto text-[11px] text-slate-600 dark:text-slate-300 tabular-nums">
          {tasks.length} of {allTasks.length} tasks
        </span>
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-600 dark:text-slate-300">Loading your tasks...</div>
      ) : activeTab === 'time' ? (
        <TimeReportingTab tasks={tasks} onOpenDrawer={(id) => setDrawerTaskId(id)} />
      ) : activeTab === 'upcoming' ? (
        <UpcomingTab tasks={tasks} onOpenDrawer={(id) => setDrawerTaskId(id)} />
      ) : (activeTab === 'kanban' && tasks.length === 0 && Object.keys(otherByStatus).length === 0 && kanbanHiddenCount === 0) ? (
        <div className="py-12 text-center">
          <UserIcon className="mx-auto h-12 w-12 text-slate-300 dark:text-slate-600" />
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
            {hasActiveFilter ? 'No tasks match the active filters' : 'No tasks assigned to you'}
          </p>
        </div>
      ) : tasks.length === 0 && activeTab !== 'kanban' ? (
        <div className="py-12 text-center">
          <UserIcon className="mx-auto h-12 w-12 text-slate-300 dark:text-slate-600" />
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
            {hasActiveFilter ? 'No tasks match the active filters' : 'No tasks assigned to you'}
          </p>
        </div>
      ) : (
        <>
          {/* Hidden-work chip — surfaces tasks the two mandatory
              Kanban rules dropped (no due date, future-start). Before
              this existed, an all-undated board rendered a false
              "No tasks assigned" empty state. One click reveals them
              inline; click again ("Hide") to restore the default view. */}
          {activeTab === 'kanban' && kanbanHiddenCount > 0 && !revealHiddenKanban && (
            <button
              type="button"
              onClick={() => setRevealHiddenKanban(true)}
              className="mb-3 inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-[12px] font-semibold text-amber-800 hover:bg-amber-100"
              title="Reveal tasks the Kanban board is hiding — no due date or not-yet-ready"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              <span className="tabular-nums">{kanbanHiddenCount}</span>
              &nbsp;hidden — no due date / not started
              <span className="text-amber-600">· reveal</span>
            </button>
          )}
          {activeTab === 'kanban' && revealHiddenKanban && (
            <button
              type="button"
              onClick={() => setRevealHiddenKanban(false)}
              className="mb-3 inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-1.5 text-[12px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="h-3.5 w-3.5" />
              Hide undated / future-start again
            </button>
          )}

          <DndContext sensors={sensors} collisionDetection={closestCorners}
            onDragStart={(e: DragStartEvent) => setActiveDragId(String(e.active.id))}
            onDragEnd={handleDragEnd}>
            <div className="grid grid-cols-4 gap-3">
              {columns.map((col) => (
                <DroppableColumn key={col.id} column={col} tasks={columnTasks[col.id] ?? []}
                  onOpenDrawer={(id) => setDrawerTaskId(id)}
                  onStatusChange={(taskId, status) => moveTask(taskId, status)} />
              ))}
            </div>
            <DragOverlay>
              {draggedTask && (
                <div className="rounded-lg border-2 border-blue-400 bg-white dark:bg-slate-900 p-3 shadow-2xl w-60">
                  {draggedTask.project?.name && <span className="text-[10px] font-semibold text-blue-600">{draggedTask.project.name}</span>}
                  <p className="text-[13px] font-medium text-slate-800 dark:text-slate-100">{draggedTask.name}</p>
                </div>
              )}
            </DragOverlay>
          </DndContext>

          {/* Other-status section — read-only. Tasks whose status
              isn't one of the 4 board columns (on_hold, cancelled,
              blocked, etc.) render here grouped by their REAL status.
              NOT wrapped in a droppable, so a drag can't silently
              overwrite their status by dumping them into "To Do".
              To move an item out of Other, open its drawer and change
              status explicitly — that's the intentional path. */}
          {activeTab === 'kanban' && Object.keys(otherByStatus).length > 0 && (
            <div className="mt-6 rounded-[14px] border border-slate-200 dark:border-slate-700 bg-slate-50/40 dark:bg-slate-800/40 p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertCircle className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400" />
                <h3 className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">Other</h3>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  read-only · statuses not on the board · open the task to change status
                </span>
              </div>
              <div className="space-y-3">
                {Object.entries(otherByStatus).map(([status, items]) => (
                  <div key={status}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className={cn('rounded-[5px] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider', STATUS_PILL[status] ?? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300')}>
                        {STATUS_LABEL[status] ?? status}
                      </span>
                      <span className="text-[11px] text-slate-400 dark:text-slate-500 tabular-nums">{items.length}</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
                      {items.map((t: any) => (
                        <div
                          key={t.id}
                          onClick={() => setDrawerTaskId(t.id)}
                          className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 cursor-pointer hover:border-slate-300 dark:hover:border-slate-600 opacity-80"
                          title="Read-only in Other. Click to open and change status."
                        >
                          <TaskCardBody task={t} />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {drawerTaskId && (
        <TaskDrawer taskId={drawerTaskId} onClose={closeDrawer} />
      )}

    </div>
  );
}
