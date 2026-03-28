import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit, Trash2, UserPlus } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { StatusBadge } from '@/components/shared/status-badge';
import { PriorityBadge } from '@/components/shared/priority-badge';
import { UserAvatar } from '@/components/shared/user-avatar';
import { TaskDiscussion } from './task-discussion';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useTask, useDeleteTask, useTaskAssignees } from '@/hooks/use-tasks';
import { useTimeEntries } from '@/hooks/use-time';
import { formatDate } from '@/lib/date-utils';
import { minutesToDisplay } from '@/types';
import { useState } from 'react';

export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const taskId = Number(id);
  const { data: task, isLoading } = useTask(taskId);
  const { data: assignees } = useTaskAssignees(taskId);
  const { data: timeData } = useTimeEntries({ taskId });
  const deleteTask = useDeleteTask();
  const [showDelete, setShowDelete] = useState(false);

  if (isLoading) return <PageSkeleton />;
  if (!task) return <p className="py-8 text-center text-muted-foreground">Task not found</p>;

  const timeEntries = timeData?.data ?? [];
  const totalMinutes = timeEntries.reduce((sum, e) => sum + e.minutes, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="rounded-md p-1.5 hover:bg-accent"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <PageHeader
          title={task.name}
          description={task.label ? `${task.label.projectName} / ${task.label.path}` : undefined}
          actions={
            <div className="flex items-center gap-2">
              <button className="rounded-md border border-border p-2 hover:bg-accent">
                <Edit className="h-4 w-4" />
              </button>
              <button
                onClick={() => setShowDelete(true)}
                className="rounded-md border border-border p-2 text-red-500 hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          }
          className="flex-1"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main content */}
        <div className="space-y-6 lg:col-span-2">
          {/* Description */}
          {task.description && (
            <div className="rounded-lg border border-border p-4">
              <h3 className="mb-2 font-medium">Description</h3>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {task.description}
              </p>
            </div>
          )}

          {/* Time entries */}
          <div className="rounded-lg border border-border p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-medium">Time Entries</h3>
              <span className="text-sm text-muted-foreground">
                Total: {minutesToDisplay(totalMinutes)}
              </span>
            </div>
            {timeEntries.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No time entries yet
              </p>
            ) : (
              <div className="space-y-2">
                {timeEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between rounded-md bg-muted/50 p-3"
                  >
                    <div>
                      <p className="text-sm">{formatDate(entry.date)}</p>
                      {entry.note && (
                        <p className="text-xs text-muted-foreground">{entry.note}</p>
                      )}
                    </div>
                    <span className="text-sm font-medium">{minutesToDisplay(entry.minutes)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Discussion */}
          <TaskDiscussion taskId={taskId} />
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Status & Priority */}
          <div className="rounded-lg border border-border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Status</span>
              <StatusBadge status={task.status} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Priority</span>
              <PriorityBadge priority={task.priority} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Progress</span>
              <span className="text-sm font-medium">{task.completionPct}%</span>
            </div>
            {task.budgetHours != null && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Budget</span>
                <span className="text-sm font-medium">{task.budgetHours}h</span>
              </div>
            )}
            {task.startDate && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Start</span>
                <span className="text-sm">{formatDate(task.startDate)}</span>
              </div>
            )}
            {task.endDate && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Due</span>
                <span className="text-sm">{formatDate(task.endDate)}</span>
              </div>
            )}
          </div>

          {/* Assignees */}
          <div className="rounded-lg border border-border p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium">Assignees</h3>
              <button className="rounded-md p-1 hover:bg-accent">
                <UserPlus className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
            {!assignees || assignees.length === 0 ? (
              <p className="text-sm text-muted-foreground">No assignees</p>
            ) : (
              <div className="space-y-2">
                {assignees.map((a) => (
                  <div key={a.id} className="flex items-center gap-2">
                    <UserAvatar
                      firstName={a.user?.firstName ?? ''}
                      lastName={a.user?.lastName ?? ''}
                      avatarUrl={a.user?.avatarUrl}
                      size="sm"
                    />
                    <div>
                      <p className="text-sm font-medium">
                        {a.user?.firstName} {a.user?.lastName}
                      </p>
                      {a.role && (
                        <p className="text-xs text-muted-foreground">{a.role}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={showDelete}
        onClose={() => setShowDelete(false)}
        onConfirm={() => {
          deleteTask.mutate(taskId, {
            onSuccess: () => navigate('/tasks'),
          });
        }}
        title="Delete Task"
        description="Are you sure you want to delete this task? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        isLoading={deleteTask.isPending}
      />
    </div>
  );
}
