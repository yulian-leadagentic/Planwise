import type { PrismaClient } from '@prisma/client';

export type ResolvedPhase = { id: number; name: string; color: string | null };

/**
 * Resolve `[SERVICE:<name>]` markers to a phase by matching the marker
 * against `Template.name` — first exact, then `<marker>\<suffix>`
 * prefix. Returns `Map<marker, ResolvedPhase>`; markers without a
 * matching template are simply absent from the map.
 *
 * Shared by two callers so they cannot drift:
 *   • `planning.service.ts` — read-time fallback for the Service
 *     column when every FK-based branch is empty.
 *   • `admin/backfills.controller.ts` — persists `task.phaseId` from
 *     the resolved marker so future reads use the FK, not the marker.
 *
 * Do NOT rebuild the match in raw SQL. Prisma `startsWith: m + '\\'`
 * compiles to `LIKE 'm\%'` in MySQL, where `\` escapes the `%` and
 * matches the literal string `m%` — zero rows. The reliable path is
 * to fetch every `task_list` template with a phase set (a small
 * catalog) and filter in JS. Verified against the staging DB during
 * the 8-attempt Service-column arc (2026-09-29, commit 94ebb43).
 */
export async function resolvePhasesByMarkerNames(
  prisma: PrismaClient,
  markerNames: Iterable<string>,
): Promise<Map<string, ResolvedPhase>> {
  const set = new Set<string>();
  for (const m of markerNames) if (m) set.add(m);
  const out = new Map<string, ResolvedPhase>();
  if (set.size === 0) return out;

  const templates = await prisma.template.findMany({
    where: { deletedAt: null, type: 'task_list', phaseId: { not: null } },
    select: {
      name: true,
      phase: { select: { id: true, name: true, color: true } },
    },
  });

  // Exact wins.
  for (const t of templates) {
    if (!t.phase) continue;
    if (set.has(t.name) && !out.has(t.name)) {
      out.set(t.name, {
        id: t.phase.id,
        name: t.phase.name,
        color: (t.phase as any).color ?? null,
      });
    }
  }
  // Prefix (`<marker>\`) for remaining markers.
  for (const t of templates) {
    if (!t.phase) continue;
    for (const m of set) {
      if (out.has(m)) continue;
      if (t.name.startsWith(`${m}\\`)) {
        out.set(m, {
          id: t.phase.id,
          name: t.phase.name,
          color: (t.phase as any).color ?? null,
        });
        break;
      }
    }
  }
  return out;
}

/** Extract the `<name>` from a task's `[SERVICE:<name>]` description marker, or null. */
export function extractServiceMarker(description: string | null | undefined): string | null {
  if (!description) return null;
  const m = description.match(/^\[SERVICE:(.+)\]$/);
  return m ? m[1] : null;
}
