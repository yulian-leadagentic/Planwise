import { AlertCircle, MessageSquare } from 'lucide-react';
import { StatusBadge } from '@/components/shared/status-badge';
import { PriorityBadge } from '@/components/shared/priority-badge';
import { UserAvatar } from '@/components/shared/user-avatar';
import { formatDate } from '@/lib/date-utils';
import { minutesToDisplay } from '@/types';
import { cn } from '@/lib/utils';
import type { Task } from '@/types';

interface TaskCardProps {
  task: Task;
}

export function TaskCard({ task }: TaskCardProps) {
  // QA5 UI-1: red due date when overdue (open tasks only). This matches
  // the shared TaskCardBody behavior so every task-display surface
  // signals overdue the same way.
  const isDone = task.status === 'completed' || (task.status as string) === 'done' || (task.status as string) === 'cancelled';
  const isOverdue = !!task.endDate && !isDone && new Date(task.endDate) < new Date();

  // QA5 UI-2: personal-task suffix. Rendered as muted inline text so
  // the task name stays the primary focus.
  const isPersonal = !!(task as unknown as { isPersonal?: boolean }).isPersonal;

  // QA5 UI-4: comment indicator. Prefer the explicit commentCount
  // surfaced by the API; fall back to _count.comments on raw payloads.
  const commentCount = Number(
    (task as unknown as { commentCount?: number })?.commentCount
    ?? (task as unknown as { _count?: { comments?: number } })?._count?.comments
    ?? 0,
  );

  // QA5 UI-5: assignee count stays as avatar stack — this card never
  // showed a count chip, so there's nothing to hide for 0/1. Avatars
  // continue to show for every assignee.
  return (
    <div className="rounded-lg border border-border bg-background p-4 transition-colors hover:bg-muted/50">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">
            {task.name}
            {isPersonal && (
              <span className="ml-1 text-muted-foreground font-normal">(Personal)</span>
            )}
          </h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {task.label?.projectName} / {task.label?.name}
          </p>
        </div>
        {/* QA5 UI-3: priority chip stays on the top-right of the name
            row, which is already where it was — matches the shared
            TaskCardBody rendering. */}
        <div className="flex items-center gap-1.5 shrink-0">
          {commentCount > 0 && (
            <span
              className="inline-flex items-center gap-0.5 text-green-600 dark:text-green-400"
              aria-label={`${commentCount} comment${commentCount === 1 ? '' : 's'}`}
              title={`${commentCount} comment${commentCount === 1 ? '' : 's'}`}
            >
              <MessageSquare className="h-3 w-3" />
              <span className="text-[10px] font-bold tabular-nums leading-none">{commentCount}</span>
            </span>
          )}
          <PriorityBadge priority={task.priority} />
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <StatusBadge status={task.status} />
        {task.loggedMinutes != null && task.loggedMinutes > 0 && (
          <span className="text-xs text-muted-foreground">
            {minutesToDisplay(task.loggedMinutes)} logged
          </span>
        )}
        {task.endDate && (
          <span
            className={cn(
              'ml-auto inline-flex items-center gap-1 text-xs',
              isOverdue ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-muted-foreground',
            )}
            title={isOverdue ? 'Overdue' : undefined}
          >
            Due {formatDate(task.endDate)}
            {isOverdue && <AlertCircle className="h-3 w-3" aria-hidden="true" />}
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
