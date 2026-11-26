/**
 * §12 (2026-11-14) · target scope — pure tree rules + the memoised
 * loader. The scheduler / project-deliverables specs cover the rule
 * end-to-end; these pin the edge cases of the tree walk itself.
 *
 *   1 ── 2 ── 4
 *     └─ 3 ── 5 ── 6
 *   9
 */
import {
  createGoverningTargetDateLookup,
  createTargetScopeMemo,
  loadTargetScopeZoneIds,
  loadUngovernedZoneIds,
  resolveGoverningTargetZoneId,
  resolveTargetScopeZoneIds,
  resolveUngovernedZoneIds,
  type ZoneTreeNode,
} from './target-scope.util';

const ZONES: ZoneTreeNode[] = [
  { id: 1, parentId: null },
  { id: 2, parentId: 1 },
  { id: 3, parentId: 1 },
  { id: 4, parentId: 2 },
  { id: 5, parentId: 3 },
  { id: 6, parentId: 5 },
  { id: 9, parentId: null },
];

describe('resolveTargetScopeZoneIds', () => {
  it('returns the root and all its descendants when no descendant has a target', () => {
    expect(resolveTargetScopeZoneIds(ZONES, 1, [])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(resolveTargetScopeZoneIds(ZONES, 3, [])).toEqual([3, 5, 6]);
    expect(resolveTargetScopeZoneIds(ZONES, 9, [])).toEqual([9]);
  });

  it('cuts the whole sub-tree of a descendant that has its own target', () => {
    // 3 has a target → 3, 5, 6 belong to it, not to 1.
    expect(resolveTargetScopeZoneIds(ZONES, 1, [3])).toEqual([1, 2, 4]);
    // …and 3's own scope is its sub-tree, minus a deeper target on 6.
    expect(resolveTargetScopeZoneIds(ZONES, 3, [1, 3, 6])).toEqual([3, 5]);
  });

  it('the root is always in its own scope — its own / an ancestor’s target does not remove it', () => {
    expect(resolveTargetScopeZoneIds(ZONES, 1, [1])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(resolveTargetScopeZoneIds(ZONES, 5, [1, 3])).toEqual([5, 6]);
  });

  it('a root missing from the zone list (e.g. a soft-deleted zone) still yields itself', () => {
    expect(resolveTargetScopeZoneIds(ZONES, 77, [])).toEqual([77]);
    expect(resolveTargetScopeZoneIds([], 77, [3])).toEqual([77]);
  });

  it('does not loop on a corrupt parent cycle', () => {
    const cyclic: ZoneTreeNode[] = [
      { id: 1, parentId: 3 },
      { id: 2, parentId: 1 },
      { id: 3, parentId: 2 },
    ];
    expect(resolveTargetScopeZoneIds(cyclic, 1, [])).toEqual([1, 2, 3]);
  });

  it('the scopes of all targets partition the zones they cover', () => {
    const targets = [1, 3, 6];
    const scopes = targets.map((z) => resolveTargetScopeZoneIds(ZONES, z, targets));
    expect(scopes).toEqual([[1, 2, 4], [3, 5], [6]]);
    const all = scopes.flat();
    expect(new Set(all).size).toBe(all.length); // no zone in two scopes
  });
});

describe('resolveGoverningTargetZoneId', () => {
  it('returns the closest ancestor-or-self zone that has a target', () => {
    expect(resolveGoverningTargetZoneId(ZONES, 6, [1])).toBe(1);
    expect(resolveGoverningTargetZoneId(ZONES, 6, [1, 3])).toBe(3);
    expect(resolveGoverningTargetZoneId(ZONES, 6, [1, 3, 6])).toBe(6);
    expect(resolveGoverningTargetZoneId(ZONES, 4, [1, 3])).toBe(1);
  });

  it('returns null when nothing on the way up has a target', () => {
    expect(resolveGoverningTargetZoneId(ZONES, 6, [])).toBeNull();
    expect(resolveGoverningTargetZoneId(ZONES, 6, [2, 9])).toBeNull(); // siblings / other trees do not count
  });

  it('agrees with resolveTargetScopeZoneIds for every zone', () => {
    const targets = [1, 3, 6];
    for (const z of ZONES) {
      const governing = resolveGoverningTargetZoneId(ZONES, z.id, targets);
      const owners = targets.filter((t) => resolveTargetScopeZoneIds(ZONES, t, targets).includes(z.id));
      expect(owners).toEqual(governing == null ? [] : [governing]);
    }
  });

  it('does not loop on a corrupt parent cycle', () => {
    const cyclic: ZoneTreeNode[] = [
      { id: 1, parentId: 2 },
      { id: 2, parentId: 1 },
    ];
    expect(resolveGoverningTargetZoneId(cyclic, 1, [])).toBeNull();
  });
});

// PR-077 follow-up (2026-11-26) · the zones a deliverable's project-level
// target takes over: the complement of its zone targets' scopes.
describe('resolveUngovernedZoneIds', () => {
  it('no zone target → every live zone; a target removes its whole scope', () => {
    expect(resolveUngovernedZoneIds(ZONES, [])).toEqual([1, 2, 3, 4, 5, 6, 9]);
    expect(resolveUngovernedZoneIds(ZONES, [3])).toEqual([1, 2, 4, 9]);
    expect(resolveUngovernedZoneIds(ZONES, [1])).toEqual([9]);
    expect(resolveUngovernedZoneIds(ZONES, [1, 9])).toEqual([]);
  });

  it('is exactly the complement of the zone targets’ scopes', () => {
    for (const targets of [[], [3], [1, 6], [2, 5], [6, 9]]) {
      const covered = targets.flatMap((t) => resolveTargetScopeZoneIds(ZONES, t, targets));
      const ungoverned = resolveUngovernedZoneIds(ZONES, targets);
      expect(ungoverned.filter((z) => covered.includes(z))).toEqual([]);
      expect([...covered, ...ungoverned].sort((a, b) => a - b)).toEqual(ZONES.map((z) => z.id).sort((a, b) => a - b));
    }
  });

  it('withinZoneId limits the answer to that sub-tree', () => {
    expect(resolveUngovernedZoneIds(ZONES, [5], 3)).toEqual([3]);
    expect(resolveUngovernedZoneIds(ZONES, [], 3)).toEqual([3, 5, 6]);
    // A zone governed from above has nothing ungoverned under it.
    expect(resolveUngovernedZoneIds(ZONES, [1], 3)).toEqual([]);
  });

  it('a zone that is not live (absent from the tree) is never returned', () => {
    expect(resolveUngovernedZoneIds(ZONES, [], 77)).toEqual([]);
  });
});

describe('loadUngovernedZoneIds', () => {
  it('reads live zones and DATED targets of the deliverable, through the memo', async () => {
    const client = {
      zone: { findMany: jest.fn().mockResolvedValue(ZONES) },
      zoneDeliverableTarget: { findMany: jest.fn().mockResolvedValue([{ zoneId: 3 }]) },
    } as any;
    const memo = createTargetScopeMemo();

    await expect(loadUngovernedZoneIds(client, { projectId: 59, projectDeliverableId: 230 }, memo)).resolves.toEqual([
      1, 2, 4, 9,
    ]);
    await loadTargetScopeZoneIds(client, { projectId: 59, projectDeliverableId: 230, rootZoneId: 3 }, memo);
    expect(client.zone.findMany).toHaveBeenCalledTimes(1);
    expect(client.zoneDeliverableTarget.findMany).toHaveBeenCalledTimes(1);
    expect(client.zoneDeliverableTarget.findMany).toHaveBeenCalledWith({
      where: { projectDeliverableId: 230, targetDate: { not: null } },
      select: { zoneId: true },
    });
  });

  it('an unresolvable project yields no zones, without queries', async () => {
    const client = { zone: { findMany: jest.fn() }, zoneDeliverableTarget: { findMany: jest.fn() } } as any;
    await expect(loadUngovernedZoneIds(client, { projectId: null, projectDeliverableId: 230 })).resolves.toEqual([]);
    expect(client.zone.findMany).not.toHaveBeenCalled();
  });
});

// The read-side lookup used by the planning payload (per-task
// "deliverable target date") and by `forceApplyTargetToTask`.
describe('createGoverningTargetDateLookup', () => {
  const D1 = new Date(Date.UTC(2026, 10, 15));
  const D3 = new Date(Date.UTC(2026, 10, 29));
  const D9 = new Date(Date.UTC(2026, 11, 6));
  const TARGETS = [
    { projectDeliverableId: 230, zoneId: 1, targetDate: D1 },
    { projectDeliverableId: 230, zoneId: 3, targetDate: D3 },
    { projectDeliverableId: 230, zoneId: 5, targetDate: null }, // duration-only row — not a target
    { projectDeliverableId: 231, zoneId: 9, targetDate: D9 },
  ];

  it('resolves the date of the closest ancestor-or-self dated target, per deliverable', () => {
    const lookup = createGoverningTargetDateLookup(ZONES, TARGETS);

    expect(lookup(230, 1)).toBe(D1); // own zone
    expect(lookup(230, 4)).toBe(D1); // 4 → 2 → 1
    expect(lookup(230, 3)).toBe(D3); // closer target wins over 1
    expect(lookup(230, 6)).toBe(D3); // 6 → 5 (date-less, skipped) → 3
    expect(lookup(231, 9)).toBe(D9);
  });

  it('returns null when no zone on the way up has a dated target for THAT deliverable', () => {
    const lookup = createGoverningTargetDateLookup(ZONES, TARGETS);

    expect(lookup(230, 9)).toBeNull(); // other tree
    expect(lookup(231, 4)).toBeNull(); // deliverable 231 is targeted on zone 9 only
    expect(lookup(999, 1)).toBeNull(); // deliverable without any zone target
  });

  it('gives the same answer on repeated calls (memoised) and matches resolveGoverningTargetZoneId', () => {
    const lookup = createGoverningTargetDateLookup(ZONES, TARGETS);
    const dated230 = new Map([
      [1, D1],
      [3, D3],
    ]);
    for (const z of ZONES) {
      const governing = resolveGoverningTargetZoneId(ZONES, z.id, dated230.keys());
      const expected = governing == null ? null : dated230.get(governing);
      expect(lookup(230, z.id)).toBe(expected);
      expect(lookup(230, z.id)).toBe(expected);
    }
  });

  it('without a zone tree only a target on the zone itself can match', () => {
    const lookup = createGoverningTargetDateLookup([], TARGETS);

    expect(lookup(230, 3)).toBe(D3);
    expect(lookup(230, 6)).toBeNull();
  });
});

describe('loadTargetScopeZoneIds', () => {
  function makeClient() {
    return {
      zone: { findMany: jest.fn().mockResolvedValue(ZONES) },
      zoneDeliverableTarget: {
        findMany: jest.fn().mockResolvedValue([{ zoneId: 1 }, { zoneId: 3 }]),
      },
    } as any;
  }

  it('reads live zones of the project and DATED targets of the deliverable', async () => {
    const client = makeClient();

    const scope = await loadTargetScopeZoneIds(client, {
      projectId: 59,
      projectDeliverableId: 230,
      rootZoneId: 1,
    });

    expect(scope).toEqual([1, 2, 4]);
    expect(client.zone.findMany).toHaveBeenCalledWith({
      where: { projectId: 59, deletedAt: null },
      select: { id: true, parentId: true },
    });
    expect(client.zoneDeliverableTarget.findMany).toHaveBeenCalledWith({
      where: { projectDeliverableId: 230, targetDate: { not: null } },
      select: { zoneId: true },
    });
  });

  it('with a memo, the zone tree is read once per project and the targets once per deliverable', async () => {
    const client = makeClient();
    const memo = createTargetScopeMemo();

    await loadTargetScopeZoneIds(client, { projectId: 59, projectDeliverableId: 230, rootZoneId: 1 }, memo);
    await loadTargetScopeZoneIds(client, { projectId: 59, projectDeliverableId: 230, rootZoneId: 3 }, memo);
    await loadTargetScopeZoneIds(client, { projectId: 59, projectDeliverableId: 231, rootZoneId: 1 }, memo);

    expect(client.zone.findMany).toHaveBeenCalledTimes(1);
    expect(client.zoneDeliverableTarget.findMany).toHaveBeenCalledTimes(2);
  });

  it('an unresolvable project degrades to the exact root zone, without queries', async () => {
    const client = makeClient();

    await expect(
      loadTargetScopeZoneIds(client, { projectId: null, projectDeliverableId: 230, rootZoneId: 7 }),
    ).resolves.toEqual([7]);
    expect(client.zone.findMany).not.toHaveBeenCalled();
    expect(client.zoneDeliverableTarget.findMany).not.toHaveBeenCalled();
  });
});
