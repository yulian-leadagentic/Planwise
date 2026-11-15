/**
 * P1 · Reference model — Phase-2 migration PLAN (pure functions).
 *
 * Work order: docs/bm2/planwise-P1-reference-model-WORKORDER.md
 * (decisions §0, §0b, §0c — the dry-run of §0c was approved; step 5,
 * the real migration, is what this plan feeds).
 *
 * What is being migrated: before the compose UI learned to add a
 * deliverable by REFERENCE (`TemplatesService.addDeliverableRef`), a
 * composing template (`Template.type !== 'task_list'`) got a deliverable
 * by COPYING its tasks — `TemplateTask` rows at the root or
 * `TemplateZoneTask` rows under a zone, tagged with
 * `deliverableTemplateId`. A copy carries no `TemplateTaskDependency`
 * rows, so a project built from such a template arrives without the
 * deliverable's dependency edges. The migration replaces each group of
 * copies with ONE reference slot — a `TemplateZone` whose
 * `linkedTaskTemplateId` is the deliverable — and removes the copies.
 *
 * This file has no Prisma and no Nest in it: it takes plain rows and
 * returns a plan. Two callers:
 *   • `P1CopiesToRefsService` — the admin backfill endpoint (dry-run by
 *     default) that also executes the plan;
 *   • `apps/api/scripts/p1-migrate-copies-to-refs.dry-run.ts` — the
 *     approved read-only planner, which now takes its marker resolution
 *     and its grouping from here so the two cannot drift.
 *
 * The grouping / marker / idempotence rules are the approved planner's,
 * unchanged. What this file adds on top is documented where it is
 * added: the drift report (`computeDrift`), the slot `sortOrder`
 * (`planTemplate`), and the skip reasons other than `already_linked`
 * (`SkipReason`).
 */
import { extractServiceMarker } from '../planning/marker-phase-resolver';
import { resolveBudget, type CatalogEntry } from '../zones/zones.util';

// ─── Marker resolution (approved planner rule, unchanged) ───────────

export type MarkerCatalogEntry = { id: number; name: string; phaseId: number | null };

/**
 * Pure mirror of the private `TemplatesService.resolveDeliverableTemplateByMarker`.
 * Matches `catalog.name = marker` first, then `name` starting with
 * `marker\` (the `base\detail` rename form). Preference rules:
 *   1. Phase match (if the task has `phaseId`).
 *   2. Prefer exact over prefix.
 *   3. Still > 1 → null (never guess).
 * Zero candidates → null. The caller feeds a catalog pre-filtered to
 * `type = 'task_list', deletedAt = null`.
 */
export function resolveDeliverableTemplateByMarker(
  description: string | null | undefined,
  taskPhaseId: number | null | undefined,
  catalog: MarkerCatalogEntry[],
): number | null {
  const marker = extractServiceMarker(description);
  if (!marker) return null;

  const exact = catalog.filter((t) => t.name === marker);
  const prefix = catalog.filter((t) => t.name.startsWith(`${marker}\\`));
  const all = [
    ...exact.map((t) => ({ ...t, matchKind: 'exact' as const })),
    ...prefix.map((t) => ({ ...t, matchKind: 'prefix' as const })),
  ];
  if (all.length === 0) return null;
  if (all.length === 1) return all[0].id;

  if (taskPhaseId != null) {
    const samePhase = all.filter((c) => c.phaseId === taskPhaseId);
    if (samePhase.length === 1) return samePhase[0].id;
    if (samePhase.length > 1) {
      const exactPhase = samePhase.find((c) => c.matchKind === 'exact');
      if (exactPhase) return exactPhase.id;
    }
  }
  if (exact.length === 1) return exact[0].id;
  return null;
}

// ─── Grouping (approved planner rule, unchanged) ────────────────────

export type Provenance = 'fk' | 'marker';
export type CopyRowKind = 'task' | 'zone_task';

/** The columns grouping needs from a `TemplateTask` / `TemplateZoneTask`. */
export interface GroupableRow {
  id: number;
  description: string | null;
  phaseId: number | null;
  deliverableTemplateId: number | null;
}

export interface GroupableZone<R extends GroupableRow> {
  id: number;
  name: string;
  parentId: number | null;
  linkedTaskTemplateId: number | null;
  templateZoneTasks: R[];
}

export interface GroupableTemplate<R extends GroupableRow> {
  id: number;
  name: string;
  templateTasks: R[];
  templateZones: Array<GroupableZone<R>>;
}

export interface SourcedCopyRow<R extends GroupableRow> {
  id: number;
  source: Provenance;
  kind: CopyRowKind;
  row: R;
}

/** One `(template, parent zone or root, deliverable)` group of copies. */
export interface CopyGroup<R extends GroupableRow> {
  /** `${templateId}:${parentZoneId ?? 'root'}:${deliverableTemplateId}` */
  key: string;
  parentZoneId: number | null;
  deliverableTemplateId: number;
  templateTaskRows: Array<SourcedCopyRow<R>>;
  templateZoneTaskRows: Array<SourcedCopyRow<R>>;
  sources: Set<Provenance>;
}

export interface UnresolvableRow {
  templateId: number;
  templateName: string;
  rowId: number;
  rowKind: CopyRowKind;
  description: string;
  phaseId: number | null;
  zoneId: number | null;
  zoneName: string | null;
}

export const groupKey = (
  templateId: number,
  parentZoneId: number | null,
  deliverableTemplateId: number,
): string => `${templateId}:${parentZoneId == null ? 'root' : parentZoneId}:${deliverableTemplateId}`;

/**
 * Group one composing template's copies.
 *
 *   • A row with `deliverableTemplateId` set belongs to that deliverable
 *     (source `fk`).
 *   • A row without it whose description is a `[SERVICE:<name>]` marker
 *     is resolved through `resolveDeliverableTemplateByMarker` (source
 *     `marker`); when that returns null the row goes to
 *     `legacyUnresolvable` and is left alone.
 *   • Any other row is the template's own task and is ignored.
 *   • Root `TemplateTask` rows group at the root; a `TemplateZoneTask`
 *     groups under its own zone (work order §0b.1 — the slot becomes a
 *     CHILD of that zone).
 *
 * Groups come back in first-seen order: root rows, then zone by zone.
 */
export function groupCopyRows<R extends GroupableRow>(
  tpl: GroupableTemplate<R>,
  catalog: MarkerCatalogEntry[],
): {
  groups: Array<CopyGroup<R>>;
  legacyUnresolvable: UnresolvableRow[];
  fkSourced: number;
  markerResolved: number;
} {
  const groups = new Map<string, CopyGroup<R>>();
  const legacyUnresolvable: UnresolvableRow[] = [];
  let fkSourced = 0;
  let markerResolved = 0;

  const place = (
    row: R,
    kind: CopyRowKind,
    zone: GroupableZone<R> | null,
  ): void => {
    let deliverableId: number | null = null;
    let source: Provenance | null = null;
    if (row.deliverableTemplateId != null) {
      deliverableId = row.deliverableTemplateId;
      source = 'fk';
    } else if (extractServiceMarker(row.description)) {
      const resolved = resolveDeliverableTemplateByMarker(row.description, row.phaseId, catalog);
      if (resolved != null) {
        deliverableId = resolved;
        source = 'marker';
      } else {
        legacyUnresolvable.push({
          templateId: tpl.id,
          templateName: tpl.name,
          rowId: row.id,
          rowKind: kind,
          description: row.description ?? '',
          phaseId: row.phaseId,
          zoneId: zone?.id ?? null,
          zoneName: zone?.name ?? null,
        });
      }
    }
    if (deliverableId == null || source == null) return;

    const parentZoneId = zone?.id ?? null;
    const key = groupKey(tpl.id, parentZoneId, deliverableId);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        parentZoneId,
        deliverableTemplateId: deliverableId,
        templateTaskRows: [],
        templateZoneTaskRows: [],
        sources: new Set<Provenance>(),
      };
      groups.set(key, g);
    }
    (kind === 'task' ? g.templateTaskRows : g.templateZoneTaskRows).push({
      id: row.id,
      source,
      kind,
      row,
    });
    g.sources.add(source);
    if (source === 'fk') fkSourced++;
    else markerResolved++;
  };

  for (const tt of tpl.templateTasks) place(tt, 'task', null);
  for (const tz of tpl.templateZones) {
    for (const tzt of tz.templateZoneTasks) place(tzt, 'zone_task', tz);
  }

  return { groups: [...groups.values()], legacyUnresolvable, fkSourced, markerResolved };
}

/**
 * Idempotence index (approved planner rule): the `(parent, deliverable)`
 * pairs that already have a zone with that `linkedTaskTemplateId`. A
 * group whose key is in here is skipped — nothing is created and its
 * remaining copies are not touched.
 */
export function existingLinkedKeys(tpl: {
  id: number;
  templateZones: Array<{ parentId: number | null; linkedTaskTemplateId: number | null }>;
}): Set<string> {
  const keys = new Set<string>();
  for (const z of tpl.templateZones) {
    if (!z.linkedTaskTemplateId) continue;
    keys.add(groupKey(tpl.id, z.parentId, z.linkedTaskTemplateId));
  }
  return keys;
}

// ─── Inputs of the full plan ────────────────────────────────────────

/** Live catalog values a template task resolves through (DN-ext). */
export interface CatalogTaskValues {
  name: string | null;
  defaultBudgetHours: unknown;
  defaultBudgetAmount: unknown;
}

/** A copy row with everything the drift report compares. */
export interface CopyRow extends GroupableRow {
  code: string;
  name: string;
  serviceTypeId: number | null;
  defaultBudgetHours: unknown;
  defaultBudgetAmount: unknown;
  sortOrder: number;
  catalogTask?: CatalogTaskValues | null;
}

export interface ComposingZone extends GroupableZone<CopyRow> {
  sortOrder: number;
}

export interface ComposingTemplate extends GroupableTemplate<CopyRow> {
  type: string;
  templateZones: ComposingZone[];
}

export interface DeliverableTask {
  id: number;
  code: string;
  name: string;
  phaseId: number | null;
  serviceTypeId: number | null;
  defaultBudgetHours: unknown;
  defaultBudgetAmount: unknown;
  sortOrder: number;
  catalogTask?: CatalogTaskValues | null;
  predecessors?: Array<{ dependsOnTemplateTaskId: number }>;
}

export interface DeliverableTemplate {
  id: number;
  name: string;
  code: string | null;
  type: string;
  phaseId: number | null;
  deletedAt: Date | null;
  templateTasks: DeliverableTask[];
}

/** A `TemplateTaskDependency` row that touches a root copy. */
export interface CopyDependencyEdge {
  id: number;
  templateTaskId: number;
  dependsOnTemplateTaskId: number;
}

// ─── The slot (must stay identical to `addDeliverableRef`) ──────────

/**
 * The `data` of the `templateZone.create` that makes a deliverable slot
 * — field for field what `TemplatesService.addDeliverableRef` writes
 * (zoneType `building`, no code, not typical, one instance, linked to
 * the deliverable, no referenced template). The service spec builds the
 * same slot through `addDeliverableRef` and compares the two, so a
 * change there that is not mirrored here fails the build.
 */
export interface SlotData {
  templateId: number;
  parentId: number | null;
  zoneType: 'building';
  name: string;
  code: null;
  isTypical: false;
  typicalCount: 1;
  instanceCount: 1;
  sortOrder: number;
  linkedTaskTemplateId: number;
  referencedTemplateId: null;
}

export function buildSlotData(args: {
  templateId: number;
  parentZoneId: number | null;
  deliverable: { id: number; name: string };
  sortOrder: number;
}): SlotData {
  return {
    templateId: args.templateId,
    parentId: args.parentZoneId,
    zoneType: 'building',
    name: args.deliverable.name,
    code: null,
    isTypical: false,
    typicalCount: 1,
    instanceCount: 1,
    sortOrder: args.sortOrder,
    linkedTaskTemplateId: args.deliverable.id,
    referencedTemplateId: null,
  };
}

// ─── Drift report ───────────────────────────────────────────────────

export interface RowRef {
  kind: CopyRowKind;
  id: number;
  code: string;
  name: string;
  source: Provenance;
}

export type DriftField =
  | 'name'
  | 'defaultBudgetHours'
  | 'defaultBudgetAmount'
  | 'phaseId'
  | 'serviceTypeId';

export const DRIFT_FIELDS: DriftField[] = [
  'name',
  'defaultBudgetHours',
  'defaultBudgetAmount',
  'phaseId',
  'serviceTypeId',
];

export type DriftValue = string | number | null;

export interface ChangedRow {
  code: string;
  copy: { kind: CopyRowKind; id: number };
  deliverableTaskId: number;
  fields: Partial<Record<DriftField, { copy: DriftValue; deliverable: DriftValue }>>;
}

/**
 * Copies vs. the deliverable's CURRENT tasks, matched by task code.
 *
 *   onlyInCopy         codes the copies have and the deliverable does
 *                      not. Deleting such a row would silently remove a
 *                      task from the template, so the plan KEEPS it
 *                      (still tagged with its deliverable). A copy with
 *                      a blank code cannot be matched and is listed
 *                      here too.
 *   onlyInDeliverable  codes the deliverable has and the copies lack —
 *                      new projects WILL start to receive these tasks.
 *   changed            same code, and a project built from the template
 *                      would get a different value after the migration
 *                      (the deliverable wins). `copy` / `deliverable`
 *                      are the values apply writes — see `appliedValues`.
 *   changedStoredOnly  same code, the stored columns differ, but apply
 *                      resolves both rows to the same value (same
 *                      catalog task, or the deliverable's own phase
 *                      covers it) — nothing changes for new projects.
 *                      `copy` / `deliverable` are the stored columns.
 *   duplicateCodes     a code that appears more than once on either
 *                      side. Matching by code is then ambiguous, so the
 *                      whole group is skipped.
 */
export interface Drift {
  onlyInCopy: RowRef[];
  onlyInDeliverable: Array<{ id: number; code: string; name: string }>;
  changed: ChangedRow[];
  changedStoredOnly: ChangedRow[];
  duplicateCodes: { inCopies: string[]; inDeliverable: string[] };
}

const normCode = (code: string | null | undefined): string => (code ?? '').trim();

/** Decimal | number | string | null → number | null (NaN-safe). */
function toNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type ComparedValues = Record<DriftField, DriftValue>;

const storedValues = (row: {
  name: string;
  defaultBudgetHours: unknown;
  defaultBudgetAmount: unknown;
  phaseId: number | null;
  serviceTypeId: number | null;
}): ComparedValues => ({
  name: row.name,
  defaultBudgetHours: toNumberOrNull(row.defaultBudgetHours),
  defaultBudgetAmount: toNumberOrNull(row.defaultBudgetAmount),
  phaseId: row.phaseId ?? null,
  serviceTypeId: row.serviceTypeId ?? null,
});

/**
 * The values `ZonesService.applyProjectTemplate` writes on the project
 * task for a template row — the same resolution it runs
 * (`resolveFromCatalog` + `resolveBudget`):
 *   name    : the linked catalog task's live name, else the row's own;
 *   budget  : the linked catalog task's live value, else the row's own,
 *             else the Task Catalog entry with the same code;
 *   phaseId : for a slot task the DELIVERABLE TEMPLATE's phase when it
 *             has one, else the task's own (`servicePhaseId ??
 *             tt.phaseId`); for a copy, the row's own.
 */
function appliedValues(
  row: {
    code: string;
    name: string;
    defaultBudgetHours: unknown;
    defaultBudgetAmount: unknown;
    phaseId: number | null;
    serviceTypeId: number | null;
    catalogTask?: CatalogTaskValues | null;
  },
  codeCatalog: Map<string, CatalogEntry>,
  templatePhaseId: number | null,
): ComparedValues {
  const ct = row.catalogTask ?? null;
  const { budgetHours, budgetAmount } = resolveBudget(
    {
      code: row.code,
      defaultBudgetHours: ct?.defaultBudgetHours ?? row.defaultBudgetHours,
      defaultBudgetAmount: ct?.defaultBudgetAmount ?? row.defaultBudgetAmount,
    },
    codeCatalog,
  );
  return {
    name: ct?.name ?? row.name,
    defaultBudgetHours: toNumberOrNull(budgetHours),
    defaultBudgetAmount: toNumberOrNull(budgetAmount),
    phaseId: templatePhaseId ?? row.phaseId ?? null,
    serviceTypeId: row.serviceTypeId ?? null,
  };
}

function diffFields(copy: ComparedValues, deliverable: ComparedValues): ChangedRow['fields'] {
  const out: ChangedRow['fields'] = {};
  for (const f of DRIFT_FIELDS) {
    if (copy[f] !== deliverable[f]) out[f] = { copy: copy[f], deliverable: deliverable[f] };
  }
  return out;
}

const toRowRef = (r: SourcedCopyRow<CopyRow>): RowRef => ({
  kind: r.kind,
  id: r.id,
  code: r.row.code,
  name: r.row.name,
  source: r.source,
});

export function computeDrift(
  copies: Array<SourcedCopyRow<CopyRow>>,
  deliverable: DeliverableTemplate,
  codeCatalog: Map<string, CatalogEntry>,
): { drift: Drift; matched: Array<SourcedCopyRow<CopyRow>>; unmatched: Array<SourcedCopyRow<CopyRow>> } {
  const copiesByCode = new Map<string, Array<SourcedCopyRow<CopyRow>>>();
  for (const c of copies) {
    const code = normCode(c.row.code);
    if (!code) continue;
    copiesByCode.set(code, [...(copiesByCode.get(code) ?? []), c]);
  }
  const tasksByCode = new Map<string, DeliverableTask[]>();
  for (const t of deliverable.templateTasks) {
    const code = normCode(t.code);
    if (!code) continue;
    tasksByCode.set(code, [...(tasksByCode.get(code) ?? []), t]);
  }

  const drift: Drift = {
    onlyInCopy: [],
    onlyInDeliverable: [],
    changed: [],
    changedStoredOnly: [],
    duplicateCodes: {
      inCopies: [...copiesByCode].filter(([, rows]) => rows.length > 1).map(([code]) => code).sort(),
      inDeliverable: [...tasksByCode].filter(([, rows]) => rows.length > 1).map(([code]) => code).sort(),
    },
  };
  const matched: Array<SourcedCopyRow<CopyRow>> = [];
  const unmatched: Array<SourcedCopyRow<CopyRow>> = [];

  for (const c of copies) {
    const code = normCode(c.row.code);
    const tasks = code ? tasksByCode.get(code) : undefined;
    if (!tasks) {
      unmatched.push(c);
      drift.onlyInCopy.push(toRowRef(c));
      continue;
    }
    matched.push(c);
    // An ambiguous code is reported as a duplicate, not compared.
    if (tasks.length !== 1 || (copiesByCode.get(code)?.length ?? 0) !== 1) continue;
    const task = tasks[0];
    const base = { code, copy: { kind: c.kind, id: c.id }, deliverableTaskId: task.id };
    const applied = diffFields(
      appliedValues(c.row, codeCatalog, null),
      appliedValues(task, codeCatalog, deliverable.phaseId ?? null),
    );
    if (Object.keys(applied).length > 0) {
      drift.changed.push({ ...base, fields: applied });
    }
    // Stored columns that differ without changing what apply writes.
    const stored = diffFields(storedValues(c.row), storedValues(task));
    for (const f of DRIFT_FIELDS) if (f in applied) delete stored[f];
    if (Object.keys(stored).length > 0) {
      drift.changedStoredOnly.push({ ...base, fields: stored });
    }
  }
  for (const t of deliverable.templateTasks) {
    const code = normCode(t.code);
    if (!code || !copiesByCode.has(code)) {
      drift.onlyInDeliverable.push({ id: t.id, code: t.code, name: t.name });
    }
  }
  return { drift, matched, unmatched };
}

// ─── The plan ───────────────────────────────────────────────────────

export type SkipReason =
  /** Approved planner rule — a zone already links this deliverable at this parent. */
  | 'already_linked'
  | 'deliverable_missing'
  | 'deliverable_deleted'
  | 'deliverable_not_task_list'
  /** A task code is repeated in the copies or in the deliverable. */
  | 'duplicate_codes'
  /** Not one copy matches a deliverable task by code — there is nothing to replace. */
  | 'no_matching_codes'
  /** The slot would sit deeper than apply loads slots. */
  | 'parent_zone_too_deep';

export const SKIP_REASONS: SkipReason[] = [
  'already_linked',
  'deliverable_missing',
  'deliverable_deleted',
  'deliverable_not_task_list',
  'duplicate_codes',
  'no_matching_codes',
  'parent_zone_too_deep',
];

/**
 * Deepest zone that may PARENT a slot (root zone = depth 1).
 *
 * `ZonesService.applyProjectTemplate` loads a template's zones three
 * levels deep when the template is applied directly, but only two
 * levels deep when it is pulled in through another template's
 * `referencedTemplateId`. A slot is a zone, so a slot under a depth-2
 * zone (slot depth 3) would be dropped — silently — whenever its
 * template is applied by reference, and one under a depth-3 zone always.
 * The `TemplateZoneTask` copies those zones hold today ARE loaded at
 * that depth, so converting them would lose tasks. Such groups are
 * skipped and reported; a root slot (depth 1) and a slot under a root
 * zone (depth 2) are loaded on both paths.
 */
export const MAX_SLOT_PARENT_DEPTH = 1;

export interface PlannedSlot {
  key: string;
  /** null = the slot goes at the template ROOT. */
  parentZoneId: number | null;
  parentZoneName: string | null;
  deliverableTemplateId: number;
  deliverableName: string;
  deliverableCode: string | null;
  /** The deliverable template's own phase — it wins over a task's phase at apply. */
  deliverablePhaseId: number | null;
  sources: Provenance[];
  /** Exactly the `data` of the `templateZone.create`. */
  slot: SlotData;
  sortOrderBasis: {
    /** Smallest `sortOrder` among the group's copies. */
    smallestCopySortOrder: number;
    /** True when `slot.sortOrder` had to move off that number. */
    adjusted: boolean;
    note: string | null;
  };
  /** Copies the slot replaces — DELETED by a real run. */
  replaces: { templateTasks: RowRef[]; templateZoneTasks: RowRef[] };
  /** Copies left in place (`drift.onlyInCopy`). */
  keeps: RowRef[];
  drift: Drift;
  /** What the slot will pull into new projects. */
  deliverableTaskCount: number;
  deliverableDependencyEdges: number;
  /**
   * `TemplateTaskDependency` rows on the deleted root copies — they go
   * with the rows (FK cascade). `notInDeliverable` are the ones the
   * deliverable does not itself define between the same two codes: an
   * edge that exists only on the copies and is lost.
   */
  copyDependencyEdges: {
    cascaded: number;
    notInDeliverable: Array<{
      id: number;
      taskId: number;
      taskCode: string | null;
      dependsOnId: number;
      dependsOnCode: string | null;
    }>;
  };
}

export interface SkippedGroup {
  key: string;
  parentZoneId: number | null;
  parentZoneName: string | null;
  deliverableTemplateId: number;
  deliverableName: string | null;
  reason: SkipReason;
  detail: string;
  sources: Provenance[];
  /** The group's copies — all of them stay where they are. */
  copyRows: RowRef[];
  /** Present whenever the deliverable is usable to compare against. */
  drift: Drift | null;
}

export interface TemplatePlan {
  templateId: number;
  templateName: string;
  templateType: string;
  plannedSlots: PlannedSlot[];
  skippedGroups: SkippedGroup[];
  legacyUnresolvable: UnresolvableRow[];
  fkSourcedRows: number;
  markerResolvedRows: number;
}

function zoneDepths(zones: Array<{ id: number; parentId: number | null }>): Map<number, number> {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const depths = new Map<number, number>();
  const depthOf = (id: number, guard: number): number => {
    const known = depths.get(id);
    if (known != null) return known;
    const z = byId.get(id);
    // A parent outside the template, or a cycle: treat as too deep.
    const depth =
      !z || guard > zones.length
        ? Number.POSITIVE_INFINITY
        : z.parentId == null
          ? 1
          : depthOf(z.parentId, guard + 1) + 1;
    depths.set(id, depth);
    return depth;
  };
  for (const z of zones) depthOf(z.id, 0);
  return depths;
}

/**
 * Plan one composing template.
 *
 * Slot `sortOrder` — the approved planner did not decide it, so:
 *   • a slot takes the SMALLEST `sortOrder` among its group's copies
 *     (never below 1 — `materializeSlotTasksUnder` orders project tasks
 *     by `slot.sortOrder * 100 + task.sortOrder`, and a 0 would drop a
 *     slot's tasks in among the tasks that stay at the root);
 *   • groups under the same parent are taken in the order
 *     (smallest copy sortOrder, smallest copy row id, deliverable id) —
 *     the order the deliverables appear in the template today, with the
 *     row id standing in when several rows share a sortOrder (the
 *     column defaults to 0, so rows that were never ordered tie);
 *   • a number that is already taken — by the previous new slot or by a
 *     zone that already sits under that parent — is moved up to the
 *     next free one. Two sibling slots with the same number would have
 *     their tasks interleaved in the project, so the numbers stay
 *     unique and the order above is kept.
 */
export function planTemplate(
  tpl: ComposingTemplate,
  ctx: {
    markerCatalog: MarkerCatalogEntry[];
    deliverableById: Map<number, DeliverableTemplate>;
    codeCatalog: Map<string, CatalogEntry>;
    copyDependencyEdges: CopyDependencyEdge[];
  },
): TemplatePlan {
  const { groups, legacyUnresolvable, fkSourced, markerResolved } = groupCopyRows(tpl, ctx.markerCatalog);
  const zoneById = new Map(tpl.templateZones.map((z) => [z.id, z]));
  const depths = zoneDepths(tpl.templateZones);
  const linkedKeys = existingLinkedKeys(tpl);
  const rootTaskCodeById = new Map(tpl.templateTasks.map((t) => [t.id, t.code]));

  const skippedGroups: SkippedGroup[] = [];
  type Candidate = {
    group: CopyGroup<CopyRow>;
    deliverable: DeliverableTemplate;
    drift: Drift;
    matched: Array<SourcedCopyRow<CopyRow>>;
    unmatched: Array<SourcedCopyRow<CopyRow>>;
    smallestSortOrder: number;
    smallestRowId: number;
  };
  const candidates: Candidate[] = [];

  for (const group of groups) {
    const rows = [...group.templateTaskRows, ...group.templateZoneTaskRows];
    const parentZoneName =
      group.parentZoneId == null ? null : zoneById.get(group.parentZoneId)?.name ?? null;
    const deliverable = ctx.deliverableById.get(group.deliverableTemplateId) ?? null;
    const usable = deliverable != null && deliverable.deletedAt == null && deliverable.type === 'task_list';
    const computed = usable ? computeDrift(rows, deliverable, ctx.codeCatalog) : null;
    const skip = (reason: SkipReason, detail: string): void => {
      skippedGroups.push({
        key: group.key,
        parentZoneId: group.parentZoneId,
        parentZoneName,
        deliverableTemplateId: group.deliverableTemplateId,
        deliverableName: deliverable?.name ?? null,
        reason,
        detail,
        sources: [...group.sources].sort(),
        copyRows: rows.map(toRowRef),
        drift: computed?.drift ?? null,
      });
    };
    const where = group.parentZoneId == null ? 'the template root' : `zone #${group.parentZoneId}`;

    if (!deliverable) {
      skip('deliverable_missing', `Template #${group.deliverableTemplateId} does not exist.`);
      continue;
    }
    if (deliverable.deletedAt != null) {
      skip('deliverable_deleted', `Deliverable template #${deliverable.id} is soft-deleted.`);
      continue;
    }
    if (deliverable.type !== 'task_list') {
      skip(
        'deliverable_not_task_list',
        `Template #${deliverable.id} is of type "${deliverable.type}"; only "task_list" templates can be referenced.`,
      );
      continue;
    }
    if (linkedKeys.has(group.key)) {
      skip(
        'already_linked',
        `A zone at ${where} already links deliverable #${deliverable.id}; nothing is created and the ${rows.length} remaining copy row(s) are left as they are.`,
      );
      continue;
    }
    if (group.parentZoneId != null && (depths.get(group.parentZoneId) ?? Infinity) > MAX_SLOT_PARENT_DEPTH) {
      const parentDepth = depths.get(group.parentZoneId);
      skip(
        'parent_zone_too_deep',
        `Zone #${group.parentZoneId} is at depth ${parentDepth}; a slot under it would not be loaded by every apply path (see MAX_SLOT_PARENT_DEPTH), so its copies stay.`,
      );
      continue;
    }
    // `computed` is non-null from here on (the deliverable is usable).
    const { drift, matched, unmatched } = computed!;
    if (drift.duplicateCodes.inCopies.length > 0 || drift.duplicateCodes.inDeliverable.length > 0) {
      skip(
        'duplicate_codes',
        'A task code is repeated, so copies cannot be matched to deliverable tasks by code: ' +
          `in the copies [${drift.duplicateCodes.inCopies.join(', ')}], ` +
          `in the deliverable [${drift.duplicateCodes.inDeliverable.join(', ')}].`,
      );
      continue;
    }
    if (matched.length === 0) {
      skip(
        'no_matching_codes',
        `None of the ${rows.length} copy row(s) has a code the deliverable has, so a slot would replace nothing and only ADD the deliverable's ${deliverable.templateTasks.length} task(s) next to the copies.`,
      );
      continue;
    }
    candidates.push({
      group,
      deliverable,
      drift,
      matched,
      unmatched,
      smallestSortOrder: Math.min(...rows.map((r) => Number(r.row.sortOrder) || 0)),
      smallestRowId: Math.min(...rows.map((r) => r.id)),
    });
  }

  // Slot sortOrder — per parent, in today's visible order.
  candidates.sort(
    (a, b) =>
      a.smallestSortOrder - b.smallestSortOrder ||
      a.smallestRowId - b.smallestRowId ||
      a.deliverable.id - b.deliverable.id,
  );
  const takenByParent = new Map<number | null, Set<number>>();
  const lastByParent = new Map<number | null, number>();
  for (const z of tpl.templateZones) {
    const taken = takenByParent.get(z.parentId) ?? new Set<number>();
    taken.add(Number(z.sortOrder) || 0);
    takenByParent.set(z.parentId, taken);
  }

  const plannedSlots: PlannedSlot[] = [];
  for (const c of candidates) {
    const parentId = c.group.parentZoneId;
    const taken = takenByParent.get(parentId) ?? new Set<number>();
    takenByParent.set(parentId, taken);
    const wanted = Math.max(1, c.smallestSortOrder);
    let sortOrder = wanted;
    const last = lastByParent.get(parentId) ?? 0;
    while (sortOrder <= last || taken.has(sortOrder)) sortOrder++;
    taken.add(sortOrder);
    lastByParent.set(parentId, sortOrder);
    const adjusted = sortOrder !== c.smallestSortOrder;
    const note = !adjusted
      ? null
      : sortOrder === wanted
        ? 'Raised to 1: apply orders slot tasks by slot.sortOrder × 100 + task.sortOrder, so a slot at 0 would not keep its tasks apart from the tasks next to it.'
        : `${wanted} is taken by a sibling zone or by the previous new slot; moved to the next free number.`;

    const deleted = new Set(
      c.matched.filter((r) => r.kind === 'task').map((r) => r.id),
    );
    const deliverableCodeById = new Map(c.deliverable.templateTasks.map((t) => [t.id, normCode(t.code)]));
    const deliverableEdges = new Set<string>();
    let deliverableDependencyEdges = 0;
    for (const t of c.deliverable.templateTasks) {
      for (const p of t.predecessors ?? []) {
        deliverableDependencyEdges++;
        deliverableEdges.add(`${normCode(t.code)}<-${deliverableCodeById.get(p.dependsOnTemplateTaskId) ?? ''}`);
      }
    }
    const cascaded = ctx.copyDependencyEdges.filter(
      (e) => deleted.has(e.templateTaskId) || deleted.has(e.dependsOnTemplateTaskId),
    );
    const notInDeliverable = cascaded
      .filter((e) => {
        const bothDeleted = deleted.has(e.templateTaskId) && deleted.has(e.dependsOnTemplateTaskId);
        const pair = `${normCode(rootTaskCodeById.get(e.templateTaskId))}<-${normCode(rootTaskCodeById.get(e.dependsOnTemplateTaskId))}`;
        return !(bothDeleted && deliverableEdges.has(pair));
      })
      .map((e) => ({
        id: e.id,
        taskId: e.templateTaskId,
        taskCode: rootTaskCodeById.get(e.templateTaskId) ?? null,
        dependsOnId: e.dependsOnTemplateTaskId,
        dependsOnCode: rootTaskCodeById.get(e.dependsOnTemplateTaskId) ?? null,
      }));

    plannedSlots.push({
      key: c.group.key,
      parentZoneId: parentId,
      parentZoneName: parentId == null ? null : zoneById.get(parentId)?.name ?? null,
      deliverableTemplateId: c.deliverable.id,
      deliverableName: c.deliverable.name,
      deliverableCode: c.deliverable.code ?? null,
      deliverablePhaseId: c.deliverable.phaseId ?? null,
      sources: [...c.group.sources].sort(),
      slot: buildSlotData({
        templateId: tpl.id,
        parentZoneId: parentId,
        deliverable: c.deliverable,
        sortOrder,
      }),
      sortOrderBasis: { smallestCopySortOrder: c.smallestSortOrder, adjusted, note },
      replaces: {
        templateTasks: c.matched.filter((r) => r.kind === 'task').map(toRowRef),
        templateZoneTasks: c.matched.filter((r) => r.kind === 'zone_task').map(toRowRef),
      },
      keeps: c.unmatched.map(toRowRef),
      drift: c.drift,
      deliverableTaskCount: c.deliverable.templateTasks.length,
      deliverableDependencyEdges,
      copyDependencyEdges: { cascaded: cascaded.length, notInDeliverable },
    });
  }

  return {
    templateId: tpl.id,
    templateName: tpl.name,
    templateType: tpl.type,
    plannedSlots,
    skippedGroups,
    legacyUnresolvable,
    fkSourcedRows: fkSourced,
    markerResolvedRows: markerResolved,
  };
}

// ─── BEFORE / AFTER trees ───────────────────────────────────────────

interface TreeNode {
  label: string;
  children: TreeNode[];
}

/** A zone as the tree draws it. `id: null` = a slot that is only planned. */
interface TreeZone {
  id: number | null;
  name: string;
  parentId: number | null;
  sortOrder: number;
  linkedTaskTemplateId: number | null;
  templateZoneTasks: CopyRow[];
  isNew: boolean;
}

const bySortThenId = <T extends { sortOrder: number; id: number | null }>(a: T, b: T): number =>
  (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) ||
  (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER);

function printTree(root: TreeNode): string[] {
  const lines = [root.label];
  const walk = (nodes: TreeNode[], prefix: string): void => {
    nodes.forEach((node, i) => {
      const last = i === nodes.length - 1;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${node.label}`);
      walk(node.children, `${prefix}${last ? '    ' : '│   '}`);
    });
  };
  walk(root.children, '');
  return lines;
}

/**
 * Tasks first, then zones — each level in (`sortOrder`, id) order. A
 * slot lists the deliverable's tasks under it (what it pulls into a
 * project) with the count of dependency edges that come with them.
 */
function buildTree(
  tpl: { id: number; name: string; type: string },
  rootTasks: CopyRow[],
  zones: TreeZone[],
  opts: {
    deliverableById: Map<number, DeliverableTemplate>;
    /** `${kind}:${id}` of the copies a plan leaves in place. */
    kept?: Set<string>;
  },
): TreeNode {
  const taskNode = (t: CopyRow, kind: CopyRowKind): TreeNode => {
    const tag = t.deliverableTemplateId != null ? ` (dt=${t.deliverableTemplateId})` : '';
    const kept = opts.kept?.has(`${kind}:${t.id}`) ? '  ← KEPT: code not in the deliverable' : '';
    return { label: `Task ${t.code || '-'} "${t.name}"${tag}${kept}`, children: [] };
  };
  const childrenOf = (parentId: number | null): TreeZone[] =>
    zones.filter((z) => z.parentId === parentId).sort(bySortThenId);

  const zoneNode = (z: TreeZone): TreeNode => {
    const children: TreeNode[] = [];
    let label = `Zone "${z.name}" (#${z.id}) [sortOrder ${z.sortOrder}]`;
    if (z.linkedTaskTemplateId != null) {
      const d = opts.deliverableById.get(z.linkedTaskTemplateId);
      const tasks = [...(d?.templateTasks ?? [])].sort(bySortThenId);
      const edges = tasks.reduce((n, t) => n + (t.predecessors?.length ?? 0), 0);
      const ident = z.isNew ? (z.id == null ? 'NEW' : `NEW #${z.id}`) : `#${z.id}`;
      const pulls = d ? ` · ${tasks.length} tasks, ${edges} dependency edges` : '';
      label = `Slot "${z.name}" (${ident}, linked→#${z.linkedTaskTemplateId}) [sortOrder ${z.sortOrder}]${pulls}`;
      for (const t of tasks) {
        children.push({ label: `· ${t.code || '-'} "${t.name}"  (from the deliverable)`, children: [] });
      }
    }
    for (const t of [...z.templateZoneTasks].sort(bySortThenId)) children.push(taskNode(t, 'zone_task'));
    if (z.id != null) for (const child of childrenOf(z.id)) children.push(zoneNode(child));
    return { label, children };
  };

  return {
    label: `Template #${tpl.id} "${tpl.name}" [${tpl.type}]`,
    children: [
      ...[...rootTasks].sort(bySortThenId).map((t) => taskNode(t, 'task')),
      ...childrenOf(null).map(zoneNode),
    ],
  };
}

/**
 * The template as it is stored. Used for BEFORE, and for AFTER once a
 * real run has written (`newSlotIds` = the zones it created, `kept` =
 * the copies it left in place).
 */
export function renderCurrentTree(
  tpl: ComposingTemplate,
  deliverableById: Map<number, DeliverableTemplate>,
  opts: { newSlotIds?: Set<number>; kept?: Set<string> } = {},
): string[] {
  const zones: TreeZone[] = tpl.templateZones.map((z) => ({
    id: z.id,
    name: z.name,
    parentId: z.parentId,
    sortOrder: z.sortOrder,
    linkedTaskTemplateId: z.linkedTaskTemplateId,
    templateZoneTasks: z.templateZoneTasks,
    isNew: opts.newSlotIds?.has(z.id) ?? false,
  }));
  return printTree(buildTree(tpl, tpl.templateTasks, zones, { deliverableById, kept: opts.kept }));
}

/** `${kind}:${id}` of every copy the plan leaves in place next to a new slot. */
export function keptKeys(plan: TemplatePlan): Set<string> {
  const kept = new Set<string>();
  for (const s of plan.plannedSlots) for (const r of s.keeps) kept.add(`${r.kind}:${r.id}`);
  return kept;
}

/** The template as the plan would leave it: replaced copies gone, kept copies flagged, new slots in place. */
export function renderPlannedTree(
  tpl: ComposingTemplate,
  plan: TemplatePlan,
  deliverableById: Map<number, DeliverableTemplate>,
): string[] {
  const deletedTasks = new Set<number>();
  const deletedZoneTasks = new Set<number>();
  for (const s of plan.plannedSlots) {
    for (const r of s.replaces.templateTasks) deletedTasks.add(r.id);
    for (const r of s.replaces.templateZoneTasks) deletedZoneTasks.add(r.id);
  }
  const zones: TreeZone[] = [
    ...tpl.templateZones.map((z) => ({
      id: z.id,
      name: z.name,
      parentId: z.parentId,
      sortOrder: z.sortOrder,
      linkedTaskTemplateId: z.linkedTaskTemplateId,
      templateZoneTasks: z.templateZoneTasks.filter((t) => !deletedZoneTasks.has(t.id)),
      isNew: false,
    })),
    ...plan.plannedSlots.map((s) => ({
      id: null,
      name: s.slot.name,
      parentId: s.slot.parentId,
      sortOrder: s.slot.sortOrder,
      linkedTaskTemplateId: s.slot.linkedTaskTemplateId,
      templateZoneTasks: [],
      isNew: true,
    })),
  ];
  return printTree(
    buildTree(
      tpl,
      tpl.templateTasks.filter((t) => !deletedTasks.has(t.id)),
      zones,
      { deliverableById, kept: keptKeys(plan) },
    ),
  );
}

