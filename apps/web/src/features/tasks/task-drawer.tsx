import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { X, Clock, Paperclip, MessageSquare, UserPlus, ChevronDown, Search, Trash2, AlertCircle, AlertTriangle, Calendar, FileText, Pencil, Send, Check, RotateCcw } from 'lucide-react';
import client from '@/api/client';
import { NavLinkWithReturn } from '@/components/nav/return-route';
import { TaskFilesTab } from '@/features/tasks/task-files-tab';
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
import { useConfirm } from '@/components/shared/confirm-dialog';
// Shared with the Modal shell so both surfaces enforce the same
// WCAG 2.2 AA tab-trap semantics.
import { useFocusTrap } from '@/components/shared/use-focus-trap';

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

type TabKey = 'time' | 'details' | 'files' | 'discussion';
const VALID_TABS: TabKey[] = ['time', 'details', 'files', 'discussion'];
function parseTab(raw: string | null, hideTimeTab: boolean): TabKey | null {
  if (!raw || !VALID_TABS.includes(raw as TabKey)) return null;
  // 'time' isn't valid when the Time tab is hidden.
  if (raw === 'time' && hideTimeTab) return null;
  return raw as TabKey;
}

const statusColors: Record<string, string> = {
  not_started: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300', in_progress: 'bg-blue-100 text-blue-700',
  in_review: 'bg-violet-100 text-violet-700', completed: 'bg-emerald-100 text-emerald-700',
  on_hold: 'bg-amber-100 text-amber-700', cancelled: 'bg-red-100 text-red-700',
};

const priorityColors: Record<string, string> = {
  low: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300', medium: 'bg-blue-100 text-blue-700',
  high: 'bg-amber-100 text-amber-700', critical: 'bg-red-100 text-red-700',
};

export function TaskDrawer({ taskId, onClose, hideTimeTab = false }: TaskDrawerProps) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  // Default to "details" when the Time tab is hidden, since "time" wouldn't
  // be a valid choice. Otherwise keep the previous default ("time") so the
  // worker-facing flow lands on the time-entry form as it always has.
  const defaultTab: TabKey = hideTimeTab ? 'details' : 'time';
  // Initialize the active tab from the URL (?tab=...) so a deep link
  // like /path?task=42&tab=files opens the drawer already on Files.
  // Ignore malformed / disallowed values and fall through to the default.
  const [tab, setTabState] = useState<TabKey>(
    () => parseTab(searchParams.get('tab'), hideTimeTab) ?? defaultTab,
  );
  const drawerRef = useRef<HTMLDivElement>(null);

  const { data: task, isLoading } = useQuery({
    queryKey: queryKeys.tasks.detail(taskId!),
    queryFn: () => tasksApi.get(taskId!),
    enabled: !!taskId,
  });

  // Persist the tab in the URL so back / refresh / outbound-return
  // (see NavLinkWithReturn) restore the same tab, and remove the param
  // when the tab is the default so the URL stays clean.
  const setTab = useCallback((next: TabKey) => {
    setTabState(next);
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next === defaultTab) p.delete('tab');
      else p.set('tab', next);
      return p;
    }, { replace: true });
  }, [defaultTab, setSearchParams]);

  // Reset the tab when the drawer switches from one task to another so
  // the previous task's tab (e.g. Files) doesn't carry over. Also fires
  // on close (taskId → null) so re-opening a fresh drawer starts on the
  // default tab.
  //
  // NB — first mount (prev === current) is a no-op, so the useState
  // initializer's URL-derived value survives for real deep links like
  // /path?task=42&tab=files. Subsequent task changes forcibly land on
  // the default AND drop the stale ?tab= param — otherwise a leftover
  // ?tab=files from the previous task would silently keep the URL out
  // of sync with the just-reset state.
  //
  // Guarded by a ref so this fires only on ACTUAL taskId transitions,
  // not every re-render.
  const prevTaskId = useRef(taskId);
  useEffect(() => {
    if (prevTaskId.current === taskId) return;
    prevTaskId.current = taskId;
    setTabState(defaultTab);
    setSearchParams((prev) => {
      if (!prev.has('tab')) return prev;
      const p = new URLSearchParams(prev);
      p.delete('tab');
      return p;
    }, { replace: true });
  }, [taskId, defaultTab, setSearchParams]);

  // Focus the drawer on open + restore focus on close. Tab-trap is
  // delegated to useFocusTrap (shared with the Modal shell) so a Tab
  // press inside the drawer wraps to the first/last focusable instead
  // of leaking focus to the page underneath.
  useEffect(() => {
    if (!taskId) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => drawerRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      try { prevFocus?.focus?.(); } catch { /* trigger may have unmounted */ }
    };
  }, [taskId]);

  useFocusTrap(!!taskId, drawerRef);

  // Escape closes the drawer — but NOT when focus is inside an inline
  // sub-editor (due-date, assignee search, time-entry inputs, review
  // reason, etc.). Otherwise pressing Escape to cancel a field wipes
  // the whole drawer, which is jarring and destroys unsaved work. The
  // sub-editor's own onKeyDown handles the field-level Escape; we
  // simply yield the keystroke to it.
  useEffect(() => {
    if (!taskId) return;
    const isFieldEditor = (el: Element | null): boolean => {
      if (!el || !(el instanceof HTMLElement)) return false;
      // Only elements INSIDE this drawer count — a stray focused input
      // on the page underneath shouldn't block the drawer's Escape.
      if (drawerRef.current && !drawerRef.current.contains(el)) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    };
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isFieldEditor(document.activeElement)) return;
      onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
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
        className="fixed inset-y-0 right-0 z-50 w-[520px] max-w-[90vw] bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-700 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200 focus:outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 px-5 py-4">
          <h2 id="task-drawer-title" className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
            {isLoading ? 'Loading...' : (task as any)?.name || 'Task'}
          </h2>
          <button onClick={onClose} className="rounded-md p-2 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close task drawer">
            <X className="h-4 w-4" />
          </button>
        </div>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-400 dark:text-slate-500">Loading task...</div>
        ) : !task ? (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-400 dark:text-slate-500">Task not found</div>
        ) : (
          <>
            {/* Task code + quick status */}
            <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
              {(task as any).code && <span className="font-mono text-[11px] text-slate-400 dark:text-slate-500">{(task as any).code}</span>}
              <StatusSelect
                currentStatus={(task as any).status}
                onChange={(s) => updateTask.mutate({ field: 'status', value: s })}
              />
              <select aria-label="Task priority" value={(task as any).priority} onChange={(e) => updateTask.mutate({ field: 'priority', value: e.target.value })}
                className={cn('rounded-[5px] px-2 py-0.5 text-[11px] font-bold border-0 cursor-pointer focus:outline-none', priorityColors[(task as any).priority] || priorityColors.medium)}>
                {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
              </select>
            </div>

            {/* Review actions (Tier D #2a) — Submit / Approve / Return.
                Rendered contextually based on the task's current status
                and its requiresReview flag. */}
            <ReviewActions task={task as any} />

            {/* Health banner */}
            <TaskHealthBanner
              task={task}
              onUpdateDueDate={(value) => updateTask.mutate({ field: 'endDate', value })}
            />

            {/* Tabs — Time is hidden when this drawer is opened from a
                manager-facing surface (e.g. the project Kanban) so logging
                hours on behalf of the team isn't even an option. */}
            <div className="flex border-b border-slate-200 dark:border-slate-700 px-5">
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
                    tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200')}>
                  {t.icon && <t.icon className="h-3 w-3" />}
                  {t.label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {tab === 'details' && <TaskDetailsTab task={task as any} onUpdate={(f, v) => updateTask.mutate({ field: f, value: v })} />}
              {tab === 'time' && !hideTimeTab && <TaskTimeTab taskId={taskId!} />}
              {tab === 'files' && (
                <TaskFilesTab
                  taskId={taskId!}
                  projectId={(task as any).projectId}
                  backLabel={(task as any)?.code ? `task ${(task as any).code}` : `task #${taskId}`}
                />
              )}
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

function TaskHealthBanner({ task, onUpdateDueDate }: { task: any; onUpdateDueDate: (value: string | null) => void }) {
  const health = getTaskHealth(task);
  if (health.level === 'ok' && health.reasons.length === 0) {
    return (
      <div className="px-5 py-2.5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 flex items-center gap-4 text-[11px] text-slate-600 dark:text-slate-300">
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" /> {health.loggedHours}h / {health.estimatedHours}h
        </span>
        <span className="tabular-nums font-semibold text-blue-600">{health.computedPct}% complete</span>
        <span className="ml-auto"><DueDateChip task={task} onUpdate={onUpdateDueDate} /></span>
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
        <div className="mt-1 flex items-center gap-3 text-[11px] text-slate-600 dark:text-slate-300">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" /> {health.loggedHours}h / {health.estimatedHours}h
          </span>
          <span className="tabular-nums font-semibold">{health.computedPct}% complete</span>
          <DueDateChip task={task} onUpdate={onUpdateDueDate} />
        </div>
      </div>
    </div>
  );
}

/**
 * Inline-editable due-date chip. Click to edit when the user has
 * permission (admin OR tasks:write OR tasks:edit-due-date); otherwise
 * it's a read-only span. Saves on blur or Enter, cancels on Escape.
 *
 * The "tasks:edit-due-date" check is the requested fine-grained
 * authorization hook — an admin can grant exactly this without giving
 * the full tasks:write power. Falls back to tasks:write so existing
 * roles keep working unchanged.
 */
function DueDateChip({ task, onUpdate }: { task: any; onUpdate: (value: string | null) => void }) {
  const { can, isAdmin } = usePermissions();
  const canEdit = isAdmin || can('tasks', 'write') || can('tasks/edit-due-date', 'write');
  const [editing, setEditing] = useState(false);
  const dueDateValue = task.endDate ? String(task.endDate).slice(0, 10) : '';

  if (!task.endDate && !canEdit) return null;

  if (editing && canEdit) {
    return (
      <input
        type="date"
        autoFocus
        defaultValue={dueDateValue}
        onBlur={(e) => {
          // Browsers return "" from <input type=date> when the typed value
          // didn't parse to a valid YYYY-MM-DD (e.g. user typed "17/06/26"
          // or any non-ISO format). Treating that empty as "user wants to
          // clear" silently destroyed the existing due date — see #52.
          // Now: only commit a value that LOOKS valid; if the field went
          // empty but we had a date, ignore the blur and keep what we had.
          // Explicit clearing happens via the ✕ button on the chip below.
          const v = e.target.value;
          const isValid = /^\d{4}-\d{2}-\d{2}$/.test(v);
          if (isValid && v !== dueDateValue) onUpdate(v);
          // empty string + had a date → assume parse failure, ignore.
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.currentTarget.value = dueDateValue; setEditing(false); }
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        }}
        className="rounded border border-blue-300 bg-white dark:bg-slate-900 px-1.5 py-0.5 text-[11px] focus:outline-none focus:border-blue-500"
      />
    );
  }

  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => canEdit && setEditing(true)}
        disabled={!canEdit}
        className={cn(
          'inline-flex items-center gap-1 rounded px-1 py-0.5',
          canEdit ? 'hover:bg-white/60 dark:hover:bg-slate-900/60 cursor-pointer' : 'cursor-default',
        )}
        title={canEdit ? 'Click to change due date' : ''}
      >
        <Calendar className="h-3 w-3" />
        {task.endDate ? formatDate(task.endDate.split('T')[0]) : (
          <span className="italic text-slate-400 dark:text-slate-500">set due date</span>
        )}
        {/* Pencil affordance — shows the field is editable. #53. Permission-
            gated via canEdit above (button is disabled when not allowed). */}
        {canEdit && (
          <Pencil className="h-2.5 w-2.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
        )}
      </button>
      {/* Explicit clear button — replaces the "blur with empty value clears
          the date" path that was silently wiping data on bad input. Only
          shown when there IS a date to clear and the user has permission. */}
      {canEdit && task.endDate && (
        <button
          type="button"
          onClick={async () => {
            if (await confirm('Clear due date?')) onUpdate(null);
          }}
          className="p-0.5 rounded text-slate-300 dark:text-slate-600 hover:text-red-500 hover:bg-red-50"
          title="Clear due date"
          aria-label="Clear due date"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
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
        {/* Header was previously slate-400 ("Assignees") — too low-contrast,
            and users couldn't tell whether the block belonged to the task
            or to the project (#55). Bumped to readable weight and renamed
            to "Assigned to this task" so the scope is unambiguous. */}
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200">
            Assigned to this task
          </label>
          <p className="text-[10.5px] text-slate-500 dark:text-slate-400 leading-tight">
            People responsible for completing this task.
          </p>
        </div>
        <button onClick={() => setShowPicker(!showPicker)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-blue-600 hover:bg-blue-50">
          <UserPlus className="h-3 w-3" /> Assign
        </button>
      </div>

      {showPicker && (
        <div className="mt-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
          <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 px-2.5 py-2">
            <Search className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people..."
              className="flex-1 bg-transparent text-[12px] outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500" autoFocus />
          </div>
          <div className="max-h-32 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-slate-400 dark:text-slate-500">No users found</p>
            ) : (
              filtered.slice(0, 10).map((u: any) => (
                <button key={u.id} onClick={() => addMutation.mutate(u.id)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <div className="w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-[8px] font-semibold flex items-center justify-center">
                    {(u.firstName?.[0] ?? '')}{(u.lastName?.[0] ?? '')}
                  </div>
                  <span className="text-slate-700 dark:text-slate-200">{u.firstName} {u.lastName}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <div className="mt-1.5 space-y-1">
        {(assignees ?? []).length === 0 && !showPicker ? (
          <p className="text-[12px] text-slate-400 dark:text-slate-500 italic">No assignees</p>
        ) : (
          (assignees ?? []).map((a: any) => (
            <div key={a.id} className="flex items-center gap-2 rounded-md bg-slate-50 dark:bg-slate-800/50 px-2 py-1.5 group">
              <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-600 text-[9px] font-semibold flex items-center justify-center">
                {(a.user?.firstName?.[0] ?? '') + (a.user?.lastName?.[0] ?? '')}
              </div>
              <span className="flex-1 text-[12px] text-slate-700 dark:text-slate-200">{a.user?.firstName} {a.user?.lastName}</span>
              {a.role && <span className="text-[10px] text-slate-400 dark:text-slate-500">({a.role})</span>}
              <button
                onClick={() => removeMutation.mutate(a.user?.id)}
                aria-label={`Remove ${a.user?.firstName ?? 'assignee'}`}
                className="opacity-60 group-hover:opacity-100 rounded p-1.5 text-slate-500 dark:text-slate-400 hover:text-red-600 hover:bg-red-50 transition-opacity">
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
  // Permission-gated due-date editing. Three accepted sources:
  //   - Admin (roleId=1) — always
  //   - tasks:write — general edit power
  //   - tasks/edit-due-date:write — the new fine-grained option requested
  //     2026-06-17, lets an admin grant exactly "can change due dates"
  //     without handing out full tasks:write.
  // First match wins; matching against either keeps existing roles
  // working with no migration needed.
  const { can, isAdmin } = usePermissions();
  const canEditDueDate = isAdmin || can('tasks', 'write') || can('tasks/edit-due-date', 'write');
  return (
    <div className="space-y-4">
      {/* Project Info leads the tab — the parent project's metadata is the
          primary content here. */}
      {task.projectId && (
        <TaskProjectInfoBlock
          projectId={task.projectId}
          backLabel={task.code ? `task ${task.code}` : `task #${task.id}`}
        />
      )}

      {/* Deliverable target date (Tier E #10). Resolved from the
          (zone × deliverable) target set on the Deliverable Planning
          screen; falls back to the deliverable-level target. Read-only
          here — the Deliverable Planning tab is where PMs edit it.
          The task's own Due Date below can differ (assignee or manager
          overrides), and if it does we show a small "manually set"
          indicator so the user knows the two aren't tied anymore. */}
      <DeliverableTargetRow task={task} />

      {/* Editable Due Date — gated on tasks:write. Without permission, we
          render a read-only span so users can still SEE the due date but
          can't change it. */}
      <div className="flex items-center gap-2">
        <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider w-20 shrink-0">Due Date</label>
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
            className="rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none"
          />
        ) : (
          <span className="text-sm text-slate-700 dark:text-slate-200">
            {dueDateValue || <span className="text-slate-400 dark:text-slate-500 italic">no due date</span>}
          </span>
        )}
        {task.dueDateOverridden && (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5" title="This date was manually set and won't be overwritten by Deliverable target changes">
            manually set
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
          <span className="text-slate-400 dark:text-slate-500">Zone:</span>{' '}
          {task.zone ? (
            <span className="text-slate-700 dark:text-slate-200 font-medium">{task.zone.name}</span>
          ) : (
            <span className="text-slate-500 dark:text-slate-400 italic">Project Root</span>
          )}
        </div>
        {task.phase && <div><span className="text-slate-400 dark:text-slate-500">Service:</span> <span className="text-slate-700 dark:text-slate-200 font-medium">{task.phase.name}</span></div>}
        {task.serviceType && <div><span className="text-slate-400 dark:text-slate-500">Deliverable:</span> <span className="text-slate-700 dark:text-slate-200 font-medium">{task.serviceType.name}</span></div>}
      </div>
    </div>
  );
}

function TaskProjectInfoBlock({ projectId, backLabel }: { projectId: number; backLabel: string }) {
  const { data: project, isLoading } = useQuery({
    queryKey: ['project-info-summary', projectId],
    queryFn: () => client.get(`/projects/${projectId}`).then((r) => r.data?.data ?? r.data),
    staleTime: 5 * 60 * 1000,
  });
  if (isLoading) {
    return <div className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 p-3 text-[12px] text-slate-400 dark:text-slate-500">Loading project info…</div>;
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
    <div className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Project Info</span>
        <NavLinkWithReturn
          to={`/projects/${projectId}`}
          returnLabel={backLabel}
          className="text-[10px] text-blue-600 hover:underline"
        >
          Open project →
        </NavLinkWithReturn>
      </div>
      <dl className="space-y-1 text-[12px]">
        <div className="flex gap-2">
          <dt className="text-slate-500 dark:text-slate-400 w-[110px] shrink-0">Project:</dt>
          <dd className="text-slate-700 dark:text-slate-200 font-medium break-words min-w-0">{project.name}</dd>
        </div>
        {/* BIM Leader — resolved from the project_partner_roles row with
            role.code = bim_leader (see projects.service.findOne). Shown
            here per user feedback 2026-06-22 — task owners need to know
            who owns BIM for the project without digging into the team
            tab. Falls back to em-dash when unassigned. */}
        <div className="flex gap-2">
          <dt className="text-slate-500 dark:text-slate-400 w-[110px] shrink-0">BIM Leader:</dt>
          <dd className="text-slate-700 dark:text-slate-200 break-words min-w-0">
            {project.bimLeader ? (
              `${project.bimLeader.firstName ?? ''} ${project.bimLeader.lastName ?? ''}`.trim() || (
                <span className="text-slate-300 dark:text-slate-600 italic">—</span>
              )
            ) : (
              <span className="text-slate-300 dark:text-slate-600 italic">—</span>
            )}
          </dd>
        </div>
        {fields.map((f) => (
          <div key={f.label} className="flex gap-2">
            <dt className="text-slate-500 dark:text-slate-400 w-[110px] shrink-0">{f.label}:</dt>
            <dd className="text-slate-700 dark:text-slate-200 break-words min-w-0">
              {f.value == null ? (
                <span className="text-slate-300 dark:text-slate-600 italic">—</span>
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
                      {label && <span className="text-slate-500 dark:text-slate-400">{label}: </span>}
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
      <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-700">
        <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider">Services Per Contract</span>
        <p className="text-[12px] text-slate-600 dark:text-slate-300 mt-1 whitespace-pre-wrap">
          {project.servicesPerContract?.trim() || <span className="text-slate-300 dark:text-slate-600 italic">—</span>}
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
      <div className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
            <span className="text-[12px] font-semibold text-slate-700 dark:text-slate-200">Your reporting history</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] tabular-nums">
            <span className="text-slate-500 dark:text-slate-400">
              {list.length} {list.length === 1 ? 'entry' : 'entries'}
            </span>
            <span className="text-slate-700 dark:text-slate-200 font-bold">
              {(totalMinutes / 60).toFixed(2)}h
            </span>
            {billableMinutes !== totalMinutes && (
              <span className="text-slate-400 dark:text-slate-500">
                ({(billableMinutes / 60).toFixed(2)}h billable)
              </span>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="px-3 py-6 text-center text-[12px] text-slate-400 dark:text-slate-500">Loading entries…</div>
        ) : list.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-slate-400 dark:text-slate-500 italic">
            No entries yet — use the form above to log your first.
          </div>
        ) : (
          <div className="max-h-[360px] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
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
            className="rounded border border-slate-200 dark:border-slate-700 px-1.5 py-1 text-[11px] focus:border-blue-400 focus:outline-none" />
          <input type="time" step="300" value={start} onChange={(ev) => setStart(ev.target.value)}
            className="w-[82px] rounded border border-slate-200 dark:border-slate-700 px-1.5 py-1 text-[11px] focus:border-blue-400 focus:outline-none" />
          <span className="text-slate-400 dark:text-slate-500 text-[10px]">→</span>
          <input type="time" step="300" value={end} onChange={(ev) => setEnd(ev.target.value)}
            className="w-[82px] rounded border border-slate-200 dark:border-slate-700 px-1.5 py-1 text-[11px] focus:border-blue-400 focus:outline-none" />
          <span className="ml-auto text-[11px] font-bold text-blue-600 tabular-nums">
            {(editingMinutes / 60).toFixed(2)}h
          </span>
        </div>
        <input type="text" value={note} onChange={(ev) => setNote(ev.target.value)}
          placeholder="Note (optional)…"
          className="w-full rounded border border-slate-200 dark:border-slate-700 px-1.5 py-1 text-[11px] focus:border-blue-400 focus:outline-none" />
        <div className="flex items-center gap-1.5">
          <button onClick={() => updateMutation.mutate()}
            disabled={editingMinutes <= 0 || updateMutation.isPending}
            className="rounded bg-blue-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {updateMutation.isPending ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => setEditing(false)}
            disabled={updateMutation.isPending}
            className="rounded px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-3 px-3 py-2 text-[12px] hover:bg-slate-50/60 dark:hover:bg-slate-800/60">
      <span className="text-slate-600 dark:text-slate-300 tabular-nums w-[78px] shrink-0">
        {entry.date ? formatDate(entry.date.split('T')[0]) : '—'}
      </span>
      <span className="text-slate-500 dark:text-slate-400 tabular-nums w-[90px] shrink-0">
        {entry.startTime && entry.endTime ? `${entry.startTime} – ${entry.endTime}` : ''}
      </span>
      <span className="font-semibold text-slate-700 dark:text-slate-200 tabular-nums w-[42px] shrink-0">
        {((entry.minutes ?? 0) / 60).toFixed(2)}h
      </span>
      {entry.note && (
        <span className="text-slate-600 dark:text-slate-300 truncate flex-1" title={entry.note}>
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
            className="text-[10px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100"
          >
            Cancel
          </button>
        </span>
      ) : (
        <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => setEditing(true)}
            className="rounded p-1 text-slate-400 dark:text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-100"
            aria-label="Edit entry"
            title="Edit"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            onClick={() => setConfirmingDelete(true)}
            className="rounded p-1 text-slate-400 dark:text-slate-500 hover:bg-red-100 hover:text-red-600"
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

/**
 * Deliverable target date, read from the parent project's deliverable
 * list (via /project-deliverables?projectId=X). Prefers the
 * (zone × deliverable) target when the task has a zoneId; otherwise
 * falls back to the deliverable-level target. Renders nothing if the
 * task isn't linked to a Deliverable at all. (Tier E #10, 2026-08-02.)
 */
function DeliverableTargetRow({ task }: { task: any }) {
  const projectId = task?.projectId;
  const deliverableId = task?.projectDeliverableId;
  const { data: deliverables } = useQuery<any[]>({
    queryKey: ['project-deliverables', projectId],
    enabled: !!projectId && !!deliverableId,
    queryFn: () =>
      client
        .get('/project-deliverables', { params: { projectId } })
        .then((r) => {
          const d = r.data?.data ?? r.data;
          return Array.isArray(d) ? d : [];
        }),
    staleTime: 30 * 1000,
  });

  if (!deliverableId) return null;
  const d = deliverables?.find((x) => x.id === deliverableId);
  if (!d) return null;
  const zoneTarget = task.zoneId != null ? d.zoneTargets?.find((zt: any) => zt.zoneId === task.zoneId) : null;
  const targetDate = zoneTarget?.targetDate ?? d.targetDate ?? null;
  const dateStr = targetDate ? String(targetDate).slice(0, 10) : null;

  return (
    <div className="flex items-center gap-2">
      <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider w-20 shrink-0">Deliverable</label>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-slate-700 dark:text-slate-200 font-medium">{d.name}</span>
        {dateStr ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 tabular-nums" title={zoneTarget ? `Zone × Deliverable target` : 'Deliverable-level target'}>
            {dateStr}
          </span>
        ) : (
          <span className="text-slate-400 dark:text-slate-500 italic text-[12px]">no target set</span>
        )}
      </div>
    </div>
  );
}

/**
 * ReviewActions (Tier D #2a, 2026-06-30)
 *
 * Contextual review controls shown right below the drawer's status
 * pill. Renders different buttons depending on where the task sits
 * in its review lifecycle:
 *   - not_started / in_progress + requiresReview  → "Submit for review"
 *   - in_review                                    → "Approve" + "Return with reason"
 *   - anything else                                → nothing
 *
 * Each click POSTs /tasks/:id/review; the server flips the status +
 * appends a task_review_events row. On success we invalidate the task
 * + review-history queries so the drawer re-renders with the new
 * status and the history section below picks up the new event.
 */
function ReviewActions({ task }: { task: any }) {
  const queryClient = useQueryClient();
  const [showReturn, setShowReturn] = useState(false);
  const [reason, setReason] = useState('');
  const requiresReview = task?.requiresReview !== false;

  const recordReview = useMutation({
    mutationFn: (body: { action: 'submit' | 'approve' | 'return'; reason?: string }) =>
      client.post(`/tasks/${task.id}/review`, body).then((r) => r.data),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['task', task.id] });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.mine() });
      queryClient.invalidateQueries({ queryKey: ['task-reviews', task.id] });
      const labels: Record<string, string> = {
        submit: 'Task submitted for review',
        approve: 'Task approved',
        return: 'Task returned for revisions',
      };
      notify.success(labels[vars.action] ?? 'Review recorded');
      setShowReturn(false);
      setReason('');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to record review'),
  });

  const status = task?.status;
  // Compute which buttons to show — the API also validates, so this
  // is purely UX (hide illegal actions rather than let the user click
  // and get a red toast).
  const canSubmit = requiresReview && (status === 'not_started' || status === 'in_progress');
  const canDecide = status === 'in_review';

  if (!canSubmit && !canDecide) return null;

  return (
    <div className="px-5 py-2.5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/60 flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mr-1">Review</span>
      {canSubmit && (
        <button
          type="button"
          onClick={() => recordReview.mutate({ action: 'submit' })}
          disabled={recordReview.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-[12px] font-semibold"
          title="Move to In Review — a lead will approve or return it"
        >
          <Send className="h-3 w-3" />
          Submit for review
        </button>
      )}
      {canDecide && !showReturn && (
        <>
          <button
            type="button"
            onClick={() => recordReview.mutate({ action: 'approve' })}
            disabled={recordReview.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-[12px] font-semibold"
          >
            <Check className="h-3 w-3" />
            Approve
          </button>
          <button
            type="button"
            onClick={() => setShowReturn(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-amber-300 text-amber-700 hover:bg-amber-50 text-[12px] font-semibold"
          >
            <RotateCcw className="h-3 w-3" />
            Return for revisions
          </button>
        </>
      )}
      {canDecide && showReturn && (
        <div className="flex-1 flex items-center gap-1.5">
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is it being returned? (required)"
            className="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-[12px] focus:border-blue-500 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && reason.trim()) recordReview.mutate({ action: 'return', reason: reason.trim() });
              if (e.key === 'Escape') { setShowReturn(false); setReason(''); }
            }}
          />
          <button
            type="button"
            onClick={() => reason.trim() && recordReview.mutate({ action: 'return', reason: reason.trim() })}
            disabled={!reason.trim() || recordReview.isPending}
            className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-[12px] font-semibold"
          >
            Return
          </button>
          <button
            type="button"
            onClick={() => { setShowReturn(false); setReason(''); }}
            className="px-2 py-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 text-[12px]"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

