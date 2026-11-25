import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma, type ZoneType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeZoneType, ZONE_TYPE_VALUES } from '../zones/dto/create-zone.dto';
import { extractServiceMarker } from '../planning/marker-phase-resolver';
import {
  applyLagForward,
  snapToWorkingDayForward,
  walkWorkingDaysForward,
  type LagUnitSched,
} from '../scheduling/scheduler.service';

// DN-ext (2026-10-22) — Fields that must NEVER be edited through the
// Deliverable Template / Zone Template editors on a row that is
// linked to a catalog TemplateTask. Those live under Task Catalog
// (the catalog's own tasks have `catalogTaskId = null`, so the
// Catalog page keeps the full edit surface). Expressed as a readonly
// array so the guard can report which specific fields were touched.
const CATALOG_LINKED_READONLY_FIELDS = [
  'name',
  'defaultBudgetHours',
  'defaultBudgetAmount',
] as const;

/// bm2 (2026-10-28) — Two template-level "working days" calculations
// the Deliverable Templates screen surfaces side by side:
//
//   • Fastest = critical-path forward pass over the predecessor DAG,
//     i.e. the minimum possible completion time with unlimited
//     parallel resources.
//
//     BM2-30 (QA6, 2026-11-25) — this is now the SAME forward pass the
//     project scheduler runs (`modules/scheduling/scheduler.service.ts`,
//     D1-Lag / D7), built from its exported pure helpers so the two
//     can't drift: per-task duration = max(1, ceil(hours / 8)) working
//     days (the scheduler's `resolveWorkingDaysDuration` with no
//     assignee), a successor starts at `applyLagForward(pred.end, lag,
//     lagUnit)` (lag 0 = the next working day, WORKING_DAYS lag adds
//     strict working days, CALENDAR_DAYS lag adds calendar days and
//     snaps forward), and the result is the number of working days from
//     the first task's start to the latest finish, inclusive. The old
//     calc ignored the per-edge lag (a 7-day wait read as ~2d) and
//     added a full idle day per edge that the scheduler never adds.
//     The calendar is the scheduler's default one (Fri + Sat rest, no
//     holidays) starting on a Sunday, so a CALENDAR_DAYS lag counts
//     the weekend it spans the same way a project would.
//
//   • Slowest = pure sequential execution — "what if we could only
//     do one task at a time". `ceil(sum(budgetHours)/8 + (N-1) × 1
//     gap day)`, ignoring the DAG, floored at Fastest (a lag wait can
//     make the critical path longer than the serial work itself).
//
// Both deliberately ignore holidays, assignee capacity and the
// project start; these are the "pure standard" numbers the templates
// screen surfaces. The real per-project scheduler lives under
// modules/scheduling.
//
// bm2 (2026-10-28, "no hours = no measure") — Both calcs return
// `null` when the template has no tasks OR when every task's
// `budgetHours` is missing / zero. Returning null lets the FE hide
// the chip entirely for the "we don't know yet" case.
//
// Fastest also returns 0 (not null) when a cycle breaks the DAG
// forward pass — the hours are real, we just couldn't compute a
// critical path. Keeping that distinct from null preserves the
// existing cycle-detection test.
const STANDARD_DAY_HOURS = 8.0;
const workingDaysLogger = new Logger('computeFastestWorkingDays');
/** BM2-30 — the scheduler's default weekly rest (Fri + Sat). */
const STANDARD_WEEKLY_REST_DAYS: readonly number[] = [5, 6];
const isStandardWorkingDay = (d: Date): boolean =>
  !STANDARD_WEEKLY_REST_DAYS.includes(d.getUTCDay());
/** BM2-30 — day 1 of the estimate: Sunday 2026-01-04 (UTC). */
const STANDARD_REFERENCE_START_MS = Date.UTC(2026, 0, 4);
export interface SwdTask {
  id: number;
  budgetHours: number | null | undefined;
}
export interface SwdEdge {
  // The task that depends on another (successor).
  templateTaskId: number;
  // The task it depends on (predecessor).
  dependsOnTemplateTaskId: number;
  // BM2-30 — the edge's finish-to-start wait (`TemplateTaskDependency`
  // lag / lagUnit). Missing = 0 working days, the plain handoff.
  lag?: number | null;
  lagUnit?: string | null;
}
// Shared "has any real hours?" predicate so both compute fns agree
// on what counts as "no measure" (null / undefined / non-finite / <= 0).
function hasAnyBudgetedHours(tasks: readonly SwdTask[]): boolean {
  for (const t of tasks) {
    const h = Number(t.budgetHours ?? 0);
    if (Number.isFinite(h) && h > 0) return true;
  }
  return false;
}
/**
 * BM2-30 — a task's length in working days, exactly as the scheduler
 * sizes an unassigned task (`resolveWorkingDaysDuration`, default 8h
 * day): hours > 0 → ceil(hours / 8), at least 1; no hours → 1.
 */
export function templateTaskWorkingDays(budgetHours: number | null | undefined): number {
  const h = Number(budgetHours ?? 0);
  if (Number.isFinite(h) && h > 0) return Math.max(1, Math.ceil(h / STANDARD_DAY_HOURS));
  return 1;
}
/** BM2-30 — normalise an edge's lag the way the scheduler does. */
function normaliseLag(e: SwdEdge): { lag: number; lagUnit: LagUnitSched } {
  return {
    lag: Math.max(0, Math.floor(Number(e.lag) || 0)),
    lagUnit: e.lagUnit === 'CALENDAR_DAYS' ? 'CALENDAR_DAYS' : 'WORKING_DAYS',
  };
}
/** Working days in [from, to], both ends included, on the standard calendar. */
function countStandardWorkingDays(from: Date, to: Date): number {
  let count = 0;
  const cursor = new Date(from.getTime());
  while (cursor.getTime() <= to.getTime()) {
    if (isStandardWorkingDay(cursor)) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}
export function computeFastestWorkingDays(
  tasks: readonly SwdTask[],
  edges: readonly SwdEdge[],
): number | null {
  if (!tasks || tasks.length === 0) return null;
  if (!hasAnyBudgetedHours(tasks)) return null;

  const duration = new Map<number, number>();
  for (const t of tasks) duration.set(t.id, templateTaskWorkingDays(t.budgetHours));

  // Build adjacency + in-degree over the task set. Edges that point
  // outside the task set (orphaned deps) are ignored — the live
  // schema's FKs make that unreachable for sane rows, but defensive.
  const taskIds = new Set<number>(duration.keys());
  const predEdges = new Map<number, Array<{ pred: number; lag: number; lagUnit: LagUnitSched }>>();
  const outgoing = new Map<number, number[]>(); // pred -> [succ...]
  const inDegree = new Map<number, number>();
  for (const id of taskIds) {
    predEdges.set(id, []);
    outgoing.set(id, []);
    inDegree.set(id, 0);
  }
  for (const e of edges) {
    if (!taskIds.has(e.templateTaskId) || !taskIds.has(e.dependsOnTemplateTaskId)) continue;
    predEdges.get(e.templateTaskId)!.push({ pred: e.dependsOnTemplateTaskId, ...normaliseLag(e) });
    outgoing.get(e.dependsOnTemplateTaskId)!.push(e.templateTaskId);
    inDegree.set(e.templateTaskId, (inDegree.get(e.templateTaskId) ?? 0) + 1);
  }

  // Kahn forward pass, the scheduler's step 10 on the standard
  // calendar: ES = max over pred edges of applyLagForward(pred.EF),
  // snapped to a working day; EF = ES walked `duration` working days
  // forward (inclusive).
  const referenceStart = snapToWorkingDayForward(
    new Date(STANDARD_REFERENCE_START_MS),
    isStandardWorkingDay,
  );
  const finish = new Map<number, Date>();
  const queue: number[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
  let processed = 0;
  while (queue.length) {
    const n = queue.shift()!;
    processed++;
    let start = referenceStart;
    for (const edge of predEdges.get(n) ?? []) {
      const pf = finish.get(edge.pred);
      if (!pf) continue;
      const candidate = applyLagForward(pf, edge.lag, edge.lagUnit, isStandardWorkingDay);
      if (candidate.getTime() > start.getTime()) start = candidate;
    }
    start = snapToWorkingDayForward(start, isStandardWorkingDay);
    finish.set(n, walkWorkingDaysForward(start, duration.get(n) ?? 1, isStandardWorkingDay));
    for (const s of outgoing.get(n) ?? []) {
      const deg = (inDegree.get(s) ?? 0) - 1;
      inDegree.set(s, deg);
      if (deg === 0) queue.push(s);
    }
  }

  if (processed !== taskIds.size) {
    workingDaysLogger.warn(
      `cycle detected in template dependency graph — processed ${processed}/${taskIds.size} tasks; returning 0`,
    );
    return 0;
  }

  let latest = referenceStart;
  for (const d of finish.values()) if (d.getTime() > latest.getTime()) latest = d;
  return countStandardWorkingDays(referenceStart, latest);
}

// bm2 (2026-10-28) — Slowest = pure sequential execution with no
// parallelism. `ceil(sum(budgetHours) / 8 + (N - 1) × 1 gap day)`.
// Dependency edges don't matter here; this is the upper-bound
// "worst-case solo operator" number that pairs with the Fastest
// critical-path calc above.
//
// BM2-30 (QA6) — pass the template's edges and the result is floored
// at Fastest: a lag wait (e.g. 7 days for a customer approval) makes
// the critical path longer than the serial work, and "Slowest ~3d"
// next to "Fastest ~15d" would be nonsense. Without edges the value
// is the plain sequential formula.
//
// Returns `null` when there are no tasks or none has any real
// `budgetHours`. Otherwise the (N-1) gap-day term would produce
// a non-zero figure for a template with ALL-NULL hours, which the
// user flagged as nonsense ("אין שעות = אין מידה").
export function computeSlowestWorkingDays(
  tasks: readonly SwdTask[],
  edges?: readonly SwdEdge[],
): number | null {
  if (!tasks || tasks.length === 0) return null;
  if (!hasAnyBudgetedHours(tasks)) return null;
  const sum = tasks.reduce((s, t) => {
    const h = Number(t.budgetHours ?? 0);
    return s + (Number.isFinite(h) && h > 0 ? h : 0);
  }, 0);
  const totalDays = sum / STANDARD_DAY_HOURS + (tasks.length - 1);
  const sequential = Math.ceil(totalDays);
  if (!edges || edges.length === 0) return sequential;
  const fastest = computeFastestWorkingDays(tasks, edges) ?? 0;
  return Math.max(sequential, fastest);
}

// DN-ext — reusable live-override: when a template task row has a
// `catalogTask` relation populated by the `findOne` include, prefer
// the catalog's current name / hours / amount over the row's own
// (snapshot) scalars. The scalars stay as a safety fallback for
// ad-hoc rows (catalogTaskId null) and for rows whose catalog row
// was deleted (`onDelete: SetNull` nulled this FK). Pure function —
// mutates only a shallow copy of the row and recurses into zone
// trees so every TemplateTask / TemplateZoneTask in the response
// gets the same treatment.
export function resolveCatalogLiveFields<T>(input: T): T {
  if (input == null) return input;
  if (Array.isArray(input)) {
    return (input as unknown[]).map(resolveCatalogLiveFields) as unknown as T;
  }
  if (typeof input !== 'object') return input;
  const row: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  const ct = row.catalogTask as
    | { name?: string | null; defaultBudgetHours?: unknown; defaultBudgetAmount?: unknown }
    | null
    | undefined;
  if (ct) {
    if (ct.name != null) row.name = ct.name;
    if (ct.defaultBudgetHours != null) row.defaultBudgetHours = ct.defaultBudgetHours;
    if (ct.defaultBudgetAmount != null) row.defaultBudgetAmount = ct.defaultBudgetAmount;
  }
  // Recurse into the nested shapes `findOne` returns so a response
  // never ships a stale name buried under a zone > child > zone-task.
  for (const key of [
    'templateTasks',
    'templateZones',
    'templateZoneTasks',
    'children',
  ]) {
    if (key in row) row[key] = resolveCatalogLiveFields(row[key]);
  }
  return row as T;
}

// ─── PR-053 (QA6, 2026-11-25) · archive + "in use" ────────────────────
//
// Decision 25.11: a template that is in use can be ARCHIVED (hidden from
// every picker, untouched where it is already used, restorable). Delete
// stays only for a template nobody uses. Applies to every `Template`
// kind (Deliverable `task_list`, hierarchical Zone `zone`, `combined`).

/** The Task Catalog is a `task_list` template too, but never archivable. */
export const TASK_CATALOG_CODE = '__TASK_CATALOG__';

/** `GET /templates?archived=` — which templates a list returns. */
export type ArchivedFilter = 'exclude' | 'only' | 'include';

export function parseArchivedFilter(raw: unknown): ArchivedFilter {
  if (raw == null || raw === '') return 'exclude';
  if (raw === 'exclude' || raw === 'only' || raw === 'include') return raw;
  throw new BadRequestException({
    code: 'TEMPLATES_ARCHIVED_FILTER_INVALID',
    message: 'archived must be one of: exclude, only, include.',
  });
}

/**
 * Where a template is used. A template is "in use" when any count is
 * above zero:
 *   • applied             — `Template.usageCount` (times it was applied
 *                           to a project),
 *   • projectDeliverables — live project deliverables made from it
 *                           (`ProjectDeliverable.sourceTemplateId`),
 *   • projectTasks        — live project tasks that belong to it
 *                           (`Task.deliverableTemplateId`),
 *   • composingTemplates  — OTHER live templates that reference it: a
 *                           zone slot (`TemplateZone.linkedTaskTemplateId`
 *                           / `referencedTemplateId`) or a zone task of
 *                           that deliverable (`TemplateZoneTask
 *                           .deliverableTemplateId`). Archived composing
 *                           templates still count (they can be restored).
 */
export interface TemplateUsage {
  applied: number;
  projectDeliverables: number;
  projectTasks: number;
  composingTemplates: number;
  inUse: boolean;
}

export function describeTemplateUsage(u: TemplateUsage): string {
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (u.applied > 0) parts.push(`applied ${plural(u.applied, 'time', 'times')}`);
  if (u.projectDeliverables > 0) {
    parts.push(plural(u.projectDeliverables, 'project deliverable', 'project deliverables'));
  }
  if (u.projectTasks > 0) parts.push(plural(u.projectTasks, 'project task', 'project tasks'));
  if (u.composingTemplates > 0) {
    parts.push(`used by ${plural(u.composingTemplates, 'other template', 'other templates')}`);
  }
  return parts.join(', ');
}

// ─── QA6 · template zone input (POST /templates/:id/zones 500) ─────────

/** Cleaned `addZone` / `updateZone` input; undefined = not sent. */
interface TemplateZoneInput {
  name?: string;
  code?: string | null;
  zoneType?: ZoneType;
  isTypical?: boolean;
  typicalCount?: number;
  instanceCount?: number;
  sortOrder?: number;
  parentId?: number | null;
  linkedTaskTemplateId?: number | null;
  referencedTemplateId?: number | null;
}

/** null / '' / 0 → null (the old `body.x || null`); else a positive integer or a 400. */
function optionalIdOrThrow(raw: unknown, field: string, code: string): number | null {
  if (raw === null || raw === undefined || raw === '' || raw === 0 || raw === '0') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new BadRequestException({
      code,
      message: `${field} must be a positive integer.`,
      details: { field, value: raw },
    });
  }
  return n;
}

function positiveIntOrThrow(raw: unknown, field: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new BadRequestException({
      code: 'TEMPLATE_ZONE_COUNT_INVALID',
      message: `${field} must be a whole number of at least 1.`,
      details: { field, value: raw },
    });
  }
  return n;
}

/**
 * Last line of defence for a template-zone write: a Prisma error that a
 * check above did not catch is still the caller's input, so it becomes
 * a 4xx with a code, never an "Unhandled error" 500. Anything else is
 * rethrown untouched.
 */
export function mapTemplateZoneWriteError(err: unknown): unknown {
  if (err instanceof Prisma.PrismaClientValidationError) {
    return new BadRequestException({
      code: 'TEMPLATE_ZONE_INVALID',
      message: 'The zone could not be saved: one of its values is not valid.',
    });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2003') {
      return new BadRequestException({
        code: 'TEMPLATE_ZONE_REFERENCE_INVALID',
        message: 'The zone points at a parent or template that does not exist.',
      });
    }
    if (err.code === 'P2000') {
      return new BadRequestException({
        code: 'TEMPLATE_ZONE_VALUE_TOO_LONG',
        message: 'One of the zone values is too long.',
      });
    }
    if (err.code === 'P2025') return new NotFoundException('Template zone not found');
  }
  return err;
}

@Injectable()
export class TemplatesService {
  constructor(private prisma: PrismaService) {}

  /**
   * PR-053 — usage of each given template (see `TemplateUsage`). Four
   * grouped reads regardless of how many templates are asked about, so
   * the list endpoint can carry `usage` on every row.
   */
  async getUsage(
    rows: ReadonlyArray<{ id: number; usageCount?: number | null }>,
  ): Promise<Map<number, TemplateUsage>> {
    const out = new Map<number, TemplateUsage>();
    const ids = rows.map((r) => r.id);
    for (const r of rows) {
      out.set(r.id, {
        applied: Math.max(0, Number(r.usageCount ?? 0) || 0),
        projectDeliverables: 0,
        projectTasks: 0,
        composingTemplates: 0,
        inUse: false,
      });
    }
    if (ids.length === 0) return out;

    const [deliverables, tasks, zoneRefs, zoneTasks] = await Promise.all([
      this.prisma.projectDeliverable.groupBy({
        by: ['sourceTemplateId'],
        where: { sourceTemplateId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.task.groupBy({
        by: ['deliverableTemplateId'],
        where: { deliverableTemplateId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.templateZone.findMany({
        where: {
          OR: [{ linkedTaskTemplateId: { in: ids } }, { referencedTemplateId: { in: ids } }],
          template: { deletedAt: null },
        },
        select: { templateId: true, linkedTaskTemplateId: true, referencedTemplateId: true },
      }),
      this.prisma.templateZoneTask.findMany({
        where: {
          deliverableTemplateId: { in: ids },
          templateZone: { template: { deletedAt: null } },
        },
        select: { deliverableTemplateId: true, templateZone: { select: { templateId: true } } },
      }),
    ]);

    for (const g of deliverables as any[]) {
      const u = out.get(g.sourceTemplateId);
      if (u) u.projectDeliverables = g._count?._all ?? 0;
    }
    for (const g of tasks as any[]) {
      const u = out.get(g.deliverableTemplateId);
      if (u) u.projectTasks = g._count?._all ?? 0;
    }
    const composers = new Map<number, Set<number>>();
    const addComposer = (target: number | null | undefined, composer: number) => {
      if (target == null || target === composer || !out.has(target)) return;
      const set = composers.get(target) ?? new Set<number>();
      set.add(composer);
      composers.set(target, set);
    };
    for (const z of zoneRefs) {
      addComposer(z.linkedTaskTemplateId, z.templateId);
      addComposer(z.referencedTemplateId, z.templateId);
    }
    for (const zt of zoneTasks) {
      addComposer(zt.deliverableTemplateId, zt.templateZone.templateId);
    }
    for (const [id, set] of composers) out.get(id)!.composingTemplates = set.size;

    for (const u of out.values()) {
      u.inUse =
        u.applied > 0 || u.projectDeliverables > 0 || u.projectTasks > 0 || u.composingTemplates > 0;
    }
    return out;
  }

  /**
   * PR-053 — archive a template: hidden from every list / picker,
   * readable by id, restorable. Idempotent. The Task Catalog can't be
   * archived (its pages would re-create a second catalog).
   */
  async archive(id: number) {
    const tpl = await this.prisma.template.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, code: true, archivedAt: true },
    });
    if (!tpl) throw new NotFoundException('Template not found');
    if (tpl.code === TASK_CATALOG_CODE) {
      throw new BadRequestException({
        code: 'TEMPLATE_CATALOG_NOT_ARCHIVABLE',
        message: 'The Task Catalog cannot be archived.',
      });
    }
    if (tpl.archivedAt) return { id: tpl.id, archivedAt: tpl.archivedAt };
    return this.prisma.template.update({
      where: { id },
      data: { archivedAt: new Date() },
      select: { id: true, archivedAt: true },
    });
  }

  /** PR-053 — bring an archived template back to the lists. Idempotent. */
  async restore(id: number) {
    const tpl = await this.prisma.template.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, archivedAt: true },
    });
    if (!tpl) throw new NotFoundException('Template not found');
    if (!tpl.archivedAt) return { id: tpl.id, archivedAt: null };
    return this.prisma.template.update({
      where: { id },
      data: { archivedAt: null },
      select: { id: true, archivedAt: true },
    });
  }

  /**
   * PR-053 — a template picked into another template (zone slot or zone
   * reference) must exist and be active. Archived ones are hidden from
   * the pickers; this closes the door for a stale tab or a direct call.
   * Already-saved references are never checked here, so a composing
   * template that used it before the archive keeps working.
   */
  private async assertPickableTemplate(templateId: number, field: string) {
    const tpl = await this.prisma.template.findFirst({
      where: { id: templateId, deletedAt: null },
      select: { id: true, name: true, type: true, archivedAt: true },
    });
    if (!tpl) {
      throw new BadRequestException({
        code: 'TEMPLATE_REF_NOT_FOUND',
        message: `${field}: template #${templateId} not found.`,
        details: { field, templateId },
      });
    }
    if (tpl.archivedAt) {
      throw new ConflictException({
        code: 'TEMPLATE_ARCHIVED',
        message: `Template "${tpl.name}" is archived. Restore it before adding it to another template.`,
        details: { field, templateId },
      });
    }
    return tpl;
  }

  /**
   * QA4 · DN-2 (2026-10-04) — Server-side resolve a Deliverable
   * Template FK from a `[SERVICE:<marker>]` description marker.
   *
   * Used by `addTask` + `addZoneTask` as a defensive fallback when
   * the caller sends only the legacy marker (e.g. an older FE build
   * cached in a tab, or a direct API caller). The B1 service-picker
   * flows already send `deliverableTemplateId` explicitly; this is
   * belt-and-braces so new rows written through either of those
   * endpoints can never again end up with a null FK + stale marker.
   *
   * Matches `catalog.name = marker` first, then `name LIKE marker\%`
   * (the `base\detail` rename form). Same preference rules as the
   * DN-1 backfill:
   *   1. Phase match (if the task has `phaseId`).
   *   2. Prefer exact over prefix.
   *   3. Still > 1 → return null (never guess).
   * Zero candidates → null.
   *
   * Templates-side only: never resolves against anything other than
   * `type=task_list, deletedAt=null` catalog rows.
   */
  private async resolveDeliverableTemplateByMarker(
    description: string | null | undefined,
    taskPhaseId: number | null | undefined,
  ): Promise<number | null> {
    const marker = extractServiceMarker(description);
    if (!marker) return null;

    const catalog = await this.prisma.template.findMany({
      where: { deletedAt: null, type: 'task_list' },
      select: { id: true, name: true, phaseId: true },
    });

    const exact = catalog.filter((t) => t.name === marker);
    const prefix = catalog.filter((t) => t.name.startsWith(`${marker}\\`));
    const all = [
      ...exact.map((t) => ({ ...t, matchKind: 'exact' as const })),
      ...prefix.map((t) => ({ ...t, matchKind: 'prefix' as const })),
    ];
    if (all.length === 0) return null;
    if (all.length === 1) return all[0].id;

    // > 1 — phase preference first.
    if (taskPhaseId != null) {
      const samePhase = all.filter((c) => c.phaseId === taskPhaseId);
      if (samePhase.length === 1) return samePhase[0].id;
      if (samePhase.length > 1) {
        const exactPhase = samePhase.find((c) => c.matchKind === 'exact');
        if (exactPhase) return exactPhase.id;
      }
    }
    // Prefer exact over prefix.
    if (exact.length === 1) return exact[0].id;
    // Still ambiguous — refuse to guess.
    return null;
  }

  /**
   * PR-053 — `archived` picks which templates come back: `exclude`
   * (default, every picker in the app) leaves archived ones out, `only`
   * is the templates page's Archived view, `include` returns both.
   * Archived templates are still loaded for the composition rollup below
   * so a composing template keeps counting the tasks of an archived
   * deliverable it references; the filter applies to the response rows.
   * Every row carries `archivedAt` and `usage` (see `TemplateUsage`).
   */
  async findAll(type?: string, archived: ArchivedFilter = 'exclude') {
    const where: any = { deletedAt: null };
    if (type) where.type = type;

    // Load templates + the per-template-zone fields we need to recursively
    // count tasks across the full composition graph (referencedTemplateId,
    // linkedTaskTemplateId, inline task counts, multiplicity).
    const templates = await this.prisma.template.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
        phase: true,
        _count: { select: { templateTasks: true, templateZones: true } },
        // bm2 (2026-10-28) — expanded from `{ id, description }` so the
        // standard-working-days rollup below can read per-task budget
        // hours + the predecessor edges without a second round trip.
        // `defaultBudgetHours` + `catalogTask.defaultBudgetHours` mirror
        // the live-resolve pattern used by `findOne` (DN-ext): the
        // catalog value wins when the row is linked, local scalar is a
        // snapshot fallback. The `take: 100` cap stays — it already
        // bounds the earlier services-extraction scan.
        templateTasks: {
          select: {
            id: true,
            description: true,
            defaultBudgetHours: true,
            catalogTask: { select: { defaultBudgetHours: true } },
            predecessors: { select: { dependsOnTemplateTaskId: true, lag: true, lagUnit: true } },
          },
          take: 100,
        },
        templateZones: {
          select: {
            instanceCount: true,
            referencedTemplateId: true,
            linkedTaskTemplateId: true,
            _count: { select: { templateZoneTasks: true } },
          },
        },
      },
    });

    // Build an id → template lookup for the recursive rollup below.
    const byId = new Map<number, any>(templates.map((t: any) => [t.id, t]));

    // Direct-services set per template: distinct service codes pulled from
    // the [SERVICE:xxx] tag in each templateTask description.
    const directServicesById = new Map<number, Set<string>>();
    for (const t of templates) {
      const set = new Set<string>();
      for (const task of (t.templateTasks ?? [])) {
        const m = task.description?.match(/^\[SERVICE:(.+)\]$/);
        if (m) set.add(m[1]);
      }
      directServicesById.set(t.id, set);
    }

    // Recursive rollup: count tasks AND collect distinct services across the
    // composition graph (root tasks + linkedTaskTemplate + referencedTemplate
    // children, multiplied by instanceCount where it makes sense for tasks
    // — services are a UNION so multiplicity doesn't apply). Memoised
    // per template id; cycle-guarded.
    const taskTotalCache = new Map<number, number>();
    const serviceSetCache = new Map<number, Set<string>>();
    const visiting = new Set<number>();

    const computeRollup = (id: number): { tasks: number; services: Set<string> } => {
      if (taskTotalCache.has(id) && serviceSetCache.has(id)) {
        return { tasks: taskTotalCache.get(id)!, services: serviceSetCache.get(id)! };
      }
      if (visiting.has(id)) return { tasks: 0, services: new Set() }; // cycle — bail
      const t = byId.get(id);
      if (!t) return { tasks: 0, services: new Set() };
      visiting.add(id);

      let tasks = t._count?.templateTasks ?? 0;
      const services = new Set<string>(directServicesById.get(id) ?? []);

      for (const z of (t.templateZones ?? [])) {
        const mult = Math.max(1, Number(z.instanceCount) || 1);
        let zoneTasks = z._count?.templateZoneTasks ?? 0;
        if (z.linkedTaskTemplateId) {
          const linked = byId.get(z.linkedTaskTemplateId);
          zoneTasks += linked?._count?.templateTasks ?? 0;
          for (const s of (directServicesById.get(z.linkedTaskTemplateId) ?? [])) services.add(s);
        }
        if (z.referencedTemplateId) {
          const child = computeRollup(z.referencedTemplateId);
          zoneTasks += child.tasks;
          for (const s of child.services) services.add(s);
        }
        tasks += zoneTasks * mult;
      }
      visiting.delete(id);
      taskTotalCache.set(id, tasks);
      serviceSetCache.set(id, services);
      return { tasks, services };
    };

    // PR-053 — usage for the rows the caller will see, then the
    // archived filter (the rollup above already saw every template).
    const visible = (templates as any[]).filter((t) =>
      archived === 'include' ? true : archived === 'only' ? t.archivedAt != null : t.archivedAt == null,
    );
    const usageById = await this.getUsage(visible);

    return visible.map((t: any) => {
      const expandedZones = (t.templateZones ?? []).reduce(
        (sum: number, z: any) => sum + Math.max(1, Number(z.instanceCount) || 1),
        0,
      );
      const rollup = computeRollup(t.id);
      // bm2 (2026-10-28) — Deliverable Templates ("task_list") get
      // both fastest (critical-path) and slowest (sequential) working
      // day estimates so the list row can preview the range before
      // you open the editor. Other template types (zone_template,
      // team_template, …) return `null` so the FE can hide the chip
      // for them. The predecessor edges ride on
      // `templateTasks[i].predecessors` from the include above.
      let fastestWorkingDays: number | null = null;
      let slowestWorkingDays: number | null = null;
      if (t.type === 'task_list') {
        const rawTasks = (t.templateTasks ?? []) as any[];
        const tasks: SwdTask[] = rawTasks.map((row) => ({
          id: row.id,
          budgetHours:
            // DN-ext live-resolve: catalog value wins when linked,
            // snapshot scalar is the fallback for ad-hoc rows or when
            // the catalog row was deleted and `onDelete: SetNull`
            // nulled the FK.
            row.catalogTask?.defaultBudgetHours != null
              ? Number(row.catalogTask.defaultBudgetHours)
              : row.defaultBudgetHours != null
                ? Number(row.defaultBudgetHours)
                : null,
        }));
        const edges: SwdEdge[] = rawTasks.flatMap((row) =>
          (row.predecessors ?? []).map((p: any) => ({
            templateTaskId: row.id,
            dependsOnTemplateTaskId: p.dependsOnTemplateTaskId,
            lag: p.lag,
            lagUnit: p.lagUnit,
          })),
        );
        fastestWorkingDays = computeFastestWorkingDays(tasks, edges);
        slowestWorkingDays = computeSlowestWorkingDays(tasks, edges);
      }
      return {
        ...t,
        _count: {
          ...t._count,
          templateZones: expandedZones,
          templateZoneRows: t._count?.templateZones ?? 0,
          templateRootTasks: t._count?.templateTasks ?? 0,
          templateTasks: rollup.tasks,
        },
        fastestWorkingDays,
        slowestWorkingDays,
        usage: usageById.get(t.id),
        // Effective service list for the UI to count distinct services
        // without needing to walk descriptions itself. Replaces the direct
        // templateTasks list (which the picker only used for service extraction).
        templateTasks: Array.from(rollup.services).map((name) => ({
          id: 0,
          description: `[SERVICE:${name}]`,
        })),
        templateZones: undefined,
      };
    });
  }

  async create(userId: number, body: any) {
    // bm2 (2026-10-28) — Validate all inline-task shapes BEFORE
    // creating the parent template, so a bad task payload can't
    // leave an orphan Template behind. Mirrors the per-task guards
    // in `addTask` (code required + unique within template).
    //  • code required: an empty / whitespace-only / missing code
    //    used to crash downstream as a raw Prisma P2012 ("Argument
    //    `code` is missing"); we surface it as a friendly 400.
    //  • within-batch uniqueness: catches `[{code:'A'},{code:'A'}]`
    //    before Prisma does, so the error message names which task
    //    index collided.
    //  TODO(dedup migration): once the staging DB has been cleaned
    //  of pre-existing duplicates, add `@@unique([templateId,code])`
    //  on `TemplateTask` so the DB enforces this too.
    if (body.tasks && Array.isArray(body.tasks)) {
      const seenCodes = new Set<string>();
      for (let i = 0; i < body.tasks.length; i++) {
        const t = body.tasks[i];
        const codeTrim = String(t?.code ?? '').trim();
        if (!codeTrim) {
          throw new BadRequestException({
            code: 'TEMPLATE_TASK_CODE_REQUIRED',
            message: `Code is required for task "${t?.name ?? '(unnamed)'}" (index ${i})`,
          });
        }
        if (seenCodes.has(codeTrim)) {
          throw new BadRequestException({
            code: 'TEMPLATE_TASK_CODE_DUPLICATE',
            message: `Duplicate code "${codeTrim}" in this batch (task "${t?.name ?? '(unnamed)'}", index ${i})`,
          });
        }
        seenCodes.add(codeTrim);
      }
    }

    const template = await this.prisma.template.create({
      data: {
        code: body.code || `TPL-${Date.now()}`,
        name: body.name,
        type: body.type || 'task_list',
        category: body.category || null,
        description: body.description || null,
        phaseId: body.phaseId || null,
        // QA3 follow-up: default zoneType tag applied when this
        // template is referenced from another template or a project.
        // Empty string treated as null so the form's "no default"
        // option round-trips cleanly.
        defaultZoneType: body.defaultZoneType || null,
        createdBy: userId,
      },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
        phase: true,
      },
    });

    // If tasks are provided inline, create them
    if (body.tasks && Array.isArray(body.tasks)) {
      for (let i = 0; i < body.tasks.length; i++) {
        const t = body.tasks[i];
        // QA4 · DN-2 (2026-10-04) — pass the Deliverable Template FK
        // through from the inline body; if the body carries only the
        // legacy `[SERVICE:<name>]` marker, resolve the FK server-side
        // so new rows never land with null FK + marker.
        const deliverableTemplateId =
          t.deliverableTemplateId
          ?? (await this.resolveDeliverableTemplateByMarker(t.description, t.phaseId ?? null));
        // DN-ext (2026-10-22) — same catalog FK passthrough as
        // `addTask`. Keeps the `POST /templates { tasks: [...] }`
        // bulk-create path consistent with the per-task picker.
        const rawCatalogTaskId = t.catalogTaskId ?? t.sourceCatalogTaskId;
        const catalogTaskId =
          rawCatalogTaskId == null || rawCatalogTaskId === ''
            ? null
            : Number.isFinite(Number(rawCatalogTaskId))
              ? Number(rawCatalogTaskId)
              : null;
        await this.prisma.templateTask.create({
          data: {
            templateId: template.id,
            serviceTypeId: t.serviceTypeId || null,
            deliverableTemplateId,
            catalogTaskId,
            code: t.code,
            name: t.name,
            description: t.description || null,
            defaultBudgetHours: t.defaultBudgetHours || null,
            defaultBudgetAmount: t.defaultBudgetAmount || null,
            defaultPriority: t.defaultPriority || 'medium',
            phaseId: t.phaseId || null,
            sortOrder: t.sortOrder ?? i,
          },
        });
      }
    }

    return this.findOne(template.id);
  }

  async findOne(id: number) {
    // QA4 B1 follow-up (2026-09-29) — every `templateTasks`/`templateZoneTasks`
    // include now surfaces the `deliverableTemplate` relation so the FE
    // can display the deliverable's CURRENT name (post-rename), instead
    // of the frozen `[SERVICE:<name>]` marker baked into `description`.
    // Without this include, a renamed deliverable causes the SERVICE
    // column in the zone editor to render blank (the marker holds a stale
    // name; the marker-only display path had no way to look up the FK
    // target). B1's write + apply paths already prefer the FK; this
    // completes the read side.
    const deliverableSelect = { id: true, name: true, code: true } as const;
    // DN-ext (2026-10-22) — the catalog source TemplateTask whose
    // name + budget values we resolve LIVE at serialization time.
    // Carries `id` for FE "is this linked?" checks + `code` for the
    // backfill audit trail; the override below only reads name +
    // hours + amount. Shape intentionally kept minimal.
    const catalogTaskSelect = {
      id: true,
      code: true,
      name: true,
      defaultBudgetHours: true,
      defaultBudgetAmount: true,
    } as const;
    // P1 · Reference model (2026-11-10) — every `TemplateZone` with a
    // `linkedTaskTemplateId` (a deliverable-slot) now surfaces the
    // linked deliverable's tasks + predecessor graph so the editor can
    // render them as a read-only nested list under the slot. This is
    // the FE affordance behind DoD "editing predecessors in 41
    // reflects in every referencing template's editor" — the same
    // include shape runs through every nesting level below (root
    // zones, children, nested children). We keep this as `select` (not
    // `include`) so the payload stays flat and we avoid pulling the
    // deliverable's own zones through the ref (which would recurse
    // uselessly for this read path). Nested `predecessors` carry the
    // same `{id,code,name}` shape the composing template's own task
    // predecessors use, so the FE renderer is identical.
    const linkedTaskTemplateSelect = {
      id: true,
      name: true,
      code: true,
      templateTasks: {
        select: {
          id: true,
          code: true,
          name: true,
          sortOrder: true,
          defaultBudgetHours: true,
          defaultBudgetAmount: true,
          predecessors: {
            select: {
              dependsOnTemplateTaskId: true,
              lag: true,
              lagUnit: true,
              reason: true,
              dependsOnTemplateTask: {
                select: { id: true, code: true, name: true },
              },
            },
            orderBy: { id: 'asc' as const },
          },
        },
        orderBy: { sortOrder: 'asc' as const },
      },
    } as const;
    const template = await this.prisma.template.findFirst({
      where: { id, deletedAt: null },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
        phase: true,
        templateTasks: {
          include: {
            serviceType: true,
            phase: true,
            deliverableTemplate: { select: deliverableSelect },
            catalogTask: { select: catalogTaskSelect },
            // T1-2 (2026-10-20) — surface the template-task predecessor
            // graph so the FE can render chips without a per-row round
            // trip. `dependsOnTemplateTask` carries just the id/name so
            // the chip label is self-contained.
            predecessors: {
              include: {
                dependsOnTemplateTask: { select: { id: true, name: true, code: true } },
              },
              orderBy: { id: 'asc' },
            },
          },
          orderBy: { sortOrder: 'asc' },
        },
        templateZones: {
          include: {
            children: {
              include: {
                linkedTaskTemplate: { select: linkedTaskTemplateSelect },
                referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
                templateZoneTasks: {
                  include: {
                    serviceType: true,
                    phase: true,
                    deliverableTemplate: { select: deliverableSelect },
                    catalogTask: { select: catalogTaskSelect },
                  },
                },
                children: {
                  include: {
                    linkedTaskTemplate: { select: linkedTaskTemplateSelect },
                    referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
                    templateZoneTasks: {
                      include: {
                        serviceType: true,
                        phase: true,
                        deliverableTemplate: { select: deliverableSelect },
                        catalogTask: { select: catalogTaskSelect },
                      },
                    },
                  },
                },
              },
            },
            linkedTaskTemplate: { select: linkedTaskTemplateSelect },
            referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
            templateZoneTasks: {
              include: {
                serviceType: true,
                phase: true,
                deliverableTemplate: { select: deliverableSelect },
                catalogTask: { select: catalogTaskSelect },
              },
            },
          },
          where: { parentId: null },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    if (!template) throw new NotFoundException('Template not found');

    // DN-ext (2026-10-22) — resolve name + default budget LIVE from the
    // catalog so a rename in Task Catalog reaches every Deliverable /
    // Zone Template that referenced the catalog row. Local `name`,
    // `defaultBudgetHours`, `defaultBudgetAmount` columns stay in place
    // as a snapshot fallback (used when `catalogTask` is NULL — ad-hoc
    // row — or when the catalog row was deleted and `onDelete: SetNull`
    // nulled this FK). We keep `catalogTask` on the payload so the FE
    // can tell whether to render the name as read-only (linked) or
    // editable (ad-hoc), and so audits can see which source the value
    // came from. This handles only the output shape; the write-side
    // guard that forbids editing name/hours when the row is linked
    // lives on `updateTask`.
    const resolved = resolveCatalogLiveFields(template) as any;

    // bm2 (2026-10-28) — same fastest + slowest working-days rollup
    // the list page shows, re-computed on the detail payload so the
    // header stat line stays in sync with the task table immediately
    // after the resolve-live pass. Deliberately uses the
    // just-resolved `defaultBudgetHours` so an unlinked (ad-hoc)
    // task's local snapshot still counts.
    let fastestWorkingDays: number | null = null;
    let slowestWorkingDays: number | null = null;
    if (resolved.type === 'task_list') {
      const rawTasks = (resolved.templateTasks ?? []) as any[];
      const tasks: SwdTask[] = rawTasks.map((row) => ({
        id: row.id,
        budgetHours: row.defaultBudgetHours != null ? Number(row.defaultBudgetHours) : null,
      }));
      const edges: SwdEdge[] = rawTasks.flatMap((row) =>
        (row.predecessors ?? []).map((p: any) => ({
          templateTaskId: row.id,
          dependsOnTemplateTaskId: p.dependsOnTemplateTaskId,
          lag: p.lag,
          lagUnit: p.lagUnit,
        })),
      );
      fastestWorkingDays = computeFastestWorkingDays(tasks, edges);
      slowestWorkingDays = computeSlowestWorkingDays(tasks, edges);
    }

    // P1 · Reference model (2026-11-10) — "Used by N templates".
    // Counts every `TemplateZone` that references THIS template as its
    // `linkedTaskTemplateId` (i.e. every composing template that has
    // this deliverable as a zone-slot). Only meaningful for
    // `task_list` templates — composing templates aren't themselves
    // referenced through `linkedTaskTemplateId`, so the field stays
    // `undefined` for them to keep the response surface honest.
    //
    // Backed by the `template_zones_linked_task_template_id_idx`
    // added in the 2026-11-10 migration — one bounded index seek per
    // detail fetch. Kept outside the main include so we don't force
    // Prisma into an N+1 shape on the detail response.
    let usedByTemplatesCount: number | undefined;
    if (resolved.type === 'task_list') {
      usedByTemplatesCount = await this.prisma.templateZone.count({
        where: { linkedTaskTemplateId: id },
      });
    }

    return { ...resolved, fastestWorkingDays, slowestWorkingDays, usedByTemplatesCount };
  }

  async update(id: number, body: any) {
    await this.findOne(id);
    return this.prisma.template.update({
      where: { id },
      data: {
        name: body.name,
        code: body.code,
        category: body.category,
        description: body.description,
        isActive: body.isActive,
        phaseId: body.phaseId !== undefined ? (body.phaseId || null) : undefined,
        // QA3 follow-up: allow editing the default zoneType. undefined
        // leaves the field alone; '' from the "— No default —" option
        // sets it back to null so the template stops carrying a type.
        defaultZoneType: body.defaultZoneType !== undefined ? (body.defaultZoneType || null) : undefined,
      },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
        phase: true,
      },
    });
  }

  async remove(id: number) {
    const template = await this.findOne(id);
    // PR-053 — delete only an unused template. "Used" is wider than the
    // old `usageCount > 0`: a template a project deliverable / task or
    // another template points at can't be deleted either (that left the
    // reference dangling). The answer is a 409 with a stable code; the
    // way out is Archive.
    const usage = (await this.getUsage([template])).get(id)!;
    if (usage.inUse) {
      throw new ConflictException({
        code: 'TEMPLATE_IN_USE',
        message: `"${template.name}" is in use (${describeTemplateUsage(usage)}). Archive it instead of deleting it.`,
        details: { templateId: id, ...usage },
      });
    }
    await this.prisma.template.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { message: 'Template deleted' };
  }

  async addTask(templateId: number, body: any) {
    await this.findOne(templateId);
    // bm2 (2026-10-28) — Code required + unique within the template.
    //  • Required: the Prisma schema has `code VARCHAR(50) NOT NULL`,
    //    so `undefined` used to surface as a raw P2012 500. We
    //    short-circuit here with a friendly 400 instead.
    //  • Unique within template: no DB `@@unique([templateId,code])`
    //    yet (staging has pre-existing duplicates we need to clean
    //    first — TODO(dedup migration)). Service-level check closes
    //    the window for NEW rows so cleanup starts from a stable
    //    baseline. Trimmed form is the source of truth so trailing
    //    whitespace can't bypass the guard.
    const codeTrim = String(body.code ?? '').trim();
    if (!codeTrim) {
      throw new BadRequestException({
        code: 'TEMPLATE_TASK_CODE_REQUIRED',
        message: 'Code is required for a template task',
      });
    }
    const dup = await this.prisma.templateTask.findFirst({
      where: { templateId, code: codeTrim },
      select: { id: true, name: true },
    });
    if (dup) {
      throw new BadRequestException({
        code: 'TEMPLATE_TASK_CODE_DUPLICATE',
        message: `Code "${codeTrim}" already exists in this template`,
      });
    }
    const maxOrder = await this.prisma.templateTask.aggregate({
      where: { templateId },
      _max: { sortOrder: true },
    });
    // QA4 · B1 (2026-09-28) — accept the deliverable FK from the
    // pickers. Optional (some callers still write only the marker);
    // when both come in, this is the source of truth going forward.
    // QA4 · DN-2 (2026-10-04) — if the caller sent only the legacy
    // `[SERVICE:<name>]` marker (no FK), resolve the FK server-side
    // so new rows never land as null-FK + stale-marker (the exact
    // shape DN-1 had to clean up on staging).
    const deliverableTemplateId =
      body.deliverableTemplateId
      ?? (await this.resolveDeliverableTemplateByMarker(body.description, body.phaseId ?? null));
    // DN-ext (2026-10-22) — the "Pick from Catalog" + "Add Task +
    // Also add to catalog" FE flows now pass through the catalog
    // TemplateTask id as `catalogTaskId` (or the legacy alias
    // `sourceCatalogTaskId`). Still copies name/hours as a snapshot
    // (safety fallback for when the catalog row is later deleted
    // and the FK goes NULL via `onDelete: SetNull`). We DO NOT
    // validate the id here beyond type-coercion: the DB FK does the
    // existence check atomically and an invalid id surfaces as a
    // Prisma P2003 that the caller can retry.
    const rawCatalogTaskId = body.catalogTaskId ?? body.sourceCatalogTaskId;
    const catalogTaskId =
      rawCatalogTaskId == null || rawCatalogTaskId === ''
        ? null
        : Number.isFinite(Number(rawCatalogTaskId))
          ? Number(rawCatalogTaskId)
          : null;
    return this.prisma.templateTask.create({
      data: {
        templateId,
        serviceTypeId: body.serviceTypeId || null,
        deliverableTemplateId,
        catalogTaskId,
        // Store the trimmed code so the duplicate check above and the
        // persisted value stay in sync — a user typing "BIM-012 " and
        // the next one typing "BIM-012" would otherwise both land.
        code: codeTrim,
        name: body.name,
        description: body.description || null,
        defaultBudgetHours: body.defaultBudgetHours || null,
        defaultBudgetAmount: body.defaultBudgetAmount || null,
        defaultPriority: body.defaultPriority || 'medium',
        phaseId: body.phaseId || null,
        sortOrder: body.sortOrder ?? (maxOrder._max.sortOrder ?? 0) + 1,
      },
      include: { serviceType: true, phase: true },
    });
  }

  /** Stored price — the write-side finance check compares against it. */
  async getTaskMoneySnapshot(taskId: number): Promise<{ defaultBudgetAmount: unknown } | null> {
    return this.prisma.templateTask.findUnique({
      where: { id: taskId },
      select: { defaultBudgetAmount: true },
    });
  }

  async updateTask(taskId: number, body: any) {
    // DN-ext (2026-10-22) — name + default budget are READ-ONLY on
    // template tasks that are linked to a catalog TemplateTask
    // (`catalogTaskId != null`). Those live under the Task Catalog
    // page; the Deliverable Template editor must only edit
    // sortOrder, predecessors + delete. We check the fields the
    // CALLER passed (own-prop check so an explicit `name: undefined`
    // never trips the guard — Prisma already treats `undefined` as
    // "skip this field"), so a sortOrder-only PATCH from an editor
    // row that happens to be linked still saves.
    //
    // The guard runs ONLY when the caller actually touches one of
    // these fields with a non-undefined value AND the row is
    // catalog-linked. Catalog rows themselves have
    // `catalogTaskId = null`, so edits from the Task Catalog page
    // keep the full edit surface. Explicitly setting
    // `catalogTaskId: null` (unlink) is allowed and clears the
    // guard for subsequent name/hours edits in the same request.
    const touchedReadonly = CATALOG_LINKED_READONLY_FIELDS.filter(
      (f) => Object.prototype.hasOwnProperty.call(body, f) && body[f] !== undefined,
    );
    // bm2 (2026-10-28) — Code validation: only runs when the caller
    // actually sends a `code` field. `undefined` means "don't touch
    // the code" (Prisma skips the field entirely), which lets
    // sortOrder-only / description-only PATCHes keep working without
    // re-querying siblings. When code IS sent, we require it and
    // reject siblings that already own that code.
    const touchingCode = Object.prototype.hasOwnProperty.call(body, 'code') && body.code !== undefined;
    let codeTrim: string | null = null;
    if (touchingCode) {
      codeTrim = String(body.code ?? '').trim();
      if (!codeTrim) {
        throw new BadRequestException({
          code: 'TEMPLATE_TASK_CODE_REQUIRED',
          message: 'Code is required for a template task',
        });
      }
    }
    if (touchedReadonly.length > 0 || touchingCode) {
      const existing = await this.prisma.templateTask.findUnique({
        where: { id: taskId },
        select: { id: true, catalogTaskId: true, templateId: true },
      });
      if (!existing) throw new NotFoundException('Template task not found');
      if (touchedReadonly.length > 0 && existing.catalogTaskId != null) {
        throw new BadRequestException(
          `Fields ${touchedReadonly.join(', ')} are read-only on tasks linked to a catalog entry — edit the task in the Task Catalog instead.`,
        );
      }
      if (touchingCode && codeTrim) {
        // Sibling-uniqueness within the same template, excluding self
        // so a no-op rename (same value as current) succeeds.
        //   TODO(dedup migration): once staging duplicates are cleaned,
        //   add `@@unique([templateId, code])` on TemplateTask so the
        //   DB enforces this at the storage layer too.
        const dup = await this.prisma.templateTask.findFirst({
          where: { templateId: existing.templateId, code: codeTrim, id: { not: taskId } },
          select: { id: true },
        });
        if (dup) {
          throw new BadRequestException({
            code: 'TEMPLATE_TASK_CODE_DUPLICATE',
            message: `Code "${codeTrim}" already exists in this template`,
          });
        }
      }
    }
    return this.prisma.templateTask.update({
      where: { id: taskId },
      data: {
        serviceTypeId: body.serviceTypeId,
        // QA4 · B1 — allow a later PATCH to correct or clear the link.
        // `undefined` skips the field entirely (Prisma treats it as
        // "not part of the update"), so legacy callers stay unaffected.
        deliverableTemplateId: body.deliverableTemplateId,
        // DN-ext — allow unlinking from the catalog by sending
        // `catalogTaskId: null` (or re-link by sending a new id).
        // The guard above only trips on name/hours edits of an
        // already-linked row, so a client that wants to override a
        // name must first unlink the row with a dedicated PATCH.
        catalogTaskId: body.catalogTaskId,
        // Use the trimmed form when the caller sent a code, so the
        // persisted value matches what the duplicate-check compared.
        code: touchingCode ? codeTrim ?? undefined : undefined,
        name: body.name,
        description: body.description,
        defaultBudgetHours: body.defaultBudgetHours,
        defaultBudgetAmount: body.defaultBudgetAmount,
        defaultPriority: body.defaultPriority,
        phaseId: body.phaseId,
        sortOrder: body.sortOrder,
      },
      include: { serviceType: true, phase: true },
    });
  }

  async removeTask(taskId: number) {
    await this.prisma.templateTask.delete({ where: { id: taskId } });
    return { message: 'Template task removed' };
  }

  // ─── T1-2 · Order + Predecessors (2026-10-20) ───────────────────
  //
  // Reorder every TemplateTask inside a template to a user-chosen
  // sequence, renumbering `sortOrder` to 10, 20, 30… so individual
  // inline edits don't force cascading renumbers later. One tx so a
  // partial reorder can't leave the template in a split state.
  //
  // The caller sends the FULL ordered list of taskIds for the
  // template; any id that doesn't belong to this template is rejected
  // (prevents a stale FE from reordering tasks across templates).
  async reorderTasks(templateId: number, orderedTaskIds: number[]) {
    const existing = await this.prisma.templateTask.findMany({
      where: { templateId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((t) => t.id));
    for (const id of orderedTaskIds) {
      if (!existingIds.has(id)) {
        throw new BadRequestException(`Task ${id} does not belong to template ${templateId}`);
      }
    }
    await this.prisma.$transaction(
      orderedTaskIds.map((id, i) =>
        this.prisma.templateTask.update({
          where: { id },
          data: { sortOrder: (i + 1) * 10 },
        }),
      ),
    );
    return { message: 'Template tasks reordered', count: orderedTaskIds.length };
  }

  // List this task's predecessors — small enough that the FE just
  // reads them off the parent template fetch, but the explicit
  // endpoint is handy for optimistic replacement + verification.
  async getTaskPredecessors(taskId: number) {
    const task = await this.prisma.templateTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Template task not found');
    return this.prisma.templateTaskDependency.findMany({
      where: { templateTaskId: taskId },
      include: {
        dependsOnTemplateTask: { select: { id: true, name: true, code: true } },
      },
      orderBy: { id: 'asc' },
    });
  }

  // Replace the whole predecessor set for a TemplateTask in one call.
  // Guards:
  //   • self-dependency (p === taskId) — rejected inline.
  //   • cross-template edges (p's template != this task's template) —
  //     rejected inline.
  //   • cycle detection — DFS over the proposed graph; if adding any
  //     of the new edges would make `taskId` reachable from itself,
  //     reject with the offending path for debugging.
  //
  // bm2 2026-10-21 — AUTO-REORDER: after the dep write, if the task's
  // current `sortOrder` is <= max(predecessor.sortOrder), bump it to
  // max + 1 and shift the siblings whose sortOrder sat in the vacated
  // range DOWN by 1 so the sequence stays contiguous. A predecessor
  // must schedule BEFORE its dependent, so this is the only way to
  // keep the invariant without blocking the user's save. The whole
  // thing (delete + create + reorder) runs inside one interactive
  // transaction so a partial failure can't leave the template split.
  //
  // Response shape (breaking from the previous flat array; the FE
  // discards the body and re-fetches, so moving to the richer shape
  // is safe):
  //   { predecessors: TemplateTaskDependency[], autoReorder?: {oldOrder, newOrder} }
  //
  // T1-Lag (2026-11-03) — input is now a richer per-edge shape so each
  // predecessor can carry `lag`, `lagUnit`, `reason`. The controller
  // accepts both the new `{predecessors: [{id,lag?,lagUnit?,reason?}]}`
  // and the legacy `{predecessorIds: number[]}` shapes and normalizes
  // the legacy one to the new one with defaults before calling here,
  // so we only have one code path to maintain.
  async setTaskPredecessors(
    taskId: number,
    proposedPreds: Array<{
      id: number;
      lag?: number;
      lagUnit?: 'WORKING_DAYS' | 'CALENDAR_DAYS';
      reason?: string | null;
    }>,
  ) {
    const task = await this.prisma.templateTask.findUnique({
      where: { id: taskId },
      select: { id: true, templateId: true, sortOrder: true },
    });
    if (!task) throw new NotFoundException('Template task not found');

    // T1-Lag — normalize into a validated, deduped list keyed by id.
    // Validation (per the spec): lag in [0..365], lagUnit ∈ enum,
    // reason trimmed to 255 chars (null when empty). Duplicate ids
    // in the payload → 400 (keeps the FE honest; "two edges to the
    // same predecessor" has no semantic meaning).
    const normalized: Array<{
      id: number;
      lag: number;
      lagUnit: 'WORKING_DAYS' | 'CALENDAR_DAYS';
      reason: string | null;
    }> = [];
    const seen = new Set<number>();
    for (const p of proposedPreds ?? []) {
      const pid = Number(p?.id);
      if (!Number.isFinite(pid)) continue;
      if (seen.has(pid)) {
        throw new BadRequestException(`Duplicate predecessor id ${pid}`);
      }
      seen.add(pid);
      const lag = Math.floor(Number(p.lag ?? 0));
      if (!Number.isFinite(lag) || lag < 0) {
        throw new BadRequestException(`Lag must be a non-negative integer (got ${p.lag})`);
      }
      if (lag > 365) {
        throw new BadRequestException(`Lag must be <= 365 (got ${lag})`);
      }
      const lagUnit = p.lagUnit ?? 'WORKING_DAYS';
      if (lagUnit !== 'WORKING_DAYS' && lagUnit !== 'CALENDAR_DAYS') {
        throw new BadRequestException(`Invalid lagUnit: ${lagUnit}`);
      }
      const rawReason = typeof p.reason === 'string' ? p.reason.trim() : '';
      const reason = rawReason ? rawReason.slice(0, 255) : null;
      normalized.push({ id: pid, lag, lagUnit, reason });
    }
    const proposed = normalized.map((p) => p.id);
    if (proposed.includes(taskId)) {
      throw new BadRequestException('A task cannot depend on itself');
    }
    let predecessorRows: Array<{ id: number; templateId: number; sortOrder: number }> = [];
    if (proposed.length > 0) {
      predecessorRows = await this.prisma.templateTask.findMany({
        where: { id: { in: proposed } },
        select: { id: true, templateId: true, sortOrder: true },
      });
      if (predecessorRows.length !== proposed.length) {
        throw new BadRequestException('One or more predecessor tasks do not exist');
      }
      for (const s of predecessorRows) {
        if (s.templateId !== task.templateId) {
          throw new BadRequestException(
            `Predecessor task ${s.id} belongs to a different template`,
          );
        }
      }
    }

    // Build the proposed graph: existing deps for every other task in
    // the template + the new set for THIS task. If a DFS starting from
    // `taskId` can reach `taskId`, there is a cycle.
    const otherDeps = await this.prisma.templateTaskDependency.findMany({
      where: {
        templateTask: { templateId: task.templateId },
        NOT: { templateTaskId: taskId },
      },
      select: { templateTaskId: true, dependsOnTemplateTaskId: true },
    });
    const adj = new Map<number, number[]>();
    const push = (from: number, to: number) => {
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from)!.push(to);
    };
    for (const d of otherDeps) push(d.templateTaskId, d.dependsOnTemplateTaskId);
    for (const p of proposed) push(taskId, p);

    // DFS from taskId; a path back to taskId = cycle. We track the
    // actual path so the error is debuggable, not just "there is a cycle".
    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const color = new Map<number, number>();
    const path: number[] = [];
    const detect = (node: number): number[] | null => {
      color.set(node, GREY);
      path.push(node);
      for (const next of adj.get(node) ?? []) {
        if (color.get(next) === GREY) {
          // Found a cycle. Trim the path to the loop section.
          const start = path.indexOf(next);
          return path.slice(start).concat(next);
        }
        if (color.get(next) === WHITE || color.get(next) === undefined) {
          const found = detect(next);
          if (found) return found;
        }
      }
      path.pop();
      color.set(node, BLACK);
      return null;
    };
    const cycle = detect(taskId);
    if (cycle) {
      throw new BadRequestException(`Dependency cycle detected: ${cycle.join(' → ')}`);
    }

    // bm2 2026-10-21 — compute the sortOrder bump BEFORE the tx so the
    // numbers we shift are from the pre-write snapshot (predecessorRows
    // was selected above with the same sortOrder values we're about to
    // compare against). Interactive $transaction so the cycle guard +
    // dep write + reorder are atomic end-to-end.
    const maxPredOrder = predecessorRows.length
      ? Math.max(...predecessorRows.map((p) => p.sortOrder))
      : -1;
    let autoReorder: { oldOrder: number; newOrder: number } | null = null;

    await this.prisma.$transaction(async (tx) => {
      // Replace the dependency set.
      await tx.templateTaskDependency.deleteMany({
        where: { templateTaskId: taskId },
      });
      if (normalized.length > 0) {
        // T1-Lag — persist per-edge lag/lagUnit/reason alongside the FK.
        await tx.templateTaskDependency.createMany({
          data: normalized.map((p) => ({
            templateTaskId: taskId,
            dependsOnTemplateTaskId: p.id,
            lag: p.lag,
            lagUnit: p.lagUnit,
            reason: p.reason,
          })),
        });
      }

      // Auto-reorder: if the current task's sortOrder is at or below
      // ANY predecessor's, bump it past the max. Shift the siblings in
      // (oldOrder, newOrder] DOWN by 1 to fill the vacated slot without
      // colliding on the UNIQUE check that `reorderTasks` relies on.
      if (maxPredOrder >= 0 && task.sortOrder <= maxPredOrder) {
        const oldOrder = task.sortOrder;
        const newOrder = maxPredOrder + 1;
        await tx.templateTask.updateMany({
          where: {
            templateId: task.templateId,
            id: { not: taskId },
            sortOrder: { gt: oldOrder, lte: newOrder },
          },
          data: { sortOrder: { decrement: 1 } },
        });
        await tx.templateTask.update({
          where: { id: taskId },
          data: { sortOrder: newOrder },
        });
        autoReorder = { oldOrder, newOrder };
      }
    });

    const predecessors = await this.prisma.templateTaskDependency.findMany({
      where: { templateTaskId: taskId },
      include: {
        dependsOnTemplateTask: { select: { id: true, name: true, code: true } },
      },
      orderBy: { id: 'asc' },
    });
    return { predecessors, autoReorder };
  }

  /**
   * POST /templates/:id/zones.
   *
   * QA6 (2026-11-25) · `POST /templates/45/zones` answered 500 on 22.11
   * (staging log: `Invalid value for argument zoneType. Expected
   * ZoneType.`, body `{ name: "Basment", zoneType: "zone" }`). The Zone
   * Template editor's "Add Zone (choose type)" form starts on the legacy
   * code `'zone'` and the "Copy from Template" picker falls back to it;
   * `template_zones.zone_type` only holds the `ZoneType` enum (site /
   * building / level / wing), and the raw value went to Prisma, whose
   * validation error is not an HttpException. Same hole §12 closed on
   * `POST /zones`; the same normaliser is reused here (`zone` →
   * `building`, `floor` → `level`, `area` → `site`, `section` → `wing`),
   * so that request now succeeds as a Building zone. Every other bad
   * input is a 4xx with a stable code before anything is written (see
   * `validateTemplateZoneInput`), and a Prisma error that still slips
   * through is mapped to a 400 / 404 instead of a 500.
   */
  async addZone(templateId: number, body: any) {
    await this.findOne(templateId); // verify template exists
    const input = await this.validateTemplateZoneInput(templateId, body ?? {}, { mode: 'create' });
    const maxOrder = await this.prisma.templateZone.aggregate({
      where: { templateId, parentId: input.parentId ?? null },
      _max: { sortOrder: true },
    });
    try {
      return await this.prisma.templateZone.create({
        data: {
          templateId,
          parentId: input.parentId ?? null,
          zoneType: input.zoneType ?? 'building',
          name: input.name!,
          code: input.code ?? null,
          isTypical: input.isTypical ?? false,
          typicalCount: input.typicalCount ?? 1,
          // Composition multiplicity — clamp to >=1 so a malformed body can't
          // mean "0 instances" (which would silently drop the zone at apply).
          instanceCount: input.instanceCount ?? 1,
          sortOrder: input.sortOrder ?? (maxOrder._max.sortOrder ?? 0) + 1,
          linkedTaskTemplateId: input.linkedTaskTemplateId ?? null,
          referencedTemplateId: input.referencedTemplateId ?? null,
        },
        include: {
          linkedTaskTemplate: { select: { id: true, name: true, code: true } },
          referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
        },
      });
    } catch (err) {
      throw mapTemplateZoneWriteError(err);
    }
  }

  /**
   * QA6 · input checks shared by `addZone` (create) and `updateZone`
   * (patch: only the fields that were sent). Throws a 4xx with an
   * UPPER_SNAKE code; returns the cleaned values.
   */
  private async validateTemplateZoneInput(
    templateId: number,
    body: Record<string, any>,
    opts: {
      mode: 'create' | 'update';
      current?: { referencedTemplateId: number | null; linkedTaskTemplateId: number | null };
    },
  ): Promise<TemplateZoneInput> {
    const out: TemplateZoneInput = {};
    const has = (k: string) => opts.mode === 'create' || body[k] !== undefined;

    if (has('name')) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        throw new BadRequestException({ code: 'TEMPLATE_ZONE_NAME_REQUIRED', message: 'Zone name is required.' });
      }
      if (name.length > 255) {
        throw new BadRequestException({
          code: 'TEMPLATE_ZONE_NAME_TOO_LONG',
          message: 'Zone name can be up to 255 characters.',
        });
      }
      out.name = name;
    }

    if (body.code !== undefined) {
      const code = body.code == null ? '' : String(body.code).trim();
      if (code.length > 50) {
        throw new BadRequestException({
          code: 'TEMPLATE_ZONE_CODE_TOO_LONG',
          message: 'Zone code can be up to 50 characters.',
        });
      }
      out.code = code || null;
    }

    if (body.zoneType !== undefined) {
      const zt = normalizeZoneType(body.zoneType);
      if (zt !== undefined) {
        if (typeof zt !== 'string' || !(ZONE_TYPE_VALUES as string[]).includes(zt)) {
          throw new BadRequestException({
            code: 'TEMPLATE_ZONE_TYPE_INVALID',
            message: `zoneType must be one of: ${ZONE_TYPE_VALUES.join(', ')}.`,
            details: { zoneType: body.zoneType, allowed: ZONE_TYPE_VALUES },
          });
        }
        out.zoneType = zt as ZoneType;
      }
    }

    if (body.isTypical !== undefined) out.isTypical = body.isTypical === true || body.isTypical === 'true';

    // 0 / '' / null keep the old `|| 1` meaning: the default.
    if (body.typicalCount !== undefined && body.typicalCount !== null && body.typicalCount !== '' && body.typicalCount !== 0) {
      out.typicalCount = positiveIntOrThrow(body.typicalCount, 'typicalCount');
    }
    if (body.instanceCount !== undefined) {
      out.instanceCount = Math.max(1, Math.floor(Number(body.instanceCount)) || 1);
    }
    if (body.sortOrder !== undefined && body.sortOrder !== null && body.sortOrder !== '') {
      const n = Number(body.sortOrder);
      if (!Number.isInteger(n)) {
        throw new BadRequestException({
          code: 'TEMPLATE_ZONE_SORT_ORDER_INVALID',
          message: 'sortOrder must be a whole number.',
        });
      }
      out.sortOrder = n;
    }

    // Parent: a zone of THIS template (create only; a zone is not moved
    // through PATCH). A missing parent used to be a foreign-key 500, a
    // parent of another template was silently accepted.
    if (opts.mode === 'create') {
      const parentId = optionalIdOrThrow(body.parentId, 'parentId', 'TEMPLATE_ZONE_PARENT_INVALID');
      if (parentId != null) {
        const parent = await this.prisma.templateZone.findUnique({
          where: { id: parentId },
          select: { id: true, templateId: true },
        });
        if (!parent || parent.templateId !== templateId) {
          throw new BadRequestException({
            code: 'TEMPLATE_ZONE_PARENT_MISMATCH',
            message: `Parent zone #${parentId} does not belong to template #${templateId}.`,
            details: { parentId, templateId },
          });
        }
      }
      out.parentId = parentId;
    }

    // References. `null` on PATCH clears one; a new id must be an active
    // template (PR-053), a zone reference must not point back at this
    // template (directly or through the templates it references), and a
    // deliverable slot must be a Deliverable (task_list) template.
    if (body.referencedTemplateId !== undefined) {
      const refId = optionalIdOrThrow(body.referencedTemplateId, 'referencedTemplateId', 'TEMPLATE_ZONE_REFERENCE_INVALID');
      if (refId != null && refId !== opts.current?.referencedTemplateId) {
        if (refId === templateId) {
          throw new BadRequestException({
            code: 'TEMPLATE_ZONE_SELF_REFERENCE',
            message: 'A template cannot reference itself.',
          });
        }
        await this.assertPickableTemplate(refId, 'referencedTemplateId');
        if (await this.referencesTemplate(refId, templateId)) {
          throw new BadRequestException({
            code: 'TEMPLATE_ZONE_REFERENCE_CYCLE',
            message: `Template #${refId} already references this template, directly or through another template.`,
            details: { referencedTemplateId: refId, templateId },
          });
        }
      }
      out.referencedTemplateId = refId;
    }
    if (body.linkedTaskTemplateId !== undefined) {
      const linkedId = optionalIdOrThrow(body.linkedTaskTemplateId, 'linkedTaskTemplateId', 'TEMPLATE_ZONE_LINK_INVALID');
      if (linkedId != null && linkedId !== opts.current?.linkedTaskTemplateId) {
        const linked = await this.assertPickableTemplate(linkedId, 'linkedTaskTemplateId');
        if (linked.type !== 'task_list') {
          throw new BadRequestException({
            code: 'TEMPLATE_ZONE_LINK_WRONG_TYPE',
            message: `Template #${linkedId} is not a Deliverable template.`,
            details: { linkedTaskTemplateId: linkedId, type: linked.type },
          });
        }
      }
      out.linkedTaskTemplateId = linkedId;
    }
    return out;
  }

  /**
   * QA6 · true when `fromTemplateId` reaches `targetId` through zone
   * references (`TemplateZone.referencedTemplateId`), i.e. adding
   * "target → from" would close a cycle. Breadth-first, one query per
   * level, bounded.
   */
  private async referencesTemplate(fromTemplateId: number, targetId: number): Promise<boolean> {
    const seen = new Set<number>([fromTemplateId]);
    let frontier = [fromTemplateId];
    for (let level = 0; level < 50 && frontier.length > 0; level++) {
      const rows = await this.prisma.templateZone.findMany({
        where: { templateId: { in: frontier }, referencedTemplateId: { not: null } },
        select: { referencedTemplateId: true },
      });
      const next: number[] = [];
      for (const r of rows) {
        const id = r.referencedTemplateId!;
        if (id === targetId) return true;
        if (!seen.has(id)) {
          seen.add(id);
          next.push(id);
        }
      }
      frontier = next;
    }
    return false;
  }

  // ─── P1 · Reference model (2026-11-10) ──────────────────────────────
  //
  // "+ Add Deliverable" in the composing template editors becomes a
  // reference instead of a copy. One TemplateZone row with
  // `linkedTaskTemplateId=<deliverable id>` ("deliverable slot") stands
  // in for the deliverable's full task+predecessor graph — the
  // apply-side pipeline (`zones.applyProjectTemplate` + `materializeDeps`)
  // already materializes those tasks and their `TaskDependency` edges
  // from `linkedTaskTemplate.templateTasks`.
  //
  // The underlying write is the same shape `addZone()` emits (so the
  // FE doesn't need to special-case the response). The "slot" gets the
  // most-neutral existing zoneType — `building`, matching `addZone()`'s
  // default (templates.service.ts §addZone) — rather than introducing a
  // new enum value for "slot".
  //
  // Validation:
  //   • `deliverableTemplateId` must exist and have `type = 'task_list'`
  //     (the deliverable-template convention, used throughout the
  //     service for list/detail filtering). A non-task_list target is a
  //     400, not a 404, so an FE drift can't silently drop the ref.
  //   • `parentZoneId`, if given, must belong to the same templateId —
  //     prevents a stale FE from attaching a slot to a sibling
  //     template's zone.
  //   • Name defaults to the referenced template's `name` so the slot
  //     reads naturally in the composing template's tree; the caller
  //     may override.
  async addDeliverableRef(
    templateId: number,
    body: {
      deliverableTemplateId?: number | string;
      parentZoneId?: number | string | null;
      sortOrder?: number | string;
      name?: string;
    },
  ) {
    await this.findOne(templateId); // verify composing template exists

    const deliverableIdRaw = body?.deliverableTemplateId;
    const deliverableId =
      deliverableIdRaw == null || deliverableIdRaw === ''
        ? NaN
        : Number(deliverableIdRaw);
    if (!Number.isFinite(deliverableId) || deliverableId <= 0) {
      throw new BadRequestException({
        code: 'DELIVERABLE_REF_ID_REQUIRED',
        message: 'deliverableTemplateId is required and must be a positive integer.',
      });
    }

    // Deliverable must exist AND be a `task_list`-type template. We
    // check both in one `findFirst` so an FE that pointed at the wrong
    // template type sees a specific 400 instead of a cryptic FK error.
    const deliverable = await this.prisma.template.findFirst({
      where: { id: deliverableId, deletedAt: null },
      select: { id: true, name: true, code: true, type: true, archivedAt: true },
    });
    if (!deliverable) {
      throw new BadRequestException({
        code: 'DELIVERABLE_REF_NOT_FOUND',
        message: `Deliverable template #${deliverableId} not found.`,
      });
    }
    // PR-053 — archived deliverables are out of the pickers; refuse a
    // new slot for one (existing slots are untouched).
    if (deliverable.archivedAt) {
      throw new ConflictException({
        code: 'TEMPLATE_ARCHIVED',
        message: `Template "${deliverable.name}" is archived. Restore it before adding it to another template.`,
        details: { field: 'deliverableTemplateId', templateId: deliverable.id },
      });
    }
    if (deliverable.type !== 'task_list') {
      throw new BadRequestException({
        code: 'DELIVERABLE_REF_WRONG_TYPE',
        message:
          `Template #${deliverableId} is of type "${deliverable.type}"; ` +
          `only "task_list" deliverable templates may be referenced.`,
      });
    }

    const parentZoneIdRaw = body?.parentZoneId;
    const parentZoneId =
      parentZoneIdRaw == null || parentZoneIdRaw === ''
        ? null
        : Number(parentZoneIdRaw);
    if (parentZoneId != null) {
      if (!Number.isFinite(parentZoneId) || parentZoneId <= 0) {
        throw new BadRequestException({
          code: 'DELIVERABLE_REF_BAD_PARENT',
          message: 'parentZoneId, when given, must be a positive integer.',
        });
      }
      const parent = await this.prisma.templateZone.findUnique({
        where: { id: parentZoneId },
        select: { id: true, templateId: true },
      });
      if (!parent || parent.templateId !== templateId) {
        throw new BadRequestException({
          code: 'DELIVERABLE_REF_PARENT_MISMATCH',
          message:
            `Parent zone #${parentZoneId} does not belong to template #${templateId}.`,
        });
      }
    }

    const maxOrder = await this.prisma.templateZone.aggregate({
      where: { templateId, parentId: parentZoneId },
      _max: { sortOrder: true },
    });
    const sortOrder =
      body?.sortOrder != null && body.sortOrder !== ''
        ? Number(body.sortOrder)
        : (maxOrder._max.sortOrder ?? 0) + 1;

    const slotName = (body?.name ?? deliverable.name).toString();

    return this.prisma.templateZone.create({
      data: {
        templateId,
        parentId: parentZoneId,
        // Reuse the most-neutral existing zoneType (same default
        // `addZone` writes above). We do NOT add a new enum value for
        // "deliverable slot" — the FE recognises the slot by
        // `linkedTaskTemplateId != null` and renders the "Linked" badge
        // + nested read-only task list on top of the plain zone chrome.
        zoneType: 'building',
        name: slotName,
        code: null,
        isTypical: false,
        typicalCount: 1,
        instanceCount: 1,
        sortOrder,
        linkedTaskTemplateId: deliverable.id,
        referencedTemplateId: null,
      },
      include: {
        linkedTaskTemplate: { select: { id: true, name: true, code: true } },
        referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
      },
    });
  }

  async updateZone(zoneId: number, body: any) {
    // QA6 · a missing zone was a Prisma P2025 500; an unknown zoneType
    // (the inline type select can carry the legacy 'zone') was a
    // validation 500. Same checks as `addZone`, applied to the fields
    // that were sent; undefined leaves a field alone, as before.
    const current = await this.prisma.templateZone.findUnique({
      where: { id: zoneId },
      select: { id: true, templateId: true, referencedTemplateId: true, linkedTaskTemplateId: true },
    });
    if (!current) throw new NotFoundException('Template zone not found');
    const input = await this.validateTemplateZoneInput(current.templateId, body ?? {}, {
      mode: 'update',
      current,
    });
    try {
      return await this.prisma.templateZone.update({
        where: { id: zoneId },
        data: {
          name: input.name,
          code: input.code,
          zoneType: input.zoneType,
          isTypical: input.isTypical,
          typicalCount: input.typicalCount,
          // Only set when the caller sent it; clamped to >= 1.
          instanceCount: input.instanceCount,
          sortOrder: input.sortOrder,
          linkedTaskTemplateId: input.linkedTaskTemplateId,
          referencedTemplateId: input.referencedTemplateId,
        },
        include: {
          linkedTaskTemplate: { select: { id: true, name: true, code: true } },
          referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
        },
      });
    } catch (err) {
      throw mapTemplateZoneWriteError(err);
    }
  }

  async removeZone(zoneId: number) {
    // QA6 · a missing zone was a Prisma P2025 500.
    const zone = await this.prisma.templateZone.findUnique({ where: { id: zoneId }, select: { id: true } });
    if (!zone) throw new NotFoundException('Template zone not found');
    // Cascade will delete children and templateZoneTasks
    await this.prisma.templateZone.delete({ where: { id: zoneId } });
    return { message: 'Template zone deleted' };
  }

  async addZoneTask(templateZoneId: number, body: any) {
    const maxOrder = await this.prisma.templateZoneTask.aggregate({
      where: { templateZoneId },
      _max: { sortOrder: true },
    });
    // QA4 · B1 (2026-09-28) — mirror of addTask() above; keeps the
    // deliverable FK in sync when the zone-picker writes the task.
    // QA4 · DN-2 (2026-10-04) — marker-only callers get the FK
    // resolved server-side. See addTask for rationale.
    const deliverableTemplateId =
      body.deliverableTemplateId
      ?? (await this.resolveDeliverableTemplateByMarker(body.description, body.phaseId ?? null));
    // DN-ext (2026-10-22) — mirror the catalog FK passthrough on the
    // zone-task write path. The ZoneCatalogPickerModal now sends
    // `catalogTaskId: catalogTask.id` so a rename in the catalog
    // reaches every zone template that referenced it.
    const rawCatalogTaskId = body.catalogTaskId ?? body.sourceCatalogTaskId;
    const catalogTaskId =
      rawCatalogTaskId == null || rawCatalogTaskId === ''
        ? null
        : Number.isFinite(Number(rawCatalogTaskId))
          ? Number(rawCatalogTaskId)
          : null;
    return this.prisma.templateZoneTask.create({
      data: {
        templateZoneId,
        code: body.code,
        name: body.name,
        description: body.description || null,
        defaultBudgetHours: body.defaultBudgetHours || null,
        defaultBudgetAmount: body.defaultBudgetAmount || null,
        phaseId: body.phaseId || null,
        serviceTypeId: body.serviceTypeId || null,
        deliverableTemplateId,
        catalogTaskId,
        defaultPriority: body.defaultPriority || 'medium',
        sortOrder: body.sortOrder ?? (maxOrder._max.sortOrder ?? 0) + 1,
      },
      include: { phase: true },
    });
  }

  async removeZoneTask(id: number) {
    await this.prisma.templateZoneTask.delete({ where: { id } });
    return { message: 'Zone task deleted' };
  }

  async duplicate(id: number, userId: number, body: { name: string; code: string }) {
    const source = await this.findOne(id);

    const newTemplate = await this.prisma.template.create({
      data: {
        code: body.code,
        name: body.name,
        type: source.type,
        category: source.category,
        description: source.description,
        phaseId: source.phaseId,
        createdBy: userId,
      },
    });

    for (const task of source.templateTasks) {
      await this.prisma.templateTask.create({
        data: {
          templateId: newTemplate.id,
          serviceTypeId: task.serviceTypeId,
          // QA4 · DN-2 (2026-10-04) — carry the Deliverable FK across
          // a template clone. Without this, a duplicated Deliverable
          // Template produces tasks with a stale `[SERVICE:…]` marker
          // but no FK, re-introducing the exact drift DN-1 cleaned up.
          deliverableTemplateId: (task as any).deliverableTemplateId ?? null,
          // DN-ext (2026-10-22) — same rationale for the catalog FK:
          // a clone of a Deliverable Template keeps its live link to
          // the catalog so renames keep propagating through the
          // duplicate, not just the original.
          catalogTaskId: (task as any).catalogTaskId ?? null,
          code: task.code,
          name: task.name,
          description: task.description,
          defaultBudgetHours: task.defaultBudgetHours,
          defaultBudgetAmount: task.defaultBudgetAmount,
          defaultPriority: task.defaultPriority,
          phaseId: task.phaseId,
          sortOrder: task.sortOrder,
        },
      });
    }

    return this.findOne(newTemplate.id);
  }
}
