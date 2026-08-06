import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { X, Clock, MessageSquare, Trash2, FileText } from 'lucide-react';
import { TaskFilesTab } from '@/features/tasks/task-files-tab';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { tasksApi } from '@/api/tasks.api';
import { queryKeys } from '@/lib/query-keys';
// Shared colour maps used by <StatusBadge> / <PriorityBadge>. Imported
// here so the drawer's inline <select>s can wear the same coloured
// pill styling without a parallel local map to keep in sync.
import { PRIORITY_COLORS } from '@/lib/constants';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { useDeleteTask } from '@/hooks/use-tasks';
// Shared with the Modal shell so both surfaces enforce the same
// WCAG 2.2 AA tab-trap semantics.
import { useFocusTrap } from '@/components/shared/use-focus-trap';
import { PRIORITY_OPTIONS } from './task-drawer/constants';
import { type TabKey, parseTab } from './task-drawer/types';
import { EditableText } from './task-drawer/editable-fields';
import { StatusSelect } from './task-drawer/status-select';
import { TaskHealthBanner } from './task-drawer/task-health-banner';
import { ReviewActions } from './task-drawer/review-actions';
import { TaskDetailsTab } from './task-drawer/task-details-tab';
import { TaskTimeTab } from './task-drawer/task-time-tab';
import { TaskDiscussionTab } from './task-drawer/task-discussion-tab';

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

// Local statusColors/priorityColors maps deleted — the drawer's
// <select> pills now pull STATUS_COLORS / PRIORITY_COLORS from
// '@/lib/constants' (the same maps <StatusBadge>/<PriorityBadge>
// use), so there's a single source of truth for both the pill
// styling and the badge components used across the app.

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

  // Delete task — ported from the standalone task-detail page so the
  // drawer is now the canonical surface (parity with detail page).
  // Confirm via the shared useConfirm hook (WCAG modal + focus trap).
  const confirmDelete = useConfirm();
  const deleteTask = useDeleteTask();
  const handleDeleteTask = useCallback(async () => {
    if (!taskId) return;
    const ok = await confirmDelete('Delete this task? This cannot be undone.');
    if (!ok) return;
    deleteTask.mutate(taskId, {
      onSuccess: () => {
        notify.success('Task deleted');
        onClose();
      },
    });
  }, [confirmDelete, deleteTask, taskId, onClose]);

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
        {/* Header — editable task name (click to edit) + delete-task
            button. Both ported from the standalone task-detail page so
            the drawer is now the canonical task surface. Delete lives
            here (not in the Details tab) so it's reachable regardless
            of which tab is open, matching the detail page's placement. */}
        <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 px-5 py-4">
          <div id="task-drawer-title" className="flex-1 min-w-0">
            {isLoading ? (
              <span className="text-sm font-bold text-slate-900 dark:text-slate-100">Loading...</span>
            ) : task ? (
              <EditableText
                value={(task as any).name}
                placeholder="Untitled task"
                onSave={(v) => updateTask.mutate({ field: 'name', value: v })}
                className="text-sm font-bold text-slate-900 dark:text-slate-100"
              />
            ) : (
              <span className="text-sm font-bold text-slate-900 dark:text-slate-100">Task</span>
            )}
          </div>
          {!!task && (
            <button
              onClick={handleDeleteTask}
              disabled={deleteTask.isPending}
              className="rounded-md p-2 text-slate-400 dark:text-slate-500 hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-600 disabled:opacity-50"
              aria-label="Delete task"
              title="Delete task"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          <button onClick={onClose} className="rounded-md p-2 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close task drawer">
            <X className="h-4 w-4" aria-hidden="true" />
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
                className={cn('rounded-[5px] px-2 py-0.5 text-[11px] font-bold border-0 cursor-pointer focus:outline-none', PRIORITY_COLORS[(task as any).priority] || PRIORITY_COLORS.medium)}>
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
