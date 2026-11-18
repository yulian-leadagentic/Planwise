import {
  resolveTargetIso,
  rowDirtyFlags,
  buildTargetItems,
  seedFromRows,
  mergeDraftsOnRefresh,
  sameDraftMap,
  snapToSundayIso,
  isCompleteIsoDate,
  taskProgressCounts,
  mergeRowOrder,
  moveRowKey,
  explicitDirtyKeys,
  resetMonthsDraftsToSeed,
  resetMonthsDraftsOfRows,
  withoutColFilter,
  isColFilterActive,
  rowPassesColFilter,
  canReorderOnto,
  ganttBarBox,
  resolveGrouping,
  ganttRangeCaption,
  withPriorDrafts,
  earliestIsoMs,
  taskStartForSave,
  taskDatesPatch,
  lagLabelText,
  chainArrowTooltip,
  taskBarTooltip,
  clickGestureTracker,
  MANUAL_DUE_TEXT,
  MANUAL_DUE_KEPT_TEXT,
  MANUAL_DUE_RELEASED_TEXT,
  manualReviewHint,
  isReviewRowListed,
  mergeReviewChoices,
  reviewCheckedTaskIds,
  reviewSubtitle,
  releaseSavePlan,
  toggledInSet,
  TASKS_MODAL_CARD_PX,
  TASKS_LIST_COL_PX,
  TASKS_LIST_TASK_MIN_PX,
  TASKS_LIST_MIN_WIDTH_PX,
  lagLabelWidthPx,
  lagLabelFits,
  ganttTaskBarLanes,
  ganttRowHeightPx,
  GANTT_ROW_BASE_PX,
  GANTT_TASK_BAR_H,
  GANTT_TASK_LANE_GAP,
  GANTT_TASK_STRIP_TOP,
  type TargetRowLike,
  buildDpTree,
  resolveLeafSavedTarget,
  flattenZoneTree,
  zoneNodeKey,
  deliverableKeyOf,
  rowProjectDeliverableIds,
  mergeDryRunPayloads,
  type DpDeliverableInput,
  type DpLeaf,
  type DpTaskInput,
  type DpZoneInput,
} from './deliverable-planning.util';

// Trivial fake of the tab's `computePreview` (months + base date → ISO).
const computePreview = (m: string) => (m === '' ? '' : `PREVIEW(${m})`);

const row = (over: Partial<TargetRowLike> = {}): TargetRowLike => ({
  key: '10:topzone-1',
  deliverableId: 10,
  zoneId: 1,
  savedMonths: null,
  savedDate: null,
  savedDurationWeeks: null,
  ...over,
});

describe('resolveTargetIso', () => {
  it('REGRESSION: a drag-saved date wins over the stale saved months (clean drafts)', () => {
    // Server after a Gantt drag-save: targetDate moved, targetMonths still
    // the old 6. The months draft is seeded from the server ("6"), so it
    // is CLEAN — the bar must sit on the saved date, not on base + 6mo.
    const r = row({ savedDate: '2026-12-13', savedMonths: 6 });
    expect(resolveTargetIso(r, { [r.key]: '6' }, {}, computePreview)).toBe('2026-12-13');
  });

  it('an explicit-date draft wins over everything', () => {
    const r = row({ savedDate: '2026-12-13', savedMonths: 6 });
    expect(
      resolveTargetIso(r, { [r.key]: '9' }, { [r.key]: '2027-01-10' }, computePreview),
    ).toBe('2027-01-10');
  });

  it('an EMPTY explicit-date draft is ignored (bar click writes "" back)', () => {
    const r = row({ savedDate: '2026-12-13', savedMonths: 6 });
    expect(resolveTargetIso(r, { [r.key]: '6' }, { [r.key]: '' }, computePreview)).toBe('2026-12-13');
  });

  it('a dirty months draft shows the months preview', () => {
    const r = row({ savedDate: '2026-12-13', savedMonths: 6 });
    expect(resolveTargetIso(r, { [r.key]: '8' }, {}, computePreview)).toBe('PREVIEW(8)');
  });

  it('a first months edit on a row with no saved target shows the preview', () => {
    const r = row();
    expect(resolveTargetIso(r, { [r.key]: '3' }, {}, computePreview)).toBe('PREVIEW(3)');
  });

  it('cleared months resolves to "" (= no target), not the saved date', () => {
    const r = row({ savedDate: '2026-12-13', savedMonths: 6 });
    expect(resolveTargetIso(r, { [r.key]: '' }, {}, computePreview)).toBe('');
    // A missing draft key reads the same as an explicit ''.
    expect(resolveTargetIso(r, {}, {}, computePreview)).toBe('');
  });

  it('legacy row with months but no date falls back to the preview', () => {
    const r = row({ savedDate: null, savedMonths: 4 });
    expect(resolveTargetIso(r, { [r.key]: '4' }, {}, computePreview)).toBe('PREVIEW(4)');
  });

  it('no months, no date, no drafts → ""', () => {
    expect(resolveTargetIso(row(), {}, {}, computePreview)).toBe('');
  });

  it('saved date without months (post-drag state) resolves to the saved date', () => {
    const r = row({ savedDate: '2026-12-13', savedMonths: null });
    expect(resolveTargetIso(r, {}, {}, computePreview)).toBe('2026-12-13');
  });
});

describe('rowDirtyFlags', () => {
  const r = row({ savedDate: '2026-12-13', savedMonths: 6, savedDurationWeeks: 4 });
  const clean = { drafts: { [r.key]: '6' }, dur: { [r.key]: '4' } };

  it('clean row → nothing dirty', () => {
    expect(rowDirtyFlags(r, clean.drafts, clean.dur, {})).toEqual({
      explicit: false, months: false, duration: false, any: false,
    });
  });

  it('flags each dimension independently', () => {
    expect(rowDirtyFlags(r, { [r.key]: '7' }, clean.dur, {})).toMatchObject({ months: true, duration: false, explicit: false, any: true });
    expect(rowDirtyFlags(r, clean.drafts, { [r.key]: '5' }, {})).toMatchObject({ months: false, duration: true, explicit: false, any: true });
    expect(rowDirtyFlags(r, clean.drafts, clean.dur, { [r.key]: '2027-01-10' })).toMatchObject({ months: false, duration: false, explicit: true, any: true });
  });

  it('an explicit draft equal to the saved date (or empty) is not dirty', () => {
    expect(rowDirtyFlags(r, clean.drafts, clean.dur, { [r.key]: '2026-12-13' }).any).toBe(false);
    expect(rowDirtyFlags(r, clean.drafts, clean.dur, { [r.key]: '' }).any).toBe(false);
  });

  it('read-only rows are never dirty', () => {
    const ro = row({ readOnly: true });
    expect(
      rowDirtyFlags(ro, { [ro.key]: '9' }, { [ro.key]: '9' }, { [ro.key]: '2027-01-10' }),
    ).toEqual({ explicit: false, months: false, duration: false, any: false });
  });

  // §11 A5 · one pending target edit per row — the one that is displayed.
  it('A5: an explicit draft ON the saved date is `explicit` while it overrides a dirty months draft', () => {
    // Months 8 typed, then the bar dragged back onto the saved date.
    expect(rowDirtyFlags(r, { [r.key]: '8' }, clean.dur, { [r.key]: '2026-12-13' })).toEqual({
      explicit: true, months: false, duration: false, any: true,
    });
  });

  it('A5: explicit and months are never both true', () => {
    // Explicit draft away from the saved date + a dirty months draft.
    expect(rowDirtyFlags(r, { [r.key]: '8' }, clean.dur, { [r.key]: '2027-01-10' })).toEqual({
      explicit: true, months: false, duration: false, any: true,
    });
    // No explicit draft (missing or '') → the months edit is the pending one.
    expect(rowDirtyFlags(r, { [r.key]: '8' }, clean.dur, {})).toMatchObject({ explicit: false, months: true });
    expect(rowDirtyFlags(r, { [r.key]: '8' }, clean.dur, { [r.key]: '' })).toMatchObject({ explicit: false, months: true });
  });

  it('A5: what is DISPLAYED is what is SAVED (repro 1: months typed, bar dragged back to the saved date)', () => {
    const k = row({ key: '20:topzone-9', deliverableId: 20, zoneId: 9, savedDate: '2027-07-04', savedMonths: null });
    const drafts = { [k.key]: '8' };
    const dates = { [k.key]: '2027-07-04' };
    expect(resolveTargetIso(k, drafts, dates, computePreview)).toBe('2027-07-04');
    // Used to post `{ months: 8 }` → the server stored months + base date.
    expect(buildTargetItems([k], drafts, {}, dates, computePreview)).toEqual([
      { id: 20, zoneId: 9, months: null, durationWeeks: null, targetDate: '2027-07-04' },
    ]);
    expect(explicitDirtyKeys([k], drafts, {}, dates)).toEqual([k.key]);
  });
});

describe('buildTargetItems', () => {
  const a = row({ key: '10:topzone-1', deliverableId: 10, zoneId: 1, savedDate: '2026-12-13', savedMonths: 6, savedDurationWeeks: 4 });
  const b = row({ key: '11:topzone-2', deliverableId: 11, zoneId: 2, savedDate: '2027-03-07', savedMonths: 9, savedDurationWeeks: null });
  const c = row({ key: '12:root', deliverableId: 12, zoneId: null, savedDate: null, savedMonths: null, savedDurationWeeks: null });
  const rows = [a, b, c];
  const cleanDrafts = { [a.key]: '6', [b.key]: '9' };
  const cleanDur = { [a.key]: '4' };
  // The module-level fake never reproduces a saved date, i.e. every
  // row's months reads as STALE. `consistentPreview` is the opposite:
  // months + base date still lands exactly on the saved date.
  const consistentPreview = (m: string) =>
    m === '6' ? '2026-12-13' : m === '9' ? '2027-03-07' : '';

  it('returns [] when nothing is dirty', () => {
    expect(buildTargetItems(rows, cleanDrafts, cleanDur, {}, computePreview)).toEqual([]);
  });

  it('sends ONLY the rows the user changed', () => {
    const items = buildTargetItems(rows, { ...cleanDrafts, [b.key]: '10' }, cleanDur, {}, computePreview);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(11);
  });

  it('skips read-only rows even when they carry drafts', () => {
    const ro = row({ key: '-1:root', deliverableId: -1, zoneId: null, readOnly: true });
    expect(
      buildTargetItems([ro], { [ro.key]: '3' }, { [ro.key]: '2' }, { [ro.key]: '2027-01-10' }, computePreview),
    ).toEqual([]);
  });

  it('explicit-date edit → targetDate + months nulled, duration from the draft', () => {
    const items = buildTargetItems(rows, cleanDrafts, cleanDur, { [a.key]: '2027-01-10' }, computePreview);
    expect(items).toEqual([
      { id: 10, zoneId: 1, months: null, durationWeeks: 4, targetDate: '2027-01-10' },
    ]);
  });

  it('explicit-date edit wins over a dirty months draft on the same row', () => {
    const items = buildTargetItems(rows, { ...cleanDrafts, [a.key]: '8' }, cleanDur, { [a.key]: '2027-01-10' }, computePreview);
    expect(items).toEqual([
      { id: 10, zoneId: 1, months: null, durationWeeks: 4, targetDate: '2027-01-10' },
    ]);
  });

  it('months edit → months as a number and NO targetDate key', () => {
    const items = buildTargetItems(rows, { ...cleanDrafts, [a.key]: '8' }, cleanDur, {}, computePreview);
    expect(items).toEqual([{ id: 10, zoneId: 1, months: 8, durationWeeks: 4 }]);
    expect('targetDate' in items[0]).toBe(false);
  });

  it('cleared months → months null and NO targetDate (server clears the target)', () => {
    const items = buildTargetItems(rows, { ...cleanDrafts, [a.key]: '' }, cleanDur, {}, computePreview);
    expect(items).toEqual([{ id: 10, zoneId: 1, months: null, durationWeeks: 4 }]);
    expect('targetDate' in items[0]).toBe(false);
  });

  // §11 R1 · duration-only edits pin the date only when they have to.
  it('duration-only edit, months still yields the saved date → NO targetDate (server re-derives the same date)', () => {
    const items = buildTargetItems(rows, cleanDrafts, { ...cleanDur, [a.key]: '6' }, {}, consistentPreview);
    expect(items).toEqual([{ id: 10, zoneId: 1, months: 6, durationWeeks: 6 }]);
    expect('targetDate' in items[0]).toBe(false);
  });

  it('duration-only edit, saved date but NO saved months (post-drag row) → date pinned', () => {
    const d = row({ key: '13:topzone-3', deliverableId: 13, zoneId: 3, savedDate: '2026-12-13', savedMonths: null, savedDurationWeeks: 4 });
    // `consistentPreview` must not even be consulted to un-pin this one.
    const items = buildTargetItems([d], {}, { [d.key]: '6' }, {}, consistentPreview);
    expect(items).toEqual([
      { id: 13, zoneId: 3, months: null, durationWeeks: 6, targetDate: '2026-12-13' },
    ]);
  });

  it('duration-only edit, STALE months (preview ≠ saved date) → date pinned, months kept', () => {
    const items = buildTargetItems(rows, cleanDrafts, { ...cleanDur, [a.key]: '6' }, {}, computePreview);
    expect(items).toEqual([
      { id: 10, zoneId: 1, months: 6, durationWeeks: 6, targetDate: '2026-12-13' },
    ]);
  });

  it('duration-only edit on a row with no saved date and no months → { months: null, durationWeeks }', () => {
    const items = buildTargetItems(rows, cleanDrafts, { ...cleanDur, [c.key]: '3' }, {}, computePreview);
    expect(items).toEqual([{ id: 12, zoneId: null, months: null, durationWeeks: 3 }]);
    expect('targetDate' in items[0]).toBe(false);
  });

  it('cleared duration → durationWeeks null (same pin rule)', () => {
    expect(buildTargetItems(rows, cleanDrafts, { [a.key]: '' }, {}, computePreview)).toEqual([
      { id: 10, zoneId: 1, months: 6, durationWeeks: null, targetDate: '2026-12-13' },
    ]);
    expect(buildTargetItems(rows, cleanDrafts, { [a.key]: '' }, {}, consistentPreview)).toEqual([
      { id: 10, zoneId: 1, months: 6, durationWeeks: null },
    ]);
  });
});

describe('explicitDirtyKeys', () => {
  const a = row({ key: '10:topzone-1', deliverableId: 10, zoneId: 1, savedDate: '2026-12-13', savedMonths: 6, savedDurationWeeks: 4 });
  const b = row({ key: '11:topzone-2', deliverableId: 11, zoneId: 2, savedDate: '2027-03-07', savedMonths: null, savedDurationWeeks: null });
  const rows = [a, b];
  const cleanDrafts = { [a.key]: '6' };
  const cleanDur = { [a.key]: '4' };

  it('a row with a dirty explicit-date draft is included', () => {
    expect(explicitDirtyKeys(rows, cleanDrafts, cleanDur, { [b.key]: '2027-07-11' })).toEqual([b.key]);
    // …also when the same row carries a pending months edit (the A4 repro).
    expect(
      explicitDirtyKeys(rows, { ...cleanDrafts, [b.key]: '8' }, cleanDur, { [b.key]: '2027-07-11' }),
    ).toEqual([b.key]);
  });

  it('months-only and duration-only edits are not included', () => {
    expect(explicitDirtyKeys(rows, { ...cleanDrafts, [b.key]: '8' }, cleanDur, {})).toEqual([]);
    expect(explicitDirtyKeys(rows, cleanDrafts, { ...cleanDur, [a.key]: '6' }, {})).toEqual([]);
  });

  it('read-only rows are never included', () => {
    const ro = row({ key: '-1:root', deliverableId: -1, zoneId: null, readOnly: true });
    expect(explicitDirtyKeys([ro], {}, {}, { [ro.key]: '2027-01-10' })).toEqual([]);
  });

  it('an explicit draft equal to the saved date (or empty) is not included', () => {
    expect(explicitDirtyKeys(rows, cleanDrafts, cleanDur, { [a.key]: '2026-12-13', [b.key]: '' })).toEqual([]);
  });

  it('returns the keys in row order', () => {
    expect(
      explicitDirtyKeys(rows, cleanDrafts, cleanDur, { [b.key]: '2027-07-11', [a.key]: '2027-01-10' }),
    ).toEqual([a.key, b.key]);
  });
});

describe('resetMonthsDraftsToSeed', () => {
  const K = '10:topzone-1';
  const OTHER = '11:topzone-2';
  const seed = (months: string) => ({ months, dur: '', date: '2027-07-11' });

  it('A4: a superseded months draft is dropped when the server months is (still) null', () => {
    const drafts = { [K]: '8', [OTHER]: '3' };
    expect(resetMonthsDraftsToSeed(drafts, [K], { [K]: seed(''), [OTHER]: seed('') })).toEqual({ [OTHER]: '3' });
  });

  it('goes back to the server value when that is not empty', () => {
    expect(resetMonthsDraftsToSeed({ [K]: '8' }, [K], { [K]: seed('6') })).toEqual({ [K]: '6' });
    expect(resetMonthsDraftsToSeed({}, [K], { [K]: seed('6') })).toEqual({ [K]: '6' });
  });

  it('a pending CLEAR ("" stored explicitly) is dropped too', () => {
    const out = resetMonthsDraftsToSeed({ [K]: '' }, [K], { [K]: seed('') });
    expect(K in out).toBe(false);
  });

  it('a key missing from the seed reads as ""', () => {
    expect(resetMonthsDraftsToSeed({ [K]: '8' }, [K], {})).toEqual({});
  });

  it('returns the SAME object when nothing changes, and never touches other keys', () => {
    const drafts = { [K]: '6', [OTHER]: '3' };
    expect(resetMonthsDraftsToSeed(drafts, [K], { [K]: seed('6') })).toBe(drafts);
    expect(resetMonthsDraftsToSeed(drafts, [], { [K]: seed('') })).toBe(drafts);
    const clean = { [OTHER]: '3' };
    expect(resetMonthsDraftsToSeed(clean, [K], { [K]: seed('') })).toBe(clean);
  });

  it('end to end with resolveTargetIso: after the reset the SAVED date shows, not the months preview', () => {
    // Saved months already null (drag-saved earlier); the user typed 8,
    // then dragged + saved 2027-07-11. Explicit-date draft is gone.
    const r = row({ key: K, savedDate: '2027-07-11', savedMonths: null });
    const stale = { [K]: '8' };
    expect(resolveTargetIso(r, stale, {}, computePreview)).toBe('PREVIEW(8)'); // the bug
    const healed = resetMonthsDraftsToSeed(stale, [K], seedFromRows([r]));
    expect(resolveTargetIso(r, healed, {}, computePreview)).toBe('2027-07-11');
    expect(rowDirtyFlags(r, healed, {}, {}).any).toBe(false);
  });
});

describe('resetMonthsDraftsOfRows', () => {
  const a = row({ key: '10:topzone-1', savedDate: '2027-07-04', savedMonths: null });
  const b = row({ key: '11:topzone-2', savedDate: '2027-03-07', savedMonths: 6 });

  it('puts each given row back on ITS server months, leaves the others alone', () => {
    const drafts = { [a.key]: '8', [b.key]: '9', other: '3' };
    expect(resetMonthsDraftsOfRows(drafts, [a, b])).toEqual({ [b.key]: '6', other: '3' });
    expect(resetMonthsDraftsOfRows(drafts, [a])).toEqual({ [b.key]: '9', other: '3' });
  });

  it('returns the SAME object for no rows / nothing to change', () => {
    const drafts = { [b.key]: '6' };
    expect(resetMonthsDraftsOfRows(drafts, [])).toBe(drafts);
    expect(resetMonthsDraftsOfRows(drafts, [a, b])).toBe(drafts);
  });

  it('A5 repro 1 ends clean: months typed, bar dragged back onto the saved date, months reset on drop', () => {
    const typed = { [a.key]: '8' };
    const dragged = { [a.key]: '2027-07-04' };
    const afterDrop = resetMonthsDraftsOfRows(typed, [a]);
    expect(rowDirtyFlags(a, afterDrop, {}, dragged).any).toBe(false);
    expect(buildTargetItems([a], afterDrop, {}, dragged, computePreview)).toEqual([]);
    expect(resolveTargetIso(a, afterDrop, dragged, computePreview)).toBe('2027-07-04');
  });
});

describe('column filters', () => {
  type Col = 'zone' | 'target';

  it('withoutColFilter: "Select all" leaves NO entry for that column, others untouched', () => {
    const filters: Record<Col, string[]> = { zone: ['A', 'B'], target: ['2027-01-24'] };
    const out = withoutColFilter(filters, 'target');
    expect(out).toEqual({ zone: ['A', 'B'], target: [] });
    expect(out.zone).toBe(filters.zone);
    // The input is not mutated.
    expect(filters.target).toEqual(['2027-01-24']);
  });

  it('isColFilterActive: empty / missing = inactive', () => {
    expect(isColFilterActive([], ['A', 'B'])).toBe(false);
    expect(isColFilterActive(undefined, ['A', 'B'])).toBe(false);
  });

  it('isColFilterActive: a set holding EVERY available value is inactive (old "Select all" state)', () => {
    expect(isColFilterActive(['A', 'B'], ['A', 'B'])).toBe(false);
    // Extra stale values in the set do not make it active.
    expect(isColFilterActive(['A', 'B', 'gone'], ['B', 'A'])).toBe(false);
  });

  it('isColFilterActive: a set missing an available value is active', () => {
    expect(isColFilterActive(['A'], ['A', 'B'])).toBe(true);
    // A value that appeared after the set was stored re-activates it.
    expect(isColFilterActive(['A', 'B'], ['A', 'B', 'new'])).toBe(true);
  });

  it('isColFilterActive: nothing available to compare against → a non-empty set stays active', () => {
    expect(isColFilterActive(['A'], [])).toBe(true);
  });

  it('rowPassesColFilter: plain include-list for clean rows', () => {
    expect(rowPassesColFilter('A', [], false)).toBe(true);
    expect(rowPassesColFilter('A', undefined, false)).toBe(true);
    expect(rowPassesColFilter('A', ['A', 'B'], false)).toBe(true);
    expect(rowPassesColFilter('C', ['A', 'B'], false)).toBe(false);
  });

  it('rowPassesColFilter: a row with pending edits ALWAYS passes', () => {
    expect(rowPassesColFilter('C', ['A', 'B'], true)).toBe(true);
    expect(rowPassesColFilter('(empty)', ['2027-01-24'], true)).toBe(true);
  });
});

describe('snapToSundayIso', () => {
  it('a Sunday stays', () => {
    expect(snapToSundayIso('2027-01-24')).toBe('2027-01-24');
    expect(snapToSundayIso('2026-12-13')).toBe('2026-12-13');
  });

  it('Monday–Saturday move FORWARD to the next Sunday', () => {
    // 2027-01-18 is a Monday … 2027-01-23 a Saturday.
    for (const d of ['18', '19', '20', '21', '22', '23']) {
      expect(snapToSundayIso(`2027-01-${d}`)).toBe('2027-01-24');
    }
  });

  it('rolls over month and year boundaries', () => {
    expect(snapToSundayIso('2027-01-27')).toBe('2027-01-31'); // Wed → Sun, same month
    expect(snapToSundayIso('2027-03-29')).toBe('2027-04-04'); // Mon → next month
    expect(snapToSundayIso('2026-12-29')).toBe('2027-01-03'); // Tue → next year
    expect(snapToSundayIso('2028-02-28')).toBe('2028-03-05'); // leap-year February
  });

  it('"" → "", and values it cannot place are returned unchanged', () => {
    expect(snapToSundayIso('')).toBe('');
    expect(snapToSundayIso('not-a-date')).toBe('not-a-date');
    // A date input emits a 1–3 digit year while it is being typed.
    expect(snapToSundayIso('0002-01-20')).toBe('0002-01-20');
  });
});

describe('isCompleteIsoDate', () => {
  it('a full, real yyyy-mm-dd with year ≥ 1000 is complete', () => {
    expect(isCompleteIsoDate('2027-01-20')).toBe(true);
    expect(isCompleteIsoDate('1000-01-01')).toBe(true);
    expect(isCompleteIsoDate('2028-02-29')).toBe(true); // leap day
  });

  it('"" and partially typed values are not', () => {
    expect(isCompleteIsoDate('')).toBe(false);
    expect(isCompleteIsoDate('2027-01')).toBe(false);
    expect(isCompleteIsoDate('2027-1-5')).toBe(false);
    expect(isCompleteIsoDate('not-a-date')).toBe(false);
  });

  it('a year still being typed (below 1000) is not', () => {
    expect(isCompleteIsoDate('0002-01-20')).toBe(false);
    expect(isCompleteIsoDate('0202-01-20')).toBe(false);
    expect(isCompleteIsoDate('0999-12-31')).toBe(false);
  });

  it('impossible days and anything beyond the date part are not', () => {
    expect(isCompleteIsoDate('2027-02-30')).toBe(false);
    expect(isCompleteIsoDate('2027-02-29')).toBe(false); // not a leap year
    expect(isCompleteIsoDate('2027-13-01')).toBe(false);
    expect(isCompleteIsoDate('2027-00-10')).toBe(false);
    expect(isCompleteIsoDate('2027-01-20T00:00:00Z')).toBe(false);
  });
});

describe('taskProgressCounts', () => {
  it('counts on the real TaskStatus enum', () => {
    const tasks = [
      { status: 'not_started' },
      { status: 'in_progress' },
      { status: 'in_review' },
      { status: 'completed' },
      { status: 'on_hold' },
      { status: 'cancelled' },
    ];
    expect(taskProgressCounts(tasks)).toEqual({ total: 6, started: 3, done: 1 });
  });

  it('all completed → done === total', () => {
    expect(taskProgressCounts([{ status: 'completed' }, { status: 'completed' }])).toEqual({
      total: 2, started: 2, done: 2,
    });
  });

  it('nothing started: not_started / on_hold / cancelled / missing status', () => {
    expect(
      taskProgressCounts([{ status: 'not_started' }, { status: 'on_hold' }, { status: 'cancelled' }, { status: null }, {}]),
    ).toEqual({ total: 5, started: 0, done: 0 });
  });

  it('legacy values are not counted (they were never in the enum)', () => {
    expect(taskProgressCounts([{ status: 'done' }, { status: 'to_do' }, { status: 'blocked' }])).toEqual({
      total: 3, started: 0, done: 0,
    });
  });

  it('empty list', () => {
    expect(taskProgressCounts([])).toEqual({ total: 0, started: 0, done: 0 });
  });
});

describe('mergeRowOrder', () => {
  it('rows hidden by a filter keep their position (merge runs on ALL keys)', () => {
    // The user's order; a filter currently shows only `a` and `c`, but
    // the merge is fed every row key of the project.
    const saved = ['c', 'b', 'a'];
    expect(mergeRowOrder(saved, ['a', 'b', 'c'])).toEqual(['c', 'b', 'a']);
  });

  it('deleted rows drop out', () => {
    expect(mergeRowOrder(['c', 'b', 'a'], ['a', 'c'])).toEqual(['c', 'a']);
  });

  it('new rows are appended in allKeys order', () => {
    expect(mergeRowOrder(['c', 'a'], ['a', 'x', 'c', 'y'])).toEqual(['c', 'a', 'x', 'y']);
    expect(mergeRowOrder([], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('drops and appends in one pass', () => {
    expect(mergeRowOrder(['gone', 'b', 'a'], ['a', 'b', 'new'])).toEqual(['b', 'a', 'new']);
  });

  it('returns the SAME reference when nothing changed', () => {
    const saved = ['c', 'b', 'a'];
    expect(mergeRowOrder(saved, ['a', 'b', 'c'])).toBe(saved);
    const empty: string[] = [];
    expect(mergeRowOrder(empty, [])).toBe(empty);
  });

  it('a duplicated saved key is collapsed to its first position', () => {
    expect(mergeRowOrder(['b', 'a', 'b'], ['a', 'b'])).toEqual(['b', 'a']);
  });
});

describe('moveRowKey', () => {
  it('nothing hidden → same as "remove, then insert at toIndex"', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(moveRowKey(order, order, 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveRowKey(order, order, 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveRowKey(order, order, 'a', 99)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('hidden rows stay where they are; the drop lands relative to the VISIBLE rows', () => {
    const order = ['a', 'h1', 'b', 'h2', 'c'];
    const visible = ['a', 'b', 'c'];
    // c dropped on the first visible row → before `a`.
    expect(moveRowKey(order, visible, 'c', 0)).toEqual(['c', 'a', 'h1', 'b', 'h2']);
    // c dropped on visible index 1 → before `b`, not before hidden `h1`.
    expect(moveRowKey(order, visible, 'c', 1)).toEqual(['a', 'h1', 'c', 'b', 'h2']);
    // a dropped past the last visible row → right after `c`.
    expect(moveRowKey(order, visible, 'a', 2)).toEqual(['h1', 'b', 'h2', 'c', 'a']);
  });

  it('a key missing from the order is still inserted', () => {
    expect(moveRowKey(['a', 'b'], ['a', 'b', 'x'], 'x', 0)).toEqual(['x', 'a', 'b']);
  });
});

describe('seedFromRows', () => {
  it('maps server values to strings, null → ""', () => {
    const a = row({ key: 'a', savedMonths: 6, savedDurationWeeks: 4, savedDate: '2026-12-13' });
    const b = row({ key: 'b' });
    expect(seedFromRows([a, b])).toEqual({
      a: { months: '6', dur: '4', date: '2026-12-13' },
      b: { months: '', dur: '', date: '' },
    });
  });
});

describe('mergeDraftsOnRefresh', () => {
  const K = '10:topzone-1';
  const OTHER = '11:topzone-2';
  const seed = (months: string, dur: string, date: string) => ({ months, dur, date });

  it('first seed (no previous seed) → plain seed, no explicit-date draft', () => {
    const next = { [K]: seed('6', '4', '2026-12-13'), [OTHER]: seed('', '', '') };
    // A stray explicit draft with no previous seed is dropped too.
    expect(mergeDraftsOnRefresh({}, next, {}, {}, { [K]: '2027-01-10' })).toEqual({
      drafts: { [K]: '6' },
      durationDrafts: { [K]: '4' },
      targetDateDrafts: {},
    });
  });

  it('keeps a pending drag across an unrelated refresh (server date unchanged)', () => {
    const s = { [K]: seed('6', '4', '2027-05-09'), [OTHER]: seed('9', '', '2027-03-07') };
    // Same server values, new object — e.g. a task due date saved elsewhere.
    const next = { [K]: seed('6', '4', '2027-05-09'), [OTHER]: seed('9', '', '2027-03-07') };
    const out = mergeDraftsOnRefresh(s, next, { [K]: '6', [OTHER]: '9' }, { [K]: '4' }, { [K]: '2026-12-13' });
    expect(out.targetDateDrafts).toEqual({ [K]: '2026-12-13' });
    expect(out.drafts).toEqual({ [K]: '6', [OTHER]: '9' });
    expect(out.durationDrafts).toEqual({ [K]: '4' });
  });

  it('drops a pending drag once the server date changed (it was saved)', () => {
    const prev = { [K]: seed('6', '4', '2027-05-09') };
    const next = { [K]: seed('', '4', '2026-12-13') };
    const out = mergeDraftsOnRefresh(prev, next, { [K]: '6' }, { [K]: '4' }, { [K]: '2026-12-13' });
    expect(out.targetDateDrafts).toEqual({});
  });

  it('drops a drag draft that now equals the server date', () => {
    const s = { [K]: seed('', '', '2026-12-13') };
    const out = mergeDraftsOnRefresh(s, { ...s }, {}, {}, { [K]: '2026-12-13' });
    expect(out.targetDateDrafts).toEqual({});
  });

  it('drops empty explicit-date drafts', () => {
    const s = { [K]: seed('6', '', '2026-12-13') };
    const out = mergeDraftsOnRefresh(s, { ...s }, { [K]: '6' }, {}, { [K]: '' });
    expect(out.targetDateDrafts).toEqual({});
  });

  // §11 A5 · an explicit draft sitting ON the server date still matters
  // while it overrides a pending months edit.
  it('A5: KEEPS an explicit draft equal to the server date while the months draft is dirty', () => {
    const s = { [K]: seed('', '', '2027-07-04') };
    // Background refetch, server unchanged; months 8 typed, bar on 07-04.
    const out = mergeDraftsOnRefresh(s, { ...s }, { [K]: '8' }, {}, { [K]: '2027-07-04' });
    expect(out.targetDateDrafts).toEqual({ [K]: '2027-07-04' });
    expect(out.drafts).toEqual({ [K]: '8' });
  });

  it('A5: …and drops it as before once the months draft is clean', () => {
    const s = { [K]: seed('6', '', '2027-07-04') };
    const out = mergeDraftsOnRefresh(s, { ...s }, { [K]: '6' }, {}, { [K]: '2027-07-04' });
    expect(out.targetDateDrafts).toEqual({});
  });

  it('A5: also kept when the server date moved ONTO the draft but the months draft is still pending', () => {
    // The explicit date was just saved; server months was null before and
    // after, so the typed 8 survives the merge. Dropping the explicit
    // draft here would flash the months preview until the post-save
    // cleanup resets the months draft.
    const prev = { [K]: seed('', '', '2027-07-04') };
    const next = { [K]: seed('', '', '2027-07-11') };
    const out = mergeDraftsOnRefresh(prev, next, { [K]: '8' }, {}, { [K]: '2027-07-11' });
    expect(out.targetDateDrafts).toEqual({ [K]: '2027-07-11' });
  });

  it('A5: a months draft that this very merge reseeds does not keep the explicit draft alive', () => {
    // Server months moved 6 → null with the save, so the dirty "8" is
    // reseeded by the merge — nothing is being overridden any more.
    const prev = { [K]: seed('6', '', '2027-07-04') };
    const next = { [K]: seed('', '', '2027-07-11') };
    const out = mergeDraftsOnRefresh(prev, next, { [K]: '8' }, {}, { [K]: '2027-07-11' });
    expect(out).toEqual({ drafts: {}, durationDrafts: {}, targetDateDrafts: {} });
  });

  it('reseeds a CLEAN months draft after the server nulled months (drag-save)', () => {
    const prev = { [K]: seed('6', '4', '2027-05-09') };
    const next = { [K]: seed('', '4', '2026-12-13') };
    const out = mergeDraftsOnRefresh(prev, next, { [K]: '6' }, { [K]: '4' }, {});
    // '' is not stored for a clean row — the key simply drops out.
    expect(out.drafts).toEqual({});
    expect(out.durationDrafts).toEqual({ [K]: '4' });
  });

  it('keeps a DIRTY months draft across an unrelated refresh', () => {
    const s = { [K]: seed('6', '4', '2027-05-09') };
    const out = mergeDraftsOnRefresh(s, { ...s }, { [K]: '8' }, { [K]: '4' }, {});
    expect(out.drafts).toEqual({ [K]: '8' });
  });

  it('keeps a user-CLEARED months draft as an explicit ""', () => {
    const s = { [K]: seed('6', '4', '2027-05-09') };
    const out = mergeDraftsOnRefresh(s, { ...s }, { [K]: '' }, { [K]: '4' }, {});
    expect(out.drafts).toEqual({ [K]: '' });
    expect(K in out.drafts).toBe(true);
  });

  it('a dirty months draft that was just SAVED converges onto the server value', () => {
    const prev = { [K]: seed('6', '', '2027-05-09') };
    const next = { [K]: seed('8', '', '2027-07-11') };
    const out = mergeDraftsOnRefresh(prev, next, { [K]: '8' }, {}, {});
    expect(out.drafts).toEqual({ [K]: '8' });
  });

  it('a dirty months draft is reseeded when the server months moved under it', () => {
    // Typed 8 (unsaved), then dragged + saved the same row: the explicit
    // save nulls months on the server. The stale "8" must not survive as
    // a pending edit — it would outrank the date that was just saved.
    const prev = { [K]: seed('6', '', '2027-05-09') };
    const next = { [K]: seed('', '', '2026-12-13') };
    const out = mergeDraftsOnRefresh(prev, next, { [K]: '8' }, {}, { [K]: '2026-12-13' });
    expect(out).toEqual({ drafts: {}, durationDrafts: {}, targetDateDrafts: {} });
  });

  it('duration follows the same rule as months', () => {
    const s = { [K]: seed('6', '4', '2027-05-09') };
    // dirty + server unchanged → kept
    expect(mergeDraftsOnRefresh(s, { ...s }, { [K]: '6' }, { [K]: '7' }, {}).durationDrafts).toEqual({ [K]: '7' });
    // cleared by the user + server unchanged → explicit ''
    expect(mergeDraftsOnRefresh(s, { ...s }, { [K]: '6' }, { [K]: '' }, {}).durationDrafts).toEqual({ [K]: '' });
    // dirty + server moved → reseeded from the server
    const moved = { [K]: seed('6', '5', '2027-05-09') };
    expect(mergeDraftsOnRefresh(s, moved, { [K]: '6' }, { [K]: '7' }, {}).durationDrafts).toEqual({ [K]: '5' });
  });

  it('removed rows drop out of every draft map', () => {
    const prev = { [K]: seed('6', '4', '2027-05-09'), [OTHER]: seed('9', '2', '2027-03-07') };
    const next = { [K]: seed('6', '4', '2027-05-09') };
    const out = mergeDraftsOnRefresh(
      prev,
      next,
      { [K]: '6', [OTHER]: '12' },
      { [K]: '4', [OTHER]: '3' },
      { [OTHER]: '2027-04-04' },
    );
    expect(out).toEqual({ drafts: { [K]: '6' }, durationDrafts: { [K]: '4' }, targetDateDrafts: {} });
  });

  it('a row that appears later gets a plain seed and keeps the others untouched', () => {
    const prev = { [K]: seed('6', '4', '2027-05-09') };
    const next = { [K]: seed('6', '4', '2027-05-09'), [OTHER]: seed('9', '2', '2027-03-07') };
    const out = mergeDraftsOnRefresh(prev, next, { [K]: '8' }, { [K]: '4' }, { [K]: '2026-12-13' });
    expect(out).toEqual({
      drafts: { [K]: '8', [OTHER]: '9' },
      durationDrafts: { [K]: '4', [OTHER]: '2' },
      targetDateDrafts: { [K]: '2026-12-13' },
    });
  });

  it('months and duration merge independently; the explicit-date merge needs the months drafts', () => {
    // The tab runs each dimension inside its own functional setState
    // updater — the per-dimension result must be identical to a single
    // combined call. Months and duration get {} for the other maps;
    // §11 A5: the explicit-date merge is handed the months drafts too.
    const prev = { [K]: seed('6', '4', '2027-05-09'), [OTHER]: seed('9', '', '2027-03-07') };
    const next = { [K]: seed('6', '4', '2027-05-09'), [OTHER]: seed('', '', '2026-12-13') };
    const drafts = { [K]: '8', [OTHER]: '9' };
    const dur = { [K]: '', [OTHER]: '3' };
    const dates = { [K]: '2026-12-20', [OTHER]: '2026-12-13' };
    const combined = mergeDraftsOnRefresh(prev, next, drafts, dur, dates);
    expect(mergeDraftsOnRefresh(prev, next, drafts, {}, {}).drafts).toEqual(combined.drafts);
    expect(mergeDraftsOnRefresh(prev, next, {}, dur, {}).durationDrafts).toEqual(combined.durationDrafts);
    expect(mergeDraftsOnRefresh(prev, next, drafts, {}, dates).targetDateDrafts).toEqual(combined.targetDateDrafts);
  });

  it('is stable: re-merging against an identical seed changes nothing', () => {
    const s = { [K]: seed('6', '4', '2027-05-09'), [OTHER]: seed('', '', '') };
    const first = mergeDraftsOnRefresh({}, s, {}, {}, {});
    const again = mergeDraftsOnRefresh(s, { ...s }, first.drafts, first.durationDrafts, first.targetDateDrafts);
    expect(sameDraftMap(first.drafts, again.drafts)).toBe(true);
    expect(sameDraftMap(first.durationDrafts, again.durationDrafts)).toBe(true);
    expect(sameDraftMap(first.targetDateDrafts, again.targetDateDrafts)).toBe(true);
  });
});

describe('sameDraftMap', () => {
  it('compares keys and values shallowly', () => {
    expect(sameDraftMap({}, {})).toBe(true);
    expect(sameDraftMap({ a: '1' }, { a: '1' })).toBe(true);
    expect(sameDraftMap({ a: '1' }, { a: '2' })).toBe(false);
    expect(sameDraftMap({ a: '1' }, { a: '1', b: '' })).toBe(false);
    // An explicit '' is NOT the same as a missing key (a pending clear).
    expect(sameDraftMap({ a: '' }, {})).toBe(false);
    expect(sameDraftMap({ a: '' }, { b: '' })).toBe(false);
  });
});

// ── §12 (2026-11-14) ────────────────────────────────────────────────

describe('canReorderOnto', () => {
  const groupOf = new Map([
    ['a1', 'del:1'],
    ['a2', 'del:1'],
    ['b1', 'del:2'],
  ]);

  it('a row can be dropped on another row of its OWN group', () => {
    expect(canReorderOnto(groupOf, 'a1', 'a2')).toBe(true);
    expect(canReorderOnto(groupOf, 'a2', 'a1')).toBe(true);
  });

  it('a row of a different group is not a drop target', () => {
    expect(canReorderOnto(groupOf, 'a1', 'b1')).toBe(false);
    expect(canReorderOnto(groupOf, 'b1', 'a2')).toBe(false);
  });

  it('not onto itself, not without a drag in flight, not for unknown rows', () => {
    expect(canReorderOnto(groupOf, 'a1', 'a1')).toBe(false);
    expect(canReorderOnto(groupOf, null, 'a1')).toBe(false);
    expect(canReorderOnto(groupOf, 'gone', 'a1')).toBe(false);
    expect(canReorderOnto(groupOf, 'a1', 'gone')).toBe(false);
    expect(canReorderOnto(groupOf, 'gone', 'also-gone')).toBe(false);
  });

  it('ungrouped view: every row shares one group, so any row is a target', () => {
    const flat = new Map([['a1', 'all'], ['b1', 'all']]);
    expect(canReorderOnto(flat, 'a1', 'b1')).toBe(true);
  });
});

describe('ganttBarBox', () => {
  const opts = { minWidthPx: 4, zeroWidthPx: 36 };

  it('a real duration keeps its geometry: left on the start, right on the target', () => {
    expect(ganttBarBox(100, 180, 10, opts)).toEqual({ leftPx: 100, widthPx: 80 });
    // …also when it is narrower than the zero-week width (1 week at month zoom).
    expect(ganttBarBox(100, 108, 1, opts)).toEqual({ leftPx: 100, widthPx: 8 });
  });

  it('a real duration thinner than the floor still gets the old minimum width', () => {
    expect(ganttBarBox(100, 101, 1, opts)).toEqual({ leftPx: 100, widthPx: 4 });
  });

  it('a ZERO-week bar gets the usable width, grown leftward — its right edge stays on the target', () => {
    const box = ganttBarBox(180, 180, 0, opts);
    expect(box).toEqual({ leftPx: 144, widthPx: 36 });
    expect(box.leftPx + box.widthPx).toBe(180);
  });
});

describe('resolveGrouping', () => {
  it('a primary dim groups by it; the sub-group passes through', () => {
    expect(resolveGrouping('deliverable', 'zone')).toEqual({ grouped: true, outerDim: 'deliverable', innerDim: 'zone' });
    expect(resolveGrouping('zone', null)).toEqual({ grouped: true, outerDim: 'zone', innerDim: null });
    expect(resolveGrouping('service', 'deliverable')).toEqual({ grouped: true, outerDim: 'service', innerDim: 'deliverable' });
  });

  it('primary "No grouping" → NOT grouped (it used to read as Deliverable)', () => {
    expect(resolveGrouping(null, null)).toEqual({ grouped: false, outerDim: 'deliverable', innerDim: 'zone' });
  });

  it('…and a leftover sub-group pick is ignored — there is no group to sub-divide', () => {
    expect(resolveGrouping(null, 'service')).toEqual({ grouped: false, outerDim: 'deliverable', innerDim: 'zone' });
  });

  it('a sub-group equal to the primary is dropped', () => {
    expect(resolveGrouping('zone', 'zone')).toEqual({ grouped: true, outerDim: 'zone', innerDim: null });
  });
});

describe('ganttRangeCaption', () => {
  it('the whole range fits (Month grid, short range) → "all in view"', () => {
    expect(ganttRangeCaption(730, 730, 'month')).toBe('Timeline spans 2 years, all in view');
    expect(ganttRangeCaption(730, 900, 'month')).toBe('Timeline spans 2 years, all in view');
  });

  it('Month grid: what is in view is said in years (or months when short)', () => {
    // 3-year pick = 4-year timeline (one year of look-back); ~875 days fit.
    expect(ganttRangeCaption(1460, 875, 'month')).toBe('Timeline spans 4 years · ~2.4 years in view');
    expect(ganttRangeCaption(1460, 300, 'month')).toBe('Timeline spans 4 years · ~10 months in view');
  });

  it('Week grid: in weeks', () => {
    expect(ganttRangeCaption(730, 250, 'week')).toBe('Timeline spans 2 years · ~36 weeks in view');
  });

  it('Day grid: in days', () => {
    expect(ganttRangeCaption(730, 41.7, 'day')).toBe('Timeline spans 2 years · ~42 days in view');
  });

  it('a range stretched by a late target is not rounded to the Years pick', () => {
    expect(ganttRangeCaption(1205, 250, 'week')).toBe('Timeline spans 3.3 years · ~36 weeks in view');
  });

  it('singular units, and no in-view part before the viewport is measured', () => {
    expect(ganttRangeCaption(365, 7, 'week')).toBe('Timeline spans 1 year · ~1 week in view');
    expect(ganttRangeCaption(730, 0, 'month')).toBe('Timeline spans 2 years');
  });
});

describe('withPriorDrafts', () => {
  it('restores the prior draft where there was one and removes the entry otherwise', () => {
    const drafts = { a: '2027-02-07', b: '2027-02-14', other: '2027-03-07' };
    expect(
      withPriorDrafts(drafts, [{ key: 'a', priorDraft: '2027-01-24' }, { key: 'b', priorDraft: '' }]),
    ).toEqual({ a: '2027-01-24', other: '2027-03-07' });
  });

  it('returns the SAME object when everything already is as it was', () => {
    const drafts = { a: '2027-01-24' };
    expect(withPriorDrafts(drafts, [{ key: 'a', priorDraft: '2027-01-24' }, { key: 'b', priorDraft: '' }])).toBe(drafts);
    expect(withPriorDrafts(drafts, [])).toBe(drafts);
  });

  it('an explicitly stored "" for a row that had no draft is removed too', () => {
    const out = withPriorDrafts({ a: '' }, [{ key: 'a', priorDraft: '' }]);
    expect('a' in out).toBe(false);
  });
});

describe('earliestIsoMs', () => {
  it('returns the earliest date as UTC ms', () => {
    expect(earliestIsoMs(['2027-02-07', '2027-01-24', '2027-03-07'])).toBe(Date.UTC(2027, 0, 24));
    expect(earliestIsoMs(new Map([['a', '2027-01-31']]).values())).toBe(Date.UTC(2027, 0, 31));
  });

  it('null for nothing, and unparsable entries are skipped', () => {
    expect(earliestIsoMs([])).toBeNull();
    expect(earliestIsoMs(['', 'nope'])).toBeNull();
    expect(earliestIsoMs(['nope', '2027-01-24'])).toBe(Date.UTC(2027, 0, 24));
  });
});

describe('taskStartForSave', () => {
  const stored = { storedStart: '2027-01-04', storedEnd: '2027-01-11' };

  it('preview-driven row → the start of the dry-run row that supplied the due date', () => {
    expect(
      taskStartForSave({
        nextEnd: '2027-02-08',
        manual: false,
        preview: { startDate: '2027-02-02', endDate: '2027-02-08' },
        ...stored,
      }),
    ).toBe('2027-02-02');
  });

  it('…also when the task has no stored dates yet', () => {
    expect(
      taskStartForSave({
        nextEnd: '2027-02-08',
        manual: false,
        preview: { startDate: '2027-02-02', endDate: '2027-02-08' },
        storedStart: null,
        storedEnd: null,
      }),
    ).toBe('2027-02-02');
  });

  it('hand-edited row → the stored start moved by the same number of days as the due date', () => {
    // Due moved +28 days; the dry-run row is ignored for a typed value.
    expect(
      taskStartForSave({
        nextEnd: '2027-02-08',
        manual: true,
        preview: { startDate: '2027-01-20', endDate: '2027-02-08' },
        ...stored,
      }),
    ).toBe('2027-02-01');
    // Moved earlier, across a year boundary.
    expect(taskStartForSave({ nextEnd: '2026-12-28', manual: true, ...stored })).toBe('2026-12-21');
  });

  it('hand-edited row with a stored date missing → no start', () => {
    expect(taskStartForSave({ nextEnd: '2027-02-08', manual: true, storedStart: null, storedEnd: '2027-01-11' })).toBeUndefined();
    expect(taskStartForSave({ nextEnd: '2027-02-08', manual: true, storedStart: '2027-01-04', storedEnd: null })).toBeUndefined();
  });

  it('a dry-run row for a DIFFERENT due date did not supply this one → falls back to the shift', () => {
    expect(
      taskStartForSave({
        nextEnd: '2027-02-08',
        manual: false,
        preview: { startDate: '2027-03-01', endDate: '2027-03-08' },
        ...stored,
      }),
    ).toBe('2027-02-01');
    // …and with nothing stored to shift, no start at all.
    expect(
      taskStartForSave({
        nextEnd: '2027-02-08',
        manual: false,
        preview: { startDate: '2027-03-01', endDate: '2027-03-08' },
        storedStart: null,
        storedEnd: null,
      }),
    ).toBeUndefined();
  });

  it('never a start later than the due date', () => {
    // An inverted dry-run row.
    expect(
      taskStartForSave({
        nextEnd: '2027-02-08',
        manual: false,
        preview: { startDate: '2027-02-10', endDate: '2027-02-08' },
        storedStart: null,
        storedEnd: null,
      }),
    ).toBeUndefined();
    // A stored pair that is already inverted (start 01-25 / end 01-11)
    // stays inverted when shifted → not sent.
    expect(
      taskStartForSave({ nextEnd: '2027-01-18', manual: true, storedStart: '2027-01-25', storedEnd: '2027-01-11' }),
    ).toBeUndefined();
    // A start ON the due date is fine.
    expect(taskStartForSave({ nextEnd: '2027-01-18', manual: true, storedStart: '2027-01-11', storedEnd: '2027-01-11' })).toBe('2027-01-18');
  });

  it('clearing the due date sends no start', () => {
    expect(taskStartForSave({ nextEnd: null, manual: true, ...stored })).toBeUndefined();
    expect(taskStartForSave({ nextEnd: '', manual: false, preview: { startDate: '2027-02-02', endDate: '2027-02-08' }, ...stored })).toBeUndefined();
  });
});

describe('taskDatesPatch', () => {
  const stored = { storedStart: '2027-01-04', storedEnd: '2027-01-11' };

  it('due date changed by the preview → endDate + the dry-run start, no manual flag', () => {
    expect(
      taskDatesPatch({
        nextEnd: '2027-02-08',
        manual: false,
        preview: { startDate: '2027-02-02', endDate: '2027-02-08' },
        ...stored,
      }),
    ).toEqual({ endDate: '2027-02-08', estimatedStartDate: '2027-02-02' });
  });

  it('due date UNCHANGED but the dry-run start differs → start-only payload', () => {
    const patch = taskDatesPatch({
      nextEnd: '2027-01-11',
      manual: false,
      preview: { startDate: '2027-01-06', endDate: '2027-01-11' },
      ...stored,
    });
    expect(patch).toEqual({ estimatedStartDate: '2027-01-06' });
    expect(patch && 'endDate' in patch).toBe(false);
    expect(patch && 'manualDueDate' in patch).toBe(false);
    // …also for a task that had no stored start at all.
    expect(
      taskDatesPatch({
        nextEnd: '2027-01-11',
        manual: false,
        preview: { startDate: '2027-01-06', endDate: '2027-01-11' },
        storedStart: null,
        storedEnd: '2027-01-11',
      }),
    ).toEqual({ estimatedStartDate: '2027-01-06' });
  });

  it('nothing changed → null', () => {
    // Dry-run row identical to what is stored.
    expect(
      taskDatesPatch({
        nextEnd: '2027-01-11',
        manual: false,
        preview: { startDate: '2027-01-04', endDate: '2027-01-11' },
        ...stored,
      }),
    ).toBeNull();
    // No dry-run row at all.
    expect(taskDatesPatch({ nextEnd: '2027-01-11', manual: false, ...stored })).toBeNull();
    // A task without dates that stays without dates.
    expect(taskDatesPatch({ nextEnd: '', manual: false, storedStart: null, storedEnd: null })).toBeNull();
  });

  it('hand-edited row with an unchanged due date → null, even if the dry-run start differs', () => {
    expect(
      taskDatesPatch({
        nextEnd: '2027-01-11',
        manual: true,
        preview: { startDate: '2027-01-06', endDate: '2027-01-11' },
        ...stored,
      }),
    ).toBeNull();
  });

  it('unchanged due date + a dry-run row for a DIFFERENT due date → null (it is not this row\'s schedule)', () => {
    expect(
      taskDatesPatch({
        nextEnd: '2027-01-11',
        manual: false,
        preview: { startDate: '2027-01-20', endDate: '2027-01-25' },
        ...stored,
      }),
    ).toBeNull();
  });

  it('unchanged due date + an inverted dry-run row → null (never a start after the due date)', () => {
    expect(
      taskDatesPatch({
        nextEnd: '2027-01-11',
        manual: false,
        preview: { startDate: '2027-01-12', endDate: '2027-01-11' },
        ...stored,
      }),
    ).toBeNull();
  });

  it('hand-edited due date → endDate + manualDueDate + the stored start shifted by the same days', () => {
    expect(taskDatesPatch({ nextEnd: '2027-01-18', manual: true, ...stored })).toEqual({
      endDate: '2027-01-18', manualDueDate: true, estimatedStartDate: '2027-01-11',
    });
    // No stored start to shift → no start key.
    expect(taskDatesPatch({ nextEnd: '2027-01-18', manual: true, storedStart: null, storedEnd: '2027-01-11' })).toEqual({
      endDate: '2027-01-18', manualDueDate: true,
    });
  });

  it('cleared due date → endDate null, no start, no manual flag', () => {
    expect(taskDatesPatch({ nextEnd: '', manual: true, ...stored })).toEqual({ endDate: null });
    expect(
      taskDatesPatch({
        nextEnd: null,
        manual: false,
        preview: { startDate: '2027-02-02', endDate: '2027-02-08' },
        ...stored,
      }),
    ).toEqual({ endDate: null });
  });
});

// ── §13 (2026-11-15) ────────────────────────────────────────────────

describe('lagLabelText', () => {
  it('positive lag → the drawn label, per unit', () => {
    expect(lagLabelText(7, 'CALENDAR_DAYS')).toBe('+7ק');
    expect(lagLabelText(3, 'WORKING_DAYS')).toBe('+3ימ"ע');
  });

  it('zero, negative or unusable lag → no label', () => {
    expect(lagLabelText(0, 'CALENDAR_DAYS')).toBeNull();
    expect(lagLabelText(-2, 'WORKING_DAYS')).toBeNull();
    expect(lagLabelText(Number.NaN, 'CALENDAR_DAYS')).toBeNull();
  });
});

describe('chainArrowTooltip', () => {
  const succ = { code: 'CRD-036', name: 'Coordination drawings' };
  const pred = { code: 'CRD-021', name: 'Survey' };
  const LRM = '‎';

  it('dashed stub: predecessor without a span, 7 calendar days', () => {
    expect(
      chainArrowTooltip({ succ, pred, lag: 7, lagUnit: 'CALENDAR_DAYS', predHasSpan: false, critical: false }),
    ).toBe(
      [
        'תלות: CRD-036 מתחילה אחרי סיום CRD-021',
        `השהיה: 7 ימים קלנדריים (${LRM}+7ק)`,
        'ל-CRD-021 אין תאריך התחלה (או שההתחלה מאוחרת מהסיום), ולכן אין לה פס. החץ המקווקו מסמן רק את התלות הנכנסת.',
      ].join('\n'),
    );
  });

  it('normal arrow with a working-day lag', () => {
    expect(
      chainArrowTooltip({ succ, pred, lag: 3, lagUnit: 'WORKING_DAYS', predHasSpan: true, critical: false }),
    ).toBe(['תלות: CRD-036 מתחילה אחרי סיום CRD-021', `השהיה: 3 ימי עבודה (${LRM}+3ימ"ע)`].join('\n'));
  });

  it('zero lag → "no lag", nothing in parentheses', () => {
    expect(
      chainArrowTooltip({ succ, pred, lag: 0, lagUnit: 'WORKING_DAYS', predHasSpan: true, critical: false }),
    ).toBe(['תלות: CRD-036 מתחילה אחרי סיום CRD-021', 'ללא השהיה'].join('\n'));
  });

  it('critical arrow → the critical-path line comes last', () => {
    expect(
      chainArrowTooltip({ succ, pred, lag: 7, lagUnit: 'CALENDAR_DAYS', predHasSpan: true, critical: true }),
    ).toBe(
      ['תלות: CRD-036 מתחילה אחרי סיום CRD-021', `השהיה: 7 ימים קלנדריים (${LRM}+7ק)`, 'על הנתיב הקריטי'].join('\n'),
    );
    // …also after the stub explanation.
    const lines = chainArrowTooltip({ succ, pred, lag: 0, lagUnit: 'CALENDAR_DAYS', predHasSpan: false, critical: true }).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('על הנתיב הקריטי');
  });

  it('singular day', () => {
    expect(
      chainArrowTooltip({ succ, pred, lag: 1, lagUnit: 'CALENDAR_DAYS', predHasSpan: true, critical: false }).split('\n')[1],
    ).toBe(`השהיה: יום קלנדרי אחד (${LRM}+1ק)`);
    expect(
      chainArrowTooltip({ succ, pred, lag: 1, lagUnit: 'WORKING_DAYS', predHasSpan: true, critical: false }).split('\n')[1],
    ).toBe(`השהיה: יום עבודה אחד (${LRM}+1ימ"ע)`);
  });

  it('negative lag reads as a lead, with no label in parentheses (none is drawn)', () => {
    const line = chainArrowTooltip({ succ, pred, lag: -3, lagUnit: 'WORKING_DAYS', predHasSpan: true, critical: false }).split('\n')[1];
    expect(line).toBe('הקדמה: 3 ימי עבודה לפני הסיום');
    expect(line).not.toContain('(');
    expect(
      chainArrowTooltip({ succ, pred, lag: -1, lagUnit: 'CALENDAR_DAYS', predHasSpan: true, critical: false }).split('\n')[1],
    ).toBe('הקדמה: יום קלנדרי אחד לפני הסיום');
  });

  it('the label in parentheses is exactly what lagLabelText draws', () => {
    for (const [lag, unit] of [[7, 'CALENDAR_DAYS'], [12, 'WORKING_DAYS']] as const) {
      const line = chainArrowTooltip({ succ, pred, lag, lagUnit: unit, predHasSpan: true, critical: false }).split('\n')[1];
      expect(line.endsWith(`(${LRM}${lagLabelText(lag, unit)})`)).toBe(true);
    }
  });

  it('a task without a code is named by its name', () => {
    expect(
      chainArrowTooltip({
        succ: { code: null, name: 'Shop drawings' },
        pred: { name: 'Survey' },
        lag: 0,
        lagUnit: 'CALENDAR_DAYS',
        predHasSpan: false,
        critical: false,
      }),
    ).toBe(
      [
        'תלות: Shop drawings מתחילה אחרי סיום Survey',
        'ללא השהיה',
        'ל-Survey אין תאריך התחלה (או שההתחלה מאוחרת מהסיום), ולכן אין לה פס. החץ המקווקו מסמן רק את התלות הנכנסת.',
      ].join('\n'),
    );
  });
});

describe('taskBarTooltip', () => {
  it('code · name · start → end', () => {
    expect(
      taskBarTooltip({ code: 'CRD-036', name: 'Coordination drawings', startIso: '2027-01-04', endIso: '2027-01-11', critical: false }),
    ).toBe('CRD-036 · Coordination drawings · 2027-01-04 → 2027-01-11');
  });

  it('no code → starts with the name; critical path keeps its suffix', () => {
    expect(
      taskBarTooltip({ code: null, name: 'Survey', startIso: '2027-01-04', endIso: '2027-01-04', critical: true }),
    ).toBe('Survey · 2027-01-04 → 2027-01-04 · critical path');
  });
});

describe('clickGestureTracker', () => {
  it('no movement, or a wiggle inside the slop → click', () => {
    expect(clickGestureTracker(100, 3).endsAsClick(100)).toBe(true);
    const t = clickGestureTracker(100, 3);
    t.move(101);
    t.move(98);
    expect(t.endsAsClick(102)).toBe(true);
  });

  it('released beyond the slop → drag', () => {
    expect(clickGestureTracker(100, 3).endsAsClick(103)).toBe(false);
    const t = clickGestureTracker(100, 3);
    t.move(140);
    expect(t.endsAsClick(180)).toBe(false);
  });

  it('out and BACK to the start is a drag, not a click', () => {
    const t = clickGestureTracker(100, 3);
    t.move(160);
    t.move(120);
    t.move(101);
    expect(t.endsAsClick(100)).toBe(false);
    // …in either direction.
    const u = clickGestureTracker(100, 3);
    u.move(60);
    expect(u.endsAsClick(100)).toBe(false);
  });
});

// ── §14 (2026-11-15) · manual ("pinned") due dates ──────────────────

describe('taskDatesPatch · release', () => {
  const stored = { storedStart: '2026-11-16', storedEnd: '2026-11-20' };
  const dryRun = { startDate: '2029-03-05', endDate: '2029-03-09' };

  it('released row whose draft is the dry-run date → dates + manualDueDate: false', () => {
    expect(
      taskDatesPatch({ nextEnd: '2029-03-09', manual: false, release: true, preview: dryRun, ...stored }),
    ).toEqual({ endDate: '2029-03-09', manualDueDate: false, estimatedStartDate: '2029-03-05' });
  });

  it('released, due date unchanged → { manualDueDate: false } alone (the flag is cleared even if nothing moves)', () => {
    // No dry-run row.
    expect(taskDatesPatch({ nextEnd: '2026-11-20', manual: false, release: true, ...stored })).toEqual({
      manualDueDate: false,
    });
    // Dry-run row identical to what is stored.
    expect(
      taskDatesPatch({
        nextEnd: '2026-11-20',
        manual: false,
        release: true,
        preview: { startDate: '2026-11-16', endDate: '2026-11-20' },
        ...stored,
      }),
    ).toEqual({ manualDueDate: false });
  });

  it('released, due date unchanged but the scheduler start differs → flag + start, no endDate', () => {
    const patch = taskDatesPatch({
      nextEnd: '2026-11-20',
      manual: false,
      release: true,
      preview: { startDate: '2026-11-18', endDate: '2026-11-20' },
      ...stored,
    });
    expect(patch).toEqual({ manualDueDate: false, estimatedStartDate: '2026-11-18' });
    expect(patch && 'endDate' in patch).toBe(false);
  });

  it('released, due date unchanged, dry-run row for another date → the start is not taken from it', () => {
    expect(
      taskDatesPatch({ nextEnd: '2026-11-20', manual: false, release: true, preview: dryRun, ...stored }),
    ).toEqual({ manualDueDate: false });
  });

  it('released, due date changed without a matching dry-run row → still released, start shifted', () => {
    expect(taskDatesPatch({ nextEnd: '2026-11-27', manual: false, release: true, ...stored })).toEqual({
      endDate: '2026-11-27', manualDueDate: false, estimatedStartDate: '2026-11-23',
    });
  });

  it('a TYPED row wins over a release: manualDueDate stays true', () => {
    expect(taskDatesPatch({ nextEnd: '2026-11-27', manual: true, release: true, ...stored })).toEqual({
      endDate: '2026-11-27', manualDueDate: true, estimatedStartDate: '2026-11-23',
    });
    // …and a typed row whose date ends up unchanged sends nothing.
    expect(taskDatesPatch({ nextEnd: '2026-11-20', manual: true, release: true, preview: dryRun, ...stored })).toBeNull();
  });

  it('a cleared due date sends endDate: null only — the server clears the flag for a null date', () => {
    expect(taskDatesPatch({ nextEnd: '', manual: false, release: true, ...stored })).toEqual({ endDate: null });
    expect(taskDatesPatch({ nextEnd: null, manual: true, release: false, ...stored })).toEqual({ endDate: null });
  });

  it('release: false / absent behaves exactly as before', () => {
    expect(
      taskDatesPatch({ nextEnd: '2029-03-09', manual: false, release: false, preview: dryRun, ...stored }),
    ).toEqual({ endDate: '2029-03-09', estimatedStartDate: '2029-03-05' });
    expect(taskDatesPatch({ nextEnd: '2026-11-20', manual: false, ...stored })).toBeNull();
    expect(
      taskDatesPatch({
        nextEnd: '2026-11-20',
        manual: false,
        preview: { startDate: '2026-11-18', endDate: '2026-11-20' },
        ...stored,
      }),
    ).toEqual({ estimatedStartDate: '2026-11-18' });
  });

  it('a pinned task with no stored due date can still be released', () => {
    expect(taskDatesPatch({ nextEnd: '', manual: false, release: true, storedStart: null, storedEnd: null })).toEqual({
      manualDueDate: false,
    });
  });
});

describe('manual-due-date texts', () => {
  it('the fixed strings', () => {
    expect(MANUAL_DUE_TEXT).toBe('תאריך ידני — לא זז כשהיעד משתנה');
    expect(MANUAL_DUE_KEPT_TEXT).toBe('תאריך ידני — נשאר במקומו');
    expect(MANUAL_DUE_RELEASED_TEXT).toBe('תאריך ידני — יחושב מחדש לפי היעד');
  });

  it('manualReviewHint: plural, singular, none', () => {
    expect(manualReviewHint(3)).toBe(
      '3 משימות עם תאריך ידני. מסומנת = תחושב מחדש לפי היעד ותחזור לתזמון אוטומטי. הסר סימון כדי להשאיר את התאריך הידני.',
    );
    expect(manualReviewHint(1)).toBe(
      'משימה אחת עם תאריך ידני. מסומנת = תחושב מחדש לפי היעד ותחזור לתזמון אוטומטי. הסר סימון כדי להשאיר את התאריך הידני.',
    );
    expect(manualReviewHint(0)).toBe('');
  });

  it('taskBarTooltip: a manual task gets the second line, after the critical suffix', () => {
    expect(
      taskBarTooltip({ code: 'CRD-036', name: 'Coordination drawings', startIso: '2026-11-16', endIso: '2026-11-20', critical: false, manual: true }),
    ).toBe('CRD-036 · Coordination drawings · 2026-11-16 → 2026-11-20\nתאריך ידני — לא זז כשהיעד משתנה');
    expect(
      taskBarTooltip({ code: null, name: 'Survey', startIso: '2026-11-16', endIso: '2026-11-20', critical: true, manual: true }),
    ).toBe('Survey · 2026-11-16 → 2026-11-20 · critical path\nתאריך ידני — לא זז כשהיעד משתנה');
    // Not manual → one line, as before.
    expect(
      taskBarTooltip({ code: null, name: 'Survey', startIso: '2026-11-16', endIso: '2026-11-20', critical: false, manual: false }),
    ).toBe('Survey · 2026-11-16 → 2026-11-20');
  });
});

describe('review rows · manual tasks', () => {
  const moving = { taskId: 1, willMove: true, manual: false, beforeEnd: '2026-11-20', afterEnd: '2029-03-09' };
  const still = { taskId: 2, willMove: false, manual: false, beforeEnd: '2026-12-04', afterEnd: '2026-12-04' };
  const pinned = { taskId: 3, willMove: false, manual: true, beforeEnd: '2026-11-27', afterEnd: '2026-11-27' };
  const releasedMoving = { taskId: 3, willMove: true, manual: true, beforeEnd: '2026-11-27', afterEnd: '2029-03-02' };

  it('isReviewRowListed: moving rows as before, manual rows ALWAYS', () => {
    expect(isReviewRowListed(moving)).toBe(true);
    expect(isReviewRowListed(still)).toBe(false);
    expect(isReviewRowListed(pinned)).toBe(true);
    expect(isReviewRowListed(releasedMoving)).toBe(true);
    // `manual` missing (older server) reads as not manual.
    expect(isReviewRowListed({ taskId: 9, willMove: false })).toBe(false);
  });

  it('mergeReviewChoices: initial seed — moving rows checked, manual rows checked ⇔ released', () => {
    expect(mergeReviewChoices(null, {}, [moving, still, releasedMoving], new Set([3]))).toEqual({
      1: { apply: true, end: '2029-03-09' },
      2: { apply: false, end: '2026-12-04' },
      3: { apply: true, end: '2029-03-02' },
    });
    expect(mergeReviewChoices(null, {}, [moving, pinned], new Set())[3]).toEqual({ apply: false, end: '2026-11-27' });
  });

  it('mergeReviewChoices: a released manual row whose dates do not change is still checked', () => {
    expect(mergeReviewChoices(null, {}, [pinned], new Set([3]))[3].apply).toBe(true);
  });

  it('mergeReviewChoices: a re-run keeps the PM\'s choice on a row that still moves', () => {
    const prevChoices = { 1: { apply: false, end: '2029-03-09' }, 3: { apply: true, end: '2029-03-02' } };
    const movedElsewhere = { ...moving, afterEnd: '2029-02-23' };
    // Task 3 was un-released; the server re-ran with it pinned.
    const out = mergeReviewChoices([moving, releasedMoving], prevChoices, [movedElsewhere, pinned], new Set());
    expect(out[1]).toEqual({ apply: false, end: '2029-02-23' });
    expect(out[3]).toEqual({ apply: false, end: '2026-11-27' });
  });

  it('mergeReviewChoices: a row that newly appears defaults to willMove; one that stops moving is unchecked', () => {
    const prevChoices = { 1: { apply: true, end: '2029-03-09' }, 2: { apply: false, end: '2026-12-04' } };
    const nowMoving = { ...still, willMove: true, afterEnd: '2029-03-16' };
    const noLongerMoving = { ...moving, willMove: false, afterEnd: '2026-11-20' };
    const out = mergeReviewChoices([moving, still], prevChoices, [noLongerMoving, nowMoving], new Set());
    expect(out[2]).toEqual({ apply: true, end: '2029-03-16' });
    expect(out[1]).toEqual({ apply: false, end: '2026-11-20' });
  });

  it('mergeReviewChoices: the release set, not the old choice, decides a manual row', () => {
    const prevChoices = { 3: { apply: false, end: '2026-11-27' } };
    expect(mergeReviewChoices([pinned], prevChoices, [releasedMoving], new Set([3]))[3].apply).toBe(true);
  });

  it('reviewCheckedTaskIds: listed + checked only; a checked manual row with unchanged dates is sent', () => {
    const items = [moving, still, pinned];
    expect(
      reviewCheckedTaskIds(items, {
        1: { apply: true, end: '' },
        2: { apply: true, end: '' }, // not listed → never sent
        3: { apply: true, end: '' },
      }),
    ).toEqual([1, 3]);
    expect(reviewCheckedTaskIds(items, { 1: { apply: false, end: '' } })).toEqual([]);
  });

  it('toggledInSet flips membership on a copy', () => {
    const base = new Set([1, 2]);
    expect([...toggledInSet(base, 2)]).toEqual([1]);
    expect([...toggledInSet(base, 3)]).toEqual([1, 2, 3]);
    expect([...base]).toEqual([1, 2]);
  });
});

describe('reviewSubtitle', () => {
  const idle = { computing: false, recalculating: false };

  it('tasks will move → the moving count, as before (manual rows do not change it)', () => {
    expect(reviewSubtitle({ ...idle, movingCount: 5, manualCount: 0 })).toBe('5 משימות יזוזו · אשר להחלה');
    expect(reviewSubtitle({ ...idle, movingCount: 5, manualCount: 3 })).toBe('5 משימות יזוזו · אשר להחלה');
  });

  it('nothing moves and nothing is manual → "אין שינויים", as before', () => {
    expect(reviewSubtitle({ ...idle, movingCount: 0, manualCount: 0 })).toBe('אין שינויים');
  });

  it('nothing moves but manual rows are listed → names them (plural / singular)', () => {
    expect(reviewSubtitle({ ...idle, movingCount: 0, manualCount: 3 })).toBe('אין משימות שיזוזו · 3 עם תאריך ידני');
    expect(reviewSubtitle({ ...idle, movingCount: 0, manualCount: 1 })).toBe('אין משימות שיזוזו · משימה אחת עם תאריך ידני');
  });

  it('computing / recalculating win over the counts', () => {
    expect(reviewSubtitle({ computing: true, recalculating: false, movingCount: 0, manualCount: 0 })).toBe('מחשב תצוגה מקדימה…');
    expect(reviewSubtitle({ computing: false, recalculating: true, movingCount: 5, manualCount: 3 })).toBe('מחשב מחדש…');
    expect(reviewSubtitle({ computing: true, recalculating: true, movingCount: 5, manualCount: 3 })).toBe('מחשב תצוגה מקדימה…');
  });
});

describe('releaseSavePlan', () => {
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

  it('nothing released → Save never waits, nothing to release', () => {
    const plan = releaseSavePlan({ released: new Set(), scheduledIds: new Set([1, 2]), dryRunPending: true });
    expect(plan.waitForDryRun).toBe(false);
    expect(sorted(plan.releasable)).toEqual([]);
  });

  it('released rows + a dry-run still pending → Save waits, and nothing is releasable yet', () => {
    const plan = releaseSavePlan({ released: new Set([3]), scheduledIds: new Set([3]), dryRunPending: true });
    expect(plan.waitForDryRun).toBe(true);
    expect(sorted(plan.releasable)).toEqual([]);
  });

  it('dry-run settled with a row for every released task → all releasable', () => {
    const plan = releaseSavePlan({ released: new Set([3, 4]), scheduledIds: new Set([1, 3, 4]), dryRunPending: false });
    expect(plan.waitForDryRun).toBe(false);
    expect(sorted(plan.releasable)).toEqual([3, 4]);
  });

  it('dry-run settled WITHOUT a row for a released task → that task is dropped from the release', () => {
    const plan = releaseSavePlan({ released: new Set([3, 4]), scheduledIds: new Set([1, 4]), dryRunPending: false });
    expect(plan.waitForDryRun).toBe(false);
    expect(sorted(plan.releasable)).toEqual([4]);
  });

  it('dry-run failed (no rows at all) → nothing is released, Save is not blocked', () => {
    const plan = releaseSavePlan({ released: new Set([3, 4]), scheduledIds: new Set(), dryRunPending: false });
    expect(plan.waitForDryRun).toBe(false);
    expect(sorted(plan.releasable)).toEqual([]);
  });
});

// ── §14b (2026-11-15) ───────────────────────────────────────────────

describe('tasks modal width budget', () => {
  const CELL_PADDING = 24; // px-3 on both sides
  const CARD_BORDER = 2; // 1px each side
  // Vertical scrollbar of the modal body: 15px in current Chrome / Edge,
  // 17px for classic Windows scrollbars.
  const SCROLLBARS = [15, 17];
  const inner = TASKS_MODAL_CARD_PX - CARD_BORDER;
  const fixed =
    TASKS_LIST_COL_PX.code +
    TASKS_LIST_COL_PX.status +
    TASKS_LIST_COL_PX.start +
    TASKS_LIST_COL_PX.due +
    TASKS_LIST_COL_PX.action;

  it('the card is 900px; the fixed columns sum to 702px and the table floor to 866px', () => {
    expect(TASKS_MODAL_CARD_PX).toBe(900);
    expect(fixed).toBe(702);
    expect(TASKS_LIST_TASK_MIN_PX).toBe(164);
    expect(TASKS_LIST_MIN_WIDTH_PX).toBe(fixed + TASKS_LIST_TASK_MIN_PX);
    expect(TASKS_LIST_MIN_WIDTH_PX).toBe(866);
  });

  it('the floor fits beside a 15px AND a 17px scrollbar with real slack — nothing scrolls sideways at the normal width', () => {
    // 15px scrollbar: 883px available → 17px of slack.
    expect(inner - 15 - TASKS_LIST_MIN_WIDTH_PX).toBe(17);
    // 17px scrollbar: 881px available → 15px to spare.
    expect(inner - 17 - TASKS_LIST_MIN_WIDTH_PX).toBe(15);
    for (const scrollbar of SCROLLBARS) {
      // Not a 1px fit: room for a wider scrollbar or a zoom-rounded width.
      expect(inner - scrollbar - TASKS_LIST_MIN_WIDTH_PX).toBeGreaterThanOrEqual(12);
    }
  });

  it('the Task column gets 196px at the normal card width, ~180px beside a scrollbar — above its floor', () => {
    expect(inner - fixed).toBe(196);
    expect(inner - 15 - fixed).toBe(181);
    expect(inner - 17 - fixed).toBe(179);
    for (const scrollbar of SCROLLBARS) {
      expect(inner - scrollbar - fixed).toBeGreaterThan(TASKS_LIST_TASK_MIN_PX);
    }
  });

  it('worst-case row (manual + released + pending) fits every cell', () => {
    // Due: date input ≥ 140px next to the "ידני" pill (~43px), 6px gap.
    expect(TASKS_LIST_COL_PX.due - CELL_PADDING - 6 - 43).toBeGreaterThanOrEqual(140);
    // Action: "Clear" (~48px) + 6px gap + "השאר ידני" (up to ~81px).
    expect(TASKS_LIST_COL_PX.action - CELL_PADDING).toBeGreaterThanOrEqual(48 + 6 + 81);
    // Start: a yyyy-mm-dd date in 11px mono (10 × 6.6px).
    expect(TASKS_LIST_COL_PX.start - CELL_PADDING).toBeGreaterThanOrEqual(66);
    // Status: the "In Progress" pill (~68px).
    expect(TASKS_LIST_COL_PX.status - CELL_PADDING).toBeGreaterThanOrEqual(68);
    // Code: an 11-character code (`AS.AHW.1131`) in 12px mono (11 × 7.2px).
    expect(TASKS_LIST_COL_PX.code).toBe(108);
    expect(TASKS_LIST_COL_PX.code - CELL_PADDING).toBeGreaterThanOrEqual(11 * 7.2);
  });
});

// ── §15 (2026-11-16) ────────────────────────────────────────────────

describe('ganttTaskBarLanes', () => {
  const task = (id: number, start: string | null, end: string | null, over: Record<string, unknown> = {}) => ({
    id,
    name: `T${id}`,
    estimatedStartDate: start,
    endDate: end,
    ...over,
  });
  const lanesById = (list: unknown) =>
    Object.fromEntries(ganttTaskBarLanes(list).items.map((i) => [i.id, i.lane]));

  it('no task list, or an empty one → no items, no lanes', () => {
    expect(ganttTaskBarLanes(undefined)).toEqual({ items: [], laneCount: 0 });
    expect(ganttTaskBarLanes(null)).toEqual({ items: [], laneCount: 0 });
    expect(ganttTaskBarLanes([])).toEqual({ items: [], laneCount: 0 });
  });

  it('tasks without a valid span get no lane and count for none', () => {
    const res = ganttTaskBarLanes([
      task(1, null, '2026-03-01'),
      task(2, '2026-03-01', null),
      task(3, '2026-03-10', '2026-03-01'), // end before start
      task(4, 'not-a-date', '2026-03-01'),
    ]);
    expect(res.items.map((i) => i.lane)).toEqual([-1, -1, -1, -1]);
    expect(res.items.every((i) => !i.hasSpan)).toBe(true);
    expect(res.laneCount).toBe(0);
  });

  it('sequential tasks share lane 0 — touching ends included', () => {
    const list = [
      task(1, '2026-03-01', '2026-03-05'),
      task(2, '2026-03-05', '2026-03-09'),
      task(3, '2026-03-12', '2026-03-12'),
    ];
    expect(lanesById(list)).toEqual({ 1: 0, 2: 0, 3: 0 });
    expect(ganttTaskBarLanes(list).laneCount).toBe(1);
  });

  it('overlapping tasks take separate lanes; a later task reuses the first free lane', () => {
    const list = [
      task(1, '2026-03-01', '2026-03-10'),
      task(2, '2026-03-03', '2026-03-06'),
      task(3, '2026-03-04', '2026-03-08'),
      task(4, '2026-03-07', '2026-03-09'), // lane 1 is free again (T2 ended 03-06)
    ];
    expect(lanesById(list)).toEqual({ 1: 0, 2: 1, 3: 2, 4: 1 });
    expect(ganttTaskBarLanes(list).laneCount).toBe(3);
  });

  it('lanes follow start order, not list order', () => {
    const list = [task(1, '2026-03-05', '2026-03-09'), task(2, '2026-03-01', '2026-03-05')];
    expect(lanesById(list)).toEqual({ 1: 0, 2: 0 });
  });

  it('keeps the bar fields and the in-row dependencies', () => {
    const [it] = ganttTaskBarLanes([
      task(7, '2026-03-01', '2026-03-02', {
        code: 'AS.1',
        onCriticalPath: true,
        dueDateOverridden: true,
        dependencies: [
          { dependsOnId: 3, lag: 2, lagUnit: 'CALENDAR_DAYS' },
          { dependsOn: { id: 4 }, lag: 1 },
          { dependsOnId: 0 },
        ],
      }),
    ]).items;
    expect(it).toMatchObject({ id: 7, code: 'AS.1', name: 'T7', onCriticalPath: true, manual: true, lane: 0 });
    expect(it.deps).toEqual([
      { predId: 3, lag: 2, lagUnit: 'CALENDAR_DAYS' },
      { predId: 4, lag: 1, lagUnit: 'WORKING_DAYS' },
    ]);
  });
});

describe('ganttRowHeightPx', () => {
  it('geometry constants: 32px base row, 6px bars, 4px gaps, strip from y=28', () => {
    expect(GANTT_ROW_BASE_PX).toBe(32);
    expect(GANTT_TASK_BAR_H).toBe(6);
    expect(GANTT_TASK_LANE_GAP).toBe(4);
    expect(GANTT_TASK_STRIP_TOP).toBe(28);
  });

  it('32px when task bars are hidden, there is no target, or no lane', () => {
    expect(ganttRowHeightPx({ hasTarget: true, showTaskBars: false, laneCount: 3 })).toBe(32);
    expect(ganttRowHeightPx({ hasTarget: false, showTaskBars: true, laneCount: 3 })).toBe(32);
    expect(ganttRowHeightPx({ hasTarget: true, showTaskBars: true, laneCount: 0 })).toBe(32);
  });

  it('28 + 10px per lane with task bars shown: 1 lane → 38, 2 → 48, 3 → 58', () => {
    expect(ganttRowHeightPx({ hasTarget: true, showTaskBars: true, laneCount: 1 })).toBe(38);
    expect(ganttRowHeightPx({ hasTarget: true, showTaskBars: true, laneCount: 2 })).toBe(48);
    expect(ganttRowHeightPx({ hasTarget: true, showTaskBars: true, laneCount: 3 })).toBe(58);
  });
});

describe('lag label fit', () => {
  it('width estimate: 7px per character + 4px', () => {
    expect(lagLabelWidthPx('+7ק')).toBe(3 * 7 + 4);
    expect(lagLabelWidthPx('+7ימ"ע')).toBe(6 * 7 + 4);
  });

  it('fits exactly at the estimated width, not 1px below', () => {
    const label = '+7ימ"ע'; // 46px
    expect(lagLabelFits(46, label)).toBe(true);
    expect(lagLabelFits(45.9, label)).toBe(false);
    expect(lagLabelFits(200, label)).toBe(true);
  });

  it('a zero, negative or unusable gap never fits', () => {
    expect(lagLabelFits(0, '+1ק')).toBe(false);
    expect(lagLabelFits(-30, '+1ק')).toBe(false);
    expect(lagLabelFits(Number.NaN, '+1ק')).toBe(false);
  });
});

// ── §16 (2026-11-18) · Hierarchical rows ──────────────────────────────

// Staging project 61 "ניסוי 8" — the work order's DoD. Zone tree in the
// planning payload's order; several ProjectDeliverables per source
// template (duplicates); 24 one-hour tasks.
const P61_ZONES: DpZoneInput[] = [
  {
    id: 725, name: 'מבנה עמית', zoneType: 'building', children: [
      {
        id: 726, name: 'Basment', zoneType: 'building', children: [
          { id: 727, name: 'B2', zoneType: 'level', children: [] },
          { id: 728, name: 'B1', zoneType: 'level', children: [] },
        ],
      },
      {
        id: 729, name: 'Building A', zoneType: 'building', children: [
          { id: 730, name: 'GL', zoneType: 'level', children: [] },
          { id: 731, name: 'L1', zoneType: 'level', children: [] },
          { id: 732, name: 'R', zoneType: 'level', children: [] },
        ],
      },
    ],
  },
];
const KICKOFF = 'תיאום ראשוני';
const READY = 'מוכנות לביצוע\\פתחים';
const DETAILED = 'תכנון מפורט\\התנגשויות וחתכים';
const zdt = (zoneId: number | null, date: string | null, dur: number | null, months: number | null = null) => ({
  zoneId,
  targetDate: date ? `${date}T00:00:00.000Z` : null,
  targetMonths: months,
  estimatedDurationWeeks: dur,
});
const pd = (id: number, src: number | null, name: string, sortOrder: number, zoneTargets: ReturnType<typeof zdt>[] = []): DpDeliverableInput => ({
  id, sourceTemplateId: src, name, sortOrder, zoneTargets,
  service: { name: 'Coordination' }, targetDate: null, targetMonths: null, estimatedDurationWeeks: null,
});
const P61_PDS: DpDeliverableInput[] = [
  pd(240, 41, KICKOFF, 1000, [zdt(725, '2027-01-03', 4)]),
  pd(241, 41, KICKOFF, 1000, [zdt(725, '2027-02-21', 5)]),
  pd(242, 27, READY, 2000),
  pd(243, 27, READY, 2000, [zdt(725, '2027-04-25', 5)]),
  pd(244, 27, READY, 2000, [zdt(725, '2027-05-09', 5)]),
  pd(245, 26, DETAILED, 3000, [zdt(725, '2027-04-04', 5)]),
  pd(246, 26, DETAILED, 3000),
  pd(247, 26, DETAILED, 3000),
  pd(248, 26, DETAILED, 3000, [zdt(725, '2027-06-13', null)]),
];
let nextTaskId = 1;
const tasksOf = (zoneId: number | null, pdId: number | null, n: number, over: Partial<DpTaskInput> = {}): DpTaskInput[] =>
  Array.from({ length: n }, () => {
    const id = nextTaskId++;
    return { id, code: `T-${id}`, name: `Task ${id}`, zoneId, projectDeliverableId: pdId, budgetHours: '1', status: 'not_started', ...over };
  });
const P61_TASKS: DpTaskInput[] = [
  ...tasksOf(726, 240, 2), ...tasksOf(726, 241, 1),
  ...tasksOf(727, 243, 3), ...tasksOf(727, 244, 2), ...tasksOf(727, 245, 4),
  ...tasksOf(728, 244, 5), ...tasksOf(728, 248, 4),
  ...tasksOf(729, 241, 3),
];
const p61 = () => buildDpTree({ zones: P61_ZONES, deliverables: P61_PDS, tasks: P61_TASKS });
const hoursOf = (leaves: readonly { hours: number }[]) => leaves.reduce((s, l) => s + l.hours, 0);

describe('buildDpTree · project 61 (the work order DoD)', () => {
  it('one node per zone at every depth, in API order, empty zones included', () => {
    const { nodes } = p61();
    expect(nodes.map((n) => [n.key, n.name, n.depth, n.parentKey])).toEqual([
      ['zone:725', 'מבנה עמית', 0, null],
      ['zone:726', 'Basment', 1, 'zone:725'],
      ['zone:727', 'B2', 2, 'zone:726'],
      ['zone:728', 'B1', 2, 'zone:726'],
      ['zone:729', 'Building A', 1, 'zone:725'],
      ['zone:730', 'GL', 2, 'zone:729'],
      ['zone:731', 'L1', 2, 'zone:729'],
      ['zone:732', 'R', 2, 'zone:729'],
    ]);
    expect(nodes.find((n) => n.key === 'zone:729')?.childKeys).toEqual(['zone:730', 'zone:731', 'zone:732']);
    expect(nodes.find((n) => n.key === 'zone:727')?.zoneType).toBe('level');
    // No task without a zone → no Project Root node.
    expect(nodes.some((n) => n.key === 'zone:root')).toBe(false);
  });

  it('leaves = (task zone × source template): duplicate PDs merge, no top-zone roll-up', () => {
    const { leaves } = p61();
    expect(leaves.map((l) => ({
      key: l.key, zone: l.zoneName, name: l.deliverableName, pds: l.projectDeliverableIds,
      primary: l.deliverableId, hours: l.hours, saved: l.savedDate, dur: l.savedDurationWeeks,
    }))).toEqual([
      { key: 'tpl:41@zone-726', zone: 'Basment', name: KICKOFF, pds: [240, 241], primary: 240, hours: 3, saved: '2027-02-21', dur: 5 },
      { key: 'tpl:41@zone-729', zone: 'Building A', name: KICKOFF, pds: [241], primary: 241, hours: 3, saved: '2027-02-21', dur: 5 },
      { key: 'tpl:27@zone-727', zone: 'B2', name: READY, pds: [243, 244], primary: 243, hours: 5, saved: '2027-05-09', dur: 5 },
      { key: 'tpl:27@zone-728', zone: 'B1', name: READY, pds: [244], primary: 244, hours: 5, saved: '2027-05-09', dur: 5 },
      { key: 'tpl:26@zone-727', zone: 'B2', name: DETAILED, pds: [245], primary: 245, hours: 4, saved: '2027-04-04', dur: 5 },
      { key: 'tpl:26@zone-728', zone: 'B1', name: DETAILED, pds: [248], primary: 248, hours: 4, saved: '2027-06-13', dur: null },
    ]);
    // PDs without tasks (242, 246, 247) are not shown (option ב).
    expect(leaves.flatMap((l) => l.projectDeliverableIds)).not.toEqual(expect.arrayContaining([242]));
  });

  it('a leaf carries its zone position and its root ancestor', () => {
    const b2 = p61().leaves.find((l) => l.key === 'tpl:27@zone-727')!;
    expect(b2).toMatchObject({
      zoneId: 727, zoneName: 'B2', zoneType: 'level', parentZoneId: 726, depth: 2,
      topLevelZoneId: 725, topLevelZoneName: 'מבנה עמית', deliverableKey: 'tpl:27',
      serviceName: 'Coordination', taskTotal: 5, taskStarted: 0, taskDone: 0,
    });
    expect(b2.taskList).toHaveLength(5);
  });

  it('the tree a view draws: Basment → [kickoff 3h · B2 → 2 · B1 → 2]; Building A → [kickoff 3h · GL/L1/R empty]', () => {
    const { nodes, leaves } = p61();
    const slots = flattenZoneTree(nodes, leaves, { collapsed: new Set(), hideEmpty: false });
    expect(slots.map((s) => (s.kind === 'node'
      ? `${'  '.repeat(s.node.depth)}${s.node.name} Σ${hoursOf(s.subtreeLeaves)}h`
      : `${'  '.repeat(s.node.depth + 1)}${s.leaf.deliverableName} ${s.leaf.hours}h`))).toEqual([
      'מבנה עמית Σ24h',
      '  Basment Σ21h',
      `    ${KICKOFF} 3h`,
      '    B2 Σ9h',
      `      ${READY} 5h`,
      `      ${DETAILED} 4h`,
      '    B1 Σ9h',
      `      ${READY} 5h`,
      `      ${DETAILED} 4h`,
      '  Building A Σ3h',
      `    ${KICKOFF} 3h`,
      '    GL Σ0h',
      '    L1 Σ0h',
      '    R Σ0h',
    ]);
  });

  it('every task is in exactly one leaf', () => {
    const { leaves } = p61();
    const ids = leaves.flatMap((l) => l.taskList.map((t) => t.id));
    expect(ids).toHaveLength(P61_TASKS.length);
    expect(new Set(ids).size).toBe(P61_TASKS.length);
    expect(hoursOf(leaves)).toBe(24);
  });
});

describe('buildDpTree · edge cases', () => {
  const zones: DpZoneInput[] = [{ id: 1, name: 'A', zoneType: 'building', children: [{ id: 2, name: 'A1', zoneType: 'level' }] }];
  const pds = [pd(10, 5, 'Design', 100), pd(11, null, 'Loose', 200)];

  it('tasks without a zone → a Project Root node FIRST and a root leaf', () => {
    const { nodes, leaves } = buildDpTree({ zones, deliverables: pds, tasks: [...tasksOf(null, 10, 2), ...tasksOf(2, 10, 1)] });
    expect(nodes.map((n) => n.key)).toEqual(['zone:root', 'zone:1', 'zone:2']);
    expect(nodes[0]).toMatchObject({ zoneId: null, name: 'Project Root', depth: 0, parentKey: null });
    const root = leaves.find((l) => l.zoneId == null)!;
    expect(root).toMatchObject({ key: 'tpl:5@zone-root', zoneName: 'Project Root', depth: 0, topLevelZoneId: null, topLevelZoneName: 'Project Root', hours: 2 });
    // Same deliverable: the zoned leaf comes first in the flat order.
    expect(leaves.map((l) => l.key)).toEqual(['tpl:5@zone-2', 'tpl:5@zone-root']);
  });

  it('no zones at all → only the Project Root node', () => {
    const { nodes, leaves } = buildDpTree({ zones: [], deliverables: pds, tasks: tasksOf(null, 11, 1) });
    expect(nodes.map((n) => n.key)).toEqual(['zone:root']);
    expect(leaves.map((l) => l.key)).toEqual(['pd:11@zone-root']);
  });

  it('a PD without a source template is its own identity', () => {
    expect(deliverableKeyOf({ id: 11, sourceTemplateId: null })).toBe('pd:11');
    expect(deliverableKeyOf({ id: 10, sourceTemplateId: 5 })).toBe('tpl:5');
  });

  it('a task of a deleted PD still gets a leaf (named by its id)', () => {
    const { leaves } = buildDpTree({ zones, deliverables: pds, tasks: tasksOf(1, 999, 1) });
    expect(leaves[0]).toMatchObject({ key: 'pd:999@zone-1', deliverableId: 999, projectDeliverableIds: [999], deliverableName: 'Deliverable #999', savedDate: null });
  });

  it('a task zone missing from the tree gets a root-level node after the real ones', () => {
    const { nodes, leaves } = buildDpTree({ zones, deliverables: pds, tasks: tasksOf(77, 10, 1) });
    expect(nodes.map((n) => [n.key, n.name, n.depth])).toEqual([['zone:1', 'A', 0], ['zone:2', 'A1', 1], ['zone:77', 'Zone #77', 0]]);
    expect(leaves[0]).toMatchObject({ zoneId: 77, zoneName: 'Zone #77', depth: 0, topLevelZoneId: 77 });
  });

  it('synthetic deliverables: read-only leaves with negative ids, one identity per name', () => {
    const syntheticOf = (t: DpTaskInput) =>
      t.name.startsWith('Task') ? { name: t.code === 'T-x' ? 'Marker' : 'Template', serviceName: 'Svc', readOnlyReason: 'why' } : null;
    const tasks: DpTaskInput[] = [
      ...tasksOf(2, null, 2),
      { id: 5000, code: 'T-x', name: 'Task x', zoneId: 2, projectDeliverableId: null },
      { id: 5001, code: null, name: 'orphan', zoneId: 2, projectDeliverableId: null }, // resolves to nothing
    ];
    const { leaves } = buildDpTree({ zones, deliverables: pds, tasks, syntheticOf });
    expect(leaves.map((l) => [l.key, l.deliverableId, l.projectDeliverableIds, l.readOnly, l.readOnlyReason, l.serviceName, l.taskList.length]))
      .toEqual([
        ['syn:Marker@zone-2', -2, [], true, 'why', 'Svc', 1],
        ['syn:Template@zone-2', -1, [], true, 'why', 'Svc', 2],
      ]);
    expect(leaves.every((l) => l.savedDate == null && l.savedMonths == null)).toBe(true);
    // Without a resolver such tasks are skipped.
    expect(buildDpTree({ zones, deliverables: pds, tasks }).leaves).toEqual([]);
  });

  it('leaf summaries (start min, due max, float min, critical path) and node rollups of float / CP', () => {
    const tasks: DpTaskInput[] = [
      ...tasksOf(2, 10, 1, { estimatedStartDate: '2027-03-01T00:00:00.000Z', endDate: '2027-03-10T00:00:00.000Z', float: 4 }),
      ...tasksOf(2, 10, 1, { estimatedStartDate: '2027-02-15', endDate: '2027-04-01', float: 0, onCriticalPath: true, status: 'completed' }),
      ...tasksOf(2, 10, 1, { float: null, status: 'in_progress' }),
      ...tasksOf(1, 11, 1, { float: 9 }),
    ];
    const { leaves, nodes } = buildDpTree({ zones, deliverables: pds, tasks });
    const a1 = leaves.find((l) => l.zoneId === 2)!;
    expect(a1).toMatchObject({
      taskStartMin: '2027-02-15', taskDueMax: '2027-04-01', floatMin: 0, onCriticalPath: true,
      taskTotal: 3, taskStarted: 2, taskDone: 1,
    });
    expect(a1.taskList.find((t) => t.onCriticalPath)).toMatchObject({ endDate: '2027-04-01', estimatedStartDate: '2027-02-15', float: 0 });
    const a = leaves.find((l) => l.zoneId === 1)!;
    expect(a).toMatchObject({ taskStartMin: null, taskDueMax: null, floatMin: 9, onCriticalPath: false });
    expect(nodes.find((n) => n.key === 'zone:1')).toMatchObject({ floatMin: 0, onCriticalPath: true });
    expect(nodes.find((n) => n.key === 'zone:2')).toMatchObject({ floatMin: 0, onCriticalPath: true });
  });

  it('inside one zone the leaves follow the PD sortOrder', () => {
    const many = [pd(20, 1, 'Zeta', 300), pd(21, 2, 'Alpha', 100), pd(22, 3, 'Mid', 200)];
    const { leaves } = buildDpTree({ zones, deliverables: many, tasks: [...tasksOf(1, 20, 1), ...tasksOf(1, 21, 1), ...tasksOf(1, 22, 1)] });
    expect(leaves.map((l) => l.deliverableName)).toEqual(['Alpha', 'Mid', 'Zeta']);
  });

  it('a repeated zone id in the tree does not loop or re-parent', () => {
    const looped: DpZoneInput[] = [{ id: 1, name: 'A', children: [{ id: 2, name: 'A1', children: [{ id: 1, name: 'A again' }] }] }];
    const { nodes } = buildDpTree({ zones: looped, deliverables: pds, tasks: [] });
    expect(nodes.map((n) => [n.key, n.depth])).toEqual([['zone:1', 0], ['zone:2', 1]]);
  });
});

describe('resolveLeafSavedTarget · the scheduler rule (closest ancestor-or-self dated ZDT)', () => {
  // 1 ⊃ 2 ⊃ 3
  const parentOf = new Map<number, number | null>([[1, null], [2, 1], [3, 2]]);

  it("the leaf's OWN zone target beats an ancestor's", () => {
    const d = pd(1, 1, 'D', 0, [zdt(1, '2027-01-03', 2, 6), zdt(3, '2027-09-05', 8, 12)]);
    expect(resolveLeafSavedTarget([d], 3, parentOf)).toEqual({ savedDate: '2027-09-05', savedMonths: 12, savedDurationWeeks: 8 });
  });

  it('the closest ancestor wins over a farther one', () => {
    const d = pd(1, 1, 'D', 0, [zdt(1, '2027-01-03', 2), zdt(2, '2027-05-02', 3)]);
    expect(resolveLeafSavedTarget([d], 3, parentOf).savedDate).toBe('2027-05-02');
    expect(resolveLeafSavedTarget([d], 1, parentOf).savedDate).toBe('2027-01-03');
  });

  it("an ancestor's target is inherited", () => {
    const d = pd(1, 1, 'D', 0, [zdt(1, '2027-01-03', 2, 6)]);
    expect(resolveLeafSavedTarget([d], 3, parentOf)).toEqual({ savedDate: '2027-01-03', savedMonths: 6, savedDurationWeeks: 2 });
  });

  it('a ZDT without a targetDate does not claim the date — but its duration is the closest one', () => {
    const d = pd(1, 1, 'D', 0, [zdt(1, '2027-01-03', 2, 6), zdt(2, null, 7, 9)]);
    expect(resolveLeafSavedTarget([d], 3, parentOf)).toEqual({ savedDate: '2027-01-03', savedMonths: 6, savedDurationWeeks: 7 });
  });

  it('a ghost ZDT (no date, months or duration) is ignored', () => {
    const d = { ...pd(1, 1, 'D', 0, [zdt(3, null, null), zdt(1, '2027-01-03', 2)]) };
    expect(resolveLeafSavedTarget([d], 3, parentOf)).toEqual({ savedDate: '2027-01-03', savedMonths: null, savedDurationWeeks: 2 });
  });

  it('nothing on the way up → the PD-level fields', () => {
    const d: DpDeliverableInput = { ...pd(1, 1, 'D', 0), targetDate: '2028-02-06T00:00:00.000Z', targetMonths: 15, estimatedDurationWeeks: 6 };
    expect(resolveLeafSavedTarget([d], 3, parentOf)).toEqual({ savedDate: '2028-02-06', savedMonths: 15, savedDurationWeeks: 6 });
    // A sibling-branch ZDT is not an ancestor.
    const other = new Map<number, number | null>([[1, null], [2, 1], [3, 1]]);
    const sib: DpDeliverableInput = { ...d, zoneTargets: [zdt(2, '2027-01-03', 1)] };
    expect(resolveLeafSavedTarget([sib], 3, other).savedDate).toBe('2028-02-06');
  });

  it('a Project Root leaf reads the zone-less ZDT, then the PD level — never a zone target', () => {
    const d: DpDeliverableInput = { ...pd(1, 1, 'D', 0, [zdt(1, '2027-01-03', 2), zdt(null, '2027-07-04', 3, 4)]), targetDate: '2028-01-02' };
    expect(resolveLeafSavedTarget([d], null, parentOf)).toEqual({ savedDate: '2027-07-04', savedMonths: 4, savedDurationWeeks: 3 });
    const noRoot: DpDeliverableInput = { ...d, zoneTargets: [zdt(1, '2027-01-03', 2)] };
    expect(resolveLeafSavedTarget([noRoot], null, parentOf)).toEqual({ savedDate: '2028-01-02', savedMonths: null, savedDurationWeeks: null });
  });

  it('a leaf with 2 PDs shows the LATEST date (with its months) and the LONGEST duration', () => {
    const a = pd(1, 1, 'D', 0, [zdt(1, '2027-05-09', 3, 8)]);
    const b = pd(2, 1, 'D', 0, [zdt(2, '2027-02-21', 9, 5)]);
    expect(resolveLeafSavedTarget([a, b], 3, parentOf)).toEqual({ savedDate: '2027-05-09', savedMonths: 8, savedDurationWeeks: 9 });
    expect(resolveLeafSavedTarget([b, a], 3, parentOf)).toEqual({ savedDate: '2027-05-09', savedMonths: 8, savedDurationWeeks: 9 });
  });

  it('no date anywhere → no date; months still surface (legacy months-only rows)', () => {
    const d: DpDeliverableInput = { ...pd(1, 1, 'D', 0), targetMonths: 3 };
    expect(resolveLeafSavedTarget([d], 3, parentOf)).toEqual({ savedDate: null, savedMonths: 3, savedDurationWeeks: null });
    expect(resolveLeafSavedTarget([], 3, parentOf)).toEqual({ savedDate: null, savedMonths: null, savedDurationWeeks: null });
  });

  it('buildDpTree uses it: a sub-zone target owns the sub-zone leaf, the root target the others', () => {
    const zones: DpZoneInput[] = [{ id: 1, name: 'A', children: [{ id: 2, name: 'A1' }, { id: 3, name: 'A2' }] }];
    const d = pd(10, 5, 'Design', 0, [zdt(1, '2027-01-03', 2), zdt(2, '2027-08-01', 4)]);
    const { leaves } = buildDpTree({ zones, deliverables: [d], tasks: [...tasksOf(2, 10, 1), ...tasksOf(3, 10, 1)] });
    expect(leaves.map((l) => [l.zoneName, l.savedDate, l.savedDurationWeeks])).toEqual([['A1', '2027-08-01', 4], ['A2', '2027-01-03', 2]]);
  });
});

describe('flattenZoneTree', () => {
  const tree = () => p61();

  it('a collapsed node is drawn; its whole sub-tree is not', () => {
    const { nodes, leaves } = tree();
    const slots = flattenZoneTree(nodes, leaves, { collapsed: new Set(['zone:726']), hideEmpty: false });
    expect(slots.map((s) => (s.kind === 'node' ? s.node.key : s.leaf.key))).toEqual([
      'zone:725', 'zone:726', 'zone:729', 'tpl:41@zone-729', 'zone:730', 'zone:731', 'zone:732',
    ]);
    // …and still rolls its sub-tree up.
    const basment = slots.find((s) => s.kind === 'node' && s.node.key === 'zone:726');
    expect(basment?.kind === 'node' && basment.collapsed).toBe(true);
    expect(basment?.kind === 'node' ? hoursOf(basment.subtreeLeaves) : -1).toBe(21);
  });

  it('collapsing the root hides everything below it', () => {
    const { nodes, leaves } = tree();
    expect(flattenZoneTree(nodes, leaves, { collapsed: new Set(['zone:725']), hideEmpty: false })).toHaveLength(1);
  });

  it('hideEmpty (a filter is on): zones without a visible leaf below them are left out, ancestors stay', () => {
    const { nodes, leaves } = tree();
    const onlyB1 = leaves.filter((l) => l.zoneId === 728);
    const slots = flattenZoneTree(nodes, onlyB1, { collapsed: new Set(), hideEmpty: true });
    expect(slots.map((s) => (s.kind === 'node' ? s.node.key : s.leaf.key))).toEqual([
      'zone:725', 'zone:726', 'zone:728', 'tpl:27@zone-728', 'tpl:26@zone-728',
    ]);
    // Without hideEmpty every zone is still drawn.
    expect(flattenZoneTree(nodes, onlyB1, { collapsed: new Set(), hideEmpty: false }).filter((s) => s.kind === 'node')).toHaveLength(8);
  });

  it("a zone's leaves keep the given order (the view's sort / saved row order)", () => {
    const { nodes, leaves } = tree();
    const reversed = [...leaves].reverse();
    const b2 = flattenZoneTree(nodes, reversed, { collapsed: new Set(), hideEmpty: false })
      .filter((s): s is Extract<typeof s, { kind: 'leaf' }> => s.kind === 'leaf' && s.node.key === 'zone:727')
      .map((s) => s.leaf.key);
    expect(b2).toEqual(['tpl:26@zone-727', 'tpl:27@zone-727']);
  });

  it('reorder stays inside a zone: the group key of a leaf is its own zone node', () => {
    const { leaves } = tree();
    const groupOf = new Map(leaves.map((l): [string, string] => [l.key, zoneNodeKey(l.zoneId)]));
    expect(canReorderOnto(groupOf, 'tpl:27@zone-727', 'tpl:26@zone-727')).toBe(true);
    expect(canReorderOnto(groupOf, 'tpl:27@zone-727', 'tpl:27@zone-728')).toBe(false);
    expect(zoneNodeKey(null)).toBe('zone:root');
    expect(zoneNodeKey(undefined)).toBe('zone:root');
  });
});

describe('buildTargetItems · a leaf with several ProjectDeliverables', () => {
  const leaf = (over: Partial<TargetRowLike> = {}): TargetRowLike =>
    row({ key: 'tpl:27@zone-727', deliverableId: 243, projectDeliverableIds: [243, 244], zoneId: 727, ...over });

  it('explicit date → one item per PD, same zone and fields', () => {
    const r = leaf({ savedDate: '2027-05-09', savedDurationWeeks: 5 });
    expect(buildTargetItems([r], {}, { [r.key]: '5' }, { [r.key]: '2027-06-06' }, computePreview)).toEqual([
      { id: 243, zoneId: 727, months: null, durationWeeks: 5, targetDate: '2027-06-06' },
      { id: 244, zoneId: 727, months: null, durationWeeks: 5, targetDate: '2027-06-06' },
    ]);
  });

  it('months edit and duration-only edit fan out the same way', () => {
    const r = leaf({ savedDate: '2027-05-09', savedMonths: null, savedDurationWeeks: 5 });
    expect(buildTargetItems([r], { [r.key]: '7' }, { [r.key]: '5' }, {}, computePreview)).toEqual([
      { id: 243, zoneId: 727, months: 7, durationWeeks: 5 },
      { id: 244, zoneId: 727, months: 7, durationWeeks: 5 },
    ]);
    expect(buildTargetItems([r], {}, { [r.key]: '6' }, {}, computePreview)).toEqual([
      { id: 243, zoneId: 727, months: null, durationWeeks: 6, targetDate: '2027-05-09' },
      { id: 244, zoneId: 727, months: null, durationWeeks: 6, targetDate: '2027-05-09' },
    ]);
  });

  it('without `projectDeliverableIds` the row sends its own deliverableId, as before', () => {
    const r = row({ key: 'k', deliverableId: 12, zoneId: 3 });
    expect(buildTargetItems([r], { k: '2' }, {}, {}, computePreview)).toEqual([{ id: 12, zoneId: 3, months: 2, durationWeeks: null }]);
  });

  it('the project-61 leaves feed it directly', () => {
    const basment = p61().leaves.find((l) => l.key === 'tpl:41@zone-726') as DpLeaf;
    expect(buildTargetItems([basment], {}, {}, { [basment.key]: '2027-03-07' }, computePreview).map((i) => [i.id, i.zoneId, i.targetDate]))
      .toEqual([[240, 726, '2027-03-07'], [241, 726, '2027-03-07']]);
  });
});

describe('rowProjectDeliverableIds', () => {
  it('the row ids, else [deliverableId]; never a synthetic (≤ 0) id', () => {
    expect(rowProjectDeliverableIds({ deliverableId: 243, projectDeliverableIds: [243, 244] })).toEqual([243, 244]);
    expect(rowProjectDeliverableIds({ deliverableId: 12 })).toEqual([12]);
    expect(rowProjectDeliverableIds({ deliverableId: 12, projectDeliverableIds: [] })).toEqual([12]);
    expect(rowProjectDeliverableIds({ deliverableId: -1, projectDeliverableIds: [] })).toEqual([]);
  });
});

describe('mergeDryRunPayloads', () => {
  it('merges the scheduled rows of every PD by task id', () => {
    const merged = mergeDryRunPayloads([
      { scheduled: [{ taskId: 1, endDate: 'a' }, { taskId: 2, endDate: 'b' }], feasibility: { reason: 'ok-1' } },
      { scheduled: [{ taskId: 3, endDate: 'c' }, { taskId: 2, endDate: 'dup' }] },
    ]);
    expect(merged.scheduled).toEqual([{ taskId: 1, endDate: 'a' }, { taskId: 2, endDate: 'b' }, { taskId: 3, endDate: 'c' }]);
    expect(merged.feasibility).toEqual({ reason: 'ok-1' });
  });

  it('nothing scheduled → the first reason explains the empty preview', () => {
    expect(mergeDryRunPayloads([
      null,
      { scheduled: [], feasibility: { reason: 'no-target-row' } },
      { scheduled: [], feasibility: { reason: 'no-tasks' } },
    ])).toEqual({ scheduled: [], feasibility: { reason: 'no-target-row' } });
    expect(mergeDryRunPayloads([])).toEqual({ scheduled: [] });
  });

  it('with rows, the feasibility of the first answer that has rows', () => {
    expect(mergeDryRunPayloads([
      { scheduled: [], feasibility: { reason: 'no-target-row' } },
      { scheduled: [{ taskId: 9 }], feasibility: { status: 'feasible' } },
    ]).feasibility).toEqual({ status: 'feasible' });
  });
});
