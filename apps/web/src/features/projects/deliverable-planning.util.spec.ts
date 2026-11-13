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
  type TargetRowLike,
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
