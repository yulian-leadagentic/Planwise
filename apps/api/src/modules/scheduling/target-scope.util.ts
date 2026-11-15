/**
 * §12 (2026-11-14) · Which tasks does a (ProjectDeliverable × Zone)
 * target own?
 *
 * The Deliverable Planning screen shows ONE row per (project deliverable
 * × TOP zone) and that row lists the tasks of the zone's sub-zones too.
 * Every server path that mapped tasks to a target matched the task's
 * `zoneId` EXACTLY, so a task living in a sub-zone was shown on the row
 * but never scheduled / never given the target date (staging: deliverable
 * 230 targeted on zone 693 "Building A", task BIM-021 in zone 695
 * "Level 1").
 *
 * Rule (one implementation, shared by the scheduler, the
 * project-deliverables module and the planning payload's per-task
 * "deliverable target date" so they cannot drift):
 *
 *   scope(target on zone Z) = tasks of the deliverable whose zone is Z or
 *   a descendant of Z, EXCEPT sub-trees rooted at a descendant zone that
 *   carries its OWN target for the same deliverable.
 *
 * i.e. the closest ancestor-or-self target wins, so every task belongs to
 * exactly one target — the project-wide loops (`previewReschedule`,
 * `saveAndUpdateDueDates`, `scanProjectOverload`) iterate all targets and
 * would otherwise schedule a task twice with a nondeterministic winner.
 *
 * "Carries its own target" = a `ZoneDeliverableTarget` row WITH a
 * `targetDate`. A row that only stores a duration (target date cleared —
 * the empty-ZDT prevention keeps such rows) cannot anchor a schedule:
 * the scheduler returns 'no-anchor' for it. Letting it claim its sub-tree
 * would leave those tasks owned by nobody, which is the bug this rule
 * removes. `forceApplyTargetToTask` already read "no target date" as
 * "no zone target".
 *
 * The tree is walked through `Zone.parentId`, NOT the materialised
 * `Zone.path`: `ZonesService.batchReorder` can re-parent a zone without
 * rewriting `path`, and the zone tree the DP screen builds its rows from
 * (`ZonesService.findTree`) is parentId-based as well.
 */
import type { PrismaClient } from '@prisma/client';

export interface ZoneTreeNode {
  id: number;
  parentId: number | null;
}

/**
 * Zone ids owned by the target on `rootZoneId`: the root itself plus its
 * descendants, minus every sub-tree rooted at a descendant listed in
 * `targetZoneIds`. The root is always part of its own scope (its presence
 * in `targetZoneIds` is irrelevant). Returned ascending for stable
 * queries.
 */
export function resolveTargetScopeZoneIds(
  zones: ReadonlyArray<ZoneTreeNode>,
  rootZoneId: number,
  targetZoneIds: Iterable<number>,
): number[] {
  const claimed = new Set<number>(targetZoneIds);
  const childrenOf = new Map<number, number[]>();
  for (const z of zones) {
    if (z.parentId == null) continue;
    const list = childrenOf.get(z.parentId);
    if (list) list.push(z.id);
    else childrenOf.set(z.parentId, [z.id]);
  }

  const scope = new Set<number>();
  const stack: number[] = [rootZoneId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (scope.has(id)) continue; // defensive — a corrupt parent cycle must not loop
    scope.add(id);
    for (const childId of childrenOf.get(id) ?? []) {
      // A descendant with its own target owns its whole sub-tree.
      if (claimed.has(childId)) continue;
      stack.push(childId);
    }
  }
  return [...scope].sort((a, b) => a - b);
}

/**
 * The zone whose target governs a task living in `zoneId`: the closest
 * ancestor-or-self zone listed in `targetZoneIds`, or null when no zone
 * on the way up to the root has a target. Inverse view of
 * `resolveTargetScopeZoneIds` — a zone is in the scope of exactly the
 * target this returns.
 */
export function resolveGoverningTargetZoneId(
  zones: ReadonlyArray<ZoneTreeNode>,
  zoneId: number,
  targetZoneIds: Iterable<number>,
): number | null {
  return walkUpToTarget(buildParentMap(zones), zoneId, new Set<number>(targetZoneIds));
}

function buildParentMap(zones: ReadonlyArray<ZoneTreeNode>): Map<number, number | null> {
  const parentOf = new Map<number, number | null>();
  for (const z of zones) parentOf.set(z.id, z.parentId);
  return parentOf;
}

function walkUpToTarget(
  parentOf: ReadonlyMap<number, number | null>,
  zoneId: number,
  claimed: { has(zoneId: number): boolean },
): number | null {
  const seen = new Set<number>();
  let cursor: number | null = zoneId;
  while (cursor != null && !seen.has(cursor)) {
    if (claimed.has(cursor)) return cursor;
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  return null;
}

/**
 * Read-side form of the same rule, for callers that resolve the target
 * date of MANY tasks at once (the planning payload) or of one task
 * (`forceApplyTargetToTask`): returns a lookup `(projectDeliverableId,
 * zoneId) → target date of the governing zone target`, or null when no
 * zone on the way up has a dated target for that deliverable (the caller
 * then falls back to the deliverable-level target). The parent map is
 * built once and results are memoised per (deliverable, zone).
 *
 * `targets` may contain date-less rows; they are ignored (not targets).
 * With an empty `zones` list only a target on the task's own zone can
 * match — callers that already know they have such a hit may skip
 * loading the tree.
 */
export function createGoverningTargetDateLookup(
  zones: ReadonlyArray<ZoneTreeNode>,
  targets: ReadonlyArray<{ projectDeliverableId: number; zoneId: number; targetDate: Date | null }>,
): (projectDeliverableId: number, zoneId: number) => Date | null {
  const parentOf = buildParentMap(zones);
  const datedByDeliverable = new Map<number, Map<number, Date>>();
  for (const t of targets) {
    if (!t.targetDate) continue;
    let byZone = datedByDeliverable.get(t.projectDeliverableId);
    if (!byZone) {
      byZone = new Map<number, Date>();
      datedByDeliverable.set(t.projectDeliverableId, byZone);
    }
    byZone.set(t.zoneId, t.targetDate);
  }

  const memo = new Map<string, Date | null>();
  return (projectDeliverableId, zoneId) => {
    const byZone = datedByDeliverable.get(projectDeliverableId);
    if (!byZone) return null;
    const key = `${projectDeliverableId}:${zoneId}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const governingZoneId = walkUpToTarget(parentOf, zoneId, byZone);
    const date = governingZoneId == null ? null : byZone.get(governingZoneId) ?? null;
    memo.set(key, date);
    return date;
  };
}

// ─── loading ─────────────────────────────────────────────────────────

/** The two delegates the scope lookup reads — `PrismaService` and a
 *  transaction client both satisfy it. */
export type TargetScopeClient = Pick<PrismaClient, 'zone' | 'zoneDeliverableTarget'>;

/**
 * Per-request memo for the project-wide loops, which resolve one scope
 * per target: the zone tree is the same for every target of a project
 * and the dated-target list is the same for every zone of a deliverable.
 * Never keep one across requests — it would hide zone / target edits.
 */
export interface TargetScopeMemo {
  zonesByProject: Map<number, Promise<ZoneTreeNode[]>>;
  datedTargetZonesByDeliverable: Map<number, Promise<number[]>>;
}

export function createTargetScopeMemo(): TargetScopeMemo {
  return { zonesByProject: new Map(), datedTargetZonesByDeliverable: new Map() };
}

/** Live zones of a project as a parent-pointer tree. `Zone` is not on
 *  the soft-delete middleware's list, hence the explicit filter. */
export function loadZoneTree(
  client: TargetScopeClient,
  projectId: number,
  memo?: TargetScopeMemo,
): Promise<ZoneTreeNode[]> {
  const cached = memo?.zonesByProject.get(projectId);
  if (cached) return cached;
  const pending = client.zone.findMany({
    where: { projectId, deletedAt: null },
    select: { id: true, parentId: true },
  }) as Promise<ZoneTreeNode[]>;
  memo?.zonesByProject.set(projectId, pending);
  return pending;
}

/** Zone ids that carry a DATED target for the deliverable (see the
 *  header for why a date-less row does not count). */
export function loadDatedTargetZoneIds(
  client: TargetScopeClient,
  projectDeliverableId: number,
  memo?: TargetScopeMemo,
): Promise<number[]> {
  const cached = memo?.datedTargetZonesByDeliverable.get(projectDeliverableId);
  if (cached) return cached;
  const pending = (
    client.zoneDeliverableTarget.findMany({
      where: { projectDeliverableId, targetDate: { not: null } },
      select: { zoneId: true },
    }) as Promise<Array<{ zoneId: number }>>
  ).then((rows) => rows.map((r) => r.zoneId));
  memo?.datedTargetZonesByDeliverable.set(projectDeliverableId, pending);
  return pending;
}

/**
 * Zone ids whose tasks the target (projectDeliverable × rootZone) owns.
 * `projectId` null/undefined (a target whose project cannot be resolved)
 * degrades to the pre-§12 exact match on the root zone.
 */
export async function loadTargetScopeZoneIds(
  client: TargetScopeClient,
  args: { projectId: number | null | undefined; projectDeliverableId: number; rootZoneId: number },
  memo?: TargetScopeMemo,
): Promise<number[]> {
  if (args.projectId == null) return [args.rootZoneId];
  const [zones, targetZoneIds] = await Promise.all([
    loadZoneTree(client, args.projectId, memo),
    loadDatedTargetZoneIds(client, args.projectDeliverableId, memo),
  ]);
  return resolveTargetScopeZoneIds(zones, args.rootZoneId, targetZoneIds);
}
