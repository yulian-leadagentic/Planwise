/**
 * PR-069 (QA6, 2026-11-25) — which `phases` rows are real services.
 *
 * The `phases` table is the app's "Service" catalog, but the v8 seed
 * (`prisma/seed.ts`, "Phases (v8 — replaces ServicePhase)") also wrote
 * the project lifecycle phases into it. A row belongs in a Service picker
 * when it is an active `service` row whose name is not one of those
 * lifecycle phases. The name rule keeps the pickers right before the
 * reviewed cleanup (`POST /admin/backfills/qa6-service-phase-cleanup`)
 * has set `kind = 'phase'` on them.
 *
 * Mirrored in the web (`features/templates/service-options.ts`); keep the
 * two lists in step.
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

/** Case / space / punctuation-insensitive key ("Pre Design" = "pre-design"). */
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

/** True when the row belongs in a Service picker. */
export function isPickableService(row: {
  name: string;
  kind?: string | null;
  isActive?: boolean | null;
}): boolean {
  if (row.isActive === false) return false;
  if (row.kind === 'phase') return false;
  return !isProjectPhaseName(row.name);
}
