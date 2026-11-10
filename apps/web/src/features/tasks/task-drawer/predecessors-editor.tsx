/**
 * Predecessors editor (§2 · task-drawer, 2026-11-10).
 *
 * Renders inside the Task Drawer's Project Info tab, below the existing
 * read-only predecessor-conflict banner. Lets the PM add / edit / delete
 * the dependencies the scheduler walks to compute due-date chains:
 *
 *   • List of current predecessors (dependency rows the BE embeds on
 *     the task as `task.dependencies[]`). Each row shows the mono task
 *     code + name on the left, a lag chip + reason in the middle, and
 *     edit / delete icon buttons on the right (visible on row hover,
 *     planwise-design standard affordance).
 *   • Inline edit mode replaces the chip+reason with the shared
 *     LagControls (number + WORKING_DAYS/CALENDAR_DAYS segmented + the
 *     LagReasonSelect popover). Save → PATCH; Cancel reverts.
 *   • Inline add form at the bottom. Dashed-outline "+ הוסף predecessor"
 *     button toggles a form (NOT a modal — explicit §2 spec) with:
 *     a searchable task picker (same-project peers, minus self, minus
 *     already-linked, minus the trivial 2-cycle peers pointing at us),
 *     lag number, lag unit, reason. Save → POST; Cancel closes.
 *   • Any add/patch/delete surfaces a one-line amber hint reminding
 *     the PM that the schedule only picks up the change on the manual
 *     "Save & update due dates" run. The hint is intentionally sticky
 *     until the drawer closes (local state resets on unmount).
 *
 * All four BE endpoints route through /projects/tasks/:id/dependencies*
 * (see apps/api/.../projects.controller.ts). The service enforces direct
 * + transitive cycle detection; we surface the 400 "Dependency cycle
 * detected" message as a red error toast.
 *
 * Shown in EVERY task status — including in_progress and tasks with
 * logged hours (§2 spec: no status gating). Tasks with logged hours get
 * an extra inline note pointing them at the Review flow, but editing
 * is never blocked.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import client from '@/api/client';
import { tasksApi } from '@/api/tasks.api';
import { queryKeys } from '@/lib/query-keys';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────

type LagUnit = 'WORKING_DAYS' | 'CALENDAR_DAYS';

interface DependencyRow {
  id: number;
  taskId: number;
  dependsOnId: number;
  lag: number;
  lagUnit: LagUnit;
  reason: string | null;
  dependsOn?: {
    id?: number;
    code?: string | null;
    name?: string | null;
    endDate?: string | Date | null;
  } | null;
}

export interface PredecessorsEditorTask {
  id: number;
  projectId?: number | null;
  loggedMinutes?: number | null;
  dependencies?: DependencyRow[] | null;
}

interface LagFormState {
  lag: number;
  lagUnit: LagUnit;
  reason: string | null;
}

// ─── Lag-reason catalog ───────────────────────────────────────────────

// Fallback when /lookups/lag-reasons is empty or errors. Mirrors the
// const in deliverable-templates-page.tsx so the two surfaces stay in
// sync even when the admin catalog is unreachable.
const LAG_REASON_FALLBACK = ['אישור לקוח', 'אספקה', 'בדיקה פנימית'] as const;

function useLagReasons() {
  return useQuery<Array<{ id: number; name: string; nameHe?: string | null; sortOrder?: number }>>({
    queryKey: ['lag-reasons'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/lookups/lag-reasons').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });
}

// ─── LagReasonSelect ──────────────────────────────────────────────────
// Self-rendered dropdown (not <select>) so the popover styles the same
// in light + dark mode instead of adopting OS chrome. Mirrors the
// LagReasonPopover in deliverable-templates-page.tsx but shaped for a
// larger surface area (13px text, 128px min width) since the drawer
// is wider than a Template table cell.

function LagReasonSelect({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const ref = useRef<HTMLDivElement>(null);
  const reasonsQuery = useLagReasons();

  useEffect(() => setDraft(value ?? ''), [value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCustomMode(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setCustomMode(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const apiOptions = (reasonsQuery.data ?? [])
    .map((r) => (r.nameHe ?? r.name ?? '').trim())
    .filter((s) => s.length > 0);
  const options: string[] =
    reasonsQuery.isError || apiOptions.length === 0 ? [...LAG_REASON_FALLBACK] : apiOptions;

  const commitCustom = () => {
    const v = draft.trim();
    onChange(v.length > 0 ? v : null);
    setOpen(false);
    setCustomMode(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
          setCustomMode(false);
        }}
        className="flex w-32 items-center justify-between rounded-[5px] border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:border-slate-400 focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="סיבת ההמתנה"
      >
        <span className={cn('truncate', !value && 'text-slate-400 dark:text-slate-500')}>
          {value && value.length > 0 ? value : 'סיבה'}
        </span>
        <span aria-hidden="true" className="ml-1 shrink-0 text-slate-400 dark:text-slate-500">
          ▾
        </span>
      </button>
      {open && (
        <div
          className="absolute right-0 z-50 mt-1 min-w-[180px] max-h-64 overflow-auto rounded-md border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
          role="listbox"
        >
          {!customMode ? (
            <>
              {options.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="option"
                  aria-selected={value === r}
                  onClick={() => {
                    onChange(r);
                    setOpen(false);
                  }}
                  className="w-full px-2 py-1 text-right text-[11px] text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  {r}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setDraft(value && !options.includes(value) ? value : '');
                  setCustomMode(true);
                }}
                className="w-full border-t border-slate-100 px-2 py-1 text-right text-[11px] text-slate-500 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                אחר…
              </button>
            </>
          ) : (
            <div className="p-1.5">
              <input
                type="text"
                autoFocus
                maxLength={255}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitCustom}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitCustom();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setOpen(false);
                    setCustomMode(false);
                  }
                }}
                placeholder="סיבה חופשית"
                className="w-full rounded-[5px] border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Lag controls (shared between Add + Edit forms) ───────────────────

function LagControls({
  state,
  setState,
  disabled,
}: {
  state: LagFormState;
  setState: (next: LagFormState) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
        <span>Lag</span>
        <input
          type="number"
          min={0}
          max={365}
          step={1}
          value={state.lag}
          disabled={disabled}
          onChange={(e) => {
            const raw = Math.max(0, Math.min(365, Math.floor(Number(e.target.value) || 0)));
            setState({ ...state, lag: raw });
          }}
          className="w-16 rounded-[5px] border border-slate-200 bg-white px-2 py-0.5 text-right font-mono tabular-nums text-[12px] text-slate-700 focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          aria-label="Lag בימים (0-365)"
        />
      </label>
      <div
        className="inline-flex items-center rounded-[5px] border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900"
        role="group"
        aria-label="יחידת השהיה"
      >
        <button
          type="button"
          disabled={disabled}
          onClick={() => setState({ ...state, lagUnit: 'WORKING_DAYS' })}
          className={cn(
            'rounded-[4px] px-2 py-0.5 text-[11px] font-semibold transition-colors',
            state.lagUnit === 'WORKING_DAYS'
              ? 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-100'
              : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200',
          )}
          aria-pressed={state.lagUnit === 'WORKING_DAYS'}
          title="ימי עבודה — handoff פנימי"
        >
          ימי עבודה
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setState({ ...state, lagUnit: 'CALENDAR_DAYS' })}
          className={cn(
            'rounded-[4px] px-2 py-0.5 text-[11px] font-semibold transition-colors',
            state.lagUnit === 'CALENDAR_DAYS'
              ? 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-100'
              : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200',
          )}
          aria-pressed={state.lagUnit === 'CALENDAR_DAYS'}
          title="ימים קלנדריים — סיבה חיצונית"
        >
          קלנדרי
        </button>
      </div>
      <LagReasonSelect
        value={state.reason}
        onChange={(reason) => setState({ ...state, reason })}
        disabled={disabled}
      />
    </div>
  );
}

// ─── Lag chip (read view) ─────────────────────────────────────────────

function LagChip({ lag, lagUnit }: { lag: number; lagUnit: LagUnit }) {
  const isWait = lag > 0;
  const unitLabel = lagUnit === 'CALENDAR_DAYS' ? 'קלנדרי' : 'ימי עבודה';
  // Planwise blue lag chip per planwise-design (bg-blue-50 text-blue-600).
  // The §2 spec calls for this exact variant regardless of wait/sequence;
  // the "ללא השהיה" (lag=0) chip reuses the same blue so it reads as a
  // first-class state, not a muted/missing one.
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[5px] px-2 py-0.5 text-[11px] font-bold tracking-wide',
        'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300',
      )}
      title={isWait ? `המתנה ${lag} ${unitLabel}` : 'ללא השהיה'}
    >
      {isWait ? (
        <>
          <span className="font-mono tabular-nums">+{lag}</span>
          <span className="ml-1">{unitLabel}</span>
        </>
      ) : (
        <span>ללא השהיה</span>
      )}
    </span>
  );
}

// ─── Task-picker searchable combobox (add form only) ──────────────────

function TaskPicker({
  tasks,
  value,
  onChange,
  disabled,
}: {
  tasks: Array<{ id: number; code?: string | null; name?: string | null }>;
  value: number | null;
  onChange: (id: number | null) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const selected = value != null ? tasks.find((t) => t.id === value) : null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tasks.slice(0, 50);
    return tasks
      .filter((t) => {
        const name = String(t.name ?? '').toLowerCase();
        const code = String(t.code ?? '').toLowerCase();
        return name.includes(q) || code.includes(q);
      })
      .slice(0, 50);
  }, [tasks, search]);

  return (
    <div ref={ref} className="relative flex-1 min-w-[200px]">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
        }}
        className="flex w-full items-center justify-between rounded-[5px] border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-700 hover:border-slate-400 focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={cn('truncate text-right', !selected && 'text-slate-400 dark:text-slate-500')}>
          {selected ? (
            <>
              {selected.code && (
                <span className="font-mono text-slate-500 dark:text-slate-400">
                  {selected.code} ·{' '}
                </span>
              )}
              {selected.name ?? `#${selected.id}`}
            </>
          ) : (
            'בחר משימה מקדימה…'
          )}
        </span>
        <span aria-hidden="true" className="ml-1 shrink-0 text-slate-400 dark:text-slate-500">
          ▾
        </span>
      </button>
      {open && (
        <div
          className="absolute left-0 right-0 z-50 mt-1 max-h-72 overflow-auto rounded-md border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
          role="listbox"
        >
          <div className="sticky top-0 border-b border-slate-100 bg-white p-1.5 dark:border-slate-800 dark:bg-slate-900">
            <input
              type="text"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="חפש לפי שם או קוד"
              className="w-full rounded-[5px] border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-700 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            />
          </div>
          {filtered.length === 0 ? (
            <div className="px-2 py-3 text-center text-[11px] text-slate-500 dark:text-slate-400">
              אין משימות תואמות.
            </div>
          ) : (
            filtered.map((t) => (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={value === t.id}
                onClick={() => {
                  onChange(t.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-2 py-1 text-right text-[12px] hover:bg-slate-50 dark:hover:bg-slate-800',
                  value === t.id
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                    : 'text-slate-700 dark:text-slate-200',
                )}
              >
                {t.code && (
                  <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                    {t.code}
                  </span>
                )}
                <span className="truncate">{t.name ?? `#${t.id}`}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────

export function PredecessorsEditor({ task }: { task: PredecessorsEditorTask }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const taskId = task.id;
  const projectId = task.projectId ?? null;
  const deps: DependencyRow[] = Array.isArray(task.dependencies) ? task.dependencies : [];
  const hasLoggedHours = Number(task.loggedMinutes ?? 0) > 0;

  // §3 (2026-11-10) — drawer-focus scroll. When the Planning grid
  // opens the drawer via the Predecessors cell it adds `?focus=predecessors`
  // to the URL. On mount we scroll this section into view then strip the
  // param so later renders (tab switch, task change) don't re-trigger
  // the jump. `sectionRef` is preferred over `getElementById` so we
  // tolerate multiple drawers in parallel (future).
  const sectionRef = useRef<HTMLElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('focus') !== 'predecessors') return;
    // Wait one frame so the drawer's own scroll container has laid out.
    const raf = requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('focus');
        return next;
      },
      { replace: true },
    );
    return () => cancelAnimationFrame(raf);
    // Intentional: only run on mount + when the `focus` param lands.
    // The setter is stable; depending on it would retrigger the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editState, setEditState] = useState<LagFormState | null>(null);

  const [addingOpen, setAddingOpen] = useState(false);
  const [addPickId, setAddPickId] = useState<number | null>(null);
  const [addState, setAddState] = useState<LagFormState>({ lag: 0, lagUnit: 'WORKING_DAYS', reason: null });

  // Sticky hint — kept visible until the component unmounts (drawer
  // close, or tab switch out of Project Info). Spec §4 explicitly
  // lets us pick the simpler lifetime; the reschedule arrival path is
  // not wired yet (manual Save & update due dates run).
  const [showHint, setShowHint] = useState(false);

  // Project-scoped peer list — only queried when the user opens the
  // add form, so the drawer doesn't pay for it up front. perPage=1000
  // covers every reasonable project size; larger ones can add paging
  // later.
  const projectTasksQuery = useQuery<any>({
    queryKey: ['tasks', 'list', { projectId, archived: false, perPage: 1000, scope: 'preds-picker' }],
    enabled: addingOpen && projectId != null,
    queryFn: () => tasksApi.list({ projectId: projectId!, perPage: 1000 }),
    staleTime: 60 * 1000,
  });
  const allProjectTasks: any[] =
    projectTasksQuery.data?.data ?? projectTasksQuery.data ?? [];

  const existingPredIds = useMemo(
    () => new Set(deps.map((d) => d.dependsOnId).filter((x): x is number => x != null)),
    [deps],
  );

  // Add candidates — exclude self, already-linked peers, and any peer
  // that already points at us (trivial 2-cycle; the BE guards transitive
  // cycles too but filtering here keeps the picker clean).
  const addCandidates = useMemo(() => {
    const trivialCycle = new Set<number>();
    for (const peer of allProjectTasks) {
      const peerDeps: any[] = peer?.dependencies ?? [];
      if (peerDeps.some((pd) => (pd?.dependsOnId ?? pd?.dependsOn?.id) === taskId)) {
        trivialCycle.add(peer.id);
      }
    }
    return allProjectTasks
      .filter((t) => t.id !== taskId && !existingPredIds.has(t.id) && !trivialCycle.has(t.id))
      .map((t) => ({ id: t.id, code: t.code, name: t.name }))
      .sort((a, b) => String(a.code ?? a.name ?? '').localeCompare(String(b.code ?? b.name ?? '')));
  }, [allProjectTasks, taskId, existingPredIds]);

  // Fallback lookup for dependsOn name/code when the embed is missing
  // (pre-§1 rows on legacy tasks). We don't fetch here — just scavenge
  // whatever the react-query cache already has from other screens.
  const nameCodeFallback = (dependsOnId: number): { code: string | null; name: string | null } => {
    const caches = queryClient.getQueriesData<any>({ queryKey: ['tasks'] });
    for (const [, data] of caches) {
      const list: any[] = data?.data ?? (Array.isArray(data) ? data : []) ?? [];
      const hit = list.find((t: any) => t?.id === dependsOnId);
      if (hit) return { code: hit.code ?? null, name: hit.name ?? null };
    }
    return { code: null, name: null };
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
    if (projectId != null) {
      queryClient.invalidateQueries({ queryKey: queryKeys.planning.byProject(projectId) });
    }
  };

  // Error surfacing: the BE returns a 400 with body
  //   { error: { message: 'Dependency cycle detected: …' } }
  // for direct + transitive cycles. We route those into a red toast
  // with the server's path intact so the PM can spot the chain. Other
  // 4xx/5xx share the generic "שגיאה בשמירת תלות" prefix.
  const surfaceError = (err: any, fallback: string) => {
    const serverMsg: string | undefined =
      err?.response?.data?.error?.message ??
      err?.response?.data?.message ??
      (typeof err?.message === 'string' ? err.message : undefined);
    if (typeof serverMsg === 'string' && /cycle/i.test(serverMsg)) {
      notify.error(serverMsg, { code: 'DEPS-CYCLE-400', error: err });
      return;
    }
    const combined = serverMsg ? `${fallback}: ${serverMsg}` : fallback;
    notify.apiError(err, combined);
  };

  const addMutation = useMutation({
    mutationFn: (payload: {
      dependsOnId: number;
      lag: number;
      lagUnit: LagUnit;
      reason: string | null;
    }) =>
      client
        .post(`/projects/tasks/${taskId}/dependencies`, payload)
        .then((r) => r.data?.data ?? r.data),
    onSuccess: () => {
      invalidate();
      setShowHint(true);
      setAddingOpen(false);
      setAddPickId(null);
      setAddState({ lag: 0, lagUnit: 'WORKING_DAYS', reason: null });
      notify.success('תלות נוספה', { code: 'DEPS-ADD-200' });
    },
    onError: (err: any) => surfaceError(err, 'שגיאה בשמירת תלות'),
  });

  const patchMutation = useMutation({
    mutationFn: ({
      dependsOnId,
      body,
    }: {
      dependsOnId: number;
      body: { lag?: number; lagUnit?: LagUnit; reason?: string | null };
    }) =>
      client
        .patch(`/projects/tasks/${taskId}/dependencies/${dependsOnId}`, body)
        .then((r) => r.data?.data ?? r.data),
    onSuccess: () => {
      invalidate();
      setShowHint(true);
      setEditingId(null);
      setEditState(null);
      notify.success('תלות עודכנה', { code: 'DEPS-PATCH-200' });
    },
    onError: (err: any) => surfaceError(err, 'שגיאה בשמירת תלות'),
  });

  const deleteMutation = useMutation({
    mutationFn: (dependsOnId: number) =>
      client
        .delete(`/projects/tasks/${taskId}/dependencies/${dependsOnId}`)
        .then((r) => r.data),
    onSuccess: () => {
      invalidate();
      setShowHint(true);
      notify.success('תלות הוסרה', { code: 'DEPS-DELETE-200' });
    },
    onError: (err: any) => surfaceError(err, 'שגיאה בהסרת תלות'),
  });

  // Handlers --------------------------------------------------------

  const beginEdit = (dep: DependencyRow) => {
    setEditingId(dep.dependsOnId);
    setEditState({
      lag: Number(dep.lag ?? 0),
      lagUnit: (dep.lagUnit as LagUnit) ?? 'WORKING_DAYS',
      reason: dep.reason ?? null,
    });
  };

  const commitEdit = (dep: DependencyRow) => {
    if (!editState) return;
    patchMutation.mutate({
      dependsOnId: dep.dependsOnId,
      body: { lag: editState.lag, lagUnit: editState.lagUnit, reason: editState.reason },
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditState(null);
  };

  const handleDelete = async (dep: DependencyRow) => {
    const label =
      dep.dependsOn?.name ?? dep.dependsOn?.code ?? nameCodeFallback(dep.dependsOnId).name ?? `#${dep.dependsOnId}`;
    const ok = await confirm(`להסיר את התלות ב-"${label}"?`, {
      title: 'הסרת תלות',
      description: 'אפשר להוסיף שוב בכל רגע.',
      confirmLabel: 'הסר',
      cancelLabel: 'ביטול',
      variant: 'danger',
    });
    if (!ok) return;
    deleteMutation.mutate(dep.dependsOnId);
  };

  const handleAddSubmit = () => {
    if (addPickId == null) return;
    addMutation.mutate({
      dependsOnId: addPickId,
      lag: addState.lag,
      lagUnit: addState.lagUnit,
      reason: addState.reason,
    });
  };

  const cancelAdd = () => {
    setAddingOpen(false);
    setAddPickId(null);
    setAddState({ lag: 0, lagUnit: 'WORKING_DAYS', reason: null });
  };

  // Render -----------------------------------------------------------

  return (
    <section
      ref={sectionRef}
      id="predecessors-section"
      aria-labelledby="preds-heading"
      className="space-y-2 scroll-mt-4"
    >
      <h3
        id="preds-heading"
        className="text-[15px] font-bold text-slate-900 dark:text-slate-100 mb-3"
      >
        תלויות (Predecessors)
      </h3>

      {/* Hint strip — shown once the user has made any add/patch/delete
          in this drawer session. Stays visible through further edits so
          the PM doesn't miss it after rapid-fire changes. The sister
          note about Review only appears when the task has reported hours. */}
      {showHint && (
        <div
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-700 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-200"
        >
          השינוי יתעדכן בלוח הזמנים ב-Save &amp; update due dates
          {hasLoggedHours && (
            <>
              {' · '}
              <span className="font-medium">
                משימה זו מופיעה ב-Review לפני עדכון תאריכים
              </span>
            </>
          )}
        </div>
      )}

      {deps.length === 0 ? (
        <p className="px-3 py-2 text-[12px] text-slate-500 dark:text-slate-400">
          אין תלויות — המשימה מתחילה ללא חיבור למשימה מוקדמת.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {deps.map((dep) => {
            const code = dep.dependsOn?.code ?? nameCodeFallback(dep.dependsOnId).code;
            const name = dep.dependsOn?.name ?? nameCodeFallback(dep.dependsOnId).name ?? `#${dep.dependsOnId}`;
            const isEditing = editingId === dep.dependsOnId;
            const isSaving =
              patchMutation.isPending && patchMutation.variables?.dependsOnId === dep.dependsOnId;
            const isDeleting =
              deleteMutation.isPending && deleteMutation.variables === dep.dependsOnId;

            return (
              <li
                key={dep.id}
                className="group flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/40"
              >
                {/* LEFT: code + name */}
                <div className="flex min-w-0 shrink-0 items-center gap-2">
                  {code && (
                    <span className="font-mono text-[11px] text-slate-400 dark:text-slate-500">
                      {code}
                    </span>
                  )}
                  <span className="truncate text-[13px] text-slate-700 dark:text-slate-200">
                    {name}
                  </span>
                </div>

                {/* MIDDLE: chip + reason OR inline-edit controls */}
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {isEditing && editState ? (
                    <LagControls state={editState} setState={setEditState} disabled={isSaving} />
                  ) : (
                    <>
                      <LagChip lag={Number(dep.lag ?? 0)} lagUnit={(dep.lagUnit as LagUnit) ?? 'WORKING_DAYS'} />
                      {dep.reason && (
                        <span className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {dep.reason}
                        </span>
                      )}
                    </>
                  )}
                </div>

                {/* RIGHT: actions */}
                <div
                  className={cn(
                    'flex shrink-0 items-center gap-1',
                    !isEditing && 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
                  )}
                >
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        onClick={() => commitEdit(dep)}
                        disabled={isSaving}
                        className="rounded-lg bg-blue-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {isSaving ? 'שומר…' : 'שמור'}
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        disabled={isSaving}
                        className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:text-slate-200"
                      >
                        ביטול
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => beginEdit(dep)}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        aria-label={`ערוך את התלות ב-${name}`}
                        title="ערוך"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(dep)}
                        disabled={isDeleting}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:text-slate-500 dark:hover:bg-red-900/30"
                        aria-label={`הסר את התלות ב-${name}`}
                        title="הסר"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Add form / Add button */}
      {addingOpen ? (
        <div className="rounded-lg border border-slate-200 bg-[#FAFBFC] p-3 dark:border-slate-700 dark:bg-slate-900/60">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-semibold text-slate-700 dark:text-slate-200">
              הוספת predecessor
            </span>
            <button
              type="button"
              onClick={cancelAdd}
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              aria-label="סגור טופס הוספה"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {projectId == null ? (
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                המשימה אינה משויכת לפרויקט — לא ניתן להוסיף תלות.
              </p>
            ) : projectTasksQuery.isLoading ? (
              <p className="text-[11px] text-slate-500 dark:text-slate-400">טוען משימות…</p>
            ) : addCandidates.length === 0 ? (
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                אין משימות זמינות להוספה כתלות.
              </p>
            ) : (
              <TaskPicker
                tasks={addCandidates}
                value={addPickId}
                onChange={setAddPickId}
                disabled={addMutation.isPending}
              />
            )}
          </div>
          <div className="mt-3">
            <LagControls state={addState} setState={setAddState} disabled={addMutation.isPending} />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={handleAddSubmit}
              disabled={addPickId == null || addMutation.isPending}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {addMutation.isPending ? 'שומר…' : 'הוסף'}
            </button>
            <button
              type="button"
              onClick={cancelAdd}
              disabled={addMutation.isPending}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:text-slate-200"
            >
              ביטול
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAddingOpen(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-[7px] border border-dashed border-slate-300 px-3 py-2 text-[12px] text-slate-500 hover:border-blue-500 hover:text-blue-600 dark:border-slate-700 dark:text-slate-400 dark:hover:border-blue-500 dark:hover:text-blue-400"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          הוסף predecessor
        </button>
      )}
    </section>
  );
}

export default PredecessorsEditor;
