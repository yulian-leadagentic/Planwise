import {
  resolveTargetIso,
  rowDirtyFlags,
  buildTargetItems,
  seedFromRows,
  mergeDraftsOnRefresh,
  sameDraftMap,
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
});

describe('buildTargetItems', () => {
  const a = row({ key: '10:topzone-1', deliverableId: 10, zoneId: 1, savedDate: '2026-12-13', savedMonths: 6, savedDurationWeeks: 4 });
  const b = row({ key: '11:topzone-2', deliverableId: 11, zoneId: 2, savedDate: '2027-03-07', savedMonths: 9, savedDurationWeeks: null });
  const c = row({ key: '12:root', deliverableId: 12, zoneId: null, savedDate: null, savedMonths: null, savedDurationWeeks: null });
  const rows = [a, b, c];
  const cleanDrafts = { [a.key]: '6', [b.key]: '9' };
  const cleanDur = { [a.key]: '4' };

  it('returns [] when nothing is dirty', () => {
    expect(buildTargetItems(rows, cleanDrafts, cleanDur, {})).toEqual([]);
  });

  it('sends ONLY the rows the user changed', () => {
    const items = buildTargetItems(rows, { ...cleanDrafts, [b.key]: '10' }, cleanDur, {});
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(11);
  });

  it('skips read-only rows even when they carry drafts', () => {
    const ro = row({ key: '-1:root', deliverableId: -1, zoneId: null, readOnly: true });
    expect(
      buildTargetItems([ro], { [ro.key]: '3' }, { [ro.key]: '2' }, { [ro.key]: '2027-01-10' }),
    ).toEqual([]);
  });

  it('explicit-date edit → targetDate + months nulled, duration from the draft', () => {
    const items = buildTargetItems(rows, cleanDrafts, cleanDur, { [a.key]: '2027-01-10' });
    expect(items).toEqual([
      { id: 10, zoneId: 1, months: null, durationWeeks: 4, targetDate: '2027-01-10' },
    ]);
  });

  it('explicit-date edit wins over a dirty months draft on the same row', () => {
    const items = buildTargetItems(rows, { ...cleanDrafts, [a.key]: '8' }, cleanDur, { [a.key]: '2027-01-10' });
    expect(items).toEqual([
      { id: 10, zoneId: 1, months: null, durationWeeks: 4, targetDate: '2027-01-10' },
    ]);
  });

  it('months edit → months as a number and NO targetDate key', () => {
    const items = buildTargetItems(rows, { ...cleanDrafts, [a.key]: '8' }, cleanDur, {});
    expect(items).toEqual([{ id: 10, zoneId: 1, months: 8, durationWeeks: 4 }]);
    expect('targetDate' in items[0]).toBe(false);
  });

  it('cleared months → months null and NO targetDate (server clears the target)', () => {
    const items = buildTargetItems(rows, { ...cleanDrafts, [a.key]: '' }, cleanDur, {});
    expect(items).toEqual([{ id: 10, zoneId: 1, months: null, durationWeeks: 4 }]);
    expect('targetDate' in items[0]).toBe(false);
  });

  it('duration-only edit → pins the saved date and keeps the saved months', () => {
    const items = buildTargetItems(rows, cleanDrafts, { ...cleanDur, [a.key]: '6' }, {});
    expect(items).toEqual([
      { id: 10, zoneId: 1, months: 6, durationWeeks: 6, targetDate: '2026-12-13' },
    ]);
  });

  it('duration-only edit on a row with no saved date → no targetDate key', () => {
    const items = buildTargetItems(rows, cleanDrafts, { ...cleanDur, [c.key]: '3' }, {});
    expect(items).toEqual([{ id: 12, zoneId: null, months: null, durationWeeks: 3 }]);
    expect('targetDate' in items[0]).toBe(false);
  });

  it('cleared duration → durationWeeks null', () => {
    const items = buildTargetItems(rows, cleanDrafts, { [a.key]: '' }, {});
    expect(items).toEqual([
      { id: 10, zoneId: 1, months: 6, durationWeeks: null, targetDate: '2026-12-13' },
    ]);
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

  it('merges each dimension independently of the other two', () => {
    // The tab runs each dimension inside its own functional setState
    // updater, passing {} for the other two — the per-dimension result
    // must be identical to a single combined call.
    const prev = { [K]: seed('6', '4', '2027-05-09'), [OTHER]: seed('9', '', '2027-03-07') };
    const next = { [K]: seed('6', '4', '2027-05-09'), [OTHER]: seed('', '', '2026-12-13') };
    const drafts = { [K]: '8', [OTHER]: '9' };
    const dur = { [K]: '', [OTHER]: '3' };
    const dates = { [K]: '2026-12-20', [OTHER]: '2026-12-13' };
    const combined = mergeDraftsOnRefresh(prev, next, drafts, dur, dates);
    expect(mergeDraftsOnRefresh(prev, next, drafts, {}, {}).drafts).toEqual(combined.drafts);
    expect(mergeDraftsOnRefresh(prev, next, {}, dur, {}).durationDrafts).toEqual(combined.durationDrafts);
    expect(mergeDraftsOnRefresh(prev, next, {}, {}, dates).targetDateDrafts).toEqual(combined.targetDateDrafts);
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
