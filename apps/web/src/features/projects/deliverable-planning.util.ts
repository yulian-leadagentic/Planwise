/**
 * Pure helpers for the Deliverable Planning tab's target drafts. Extracted
 * from the tab component so the three rules below can be unit-tested
 * independently of React:
 *
 *   1. which date a (zone × deliverable) row SHOWS            → `resolveTargetIso`
 *   2. which rows a save SENDS (and in what shape)            → `buildTargetItems`
 *   3. which pending edits SURVIVE a server refresh of `rows` → `mergeDraftsOnRefresh`
 *
 * §11 (2026-11-13) added small pure helpers next to them:
 * `explicitDirtyKeys` / `resetMonthsDraftsToSeed` /
 * `resetMonthsDraftsOfRows` (months draft of a row whose explicit date
 * was saved or committed), `withoutColFilter` / `isColFilterActive` /
 * `rowPassesColFilter` (Table column filters), `snapToSundayIso`,
 * `isCompleteIsoDate`, `taskProgressCounts`, `mergeRowOrder`,
 * `moveRowKey`.
 *
 * §12 (2026-11-14) added `canReorderOnto`, `ganttBarBox`,
 * `resolveGrouping`, `ganttRangeCaption`, `withPriorDrafts`,
 * `earliestIsoMs`, `taskStartForSave` and `taskDatesPatch`.
 *
 * §13 (2026-11-15) added `lagLabelText`, `chainArrowTooltip`,
 * `taskBarTooltip` and `clickGestureTracker`.
 *
 * §14 (2026-11-15) added the manual-due-date helpers: the `MANUAL_DUE_*`
 * texts, `manualReviewHint`, `isReviewRowListed`, `mergeReviewChoices`,
 * `reviewCheckedTaskIds`, `reviewSubtitle`, `releaseSavePlan`,
 * `toggledInSet`, and the `release` argument of `taskDatesPatch`.
 * §14b added the tasks modal's width budget (`TASKS_LIST_*`).
 *
 * §10 (2026-11-13) · Principle: the SAVED `targetDate` is the single
 * source of truth for display. Months is only an input device — a
 * months-derived preview is shown only while the user has a pending
 * months edit. Before §10 every call-site resolved
 * `explicit draft || computePreview(months draft) || savedDate`, and the
 * months draft is seeded from the server, so `months + today's base date`
 * always outranked the date that was actually saved (a drag-saved bar
 * "jumped back" on the next render).
 */

/** The slice of a Deliverable Planning row these helpers need. */
export interface TargetRowLike {
  key: string;
  deliverableId: number;
  zoneId: number | null;
  savedMonths: number | null;
  /** yyyy-mm-dd */
  savedDate: string | null;
  savedDurationWeeks: number | null;
  /** DP-EMPTY-3 synthetic rows — never dirty, never saved. */
  readOnly?: boolean;
}

/** One item of the `POST /project-deliverables/targets/batch` payload. */
export interface TargetBatchItem {
  id: number;
  zoneId: number | null;
  months: number | null;
  durationWeeks: number | null;
  /** Explicit ISO date — when present the server uses it instead of
   *  recomputing `months + baseDate`. */
  targetDate?: string;
}

/** Draft maps keyed by row key. Empty string = "cleared by the user". */
export type DraftMap = Record<string, string>;

/** Server values of one row at the time the drafts were last seeded. */
export interface DraftSeed {
  months: string;
  dur: string;
  date: string;
}
export type DraftSeedMap = Record<string, DraftSeed>;

const monthsServerOf = (r: TargetRowLike): string =>
  r.savedMonths == null ? '' : String(r.savedMonths);
const durServerOf = (r: TargetRowLike): string =>
  r.savedDurationWeeks == null ? '' : String(r.savedDurationWeeks);

/**
 * Effective target for a row:
 *   1. pending explicit-date draft (Gantt drag / modal)  — wins outright;
 *   2. pending MONTHS edit (draft differs from the server) — the preview,
 *      which may be '' when the user cleared months ("no target");
 *   3. the saved date. `computePreview` is only a fallback here for
 *      legacy rows that carry months but no date.
 */
export function resolveTargetIso(
  r: TargetRowLike,
  drafts: DraftMap,
  targetDateDrafts: DraftMap,
  computePreview: (months: string) => string,
): string {
  const explicit = targetDateDrafts[r.key];
  if (explicit) return explicit;
  const monthsDraft = drafts[r.key] ?? '';
  if (monthsDraft !== monthsServerOf(r)) return computePreview(monthsDraft);
  return r.savedDate || computePreview(monthsDraft) || '';
}

/**
 * Which dimensions of a row the user has changed vs the server.
 *
 * §11 A5 (2026-11-13) · `explicit` and `months` are never both true — a
 * row has ONE pending target edit, and it is the one `resolveTargetIso`
 * shows. A non-empty explicit-date draft is the pending edit when it
 * differs from the saved date OR when the months draft is dirty: in the
 * second case it sits on the saved date but is actively overriding a
 * pending months edit (months typed, then the bar dragged back onto the
 * saved date). `months` is then reported false, so `buildTargetItems`
 * sends the explicit date. Before, that row DISPLAYED the explicit date
 * while Save posted the months, and the bar jumped.
 */
export function rowDirtyFlags(
  r: TargetRowLike,
  drafts: DraftMap,
  durationDrafts: DraftMap,
  targetDateDrafts: DraftMap,
): { explicit: boolean; months: boolean; duration: boolean; any: boolean } {
  // Read-only (synthetic) rows never contribute to dirty state — their
  // inputs are disabled and they are excluded from every save.
  if (r.readOnly) return { explicit: false, months: false, duration: false, any: false };
  const explicitDraft = targetDateDrafts[r.key] ?? '';
  const monthsDirty = (drafts[r.key] ?? '') !== monthsServerOf(r);
  const explicit = explicitDraft !== '' && (explicitDraft !== (r.savedDate ?? '') || monthsDirty);
  const months = monthsDirty && !explicit;
  const duration = (durationDrafts[r.key] ?? '') !== durServerOf(r);
  return { explicit, months, duration, any: explicit || months || duration };
}

/**
 * Sparse batch payload — only rows the user actually changed. Sending
 * every row (the pre-§10 behaviour) made the server re-derive
 * `targetDate = months + baseDate` for rows nobody touched.
 *
 * `durationWeeks` is ALWAYS the current duration draft for a row that is
 * sent, so the aggregated (sub-zone) duration keeps converging onto the
 * top-zone row exactly as before.
 */
export function buildTargetItems(
  rows: TargetRowLike[],
  drafts: DraftMap,
  durationDrafts: DraftMap,
  targetDateDrafts: DraftMap,
  computePreview: (months: string) => string,
): TargetBatchItem[] {
  const items: TargetBatchItem[] = [];
  for (const r of rows) {
    const dirty = rowDirtyFlags(r, drafts, durationDrafts, targetDateDrafts);
    if (!dirty.any) continue;
    const durDraft = durationDrafts[r.key] ?? '';
    const durationWeeks = durDraft === '' ? null : Number(durDraft);
    if (dirty.explicit) {
      // Explicit date wins. Months is nulled: it no longer describes
      // this target, and a stale value would re-derive a different date
      // the next time the row is saved through the months path.
      items.push({
        id: r.deliverableId,
        zoneId: r.zoneId,
        months: null,
        durationWeeks,
        targetDate: targetDateDrafts[r.key],
      });
    } else if (dirty.months) {
      // Classic table flow — NO targetDate, the server computes it from
      // months + base date (and clears the target when months is null).
      const monthsDraft = drafts[r.key] ?? '';
      items.push({
        id: r.deliverableId,
        zoneId: r.zoneId,
        months: monthsDraft === '' ? null : Number(monthsDraft),
        durationWeeks,
      });
    } else {
      // Duration-only edit.
      // §11 (2026-11-13) · Pin the saved date ONLY when letting the
      // server re-derive it from months + base date would CHANGE it (no
      // months at all, or months that no longer yield the saved date).
      // An explicit `targetDate` also makes the server delete the target
      // rows of every descendant zone — a side effect a plain duration
      // edit must not have when months already produces the same date.
      const pinDate =
        Boolean(r.savedDate) &&
        (r.savedMonths == null || computePreview(String(r.savedMonths)) !== r.savedDate);
      items.push({
        id: r.deliverableId,
        zoneId: r.zoneId,
        months: r.savedMonths,
        durationWeeks,
        ...(pinDate && r.savedDate ? { targetDate: r.savedDate } : {}),
      });
    }
  }
  return items;
}

/**
 * §11 (2026-11-13) · Keys of the rows a save sends on the EXPLICIT-date
 * branch (`rowDirtyFlags(...).explicit`; read-only rows never qualify).
 * Captured together with `buildTargetItems` — i.e. when the POST is
 * built — because once such a row is saved its months draft is no longer
 * a pending edit (see `resetMonthsDraftsToSeed`).
 */
export function explicitDirtyKeys(
  rows: TargetRowLike[],
  drafts: DraftMap,
  durationDrafts: DraftMap,
  targetDateDrafts: DraftMap,
): string[] {
  const keys: string[] = [];
  for (const r of rows) {
    if (rowDirtyFlags(r, drafts, durationDrafts, targetDateDrafts).explicit) keys.push(r.key);
  }
  return keys;
}

/**
 * §11 (2026-11-13) · A row whose target was just SAVED as an explicit
 * date: put its months draft back on the server value (`seed`, '' for an
 * unknown key). `mergeDraftsOnRefresh` cannot do this on its own — it
 * only reseeds a dirty months draft when the SERVER months moved, and a
 * row that was already drag-saved has months null before and after, so a
 * typed-but-superseded "8" survived and outranked the saved date as soon
 * as the explicit-date draft was dropped.
 *
 * Duration drafts are deliberately not touched. Returns the SAME object
 * when nothing changed.
 */
export function resetMonthsDraftsToSeed(
  drafts: DraftMap,
  keys: string[],
  seed: DraftSeedMap,
): DraftMap {
  let next = drafts;
  for (const key of keys) {
    const server = seed[key]?.months ?? '';
    if ((next[key] ?? '') === server && (server !== '' || !(key in next))) continue;
    if (next === drafts) next = { ...drafts };
    // Same storage rule as the refresh merge: a clean '' is not stored.
    if (server === '') delete next[key];
    else next[key] = server;
  }
  return next;
}

/**
 * §11 A5 (2026-11-13) · "Last edit wins": an explicit date was just
 * COMMITTED for these rows (a Gantt drag was let go), so their months
 * drafts are no longer pending edits — back to each row's own server
 * months. Same reset as above, seeded from the rows themselves.
 */
export function resetMonthsDraftsOfRows(drafts: DraftMap, rows: TargetRowLike[]): DraftMap {
  if (rows.length === 0) return drafts;
  return resetMonthsDraftsToSeed(drafts, rows.map((r) => r.key), seedFromRows(rows));
}

/**
 * §11 (2026-11-13) · Table column filters. A column's filter is a list
 * of selected values; [] (or a missing entry) = no filter.
 *
 * "Select all" means NO filter — not "the values that exist right now".
 * Storing the current values kept the column "filtered (N)" and excluded
 * every value that appeared later (a row whose date changed while the
 * user was typing its months vanished mid-edit).
 */
export function withoutColFilter<K extends string>(
  filters: Record<K, string[]>,
  col: K,
): Record<K, string[]> {
  return { ...filters, [col]: [] };
}

/**
 * Does a column filter currently restrict anything? Not when it is
 * empty, and not when it holds every value the column currently offers
 * (`availableValues` — the options its dropdown lists): such a set hides
 * nothing, so the header shows the un-filtered state. This is how a full
 * set persisted by the old "Select all" reads as inactive. With no
 * available values to compare against, a non-empty set stays active.
 */
export function isColFilterActive(
  selected: readonly string[] | undefined,
  availableValues: readonly string[],
): boolean {
  if (!selected || selected.length === 0) return false;
  if (availableValues.length === 0) return true;
  const sel = new Set(selected);
  return !availableValues.every((v) => sel.has(v));
}

/**
 * One row against one column filter. A row with pending edits ALWAYS
 * passes: it must stay on screen until it is saved or reset, whatever
 * its edited value now is. (No "full set" rule needed here — a set that
 * holds every available value contains this row's value by definition.)
 */
export function rowPassesColFilter(
  value: string,
  selected: readonly string[] | undefined,
  rowDirty: boolean,
): boolean {
  if (rowDirty) return true;
  if (!selected || selected.length === 0) return true;
  return selected.includes(value);
}

/**
 * §11 (2026-11-13) · The server stores every target on a Sunday: it
 * snaps FORWARD to the next Sunday (a Sunday stays). Mirror of
 * `snapToSunday` in project-deliverables.service.ts, ISO in → ISO out,
 * so a date the client drafts is the date that comes back after Save.
 *
 * '' → ''. An unparsable value, or a year below 1000 (what a date input
 * emits while the year is still being typed), is returned unchanged.
 */
export function snapToSundayIso(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!Number.isFinite(y) || y < 1000) return iso;
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.getUTCDay(); // Sun=0..Sat=6
  date.setUTCDate(date.getUTCDate() + (day === 0 ? 0 : 7 - day));
  return date.toISOString().slice(0, 10);
}

/**
 * §11 (2026-11-13) · Is `value` a COMPLETE calendar date — exactly
 * yyyy-mm-dd, a real day, year ≥ 1000? A `<input type="date">` emits ''
 * or a short-year value (0002-…, 0020-…) while the user is still typing;
 * those are "no change yet" and must not become a target (nor a dry-run
 * anchor).
 */
export function isCompleteIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1000) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC rolls an impossible day over (02-30 → 03-02) — reject those.
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * §11 (2026-11-13) · Task-status progress of one (zone × deliverable)
 * row, on the real Prisma `TaskStatus` enum
 * (not_started | in_progress | in_review | completed | on_hold |
 * cancelled). `done` = completed; `started` = in progress, in review or
 * completed. The pre-§11 counters compared against legacy values
 * (`done` / `to_do` / `blocked`), so nothing was ever "done" and every
 * task counted as "started".
 */
export function taskProgressCounts(
  tasks: { status?: string | null }[],
): { total: number; started: number; done: number } {
  let started = 0;
  let done = 0;
  for (const t of tasks) {
    if (t.status === 'completed') {
      done += 1;
      started += 1;
    } else if (t.status === 'in_progress' || t.status === 'in_review') {
      started += 1;
    }
  }
  return { total: tasks.length, started, done };
}

/**
 * §11 (2026-11-13) · Reconcile the persisted Gantt row order with the
 * project's FULL (unfiltered) row set: every saved key that still exists
 * keeps its position — whether or not a filter currently hides it —
 * deleted rows drop out, and rows not in the saved order are appended in
 * `allKeys` order. Returns the SAME array reference when nothing changed
 * so a `setState` updater can bail out.
 */
export function mergeRowOrder(saved: string[], allKeys: string[]): string[] {
  const all = new Set(allKeys);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const k of saved) {
    if (all.has(k) && !seen.has(k)) {
      seen.add(k);
      merged.push(k);
    }
  }
  const keptCount = merged.length;
  for (const k of allKeys) {
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(k);
    }
  }
  if (keptCount === saved.length && merged.length === saved.length) return saved;
  return merged;
}

/**
 * §11 (2026-11-13) · Drag-reorder while a filter may be active. `toIndex`
 * addresses the VISIBLE rows, but `order` also holds the rows a filter
 * hides — so the drop position is resolved through the visible row that
 * sits at `toIndex` once the dragged key is taken out. With nothing
 * hidden this is exactly the old "remove, then insert at toIndex".
 */
export function moveRowKey(
  order: string[],
  visibleKeys: string[],
  fromKey: string,
  toIndex: number,
): string[] {
  const rest = order.filter((k) => k !== fromKey);
  const visibleRest = visibleKeys.filter((k) => k !== fromKey);
  const clamped = Math.max(0, Math.min(toIndex, visibleRest.length));
  let at: number;
  if (clamped < visibleRest.length) {
    at = rest.indexOf(visibleRest[clamped]);
  } else if (visibleRest.length > 0) {
    // Dropped past the last visible row → right after it.
    const last = rest.indexOf(visibleRest[visibleRest.length - 1]);
    at = last === -1 ? -1 : last + 1;
  } else {
    at = rest.length;
  }
  if (at === -1) at = rest.length;
  return [...rest.slice(0, at), fromKey, ...rest.slice(at)];
}

/**
 * §12 (2026-11-14) · Drag-reorder is a WITHIN-GROUP operation: a row can
 * only be dropped on another row of its own group. The saved order is
 * one flat list, but a row is always drawn inside its group — so a drop
 * on a foreign group changed the flat order and the row landed somewhere
 * unrelated to the drop point. `groupOf` maps row key → group key (every
 * row shares one key when the Gantt is not grouped).
 */
export function canReorderOnto(
  groupOf: ReadonlyMap<string, string>,
  fromKey: string | null,
  toKey: string,
): boolean {
  if (!fromKey || fromKey === toKey) return false;
  const from = groupOf.get(fromKey);
  return from !== undefined && from === groupOf.get(toKey);
}

/**
 * §12 (2026-11-14) · Horizontal box of a Gantt row's bar. A real duration
 * keeps the geometry it always had (left edge at the start, at least
 * `minWidthPx` wide). A ZERO-week bar had no width at all — it rendered
 * as a sliver whose drag / resize zones were clipped away — so it gets
 * `zeroWidthPx`, grown LEFTWARD: its right edge stays on the target date,
 * the one position on the bar that has to be truthful.
 */
export function ganttBarBox(
  startPx: number,
  targetPx: number,
  durationWeeks: number,
  opts: { minWidthPx: number; zeroWidthPx: number },
): { leftPx: number; widthPx: number } {
  if (durationWeeks <= 0) return { leftPx: targetPx - opts.zeroWidthPx, widthPx: opts.zeroWidthPx };
  return { leftPx: startPx, widthPx: Math.max(opts.minWidthPx, targetPx - startPx) };
}

export type GroupDim = 'zone' | 'deliverable' | 'service';

/**
 * §12 (2026-11-14) · What the Group / Sub-group picks mean for the views.
 * Primary "No grouping" used to fall back to Deliverable, i.e. it looked
 * exactly like picking Deliverable. It now means NO group level at all:
 * a flat list of rows, no group headers, nothing to collapse. The
 * sub-group pick is ignored in that case (the control hides it — a
 * sub-group of nothing has no meaning), and each row is labelled by its
 * full identity, Deliverable · Zone, which is what `outerDim` / `innerDim`
 * carry for the column headers.
 */
export function resolveGrouping(
  primary: GroupDim | null,
  secondary: GroupDim | null,
): { grouped: boolean; outerDim: GroupDim; innerDim: GroupDim | null } {
  if (primary == null) return { grouped: false, outerDim: 'deliverable', innerDim: 'zone' };
  return { grouped: true, outerDim: primary, innerDim: secondary === primary ? null : secondary };
}

const trimNumber = (n: number): string => String(Math.round(n * 10) / 10);
const plural = (n: string, unit: string): string => `${n} ${unit}${n === '1' ? '' : 's'}`;

/**
 * §12 (2026-11-14) · Caption next to the Gantt's Years / Grid selectors.
 * It used to read "Showing ~N years at a time", which was never true:
 * the Years pick sets how far the TIMELINE runs past the base date (the
 * total range — `spanDays`, which also holds a one-year look-back and
 * grows when a target lies later), while how much of it is IN VIEW
 * depends on the grid and the viewport (`visibleDays`): the Month grid
 * fits two years or more whatever the pick, Week and Day show a slice.
 * The in-view part is phrased in the grid's own unit.
 */
export function ganttRangeCaption(
  spanDays: number,
  visibleDays: number,
  granularity: 'month' | 'week' | 'day',
): string {
  const total = `Timeline spans ${plural(trimNumber(spanDays / 365), 'year')}`;
  // Not measured yet (first paint) → say only what is known.
  if (!(visibleDays > 0)) return total;
  if (visibleDays >= spanDays) return `${total}, all in view`;
  const months = visibleDays / (365 / 12);
  const inView =
    granularity === 'day' ? plural(String(Math.max(1, Math.round(visibleDays))), 'day')
    : granularity === 'week' ? plural(String(Math.max(1, Math.round(visibleDays / 7))), 'week')
    : months >= 18 ? plural(trimNumber(months / 12), 'year')
    : plural(String(Math.max(1, Math.round(months))), 'month');
  return `${total} · ~${inView} in view`;
}

/**
 * §12 (2026-11-14) · Put explicit-date drafts back to what they were
 * before a drag: the prior draft where there was one, no entry otherwise.
 * Returns the SAME object when nothing changes.
 */
export function withPriorDrafts(
  drafts: DraftMap,
  priors: readonly { key: string; priorDraft: string }[],
): DraftMap {
  let next = drafts;
  for (const { key, priorDraft } of priors) {
    if (priorDraft ? next[key] === priorDraft : !(key in next)) continue;
    if (next === drafts) next = { ...drafts };
    if (priorDraft) next[key] = priorDraft;
    else delete next[key];
  }
  return next;
}

/**
 * §12 (2026-11-14) · Earliest of a set of ISO dates, as UTC ms (null for
 * none). The rollup drag's past-date check runs on the dates it actually
 * WRITES (Sunday-snapped), not on the raw shifted ones.
 */
export function earliestIsoMs(isos: Iterable<string>): number | null {
  let earliest: number | null = null;
  for (const iso of isos) {
    const ms = new Date(iso).getTime();
    if (Number.isFinite(ms) && (earliest == null || ms < earliest)) earliest = ms;
  }
  return earliest;
}

const shiftIsoDays = (iso: string, days: number): string =>
  new Date(new Date(iso).getTime() + days * 86_400_000).toISOString().slice(0, 10);

/**
 * §12 (2026-11-14) · The START date the tasks modal saves together with
 * a task's new due date. Saving only the due date left the stored start
 * behind: after a target move tasks ended up starting AFTER they ended,
 * or with stretched durations. `undefined` = send no start key.
 *
 *   - cleared due date                     → no start;
 *   - preview-driven row (not hand-edited) → the start of the dry-run row
 *     that supplied this very due date;
 *   - hand-edited row, or no matching dry-run row → the stored start
 *     moved by the same number of days the due date moved, when both
 *     stored dates exist;
 *   - a start later than the due date is never sent.
 */
export function taskStartForSave(args: {
  /** Due date being saved ('' / null = cleared). */
  nextEnd: string | null | undefined;
  /** The user typed into this row (it is in `manualEdits`). */
  manual: boolean;
  /** Dry-run row for this task, if the scheduler returned one. */
  preview?: { startDate: string; endDate: string } | null;
  /** Stored dates before this save. */
  storedStart: string | null | undefined;
  storedEnd: string | null | undefined;
}): string | undefined {
  const { nextEnd, manual, preview, storedStart, storedEnd } = args;
  if (!nextEnd || !isCompleteIsoDate(nextEnd)) return undefined;
  let start: string | undefined;
  if (!manual && preview && preview.endDate === nextEnd && isCompleteIsoDate(preview.startDate)) {
    start = preview.startDate;
  } else if (
    storedStart && storedEnd && isCompleteIsoDate(storedStart) && isCompleteIsoDate(storedEnd)
  ) {
    const deltaDays = Math.round(
      (new Date(nextEnd).getTime() - new Date(storedEnd).getTime()) / 86_400_000,
    );
    start = shiftIsoDays(storedStart, deltaDays);
  }
  return start !== undefined && start <= nextEnd ? start : undefined;
}

/**
 * Body of the `PATCH /tasks/:id` the tasks modal sends for one row.
 * `manualDueDate`: `true` pins the task (a typed date), `false` releases
 * a pinned one back to automatic scheduling (§14), absent leaves the
 * flag alone.
 */
export interface TaskDatesPatch {
  endDate?: string | null;
  manualDueDate?: boolean;
  estimatedStartDate?: string;
}

/**
 * §12 (2026-11-14) · What the tasks modal saves for ONE task row — or
 * `null` when there is nothing to save for it.
 *
 *   - due date changed → `endDate` (null when cleared), `manualDueDate`
 *     for a hand-edited non-empty date, plus the start from
 *     `taskStartForSave` when there is one;
 *   - due date UNCHANGED → normally nothing. The one exception: a row
 *     that is not hand-edited, whose dry-run row carries this very due
 *     date but a different START than the stored one. The modal shows
 *     that proposed start, so Save writes it — start only, without
 *     `endDate` / `manualDueDate`. Before, such a row was skipped.
 *
 * §14 (2026-11-15) · `release` — the PM asked for this pinned ("manual")
 * task to go back to automatic scheduling. Its dates then come from the
 * dry-run like any other row's, and the payload carries
 * `manualDueDate: false`: with the dates when the due date changed, on
 * its own (plus a changed start) when it did not — the flag is cleared
 * even if nothing moves. A row the PM TYPED into is a manual edit and
 * wins over a release (`manualDueDate: true`). A cleared due date sends
 * `endDate: null` as before; the server clears the flag for a null date.
 */
export function taskDatesPatch(args: {
  /** The row's due-date draft ('' / null = cleared). */
  nextEnd: string | null | undefined;
  manual: boolean;
  /** §14 · release a pinned task back to automatic scheduling. */
  release?: boolean;
  preview?: { startDate: string; endDate: string } | null;
  storedStart: string | null | undefined;
  storedEnd: string | null | undefined;
}): TaskDatesPatch | null {
  const { manual, preview, storedStart, storedEnd } = args;
  const release = Boolean(args.release) && !manual;
  const end = args.nextEnd || null;
  if ((storedEnd ?? '') !== (end ?? '')) {
    const payload: TaskDatesPatch = { endDate: end };
    if (end && manual) payload.manualDueDate = true;
    else if (end && release) payload.manualDueDate = false;
    const start = taskStartForSave(args);
    if (start !== undefined) payload.estimatedStartDate = start;
    return payload;
  }
  // Due date unchanged — the scheduler's own start may still differ, and
  // a release still has to clear the flag.
  const schedulerStart =
    !manual && end && preview && preview.endDate === end ? taskStartForSave(args) : undefined;
  const startChanged = schedulerStart !== undefined && schedulerStart !== (storedStart ?? '');
  if (release) {
    return startChanged
      ? { manualDueDate: false, estimatedStartDate: schedulerStart }
      : { manualDueDate: false };
  }
  return startChanged ? { estimatedStartDate: schedulerStart } : null;
}

// ── §14 (2026-11-15) · Manual ("pinned") due dates ───────────────────
//
// A task whose due date was typed by a person (`dueDateOverridden`) does
// not move when its deliverable target moves. Nothing on screen said so,
// and nothing let the PM release it. These are the pure parts of making
// it visible and releasable; the texts are Hebrew like the "ידני" pill.

/** Hover text of the "ידני" pill / Gantt task bar of a pinned task. */
export const MANUAL_DUE_TEXT = 'תאריך ידני — לא זז כשהיעד משתנה';
/** …in a review / tasks list, for a pinned task that stays as it is. */
export const MANUAL_DUE_KEPT_TEXT = 'תאריך ידני — נשאר במקומו';
/** …and for one that is about to be recalculated from the target. */
export const MANUAL_DUE_RELEASED_TEXT = 'תאריך ידני — יחושב מחדש לפי היעד';

/**
 * The one hint line above the review table when it lists manual tasks
 * ('' for none). Their checkbox means "release and recalculate".
 */
export function manualReviewHint(manualCount: number): string {
  if (!(manualCount > 0)) return '';
  const lead = manualCount === 1 ? 'משימה אחת עם תאריך ידני' : `${manualCount} משימות עם תאריך ידני`;
  return `${lead}. מסומנת = תחושב מחדש לפי היעד ותחזור לתזמון אוטומטי. הסר סימון כדי להשאיר את התאריך הידני.`;
}

/** The slice of a reschedule-preview item the review helpers need. */
export interface ReviewItemLike {
  taskId: number;
  willMove: boolean;
  /** The task is stored as manual (`dueDateOverridden`). */
  manual?: boolean;
  beforeEnd?: string | null;
  afterEnd?: string | null;
}
export type ReviewChoices = Record<number, { apply: boolean; end: string }>;

/**
 * Which preview rows the review modal LISTS: the ones that will move, as
 * before, plus every manual task — moving or not. A pinned task that
 * stays put used to be invisible there, so the PM could not tell why it
 * had not followed the target.
 */
export function isReviewRowListed(item: ReviewItemLike): boolean {
  return item.willMove || Boolean(item.manual);
}

/**
 * Per-row choices for a (re)computed preview.
 *   - manual row → checked ⇔ it is in the release set;
 *   - other row  → keeps the PM's choice when it was listed before and
 *     still moves; a row that newly appears defaults to `willMove`.
 * With no previous preview this is the initial seed.
 */
export function mergeReviewChoices(
  prevItems: readonly ReviewItemLike[] | null,
  prevChoices: ReviewChoices,
  nextItems: readonly ReviewItemLike[],
  release: ReadonlySet<number>,
): ReviewChoices {
  const wasListed = new Set<number>();
  for (const item of prevItems ?? []) if (isReviewRowListed(item)) wasListed.add(item.taskId);
  const out: ReviewChoices = {};
  for (const item of nextItems) {
    const prev = prevChoices[item.taskId];
    const apply = item.manual
      ? release.has(item.taskId)
      : item.willMove && prev && wasListed.has(item.taskId)
        ? prev.apply
        : item.willMove;
    out[item.taskId] = { apply, end: item.afterEnd ?? item.beforeEnd ?? '' };
  }
  return out;
}

/**
 * The task ids the review's confirm writes: every LISTED row that is
 * checked. A checked manual row is sent even when its dates do not
 * change — being in both lists is what clears its manual flag.
 */
export function reviewCheckedTaskIds(
  items: readonly ReviewItemLike[],
  choices: ReviewChoices,
): number[] {
  return items
    .filter((item) => isReviewRowListed(item) && Boolean(choices[item.taskId]?.apply))
    .map((item) => item.taskId);
}

/**
 * The line under the review modal's title. The count is of tasks that
 * will MOVE, as it always was. With nothing moving but manual tasks
 * listed it used to read "אין שינויים" above a list with checked rows
 * and an enabled confirm button — that case now names the manual tasks.
 */
export function reviewSubtitle(args: {
  /** First preview still being computed (nothing to show yet). */
  computing: boolean;
  /** Preview being re-run after a manual row was released / kept. */
  recalculating: boolean;
  movingCount: number;
  manualCount: number;
}): string {
  if (args.computing) return 'מחשב תצוגה מקדימה…';
  if (args.recalculating) return 'מחשב מחדש…';
  if (args.movingCount > 0) return `${args.movingCount} משימות יזוזו · אשר להחלה`;
  if (args.manualCount > 0) {
    const manual = args.manualCount === 1 ? 'משימה אחת עם תאריך ידני' : `${args.manualCount} עם תאריך ידני`;
    return `אין משימות שיזוזו · ${manual}`;
  }
  return 'אין שינויים';
}

/**
 * Tasks modal · what Save may do with the release set right now.
 *
 *   - `waitForDryRun` — rows are released and the dry-run for the current
 *     (target, release set) has not settled yet (debounce window, or the
 *     request in flight): Save has to wait. Saving at that moment sent
 *     `manualDueDate: false` with the OLD date — the task was released
 *     but never recalculated.
 *   - `releasable` — the released rows the settled dry-run actually
 *     returned a row for. A released row WITHOUT one (the dry-run failed,
 *     or had nothing for it) is not sent as a release at all: it stays
 *     manual on this save rather than being un-pinned on its stale date.
 */
export function releaseSavePlan(args: {
  released: ReadonlySet<number>;
  /** Task ids the settled dry-run returned a row for (a Set or a Map). */
  scheduledIds: { has(id: number): boolean };
  /** A dry-run for the current (target, release set) is still pending. */
  dryRunPending: boolean;
}): { waitForDryRun: boolean; releasable: Set<number> } {
  const releasable = new Set<number>();
  if (args.released.size === 0) return { waitForDryRun: false, releasable };
  if (args.dryRunPending) return { waitForDryRun: true, releasable };
  for (const id of args.released) if (args.scheduledIds.has(id)) releasable.add(id);
  return { waitForDryRun: false, releasable };
}

// ── §14b (2026-11-15) · Width budget of the tasks modal's table ──────
//
// The table used to be an auto-layout table whose declared widths
// (108 + 110 + 110 + 200 + 180 = 708, before the Task column) could not
// fit its 720px card; it only looked right because auto layout shrank
// the columns. §14 added a pill to the Due cell and a second button to
// the Action cell — neither shrinks — so the table overflowed the card
// and the Start column was crushed to one word per line. The tasks-list
// table is now FIXED layout on an explicit budget; the Task column takes
// what is left, and never less than its floor (below that the modal body
// scrolls sideways instead of crushing columns).
//
// Every cell has 12px of padding on each side (24px per column).

/**
 * Card width of the tasks modal — its class in the tab is `w-[900px]`.
 * 898px inside the 1px borders: the fixed columns (702px) + a 196px Task
 * column — 181px of it beside a 15px vertical scrollbar, 179px beside a
 * 17px one.
 */
export const TASKS_MODAL_CARD_PX = 900;
/** Fixed column widths (px, padding included). Task = the rest. */
export const TASKS_LIST_COL_PX = {
  /**
   * 84px of content ≈ 11.6 characters of 12px mono — real task codes run
   * to 11 (`AS.AHW.1131` ≈ 79px). Anything longer ellipsizes.
   */
  code: 108,
  /** 72px: the widest status pill, "In Progress" (~68px). */
  status: 96,
  /** 72px: a yyyy-mm-dd date in 11px mono (~66px); the "pending" caption (~40px). */
  start: 96,
  /** 208px: date input (≥ 140px) + 6px gap + the "ידני" pill (~43px). */
  due: 232,
  /** 146px: "Clear" (~48px) + 6px gap + "השאר ידני" (~76–81px). */
  action: 170,
} as const;
/**
 * Floor of the Task column (140px of text before it truncates). It is
 * deliberately BELOW what the column gets at the normal card width
 * (179–196px), so the table's min-width keeps real slack: 866px against
 * 883px beside a 15px scrollbar, 881px beside a classic 17px one. A floor
 * of 180 left a 1px fit — one wider scrollbar, or a width rounded by
 * browser zoom, and the modal scrolled sideways at its normal width.
 */
export const TASKS_LIST_TASK_MIN_PX = 164;
/** min-width of the table: the fixed columns + the Task column's floor. */
export const TASKS_LIST_MIN_WIDTH_PX =
  TASKS_LIST_COL_PX.code +
  TASKS_LIST_COL_PX.status +
  TASKS_LIST_COL_PX.start +
  TASKS_LIST_COL_PX.due +
  TASKS_LIST_COL_PX.action +
  TASKS_LIST_TASK_MIN_PX;

/** Copy of `set` with `value` flipped in / out. */
export function toggledInSet<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export type LagUnit = 'WORKING_DAYS' | 'CALENDAR_DAYS';

/**
 * §13 (2026-11-15) · The short lag label drawn next to a Gantt chain
 * arrow: `+Nימ"ע` for working days, `+Nק` for calendar days. Only a
 * positive lag gets one (`null` otherwise — zero-lag arrows are bare).
 * `chainArrowTooltip` quotes this very string, so the label and its
 * explanation cannot drift apart.
 */
export function lagLabelText(lag: number, unit: LagUnit): string | null {
  if (!Number.isFinite(lag) || lag <= 0) return null;
  return unit === 'WORKING_DAYS' ? `+${lag}ימ"ע` : `+${lag}ק`;
}

/**
 * §15 (2026-11-16) · Estimated drawn width of a lag label (10px mono
 * text, generous) — the size of its invisible hover box, and the room
 * an arrow must have for the label to be drawn at all.
 */
export function lagLabelWidthPx(label: string): number {
  return label.length * 7 + 4;
}

/**
 * §15 (2026-11-16) · Does a lag label fit on its arrow? Zoomed out
 * (Month granularity, years on screen) the arrows are a few px long and
 * the labels of neighbouring arrows piled up into an unreadable blob.
 * A label is drawn only when the horizontal gap between the
 * predecessor's right edge and the successor's left edge holds it; the
 * arrow's tooltip states the lag either way.
 */
export function lagLabelFits(gapPx: number, label: string): boolean {
  return Number.isFinite(gapPx) && gapPx >= lagLabelWidthPx(label);
}

// ── §15 (2026-11-16) · Gantt row geometry ─────────────────────────────
// The labels column and the timeline column of the Gantt iterate the
// same slots side by side, but they are separate DOM columns: a label
// row only lines up with its timeline row if both have the same height.
// The timeline row grows a task strip under the deliverable bar, so its
// height is computed here once and used by BOTH columns.

/** Base row height — the deliverable bar sits at top-2 h-4 (y 8..24). */
export const GANTT_ROW_BASE_PX = 32;
/** Height of one task sub-bar. */
export const GANTT_TASK_BAR_H = 6;
/** Vertical gap between task lanes. */
export const GANTT_TASK_LANE_GAP = 4;
/** y of the first task lane: 8 (top pad) + 16 (bar) + 4 (gap). */
export const GANTT_TASK_STRIP_TOP = 28;

/** One task sub-bar of a Gantt row, with its lane (−1 = no span, not drawn). */
export interface GanttTaskBarItem {
  id: number;
  code: string | null;
  name: string;
  hasSpan: boolean;
  startMs: number;
  endMs: number;
  lane: number;
  onCriticalPath: boolean;
  /** §14 (2026-11-15) · pinned due date — said in the bar's tooltip. */
  manual: boolean;
  deps: Array<{ predId: number; lag: number; lagUnit: LagUnit }>;
}

/** The fields of a row's `taskList` entry that the sub-bars read. */
interface GanttTaskLike {
  id?: unknown;
  code?: string | null;
  name?: string | null;
  estimatedStartDate?: string | null;
  endDate?: string | null;
  onCriticalPath?: unknown;
  dueDateOverridden?: unknown;
  dependencies?: unknown;
}

interface GanttTaskDepLike {
  dependsOnId?: unknown;
  dependsOn?: { id?: unknown } | null;
  lag?: unknown;
  lagUnit?: unknown;
}

/**
 * §15 (2026-11-16) · The task sub-bars of one Gantt row and their lanes.
 * Only a task with a valid span (start ≤ end, both dates parse) gets a
 * lane; those are taken in start order and each goes into the first
 * lane whose last bar ends on or before its start (greedy), else a new
 * lane. `laneCount` is the number of lanes used.
 */
export function ganttTaskBarLanes(taskList: unknown): {
  items: GanttTaskBarItem[];
  laneCount: number;
} {
  const list: GanttTaskLike[] = Array.isArray(taskList) ? taskList : [];
  if (list.length === 0) return { items: [], laneCount: 0 };
  const items: GanttTaskBarItem[] = list.map((t) => {
    const sIso = t.estimatedStartDate ?? null;
    const eIso = t.endDate ?? null;
    const sMs = sIso ? new Date(sIso).getTime() : NaN;
    const eMs = eIso ? new Date(eIso).getTime() : NaN;
    const hasSpan = Number.isFinite(sMs) && Number.isFinite(eMs) && eMs >= sMs;
    return {
      id: Number(t.id),
      code: t.code ?? null,
      name: t.name ?? `#${t.id}`,
      hasSpan,
      startMs: hasSpan ? sMs : NaN,
      endMs: hasSpan ? eMs : NaN,
      lane: -1,
      onCriticalPath: Boolean(t.onCriticalPath),
      manual: Boolean(t.dueDateOverridden),
      deps: (Array.isArray(t.dependencies) ? (t.dependencies as GanttTaskDepLike[]) : [])
        .map((d) => ({
          predId: Number(d?.dependsOnId ?? d?.dependsOn?.id ?? 0),
          lag: Number(d?.lag ?? 0),
          lagUnit: (d?.lagUnit === 'CALENDAR_DAYS' ? 'CALENDAR_DAYS' : 'WORKING_DAYS') as LagUnit,
        }))
        .filter((d: { predId: number }) => d.predId > 0),
    };
  });
  const sortable = items.filter((i) => i.hasSpan);
  sortable.sort((a, b) => a.startMs - b.startMs);
  const laneEnds: number[] = [];
  for (const it of sortable) {
    let placed = false;
    for (let li = 0; li < laneEnds.length; li++) {
      if (laneEnds[li] <= it.startMs) {
        it.lane = li;
        laneEnds[li] = it.endMs;
        placed = true;
        break;
      }
    }
    if (!placed) {
      it.lane = laneEnds.length;
      laneEnds.push(it.endMs);
    }
  }
  return { items, laneCount: laneEnds.length };
}

/**
 * §15 (2026-11-16) · Height of one Gantt zone row — the timeline row
 * AND its label row. The base 32px, unless the row has a target (a row
 * without one draws no bar and no strip) and task bars are shown and at
 * least one task has a lane: then the strip's lanes plus 4px below,
 * i.e. 28 + laneCount × 10.
 */
export function ganttRowHeightPx(args: {
  hasTarget: boolean;
  showTaskBars: boolean;
  laneCount: number;
}): number {
  if (!args.hasTarget || !args.showTaskBars || args.laneCount <= 0) return GANTT_ROW_BASE_PX;
  const stripHeight = args.laneCount * (GANTT_TASK_BAR_H + GANTT_TASK_LANE_GAP) - GANTT_TASK_LANE_GAP;
  return GANTT_TASK_STRIP_TOP + stripHeight + 4;
}

const lagDaysPhrase = (days: number, unit: LagUnit): string =>
  unit === 'WORKING_DAYS'
    ? (days === 1 ? 'יום עבודה אחד' : `${days} ימי עבודה`)
    : (days === 1 ? 'יום קלנדרי אחד' : `${days} ימים קלנדריים`);

/**
 * §13 (2026-11-15) · Hover text of one chain arrow (and of its lag
 * label) in the Gantt's per-row task overlay. Nothing on screen said
 * what a small `+7ק` with a dashed arrow into a task bar meant. One line
 * each, in Hebrew like the label it explains:
 *
 *   1. the dependency — successor starts after the predecessor ends
 *      (a task is named by its code, or by its name when it has none);
 *   2. the lag — spelled out, with the drawn label in parentheses; "no
 *      lag" for 0; a negative lag reads as a lead (no label is drawn);
 *   3. only for the dashed stub — why the predecessor has no bar;
 *   4. only for an arrow drawn as critical — "on the critical path".
 *
 * The U+200E before the quoted label keeps its `+N` reading left-to-right
 * inside the right-to-left sentence.
 */
export function chainArrowTooltip(args: {
  succ: { code?: string | null; name: string };
  pred: { code?: string | null; name: string };
  lag: number;
  lagUnit: LagUnit;
  /** False for the dashed stub: the predecessor has no drawable span. */
  predHasSpan: boolean;
  /** The arrow is drawn in the critical-path colour. */
  critical: boolean;
}): string {
  const ref = (t: { code?: string | null; name: string }): string => t.code || t.name;
  const pred = ref(args.pred);
  const lag = Number.isFinite(args.lag) ? args.lag : 0;
  const label = lagLabelText(lag, args.lagUnit);
  const lines = [`תלות: ${ref(args.succ)} מתחילה אחרי סיום ${pred}`];
  if (label) lines.push(`השהיה: ${lagDaysPhrase(lag, args.lagUnit)} (‎${label})`);
  else if (lag < 0) lines.push(`הקדמה: ${lagDaysPhrase(-lag, args.lagUnit)} לפני הסיום`);
  else lines.push('ללא השהיה');
  if (!args.predHasSpan) {
    lines.push(
      `ל-${pred} אין תאריך התחלה (או שההתחלה מאוחרת מהסיום), ולכן אין לה פס. החץ המקווקו מסמן רק את התלות הנכנסת.`,
    );
  }
  if (args.critical) lines.push('על הנתיב הקריטי');
  return lines.join('\n');
}

/**
 * §13 (2026-11-15) · Hover text of a task sub-bar in the same overlay:
 * `<code> · <name> · <start> → <end>` (+ the critical-path suffix it
 * always had). The dates were missing — the bar's position was the only
 * hint of when the task runs.
 *
 * §14 (2026-11-15) · A pinned ("manual") task gets a second line saying
 * so — it is why that bar stays behind when the target moves.
 */
export function taskBarTooltip(args: {
  code?: string | null;
  name: string;
  startIso: string;
  endIso: string;
  critical: boolean;
  manual?: boolean;
}): string {
  const line = `${args.code ? `${args.code} · ` : ''}${args.name} · ${args.startIso} → ${args.endIso}${args.critical ? ' · critical path' : ''}`;
  return args.manual ? `${line}\n${MANUAL_DUE_TEXT}` : line;
}

/**
 * §13 (2026-11-15) · Click or drag? A pointer gesture counts as a CLICK
 * only if the pointer never left the slop radius during the WHOLE
 * gesture. The Gantt used to look at the release point alone, so a drag
 * that went out and came back to where it started was read as a click —
 * the group collapsed under the user, or the tasks modal opened.
 * Feed it every pointermove; ask on pointerup.
 */
export function clickGestureTracker(startX: number, slopPx: number): {
  move: (x: number) => void;
  endsAsClick: (x: number) => boolean;
} {
  let maxExcursion = 0;
  const move = (x: number) => {
    maxExcursion = Math.max(maxExcursion, Math.abs(x - startX));
  };
  return {
    move,
    endsAsClick: (x: number) => {
      move(x);
      return maxExcursion < slopPx;
    },
  };
}

/** Snapshot of the server values the drafts are (re)seeded from. */
export function seedFromRows(rows: TargetRowLike[]): DraftSeedMap {
  const seed: DraftSeedMap = {};
  for (const r of rows) {
    seed[r.key] = { months: monthsServerOf(r), dur: durServerOf(r), date: r.savedDate ?? '' };
  }
  return seed;
}

/**
 * Months / duration share one rule. A draft is a PENDING USER EDIT when
 * it differs from the server value it was seeded from; it survives a
 * refresh only while that server value is unchanged. Once the server
 * value moved (the edit was saved, superseded by an explicit-date save
 * that nulls months, or changed by someone else) the draft is reseeded
 * from the new authoritative value — same guard the explicit-date drafts
 * use below.
 */
function mergeValueDrafts(
  prevSeed: DraftSeedMap,
  nextSeed: DraftSeedMap,
  current: DraftMap,
  field: 'months' | 'dur',
): DraftMap {
  const out: DraftMap = {};
  for (const key of Object.keys(nextSeed)) {
    const next = nextSeed[key][field];
    const prev = prevSeed[key];
    const cur = current[key] ?? '';
    const userDirty = prev != null && cur !== prev[field];
    const keep = userDirty && prev[field] === next;
    const value = keep ? cur : next;
    // `keep` with '' = the user cleared the input; store the explicit ''
    // so the pending clear survives.
    if (value !== '' || keep) out[key] = value;
  }
  return out;
}

/**
 * Merge drafts when `rows` refresh: keep the user's pending edits,
 * reseed the clean ones. Iterates `nextSeed` only, so rows that no
 * longer exist drop out. `prevSeed` is the seed the CURRENT drafts were
 * last reconciled against; a key missing from it (first seed / new row)
 * gets a plain seed and no explicit-date draft.
 *
 * Months and duration are merged independently of everything else —
 * callers may rely on that (the tab applies each one inside its own
 * functional `setState` updater, passing `{}` for the other maps).
 *
 * §11 A5 (2026-11-13) · The explicit-date merge is the exception: it
 * also reads the MONTHS drafts, so a caller that wants `targetDateDrafts`
 * must pass the real months drafts. An explicit draft that equals the
 * server date is normally "no longer an edit" and dropped — but not while
 * that row's months draft is still a pending edit after this merge: it is
 * then the thing holding the display on that date (see `rowDirtyFlags`),
 * and dropping it would let the months preview pop back on any
 * background refetch.
 */
export function mergeDraftsOnRefresh(
  prevSeed: DraftSeedMap,
  nextSeed: DraftSeedMap,
  drafts: DraftMap,
  durationDrafts: DraftMap,
  targetDateDrafts: DraftMap,
): { drafts: DraftMap; durationDrafts: DraftMap; targetDateDrafts: DraftMap } {
  const nextDrafts = mergeValueDrafts(prevSeed, nextSeed, drafts, 'months');
  const nextTargetDateDrafts: DraftMap = {};
  for (const key of Object.keys(nextSeed)) {
    const d = targetDateDrafts[key];
    const prev = prevSeed[key];
    if (!d || prev == null) continue;
    const serverDate = nextSeed[key].date;
    // Keep a pending drag only while the server date it was dragged away
    // from is unchanged. A changed server date is the new authoritative
    // value; a draft equal to it is no longer an edit…
    const pendingDrag = prev.date === serverDate && d !== serverDate;
    // …unless it is overriding a months edit that is still pending.
    const overridesMonths = d === serverDate && (nextDrafts[key] ?? '') !== nextSeed[key].months;
    if (pendingDrag || overridesMonths) nextTargetDateDrafts[key] = d;
  }
  return {
    drafts: nextDrafts,
    durationDrafts: mergeValueDrafts(prevSeed, nextSeed, durationDrafts, 'dur'),
    targetDateDrafts: nextTargetDateDrafts,
  };
}

/** Shallow equality for draft maps — lets `setState` updaters bail out
 *  (return the previous object) when a merge changed nothing. */
export function sameDraftMap(a: DraftMap, b: DraftMap): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || a[k] !== b[k]) return false;
  }
  return true;
}
