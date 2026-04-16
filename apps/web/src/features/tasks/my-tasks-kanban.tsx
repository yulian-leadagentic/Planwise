import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, User as UserIcon, GripVertical, CalendarClock } from 'lucide-react';
import { DndContext, DragOverlay, closestCorners, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent, useDraggable, useDroppable } from '@dnd-kit/core';
import { PageHeader } from '@/components/shared/page-header';
import { TaskDrawer } from './task-drawer';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { tasksApi } from '@/api/tasks.api';
import { timeApi } from '@/api/time.api';

const columns = [
  { id: 'not_started', label: 'To Do', color: 'border-t-slate-400', bg: 'bg-slate-50/50' },
  { id: 'in_progress', label: 'In Progress', color: 'border-t-blue-500', bg: 'bg-blue-50/30' },
  { id: 'in_review', label: 'In Review', color: 'border-t-violet-500', bg: 'bg-violet-50/30' },
  { id: 'completed', label: 'Done', color: 'border-t-emerald-500', bg: 'bg-emerald-50/30' },
];

const zoneBorderColors: Record<string, string> = {
  site: 'border-l-indigo-400', building: 'border-l-amber-500', level: 'border-l-teal-400',
  zone: 'border-l-amber-400', area: 'border-l-purple-400', floor: 'border-l-blue-400',
  section: 'border-l-teal-400', wing: 'border-l-pink-400',
};

function getTaskScore(task: any): number {
  let score = 0;
  const now = Date.now();
  if (task.endDate) {
    const daysUntilDue = (new Date(task.endDate).getTime() - now) / 86400000;
    if (daysUntilDue < 0) score += 1000;
    else if (daysUntilDue < 3) score += 500;
    else if (daysUntilDue < 7) score += 200;
    else if (daysUntilDue < 14) score += 100;
    else score += 50;
  }
  if (task.priority === 'critical') score += 400;
  else if (task.priority === 'high') score += 200;
  else if (task.priority === 'medium') score += 50;
  if (task.budgetHours && Number(task.budgetHours) > 0) score += 20;
  return score;
}

// Calculate "Start no later than" = dueDate - estimatedHours (in working days)
function getStartByDate(task: any): string | null {
  if (!task.endDate || !task.budgetHours) return null;
  const hours = Number(task.budgetHours);
  if (hours <= 0) return null;
  const workingDays = Math.ceil(hours / 8); // 8h per day
  const due = new Date(task.endDate);
  let d = new Date(due);
  let counted = 0;
  while (counted < workingDays) {
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 5 && dow !== 6) counted++; // Skip Fri+Sat
  }
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function QuickTimeLog({ taskId, taskName }: { taskId: number; taskName: string }) {
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const queryClient = useQueryClient();

  const logTime = useMutation({
    mutationFn: () => timeApi.createEntry({
      taskId, date: new Date().toISOString().split('T')[0],
      minutes: Math.round(Number(hours) * 60), note: note.trim() || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['time'] });
      notify.success(`Logged ${hours}h`, { code: 'TIME-LOG-200' });
      setOpen(false); setHours(''); setNote('');
    },
    onError: (err: any) => notify.apiError(err, 'Failed'),
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

function DraggableTaskCard({ task, onOpenDrawer }: { task: any; onOpenDrawer: (id: number) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `task-${task.id}` });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  const zoneType = task.zone?.zoneType || 'zone';
  const projectName = task.project?.name || task.label?.projectName || '';
  const zoneName = task.zone?.name || task.label?.name || '';
  const startBy = getStartByDate(task);
  const now = new Date();
  const isOverdue = task.endDate && new Date(task.endDate) < now && task.status !== 'completed';
  const startByDate = startBy ? new Date(task.endDate) : null;
  const startByPassed = startByDate ? (() => {
    const hours = Number(task.budgetHours || 0);
    const workDays = Math.ceil(hours / 8);
    const d = new Date(task.endDate);
    let counted = 0;
    while (counted < workDays) { d.setDate(d.getDate() - 1); if (d.getDay() !== 5 && d.getDay() !== 6) counted++; }
    return d < now;
  })() : false;

  return (
    <div ref={setNodeRef} style={style} {...attributes}
      className={cn(
        'rounded-lg border border-slate-200 bg-white shadow-sm hover:shadow-md transition-all border-l-[3px]',
        zoneBorderColors[zoneType] || 'border-l-slate-300',
        isDragging && 'opacity-40 shadow-lg ring-2 ring-blue-300 z-50',
      )}>
      {/* Drag handle */}
      <div {...listeners} className="flex items-center gap-1.5 px-3 pt-2 cursor-grab active:cursor-grabbing">
        <GripVertical className="h-3 w-3 text-slate-300" />
        {projectName && (
          <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 rounded px-1.5 py-0.5 truncate max-w-[140px]">{projectName}</span>
        )}
      </div>

      {/* Clickable area → open drawer */}
      <div className="px-3 pb-3 pt-1 cursor-pointer" onClick={() => onOpenDrawer(task.id)}>
        {task.code && <span className="text-[9px] font-mono text-slate-400">{task.code}</span>}
        <p className="text-[13px] font-medium text-slate-800 line-clamp-2">{task.name}</p>
        {zoneName && <p className="text-[10px] text-slate-400 mt-0.5 truncate">{zoneName}</p>}

        <div className="mt-2 flex items-center gap-1.5 text-[10px] flex-wrap">
          {task.priority === 'critical' && <span className="rounded bg-red-100 px-1 py-0.5 font-bold text-red-600">Critical</span>}
          {task.priority === 'high' && <span className="rounded bg-amber-100 px-1 py-0.5 font-bold text-amber-600">High</span>}
          {task.budgetHours != null && Number(task.budgetHours) > 0 && <span className="text-slate-500">{Number(task.budgetHours)}h est.</span>}
          {isOverdue && <span className="rounded bg-red-100 px-1 py-0.5 font-bold text-red-600">Overdue</span>}
        </div>

        {/* Dates row */}
        <div className="mt-1.5 space-y-0.5">
          {task.endDate && (
            <div className="flex items-center gap-1 text-[10px]">
              <span className="text-slate-400">Due:</span>
              <span className={cn('font-medium', isOverdue ? 'text-red-600' : 'text-slate-600')}>
                {new Date(task.endDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
              </span>
            </div>
          )}
          {startBy && (
            <div className="flex items-center gap-1 text-[10px]">
              <CalendarClock className="h-3 w-3 text-amber-500" />
              <span className="text-slate-400">Start by:</span>
              <span className={cn('font-medium', startByPassed ? 'text-red-600' : 'text-amber-600')}>{startBy}</span>
            </div>
          )}
        </div>

        {/* Progress */}
        {task.completionPct > 0 && (
          <div className="mt-1.5 flex items-center gap-1">
            <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full" style={{ width: `${task.completionPct}%` }} />
            </div>
            <span className="text-[10px] text-blue-600 font-medium shrink-0">{task.completionPct}%</span>
          </div>
        )}

        <div className="mt-2">
          <QuickTimeLog taskId={task.id} taskName={task.name} />
        </div>
      </div>
    </div>
  );
}

function DroppableColumn({ column, tasks, onOpenDrawer }: { column: typeof columns[0]; tasks: any[]; onOpenDrawer: (id: number) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <div ref={setNodeRef}
      className={cn('flex flex-col rounded-[14px] border-t-[3px] min-h-[400px] transition-all', column.color,
        isOver ? 'bg-blue-50/60 border-blue-300 border-2 shadow-inner' : `border border-slate-200 ${column.bg}`)}>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-slate-700">{column.label}</h3>
          <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">{tasks.length}</span>
        </div>
      </div>
      <div className="flex-1 space-y-2 px-3 pb-3">
        {tasks.map((task: any) => (
          <DraggableTaskCard key={task.id} task={task} onOpenDrawer={onOpenDrawer} />
        ))}
        {tasks.length === 0 && (
          <div className={cn('py-8 text-center text-[11px] rounded-lg border-2 border-dashed', isOver ? 'border-blue-400 text-blue-500' : 'border-slate-200 text-slate-400')}>
            {isOver ? 'Drop here' : 'No tasks'}
          </div>
        )}
      </div>
    </div>
  );
}

export function MyTasksKanbanPage() {
  const queryClient = useQueryClient();
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [drawerTaskId, setDrawerTaskId] = useState<number | null>(null);

  const { data: tasksData, isLoading } = useQuery({
    queryKey: ['tasks', 'mine'],
    queryFn: () => tasksApi.mine().then((r: any) => {
      const d = r?.data ?? r;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
  });

  const tasks: any[] = Array.isArray(tasksData) ? tasksData : [];

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const columnTasks = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const col of columns) map[col.id] = [];
    for (const task of tasks) {
      const status = task.status || 'not_started';
      if (map[status]) map[status].push(task);
      else map.not_started.push(task);
    }
    map.not_started.sort((a, b) => getTaskScore(b) - getTaskScore(a));
    map.in_progress.sort((a, b) => {
      if (!a.endDate && !b.endDate) return 0;
      if (!a.endDate) return 1;
      if (!b.endDate) return -1;
      return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
    });
    return map;
  }, [tasks]);

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

    // OPTIMISTIC UPDATE — move task immediately in local cache
    queryClient.setQueryData(['tasks', 'mine'], (old: any) => {
      if (!Array.isArray(old)) return old;
      return old.map((t: any) => t.id === taskId ? { ...t, status: targetCol.id } : t);
    });

    try {
      await tasksApi.update(taskId, { status: targetCol.id });
      // Refetch to confirm
      queryClient.invalidateQueries({ queryKey: ['tasks', 'mine'] });
      notify.success(`Moved to ${targetCol.label}`, { code: 'TASK-STATUS-200' });
    } catch (err: any) {
      // Revert on error
      queryClient.invalidateQueries({ queryKey: ['tasks', 'mine'] });
      notify.apiError(err, 'Failed to update status');
    }
  };

  const draggedTask = activeDragId ? tasks.find((t: any) => `task-${t.id}` === activeDragId) : null;

  return (
    <div className="space-y-6">
      <PageHeader title="My Tasks" description="Your personal task board — drag to change status, click card to view details & log time" />

      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-400">Loading your tasks...</div>
      ) : tasks.length === 0 ? (
        <div className="py-12 text-center">
          <UserIcon className="mx-auto h-12 w-12 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">No tasks assigned to you</p>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCorners}
          onDragStart={(e: DragStartEvent) => setActiveDragId(String(e.active.id))}
          onDragEnd={handleDragEnd}>
          <div className="grid grid-cols-4 gap-3">
            {columns.map((col) => (
              <DroppableColumn key={col.id} column={col} tasks={columnTasks[col.id] ?? []}
                onOpenDrawer={(id) => setDrawerTaskId(id)} />
            ))}
          </div>
          <DragOverlay>
            {draggedTask && (
              <div className="rounded-lg border-2 border-blue-400 bg-white p-3 shadow-2xl w-60">
                {draggedTask.project?.name && <span className="text-[10px] font-semibold text-blue-600">{draggedTask.project.name}</span>}
                <p className="text-[13px] font-medium text-slate-800">{draggedTask.name}</p>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {drawerTaskId && (
        <TaskDrawer taskId={drawerTaskId} onClose={() => setDrawerTaskId(null)} />
      )}
    </div>
  );
}
