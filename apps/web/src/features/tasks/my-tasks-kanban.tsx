import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Plus, ChevronDown, User as UserIcon } from 'lucide-react';
import { DndContext, DragOverlay, closestCorners, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDroppable } from '@dnd-kit/core';
import { PageHeader } from '@/components/shared/page-header';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { tasksApi } from '@/api/tasks.api';
import { timeApi } from '@/api/time.api';
import client from '@/api/client';

const columns = [
  { id: 'not_started', label: 'To Do', color: 'border-t-slate-400', bg: 'bg-slate-50/50' },
  { id: 'in_progress', label: 'In Progress', color: 'border-t-blue-500', bg: 'bg-blue-50/30' },
  { id: 'in_review', label: 'In Review', color: 'border-t-violet-500', bg: 'bg-violet-50/30' },
  { id: 'completed', label: 'Done', color: 'border-t-emerald-500', bg: 'bg-emerald-50/30' },
];

function QuickTimeLog({ taskId, taskName }: { taskId: number; taskName: string }) {
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const queryClient = useQueryClient();

  const logTime = useMutation({
    mutationFn: () => timeApi.createEntry({
      taskId,
      date: new Date().toISOString().split('T')[0],
      minutes: Math.round(Number(hours) * 60),
      note: note.trim() || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['time'] });
      notify.success(`Logged ${hours}h on "${taskName}"`, { code: 'TIME-LOG-200' });
      setOpen(false);
      setHours('');
      setNote('');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to log time'),
  });

  if (!open) {
    return (
      <button onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-600 hover:bg-blue-100">
        <Clock className="h-3 w-3" /> Log Time
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-blue-200 bg-blue-50/50 p-2 space-y-1.5" onClick={(e) => e.stopPropagation()}>
      <div className="flex gap-1.5">
        <input type="number" step="0.25" min="0.25" max="24" value={hours} onChange={(e) => setHours(e.target.value)}
          placeholder="Hours" className="w-16 px-1.5 py-1 rounded border border-slate-200 text-[11px] focus:border-blue-400 focus:outline-none" autoFocus />
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Note..." className="flex-1 px-1.5 py-1 rounded border border-slate-200 text-[11px] focus:border-blue-400 focus:outline-none" />
      </div>
      <div className="flex gap-1">
        <button onClick={() => { if (hours && Number(hours) > 0) logTime.mutate(); }}
          disabled={!hours || Number(hours) <= 0 || logTime.isPending}
          className="rounded bg-blue-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
          {logTime.isPending ? 'Saving...' : 'Save'}
        </button>
        <button onClick={() => setOpen(false)} className="text-[10px] text-slate-400 px-1">Cancel</button>
      </div>
    </div>
  );
}

function MyTaskCard({ task }: { task: any }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `task-${task.id}` });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}
      className={cn('rounded-lg border border-slate-200 bg-white p-3 cursor-grab active:cursor-grabbing shadow-sm hover:shadow-md transition-all',
        isDragging && 'opacity-50 shadow-lg ring-2 ring-blue-300')}>
      {task.code && <span className="text-[10px] font-mono text-slate-400">{task.code}</span>}
      <p className="text-[13px] font-medium text-slate-800 line-clamp-2 mt-0.5">{task.name}</p>

      {/* Project + zone context */}
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-slate-400">
        {task.project?.name && <span className="truncate">{task.project.name}</span>}
        {task.zone?.name && <><span>·</span><span className="truncate">{task.zone.name}</span></>}
      </div>

      {/* Meta row */}
      <div className="mt-2 flex items-center gap-2 text-[10px] flex-wrap">
        {task.priority === 'critical' && <span className="rounded bg-red-100 px-1 py-0.5 font-bold text-red-600">Critical</span>}
        {task.priority === 'high' && <span className="rounded bg-amber-100 px-1 py-0.5 font-bold text-amber-600">High</span>}
        {task.budgetHours && <span className="text-slate-500">{Number(task.budgetHours)}h budget</span>}
        {task.endDate && (
          <span className={cn('text-slate-400', new Date(task.endDate) < new Date() && task.status !== 'completed' && 'text-red-500 font-medium')}>
            Due {new Date(task.endDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
          </span>
        )}
        {task.completionPct > 0 && (
          <span className="text-blue-600 font-medium">{task.completionPct}%</span>
        )}
      </div>

      {/* Quick time log */}
      <div className="mt-2">
        <QuickTimeLog taskId={task.id} taskName={task.name} />
      </div>
    </div>
  );
}

function MyTaskColumn({ column, tasks }: { column: typeof columns[0]; tasks: any[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const taskIds = tasks.map((t: any) => `task-${t.id}`);

  return (
    <div ref={setNodeRef}
      className={cn('flex flex-col rounded-[14px] border-t-[3px] min-h-[400px]', column.color,
        isOver ? 'bg-blue-50/50 border-blue-200' : `border border-slate-200 ${column.bg}`)}>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-slate-700">{column.label}</h3>
          <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">{tasks.length}</span>
        </div>
      </div>
      <div className="flex-1 space-y-2 px-3 pb-3">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {tasks.map((task: any) => <MyTaskCard key={task.id} task={task} />)}
        </SortableContext>
        {tasks.length === 0 && <div className="py-8 text-center text-[11px] text-slate-400">No tasks</div>}
      </div>
    </div>
  );
}

export function MyTasksKanbanPage() {
  const queryClient = useQueryClient();
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const { data: tasksData, isLoading } = useQuery({
    queryKey: ['tasks', 'mine'],
    queryFn: () => tasksApi.mine().then((r: any) => {
      const d = r?.data ?? r;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
  });

  const tasks: any[] = Array.isArray(tasksData) ? tasksData : [];

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const columnTasks = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const col of columns) map[col.id] = [];
    for (const task of tasks) {
      const status = task.status || 'not_started';
      if (map[status]) map[status].push(task);
      else map.not_started.push(task);
    }
    return map;
  }, [tasks]);

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;
    const taskId = Number(String(active.id).replace('task-', ''));
    const targetCol = columns.find((c) => c.id === String(over.id));
    if (targetCol) {
      const task = tasks.find((t: any) => t.id === taskId);
      if (task && task.status !== targetCol.id) {
        try {
          await tasksApi.update(taskId, { status: targetCol.id });
          queryClient.invalidateQueries({ queryKey: ['tasks'] });
          notify.success(`Moved to ${targetCol.label}`, { code: 'TASK-STATUS-200' });
        } catch (err: any) { notify.apiError(err, 'Failed'); }
      }
    }
  };

  const draggedTask = activeDragId ? tasks.find((t: any) => `task-${t.id}` === activeDragId) : null;

  return (
    <div className="space-y-6">
      <PageHeader title="My Tasks" description="Your personal task board — drag to change status, click to log time" />

      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-400">Loading your tasks...</div>
      ) : tasks.length === 0 ? (
        <div className="py-12 text-center">
          <UserIcon className="mx-auto h-12 w-12 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">No tasks assigned to you</p>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCorners}
          onDragStart={(e: DragStartEvent) => setActiveDragId(String(e.active.id))} onDragEnd={handleDragEnd}>
          <div className="grid grid-cols-4 gap-3">
            {columns.map((col) => <MyTaskColumn key={col.id} column={col} tasks={columnTasks[col.id] ?? []} />)}
          </div>
          <DragOverlay>
            {draggedTask && (
              <div className="rounded-lg border border-blue-300 bg-white p-3 shadow-2xl opacity-90 w-60">
                <p className="text-[13px] font-medium text-slate-800">{draggedTask.name}</p>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}
