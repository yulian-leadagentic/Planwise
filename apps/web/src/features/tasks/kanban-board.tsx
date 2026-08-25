import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Filter, GripVertical, Clock, AlertCircle, AlertTriangle, Search, X } from 'lucide-react';
import { getTaskPhaseName } from '@/features/execution-board/execution-board.util';
import { DndContext, DragOverlay, closestCorners, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { TaskCardBody } from '@/components/shared/task-card-body';
import client from '@/api/client';
import { tasksApi } from '@/api/tasks.api';
import { TaskDrawer } from './task-drawer';
import { useDrawerRoute } from '@/components/nav/use-drawer-route';
import { getTaskHealth } from '@/lib/task-health';
import { STATUS_PILL, STATUS_LABEL, ZONE_BORDER_COLORS } from '@/lib/task-constants';
import { PeopleMultiSelect } from '@/components/shared/people-multi-select';

// Column labels mirror STATUS_LABEL exactly so the kanban headers read the
// same as every other status badge in the app ("To Do" / "Done", not "Not
// Started" / "Completed").
const columns = [
  { id: 'not_started', label: 'To Do', color: 'border-t-slate-400', bg: 'bg-slate-50 dark:bg-slate-800/50' },
  { id: 'in_progress', label: 'In Progress', color: 'border-t-blue-500', bg: 'bg-blue-50/30' },
  { id: 'in_review', label: 'In Review', color: 'border-t-violet-500', bg: 'bg-violet-50/30' },
  { id: 'on_hold', label: 'On Hold', color: 'border-t-amber-500', bg: 'bg-amber-50/30' },
  { id: 'completed', label: 'Done', color: 'border-t-emerald-500', bg: 'bg-emerald-50/30' },
];

// Manager-facing card. Drag listeners live ONLY on the grip button so the
// rest of the card stays clickable (opens the task drawer). Without this
// split a click anywhere on the card would race with @dnd-kit's pointer
// activation and randomly trigger drag instead of click.
function KanbanCard({ task, onOpen }: { task: any; onOpen: (id: number) => void }) {
  // V2 — mirror the my-tasks Kanban card layout so users see the same
  // visual language across both surfaces. Differences kept on purpose:
  //   • no project-name header (the page IS the project context)
  //   • no Log-Time button (manager view, not the worker's surface)
  // Everything else — health icons, zone breadcrumb, service +
  // deliverable chips, status pill, hours pill colored by budget,
  // due date with overdue tone, risk reason banner, assignee
  // avatars — matches /my-tasks.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `task-${task.id}` });
  const style = { transform: CSS.Transform.toString(transform), transition };

  const health = getTaskHealth(task);
  const zoneType = task.zone?.zoneType || 'zone';
  const zoneName = task.zone?.name ?? '';
  const breadcrumb: string[] = Array.isArray((task as any).zoneBreadcrumb) ? (task as any).zoneBreadcrumb : [];

  const borderCls =
    health.level === 'critical'
      ? 'border-red-300 bg-red-50 ring-1 ring-red-200'
      : health.level === 'warning'
        ? 'border-amber-300 bg-amber-50/50'
        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900';

  // Hours pill tone matches /my-tasks: green<80% / amber 80-100% / red>100% / slate if no estimate.
  const pct = health.estimatedHours > 0 ? (health.loggedHours / health.estimatedHours) * 100 : 0;
  const hoursTone = health.estimatedHours <= 0
    ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
    : pct >= 100
      ? 'bg-red-100 text-red-700 border-red-200'
      : pct >= 80
        ? 'bg-amber-100 text-amber-700 border-amber-200'
        : 'bg-emerald-100 text-emerald-700 border-emerald-200';

  // Card design normalized to the shared TaskCardBody layout (client
  // feedback 2026-08-02 item 2). Extras that only make sense on a
  // manager surface — task code, status/priority chips, hours pill,
  // assignee stack — live in the header/footer around the shared
  // labeled-field body so the visual language is consistent while
  // manager-specific info remains one glance away.
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      className={cn(
        'group rounded-[14px] border shadow-sm hover:shadow-md transition-shadow duration-100 border-l-[3px] overflow-hidden',
        borderCls,
        ZONE_BORDER_COLORS[zoneType] || 'border-l-slate-300',
        isDragging && 'opacity-50 shadow-lg ring-2 ring-blue-300',
      )}
    >
      {/* Header — grip, code, status pill, health/priority marks. */}
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1.5">
        <button
          type="button"
          aria-label="Drag to reorder or change column"
          title="Drag to move"
          {...listeners}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-300 dark:text-slate-600 opacity-0 group-hover:opacity-100 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-500 dark:hover:text-slate-300 cursor-grab active:cursor-grabbing touch-none focus:outline-none focus:ring-2 focus:ring-blue-300 focus:opacity-100"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        {task.code && <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 shrink-0">{task.code}</span>}
        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider shrink-0', STATUS_PILL[task.status] ?? STATUS_PILL.not_started)}>
          {STATUS_LABEL[task.status] ?? task.status}
        </span>
        {task.priority === 'critical' && <span className="rounded bg-red-100 px-1 py-0.5 text-[10px] font-bold text-red-600 shrink-0">Crit</span>}
        {task.priority === 'high' && <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-bold text-amber-600 shrink-0">High</span>}
        <div className="ml-auto flex items-center gap-1">
          {health.level === 'critical' && <AlertCircle className="h-3.5 w-3.5 text-red-600 shrink-0" />}
          {health.level === 'warning' && <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
        </div>
      </div>

      {/* Body — shared labeled-field layout. Clicking opens the drawer. */}
      <button
        type="button"
        onClick={() => onOpen(task.id)}
        className="w-full text-left cursor-pointer hover:bg-slate-50/50 dark:hover:bg-slate-800/50 focus:outline-none focus:ring-2 focus:ring-blue-300"
      >
        <TaskCardBody task={task} isOverdue={health.isOverdue} hideProject />
      </button>

      {/* Footer — hours pill + zone breadcrumb (if any) + assignee avatars. */}
      <div className="px-3.5 pb-3 flex items-center gap-2 flex-wrap">
        <div className={cn(
          'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-bold tabular-nums',
          hoursTone,
        )}>
          <Clock className="h-3 w-3 shrink-0" />
          <span>{health.loggedHours}h</span>
          {health.estimatedHours > 0 && <span className="opacity-70">/ {health.estimatedHours}h</span>}
        </div>
        {breadcrumb.length > 0 && (
          <span className="text-[10px] text-slate-400 dark:text-slate-500 truncate max-w-[140px]" title={breadcrumb.join(' > ')}>
            {breadcrumb.join(' › ')}
          </span>
        )}
        {Array.isArray(task.assignees) && task.assignees.length > 0 && (
          <div className="ml-auto flex items-center gap-0.5">
            {(task.assignees as any[]).slice(0, 4).map((a) => {
              const initials = `${a.user?.firstName?.[0] ?? ''}${a.user?.lastName?.[0] ?? ''}` || '?';
              return (
                <span
                  key={a.id}
                  className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-[8px] font-bold border border-white -ml-1 first:ml-0"
                  title={`${a.user?.firstName ?? ''} ${a.user?.lastName ?? ''}`.trim()}
                >
                  {initials}
                </span>
              );
            })}
            {task.assignees.length > 4 && (
              <span className="text-[9px] text-slate-500 dark:text-slate-400 ml-1">+{task.assignees.length - 4}</span>
            )}
          </div>
        )}
      </div>
      {health.reasons.length > 0 && (
        <div className={cn(
          'mx-3.5 mb-3 rounded px-1.5 py-1 text-[10px]',
          health.level === 'critical' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700',
        )}>
          {health.reasons[0]}
        </div>
      )}
    </div>
  );
}

function KanbanColumn({ column, tasks, onOpen }: { column: typeof columns[0]; tasks: any[]; onOpen: (id: number) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const taskIds = tasks.map((t: any) => `task-${t.id}`);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex flex-col rounded-[14px] border-t-[3px] min-h-[300px]',
        column.color,
        isOver ? 'bg-blue-50/50 border-blue-200' : `border border-slate-200 dark:border-slate-700 ${column.bg}`,
      )}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">{column.label}</h3>
          <span className="rounded-full bg-slate-200 dark:bg-slate-700 px-1.5 py-0.5 text-[10px] font-bold text-slate-600 dark:text-slate-300">
            {tasks.length}
          </span>
        </div>
      </div>

      <div className="flex-1 space-y-2 px-3 pb-3">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {tasks.map((task: any) => (
            <KanbanCard key={task.id} task={task} onOpen={onOpen} />
          ))}
        </SortableContext>
        {tasks.length === 0 && (
          <div className="py-6 text-center text-[11px] text-slate-400 dark:text-slate-500">
            No tasks
          </div>
        )}
      </div>
    </div>
  );
}

export function KanbanBoard({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // Task whose drawer is currently open. Manager-facing drawer (no time
  // tab) — moving between stages happens via drag OR via the status pill
  // inside the drawer; assigning people is in the drawer's Details tab.
  // Drawer ID lives in ?task=N so browser-back / refresh / outbound links
  // pointing back here restore the drawer (see useDrawerRoute docs).
  const { drawerId: drawerTaskId, openDrawer: setDrawerTaskId, closeDrawer } = useDrawerRoute('task');

  const { data: planningData, isLoading, isError, refetch } = useQuery({
    queryKey: ['planning', projectId],
    queryFn: () => client.get(`/projects/${projectId}/planning-data`).then((r) => r.data?.data ?? r.data),
    enabled: !!projectId,
  });

  // Unwrap nested response: handle { success, data: { tasks } } or { tasks } or { data: { tasks } }
  const raw = planningData as any;
  const pd = raw?.tasks ? raw : raw?.data?.tasks ? raw.data : raw?.data ?? raw;
  const tasks: any[] = Array.isArray(pd?.tasks) ? pd.tasks : [];

  // ─── Filters ────────────────────────────────────────────────────────────
  // Search (code/name) + deliverable + assignee + priority. The deliverable
  // dimension uses the SAME canonical resolver (getTaskPhaseName) the
  // planning grid and execution board use, so picking "Critical Report" here
  // matches that exact label everywhere else.
  const [searchText, setSearchText] = useState('');
  const [deliverableFilter, setDeliverableFilter] = useState('');
  // Assignee filter is a set of userIds (UNION — a task matches if
  // ANY selected person is on it). Was a single-value <select>;
  // replaced with the PeopleMultiSelect for consistency with the
  // Projects list "All Team Members" filter. (fix/people-filter.)
  const [assigneeFilter, setAssigneeFilter] = useState<number[]>([]);
  const [priorityFilter, setPriorityFilter] = useState('');

  const filterOptions = useMemo(() => {
    const deliverables = new Set<string>();
    // Track avatar + display name for the assignee options so the
    // PeopleMultiSelect rows render with the same face the task
    // avatars show elsewhere in the app.
    const assigneeMap = new Map<number, {
      userId: number;
      displayName: string;
      avatarUrl?: string | null;
    }>();
    for (const t of tasks) {
      const dn = getTaskPhaseName(t);
      if (dn) deliverables.add(dn);
      for (const a of t.assignees ?? []) {
        const id: number | undefined = a.userId ?? a.user?.id;
        if (id == null) continue;
        const name = `${a.user?.firstName ?? ''} ${a.user?.lastName ?? ''}`.trim() || `User #${id}`;
        if (!assigneeMap.has(id)) {
          assigneeMap.set(id, {
            userId: id,
            displayName: name,
            avatarUrl: a.user?.avatarUrl ?? null,
          });
        }
      }
    }
    return {
      deliverables: Array.from(deliverables).sort(),
      assignees: Array.from(assigneeMap.values())
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    };
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    const assigneeSet = new Set(assigneeFilter);
    return tasks.filter((t: any) => {
      // Kanban rule: tasks without a due date have no place on a
      // deadline-driven board (client feedback 2026-08-02 item 7).
      // The Planning grid still shows them so PMs can date them.
      if (!t.endDate) return false;
      if (q && !(`${t.code ?? ''} ${t.name ?? ''}`.toLowerCase().includes(q))) return false;
      if (deliverableFilter && (getTaskPhaseName(t) ?? '') !== deliverableFilter) return false;
      if (priorityFilter && t.priority !== priorityFilter) return false;
      if (assigneeSet.size > 0) {
        const has = (t.assignees ?? []).some((a: any) => {
          const aid: number | undefined = a.userId ?? a.user?.id;
          return typeof aid === 'number' && assigneeSet.has(aid);
        });
        if (!has) return false;
      }
      return true;
    });
  }, [tasks, searchText, deliverableFilter, assigneeFilter, priorityFilter]);

  const isFiltered = !!searchText.trim() || !!deliverableFilter || assigneeFilter.length > 0 || !!priorityFilter;

  const sensors = useSensors(
    // 8px activation distance — same as the My Tasks kanban. Lower values
    // (e.g. 5px) make it easy to accidentally start a drag when clicking
    // a card to open the drawer; 8px is the sweet spot.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const columnTasks = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const col of columns) map[col.id] = [];
    for (const task of filteredTasks) {
      const status = task.status || 'not_started';
      if (map[status]) map[status].push(task);
      else if (map.not_started) map.not_started.push(task);
    }
    return map;
  }, [filteredTasks]);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;

    const taskId = Number(String(active.id).replace('task-', ''));
    const targetColumn = columns.find((c) => c.id === String(over.id));

    if (targetColumn) {
      // Dropped on a column — change status
      const task = tasks.find((t: any) => t.id === taskId);
      if (task && task.status !== targetColumn.id) {
        try {
          await tasksApi.update(taskId, { status: targetColumn.id });
          queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
          notify.success(`Moved to ${targetColumn.label}`, { code: 'TASK-STATUS-200' });
        } catch (err: any) {
          notify.apiError(err, 'Failed to update status');
        }
      }
    }
  };

  const draggedTask = activeDragId ? tasks.find((t: any) => `task-${t.id}` === activeDragId) : null;

  if (isLoading) {
    return <div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">Loading board...</div>;
  }

  if (isError) {
    return (
      <div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">
        Couldn't load the board.{' '}
        <button onClick={() => refetch()} className="font-medium text-blue-600 hover:underline">Retry</button>
      </div>
    );
  }

  return (
    <>
      {/* Filter bar — search + deliverable + assignee + priority. Uses the
          shared canonical resolver so picking a deliverable here matches the
          exact same label everywhere else (planning, execution board). */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search by code or name…"
            className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-8 pr-7 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
          />
          {searchText && (
            <button
              onClick={() => setSearchText('')}
              title="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-100"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <select
          value={deliverableFilter}
          onChange={(e) => setDeliverableFilter(e.target.value)}
          className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-400"
          title="Filter by deliverable"
        >
          <option value="">All Deliverables</option>
          {filterOptions.deliverables.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <PeopleMultiSelect
          people={filterOptions.assignees}
          value={assigneeFilter}
          onChange={setAssigneeFilter}
          placeholder="All Assignees"
          title="Filter kanban by assignee"
          triggerClassName="w-56"
        />
        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-400"
          title="Filter by priority"
        >
          <option value="">All Priorities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        {isFiltered && (
          <button
            type="button"
            onClick={() => { setSearchText(''); setDeliverableFilter(''); setAssigneeFilter([]); setPriorityFilter(''); }}
            className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
            title="Clear all filters"
          >
            Clear filters
          </button>
        )}
        <span className="ml-auto text-[11px] text-slate-500 dark:text-slate-400">
          {isFiltered ? <>{filteredTasks.length} of {tasks.length} task{tasks.length !== 1 ? 's' : ''}</> : <>{tasks.length} task{tasks.length !== 1 ? 's' : ''}</>}
        </span>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="grid grid-cols-5 gap-3 min-h-[500px]">
          {columns.map((col) => (
            <KanbanColumn key={col.id} column={col} tasks={columnTasks[col.id] ?? []} onOpen={(id) => setDrawerTaskId(id)} />
          ))}
        </div>

        <DragOverlay>
          {draggedTask && (
            <div className="rounded-lg border border-blue-300 bg-white dark:bg-slate-900 p-3 shadow-2xl opacity-90 w-64">
              <p className="text-[13px] font-medium text-slate-800 dark:text-slate-100">{draggedTask.name}</p>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* Manager-facing drawer — Time tab hidden by spec. Status changes
          and assignee management happen here; hours logging does not. */}
      {drawerTaskId && (
        <TaskDrawer taskId={drawerTaskId} onClose={closeDrawer} hideTimeTab />
      )}
    </>
  );
}
