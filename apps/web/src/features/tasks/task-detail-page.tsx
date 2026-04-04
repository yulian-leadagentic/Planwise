import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit, Trash2, UserPlus, X } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { StatusBadge } from '@/components/shared/status-badge';
import { PriorityBadge } from '@/components/shared/priority-badge';
import { UserAvatar } from '@/components/shared/user-avatar';
import { TaskDiscussion } from './task-discussion';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import {
  useTask,
  useDeleteTask,
  useUpdateTask,
  useAddTaskAssignee,
  useRemoveTaskAssignee,
} from '@/hooks/use-tasks';
import { useTimeEntries } from '@/hooks/use-time';
import { formatDate } from '@/lib/date-utils';
import { minutesToDisplay } from '@/types';
import { useState, useEffect, useRef, type ReactNode } from 'react';
import { toast } from 'sonner';

/* -------------------------------------------------------------------------- */
/*  Inline‑editable primitives                                                */
/* -------------------------------------------------------------------------- */

const STATUS_OPTIONS = [
  'not_started',
  'in_progress',
  'in_review',
  'completed',
  'on_hold',
  'cancelled',
] as const;

const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical'] as const;

function EditableText({
  value,
  onSave,
  className = '',
  placeholder = 'Click to edit',
}: {
  value: string;
  onSave: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);

  useEffect(() => setVal(value), [value]);

  if (!editing) {
    return (
      <span
        onClick={() => setEditing(true)}
        className={`cursor-pointer rounded px-1 hover:bg-muted/50 ${className}`}
      >
        {value || <span className="text-muted-foreground italic">{placeholder}</span>}
      </span>
    );
  }

  return (
    <input
      type="text"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => {
        if (val !== value) onSave(val);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (val !== value) onSave(val);
          setEditing(false);
        }
        if (e.key === 'Escape') {
          setVal(value);
          setEditing(false);
        }
      }}
      autoFocus
      className={`rounded border border-border bg-background px-2 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring ${className}`}
    />
  );
}

function EditableTextarea({
  value,
  onSave,
}: {
  value: string;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);

  useEffect(() => setVal(value), [value]);

  if (!editing) {
    return (
      <div
        onClick={() => setEditing(true)}
        className="cursor-pointer rounded px-1 hover:bg-muted/50"
      >
        {value ? (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{value}</p>
        ) : (
          <p className="text-sm italic text-muted-foreground">Click to add description</p>
        )}
      </div>
    );
  }

  return (
    <textarea
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => {
        if (val !== value) onSave(val);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setVal(value);
          setEditing(false);
        }
      }}
      autoFocus
      rows={5}
      className="w-full rounded border border-border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
    />
  );
}

function EditableNumber({
  value,
  onSave,
  min,
  max,
  suffix = '',
}: {
  value: number | null | undefined;
  onSave: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(value ?? ''));

  useEffect(() => setVal(String(value ?? '')), [value]);

  const save = () => {
    const num = Number(val);
    if (!isNaN(num) && num !== value) {
      const clamped =
        min != null && max != null
          ? Math.min(max, Math.max(min, num))
          : min != null
            ? Math.max(min, num)
            : max != null
              ? Math.min(max, num)
              : num;
      onSave(clamped);
    }
    setEditing(false);
  };

  if (!editing) {
    return (
      <span
        onClick={() => setEditing(true)}
        className="cursor-pointer rounded px-1 text-sm font-medium hover:bg-muted/50"
      >
        {value != null ? `${value}${suffix}` : <span className="italic text-muted-foreground">--</span>}
      </span>
    );
  }

  return (
    <input
      type="number"
      value={val}
      min={min}
      max={max}
      onChange={(e) => setVal(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') {
          setVal(String(value ?? ''));
          setEditing(false);
        }
      }}
      autoFocus
      className="w-24 rounded border border-border bg-background px-2 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
    />
  );
}

function EditableDate({
  value,
  onSave,
}: {
  value: string | null | undefined;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value ? value.slice(0, 10) : '');

  useEffect(() => setVal(value ? value.slice(0, 10) : ''), [value]);

  const save = () => {
    if (val && val !== (value ?? '').slice(0, 10)) onSave(val);
    setEditing(false);
  };

  if (!editing) {
    return (
      <span
        onClick={() => setEditing(true)}
        className="cursor-pointer rounded px-1 text-sm hover:bg-muted/50"
      >
        {value ? formatDate(value) : <span className="italic text-muted-foreground">--</span>}
      </span>
    );
  }

  return (
    <input
      type="date"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') {
          setVal(value ? value.slice(0, 10) : '');
          setEditing(false);
        }
      }}
      autoFocus
      className="rounded border border-border bg-background px-2 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
    />
  );
}

function EditableSelect<T extends string>({
  value,
  options,
  onSave,
  renderValue,
}: {
  value: T;
  options: readonly T[];
  onSave: (v: T) => void;
  renderValue: (v: T) => ReactNode;
}) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <span
        onClick={() => setEditing(true)}
        className="cursor-pointer rounded px-1 hover:bg-muted/50"
      >
        {renderValue(value)}
      </span>
    );
  }

  return (
    <select
      value={value}
      onChange={(e) => {
        onSave(e.target.value as T);
        setEditing(false);
      }}
      onBlur={() => setEditing(false)}
      autoFocus
      className="rounded border border-border bg-background px-2 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt.replace(/_/g, ' ')}
        </option>
      ))}
    </select>
  );
}

/* -------------------------------------------------------------------------- */
/*  Add Assignee Dialog                                                       */
/* -------------------------------------------------------------------------- */

function AddAssigneeDialog({
  open,
  onClose,
  onAdd,
  isLoading,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (userId: number, role: string) => void;
  isLoading: boolean;
}) {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('');

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm rounded-lg border border-border bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Add Assignee</h3>
          <button onClick={onClose} className="rounded p-1 hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">User ID</label>
            <input
              type="number"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="Enter user ID"
              className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Role (optional)</label>
            <input
              type="text"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. Reviewer, Lead"
              className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
          >
            Cancel
          </button>
          <button
            disabled={!userId || isLoading}
            onClick={() => {
              const id = Number(userId);
              if (!id) return;
              onAdd(id, role);
            }}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isLoading ? 'Adding...' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sidebar row helper                                                        */
/* -------------------------------------------------------------------------- */

function SidebarRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page component                                                            */
/* -------------------------------------------------------------------------- */

export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const taskId = Number(id);

  const { data: task, isLoading } = useTask(taskId);
  const { data: timeData } = useTimeEntries({ taskId });
  const deleteTask = useDeleteTask();
  const updateTask = useUpdateTask();
  const addAssignee = useAddTaskAssignee();
  const removeAssignee = useRemoveTaskAssignee();

  const [showDelete, setShowDelete] = useState(false);
  const [showAddAssignee, setShowAddAssignee] = useState(false);

  if (isLoading) return <PageSkeleton />;
  if (!task) return <p className="py-8 text-center text-muted-foreground">Task not found</p>;

  const timeEntries = timeData?.data ?? [];
  const totalMinutes = timeEntries.reduce((sum: number, e: any) => sum + e.minutes, 0);

  const assignees = task.assignees ?? [];

  /* helper to fire an update */
  const patch = (fields: Record<string, unknown>) => {
    updateTask.mutate({ id: taskId, ...fields } as any);
  };

  /* breadcrumb: Project > Zone > Task code */
  const breadcrumb = [
    task.project?.name,
    task.zone?.name,
    task.code,
  ]
    .filter(Boolean)
    .join(' > ');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="rounded-md p-1.5 hover:bg-accent"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <PageHeader
          title={
            <EditableText
              value={task.name}
              onSave={(v) => patch({ name: v })}
              className="text-xl font-semibold"
            />
          }
          description={breadcrumb}
          actions={
            <div className="flex items-center gap-2">
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
        {/* ---- Main content ---- */}
        <div className="space-y-6 lg:col-span-2">
          {/* Description */}
          <div className="rounded-lg border border-border p-4">
            <h3 className="mb-2 font-medium">Description</h3>
            <EditableTextarea
              value={task.description ?? ''}
              onSave={(v) => patch({ description: v })}
            />
          </div>

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
                {timeEntries.map((entry: any) => (
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
                    <span className="text-sm font-medium">
                      {minutesToDisplay(entry.minutes)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Discussion */}
          <TaskDiscussion taskId={taskId} />
        </div>

        {/* ---- Sidebar ---- */}
        <div className="space-y-4">
          {/* Status, priority & metadata */}
          <div className="rounded-lg border border-border p-4 space-y-3">
            <SidebarRow label="Status">
              <EditableSelect
                value={task.status}
                options={STATUS_OPTIONS}
                onSave={(v) => patch({ status: v })}
                renderValue={(v) => <StatusBadge status={v} />}
              />
            </SidebarRow>

            <SidebarRow label="Priority">
              <EditableSelect
                value={task.priority}
                options={PRIORITY_OPTIONS}
                onSave={(v) => patch({ priority: v })}
                renderValue={(v) => <PriorityBadge priority={v} />}
              />
            </SidebarRow>

            <SidebarRow label="Progress">
              <EditableNumber
                value={task.completionPct}
                onSave={(v) => patch({ completionPct: v })}
                min={0}
                max={100}
                suffix="%"
              />
            </SidebarRow>

            <SidebarRow label="Budget Hours">
              <EditableNumber
                value={task.budgetHours}
                onSave={(v) => patch({ budgetHours: v })}
                min={0}
                suffix="h"
              />
            </SidebarRow>

            <SidebarRow label="Budget Amount">
              <EditableNumber
                value={task.budgetAmount}
                onSave={(v) => patch({ budgetAmount: v })}
                min={0}
              />
            </SidebarRow>

            <SidebarRow label="Start">
              <EditableDate
                value={task.startDate}
                onSave={(v) => patch({ startDate: v })}
              />
            </SidebarRow>

            <SidebarRow label="Due">
              <EditableDate
                value={task.endDate}
                onSave={(v) => patch({ endDate: v })}
              />
            </SidebarRow>

            {/* Code */}
            {task.code && (
              <SidebarRow label="Code">
                <span className="rounded bg-muted px-2 py-0.5 text-xs font-mono">
                  {task.code}
                </span>
              </SidebarRow>
            )}

            {/* Service Type */}
            {task.serviceType && (
              <SidebarRow label="Service Type">
                <span
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                  style={{
                    backgroundColor: task.serviceType.color
                      ? `${task.serviceType.color}20`
                      : undefined,
                    color: task.serviceType.color ?? undefined,
                  }}
                >
                  {task.serviceType.name}
                </span>
              </SidebarRow>
            )}

            {/* Phase */}
            {task.phase && (
              <SidebarRow label="Phase">
                <span className="text-sm">{task.phase.name}</span>
              </SidebarRow>
            )}
          </div>

          {/* Assignees */}
          <div className="rounded-lg border border-border p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium">Assignees</h3>
              <button
                onClick={() => setShowAddAssignee(true)}
                className="rounded-md p-1 hover:bg-accent"
              >
                <UserPlus className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
            {assignees.length === 0 ? (
              <p className="text-sm text-muted-foreground">No assignees</p>
            ) : (
              <div className="space-y-2">
                {assignees.map((a: any) => (
                  <div key={a.id} className="flex items-center gap-2">
                    <UserAvatar
                      firstName={a.user?.firstName ?? ''}
                      lastName={a.user?.lastName ?? ''}
                      avatarUrl={a.user?.avatarUrl}
                      size="sm"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {a.user?.firstName} {a.user?.lastName}
                      </p>
                      {a.role && (
                        <p className="text-xs text-muted-foreground">{a.role}</p>
                      )}
                    </div>
                    <button
                      onClick={() =>
                        removeAssignee.mutate({ taskId, userId: a.userId ?? a.user?.id })
                      }
                      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-red-500"
                      title="Remove assignee"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Delete confirmation */}
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

      {/* Add assignee dialog */}
      <AddAssigneeDialog
        open={showAddAssignee}
        onClose={() => setShowAddAssignee(false)}
        onAdd={(userId, role) => {
          addAssignee.mutate(
            { taskId, userId, role: role || undefined },
            {
              onSuccess: () => setShowAddAssignee(false),
            },
          );
        }}
        isLoading={addAssignee.isPending}
      />
    </div>
  );
}
