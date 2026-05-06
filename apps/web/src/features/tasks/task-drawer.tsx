import { useState, useEffect, useRef } from 'react';
import { X, Clock, Paperclip, MessageSquare, UserPlus, ChevronDown, Search, Trash2, AlertCircle, AlertTriangle, Calendar, FileText } from 'lucide-react';
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
                { key: 'details' as const, label: 'Details' },
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
        <option key={s} value={s}>{s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>
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
            <Calendar className="h-3 w-3" /> Due {new Date(task.endDate.split('T')[0]).toLocaleDateString()}
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
              <Calendar className="h-3 w-3" /> {new Date(task.endDate.split('T')[0]).toLocaleDateString()}
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
      setShowPicker(false);
      setSearch('');
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
  const inputClass = 'mt-1 w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none';
  const readOnlyClass = 'mt-1 w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-600';
  const fmtDate = (iso?: string | null) => iso ? new Date(iso).toLocaleDateString() : '—';

  return (
    <div className="space-y-4">
      <div>
        <label className="text-[11px] font-semibold text-slate-400 uppercase">Description</label>
        <p className="mt-1 text-[13px] text-slate-600">{task.description || <span className="italic text-slate-400">No description</span>}</p>
      </div>

      {/* Planning fields — read-only here. Edit from the project Planning view. */}
      <div>
        <p className="text-[10px] text-slate-400 mb-1.5 italic">
          Planning data — edit from the Project › Planning view
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase">Est. Hours</label>
            <div className={readOnlyClass}>{task.budgetHours ?? '—'}</div>
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase">Amount</label>
            <div className={readOnlyClass}>{task.budgetAmount ?? '—'}</div>
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase">Due Date</label>
            <div className={readOnlyClass}>{fmtDate(task.endDate)}</div>
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase" htmlFor="td-pct">Completion</label>
            <input id="td-pct" type="number" min="0" max="100" key={`p-${task.id}`} defaultValue={task.completionPct ?? 0}
              onBlur={(e) => onUpdate('completionPct', Number(e.target.value))}
              className={inputClass} />
          </div>
        </div>
      </div>

      <AssigneeManager taskId={task.id} assignees={task.assignees} />

      <div className="grid grid-cols-2 gap-3 text-[12px]">
        {task.zone && <div><span className="text-slate-400">Zone:</span> <span className="text-slate-700 font-medium">{task.zone.name}</span></div>}
        {task.phase && <div><span className="text-slate-400">Service:</span> <span className="text-slate-700 font-medium">{task.phase.name}</span></div>}
        {task.serviceType && <div><span className="text-slate-400">Deliverable:</span> <span className="text-slate-700 font-medium">{task.serviceType.name}</span></div>}
      </div>
    </div>
  );
}

function TaskTimeTab({ taskId }: { taskId: number }) {
  const { data: entries = [] } = useQuery({
    queryKey: queryKeys.time.entriesByTask(taskId),
    queryFn: () => client.get('/time-entries', { params: { taskId } }).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
  });

  const totalMinutes = (entries as any[]).reduce((s: number, e: any) => s + (e.minutes ?? 0), 0);

  return (
    <div className="space-y-4">
      <TimeEntryForm taskId={taskId} variant="full" />

      <div className="text-[12px] text-slate-600">
        Total logged: <span className="font-semibold text-slate-700">{Math.round(totalMinutes / 60 * 10) / 10}h</span>
        {(entries as any[]).length > 0 && <span> ({(entries as any[]).length} entries)</span>}
      </div>

      <div className="space-y-1">
        {(entries as any[]).slice(0, 20).map((e: any) => (
          <div key={e.id} className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-[12px]">
            <span className="text-slate-600">{e.date ? new Date(e.date).toLocaleDateString() : '-'}</span>
            <span className="font-medium text-slate-700">{e.startTime ?? ''}{e.startTime && e.endTime ? ` – ${e.endTime}` : ''}</span>
            <span className="font-semibold text-slate-700">{Math.round((e.minutes ?? 0) / 60 * 10) / 10}h</span>
            {e.note && <span className="text-slate-600 truncate max-w-[150px]">{e.note}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function TaskDiscussionTab({ taskId }: { taskId: number }) {
  return <MessagePanel entityType="task" entityId={taskId} />;
}
