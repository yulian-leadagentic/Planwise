import { Prisma } from '@prisma/client';

/**
 * Zone soft-delete renames every deleted zone to
 * `${name} #deleted-${id}-${epochMs}` (zones.service.ts removeImpl —
 * the `(projectId, name, deletedAt)` unique key needs it). This strips
 * that suffix again; names without it come back unchanged.
 */
const DELETED_SUFFIX = /(?: #deleted-\d+-\d+)+$/;

export function stripDeletedZoneSuffix(name: string): string {
  return name.replace(DELETED_SUFFIX, '');
}

export interface RestoredZone {
  id: number;
  name: string;
}

/**
 * Bring back a soft-deleted zone and every soft-deleted ancestor above
 * it, so a restored task has a live place in the planning tree again.
 *
 * Walks `parentId` up from `zoneId` and stops at the first live zone,
 * at the root, or at a missing row. Only that chain is restored — not
 * sibling or descendant zones, and not the archived tasks inside them.
 * Each restored zone gets `deletedAt = null` and its original name back
 * (suffix stripped); when a live zone in the project already uses that
 * name it becomes `<name> (restored)`, `<name> (restored 2)`, …
 * `path` / `depth` / `parentId` are left as they are (delete never
 * changed them).
 *
 * Runs on the caller's transaction client. Returns the restored zones
 * top-down (outermost ancestor first); `[]` when the zone was live.
 */
export async function restoreDeletedZoneChain(
  tx: Prisma.TransactionClient,
  zoneId: number,
): Promise<RestoredZone[]> {
  const chain: Array<{ id: number; projectId: number; name: string }> = [];
  const seen = new Set<number>();
  let cursor: number | null = zoneId;
  while (cursor != null && !seen.has(cursor)) {
    seen.add(cursor);
    // Zone is not in the soft-delete middleware's model list, so this
    // reads the row whether or not it is deleted.
    const zone: { id: number; projectId: number; parentId: number | null; name: string; deletedAt: Date | null } | null =
      await tx.zone.findUnique({
        where: { id: cursor },
        select: { id: true, projectId: true, parentId: true, name: true, deletedAt: true },
      });
    if (!zone || zone.deletedAt == null) break;
    chain.push(zone);
    cursor = zone.parentId;
  }

  const restored: RestoredZone[] = [];
  // Top-down, so an ancestor keeps its original name before a
  // same-named descendant is checked against it.
  for (const zone of chain.reverse()) {
    const name = await freeZoneName(tx, zone.projectId, stripDeletedZoneSuffix(zone.name));
    await tx.zone.update({
      where: { id: zone.id },
      data: { deletedAt: null, name },
    });
    restored.push({ id: zone.id, name });
  }
  return restored;
}

/**
 * `base` when no live zone in the project has it, else the first free
 * `base (restored)`, `base (restored 2)`, … Compared in the database so
 * the column's collation decides what counts as the same name.
 */
async function freeZoneName(tx: Prisma.TransactionClient, projectId: number, base: string): Promise<string> {
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? base : n === 1 ? `${base} (restored)` : `${base} (restored ${n})`;
    const taken = await tx.zone.findFirst({
      where: { projectId, name: candidate, deletedAt: null },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  throw new Error(`No free name for restored zone "${base}" in project ${projectId}`);
}
