import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { X, Clock, Paperclip, MessageSquare, UserPlus, ChevronDown, Search, Trash2, AlertCircle, AlertTriangle, Calendar, FileText, Pencil } from 'lucide-react';
import { FilesTab } from '@/features/projects/files-tab';
import { MessagePanel } from '@/features/messaging/message-panel';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { tasksApi } from '@/api/tasks.api';
import { timeApi } from '@/api/time.api';
import { formatDate, formatRelative } from '@/lib/date-utils';
import { getTaskHealth } from '@/lib/task-health';
import { queryKeys } from '@/lib/query-keys';
import { TimeEntryForm } from '@/features/time/time-entry-form';
import { useAllowedTransitions } from '@/hooks/use-allowed-transitions';
import { STATUS_LABEL } from '@/lib/task-constants';
import { usePermissions } from '@/hooks/use-permissions';
import { TaskChecklist } from '@/features/tasks/task-checklist';
import client from '@/api/client';

interface TaskDrawerProps {
  taskId: number | null;
  onClose: () => void;
  /**
   * Hide the "Time" tab and entry form. Used by surfaces aimed at managers
   * (e.g. the project Kanban) where the user is meant to coordinate work
   * — change status, assign people, edit details — but NOT log hours on
   * behalf of the team. When true the drawer opens on the Details tab.
   */
  hideTimeTab?: boolean;
}

const STATUS_OPTIONS = ['not_started', 'in_progress', 'in_review', 'completed', 'on_hold', 'cancelled'];
const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical'];

const statusColors: Record<string, string> = {
  not_started: 'bg-slate-100 text-slate-600', in_progress: 'bg-blue-100 text-blue-700',
  in_review: 'bg-violet-100 text-violet-700', completed: 'bg-emerald-100 text-emerald-700',
  on_hold: 'bg-amber-100 text-amber-700', cancelled: 'bg-red-100 text-red-700',
};

const priorityColors: Record<string, string> = {
  low: 'bg-slate-100 text-slate-600', medium: 'bg-blue-100 text-blue-700',
  high: 'bg-amber-100 text-amber-700', critical: 'bg-red-100 text-red-700',
};

export function TaskDrawer({ taskId, onClose, hideTimeTab = false }: TaskDrawerProps) {
  const queryClient = useQueryClient();
  // Default to "details" when the Time tab is hidden, since "time" wouldn't
  // be a valid choice. Otherwise keep the previous default ("time") so the
  // worker-facing flow lands on the time-entry form as it always has.
  const [tab, setTab] = useState<'time' | 'details' | 'files' | 'discussion'>(
    hideTimeTab ? 'details' : 'time',
  );
  const drawerRef = useRef<HTMLDivElement>(null);

  const { data: task, isLoading } = useQuery({
    queryKey: queryKeys.tasks.detail(taskId!),
    queryFn: () => tasksApi.get(taskId!),
    enabled: !!taskId,
  });

  // Focus drawer on open + close on Escape + restore focus on close
  useEffect(() => {
    if (!taskId) return;
    const prevFocus = document.activeElement as HTMLElement;
    setTimeout(() => drawerRef.current?.focus(), 0);

    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      prevFocus?.focus?.();
    };
  }, [taskId, onClose]);

  const updateTask = useMutation({
    mutationFn: ({ field, value }: { field: string; value: any }) =>
      tasksApi.update(taskId!, { [field]: value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.mine() });
      queryClient.invalidateQueries({ queryKey: queryKeys.planning.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionBoard.all });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update'),
  });

  if (!taskId) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} aria-hidden="true" />

      {/* Drawer */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-drawer-title"
        tabIndex={-1}
        className="fixed inset-y-0 right-0 z-50 w-[520px] max-w-[90vw] bg-white border-l border-slate-200 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200 focus:outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 id="task-drawer-title" className="text-sm font-bold text-slate-900 truncate">
            {isLoading ? 'Loading...' : (task as any)?.name || 'Task'}
          </h2>
          <button onClick={onClose} className="rounded-md p-2 hover:bg-slate-100 text-slate-400 hover:text-slate-600" aria-label="Close task drawer">
            <X className="h-4 w-4" />
          </button>
        </div>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-400">Loading task...</div>
        ) : !task ? (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-400">Task not found</div>
        ) : (
          <>
            {/* Task code + quick status */}
            <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
              {(task as any).code && <span className="font-mono text-[11px] text-slate-400">{(task as any).code}</span>}
              <StatusSelect
                currentStatus={(task as any).status}
                onChange={(s) => updateTask.mutate({ field: 'status', value: s })}
              />
              <select aria-label="Task priority" value={(task as any).priority} onChange={(e) => updateTask.mutate({ field: 'priority', value: e.target.value })}
                className={cn('rounded-[5px] px-2 py-0.5 text-[11px] font-bold border-0 cursor-pointer focus:outline-none', priorityColors[(task as any).priority] || priorityColors.medium)}>
                {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
              </select>
            </div>

            {/* Health banner */}
            <TaskHealthBanner task={task} />

            {/* Tabs — Time is hidden when this drawer is opened from a
                manager-facing surface (e.g. the project Kanban) so logging
                hours on behalf of the team isn't even an option. */}
            <div className="flex border-b border-slate-200 px-5">
              {([
                ...(hideTimeTab ? [] : [{ key: 'time' as const, label: 'Time', icon: Clock }]),
                // Renamed "Details" → "Project Info" (Z1). The tab now
                // leads with the parent project's info, then the task's
                // own details below.
                { key: 'details' as const, label: 'Project Info' },
                { key: 'files' as const, label: 'Files', icon: FileText },
                { key: 'discussion' as const, label: 'Discussion', icon: MessageSquare },
              ]).map((t) => (
                <button key={t.key} onClick={() => setTab(t.key)}
                  className={cn('border-b-2 px-3 py-2 text-xs font-semibold transition-colors flex items-center gap-1',
                    tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600')}>
                  {t.icon && <t.icon className="h-3 w-3" />}
                  {t.label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {tab === 'details' && <TaskDetailsTab task={task as any} onUpdate={(f, v) => updateTask.mutate({ field: f, value: v })} />}
              {tab === 'time' && !hideTimeTab && <TaskTimeTab taskId={taskId!} />}
              {tab === 'files' && (task as any).projectId && <FilesTab projectId={(task as any).projectId} />}
              {tab === 'discussion' && <TaskDiscussionTab taskId={taskId!} />}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function StatusSelect({ currentStatus, onChange }: { currentStatus: string; onChange: (s: string) => void }) {
  const { allowedStatuses } = useAllowedTransitions(currentStatus);
  return (
    <select
      aria-label="Task status"
      value={currentStatus}
      onChange={(e) => onChange(e.target.value)}
      className={cn('rounded-[5px] px-2 py-0.5 text-[11px] font-bold border-0 cursor-pointer focus:outline-none', statusColors[currentStatus] || statusColors.not_started)}
    >
      {STATUS_OPTIONS.filter((s) => allowedStatuses.includes(s)).map((s) => (
        <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>
      ))}
    </select>
  );
}

function TaskHealthBanner({ task }: { task: any }) {
  const health = getTaskHealth(task);
  if (health.level === 'ok' && health.reasons.length === 0) {
    return (
      <div className="px-5 py-2.5 border-b border-slate-100 bg-slate-50/50 flex items-center gap-4 text-[11px] text-slate-600">
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" /> {health.loggedHours}h / {health.estimatedHours}h
        </span>
        <span className="tabular-nums font-semibold text-blue-600">{health.computedPct}% complete</span>
        {task.endDate && (
          <span className="flex items-center gap-1 ml-auto">
            <Calendar className="h-3 w-3" /> Due {formatDate(task.endDate.split('T')[0])}
          </span>
        )}
      </div>
    );
  }

  const isCritical = health.level === 'critical';
  const bgCls = isCritical ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200';
  const textCls = isCritical ? 'text-red-700' : 'text-amber-700';
  const Icon = isCritical ? AlertCircle : AlertTriangle;

  return (
    <div className={cn('px-5 py-2.5 border-b flex items-start gap-2', bgCls)}>
      <Icon className={cn('h-4 w-4 shrink-0 mt-0.5', textCls)} />
      <div className="flex-1 min-w-0">
        <div className={cn('text-[11px] font-bold uppercase tracking-wider', textCls)}>
          {isCritical ? 'At Risk — Needs Attention' : 'Warning'}
        </div>
        <ul className={cn('mt-0.5 text-[12px] space-y-0.5', textCls)}>
          {health.reasons.map((r, i) => <li key={i}>• {r}</li>)}
        </ul>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-slate-600">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" /> {health.loggedHours}h / {health.estimatedHours}h
          </span>
          <span className="tabular-nums font-semibold">{health.computedPct}% complete</span>
          {task.endDate && (
            <span className="flex items-center gap-1">
              <Calendar className="h-3 w-3" /> {formatDate(task.endDate.split('T')[0])}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function AssigneeManager({ taskId, assignees }: { taskId: number; assignees: any[] }) {
  const queryClient = useQueryClient();
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState('');

  const { data: users = [] } = useQuery({
    queryKey: queryKeys.users.list(),
    queryFn: () => client.get('/users').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
    staleTime: 5 * 60 * 1000,
    enabled: showPicker,
  });

  const addMutation = useMutation({
    mutationFn: (userId: number) => tasksApi.addAssignee(taskId, { userId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionBoard.all });
      // Auto-close the picker after 3s — the new assignee chip animates
      // in immediately so the user sees the change, but the picker stays
      // open briefly in case they want to add multiple people in a row.
      setSearch('');
      window.setTimeout(() => setShowPicker(false), 3000);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to assign'),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: number) => tasksApi.removeAssignee(taskId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionBoard.all });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove'),
  });

  const assignedIds = new Set((assignees ?? []).map((a: any) => a.user?.id));
  const filtered = (users as any[]).filter((u: any) => {
    if (assignedIds.has(u.id)) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return `${u.firstName} ${u.lastName}`.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q);
  });

  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="text-[11px] font-semibold text-slate-400 uppercase">Assignees</label>
        <button onClick={() => setShowPicker(!showPicker)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-blue-600 hover:bg-blue-50">
          <UserPlus className="h-3 w-3" /> Assign
        </button>
      </div>

      {showPicker && (
        <div className="mt-1.5 rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-slate-100 px-2.5 py-2">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people..."
              className="flex-1 bg-transparent text-[12px] outline-none placeholder:text-slate-400" autoFocus />
          </div>
          <div className="max-h-32 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-slate-400">No users found</p>
            ) : (
              filtered.slice(0, 10).map((u: any) => (
                <button key={u.id} onClick={() => addMutation.mutate(u.id)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-slate-50">
                  <div className="w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-[8px] font-semibold flex items-center justify-center">
                    {(u.firstName?.[0] ?? '')}{(u.lastName?.[0] ?? '')}
                  </div>
                  <span className="text-slate-700">{u.firstName} {u.lastName}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <div className="mt-1.5 space-y-1">
        {(assignees ?? []).length === 0 && !showPicker ? (
          <p className="text-[12px] text-slate-400 italic">No assignees</p>
        ) : (
          (assignees ?? []).map((a: any) => (
            <div key={a.id} className="flex items-center gap-2 rounded-md bg-slate-50 px-2 py-1.5 group">
              <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-600 text-[9px] font-semibold flex items-center justify-center">
                {(a.user?.firstName?.[0] ?? '') + (a.user?.lastName?.[0] ?? '')}
              </div>
              <span className="flex-1 text-[12px] text-slate-700">{a.user?.firstName} {a.user?.lastName}</span>
              {a.role && <span className="text-[10px] text-slate-400">({a.role})</span>}
              <button
                onClick={() => removeMutation.mutate(a.user?.id)}
                aria-label={`Remove ${a.user?.firstName ?? 'assignee'}`}
                className="opacity-60 group-hover:opacity-100 rounded p-1.5 text-slate-500 hover:text-red-600 hover:bg-red-50 transition-opacity">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TaskDetailsTab({ task, onUpdate }: { task: any; onUpdate: (field: string, value: any) => void }) {
  const dueDateValue = task.endDate ? String(task.endDate).slice(0, 10) : '';
  // Permission-gated due-date editing. Workers without tasks:write see the
  // value but can't change it — managers (admin or anyone with the write
  // permission) get the editable input. Display label stays consistent
  // either way so the layout doesn't jump between users.
  const { can, isAdmin } = usePermissions();
  const canEditDueDate = isAdmin || can('tasks', 'write');
  return (
    <div className="space-y-4">
      {/* Project Info leads the tab — the parent project's metadata is the
          primary content here. */}
      {task.projectId && <TaskProjectInfoBlock projectId={task.projectId} />}

      {/* Editable Due Date — gated on tasks:write. Without permission, we
          render a read-only span so users can still SEE the due date but
          can't change it. */}
      <div className="flex items-center gap-2">
        <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider w-20 shrink-0">Due Date</label>
        {canEditDueDate ? (
          <input
            type="date"
            key={`due-${task.id}-${dueDateValue}`}
            defaultValue={dueDateValue}
            onBlur={(e) => {
              const v = e.target.value;
              // Empty → null (clear the date). Otherwise pass the ISO yyyy-mm-dd
              // through unchanged; the API's @IsDateString accepts it as-is.
              if (v !== dueDateValue) onUpdate('endDate', v || null);
            }}
            className="rounded-md border border-slate-200 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none"
          />
        ) : (
          <span className="text-sm text-slate-700">
            {dueDateValue || <span className="text-slate-400 italic">no due date</span>}
          </span>
        )}
      </div>

      <AssigneeManager taskId={task.id} assignees={task.assignees} />

      {/* Checklist (todo) — added per the BM mapping meeting decision that
          personal-task style items belong INSIDE the task, not as separate
          tasks. No due date, no hours. Renders inside the Details tab so
          the assignee + dates context is visible right above. */}
      <TaskChecklist taskId={task.id} />

      <div className="grid grid-cols-2 gap-3 text-[12px]">
        {/* Zone row: name for zoned tasks, explicit "Project Root" for
            zoneId=null tasks so the drawer doesn't silently hide the
            zone information (which made it look like a field was just
            missing rather than intentionally unscoped). */}
        <div>
          <span className="text-slate-400">Zone:</span>{' '}
          {task.zone ? (
            <span className="text-slate-700 font-medium">{task.zone.name}</span>
          ) : (
            <span className="text-slate-500 italic">Project Root</span>
          )}
        </div>
        {task.phase && <div><span className="text-slate-400">Service:</span> <span className="text-slate-700 font-medium">{task.phase.name}</span></div>}
        {task.serviceType && <div><span className="text-slate-400">Deliverable:</span> <span className="text-slate-700 font-medium">{task.serviceType.name}</span></div>}
      </div>
    </div>
  );
}

function TaskProjectInfoBlock({ projectId }: { projectId: number }) {
  const { data: project, isLoading } = useQuery({
    queryKey: ['project-info-summary', projectId],
    queryFn: () => client.get(`/projects/${projectId}`).then((r) => r.data?.data ?? r.data),
    staleTime: 5 * 60 * 1000,
  });
  if (isLoading) {
    return <div className="rounded-md border border-slate-200 bg-slate-50/60 p-3 text-[12px] text-slate-400">Loading project info…</div>;
  }
  if (!project) return null;

  // Always-rendered list (Z1 follow-up) — the user wants the task card's
  // Project Info to mirror the Project Info tab, so we show every field
  // with an em-dash placeholder rather than hiding empties. Helpers
  // resolve URL fields into click-throughs.
  const fmtVal = (v?: string | null) => (v && v.trim() ? v : null);
  const fields: Array<{ label: string; value: string | null; isLink?: boolean }> = [
    { label: 'Weekly Meeting', value: fmtVal(project.weeklyMeetingDay) },
    { label: 'Authoring Tool', value: fmtVal(project.authoringToolVersion) },
  ];

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/60 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Project Info</span>
        <Link to={`/projects/${projectId}`} className="text-[10px] text-blue-600 hover:underline">
          Open project →
        </Link>
      </div>
      <dl className="space-y-1 text-[12px]">
        <div className="flex gap-2">
          <dt className="text-slate-500 w-[110px] shrink-0">Project:</dt>
          <dd className="text-slate-700 font-medium break-words min-w-0">{project.name}</dd>
        </div>
        {fields.map((f) => (
          <div key={f.label} className="flex gap-2">
            <dt className="text-slate-500 w-[110px] shrink-0">{f.label}:</dt>
            <dd className="text-slate-700 break-words min-w-0">
              {f.value == null ? (
                <span className="text-slate-300 italic">—</span>
              ) : f.isLink ? (
                // The hub field can hold multiple "Label | URL" lines.
                // Render each on its own row; linkify URLs.
                f.value.split('\n').map((line, i) => {
                  const trimmed = line.trim();
                  if (!trimmed) return null;
                  const sep = trimmed.indexOf('|');
                  const label = sep >= 0 ? trimmed.slice(0, sep).trim() : '';
                  const url = sep >= 0 ? trimmed.slice(sep + 1).trim() : trimmed;
                  return (
                    <div key={i}>
                      {label && <span className="text-slate-500">{label}: </span>}
                      {/^https?:\/\//.test(url)
                        ? <a href={url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline break-all">{url}</a>
                        : <span className="break-all">{url}</span>}
                    </div>
                  );
                })
              ) : f.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 pt-2 border-t border-slate-200">
        <span className="text-[10px] text-slate-500 uppercase tracking-wider">Services Per Contract</span>
        <p className="text-[12px] text-slate-600 mt-1 whitespace-pre-wrap">
          {project.servicesPerContract?.trim() || <span className="text-slate-300 italic">—</span>}
        </p>
      </div>
    </div>
  );
}

function TaskTimeTab({ taskId }: { taskId: number }) {
  const { data: entries = [], isLoading } = useQuery({
    queryKey: queryKeys.time.entriesByTask(taskId),
    queryFn: () => client.get('/time-entries', { params: { taskId } }).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
  });

  const list = entries as any[];
  const totalMinutes = list.reduce((s: number, e: any) => s + (e.minutes ?? 0), 0);
  const billableMinutes = list.filter((e: any) => e.isBillable).reduce((s: number, e: any) => s + (e.minutes ?? 0), 0);

  return (
    <div className="space-y-4">
      <TimeEntryForm taskId={taskId} variant="full" />

      {/* Reporting history — every entry the current user has logged on
          this task, newest first. Surfaces the full picture (not just
          today's entry) so users can verify what they've already
          reported. Server-side, the /time-entries route is scoped to
          the caller's userId, so this is *your* reporting only. */}
      <div className="rounded-md border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-slate-400" />
            <span className="text-[12px] font-semibold text-slate-700">Your reporting history</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] tabular-nums">
            <span className="text-slate-500">
              {list.length} {list.length === 1 ? 'entry' : 'entries'}
            </span>
            <span className="text-slate-700 font-bold">
              {(totalMinutes / 60).toFixed(2)}h
            </span>
            {billableMinutes !== totalMinutes && (
              <span className="text-slate-400">
                ({(billableMinutes / 60).toFixed(2)}h billable)
              </span>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="px-3 py-6 text-center text-[12px] text-slate-400">Loading entries…</div>
        ) : list.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-slate-400 italic">
            No entries yet — use the form above to log your first.
          </div>
        ) : (
          <div className="max-h-[360px] overflow-y-auto divide-y divide-slate-100">
            {list.map((e: any) => (
              <TimeEntryRow key={e.id} entry={e} taskId={taskId} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Single time-entry row with inline edit + delete. Edit replaces the
 * read-only display with date/start/end/note inputs and a save button.
 * Delete asks for confirmation (we don't want a single misclick to
 * wipe an hour of reported work).
 */
function TimeEntryRow({ entry, taskId }: { entry: any; taskId: number }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [date, setDate] = useState((entry.date ?? '').split('T')[0]);
  const [start, setStart] = useState(entry.startTime ?? '09:00');
  const [end, setEnd] = useState(entry.endTime ?? '10:00');
  const [note, setNote] = useState(entry.note ?? '');

  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const editingMinutes = Math.max(0, (eh * 60 + em) - (sh * 60 + sm));

  const updateMutation = useMutation({
    mutationFn: () => timeApi.updateEntry(entry.id, {
      date,
      startTime: start,
      endTime: end,
      minutes: editingMinutes,
      note: note.trim() || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.time.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.time.entriesByTask(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.mine() });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      notify.success('Entry updated', { code: 'TIME-EDIT-200' });
      setEditing(false);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update entry'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => timeApi.deleteEntry(entry.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.time.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.time.entriesByTask(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.mine() });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      notify.success('Entry deleted', { code: 'TIME-DEL-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete entry'),
  });

  if (editing) {
    return (
      <div className="px-3 py-2 bg-blue-50/40 space-y-1.5">
        <div className="flex items-center gap-2">
          <input type="date" value={date} onChange={(ev) => setDate(ev.target.value)}
            className="rounded border border-slate-200 px-1.5 py-1 text-[11px] focus:border-blue-400 focus:outline-none" />
          <input type="time" step="300" value={start} onChange={(ev) => setStart(ev.target.value)}
            className="w-[82px] rounded border border-slate-200 px-1.5 py-1 text-[11px] focus:border-blue-400 focus:outline-none" />
          <span className="text-slate-400 text-[10px]">→</span>
          <input type="time" step="300" value={end} onChange={(ev) => setEnd(ev.target.value)}
            className="w-[82px] rounded border border-slate-200 px-1.5 py-1 text-[11px] focus:border-blue-400 focus:outline-none" />
          <span className="ml-auto text-[11px] font-bold text-blue-600 tabular-nums">
            {(editingMinutes / 60).toFixed(2)}h
          </span>
        </div>
        <input type="text" value={note} onChange={(ev) => setNote(ev.target.value)}
          placeholder="Note (optional)…"
          className="w-full rounded border border-slate-200 px-1.5 py-1 text-[11px] focus:border-blue-400 focus:outline-none" />
        <div className="flex items-center gap-1.5">
          <button onClick={() => updateMutation.mutate()}
            disabled={editingMinutes <= 0 || updateMutation.isPending}
            className="rounded bg-blue-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {updateMutation.isPending ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => setEditing(false)}
            disabled={updateMutation.isPending}
            className="rounded px-2 py-0.5 text-[11px] font-semibold text-slate-500 hover:bg-slate-100">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-3 px-3 py-2 text-[12px] hover:bg-slate-50/60">
      <span className="text-slate-600 tabular-nums w-[78px] shrink-0">
        {entry.date ? formatDate(entry.date.split('T')[0]) : '—'}
      </span>
      <span className="text-slate-500 tabular-nums w-[90px] shrink-0">
        {entry.startTime && entry.endTime ? `${entry.startTime} – ${entry.endTime}` : ''}
      </span>
      <span className="font-semibold text-slate-700 tabular-nums w-[42px] shrink-0">
        {((entry.minutes ?? 0) / 60).toFixed(2)}h
      </span>
      {entry.note && (
        <span className="text-slate-600 truncate flex-1" title={entry.note}>
          {entry.note}
        </span>
      )}
      {!entry.note && <span className="flex-1" />}
      {confirmingDelete ? (
        <span className="flex items-center gap-1.5">
          <button
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            className="rounded bg-red-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-700 disabled:opacity-50"
            aria-label="Confirm delete entry"
          >
            {deleteMutation.isPending ? '…' : 'Delete'}
          </button>
          <button
            onClick={() => setConfirmingDelete(false)}
            disabled={deleteMutation.isPending}
            className="text-[10px] text-slate-500 hover:text-slate-700"
          >
            Cancel
          </button>
        </span>
      ) : (
        <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => setEditing(true)}
            className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
            aria-label="Edit entry"
            title="Edit"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            onClick={() => setConfirmingDelete(true)}
            className="rounded p-1 text-slate-400 hover:bg-red-100 hover:text-red-600"
            aria-label="Delete entry"
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </span>
      )}
    </div>
  );
}

function TaskDiscussionTab({ taskId }: { taskId: number }) {
  return <MessagePanel entityType="task" entityId={taskId} />;
}
