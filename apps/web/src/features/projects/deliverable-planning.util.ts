/**
 * Pure helpers for the Deliverable Planning tab's target drafts. Extracted
 * from the tab component so the three rules below can be unit-tested
 * independently of React:
 *
 *   1. which date a (zone × deliverable) row SHOWS            → `resolveTargetIso`
 *   2. which rows a save SENDS (and in what shape)            → `buildTargetItems`
 *   3. which pending edits SURVIVE a server refresh of `rows` → `mergeDraftsOnRefresh`
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

/** Which dimensions of a row the user has changed vs the server. */
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
  const explicit = explicitDraft !== '' && explicitDraft !== (r.savedDate ?? '');
  const months = (drafts[r.key] ?? '') !== monthsServerOf(r);
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
      // Duration-only edit — pin the saved date so the server does not
      // re-derive it from months + today's base date.
      items.push({
        id: r.deliverableId,
        zoneId: r.zoneId,
        months: r.savedMonths,
        durationWeeks,
        ...(r.savedDate ? { targetDate: r.savedDate } : {}),
      });
    }
  }
  return items;
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
 * The three dimensions are merged independently of each other — callers
 * may rely on that (the tab applies each one inside its own functional
 * `setState` updater).
 */
export function mergeDraftsOnRefresh(
  prevSeed: DraftSeedMap,
  nextSeed: DraftSeedMap,
  drafts: DraftMap,
  durationDrafts: DraftMap,
  targetDateDrafts: DraftMap,
): { drafts: DraftMap; durationDrafts: DraftMap; targetDateDrafts: DraftMap } {
  const nextTargetDateDrafts: DraftMap = {};
  for (const key of Object.keys(nextSeed)) {
    const d = targetDateDrafts[key];
    const prev = prevSeed[key];
    // Keep a pending drag only while the server date it was dragged away
    // from is unchanged. A changed server date is the new authoritative
    // value; a draft equal to it is no longer an edit.
    if (d && prev != null && prev.date === nextSeed[key].date && d !== nextSeed[key].date) {
      nextTargetDateDrafts[key] = d;
    }
  }
  return {
    drafts: mergeValueDrafts(prevSeed, nextSeed, drafts, 'months'),
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
