import { StatusBadge } from '@/components/shared/status-badge';
import { PriorityBadge } from '@/components/shared/priority-badge';
import { UserAvatar } from '@/components/shared/user-avatar';
import { formatDate } from '@/lib/date-utils';
import { minutesToDisplay } from '@/types';
import type { Task } from '@/types';

interface TaskCardProps {
  task: Task;
}

export function TaskCard({ task }: TaskCardProps) {
  return (
    <div className="rounded-lg border border-border bg-background p-4 transition-colors hover:bg-muted/50">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{task.name}</h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {task.label?.projectName} / {task.label?.name}
          </p>
        </div>
        <PriorityBadge priority={task.priority} />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <StatusBadge status={task.status} />
        {task.loggedMinutes != null && task.loggedMinutes > 0 && (
          <span className="text-xs text-muted-foreground">
            {minutesToDisplay(task.loggedMinutes)} logged
          </span>
        )}
        {task.endDate && (
          <span className="ml-auto text-xs text-muted-foreground">
            Due {formatDate(task.endDate)}
          </span>
        )}
      </div>

      {task.assignees && task.assignees.length > 0 && (
        <div className="mt-3 flex -space-x-1">
          {task.assignees.slice(0, 5).map((a) => (
            <UserAvatar
              key={a.id}
              firstName={a.user?.firstName ?? ''}
              lastName={a.user?.lastName ?? ''}
              avatarUrl={a.user?.avatarUrl}
              size="xs"
              className="ring-2 ring-background"
            />
          ))}
          {task.assignees.length > 5 && (
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium ring-2 ring-background">
              +{task.assignees.length - 5}
            </div>
          )}
        </div>
      )}

      {/* Progress bar */}
      {task.completionPct > 0 && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Progress</span>
            <span>{task.completionPct}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-brand-500 transition-all"
              style={{ width: `${task.completionPct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
