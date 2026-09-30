/**
 * Shared task → Deliverable resolver — extracted from planning-modal.tsx
 * (QA4 · DP-EMPTY-3, 2026-09-30). Previously the Planning tab and the
 * Deliverable Planning tab disagreed on the deliverable dimension:
 *   • Planning tab used a 5-step fallback ending in the
 *     [SERVICE:<name>] description marker, so every task rendered a
 *     DELIVERABLE badge even when no `ProjectDeliverable` row existed.
 *   • Deliverable Planning grid built rows ONLY from real
 *     `ProjectDeliverable` rows, so a project whose tasks only carried
 *     markers (e.g. project 33) rendered the empty state.
 *
 * Both tabs now import THIS function. The Deliverable Planning grid
 * uses it to build a synthetic (read-only) row set from task metadata
 * when the project has no ProjectDeliverable rows yet — the operator
 * runs the DP-EMPTY-1 backfill to materialize them and unlock the
 * editable target cells.
 *
 * Kept as a plain util (no React deps) so any surface — including the
 * DP grid, the Execution Board's parallel resolver, and future
 * reporters — can share the same canonical priority list.
 */

/** Lookups for the project's first-class Deliverable entities. */
export interface ProjectDeliverableLookups {
  /** All of the project's deliverables, display-ordered. */
  list: any[];
  /** ProjectDeliverable id → entity. */
  byId: Map<number, any>;
  /** sourceTemplateId → entity (1:1 within a project for backfilled rows). */
  byTemplateId: Map<number, any>;
}

/** Empty context shape — safe default for callers that have no lookup. */
export const EMPTY_DELIVERABLE_LOOKUPS: ProjectDeliverableLookups = {
  list: [],
  byId: new Map(),
  byTemplateId: new Map(),
};

/**
 * Canonical Deliverable label for a task — the SINGLE resolution used by
 * every planning surface so they never disagree. Priority:
 *   1. projectDeliverable entity (project-owned name — the authoritative
 *      label the PM/customer see). Resolved via the task's
 *      projectDeliverableId, or via its deliverableTemplateId.
 *   2. deliverableTemplate.name  (legacy source Template)
 *   3. serviceType.name          (legacy ServiceType FK)
 *   4. [SERVICE:xxx] marker       (legacy zone-template description) —
 *      this is the path a naive filter would miss, which is why
 *      marker-only deliverables were absent from the Deliverable dropdown.
 *   5. 'No Deliverable'
 */
export function resolveTaskDeliverable(
  t: any,
  lookups: ProjectDeliverableLookups = EMPTY_DELIVERABLE_LOOKUPS,
): string {
  if (t.projectDeliverableId != null) {
    const d = lookups.byId.get(t.projectDeliverableId);
    if (d?.name) return d.name;
  }
  if (t.deliverableTemplateId != null) {
    const d = lookups.byTemplateId.get(t.deliverableTemplateId);
    if (d?.name) return d.name;
  }
  if (t.projectDeliverable?.name) return t.projectDeliverable.name;
  if (t.deliverableTemplate?.name) return t.deliverableTemplate.name;
  if (t.serviceType?.name) return t.serviceType.name;
  const marker = t.description?.match?.(/^\[SERVICE:(.+)\]$/)?.[1];
  if (marker) return marker;
  return 'No Deliverable';
}

/**
 * Provenance for a resolved deliverable label — tells the caller which
 * priority step matched, so a surface can decide whether the target row
 * is editable (a real `ProjectDeliverable` row exists) or must render
 * read-only (a marker/template fallback). The Deliverable Planning grid
 * uses this to disable target cells for un-materialized rows and prompt
 * the operator to run the backfill.
 *
 * Order matches the priority list above:
 *   • 'project-deliverable'  — real ProjectDeliverable row via id / template FK
 *                              (editable)
 *   • 'template'             — deliverableTemplate.name (no ProjectDeliverable yet)
 *   • 'service-type'         — legacy ServiceType FK
 *   • 'marker'               — [SERVICE:<name>] description marker
 *   • 'none'                 — nothing resolved → the "No Deliverable" bucket
 */
export type DeliverableResolutionSource =
  | 'project-deliverable'
  | 'template'
  | 'service-type'
  | 'marker'
  | 'none';

export interface ResolvedTaskDeliverable {
  name: string;
  source: DeliverableResolutionSource;
  /** Resolved ProjectDeliverable id when source === 'project-deliverable'. */
  projectDeliverableId: number | null;
  /** Deliverable Template id when the task carries one (any source that isn't 'none'). */
  deliverableTemplateId: number | null;
}

/**
 * Same priority chain as `resolveTaskDeliverable`, but returns which
 * step matched. The Deliverable Planning grid uses `source` to gate
 * "editable target cell" vs "read-only, run backfill first".
 */
export function resolveTaskDeliverableDetailed(
  t: any,
  lookups: ProjectDeliverableLookups = EMPTY_DELIVERABLE_LOOKUPS,
): ResolvedTaskDeliverable {
  if (t.projectDeliverableId != null) {
    const d = lookups.byId.get(t.projectDeliverableId);
    if (d?.name) {
      return {
        name: d.name,
        source: 'project-deliverable',
        projectDeliverableId: t.projectDeliverableId,
        deliverableTemplateId: t.deliverableTemplateId ?? null,
      };
    }
  }
  if (t.deliverableTemplateId != null) {
    const d = lookups.byTemplateId.get(t.deliverableTemplateId);
    if (d?.name) {
      return {
        name: d.name,
        source: 'project-deliverable',
        projectDeliverableId: d.id ?? null,
        deliverableTemplateId: t.deliverableTemplateId,
      };
    }
  }
  if (t.projectDeliverable?.name) {
    return {
      name: t.projectDeliverable.name,
      source: 'project-deliverable',
      projectDeliverableId: t.projectDeliverableId ?? t.projectDeliverable.id ?? null,
      deliverableTemplateId: t.deliverableTemplateId ?? null,
    };
  }
  if (t.deliverableTemplate?.name) {
    return {
      name: t.deliverableTemplate.name,
      source: 'template',
      projectDeliverableId: null,
      deliverableTemplateId: t.deliverableTemplateId ?? t.deliverableTemplate.id ?? null,
    };
  }
  if (t.serviceType?.name) {
    return {
      name: t.serviceType.name,
      source: 'service-type',
      projectDeliverableId: null,
      deliverableTemplateId: null,
    };
  }
  const marker = t.description?.match?.(/^\[SERVICE:(.+)\]$/)?.[1];
  if (marker) {
    return {
      name: marker,
      source: 'marker',
      projectDeliverableId: null,
      deliverableTemplateId: null,
    };
  }
  return {
    name: 'No Deliverable',
    source: 'none',
    projectDeliverableId: null,
    deliverableTemplateId: null,
  };
}
