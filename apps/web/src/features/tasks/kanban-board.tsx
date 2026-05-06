import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Filter, User as UserIcon, GripVertical } from 'lucide-react';
import { DndContext, DragOverlay, closestCorners, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import { tasksApi } from '@/api/tasks.api';
import { TaskDrawer } from './task-drawer';

const columns = [
  { id: 'not_started', label: 'Not Started', color: 'border-t-slate-400', bg: 'bg-slate-50' },
  { id: 'in_progress', label: 'In Progress', color: 'border-t-blue-500', bg: 'bg-blue-50/30' },
  { id: 'in_review', label: 'In Review', color: 'border-t-violet-500', bg: 'bg-violet-50/30' },
  { id: 'on_hold', label: 'On Hold', color: 'border-t-amber-500', bg: 'bg-amber-50/30' },
  { id: 'completed', label: 'Completed', color: 'border-t-emerald-500', bg: 'bg-emerald-50/30' },
];

// Manager-facing card. Drag listeners live ONLY on the grip button so the
// rest of the card stays clickable (opens the task drawer). Without this
// split a click anywhere on the card would race with @dnd-kit's pointer
// activation and randomly trigger drag instead of click.
function KanbanCard({ task, onOpen }: { task: any; onOpen: (id: number) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `task-${task.id}` });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const assignee = task.assignees?.[0]?.user;
  const extraAssignees = (task.assignees?.length ?? 0) - 1;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      className={cn(
        'group rounded-lg border border-slate-200 bg-white shadow-sm hover:shadow-md transition-shadow',
        isDragging && 'opacity-50 shadow-lg ring-2 ring-blue-300',
      )}
    >
      <div className="flex items-start gap-1 p-3">
        {/* Drag grip — the only place that listens for drag activation. */}
        <button
          type="button"
          aria-label="Drag to reorder or change column"
          title="Drag to move"
          {...listeners}
          className="-ml-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-300 opacity-0 group-hover:opacity-100 hover:bg-slate-100 hover:text-slate-500 cursor-grab active:cursor-grabbing touch-none focus:outline-none focus:ring-2 focus:ring-blue-300 focus:opacity-100"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>

        {/* Click target — opens the drawer */}
        <button
          type="button"
          onClick={() => onOpen(task.id)}
          className="flex-1 min-w-0 text-left cursor-pointer rounded -mx-1 px-1 py-0.5 hover:bg-slate-50/50 focus:outline-none focus:ring-2 focus:ring-blue-300"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              {task.code && <span className="text-[10px] font-mono text-slate-400">{task.code}</span>}
              <p className="text-[13px] font-medium text-slate-800 line-clamp-2">{task.name}</p>
            </div>
            {task.priority === 'critical' && <span className="rounded bg-red-100 px-1 py-0.5 text-[9px] font-bold text-red-600">!</span>}
            {task.priority === 'high' && <span className="rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold text-amber-600">!</span>}
          </div>

          <div className="mt-2 flex items-center gap-2 text-[10px] flex-wrap">
            {assignee && (
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-1.5 py-0.5 text-indigo-600">
                <UserIcon className="h-2.5 w-2.5" />
                {assignee.firstName}
                {extraAssignees > 0 && <span className="text-indigo-400">+{extraAssignees}</span>}
              </span>
            )}
            {task.budgetHours && (
              <span className="text-slate-400">{Number(task.budgetHours)}h</span>
            )}
            {task.endDate && (
              <span className={cn(
                'text-slate-400',
                new Date(task.endDate) < new Date() && task.status !== 'completed' && 'text-red-500 font-medium',
              )}>
                {new Date(task.endDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
              </span>
            )}
          </div>
        </button>
      </div>
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
        isOver ? 'bg-blue-50/50 border-blue-200' : `border border-slate-200 ${column.bg}`,
      )}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-slate-700">{column.label}</h3>
          <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">
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
          <div className="py-6 text-center text-[11px] text-slate-400">
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
  const [drawerTaskId, setDrawerTaskId] = useState<number | null>(null);

  const { data: planningData, isLoading } = useQuery({
    queryKey: ['planning', projectId],
    queryFn: () => client.get(`/projects/${projectId}/planning-data`).then((r) => r.data?.data ?? r.data),
    enabled: !!projectId,
  });

  // Unwrap nested response: handle { success, data: { tasks } } or { tasks } or { data: { tasks } }
  const raw = planningData as any;
  const pd = raw?.tasks ? raw : raw?.data?.tasks ? raw.data : raw?.data ?? raw;
  const tasks: any[] = Array.isArray(pd?.tasks) ? pd.tasks : [];

  const sensors = useSensors(
    // 8px activation distance — same as the My Tasks kanban. Lower values
    // (e.g. 5px) make it easy to accidentally start a drag when clicking
    // a card to open the drawer; 8px is the sweet spot.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const columnTasks = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const col of columns) map[col.id] = [];
    for (const task of tasks) {
      const status = task.status || 'not_started';
      if (map[status]) map[status].push(task);
      else if (map.not_started) map.not_started.push(task);
    }
    return map;
  }, [tasks]);

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
    return <div className="py-12 text-center text-sm text-slate-400">Loading board...</div>;
  }

  return (
    <>
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
            <div className="rounded-lg border border-blue-300 bg-white p-3 shadow-2xl opacity-90 w-64">
              <p className="text-[13px] font-medium text-slate-800">{draggedTask.name}</p>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* Manager-facing drawer — Time tab hidden by spec. Status changes
          and assignee management happen here; hours logging does not. */}
      {drawerTaskId && (
        <TaskDrawer taskId={drawerTaskId} onClose={() => setDrawerTaskId(null)} hideTimeTab />
      )}
    </>
  );
}
