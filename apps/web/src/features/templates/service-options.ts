/**
 * PR-069 (QA6, 2026-11-25) — the Service pickers list `/phases` rows,
 * and that table also holds the project lifecycle phases the v8 seed
 * wrote into it (Pre-Design, Design, Construction, AFC, Handover,
 * Maintenance, תכנון מפורט / סופי / לביצוע). They are not services, so a
 * picker leaves them out, together with rows the cleanup marked
 * `kind: 'phase'` or deactivated. Rule mirrored from the API
 * (`modules/phases/service-phase-rule.ts`); keep the lists in step.
 *
 * A value that is already selected (or used by a listed template) stays
 * in the list, so editing an old template never blanks its Service.
 */

export const PROJECT_PHASE_NAMES: readonly string[] = [
  'Pre-Design',
  'Design',
  'Construction',
  'AFC',
  'Handover',
  'Maintenance',
  'תכנון מפורט',
  'תכנון סופי',
  'תכנון לביצוע',
];

export function normalizeServiceName(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const PROJECT_PHASE_KEYS = new Set(PROJECT_PHASE_NAMES.map(normalizeServiceName));

export function isProjectPhaseName(name: string | null | undefined): boolean {
  const key = normalizeServiceName(name);
  return key !== '' && PROJECT_PHASE_KEYS.has(key);
}

export interface ServiceRowLike {
  id: number;
  name: string;
  code?: string | null;
  kind?: string | null;
  isActive?: boolean | null;
}

/** True when the row belongs in a Service picker. */
export function isPickableService(row: ServiceRowLike): boolean {
  if (row.isActive === false) return false;
  if (row.kind === 'phase') return false;
  return !isProjectPhaseName(row.name);
}

/**
 * Picker options: the pickable services, plus any row in `keepIds` (the
 * current value, or values in use) so it still shows. Order is kept.
 */
export function serviceOptions<T extends ServiceRowLike>(
  rows: readonly T[] | null | undefined,
  keepIds: Iterable<number | string | null | undefined> = [],
): T[] {
  const keep = new Set<number>();
  for (const v of keepIds) {
    const n = Number(v);
    if (v !== null && v !== undefined && v !== '' && Number.isFinite(n)) keep.add(n);
  }
  return (Array.isArray(rows) ? rows : []).filter((r) => isPickableService(r) || keep.has(r.id));
}
