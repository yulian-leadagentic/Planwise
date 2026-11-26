/**
 * PR-069 (QA6, 2026-11-25) — pure planner behind
 * `POST /admin/backfills/qa6-service-phase-cleanup`.
 *
 * What the rows are. The `phases` table is the app's "Service" catalog
 * (Services page, every Service picker, `Task.phaseId`,
 * `Template.phaseId`, `ProjectDeliverable.serviceId`). The v8 seed
 * (`prisma/seed.ts`, "Phases (v8 — replaces ServicePhase)") also wrote the
 * project LIFECYCLE phases into it: Pre-Design, Design, Construction, AFC,
 * Handover, Maintenance and, from 2026-06-18, תכנון מפורט / סופי / לביצוע.
 * They are not wrong service rows, they are phases saved in the same
 * table, so they are marked `kind = 'phase'` (kept for whatever points
 * at them, hidden from Service pickers). `ServiceType` (`service_types`,
 * `GET /service-types`) is a different, older catalog (disciplines: BIM
 * Coordination, MEP, Structural, ...): it gets the same duplicate check
 * (2026-11-26), never the phase rule.
 *
 * Duplicates ("BIM Coordination BIM"), the same rules in both tables:
 *   1. two rows whose names are the same once case, spaces and
 *      punctuation are ignored;
 *   2. one row's name is another row's name followed by that row's code
 *      ("BIM Coordination" with code BIM, shown as "BIM Coordination BIM");
 *   3. (2026-11-26) a row's name ends with a word that already appears
 *      earlier in the same name, and the name without that last word is
 *      another live row's name ("BIM Coordination BIM" next to
 *      "BIM Coordination" with code BMC, which rule 2 misses).
 * The one with the shortest name stays (then the most used, then the
 * oldest); the others are merged into it when something points at them
 * (every FK re-pointed, then the row deactivated) or just deactivated
 * when nothing does.
 *
 * Nothing is ever deleted.
 */

import { isProjectPhaseName, normalizeServiceName } from '../phases/service-phase-rule';

export { isProjectPhaseName, normalizeServiceName };

/** The table a cleanup row lives in. */
export type CleanupTable = 'phases' | 'service_types';

export interface PhaseRow {
  id: number;
  name: string;
  code: string | null;
  kind: 'service' | 'phase';
  isActive: boolean;
}

export interface PhaseUsage {
  /** Live project tasks (`Task.phaseId`, not deleted). */
  tasks: number;
  /** Live Deliverable / Zone templates (`Template.phaseId`), the Task Catalog excluded. */
  templates: number;
  /** Task Catalog items (`TemplateTask.phaseId` on `__TASK_CATALOG__`). */
  taskCatalogItems: number;
  /** Other template tasks / zone tasks (`TemplateTask` + `TemplateZoneTask`). */
  templateTasks: number;
  /** Live project deliverables (`ProjectDeliverable.serviceId`). */
  projectDeliverables: number;
  /** Distinct projects with a live task or project deliverable on it. */
  projects: number;
}

export const EMPTY_USAGE: PhaseUsage = {
  tasks: 0,
  templates: 0,
  taskCatalogItems: 0,
  templateTasks: 0,
  projectDeliverables: 0,
  projects: 0,
};

export function usageTotal(u: PhaseUsage): number {
  return u.tasks + u.templates + u.taskCatalogItems + u.templateTasks + u.projectDeliverables;
}

export type CleanupAction = 'mark_phase' | 'merge' | 'deactivate';
export type KindGuess = 'project_phase' | 'duplicate_service';

export interface CleanupCandidate {
  table: 'phases';
  id: number;
  name: string;
  code: string | null;
  kindGuess: KindGuess;
  reason: string;
  usage: PhaseUsage;
  action: CleanupAction;
  /** Set for `merge` (and for a `deactivate` of a duplicate): the row that stays. */
  mergeInto: { id: number; name: string; code: string | null } | null;
  /** A `ServiceType` row with the same name, for context only. */
  matchingServiceType: { id: number; name: string; code: string | null } | null;
}

export interface ServiceTypeRow {
  id: number;
  name: string;
  code: string | null;
  /** `service_types.is_active`; a row without it counts as active. */
  isActive?: boolean;
}

/** Where a `service_types` row is used. */
export interface ServiceTypeUsage {
  /** Live project tasks (`Task.serviceTypeId`, not deleted). */
  tasks: number;
  /** Task Catalog items (`TemplateTask.serviceTypeId` on `__TASK_CATALOG__`). */
  taskCatalogItems: number;
  /** Other template tasks / zone tasks (`TemplateTask` + `TemplateZoneTask`). */
  templateTasks: number;
  /** Zone links (`ZoneServiceType.serviceTypeId`, table `zone_service_types`). */
  zoneLinks: number;
  /** Project category links (`ProjectCategory.serviceTypeId`, table `project_categories`). */
  projectCategories: number;
  /** Distinct projects with a live task or a project category on it. */
  projects: number;
}

export const EMPTY_SERVICE_TYPE_USAGE: ServiceTypeUsage = {
  tasks: 0,
  taskCatalogItems: 0,
  templateTasks: 0,
  zoneLinks: 0,
  projectCategories: 0,
  projects: 0,
};

export function serviceTypeUsageTotal(u: ServiceTypeUsage): number {
  return u.tasks + u.taskCatalogItems + u.templateTasks + u.zoneLinks + u.projectCategories;
}

export type ServiceTypeCleanupAction = 'merge' | 'deactivate';

export interface ServiceTypeCleanupCandidate {
  table: 'service_types';
  id: number;
  name: string;
  code: string | null;
  kindGuess: 'duplicate_service';
  reason: string;
  usage: ServiceTypeUsage;
  action: ServiceTypeCleanupAction;
  /** The row that stays. */
  mergeInto: { id: number; name: string; code: string | null };
  /**
   * For a `merge`: links of this row that the row that stays already has
   * (same zone, same project). One link per zone / project is allowed, so
   * the merge removes these instead of moving them; they carry nothing
   * the link of the row that stays does not. Filled by the service, null
   * for a `deactivate`.
   */
  linksAlreadyOnKeeper: { zoneLinks: number; projectCategories: number } | null;
}

export type AnyCleanupCandidate = CleanupCandidate | ServiceTypeCleanupCandidate;

// ─── duplicate rule (both tables) ─────────────────────────────────────

/** The words of a name as written (NFKC), split on anything that is not a letter or a digit. */
export function serviceNameWords(value: string | null | undefined): string[] {
  return (value ?? '')
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Rule 3: the name ends with a word that already appears earlier in it
 * ("BIM Coordination BIM"). Returns that word as written and the
 * normalised name without it ("bimcoordination"), or null.
 */
export function repeatedLastWord(name: string | null | undefined): { word: string; key: string } | null {
  const words = serviceNameWords(name);
  if (words.length < 2) return null;
  const keys = words.map(normalizeServiceName);
  const last = keys[keys.length - 1];
  if (!last || !keys.slice(0, -1).includes(last)) return null;
  return { word: words[words.length - 1], key: keys.slice(0, -1).join('') };
}

interface CatalogRow {
  id: number;
  name: string;
  code: string | null;
}

export interface DuplicateMatch<R extends CatalogRow> {
  row: R;
  keeper: R;
  reason: string;
}

const codeSuffix = (r: CatalogRow) => (r.code && r.code.trim() ? ` (${r.code})` : '');

function duplicateReason(r: CatalogRow, keeper: CatalogRow, noun: string): string {
  const head = `Same ${noun} as #${keeper.id} "${keeper.name}"${codeSuffix(keeper)}`;
  const key = normalizeServiceName(r.name);
  const keeperKey = normalizeServiceName(keeper.name);
  if (key === keeperKey) {
    return `${head}: the same name once case, spaces and punctuation are ignored.`;
  }
  if (keeper.code && keeper.code.trim() && key === normalizeServiceName(`${keeper.name} ${keeper.code}`)) {
    return `${head}: the name is that name followed by its code "${keeper.code.trim()}".`;
  }
  const repeated = repeatedLastWord(r.name);
  if (repeated && repeated.key === keeperKey) {
    return `${head}: the name is that name with its word "${repeated.word}" repeated at the end.`;
  }
  return `${head}.`;
}

/**
 * Duplicate groups among `live` rows (rules 1 to 3 of the header); for
 * every group, each row but the keeper, with the keeper and the reason.
 */
export function findDuplicates<R extends CatalogRow>(
  live: readonly R[],
  usedTotal: (id: number) => number,
  noun: string,
): DuplicateMatch<R>[] {
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let p = parent.get(id)!;
    while (p !== parent.get(p)) p = parent.get(p)!;
    parent.set(id, p);
    return p;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };
  for (const r of live) parent.set(r.id, r.id);
  const firstByKey = new Map<string, number>();
  const claim = (key: string, id: number) => {
    if (!key) return;
    const other = firstByKey.get(key);
    if (other === undefined) firstByKey.set(key, id);
    else union(other, id);
  };
  // Rule 1: the same name key.
  const firstByName = new Map<string, number>();
  for (const r of live) {
    const key = normalizeServiceName(r.name);
    claim(key, r.id);
    if (key && !firstByName.has(key)) firstByName.set(key, r.id);
  }
  // Rule 2: one row's name is another row's name followed by its code.
  for (const r of live) {
    if (r.code && r.code.trim()) claim(normalizeServiceName(`${r.name} ${r.code}`), r.id);
  }
  // Rule 3: the name repeats its last word, and without it is another row's name.
  for (const r of live) {
    const repeated = repeatedLastWord(r.name);
    const other = repeated ? firstByName.get(repeated.key) : undefined;
    if (other !== undefined && other !== r.id) union(other, r.id);
  }

  const groups = new Map<number, R[]>();
  for (const r of live) {
    const root = find(r.id);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  }
  const out: DuplicateMatch<R>[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const keeper = [...members].sort(
      (a, b) =>
        normalizeServiceName(a.name).length - normalizeServiceName(b.name).length ||
        usedTotal(b.id) - usedTotal(a.id) ||
        a.id - b.id,
    )[0];
    for (const r of members) {
      if (r.id === keeper.id) continue;
      out.push({ row: r, keeper, reason: duplicateReason(r, keeper, noun) });
    }
  }
  return out;
}

// ─── phases ───────────────────────────────────────────────────────────

/**
 * Plan the cleanup. Only active `service` rows are looked at, so a row
 * already marked or deactivated by an earlier run is never planned
 * again (idempotent).
 */
export function planServicePhaseCleanup(
  rows: readonly PhaseRow[],
  usageById: ReadonlyMap<number, PhaseUsage>,
  serviceTypes: readonly ServiceTypeRow[] = [],
): { candidates: CleanupCandidate[]; unchanged: PhaseRow[] } {
  const live = rows.filter((r) => r.isActive && r.kind === 'service');
  const usage = (id: number) => usageById.get(id) ?? EMPTY_USAGE;
  const stByKey = new Map<string, ServiceTypeRow>();
  for (const st of serviceTypes) stByKey.set(normalizeServiceName(st.name), st);
  const matchingServiceType = (r: PhaseRow) => {
    const st = stByKey.get(normalizeServiceName(r.name));
    return st ? { id: st.id, name: st.name, code: st.code ?? null } : null;
  };

  const candidates = new Map<number, CleanupCandidate>();
  for (const { row: r, keeper, reason } of findDuplicates(live, (id) => usageTotal(usage(id)), 'service')) {
    const used = usageTotal(usage(r.id)) > 0;
    candidates.set(r.id, {
      table: 'phases',
      id: r.id,
      name: r.name,
      code: r.code ?? null,
      kindGuess: 'duplicate_service',
      reason,
      usage: usage(r.id),
      action: used ? 'merge' : 'deactivate',
      mergeInto: { id: keeper.id, name: keeper.name, code: keeper.code ?? null },
      matchingServiceType: matchingServiceType(r),
    });
  }

  for (const r of live) {
    if (candidates.has(r.id) || !isProjectPhaseName(r.name)) continue;
    candidates.set(r.id, {
      table: 'phases',
      id: r.id,
      name: r.name,
      code: r.code ?? null,
      kindGuess: 'project_phase',
      reason: 'Project lifecycle phase saved in the Service table by the v8 seed.',
      usage: usage(r.id),
      action: 'mark_phase',
      mergeInto: null,
      matchingServiceType: matchingServiceType(r),
    });
  }

  const list = [...candidates.values()].sort((a, b) => a.id - b.id);
  const unchanged = rows.filter((r) => !candidates.has(r.id));
  return { candidates: list, unchanged };
}

// ─── service types ────────────────────────────────────────────────────

/**
 * Plan the duplicate cleanup of `service_types` (rules 1 to 3 only; the
 * table holds disciplines, not project phases). Only active rows are
 * looked at, so a row deactivated by an earlier run is never planned
 * again (idempotent).
 */
export function planServiceTypeDuplicates(
  rows: readonly ServiceTypeRow[],
  usageById: ReadonlyMap<number, ServiceTypeUsage>,
): { candidates: ServiceTypeCleanupCandidate[]; unchanged: ServiceTypeRow[] } {
  const live = rows.filter((r) => r.isActive !== false);
  const usage = (id: number) => usageById.get(id) ?? EMPTY_SERVICE_TYPE_USAGE;
  const candidates = findDuplicates(live, (id) => serviceTypeUsageTotal(usage(id)), 'service type')
    .map(({ row: r, keeper, reason }): ServiceTypeCleanupCandidate => ({
      table: 'service_types',
      id: r.id,
      name: r.name,
      code: r.code ?? null,
      kindGuess: 'duplicate_service',
      reason,
      usage: usage(r.id),
      action: serviceTypeUsageTotal(usage(r.id)) > 0 ? 'merge' : 'deactivate',
      mergeInto: { id: keeper.id, name: keeper.name, code: keeper.code ?? null },
      linksAlreadyOnKeeper: null,
    }))
    .sort((a, b) => a.id - b.id);
  const ids = new Set(candidates.map((c) => c.id));
  return { candidates, unchanged: rows.filter((r) => !ids.has(r.id)) };
}
