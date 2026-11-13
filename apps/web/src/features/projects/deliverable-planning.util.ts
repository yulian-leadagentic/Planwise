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
