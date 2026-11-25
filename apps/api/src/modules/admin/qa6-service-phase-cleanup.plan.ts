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
 * at them, hidden from Service pickers). `ServiceType` is a different,
 * older catalog (disciplines: BIM Coordination, MEP, Structural, ...) and
 * is only reported here, never changed.
 *
 * Duplicates ("BIM Coordination BIM"): two rows whose names are the same
 * once case, spaces and punctuation are ignored, or where one row's name
 * is another row's name followed by its code ("BIM Coordination" with
 * code BIM, shown as "BIM Coordination BIM"). The one with the shortest
 * name stays (then the most used, then the oldest); the others are
 * merged into it when something points at them (every FK re-pointed,
 * then the row deactivated) or just deactivated when nothing does.
 *
 * Nothing is ever deleted.
 */

import { isProjectPhaseName, normalizeServiceName } from '../phases/service-phase-rule';

export { isProjectPhaseName, normalizeServiceName };

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
}

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

  // ── duplicate groups (union of rows sharing a name key) ──────────────
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
  for (const r of live) claim(normalizeServiceName(r.name), r.id);
  for (const r of live) {
    if (r.code && r.code.trim()) claim(normalizeServiceName(`${r.name} ${r.code}`), r.id);
  }
  const groups = new Map<number, PhaseRow[]>();
  for (const r of live) {
    const root = find(r.id);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  }

  const candidates = new Map<number, CleanupCandidate>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const keeper = [...members].sort(
      (a, b) =>
        normalizeServiceName(a.name).length - normalizeServiceName(b.name).length ||
        usageTotal(usage(b.id)) - usageTotal(usage(a.id)) ||
        a.id - b.id,
    )[0];
    for (const r of members) {
      if (r.id === keeper.id) continue;
      const used = usageTotal(usage(r.id)) > 0;
      candidates.set(r.id, {
        id: r.id,
        name: r.name,
        code: r.code ?? null,
        kindGuess: 'duplicate_service',
        reason: `Same service as #${keeper.id} "${keeper.name}"${keeper.code ? ` (${keeper.code})` : ''}.`,
        usage: usage(r.id),
        action: used ? 'merge' : 'deactivate',
        mergeInto: { id: keeper.id, name: keeper.name, code: keeper.code ?? null },
        matchingServiceType: matchingServiceType(r),
      });
    }
  }

  for (const r of live) {
    if (candidates.has(r.id) || !isProjectPhaseName(r.name)) continue;
    candidates.set(r.id, {
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
