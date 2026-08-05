import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { columns } from './constants';
import { DraggableTaskCard } from './draggable-task-card';

export function DroppableColumn({ column, tasks, onOpenDrawer, onStatusChange }: { column: typeof columns[0]; tasks: any[]; onOpenDrawer: (id: number) => void; onStatusChange: (taskId: number, status: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  // Default the "To Do" column to collapsed when it has many cards so
  // the user sees their active work first. Other columns start expanded.
  // The collapse state is per-column, persisted in localStorage so it
  // sticks across page reloads (kanban is a long-lived view people
  // anchor on; resetting it on every reload was annoying).
  const lsKey = `kanban.collapsed.${column.id}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(lsKey);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch {}
    // Default: collapse "To Do" only when it has more than 10 tasks.
    return column.id === 'not_started' && tasks.length > 10;
  });
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(lsKey, next ? '1' : '0'); } catch {}
      return next;
    });
  };

  return (
    <div ref={setNodeRef}
      className={cn('flex flex-col rounded-[14px] border-t-[3px] transition-all', column.color,
        collapsed ? 'min-h-[80px]' : 'min-h-[400px]',
        isOver ? 'bg-blue-50/60 border-blue-300 border-2 shadow-inner' : `border border-slate-200 dark:border-slate-700 ${column.bg}`)}>
      <div className="flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? `Expand ${column.label}` : `Collapse ${column.label}`}
          aria-expanded={!collapsed}
          className="flex items-center gap-2 group"
        >
          <span className={cn('text-slate-400 dark:text-slate-500 group-hover:text-slate-600 transition-transform', collapsed ? '-rotate-90' : '')}>
            ▾
          </span>
          <h3 className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">{column.label}</h3>
          <span className="rounded-full bg-slate-200 dark:bg-slate-700 px-1.5 py-0.5 text-[10px] font-bold text-slate-600 dark:text-slate-300">{tasks.length}</span>
        </button>
      </div>
      {!collapsed && (
      <div className="flex-1 space-y-2 px-3 pb-3">
        {tasks.map((task: any) => (
          <DraggableTaskCard key={task.id} task={task} onOpenDrawer={onOpenDrawer} onStatusChange={onStatusChange} />
        ))}
        {tasks.length === 0 && (
          <div className={cn('py-8 text-center text-[11px] rounded-lg border-2 border-dashed', isOver ? 'border-blue-400 text-blue-500' : 'border-slate-200 dark:border-slate-700 text-slate-400 dark:text-slate-500')}>
            {isOver ? 'Drop here' : 'No tasks'}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
