import { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Calendar, Save, RefreshCcw, Layers, LayoutGrid, GanttChart, AlertTriangle, ArrowUpDown, ChevronUp, ChevronDown, Filter } from 'lucide-react';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { OpenInDriveButton } from '@/features/drive/open-in-drive-button';

/**
 * Deliverable Planning tab (Tier E #10, revised 2026-08-02).
 *
 * Second phase of project setup — set a target date per
 * (zone × deliverable) pair. PM enters an offset in MONTHS from a
 * "base date" (project kickoff / today); the backend snaps FORWARD
 * to the next Sunday (first day of the week in Israel) so the
 * customer promise never lands earlier than "N months from now".
 *
 * On save, task due dates propagate from the (zone × deliverable)
 * target — but only for tasks that haven't been manually overridden.
 * The API returns a list of overridden tasks and the PM sees a
 * prompt: keep manual dates, or overwrite them.
 *
 * Two view modes:
 *   - Table (default): zone × deliverable rows with month input +
 *     computed date pill.
 *   - Gantt: horizontal bar timeline, one row per (zone × deliverable),
 *     bar spanning est-start → due-date.
 */
export function DeliverablePlanningTab({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const todayStr = new Date().toISOString().slice(0, 10);
  const [baseDate, setBaseDate] = useState<string>(todayStr);
  const [viewMode, setViewMode] = useState<'table' | 'gantt'>('table');
  const [filterHasDue, setFilterHasDue] = useState<'' | 'yes' | 'no'>('');
  // Once at least one deliverable has a saved target, default to
  // Gantt view (client feedback 2026-08-02, item 6). Only flips once
  // per mount — the user can still switch back to Table manually.
  const [defaultedToGantt, setDefaultedToGantt] = useState(false);

  // Draft edits keyed by `${deliverableId}:${zoneId}`. Empty string = clear.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Duration drafts (calendar days) — parallel state so target months
  // and duration edits can be saved together in one batch.
  const [durationDrafts, setDurationDrafts] = useState<Record<string, string>>({});
  // Explicit-date drafts (ISO yyyy-mm-dd) — populated by the Gantt
  // drag so week-level precision is preserved (client feedback
  // 2026-08-02 item 4). When present for a row, this OVERRIDES the
  // months draft when saving.
  const [targetDateDrafts, setTargetDateDrafts] = useState<Record<string, string>>({});

  const { data: deliverables = [], isLoading } = useQuery<any[]>({
    queryKey: ['project-deliverables', projectId],
    queryFn: () =>
      client
        .get('/project-deliverables', { params: { projectId } })
        .then((r) => {
          const d = r.data?.data ?? r.data;
          return Array.isArray(d) ? d : [];
        }),
    staleTime: 30 * 1000,
  });

  const { data: planningData } = useQuery<any>({
    queryKey: ['planning', projectId],
    queryFn: () => client.get(`/projects/${projectId}/planning-data`).then((r) => r.data?.data ?? r.data),
    enabled: !!projectId,
    staleTime: 60 * 1000,
  });
  const tasks: any[] = Array.isArray(planningData?.tasks) ? planningData.tasks : [];
  const zonesFlat: any[] = Array.isArray(planningData?.zones) ? planningData.zones : [];

  // Build (zone × deliverable) rows from the tasks — the source of
  // truth for "which deliverables are used in which zones". Root-level
  // deliverables (tasks with no zoneId) get a synthetic "Project Root"
  // zone with id=null.
  type Row = {
    key: string;
    deliverableId: number;
    deliverableName: string;
    zoneId: number | null;
    zoneName: string;
    serviceName: string | null;
    // Current server target (either from zoneTargets[zoneId] or the deliverable-level fallback)
    savedMonths: number | null;
    savedDate: string | null;
    savedDurationWeeks: number | null;
    // Aggregate task counts for this (zone × deliverable). Rendered
    // as a badge on each Gantt bar (client feedback 2026-08-02 item 4).
    // "started" = anything past To Do that isn't Done ("in_progress",
    // "in_review", "done" for the started tally); "done" = "done".
    taskTotal: number;
    taskStarted: number;
    taskDone: number;
    // The full task list for this row — feeds the Gantt-bar-click
    // modal (client feedback item 2/3). Kept minimal: id/code/name/end/status.
    taskList: { id: number; code: string | null; name: string; endDate: string | null; status: string }[];
  };
  const rows: Row[] = useMemo(() => {
    const seen = new Set<string>();
    const list: Row[] = [];
    const grouped = new Map<string, any[]>();
    for (const t of tasks) {
      const dId = t.projectDeliverableId;
      if (dId == null) continue;
      const zoneId = t.zoneId ?? null;
      const key = `${dId}:${zoneId ?? 'root'}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(t);
    }
    for (const [key, group] of grouped) {
      if (seen.has(key)) continue;
      seen.add(key);
      const first = group[0];
      const dId: number = first.projectDeliverableId;
      const zoneId: number | null = first.zoneId ?? null;
      const zone = zonesFlat.find((z) => z.id === zoneId);
      const deliverable = deliverables.find((d) => d.id === dId);
      const zoneTargetRow = deliverable?.zoneTargets?.find((zt: any) => zt.zoneId === zoneId);
      const savedMonths = zoneTargetRow?.targetMonths ?? deliverable?.targetMonths ?? null;
      const savedDate = zoneTargetRow?.targetDate ?? deliverable?.targetDate ?? null;
      const savedDurationWeeks = zoneTargetRow?.estimatedDurationWeeks ?? deliverable?.estimatedDurationWeeks ?? null;
      const taskTotal = group.length;
      // status vocabulary: 'to_do' | 'in_progress' | 'in_review' | 'done' | 'blocked'
      const taskDone = group.filter((t) => t.status === 'done').length;
      const taskStarted = group.filter((t) => t.status !== 'to_do' && t.status !== 'blocked').length;
      const taskList = group.map((t) => ({
        id: t.id,
        code: t.code ?? null,
        name: t.name,
        endDate: t.endDate ? String(t.endDate).slice(0, 10) : null,
        status: t.status,
      }));
      list.push({
        key,
        deliverableId: dId,
        deliverableName: deliverable?.name ?? `Deliverable #${dId}`,
        zoneId,
        zoneName: zone?.name ?? (zoneId == null ? 'Project Root' : `Zone #${zoneId}`),
        serviceName: deliverable?.service?.name ?? null,
        savedMonths,
        savedDate: savedDate ? String(savedDate).slice(0, 10) : null,
        savedDurationWeeks,
        taskTotal,
        taskStarted,
        taskDone,
        taskList,
      });
    }
    // Sort: zone name first (Project Root last), then deliverable name.
    return list.sort((a, b) => {
      if (a.zoneId == null && b.zoneId != null) return 1;
      if (b.zoneId == null && a.zoneId != null) return -1;
      const zc = a.zoneName.localeCompare(b.zoneName);
      if (zc !== 0) return zc;
      return a.deliverableName.localeCompare(b.deliverableName);
    });
  }, [tasks, zonesFlat, deliverables]);

  // Seed drafts from server values whenever rows change.
  useEffect(() => {
    const initial: Record<string, string> = {};
    const initialDur: Record<string, string> = {};
    for (const r of rows) {
      if (r.savedMonths != null) initial[r.key] = String(r.savedMonths);
      if (r.savedDurationWeeks != null) initialDur[r.key] = String(r.savedDurationWeeks);
    }
    setDrafts(initial);
    setDurationDrafts(initialDur);
    // Reset explicit-date drafts on row refresh — server just told us
    // the authoritative targetDate, so any stale drag draft is void.
    setTargetDateDrafts({});
  }, [rows]);

  // Auto-open in Gantt view once at least one row has a saved target
  // (client feedback 2026-08-02, item 6). Flips once per mount — the
  // user can still switch back to Table manually and it won't be
  // overridden.
  useEffect(() => {
    if (defaultedToGantt) return;
    const anySaved = rows.some((r) => !!r.savedDate);
    if (anySaved) {
      setViewMode('gantt');
      setDefaultedToGantt(true);
    }
  }, [rows, defaultedToGantt]);

  // Client-side preview: match backend snap logic exactly (forward to
  // next Sunday). We NEVER snap backward — customer promise doesn't
  // land earlier than "N months from base".
  const computePreview = (monthsRaw: string): string => {
    if (monthsRaw === '' || monthsRaw == null) return '';
    const months = Number(monthsRaw);
    if (Number.isNaN(months) || months < 0) return '';
    const [by, bm, bd] = baseDate.split('-').map(Number);
    if (!by || !bm || !bd) return '';
    const shifted = new Date(Date.UTC(by, bm - 1, bd));
    shifted.setUTCMonth(shifted.getUTCMonth() + Math.floor(months));
    const day = shifted.getUTCDay(); // Sun=0..Sat=6
    const daysForward = day === 0 ? 0 : 7 - day;
    shifted.setUTCDate(shifted.getUTCDate() + daysForward);
    return shifted.toISOString().slice(0, 10);
  };

  const [overrideConfirm, setOverrideConfirm] = useState<{ taskId: number; taskName: string; currentDue: string | null; targetDate: string | null }[] | null>(null);
  // Per-task conflict prompt for tasks whose current endDate is AFTER
  // the about-to-be-saved deliverable target. Client feedback
  // 2026-08-08: don't block — surface the conflicts, let the PM pick
  // per task whether to overwrite the Due date to the new target or
  // keep it as-is, then finish the save. Previously this was a hard
  // block ("fix task dates first") which forced the PM out of the
  // planning flow.
  type ExceedItem = { taskId: number; code: string | null; taskName: string; endDate: string; targetDate: string; deliverableName: string; zoneName: string };
  const [exceedPrompt, setExceedPrompt] = useState<ExceedItem[] | null>(null);
  // Per-task choice made by the PM in the conflict prompt. 'update' =
  // apply the target to the task's endDate (force-apply after save);
  // 'keep' = leave the task's endDate alone. Default 'update' — the
  // common case per the "notify and update" spec.
  const [exceedChoices, setExceedChoices] = useState<Record<number, 'update' | 'keep'>>({});
  // Loading flag while the sequenced Save + per-task force-apply chain
  // runs. Guards the confirm button and disables per-row toggling.
  const [exceedApplying, setExceedApplying] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      client
        .post('/project-deliverables/targets/batch', {
          baseDate,
          // Client 2026-08-03: never auto-propagate to task endDates.
          // Task due dates are AUTHORITATIVE at the task level once
          // set; the PM manages any downstream adjustments manually.
          applyToTasks: false,
          items: rows.map((r) => ({
            id: r.deliverableId,
            zoneId: r.zoneId,
            months: drafts[r.key] === '' || drafts[r.key] == null ? null : Number(drafts[r.key]),
            durationWeeks: durationDrafts[r.key] === '' || durationDrafts[r.key] == null ? null : Number(durationDrafts[r.key]),
            targetDate: targetDateDrafts[r.key] || undefined,
          })),
        })
        .then((r) => r.data),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['project-deliverables', projectId] });
      queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
      const payload = data?.data ?? data;
      notify.success(`Saved ${payload?.updated ?? rows.length} deliverable targets`);
      // Task due-date conflicts are handled up-front by the per-task
      // Update/Keep dialog in attemptSave; a silent success here is
      // the correct outcome when there are no conflicts.
    },
    onError: (err: any) => notify.apiError(err, 'Failed to save target dates'),
  });

  /**
   * Preflight before save: find every task whose current endDate is
   * strictly AFTER its (about-to-be-saved) deliverable target. The
   * conflict prompt (formerly a hard block) surfaces these and lets
   * the PM pick per task whether to overwrite or keep — the save
   * completes either way. Client feedback 2026-08-08.
   */
  const findExceedingTasks = (): ExceedItem[] | null => {
    const offenders: ExceedItem[] = [];
    for (const r of rows) {
      const newTargetIso = targetDateDrafts[r.key] || computePreview(drafts[r.key] ?? '') || r.savedDate;
      if (!newTargetIso) continue;
      const targetMs = new Date(newTargetIso).getTime();
      for (const t of r.taskList ?? []) {
        if (!t.endDate) continue;
        if (new Date(t.endDate).getTime() > targetMs) {
          offenders.push({
            taskId: t.id,
            code: t.code ?? null,
            taskName: t.name,
            endDate: String(t.endDate).slice(0, 10),
            targetDate: String(newTargetIso).slice(0, 10),
            deliverableName: r.deliverableName,
            zoneName: r.zoneName,
          });
        }
      }
    }
    return offenders.length > 0 ? offenders : null;
  };

  const attemptSave = () => {
    const offenders = findExceedingTasks();
    if (offenders) {
      // Default every conflicting task to 'update' — the "notify and
      // update" spec's happy path. PM can flip individual rows to
      // 'keep' or use "Keep all" before confirming.
      const defaults: Record<number, 'update' | 'keep'> = {};
      for (const o of offenders) defaults[o.taskId] = 'update';
      setExceedChoices(defaults);
      setExceedPrompt(offenders);
      return;
    }
    save.mutate();
  };

  /**
   * Confirm handler for the conflict prompt. Sequenced so the new
   * deliverable target is persisted FIRST (batch save), then any tasks
   * the PM chose to update get their endDate force-applied to that
   * target. Force-apply reads the just-saved target on the server, so
   * the ordering is load-bearing.
   */
  const confirmExceed = async () => {
    if (!exceedPrompt) return;
    setExceedApplying(true);
    try {
      await save.mutateAsync();
      const updateIds = exceedPrompt
        .filter((t) => exceedChoices[t.taskId] === 'update')
        .map((t) => t.taskId);
      // Fire per-task force-apply in parallel — the endpoint is
      // idempotent and each hits a different task row so there's no
      // ordering constraint between them.
      const results = await Promise.allSettled(
        updateIds.map((id) => forceApply.mutateAsync(id)),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        notify.warning(`${updateIds.length - failed} of ${updateIds.length} task due dates updated`);
      } else if (updateIds.length > 0) {
        notify.success(`Updated ${updateIds.length} task due date${updateIds.length === 1 ? '' : 's'} to the new target`);
      }
      // Refresh planning so the updated task endDates are picked up.
      queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
    } finally {
      setExceedApplying(false);
      setExceedPrompt(null);
      setExceedChoices({});
    }
  };

  const forceApply = useMutation({
    mutationFn: (taskId: number) =>
      client
        .post(`/project-deliverables/tasks/${taskId}/force-apply-target`)
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to overwrite task due date'),
  });

  const hasUnsavedChanges = useMemo(() => {
    for (const r of rows) {
      const draft = drafts[r.key] ?? '';
      const server = r.savedMonths == null ? '' : String(r.savedMonths);
      if (draft !== server) return true;
      const durDraft = durationDrafts[r.key] ?? '';
      const durServer = r.savedDurationWeeks == null ? '' : String(r.savedDurationWeeks);
      if (durDraft !== durServer) return true;
      // A Gantt target-date drag writes ONLY targetDateDrafts. This dimension
      // was missing from the dirty check, so such a drag left "Save all"
      // disabled and no unsaved banner — the drag was silently lost on refresh.
      // Only a row that was actually dragged has an entry here, so unchanged
      // rows never register as dirty.
      const tgtDraft = targetDateDrafts[r.key];
      if (tgtDraft != null && tgtDraft !== '' && tgtDraft !== (r.savedDate ?? '')) return true;
    }
    return false;
  }, [rows, drafts, durationDrafts, targetDateDrafts]);

  const resetDrafts = () => {
    const initial: Record<string, string> = {};
    const initialDur: Record<string, string> = {};
    for (const r of rows) {
      if (r.savedMonths != null) initial[r.key] = String(r.savedMonths);
      if (r.savedDurationWeeks != null) initialDur[r.key] = String(r.savedDurationWeeks);
    }
    setDrafts(initial);
    setDurationDrafts(initialDur);
    // Discard pending Gantt target-date drags too (pristine state is empty).
    // Previously Reset skipped this, so a dragged-but-reset row still had a
    // stale target-date draft that got persisted on the next save.
    setTargetDateDrafts({});
  };

  // Filtered rows for display (only affects the visible view; save
  // still writes all rows).
  const visibleRows = useMemo(() => {
    if (filterHasDue === '') return rows;
    if (filterHasDue === 'yes') return rows.filter((r) => (drafts[r.key] ?? r.savedMonths ?? '') !== '' && (drafts[r.key] ?? r.savedMonths ?? '') !== null);
    return rows.filter((r) => (drafts[r.key] ?? r.savedMonths ?? '') === '' || (drafts[r.key] ?? r.savedMonths ?? '') == null);
  }, [rows, drafts, filterHasDue]);

  if (isLoading) return <div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">Loading deliverables...</div>;
  if (rows.length === 0) {
    return (
      <div className="py-12 text-center">
        <Layers className="mx-auto h-12 w-12 text-slate-300 dark:text-slate-600" />
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">No zone × deliverable pairs found. Add tasks with a deliverable on the Planning tab first.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Per-task conflict prompt (client feedback 2026-08-08).
          Replaces the old hard block with a notify-and-update flow:
          list every task whose current Due is after the new deliverable
          target, let the PM choose per-task whether to overwrite the
          task's Due with the target OR keep it as-is, then continue
          with the save. "Apply to all" (Update / Keep) flips the whole
          list at once. */}
      {exceedPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 backdrop-blur-sm" onClick={() => !exceedApplying && setExceedPrompt(null)}>
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[720px] max-w-[92vw] max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-600" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Some tasks end after the new deliverable target</h3>
                <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Pick per task whether to update the task's Due date to the new deliverable target, or keep it as-is. The save proceeds either way.
                </p>
              </div>
            </div>
            {/* Bulk-toggle bar — "Apply to all" affordance. */}
            <div className="px-5 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2 text-[12px] bg-slate-50/60 dark:bg-slate-800/40">
              <span className="font-semibold text-slate-500 dark:text-slate-400">Apply to all:</span>
              <button
                type="button"
                disabled={exceedApplying}
                onClick={() => {
                  const next: Record<number, 'update' | 'keep'> = {};
                  for (const o of exceedPrompt) next[o.taskId] = 'update';
                  setExceedChoices(next);
                }}
                className="px-2.5 py-1 rounded-md border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 font-semibold disabled:opacity-50"
              >
                Update all to target
              </button>
              <button
                type="button"
                disabled={exceedApplying}
                onClick={() => {
                  const next: Record<number, 'update' | 'keep'> = {};
                  for (const o of exceedPrompt) next[o.taskId] = 'keep';
                  setExceedChoices(next);
                }}
                className="px-2.5 py-1 rounded-md border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold disabled:opacity-50"
              >
                Keep all as-is
              </button>
              <span className="ml-auto text-slate-400 dark:text-slate-500 tabular-nums">
                {exceedPrompt.filter((t) => exceedChoices[t.taskId] === 'update').length} of {exceedPrompt.length} will update
              </span>
            </div>
            <div className="p-5 space-y-2 overflow-auto">
              {exceedPrompt.map((t) => {
                const choice = exceedChoices[t.taskId] ?? 'update';
                return (
                  <div key={t.taskId} className="border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 shrink-0 tabular-nums">{t.code ?? '—'}</span>
                      <span className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate">{t.taskName}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px] text-slate-500 dark:text-slate-400">
                      <span>{t.zoneName} · {t.deliverableName}</span>
                      <span className="text-slate-300 dark:text-slate-600">·</span>
                      <span>current due <span className="font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-200">{t.endDate}</span></span>
                      <span className="text-slate-300 dark:text-slate-600">→ new target</span>
                      <span className="font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-200">{t.targetDate}</span>
                    </div>
                    <div className="mt-2 inline-flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
                      <button
                        type="button"
                        disabled={exceedApplying}
                        onClick={() => setExceedChoices((s) => ({ ...s, [t.taskId]: 'update' }))}
                        className={cn('px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-50', choice === 'update' ? 'bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}
                      >
                        Update to target
                      </button>
                      <button
                        type="button"
                        disabled={exceedApplying}
                        onClick={() => setExceedChoices((s) => ({ ...s, [t.taskId]: 'keep' }))}
                        className={cn('px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-50', choice === 'keep' ? 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}
                      >
                        Keep as-is
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
              <button
                type="button"
                disabled={exceedApplying}
                onClick={() => setExceedPrompt(null)}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={exceedApplying}
                onClick={confirmExceed}
                className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50"
              >
                {exceedApplying ? 'Applying…' : 'Confirm and save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Overridden-tasks confirm modal (Tier E #10) */}
      {overrideConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={() => setOverrideConfirm(null)}>
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[540px] max-w-[92vw] max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Some tasks have manual due dates</h3>
                <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-0.5">
                  These tasks were previously set by their assignee or a manager. Keep the manual date, or overwrite with the new target?
                </p>
              </div>
            </div>
            <div className="p-5 space-y-2">
              {overrideConfirm.map((t) => (
                <div key={t.taskId} className="flex items-center gap-2 text-[13px] border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                  <span className="flex-1 font-medium text-slate-800 dark:text-slate-100 truncate">{t.taskName}</span>
                  <span className="text-slate-400 dark:text-slate-500 tabular-nums">{t.currentDue ?? '—'}</span>
                  <span className="text-slate-300 dark:text-slate-600">→</span>
                  <span className="text-emerald-600 tabular-nums">{t.targetDate ?? '—'}</span>
                  <button
                    type="button"
                    onClick={() => forceApply.mutate(t.taskId)}
                    className="ml-2 bg-amber-600 hover:bg-amber-700 text-white text-[12px] font-semibold px-2.5 py-1 rounded-md"
                  >
                    Overwrite
                  </button>
                </div>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
              <button
                onClick={() => setOverrideConfirm(null)}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
              >
                Keep all manual dates
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header controls */}
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <h2 className="text-[15px] font-bold text-slate-900 dark:text-slate-100">Deliverable Planning</h2>
          <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">
            Set a target date per (zone × deliverable) as "N months from the base date". Dates snap forward to the next Sunday.
          </p>
        </div>
        <div className="ml-auto flex items-end gap-2">
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Due date</label>
            <select
              value={filterHasDue}
              onChange={(e) => setFilterHasDue(e.target.value as any)}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
            >
              <option value="">All</option>
              <option value="yes">With target</option>
              <option value="no">Missing target</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Base date</label>
            <input
              type="date"
              value={baseDate}
              onChange={(e) => setBaseDate(e.target.value)}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('table')}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold', viewMode === 'table' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}
              title="Table view"
            >
              <LayoutGrid className="h-3.5 w-3.5" /> Table
            </button>
            <button
              type="button"
              onClick={() => setViewMode('gantt')}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold', viewMode === 'gantt' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}
              title="Gantt view"
            >
              <GanttChart className="h-3.5 w-3.5" /> Gantt
            </button>
          </div>
          {hasUnsavedChanges && (
            <button
              type="button"
              onClick={resetDrafts}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 text-[13px] font-semibold"
              title="Discard unsaved changes"
            >
              <RefreshCcw className="h-3.5 w-3.5" /> Reset
            </button>
          )}
          <button
            type="button"
            onClick={attemptSave}
            disabled={!hasUnsavedChanges || save.isPending}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-[13px] font-semibold"
           aria-label="Save">
            <Save className="h-3.5 w-3.5"  aria-hidden="true" />
            {save.isPending ? 'Saving...' : 'Save all'}
          </button>
        </div>
      </div>

      {viewMode === 'table' ? (
        <TableView rows={visibleRows} drafts={drafts} setDrafts={setDrafts} durationDrafts={durationDrafts} setDurationDrafts={setDurationDrafts} computePreview={computePreview} />
      ) : (
        <GanttView projectId={projectId} rows={visibleRows} drafts={drafts} durationDrafts={durationDrafts} targetDateDrafts={targetDateDrafts} setDrafts={setDrafts} setDurationDrafts={setDurationDrafts} setTargetDateDrafts={setTargetDateDrafts} computePreview={computePreview} baseDate={baseDate} />
      )}

      {hasUnsavedChanges && (
        <p className="text-[12px] text-blue-600 font-medium">
          You have unsaved changes. Click <span className="font-bold">Save all</span> to persist them.
        </p>
      )}
    </div>
  );
}

/**
 * Table view — grouped by Deliverable (primary), Zone rows underneath.
 * Every column supports sort + per-column filter. Data rendered as
 * plain text (no chips/pills) per client 2026-08-02 revision.
 */
function TableView({
  rows,
  drafts,
  setDrafts,
  durationDrafts,
  setDurationDrafts,
  computePreview,
}: {
  rows: any[];
  drafts: Record<string, string>;
  setDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  durationDrafts: Record<string, string>;
  setDurationDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  computePreview: (m: string) => string;
}) {
  // Per-column filters — arrays of selected values (empty = no filter).
  // A row passes a column filter if its value is IN the selected array.
  // Values are cascading: each column's filter dropdown shows only the
  // values that are still available given the OTHER columns' filters,
  // so users can drill down without seeing dead options.
  type ColKey = 'deliverable' | 'zone' | 'service' | 'months' | 'duration' | 'target';
  const [colFilters, setColFilters] = useState<Record<ColKey, string[]>>({
    deliverable: [], zone: [], service: [], months: [], duration: [], target: [],
  });
  const [openFilter, setOpenFilter] = useState<null | ColKey>(null);
  // Sort state — one column at a time; asc/desc toggle.
  const [sort, setSort] = useState<{ col: ColKey; dir: 'asc' | 'desc' }>({ col: 'deliverable', dir: 'asc' });

  // Effective raw values a row contributes to each column (for both
  // the filter matcher and the "available options" derivation).
  const rowValue = (r: any, col: ColKey): string => {
    if (col === 'deliverable') return r.deliverableName ?? '';
    if (col === 'zone') return r.zoneName ?? '';
    if (col === 'service') return r.serviceName ?? '';
    if (col === 'months') {
      const draft = drafts[r.key] ?? '';
      return draft || (r.savedMonths == null ? '' : String(r.savedMonths));
    }
    if (col === 'duration') {
      const draft = durationDrafts[r.key] ?? '';
      return draft || (r.savedDurationWeeks == null ? '' : String(r.savedDurationWeeks));
    }
    // target
    const draft = drafts[r.key] ?? '';
    return computePreview(draft) || r.savedDate || '';
  };

  // Helper: does a row pass the currently selected filter for a given
  // column? Called both by the visible-rows pipeline and by the
  // "available options" builder (which excludes the requesting column).
  const rowPassesCol = (r: any, col: ColKey, filters: Record<ColKey, string[]>): boolean => {
    const sel = filters[col];
    if (!sel || sel.length === 0) return true;
    const v = rowValue(r, col) || '(empty)';
    return sel.includes(v);
  };

  // Visible rows: pass every column filter.
  const filtered = useMemo(
    () => rows.filter((r) => (['deliverable', 'zone', 'service', 'months', 'duration', 'target'] as ColKey[]).every((c) => rowPassesCol(r, c, colFilters))),
    [rows, drafts, durationDrafts, colFilters],
  );

  // For a given column, build the list of distinct values the user
  // CAN currently pick — computed against rows that pass every OTHER
  // filter (cascading). Result is `{ value, selected, count }[]`.
  const optionsFor = (col: ColKey) => {
    const otherCols = (['deliverable', 'zone', 'service', 'months', 'duration', 'target'] as ColKey[]).filter((c) => c !== col);
    const eligible = rows.filter((r) => otherCols.every((c) => rowPassesCol(r, c, colFilters)));
    const counts = new Map<string, number>();
    for (const r of eligible) {
      const v = rowValue(r, col) || '(empty)';
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const sel = new Set(colFilters[col] ?? []);
    return Array.from(counts.entries())
      .map(([value, count]) => ({ value, count, selected: sel.has(value) }))
      .sort((a, b) => a.value.localeCompare(b.value));
  };

  const toggleFilterValue = (col: ColKey, value: string) => {
    setColFilters((s) => {
      const cur = new Set(s[col]);
      if (cur.has(value)) cur.delete(value); else cur.add(value);
      return { ...s, [col]: Array.from(cur) };
    });
  };
  const clearFilter = (col: ColKey) => setColFilters((s) => ({ ...s, [col]: [] }));
  const selectAll = (col: ColKey) => {
    const all = optionsFor(col).map((o) => o.value);
    setColFilters((s) => ({ ...s, [col]: all }));
  };

  // Effective date for sort/display
  const effectiveDate = (r: any) => {
    const draft = drafts[r.key] ?? '';
    return computePreview(draft) || r.savedDate || '';
  };
  const effectiveMonths = (r: any) => {
    const draft = drafts[r.key] ?? '';
    return draft || (r.savedMonths == null ? '' : String(r.savedMonths));
  };
  const effectiveDuration = (r: any) => {
    const draft = durationDrafts[r.key] ?? '';
    return draft || (r.savedDurationWeeks == null ? '' : String(r.savedDurationWeeks));
  };

  // Sort within the same deliverable group. Deliverable order is
  // ALWAYS driven by the sort setting (so users can sort deliverables
  // top-level too). Zones inside a deliverable follow the same rule
  // when sort col is 'zone', else stay in their default order.
  const sortedGroups = useMemo(() => {
    // Group by deliverable
    const map = new Map<number, { deliverableId: number; deliverableName: string; serviceName: string | null; zones: any[] }>();
    for (const r of filtered) {
      if (!map.has(r.deliverableId)) {
        map.set(r.deliverableId, {
          deliverableId: r.deliverableId,
          deliverableName: r.deliverableName,
          serviceName: r.serviceName,
          zones: [],
        });
      }
      map.get(r.deliverableId)!.zones.push(r);
    }
    const groups = Array.from(map.values());

    // Sort the groups
    const sign = sort.dir === 'asc' ? 1 : -1;
    const cmp = (a: string | number, b: string | number) => (a > b ? 1 : a < b ? -1 : 0) * sign;
    if (sort.col === 'deliverable') groups.sort((a, b) => cmp(a.deliverableName.toLowerCase(), b.deliverableName.toLowerCase()));
    else if (sort.col === 'service') groups.sort((a, b) => cmp((a.serviceName ?? '').toLowerCase(), (b.serviceName ?? '').toLowerCase()));
    else if (sort.col === 'zone') groups.sort((a, b) => cmp((a.zones[0]?.zoneName ?? '').toLowerCase(), (b.zones[0]?.zoneName ?? '').toLowerCase()));
    else if (sort.col === 'months') groups.sort((a, b) => cmp(Number(effectiveMonths(a.zones[0]) || 0), Number(effectiveMonths(b.zones[0]) || 0)));
    else if (sort.col === 'duration') groups.sort((a, b) => cmp(Number(effectiveDuration(a.zones[0]) || 0), Number(effectiveDuration(b.zones[0]) || 0)));
    else if (sort.col === 'target') groups.sort((a, b) => cmp(effectiveDate(a.zones[0]) || '', effectiveDate(b.zones[0]) || ''));

    // Sort zone rows within each group
    for (const g of groups) {
      const zsign = sort.dir === 'asc' ? 1 : -1;
      const zcmp = (a: string | number, b: string | number) => (a > b ? 1 : a < b ? -1 : 0) * zsign;
      if (sort.col === 'zone' || sort.col === 'deliverable' || sort.col === 'service') {
        g.zones.sort((a: any, b: any) => zcmp(a.zoneName.toLowerCase(), b.zoneName.toLowerCase()));
      } else if (sort.col === 'months') {
        g.zones.sort((a: any, b: any) => zcmp(Number(effectiveMonths(a) || 0), Number(effectiveMonths(b) || 0)));
      } else if (sort.col === 'duration') {
        g.zones.sort((a: any, b: any) => zcmp(Number(effectiveDuration(a) || 0), Number(effectiveDuration(b) || 0)));
      } else if (sort.col === 'target') {
        g.zones.sort((a: any, b: any) => zcmp(effectiveDate(a) || '', effectiveDate(b) || ''));
      }
    }
    return groups;
  }, [filtered, sort, drafts, durationDrafts]);

  const toggleSort = (col: typeof sort.col) => {
    setSort((s) => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }));
  };

  return (
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-[#FAFBFC] border-b border-slate-100 dark:border-slate-800">
          <tr className="text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
            <SortableFilterableHeader
              label="Deliverable" width="w-[240px]"
              sort={sort} col="deliverable" onToggleSort={() => toggleSort('deliverable')}
              options={optionsFor('deliverable')} activeCount={colFilters.deliverable.length}
              onToggleValue={(v) => toggleFilterValue('deliverable', v)}
              onClear={() => clearFilter('deliverable')} onSelectAll={() => selectAll('deliverable')}
              open={openFilter === 'deliverable'} onToggleOpen={() => setOpenFilter((c) => c === 'deliverable' ? null : 'deliverable')}
            />
            <SortableFilterableHeader
              label="Zone"
              sort={sort} col="zone" onToggleSort={() => toggleSort('zone')}
              options={optionsFor('zone')} activeCount={colFilters.zone.length}
              onToggleValue={(v) => toggleFilterValue('zone', v)}
              onClear={() => clearFilter('zone')} onSelectAll={() => selectAll('zone')}
              open={openFilter === 'zone'} onToggleOpen={() => setOpenFilter((c) => c === 'zone' ? null : 'zone')}
            />
            <SortableFilterableHeader
              label="Service"
              sort={sort} col="service" onToggleSort={() => toggleSort('service')}
              options={optionsFor('service')} activeCount={colFilters.service.length}
              onToggleValue={(v) => toggleFilterValue('service', v)}
              onClear={() => clearFilter('service')} onSelectAll={() => selectAll('service')}
              open={openFilter === 'service'} onToggleOpen={() => setOpenFilter((c) => c === 'service' ? null : 'service')}
            />
            <SortableFilterableHeader
              label="Months" width="w-[110px]" align="right"
              sort={sort} col="months" onToggleSort={() => toggleSort('months')}
              options={optionsFor('months')} activeCount={colFilters.months.length}
              onToggleValue={(v) => toggleFilterValue('months', v)}
              onClear={() => clearFilter('months')} onSelectAll={() => selectAll('months')}
              open={openFilter === 'months'} onToggleOpen={() => setOpenFilter((c) => c === 'months' ? null : 'months')}
            />
            <SortableFilterableHeader
              label="Duration (weeks) *" width="w-[140px]" align="right"
              sort={sort} col="duration" onToggleSort={() => toggleSort('duration')}
              options={optionsFor('duration')} activeCount={colFilters.duration.length}
              onToggleValue={(v) => toggleFilterValue('duration', v)}
              onClear={() => clearFilter('duration')} onSelectAll={() => selectAll('duration')}
              open={openFilter === 'duration'} onToggleOpen={() => setOpenFilter((c) => c === 'duration' ? null : 'duration')}
            />
            <SortableFilterableHeader
              label="Target Date" width="w-[160px]"
              sort={sort} col="target" onToggleSort={() => toggleSort('target')}
              options={optionsFor('target')} activeCount={colFilters.target.length}
              onToggleValue={(v) => toggleFilterValue('target', v)}
              onClear={() => clearFilter('target')} onSelectAll={() => selectAll('target')}
              open={openFilter === 'target'} onToggleOpen={() => setOpenFilter((c) => c === 'target' ? null : 'target')}
            />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {sortedGroups.map((g) => (
            <FragmentGroup key={g.deliverableId}>
              {/* Deliverable header row — deliverable name only. Service
                  is deliberately NOT repeated here (it already shows in
                  the Service column per row), otherwise the same value
                  reads twice on every group and looked like a data
                  leak. (Client feedback 2026-08-02.) */}
              <tr className="bg-slate-50/70 dark:bg-slate-800/70">
                <td colSpan={6} className="px-4 py-2 text-[12px] font-bold text-slate-700 dark:text-slate-200">
                  <div className="flex items-center justify-between gap-3">
                    <span>{g.deliverableName}</span>
                    {/* Open the deliverable's Drive folder (create-if-
                        missing on click). Rate-limited backend; a
                        graceful "not configured" toast fires if the
                        admin hasn't set up Drive yet. */}
                    <OpenInDriveButton entity="deliverable" id={g.deliverableId} />
                  </div>
                </td>
              </tr>
              {g.zones.map((r) => {
                const draft = drafts[r.key] ?? '';
                const durDraft = durationDrafts[r.key] ?? '';
                const preview = computePreview(draft);
                const serverMonths = r.savedMonths == null ? '' : String(r.savedMonths);
                const serverDur = r.savedDurationWeeks == null ? '' : String(r.savedDurationWeeks);
                const isDirty = draft !== serverMonths || durDraft !== serverDur;
                return (
                  <tr key={r.key} className={cn('hover:bg-slate-50/40 dark:hover:bg-slate-800/40', isDirty && 'bg-blue-50/30')}>
                    <td className="px-4 py-2 text-slate-400 dark:text-slate-500">—</td>
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200">{r.zoneName}</td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300 text-[13px]">{r.serviceName ?? '—'}</td>
                    <td className="px-4 py-2 text-right">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={draft}
                        onChange={(e) => setDrafts((s) => ({ ...s, [r.key]: e.target.value }))}
                        placeholder="—"
                        className="w-[86px] px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 tabular-nums text-right focus:border-blue-500 focus:outline-none"
                      />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={durDraft}
                        onChange={(e) => setDurationDrafts((s) => ({ ...s, [r.key]: e.target.value }))}
                        placeholder="—"
                        className="w-[86px] px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 tabular-nums text-right focus:border-blue-500 focus:outline-none"
                      />
                    </td>
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200 tabular-nums">
                      {preview
                        ? preview
                        : r.savedDate
                          ? <span className="text-slate-500 dark:text-slate-400">{r.savedDate}</span>
                          : <span className="text-slate-300 dark:text-slate-600">no target</span>}
                    </td>
                  </tr>
                );
              })}
            </FragmentGroup>
          ))}
        </tbody>
      </table>
      {/* Footnote — the Duration column is in CALENDAR days, not
          working hours. Set by the client on 2026-08-02 so the PM
          can draw the Gantt independent of team availability. */}
      <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 italic">
        * Duration is in <span className="font-semibold">calendar weeks</span>, not actual working time.
      </div>
    </div>
  );
}

// Fragment wrapper as a named component so React key prop is legal on it.
function FragmentGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/**
 * Column header — sort (click label) + filter (funnel icon). Filter
 * popover shows a CHECKBOX LIST of the values currently loaded on
 * screen for that column. Cascading — the options reflect the current
 * state of other columns' filters so users can drill down without
 * seeing dead ends. (Tier E #10 revision, 2026-08-02 client update.)
 */
function SortableFilterableHeader({
  label, width, align,
  sort, col, onToggleSort,
  options, activeCount,
  onToggleValue, onClear, onSelectAll,
  open, onToggleOpen,
}: {
  label: string;
  width?: string;
  align?: 'left' | 'right';
  sort: { col: string; dir: 'asc' | 'desc' };
  col: string;
  onToggleSort: () => void;
  options: { value: string; count: number; selected: boolean }[];
  activeCount: number;
  onToggleValue: (v: string) => void;
  onClear: () => void;
  onSelectAll: () => void;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onToggleOpen();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onToggleOpen]);
  useEffect(() => { if (!open) setSearch(''); }, [open]);

  const isSorted = sort.col === col;
  const filteredOptions = search
    ? options.filter((o) => o.value.toLowerCase().includes(search.toLowerCase()))
    : options;
  const hasActive = activeCount > 0;

  return (
    <th className={cn('px-4 py-3 font-semibold', width, align === 'right' ? 'text-right' : 'text-left')}>
      <div ref={ref} className={cn('relative inline-flex items-center gap-1.5', align === 'right' && 'justify-end w-full')}>
        <button
          type="button"
          onClick={onToggleSort}
          className={cn('inline-flex items-center gap-0.5 hover:text-slate-600 dark:hover:text-slate-200 transition-colors', isSorted && 'text-slate-700 dark:text-slate-200')}
          title={`Sort by ${label}`}
        >
          <span>{label}</span>
          <ArrowUpDown className={cn('h-3 w-3', !isSorted && 'opacity-40')} />
          {isSorted && (sort.dir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
        </button>
        <button
          type="button"
          onClick={onToggleOpen}
          className={cn('relative flex items-center justify-center w-4 h-4 rounded transition-colors', hasActive ? 'text-blue-600' : 'text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-100')}
          title={hasActive ? `${label} is filtered (${activeCount})` : `Filter ${label}`}
        >
          <Filter className="h-3 w-3" />
          {hasActive && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[13px] h-[13px] px-0.5 rounded-full bg-blue-600 text-white text-[8px] font-bold flex items-center justify-center">
              {activeCount}
            </span>
          )}
        </button>
        {open && (
          <div className="absolute left-0 top-full z-40 mt-1 w-[260px] rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.12)] border border-black/5 bg-white dark:bg-slate-900">
            {/* Header: search + Select all / Clear */}
            <div className="p-2 border-b border-slate-100 dark:border-slate-800">
              <input
                type="text"
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search…`}
                className="w-full px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 text-[12px] focus:border-blue-500 focus:outline-none"
              />
              <div className="flex items-center justify-between mt-2 text-[11px]">
                <button
                  type="button"
                  onClick={onSelectAll}
                  className="text-blue-600 hover:text-blue-700 font-semibold"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={onClear}
                  className="text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 font-semibold"
                >
                  Clear
                </button>
              </div>
            </div>
            {/* Checkbox list of distinct values (cascading — respects
                other columns' filters). Shows the row count per value
                so users can see how many rows a pick will yield. */}
            <div className="max-h-64 overflow-y-auto py-1">
              {filteredOptions.length === 0 ? (
                <p className="px-3 py-4 text-[11px] text-slate-400 dark:text-slate-500 italic text-center">
                  {search ? 'No matches' : 'No values available'}
                </p>
              ) : (
                filteredOptions.map((o) => (
                  <label
                    key={o.value}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer text-[12px]"
                  >
                    <input
                      type="checkbox"
                      checked={o.selected}
                      onChange={() => onToggleValue(o.value)}
                      className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="flex-1 truncate text-slate-700 dark:text-slate-200" title={o.value}>
                      {o.value === '(empty)' ? <span className="text-slate-400 dark:text-slate-500 italic">(empty)</span> : o.value}
                    </span>
                    <span className="text-[10px] text-slate-400 dark:text-slate-500 tabular-nums">{o.count}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </th>
  );
}

/**
 * Interactive Gantt view (Tier E #10, revised 2026-08-02).
 *
 * Every row is a (zone × deliverable) pair. The bar's RIGHT edge sits
 * at the target date; the LEFT edge sits `estimatedDurationWeeks`
 * calendar days back. Both edges are draggable — drop updates the
 * duration and/or the target date in the draft state (saved on the
 * "Save all" click in the parent). Middle drag moves the bar
 * bodily (target shifts, duration unchanged).
 *
 * Layout uses a proper 2-column grid — the LEFT column holds the
 * zone/deliverable labels and is aligned across the header AND every
 * row. The timeline area is the second column; the year/month bands
 * live only in the timeline column, so labels no longer sit under
 * dates. (Fixes the mid-turn alignment feedback from 2026-08-02.)
 */
function GanttView({
  projectId,
  rows,
  drafts,
  durationDrafts,
  targetDateDrafts,
  setDrafts,
  setDurationDrafts,
  setTargetDateDrafts,
  computePreview,
  baseDate,
}: {
  projectId: number;
  rows: any[];
  drafts: Record<string, string>;
  durationDrafts: Record<string, string>;
  targetDateDrafts: Record<string, string>;
  setDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  setDurationDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  setTargetDateDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  computePreview: (m: string) => string;
  baseDate: string;
}) {
  // Row order — persisted per browser via localStorage. Rebuilt from
  // the incoming rows whenever the row set changes, preserving any
  // prior order the user established. New rows get appended at the
  // end. (D&D reorder — client feedback 2026-08-02.)
  const orderKey = 'planwise:gantt:row-order:v1';
  const [rowOrder, setRowOrder] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(orderKey);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch { return []; }
  });
  useEffect(() => {
    // Merge: keep saved order for rows still present; append new ones.
    const present = new Set(rows.map((r) => r.key));
    const kept = rowOrder.filter((k) => present.has(k));
    const added = rows.map((r) => r.key).filter((k) => !kept.includes(k));
    const merged = [...kept, ...added];
    if (merged.length !== rowOrder.length || merged.some((k, i) => k !== rowOrder[i])) {
      setRowOrder(merged);
    }
  }, [rows]);
  useEffect(() => {
    try { localStorage.setItem(orderKey, JSON.stringify(rowOrder)); } catch { /* ignore */ }
  }, [rowOrder]);

  // Ordered rows for display, matching rowOrder.
  const orderedRows = useMemo(() => {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const ordered = rowOrder.map((k) => byKey.get(k)).filter(Boolean) as any[];
    // Any rows not yet in the persisted order (shouldn't happen after the effect above, but defensive) get appended.
    const missing = rows.filter((r) => !rowOrder.includes(r.key));
    return [...ordered, ...missing];
  }, [rows, rowOrder]);

  // Compact scale so 3 years fit in one viewport (client feedback
  // 2026-08-02 item 5). 8 px/week × 156 weeks (3 yr) ≈ 1250px, which
  // fits a typical laptop timeline column (viewport − 260px label
  // column ≈ 1000-1400px). Shorter than the old 30 px/week; users
  // can still pan for anything past 3 yr.
  const PX_PER_WEEK = 8;
  const PX_PER_DAY = PX_PER_WEEK / 7;
  const VISIBLE_YEARS = 3;

  // Compute the timeline span. Base is `baseDate`; end is 3 months
  // past the latest target (or 3 years from base, whichever is bigger)
  // so short-project scroll bars don't rattle around at the end.
  // Prefer explicit-date draft (from Gantt drag) → months draft →
  // saved server value. Same resolution order used inside GanttRow.
  const targets = orderedRows.map((r) => {
    if (targetDateDrafts[r.key]) return targetDateDrafts[r.key];
    const draft = drafts[r.key] ?? '';
    return computePreview(draft) || r.savedDate;
  }).filter(Boolean) as string[];

  // Pad the timeline with 1 year of past-buffer BEFORE baseDate so
  // the "today" marker always has room to sit in the first third of
  // the viewport (client feedback 2026-08-02). Without this buffer,
  // baseDate == today collapses todayPx to 0 and scrollLeft can't go
  // negative — today gets pinned to the left edge.
  const baseDateMs = new Date(baseDate).getTime();
  const PAST_BUFFER_DAYS = 365;
  const startMs = baseDateMs - PAST_BUFFER_DAYS * 86_400_000;
  const latestTargetMs = targets.length ? Math.max(...targets.map((d) => new Date(d).getTime())) : baseDateMs;
  const threeYearMs = baseDateMs + VISIBLE_YEARS * 365 * 86_400_000;
  const endMs = Math.max(latestTargetMs + 90 * 86_400_000, threeYearMs);
  const spanDays = Math.max(30, Math.round((endMs - startMs) / 86_400_000));
  const totalTimelineWidth = spanDays * PX_PER_DAY;
  // NB: don't early-return here — hooks below (useRef, useState,
  // useEffect) must run on EVERY render, otherwise React errors with
  // "Rendered fewer hooks than expected" when the row set toggles
  // between empty and non-empty (client feedback 2026-08-02). The
  // empty-state render is done at the bottom of the function.

  // Month + year ticks in PX positions along the total width. Walk
  // from the padded `startMs` (not baseDate) so the past-buffer area
  // gets its year/month labels too (client feedback 2026-08-02).
  // Anchor to the FIRST DAY of the month containing startMs so ticks
  // land on month boundaries, then step month-by-month until we reach
  // the end of the timeline.
  const monthTicks: { px: number; year: number; month: number }[] = [];
  const tickAnchor = new Date(startMs);
  tickAnchor.setUTCDate(1);
  tickAnchor.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i <= Math.ceil(spanDays / 30) + 2; i++) {
    const d = new Date(tickAnchor);
    d.setUTCMonth(d.getUTCMonth() + i);
    const days = (d.getTime() - startMs) / 86_400_000;
    const px = days * PX_PER_DAY;
    if (px >= 0 && px <= totalTimelineWidth) monthTicks.push({ px, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  const yearBands: { year: number; startPx: number; endPx: number }[] = [];
  for (let i = 0; i < monthTicks.length; i++) {
    const t = monthTicks[i];
    const last = yearBands[yearBands.length - 1];
    if (last && last.year === t.year) {
      last.endPx = i + 1 < monthTicks.length ? monthTicks[i + 1].px : totalTimelineWidth;
    } else {
      yearBands.push({ year: t.year, startPx: t.px, endPx: i + 1 < monthTicks.length ? monthTicks[i + 1].px : totalTimelineWidth });
    }
  }
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Today marker (client feedback 2026-08-02).
  const todayMs = Date.now();
  const todayPx = ((todayMs - startMs) / 86_400_000) * PX_PER_DAY;
  const todayInRange = todayPx >= 0 && todayPx <= totalTimelineWidth;

  // Single scroll source of truth: the BODY scroller. The header row
  // (year+month bands) is `overflow-hidden` and its inner content is
  // translated by `-scrollLeftPx`, so both always move together and
  // there is exactly one horizontal scrollbar. This replaces the
  // two-scroller onScroll-mirror trick, which sometimes let the top
  // and bottom drift apart when the top wasn't the active scroller.
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollLeftPx, setScrollLeftPx] = useState(0);
  const scrollByDays = (days: number) => {
    const el = bodyScrollRef.current;
    if (!el) return;
    const dx = days * PX_PER_DAY;
    el.scrollTo({ left: Math.max(0, el.scrollLeft + dx), behavior: 'smooth' });
  };
  const scrollToToday = (smooth: boolean = true) => {
    const el = bodyScrollRef.current;
    if (!el) return;
    // Put "today" in the FIRST THIRD of the viewport (client feedback
    // 2026-08-02) — leaves ~2/3 of horizontal space for future work.
    if (todayInRange) {
      el.scrollTo({ left: Math.max(0, todayPx - el.clientWidth / 3), behavior: smooth ? 'smooth' : 'auto' });
    } else {
      el.scrollTo({ left: 0, behavior: smooth ? 'smooth' : 'auto' });
    }
  };

  // On first paint (and after the timeline width changes), snap the
  // viewport so "today" starts in the first third instead of at the
  // left edge. Runs once per width change, not on every scroll.
  useEffect(() => {
    scrollToToday(false);
  }, [totalTimelineWidth]);

  // Past-date confirmation state (client feedback 2026-08-02).
  const [pastDateConfirm, setPastDateConfirm] = useState<null | { rowKey: string; newTargetMs: number; kind: 'target' | 'duration' | 'move'; apply: () => void }>(null);
  // Task-list modal for a clicked Gantt bar (items 2+3). Shows every
  // task under that (zone × deliverable) with an editable due date.
  const [taskModalRow, setTaskModalRow] = useState<any | null>(null);

  // Row drag state (D&D reorder). We use HTML5 drag events; @dnd-kit
  // is heavier than we need for a linear list.
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropIndicatorIdx, setDropIndicatorIdx] = useState<number | null>(null);

  const handleReorder = (fromKey: string, toIndex: number) => {
    setRowOrder((prev) => {
      const filtered = prev.filter((k) => k !== fromKey);
      const clamped = Math.max(0, Math.min(toIndex, filtered.length));
      return [...filtered.slice(0, clamped), fromKey, ...filtered.slice(clamped)];
    });
  };

  // Empty state — rendered AFTER all hooks so the hook count stays
  // constant across renders (see note above).
  if (orderedRows.length === 0) {
    return (
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-400 dark:text-slate-500">
        No (zone × deliverable) rows yet — add tasks on the Planning tab first.
      </div>
    );
  }

  return (
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      {pastDateConfirm && (
        <PastDateConfirmModal
          onCancel={() => setPastDateConfirm(null)}
          onConfirm={() => {
            pastDateConfirm.apply();
            setPastDateConfirm(null);
          }}
          newDate={new Date(pastDateConfirm.newTargetMs).toISOString().slice(0, 10)}
        />
      )}
      {taskModalRow && (
        <DeliverableTasksModal
          row={taskModalRow}
          onClose={() => setTaskModalRow(null)}
        />
      )}

      {/* Toolbar — scroll navigation + Today jump. */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 dark:border-slate-800 bg-[#FAFBFC] text-[12px]">
        <span className="text-slate-500 dark:text-slate-400 font-medium">Timeline</span>
        <div className="flex items-center gap-1 ml-2">
          <button type="button" onClick={() => scrollByDays(-365)} className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-600 dark:text-slate-300" title="Scroll back one year">◀ Year</button>
          <button type="button" onClick={() => scrollByDays(-30)} className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-600 dark:text-slate-300" title="Scroll back one month">◀ Month</button>
          <button type="button" onClick={() => scrollToToday(true)} className="flex items-center gap-1 px-2.5 py-1 rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 font-semibold" title="Jump to today">Today</button>
          <button type="button" onClick={() => scrollByDays(30)} className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-600 dark:text-slate-300" title="Scroll forward one month">Month ▶</button>
          <button type="button" onClick={() => scrollByDays(365)} className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-600 dark:text-slate-300" title="Scroll forward one year">Year ▶</button>
        </div>
        {/* Progress legend — client meeting 2026-08-04. Bars are
            colored by aggregate task status: blue = nothing started,
            amber = at least one in progress, emerald = all done.
            No percentages (misleading on small totals). Past-target
            bars additionally get a red ring — kept subtle so status
            stays the primary signal. */}
        <div className="ml-4 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">Bar:</span>
          <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-500" />Not started</span>
          <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-amber-500" />In progress</span>
          <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />Done</span>
          <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm ring-2 ring-red-300 ring-inset bg-white dark:bg-slate-900" />Past target</span>
        </div>
        <span className="ml-auto text-[11px] text-slate-400 dark:text-slate-500">
          Showing ~{VISIBLE_YEARS} years at a time · drag rows to reorder
        </span>
      </div>

      {/* 2-column grid — LEFT: labels (fixed), RIGHT: scrollable timeline. */}
      <div className="grid grid-cols-[260px_1fr]">
        {/* Header row spanning both columns */}
        <div className="px-4 py-2 text-[11px] uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 border-r border-b border-slate-200 dark:border-slate-700 bg-[#FAFBFC] flex items-end">
          Zone · Deliverable
        </div>
        <div
          className="overflow-hidden border-b border-slate-200 dark:border-slate-700 bg-[#FAFBFC]"
        >
          <div
            style={{ width: totalTimelineWidth, position: 'relative', transform: `translateX(${-scrollLeftPx}px)` }}
          >
            <div className="relative h-6 border-b border-slate-100 dark:border-slate-800">
              {yearBands.map((b, i) => (
                <div
                  key={i}
                  className="absolute top-0 h-full flex items-center border-l border-slate-200 dark:border-slate-700 pl-1.5 text-[11px] font-bold text-slate-700 dark:text-slate-200"
                  style={{ left: b.startPx, width: Math.max(0, b.endPx - b.startPx) }}
                >
                  {b.year}
                </div>
              ))}
            </div>
            <div className="relative h-6">
              {monthTicks.map((t, i) => (
                <div
                  key={i}
                  className="absolute top-0 h-full flex items-center border-l border-slate-100 dark:border-slate-800 pl-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400"
                  style={{ left: t.px }}
                >
                  {MONTH_NAMES[t.month - 1]}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Rows body — labels on left, scrollable bars on right. Both
          columns must scroll VERTICALLY in sync (they naturally do
          because both are in the same outer container); the timeline
          column scrolls HORIZONTALLY on its own. */}
      <div className="grid grid-cols-[260px_1fr]">
        {/* Labels column */}
        <div className="divide-y divide-slate-100 dark:divide-slate-800 border-r border-slate-200 dark:border-slate-700">
          {orderedRows.map((r, idx) => (
            <div
              key={r.key}
              draggable
              onDragStart={() => setDragKey(r.key)}
              onDragEnd={() => { setDragKey(null); setDropIndicatorIdx(null); }}
              onDragOver={(e) => { e.preventDefault(); setDropIndicatorIdx(idx); }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragKey && dragKey !== r.key) handleReorder(dragKey, idx);
                setDragKey(null);
                setDropIndicatorIdx(null);
              }}
              className={cn(
                'group h-8 px-4 text-[12px] flex items-center gap-2 cursor-grab active:cursor-grabbing hover:bg-slate-50/60 dark:hover:bg-slate-800/60',
                dragKey === r.key && 'opacity-40',
                dropIndicatorIdx === idx && dragKey && dragKey !== r.key && 'border-t-2 border-blue-500',
              )}
              title="Drag to reorder"
            >
              <span className="text-slate-300 dark:text-slate-600 group-hover:text-slate-500 leading-none">⋮⋮</span>
              <span className="font-medium text-slate-800 dark:text-slate-100 truncate">{r.zoneName}</span>
              <span className="text-slate-500 dark:text-slate-400 truncate">· {r.deliverableName}</span>
            </div>
          ))}
        </div>
        {/* Timeline column — the ONLY horizontal scroller. Its scroll
            position drives the header's translateX so year/month
            bands and today marker always sit above the correct week.
            Prev/Next-year and Today buttons operate on this ref. */}
        <div
          ref={bodyScrollRef}
          className="overflow-x-auto"
          onScroll={(e) => setScrollLeftPx((e.target as HTMLDivElement).scrollLeft)}
        >
          <div style={{ width: totalTimelineWidth, position: 'relative' }} className="divide-y divide-slate-100 dark:divide-slate-800">
            {/* Today vertical line (only if in range). */}
            {todayInRange && (
              <div
                className="absolute top-0 bottom-0 border-l-2 border-red-500 pointer-events-none z-20"
                style={{ left: todayPx }}
                title={`Today: ${new Date().toISOString().slice(0, 10)}`}
              >
                <span className="absolute -top-5 -translate-x-1/2 left-0 rounded bg-red-500 text-white text-[9px] px-1.5 py-0.5 font-bold whitespace-nowrap">
                  Today
                </span>
              </div>
            )}
            {orderedRows.map((r) => (
              <GanttRow
                key={r.key}
                r={r}
                projectId={projectId}
                drafts={drafts}
                durationDrafts={durationDrafts}
                targetDateDrafts={targetDateDrafts}
                setDrafts={setDrafts}
                setDurationDrafts={setDurationDrafts}
                setTargetDateDrafts={setTargetDateDrafts}
                computePreview={computePreview}
                startMs={startMs}
                pxPerDay={PX_PER_DAY}
                onRequestPastDate={(rowKey, newTargetMs, kind, apply) => setPastDateConfirm({ rowKey, newTargetMs, kind, apply })}
                onBarClick={() => setTaskModalRow(r)}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 italic">
        * Bar length reflects <span className="font-semibold">calendar weeks</span> (not working time). Drag the left edge to change duration, the right edge (or middle) to change the target date. Scrolling backwards past today triggers a confirmation.
      </div>
    </div>
  );
}

/**
 * One Gantt row. Renders ONLY the bar (labels live in the fixed left
 * column of GanttView). Positions are absolute px based on `pxPerDay`
 * so the horizontal viewport can scroll independently.
 *
 * Drag handles:
 *   - LEFT edge → change duration (target held).
 *   - RIGHT edge → change target date (duration held).
 *   - MIDDLE → move whole bar (target shifts, duration held).
 *
 * If the drag ends with the target in the past, we open a
 * confirmation modal (via onRequestPastDate); user can approve or
 * revert. Approve logs the change to the activity log (client
 * feedback 2026-08-02).
 */
function GanttRow({
  r,
  projectId,
  drafts,
  durationDrafts,
  targetDateDrafts,
  setDrafts,
  setDurationDrafts,
  setTargetDateDrafts,
  computePreview,
  startMs,
  pxPerDay,
  onRequestPastDate,
  onBarClick,
}: {
  r: any;
  projectId: number;
  drafts: Record<string, string>;
  durationDrafts: Record<string, string>;
  targetDateDrafts: Record<string, string>;
  setDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  setDurationDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  setTargetDateDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  computePreview: (m: string) => string;
  startMs: number;
  pxPerDay: number;
  onRequestPastDate: (rowKey: string, newTargetMs: number, kind: 'target' | 'duration' | 'move', apply: () => void) => void;
  onBarClick: () => void;
}) {
  const draft = drafts[r.key] ?? '';
  const durDraft = durationDrafts[r.key] ?? '';
  // Resolution order for the bar's target date:
  //   1. explicit date from a Gantt drag (targetDateDrafts)
  //   2. months preview (drafts + baseDate)
  //   3. server savedDate
  // Item 1 gives the drag week-level precision (client feedback
  // 2026-08-02 item 4); items 2+3 preserve the classic table edit.
  const targetDate = targetDateDrafts[r.key] || computePreview(draft) || r.savedDate;
  const durationWeeks = Number(durDraft || r.savedDurationWeeks || 0);

  if (!targetDate) {
    return (
      <div className="relative h-8 flex items-center text-[11px] text-slate-300 dark:text-slate-600 italic pl-2">
        no target
      </div>
    );
  }

  const targetMs = new Date(targetDate).getTime();
  const durMs = Math.max(0, durationWeeks * 7 * 86_400_000);
  const barStartMs = targetMs - durMs;

  // Pixel positions relative to the timeline start.
  const rightPx = ((targetMs - startMs) / 86_400_000) * pxPerDay;
  const leftPx = ((barStartMs - startMs) / 86_400_000) * pxPerDay;
  const widthPx = Math.max(4, rightPx - leftPx);

  const todayMs = Date.now();
  const isPastTarget = targetMs < todayMs;

  const startDrag = (mode: 'left' | 'right' | 'middle') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const initTargetMs = targetMs;
    const initDurationWeeks = durationWeeks;
    const initDurDraft = durDraft;
    const initTargetDateDraft = targetDateDrafts[r.key] ?? '';
    void draft; // reserved for future use — reads happen through targetDateDrafts now
    const initClientX = e.clientX;
    const msPerPx = 86_400_000 / pxPerDay;
    let finalTargetMs = initTargetMs;
    // Track the last-committed draft values so we can re-apply
    // atomically after the past-date confirmation modal.
    let lastTargetIso: string = initTargetDateDraft;
    let lastDurWeeks: string = initDurDraft;

    // Snap a raw ms timestamp to yyyy-mm-dd (server handles Sunday snap).
    const isoDayOf = (ms: number) => {
      const d = new Date(ms);
      d.setUTCHours(0, 0, 0, 0);
      return d.toISOString().slice(0, 10);
    };

    const onMove = (ev: PointerEvent) => {
      const dxPx = ev.clientX - initClientX;
      const dxMs = dxPx * msPerPx;
      if (mode === 'right' || mode === 'middle') {
        // Target drags (right edge OR middle-move) now write an
        // explicit ISO date — no more month-rounding round-trip
        // through the months+baseDate hack. Week-level precision
        // survives the save (client feedback 2026-08-02 item 4).
        finalTargetMs = Math.max(0, initTargetMs + dxMs);
        lastTargetIso = isoDayOf(finalTargetMs);
        setTargetDateDrafts((s) => ({ ...s, [r.key]: lastTargetIso }));
      } else {
        // Left edge → change duration (target held).
        const newDur = Math.max(0, Math.round(initDurationWeeks - dxMs / (7 * 86_400_000)));
        lastDurWeeks = String(newDur);
        setDurationDrafts((s) => ({ ...s, [r.key]: lastDurWeeks }));
      }
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);

      // Click detection — MIDDLE-mode near-zero drag opens the task
      // list modal instead of committing a target move (client
      // feedback 2026-08-02 items 2+3).
      const CLICK_SLOP = 3;
      const totalDx = Math.abs(ev.clientX - initClientX);
      if (mode === 'middle' && totalDx < CLICK_SLOP) {
        setTargetDateDrafts((s) => ({ ...s, [r.key]: initTargetDateDraft }));
        onBarClick();
        return;
      }

      const kind: 'target' | 'duration' | 'move' = mode === 'right' ? 'target' : mode === 'left' ? 'duration' : 'move';
      if (mode !== 'left' && finalTargetMs < todayMs && finalTargetMs !== initTargetMs) {
        // Revert the explicit-date draft, then let the modal's
        // Apply callback re-apply. Server-side audit-logging fires
        // later in batchSetTargets when the user clicks Save.
        setTargetDateDrafts((s) => ({ ...s, [r.key]: initTargetDateDraft }));
        onRequestPastDate(r.key, finalTargetMs, kind, () => {
          setTargetDateDrafts((s) => ({ ...s, [r.key]: lastTargetIso }));
          setDurationDrafts((s) => ({ ...s, [r.key]: lastDurWeeks }));
        });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const total = r.taskTotal ?? 0;
  const started = r.taskStarted ?? 0;
  const done = r.taskDone ?? 0;

  // Bar color reflects TASK-STATUS progress (client meeting
  // 2026-08-04, Amit's proposal). Three states — no percentages
  // because those mislead when totals are small or unbalanced:
  //   • blue      — no task has started yet
  //   • amber     — at least one task is in progress
  //   • emerald   — all tasks are done
  //   • slate     — no tasks under this row (nothing to color)
  const barStatus: 'empty' | 'not_started' | 'in_progress' | 'done' =
    total === 0 ? 'empty'
    : done === total ? 'done'
    : started > 0 ? 'in_progress'
    : 'not_started';
  const barColor =
    barStatus === 'done'         ? 'bg-emerald-500/85 hover:bg-emerald-600'
    : barStatus === 'in_progress'? 'bg-amber-500/85 hover:bg-amber-600'
    : barStatus === 'not_started'? 'bg-blue-500/85 hover:bg-blue-600'
    :                              'bg-slate-300 dark:bg-slate-600 hover:bg-slate-400';
  const handleColor =
    barStatus === 'done'         ? 'bg-emerald-700/40 hover:bg-emerald-800'
    : barStatus === 'in_progress'? 'bg-amber-700/40 hover:bg-amber-800'
    : barStatus === 'not_started'? 'bg-blue-700/40 hover:bg-blue-800'
    :                              'bg-slate-500/40 hover:bg-slate-600';
  const barStatusLabel =
    barStatus === 'done' ? 'All tasks done'
    : barStatus === 'in_progress' ? 'In progress'
    : barStatus === 'not_started' ? 'Not started'
    : 'No tasks';
  // Retain past-target hint via a subtle top border since color is
  // now taken by status. Users still see when a deliverable is
  // overdue without losing the progress signal.
  const pastHint = isPastTarget ? 'ring-2 ring-red-300 ring-inset' : '';

  return (
    <div className="relative h-8 select-none">
      <div
        className={cn('absolute top-2 h-4 rounded-md shadow-sm cursor-pointer flex items-center justify-between overflow-hidden', barColor, pastHint)}
        style={{ left: leftPx, width: widthPx }}
        title={`${r.deliverableName} — ${targetDate} · ${durationWeeks}w · ${barStatusLabel}${isPastTarget ? ' · target past' : ''} · click to edit tasks`}
        onPointerDown={startDrag('middle')}
      >
        <div
          className={cn('w-1.5 h-full cursor-ew-resize shrink-0', handleColor)}
          onPointerDown={startDrag('left')}
          title="Drag to change duration"
        />
        <span className="text-white text-[10px] font-bold tabular-nums whitespace-nowrap px-1 truncate">
          {durationWeeks > 0 ? `${durationWeeks}w · ` : ''}{targetDate}
        </span>
        <div
          className={cn('w-1.5 h-full cursor-ew-resize shrink-0', handleColor)}
          onPointerDown={startDrag('right')}
          title="Drag to change target date"
        />
      </div>
      {total > 0 && (
        <div
          className="absolute top-1 flex items-center gap-1 text-[10px] font-bold tabular-nums text-slate-600 dark:text-slate-300 bg-white/90 rounded px-1 pointer-events-none"
          style={{ left: rightPx + 6 }}
          title={`${total} tasks · ${started} started · ${done} done`}
        >
          <span className="text-slate-700 dark:text-slate-200">{total}</span>
          <span className="text-slate-300 dark:text-slate-600">·</span>
          <span className="text-blue-600">{started}</span>
          <span className="text-slate-300 dark:text-slate-600">·</span>
          <span className="text-emerald-600">{done}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Modal shown when a Gantt drag moves the target into the past. The
 * user must explicitly confirm; on confirm the change is applied and
 * logged (via /activity-log). Cancel reverts.
 */
function PastDateConfirmModal({
  newDate,
  onConfirm,
  onCancel,
}: {
  newDate: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="w-[420px] rounded-[14px] bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700 p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
          </div>
          <div className="min-w-0">
            <h3 className="text-[15px] font-bold text-slate-800 dark:text-slate-100">Backdated target</h3>
            <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">You're setting the target to a date in the past.</p>
          </div>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] mb-4 space-y-1">
          <div><span className="text-slate-500 dark:text-slate-400">New target:</span> <span className="font-semibold text-amber-800">{newDate}</span></div>
          <div><span className="text-slate-500 dark:text-slate-400">Today:</span> <span className="font-semibold text-slate-700 dark:text-slate-200">{today}</span></div>
        </div>
        <p className="text-[12px] text-slate-600 dark:text-slate-300 mb-5">
          This change will be recorded in the project's activity log with your name and the previous target date. Continue?
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-[12px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3.5 py-1.5 rounded-lg bg-amber-600 text-white text-[12px] font-semibold hover:bg-amber-700"
          >
            Apply &amp; log
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Deliverable Tasks modal — opens when the user clicks a Gantt bar
 * (client feedback 2026-08-02 items 2 + 3). Lists every task under
 * that (zone × deliverable) with columns: Code, Name, Due date
 * (editable). Save writes each changed row via PATCH /tasks/:id and
 * flips the task's `dueDateOverridden` flag on the server. Refetches
 * planning data on close so the Gantt reflects the change.
 */
function DeliverableTasksModal({ row, onClose }: { row: any; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<number, string>>(() => {
    const seed: Record<number, string> = {};
    for (const t of row.taskList ?? []) seed[t.id] = t.endDate ?? '';
    return seed;
  });
  const [saving, setSaving] = useState(false);

  const dirty = (row.taskList ?? []).some((t: any) => (t.endDate ?? '') !== (drafts[t.id] ?? ''));

  const save = async () => {
    setSaving(true);
    try {
      const changed = (row.taskList ?? []).filter((t: any) => (t.endDate ?? '') !== (drafts[t.id] ?? ''));
      await Promise.all(
        changed.map((t: any) =>
          client.patch(`/tasks/${t.id}`, { endDate: drafts[t.id] || null }),
        ),
      );
      notify.success(`Updated ${changed.length} due date${changed.length === 1 ? '' : 's'}`);
      // Refresh planning data — the row will pick up the new dates.
      queryClient.invalidateQueries({ queryKey: ['planning'] });
      onClose();
    } catch (err: any) {
      notify.error(err?.response?.data?.message ?? 'Failed to save due dates');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[720px] max-w-[92vw] max-h-[80vh] flex flex-col rounded-[14px] bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-slate-100 dark:border-slate-800 p-5">
          <div className="min-w-0">
            <h3 className="text-[15px] font-bold text-slate-800 dark:text-slate-100 truncate">{row.deliverableName}</h3>
            <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
              {row.zoneName}
              {row.serviceName ? <span> · {row.serviceName}</span> : null}
              {row.savedDate ? <span> · target {row.savedDate}</span> : null}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 text-[18px] leading-none px-1">×</button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {(row.taskList ?? []).length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400 dark:text-slate-500 italic">No tasks under this deliverable.</div>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="bg-[#FAFBFC] sticky top-0 z-10">
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="px-4 py-2 w-[110px]">Code</th>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2 w-[110px]">Status</th>
                  <th className="px-4 py-2 w-[160px]">Due date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {(row.taskList ?? []).map((t: any) => (
                  <tr key={t.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
                    <td className="px-4 py-2 text-slate-500 dark:text-slate-400 tabular-nums">{t.code ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-800 dark:text-slate-100 truncate">{t.name}</td>
                    <td className="px-4 py-2">
                      <span className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
                        t.status === 'done' ? 'bg-emerald-100 text-emerald-700' :
                        t.status === 'in_progress' ? 'bg-blue-100 text-blue-700' :
                        t.status === 'in_review' ? 'bg-amber-100 text-amber-700' :
                        t.status === 'blocked' ? 'bg-red-100 text-red-700' :
                        'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
                      )}>{t.status}</span>
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="date"
                        value={drafts[t.id] ?? ''}
                        onChange={(e) => setDrafts((s) => ({ ...s, [t.id]: e.target.value }))}
                        className="rounded border border-slate-200 dark:border-slate-700 px-2 py-1 text-[12px] tabular-nums w-full focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 dark:border-slate-800 px-5 py-3 bg-[#FAFBFC]">
          <div className="text-[11px] text-slate-500 dark:text-slate-400">
            {row.taskList?.length ?? 0} tasks · {dirty ? 'unsaved changes' : 'up to date'}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-[12px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-900"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving}
              className="px-3.5 py-1.5 rounded-lg bg-blue-600 text-white text-[12px] font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : 'Save due dates'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
