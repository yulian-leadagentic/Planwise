import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Filter, User as UserIcon } from 'lucide-react';
import { DndContext, DragOverlay, closestCorners, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import { tasksApi } from '@/api/tasks.api';

const columns = [
  { id: 'not_started', label: 'Not Started', color: 'border-t-slate-400', bg: 'bg-slate-50' },
  { id: 'in_progress', label: 'In Progress', color: 'border-t-blue-500', bg: 'bg-blue-50/30' },
  { id: 'in_review', label: 'In Review', color: 'border-t-violet-500', bg: 'bg-violet-50/30' },
  { id: 'on_hold', label: 'On Hold', color: 'border-t-amber-500', bg: 'bg-amber-50/30' },
  { id: 'completed', label: 'Completed', color: 'border-t-emerald-500', bg: 'bg-emerald-50/30' },
];

function KanbanCard({ task }: { task: any }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `task-${task.id}` });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const assignee = task.assignees?.[0]?.user;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        'rounded-lg border border-slate-200 bg-white p-3 cursor-grab active:cursor-grabbing shadow-sm hover:shadow-md transition-shadow',
        isDragging && 'opacity-50 shadow-lg',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {task.code && <span className="text-[10px] font-mono text-slate-400">{task.code}</span>}
          <p className="text-[13px] font-medium text-slate-800 line-clamp-2">{task.name}</p>
        </div>
        {task.priority === 'critical' && <span className="rounded bg-red-100 px-1 py-0.5 text-[9px] font-bold text-red-600">!</span>}
        {task.priority === 'high' && <span className="rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold text-amber-600">!</span>}
      </div>

      <div className="mt-2 flex items-center gap-2 text-[10px]">
        {assignee && (
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-1.5 py-0.5 text-indigo-600">
            <UserIcon className="h-2.5 w-2.5" />
            {assignee.firstName}
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
    </div>
  );
}

function KanbanColumn({ column, tasks }: { column: typeof columns[0]; tasks: any[] }) {
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
            <KanbanCard key={task.id} task={task} />
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

  const { data: planningData, isLoading } = useQuery({
    queryKey: ['planning', projectId],
    queryFn: () => client.get(`/projects/${projectId}/planning-data`).then((r) => r.data?.data ?? r.data),
    enabled: !!projectId,
  });

  const pd = (planningData as any)?.data ?? planningData;
  const tasks = (pd as any)?.tasks ?? [];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
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
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="grid grid-cols-5 gap-3 min-h-[500px]">
        {columns.map((col) => (
          <KanbanColumn key={col.id} column={col} tasks={columnTasks[col.id] ?? []} />
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
  );
}
