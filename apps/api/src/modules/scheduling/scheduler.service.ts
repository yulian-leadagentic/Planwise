import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExecutionPlanningService } from '../execution-planning/execution-planning.service';

/**
 * T3 · Working-Day Scheduling Engine
 * -------------------------------------------------------------------
 * Spec: docs/bm2/planwise-scheduling-engine-SPEC.md (locked 2026-10-20).
 * Depends on T1 (TemplateTask sort order + TemplateTaskDependency and
 * their project-level materialisation into Task.sortOrder + TaskDependency).
 *
 * Public API:
 *   - scheduleDeliverableDryRun(inputs)         — compute, no writes
 *   - scheduleDeliverableAndCommit(inputs, uid) — compute + persist
 *
 * Algorithm overview:
 *   1. Load the DAG under ZoneDeliverableTarget (deliverableId; optional zoneId).
 *   2. Load holiday / rest-day sources (org CalendarDay + HrSettings
 *      .weeklyRestDays). Resolve per-assignee dailyStandardHours when a
 *      task has one.
 *   3. Compute each task's working-day duration (ceil(budgetHours /
 *      dailyStandardHours), default 1).
 *   4. Backward pass (anchor = targetDate): terminal tasks end at
 *      anchor; non-terminal end at `prevWorkingDay(min(successor.start))`
 *      clamped to anchor (finish-to-start + 1 working day — spec rule 3);
 *      startDate = walkBack(endDate, duration).
 *      `dueDateOverridden` short-circuits — the task's stored dates
 *      are preserved and the surrounding chain respects them.
 *   5. Forward pass (base = max(project.startDate, today)): topo
 *      order; earliestStart = max(nextWorkingDay(preds.earliestFinish), base);
 *      earliestFinish = walkForward(earliestStart, duration).
 *      Status derives from `overflowDays`: 0 → feasible, 1-5 → at-risk,
 *      >5 → infeasible.
 *   6. Optional write-back (commit path only) under a transaction;
 *      Task.startDate (actual start) is never touched — we only
 *      update `estimatedStartDate` + `endDate`.
 *
 * Reuse (no duplicate loops):
 *   - `ExecutionPlanningService.countWorkingDays(from, to, holidays)`
 *     for the forward-pass overflow measurement. The step-helpers
 *     (walkWorkingDaysBack / walkWorkingDaysForward) are new because
 *     they produce a date, not a count — `countWorkingDays` can't be
 *     bent to that shape without a second loop.
 *
 * Topological order: Kahn's algorithm (BFS over in-degree). Forward
 * topo order is used directly for the forward pass; reversed for the
 * backward pass. If a cycle is present, Kahn's drops the offending
 * nodes from the output; those tasks are left unscheduled and the
 * result's `scheduled` array only contains the acyclic subset — the
 * feasibility engine warns on cycles separately.
 *
 * `estimatedDurationWeeks` semantics note (follow-up): the column
 * `ZoneDeliverableTarget.estimatedDurationWeeks` is stored today as
 * CALENDAR days (not weeks, despite the name — see schema comment
 * circa 2026-08-02). T3 does NOT read this column as the task-level
 * duration; task durations come from `budgetHours / dailyStandardHours`.
 * The deliverable-level column is kept as a fallback hint for the
 * Gantt renderer and is converted into a working-day count via
 * `countWorkingDays` only when that helper would be useful (not yet
 * wired — a later spec item should rename + retype this field).
 *
 * Triggers (deferred): the spec lists auto-triggers for target
 * change, dependency change, assignment change and duration change.
 * This pass exposes explicit endpoints only; events are left as a
 * follow-up until the engine proves out.
 */
export interface ScheduleInputs {
  deliverableId: number; // ZoneDeliverableTarget id
  zoneId?: number;       // optional (ZoneDeliverableTarget already pins a zone, but kept for symmetry with spec)
  anchorDate?: Date;     // optional override for targetDate (used when simulating)
}

export interface ScheduledTask {
  taskId: number;
  startDate: Date;         // Task.estimatedStartDate (working-day aligned)
  endDate: Date;           // Task.endDate (working-day aligned OR the raw anchor when non-working — see §Convention below)
  workingDaysDuration: number;
  skippedByOverride: boolean; // true if dueDateOverridden preserved the stored dates
  assigneeId: number | null;  // first assignee (same convention as duration); null = unassigned
  /**
   * D2 (resource leveling + spec rule 13): true when the task cannot be
   * placed inside the available runway at its assignee's daily capacity.
   * Reasons:
   *   - 'overload'              : hours spill past baseDate (project.startDate / today).
   *   - 'predecessor-conflict'  : leveling moved startDate below prevWorkingDay(pred.endDate)+1wd.
   * The PM dashboard surfaces these (D3, follow-up); the engine never
   * "forces" an infeasible plan but still exposes the computed dates so
   * the reviewer can see the gap.
   */
  infeasible?: boolean;
  infeasibleReason?: 'overload' | 'predecessor-conflict';
}

export interface ScheduleResult {
  scheduled: ScheduledTask[];
  feasibility: {
    status: 'feasible' | 'at-risk' | 'infeasible';
    earliestForwardFinish: Date | null;
    overflowDays: number; // positive = past anchor
    reason?: string;
  };
}

/**
 * D3 · Overload scan — one flagged task row.
 *
 * Produced by `scanProjectOverload` / `scanAllActiveOverload`.
 * Enriches a `ScheduledTask` (where `infeasible === true`) with the
 * surrounding task / deliverable / zone / assignee metadata the PM
 * dashboard needs to surface the problem without a second round-trip.
 *
 * `overflowDays` is set when the task's start cursor spilled before
 * baseDate (project.startDate / today) during resource leveling; it
 * counts CALENDAR days from `estimatedStartDate` back to baseDate.
 * Omitted when the only reason is `predecessor-conflict` (the scheduler
 * didn't walk off the runway, it just violated the +1-wd gap rule).
 */
export interface OverloadFlaggedTask {
  taskId: number;
  taskCode: string;
  taskName: string;
  deliverableId: number; // ZoneDeliverableTarget id
  deliverableName: string;
  zoneId: number | null;
  zoneName: string | null;
  assigneeId: number | null;
  assigneeName: string | null;
  budgetHours: number | null;
  estimatedStartDate: string | null; // yyyy-MM-dd
  endDate: string | null; // yyyy-MM-dd
  infeasibleReason: 'overload' | 'predecessor-conflict';
  overflowDays?: number;
  projectId: number;
  projectName: string;
}

export interface ProjectOverloadScanResult {
  projectId: number;
  projectName: string;
  scannedDeliverables: number;
  flaggedTasks: OverloadFlaggedTask[];
}

export interface AllOverloadScanResult {
  scannedProjects: number;
  scannedDeliverables: number;
  flaggedTasks: OverloadFlaggedTask[];
}

/**
 * D4 · "Save & update due dates" — per-task review item.
 *
 * The scheduler never auto-commits a task that falls into one of
 * three categories (spec §D4c):
 *   (א) manual        — `dueDateOverridden === true` (rule 10:
 *                       preserved); PM must confirm the overwrite.
 *   (ב) overload      — the engine flagged `infeasible === true`
 *                       (rule 13: never force; surface to PM).
 *   (ג) hours-logged — a `TimeEntry` with minutes>0 and
 *                       specialHourBucketId=NULL exists for this
 *                       task; moving its dates could invalidate
 *                       already-reported hours.
 *
 * Everything else is auto-committed in-place. The review payload lets
 * the PM accept or override each flagged row via `applyReviewed`.
 */
export interface ReviewRequiredTask {
  taskId: number;
  taskCode: string;
  taskName: string;
  deliverableId: number;
  deliverableName: string;
  zoneId: number | null;
  zoneName: string | null;
  currentEnd: string | null;   // yyyy-MM-dd — the task's CURRENT stored endDate
  proposedEnd: string | null;  // yyyy-MM-dd — what the scheduler would place endDate at
  reason: 'manual' | 'overload' | 'hours-logged';
}

export interface SaveAndUpdateDueDatesResult {
  scannedDeliverables: number;
  autoApplied: Array<{ taskId: number; newStart: string; newEnd: string }>;
  requiresReview: ReviewRequiredTask[];
}

/**
 * Convention: `endDate` holds the deadline the deliverable promised.
 * If anchor lands on a non-working day (holiday / weekly rest) the
 * TERMINAL task's stored endDate stays the anchor so the customer-
 * facing "due by" number is preserved; `startDate` is still a working
 * day because the task is actually executed on working days. Non-
 * terminal tasks derive endDate from `prevWorkingDay(min(successor.start))`
 * (finish-to-start + 1 working day — spec rule 3), which IS a working
 * day, so their endDate is also always a working day.
 */
interface TaskRow {
  id: number;
  budgetHours: unknown;        // Prisma Decimal | null
  estimatedStartDate: Date | null;
  startDate: Date | null;
  endDate: Date | null;
  dueDateOverridden: boolean;
  assignees: Array<{ user: { id: number; dailyStandardHours: unknown } }>;
}

const DEFAULT_WEEKLY_REST_DAYS = [5, 6]; // Fri + Sat (Israeli work-week), aligned with HrSettings default
const DEFAULT_DAILY_STANDARD_HOURS = 8;
const DAY_MS = 86400000;

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eps: ExecutionPlanningService,
  ) {}

  async scheduleDeliverableDryRun(inputs: ScheduleInputs): Promise<ScheduleResult> {
    return this.scheduleDeliverable(inputs, { writeBack: false });
  }

  async scheduleDeliverableAndCommit(
    inputs: ScheduleInputs,
    actorId?: number,
  ): Promise<ScheduleResult> {
    return this.scheduleDeliverable(inputs, { writeBack: true, actorId });
  }

  // ─── D3 · Overload scan ────────────────────────────────────────────
  //
  // Runs `scheduleDeliverableDryRun` for every deliverable under a
  // project (or every deliverable under every active project in the
  // `-all` variant), filters to `infeasible === true` tasks, then
  // enriches with the surrounding task / deliverable / zone / assignee
  // metadata so the PM dashboard can render a single row per flagged
  // task without a second round-trip.
  //
  // The scan is read-only — nothing in Prisma is updated. The
  // scheduler is invoked per deliverable sequentially; the per-call
  // cost dominates (one query per deliverable), so a short-circuit on
  // no-tasks / no-anchor paths comes for free.
  async scanProjectOverload(projectId: number): Promise<ProjectOverloadScanResult> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Load every ZoneDeliverableTarget under the project. The scheduler
    // iterates these one by one — a project with hundreds of
    // deliverables will issue hundreds of per-deliverable queries, but
    // this is read-only / cache-safe and keeps the engine's single
    // entry point intact.
    const targets = await this.prisma.zoneDeliverableTarget.findMany({
      where: {
        projectDeliverable: { projectId, deletedAt: null },
      },
      select: {
        id: true,
        zoneId: true,
        projectDeliverable: { select: { id: true, name: true } },
        zone: { select: { id: true, name: true, code: true } },
      },
    });

    const flaggedTasks: OverloadFlaggedTask[] = [];
    const taskIdsFlagged = new Set<number>();
    for (const t of targets) {
      let result: ScheduleResult;
      try {
        result = await this.scheduleDeliverableDryRun({ deliverableId: t.id });
      } catch (err) {
        this.logger.warn(
          `scanProjectOverload: dryRun failed for deliverableId=${t.id} — ${(err as Error).message}`,
        );
        continue;
      }
      for (const s of result.scheduled) {
        if (!s.infeasible || !s.infeasibleReason) continue;
        taskIdsFlagged.add(s.taskId);
      }
    }

    if (taskIdsFlagged.size === 0) {
      return {
        projectId: project.id,
        projectName: project.name,
        scannedDeliverables: targets.length,
        flaggedTasks: [],
      };
    }

    // Re-walk the per-deliverable results once we know the universe of
    // flagged task ids, so a single bulk Task.findMany can enrich
    // them. Using the same `targets` loop twice (once for discovery,
    // once for enrichment) is cheaper than issuing a Task.findMany
    // per deliverable.
    const taskMetadata = await this.prisma.task.findMany({
      where: { id: { in: [...taskIdsFlagged] } },
      select: {
        id: true,
        code: true,
        name: true,
        budgetHours: true,
        assignees: {
          where: { deletedAt: null },
          select: { user: { select: { id: true, firstName: true, lastName: true } } },
          take: 1,
        },
      },
    });
    const taskById = new Map(taskMetadata.map((t) => [t.id, t]));

    const baseDate = this.stripTime(new Date());

    for (const t of targets) {
      let result: ScheduleResult;
      try {
        result = await this.scheduleDeliverableDryRun({ deliverableId: t.id });
      } catch {
        continue;
      }
      for (const s of result.scheduled) {
        if (!s.infeasible || !s.infeasibleReason) continue;
        const meta = taskById.get(s.taskId);
        if (!meta) continue;
        const assignee = meta.assignees?.[0]?.user ?? null;
        const assigneeName = assignee
          ? [assignee.firstName, assignee.lastName].filter(Boolean).join(' ').trim() || null
          : null;

        // overflowDays only for `overload`. We count calendar-day gap
        // from the computed start back to baseDate when start < base.
        let overflowDays: number | undefined;
        if (s.infeasibleReason === 'overload' && s.startDate < baseDate) {
          const diff = Math.ceil(
            (baseDate.getTime() - this.stripTime(s.startDate).getTime()) / DAY_MS,
          );
          if (diff > 0) overflowDays = diff;
        }

        flaggedTasks.push({
          taskId: s.taskId,
          taskCode: meta.code,
          taskName: meta.name,
          deliverableId: t.id,
          deliverableName: t.projectDeliverable?.name ?? '—',
          zoneId: t.zone?.id ?? t.zoneId ?? null,
          zoneName: t.zone?.name ?? null,
          assigneeId: assignee?.id ?? null,
          assigneeName,
          budgetHours: meta.budgetHours != null ? Number(meta.budgetHours) : null,
          estimatedStartDate: s.startDate ? s.startDate.toISOString().split('T')[0] : null,
          endDate: s.endDate ? s.endDate.toISOString().split('T')[0] : null,
          infeasibleReason: s.infeasibleReason,
          overflowDays,
          projectId: project.id,
          projectName: project.name,
        });
      }
    }

    // De-dup — a single Task could appear once per deliverable scan
    // if it lives under multiple targets. In practice Task → one
    // (projectDeliverable, zone), so this is defensive.
    const seen = new Set<number>();
    const deduped: OverloadFlaggedTask[] = [];
    for (const row of flaggedTasks) {
      if (seen.has(row.taskId)) continue;
      seen.add(row.taskId);
      deduped.push(row);
    }

    return {
      projectId: project.id,
      projectName: project.name,
      scannedDeliverables: targets.length,
      flaggedTasks: deduped,
    };
  }

  /**
   * Aggregated variant — iterate every active, non-archived project
   * and run `scanProjectOverload` on each. The result's rows carry
   * `projectId`/`projectName` already (populated by the per-project
   * call), so the dashboard can group by project without a second
   * lookup.
   */
  async scanAllActiveOverload(): Promise<AllOverloadScanResult> {
    const projects = await this.prisma.project.findMany({
      where: { status: 'active', isArchived: false },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    let scannedDeliverables = 0;
    const flaggedTasks: OverloadFlaggedTask[] = [];
    for (const p of projects) {
      try {
        const res = await this.scanProjectOverload(p.id);
        scannedDeliverables += res.scannedDeliverables;
        flaggedTasks.push(...res.flaggedTasks);
      } catch (err) {
        this.logger.warn(
          `scanAllActiveOverload: skipped projectId=${p.id} — ${(err as Error).message}`,
        );
      }
    }

    return {
      scannedProjects: projects.length,
      scannedDeliverables,
      flaggedTasks,
    };
  }

  // ─── D4 · Save & update due dates ──────────────────────────────────
  //
  // Reschedules every deliverable in a project in one call. Tasks that
  // land in one of three "problematic" buckets (spec §D4c) are NEVER
  // auto-committed — they come back in `requiresReview` for the PM to
  // approve or override via `applyReviewed`. Everything else is
  // written in-place under a single transaction so the write is
  // atomic per deliverable set.
  //
  // Called AFTER the FE has already persisted the deliverable targets
  // via `POST /project-deliverables/targets/batch`; this endpoint is
  // step 2 of the "Save & update" button. Splitting the two is
  // intentional — the regular Save button hits step 1 only, so each
  // endpoint has exactly one job and the modules don't need to cross-
  // import.
  //
  // Hours-logged check: a `TimeEntry` with minutes>0 AND
  // specialHourBucketId=NULL. Reported hours against a SpecialHourBucket
  // (HR behavior A/B) don't block — the dates we move are the project
  // task's, not the bucket's accrual.
  //
  // D6 (TODO) · When this endpoint lands, additional auto-reschedule
  // trigger points should hook into this same flow via a shared method
  // instead of re-implementing the problematic-task filter — see the
  // `TODO(D6 · scheduling)` markers around the deliverable-target /
  // task-assignee / task-budgetHours write paths.
  async saveAndUpdateDueDates(
    projectId: number,
    actorId?: number,
  ): Promise<SaveAndUpdateDueDatesResult> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Load every ZoneDeliverableTarget under the project — same shape
    // as the overload scan but with projectDeliverable name/zone for
    // the review-row metadata.
    const targets = await this.prisma.zoneDeliverableTarget.findMany({
      where: { projectDeliverable: { projectId, deletedAt: null } },
      select: {
        id: true,
        zoneId: true,
        projectDeliverable: { select: { id: true, name: true } },
        zone: { select: { id: true, name: true } },
      },
    });

    if (targets.length === 0) {
      return { scannedDeliverables: 0, autoApplied: [], requiresReview: [] };
    }

    // Dry-run per deliverable. We keep the target meta so the review
    // rows can carry deliverable/zone names without a second query.
    const perDeliverable: Array<{ target: (typeof targets)[number]; scheduled: ScheduledTask[] }> = [];
    for (const t of targets) {
      try {
        const result = await this.scheduleDeliverableDryRun({ deliverableId: t.id });
        perDeliverable.push({ target: t, scheduled: result.scheduled });
      } catch (err) {
        this.logger.warn(
          `saveAndUpdateDueDates: dryRun failed for deliverableId=${t.id} — ${(err as Error).message}`,
        );
      }
    }

    const allTaskIds = new Set<number>();
    for (const { scheduled } of perDeliverable) {
      for (const s of scheduled) allTaskIds.add(s.taskId);
    }

    if (allTaskIds.size === 0) {
      return { scannedDeliverables: targets.length, autoApplied: [], requiresReview: [] };
    }

    // Bulk-load task metadata (code/name/current endDate) for the
    // review rows.
    const taskRows = await this.prisma.task.findMany({
      where: { id: { in: [...allTaskIds] } },
      select: {
        id: true,
        code: true,
        name: true,
        endDate: true,
        dueDateOverridden: true,
      },
    });
    const taskById = new Map(taskRows.map((t) => [t.id, t]));

    // (ג) hours-logged: group TimeEntry by task; the Set membership
    // acts as the blocker. `specialHourBucketId=null` excludes HR-bucket
    // reports (behavior A/B) — those don't own the project task's
    // scheduling dates.
    const timeEntries = await this.prisma.timeEntry.groupBy({
      by: ['taskId'],
      where: {
        taskId: { in: [...allTaskIds] },
        minutes: { gt: 0 },
        specialHourBucketId: null,
        deletedAt: null,
      },
      _sum: { minutes: true },
    });
    const hasHoursLogged = new Set<number>();
    for (const row of timeEntries) {
      if (row.taskId != null && (row._sum.minutes ?? 0) > 0) {
        hasHoursLogged.add(row.taskId);
      }
    }

    // Partition: auto-commit vs. review. We iterate per-deliverable so
    // the review row keeps its deliverable/zone context.
    const taskToCommit = new Map<number, { newStart: Date; newEnd: Date }>();
    const requiresReview: ReviewRequiredTask[] = [];
    const seenReviewTaskIds = new Set<number>();

    const pushReview = (
      s: ScheduledTask,
      target: (typeof targets)[number],
      reason: ReviewRequiredTask['reason'],
    ) => {
      if (seenReviewTaskIds.has(s.taskId)) return;
      const meta = taskById.get(s.taskId);
      if (!meta) return;
      seenReviewTaskIds.add(s.taskId);
      requiresReview.push({
        taskId: s.taskId,
        taskCode: meta.code,
        taskName: meta.name,
        deliverableId: target.id,
        deliverableName: target.projectDeliverable?.name ?? '—',
        zoneId: target.zone?.id ?? target.zoneId ?? null,
        zoneName: target.zone?.name ?? null,
        currentEnd: meta.endDate ? meta.endDate.toISOString().split('T')[0] : null,
        proposedEnd: s.endDate ? s.endDate.toISOString().split('T')[0] : null,
        reason,
      });
    };

    for (const { target, scheduled } of perDeliverable) {
      for (const s of scheduled) {
        // (א) manual override — the scheduler short-circuits on
        // dueDateOverridden and returns the stored dates; the PM must
        // explicitly accept the overwrite. "proposed" ends up equal
        // to the current date (since the engine didn't recompute), so
        // the review input is pre-filled with current; the PM edits
        // if they want a new date or picks "Keep current" to leave it.
        if (s.skippedByOverride) {
          pushReview(s, target, 'manual');
          continue;
        }
        // (ב) overload / infeasible — never auto-commit.
        if (s.infeasible) {
          pushReview(s, target, 'overload');
          continue;
        }
        // (ג) hours already logged — never auto-commit.
        if (hasHoursLogged.has(s.taskId)) {
          pushReview(s, target, 'hours-logged');
          continue;
        }
        // Safe to auto-commit.
        taskToCommit.set(s.taskId, { newStart: s.startDate, newEnd: s.endDate });
      }
    }

    const autoApplied: Array<{ taskId: number; newStart: string; newEnd: string }> = [];
    if (taskToCommit.size > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const [taskId, { newStart, newEnd }] of taskToCommit) {
          await tx.task.update({
            where: { id: taskId },
            data: {
              estimatedStartDate: newStart,
              endDate: newEnd,
              // Rule 10: never flip dueDateOverridden back to false
              // here. Auto-scheduling writes the computed date but
              // leaves override state alone — a PM who had previously
              // picked a manual date for this task would have landed in
              // the review path above.
            },
          });
        }
      });
      for (const [taskId, { newStart, newEnd }] of taskToCommit) {
        autoApplied.push({
          taskId,
          newStart: newStart.toISOString().split('T')[0],
          newEnd: newEnd.toISOString().split('T')[0],
        });
      }
    }

    this.logger.log(
      `saveAndUpdateDueDates · projectId=${projectId} actor=${actorId ?? 'system'} ` +
        `scanned=${targets.length} autoApplied=${autoApplied.length} requiresReview=${requiresReview.length}`,
    );

    return {
      scannedDeliverables: targets.length,
      autoApplied,
      requiresReview,
    };
  }

  /**
   * D4 · Commit the PM-approved review rows.
   *
   * Each approval carries the ACCEPTED endDate — either the engine's
   * proposed date or a PM-typed override. We recompute `estimatedStartDate`
   * as `walkWorkingDaysBack(endDate, duration)` using the task's
   * budgetHours / first-assignee's dailyStandardHours — identical to
   * the formula the scheduler uses for duration (spec §D4d), so the
   * forward/backward passes stay consistent on the next recompute.
   *
   * Only tasks that belong to the named project are committed; a
   * stray taskId from another project is silently skipped (defensive
   * — the FE only sends ids it got back from `saveAndUpdateDueDates`).
   */
  async applyReviewed(
    projectId: number,
    approvals: Array<{ taskId: number; acceptedEnd: string }>,
    actorId?: number,
  ): Promise<{ applied: number }> {
    if (!Array.isArray(approvals) || approvals.length === 0) {
      return { applied: 0 };
    }

    const taskRows = await this.prisma.task.findMany({
      where: {
        id: { in: approvals.map((a) => a.taskId) },
        projectId,
        deletedAt: null,
      },
      select: {
        id: true,
        budgetHours: true,
        assignees: {
          where: { deletedAt: null },
          select: { user: { select: { dailyStandardHours: true } } },
          take: 1,
        },
      },
    });
    if (taskRows.length === 0) return { applied: 0 };
    const taskById = new Map(taskRows.map((t) => [t.id, t]));

    // Reload calendar + rest days for the working-day walk (same
    // helpers the scheduler uses). We could lift this into a shared
    // helper, but the per-call cost is tiny and avoiding the extra
    // indirection keeps this method self-contained.
    const calendarDays = await this.prisma.calendarDay.findMany({
      where: { appliesTo: { in: ['all', 'employees_only'] } },
      select: { date: true, type: true, workingHours: true },
    });
    const holidayDates = new Set<string>();
    for (const d of calendarDays) {
      const wh = d.workingHours == null ? null : Number(d.workingHours);
      if (d.type !== 'REGULAR' && (wh === null || wh === 0)) {
        holidayDates.add(d.date.toISOString().split('T')[0]);
      }
    }
    const hr = await this.prisma.hrSettings.findFirst({ select: { weeklyRestDays: true } });
    const restDaysRaw = hr?.weeklyRestDays as unknown as number[] | null;
    const weeklyRestDays =
      Array.isArray(restDaysRaw) && restDaysRaw.every((n) => Number.isInteger(n))
        ? restDaysRaw
        : DEFAULT_WEEKLY_REST_DAYS;
    const isWorkingDay = (d: Date): boolean => {
      const dow = d.getUTCDay();
      if (weeklyRestDays.includes(dow)) return false;
      const key = d.toISOString().split('T')[0];
      if (holidayDates.has(key)) return false;
      return true;
    };

    let applied = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const a of approvals) {
        const task = taskById.get(a.taskId);
        if (!task) continue;
        // Parse yyyy-MM-dd as UTC midnight — matches `stripTime` so the
        // @db.Date column never serializes to the previous day in a
        // negative-offset timezone.
        const [y, m, d] = String(a.acceptedEnd || '').split('-').map(Number);
        if (!y || !m || !d) continue;
        const endDate = new Date(Date.UTC(y, m - 1, d));
        const dsh = Number(
          (task.assignees?.[0] as any)?.user?.dailyStandardHours ?? DEFAULT_DAILY_STANDARD_HOURS,
        );
        const bh = task.budgetHours != null ? Number(task.budgetHours) : 0;
        const duration = bh > 0 && dsh > 0 ? Math.max(1, Math.ceil(bh / dsh)) : 1;
        const startDate = walkWorkingDaysBack(endDate, duration, isWorkingDay);
        await tx.task.update({
          where: { id: a.taskId },
          data: {
            estimatedStartDate: startDate,
            endDate,
            // The PM is explicitly setting this date, so flip
            // dueDateOverridden true — a subsequent target-change should
            // keep going through the review flow for this task (rule
            // 10 preservation).
            dueDateOverridden: true,
          },
        });
        applied++;
      }
    });

    this.logger.log(
      `applyReviewed · projectId=${projectId} actor=${actorId ?? 'system'} applied=${applied}/${approvals.length}`,
    );

    return { applied };
  }

  private async scheduleDeliverable(
    inputs: ScheduleInputs,
    opts: { writeBack: boolean; actorId?: number },
  ): Promise<ScheduleResult> {
    // 1. Resolve deliverable + anchor.
    const deliverable = await this.prisma.zoneDeliverableTarget.findUnique({
      where: { id: inputs.deliverableId },
      include: {
        projectDeliverable: { include: { project: { select: { id: true, startDate: true } } } },
        zone: { select: { id: true, projectId: true } },
      },
    });
    if (!deliverable) {
      throw new NotFoundException(`ZoneDeliverableTarget ${inputs.deliverableId} not found`);
    }
    const anchor = inputs.anchorDate ?? deliverable.targetDate ?? null;
    if (!anchor) {
      return this.emptyResult('no-anchor');
    }

    // 2. Load tasks under this (projectDeliverable × zone) with assignees.
    //    We intentionally include completed tasks — the scheduler's
    //    output lets a UI prompt the PM about them separately.
    const zoneId = inputs.zoneId ?? deliverable.zoneId;
    const projectDeliverableId = deliverable.projectDeliverableId;
    const tasks = (await this.prisma.task.findMany({
      where: {
        projectDeliverableId,
        zoneId,
        deletedAt: null,
        isArchived: false,
      },
      select: {
        id: true,
        budgetHours: true,
        estimatedStartDate: true,
        startDate: true,
        endDate: true,
        dueDateOverridden: true,
        assignees: {
          where: { deletedAt: null },
          select: { user: { select: { id: true, dailyStandardHours: true } } },
        },
      },
    })) as unknown as TaskRow[];

    if (tasks.length === 0) {
      return this.emptyResult('no-tasks');
    }

    const taskIds = tasks.map((t) => t.id);

    // 3. Load dependency edges whose BOTH ends are inside the loaded set.
    const deps = await this.prisma.taskDependency.findMany({
      where: { taskId: { in: taskIds }, dependsOnId: { in: taskIds } },
      select: { taskId: true, dependsOnId: true },
    });

    // 4. Load the org calendar (holidays + partial-day rows).
    const calendarDays = await this.prisma.calendarDay.findMany({
      where: { appliesTo: { in: ['all', 'employees_only'] } },
      select: { date: true, type: true, workingHours: true },
    });
    const holidayDates = new Set<string>();
    for (const d of calendarDays) {
      // A non-REGULAR row with 0 (or null) working hours is treated as a
      // non-working day for scheduler purposes. Partial-day rows
      // (HOLIDAY_EVE with workingHours > 0) are STILL counted as
      // working days — the scheduler plans a day of work there; the
      // monthly engine remains the authority for exact hours.
      const wh = d.workingHours == null ? null : Number(d.workingHours);
      if (d.type !== 'REGULAR' && (wh === null || wh === 0)) {
        holidayDates.add(d.date.toISOString().split('T')[0]);
      }
    }

    // 5. HrSettings.weeklyRestDays (singleton — currently org-level only).
    //    Per-employee overrides would plug in here (F3a note in spec);
    //    not wired yet because the schema stores a single org row.
    const hr = await this.prisma.hrSettings.findFirst({ select: { weeklyRestDays: true } });
    const restDaysRaw = hr?.weeklyRestDays as unknown as number[] | null;
    const weeklyRestDays =
      Array.isArray(restDaysRaw) && restDaysRaw.every((n) => Number.isInteger(n))
        ? restDaysRaw
        : DEFAULT_WEEKLY_REST_DAYS;

    const isWorkingDay = (d: Date): boolean => {
      // Use UTC getters throughout — Prisma `@db.Date` columns come
      // back as midnight-UTC Date objects, and the scheduler
      // normalises every date through `stripTime` which also uses
      // UTC. Mixing local getters here would break on timezones west
      // of UTC (local date = UTC date − 1).
      const dow = d.getUTCDay();
      if (weeklyRestDays.includes(dow)) return false;
      const key = d.toISOString().split('T')[0];
      if (holidayDates.has(key)) return false;
      return true;
    };

    // 6. Per-task duration in working days.
    const durationByTask = new Map<number, number>();
    for (const t of tasks) {
      durationByTask.set(t.id, this.resolveWorkingDaysDuration(t));
    }

    // 7. Adjacency maps.
    const successors = new Map<number, number[]>();
    const predecessors = new Map<number, number[]>();
    for (const id of taskIds) {
      successors.set(id, []);
      predecessors.set(id, []);
    }
    for (const d of deps) {
      successors.get(d.dependsOnId)?.push(d.taskId);
      predecessors.get(d.taskId)?.push(d.dependsOnId);
    }

    // 8. Topological sort (Kahn / BFS). Forward order has sources first.
    const topoOrder = this.kahnTopoSort(taskIds, predecessors);

    // ─── 9. BACKWARD PASS ────────────────────────────────────────────
    const scheduled = new Map<number, ScheduledTask>();
    const backwardOrder = [...topoOrder].reverse();
    const anchorDate = this.stripTime(anchor);

    for (const taskId of backwardOrder) {
      const task = tasks.find((t) => t.id === taskId)!;
      const dur = durationByTask.get(taskId)!;
      const assigneeId = task.assignees?.[0]?.user?.id ?? null;

      // Respect manual override — do NOT touch the task's stored dates.
      if (task.dueDateOverridden) {
        const sd = task.estimatedStartDate ?? task.startDate ?? anchorDate;
        const ed = task.endDate ?? anchorDate;
        scheduled.set(taskId, {
          taskId,
          startDate: this.stripTime(sd),
          endDate: this.stripTime(ed),
          workingDaysDuration: dur,
          skippedByOverride: true,
          assigneeId,
        });
        continue;
      }

      // endDate: terminal → anchor (stored as-is per convention);
      //          non-terminal → prevWorkingDay(min(successor.startDate))
      //          (finish-to-start +1 working day — spec rule 3), clamped
      //          to anchor.
      const succ = successors.get(taskId) ?? [];
      let endDate: Date;
      if (succ.length === 0) {
        endDate = anchorDate;
      } else {
        let minStart: Date | null = null;
        for (const sId of succ) {
          const s = scheduled.get(sId);
          if (!s) continue;
          if (minStart === null || s.startDate.getTime() < minStart.getTime()) {
            minStart = s.startDate;
          }
        }
        // D1 (gap = 1 working day): the predecessor must finish ONE
        // working day BEFORE the successor's start. If no scheduled
        // successor (e.g. in a cycle the successor was dropped), fall
        // back to anchor.
        endDate = minStart !== null ? prevWorkingDay(minStart, isWorkingDay) : anchorDate;
        if (endDate.getTime() > anchorDate.getTime()) endDate = anchorDate;
      }

      // startDate = walk back `dur` working days (inclusive — see helper).
      const startDate = walkWorkingDaysBack(endDate, dur, isWorkingDay);

      scheduled.set(taskId, {
        taskId,
        startDate,
        endDate,
        workingDaysDuration: dur,
        skippedByOverride: false,
        assigneeId,
      });
    }

    // ─── 10. FORWARD PASS (feasibility) ─────────────────────────────
    const today = this.stripTime(new Date());
    const projectStart = deliverable.projectDeliverable?.project?.startDate ?? null;
    const baseDateRaw = projectStart && projectStart.getTime() > today.getTime()
      ? this.stripTime(projectStart)
      : today;
    const baseDate = snapToWorkingDayForward(baseDateRaw, isWorkingDay);

    const earliestFinishByTask = new Map<number, Date>();
    for (const taskId of topoOrder) {
      const dur = durationByTask.get(taskId)!;
      const preds = predecessors.get(taskId) ?? [];
      let earliestStart = baseDate;
      for (const pId of preds) {
        const pf = earliestFinishByTask.get(pId);
        if (!pf) continue;
        // D1 (gap = 1 working day): successor starts ONE working day
        // AFTER the predecessor finishes. baseDate is NOT shifted — the
        // +1 applies only when there's a predecessor. Multiple preds →
        // take the max (handoff waits for the latest predecessor).
        const earliestFromPred = nextWorkingDay(pf, isWorkingDay);
        if (earliestFromPred.getTime() > earliestStart.getTime()) earliestStart = earliestFromPred;
      }
      earliestStart = snapToWorkingDayForward(earliestStart, isWorkingDay);
      const earliestFinish = walkWorkingDaysForward(earliestStart, dur, isWorkingDay);
      earliestFinishByTask.set(taskId, earliestFinish);
    }

    let latestFinish: Date | null = null;
    for (const d of earliestFinishByTask.values()) {
      if (!latestFinish || d.getTime() > latestFinish.getTime()) latestFinish = d;
    }

    // Overflow in WORKING days past the anchor. Reuses the ExecutionPlanning
    // helper so the "working-day count" math has exactly one implementation.
    let overflowDays = 0;
    if (latestFinish && latestFinish.getTime() > anchorDate.getTime()) {
      // countWorkingDays is inclusive on both ends — advance anchor by
      // one day so we don't count the anchor itself.
      const from = new Date(anchorDate.getTime() + DAY_MS);
      overflowDays = this.eps.countWorkingDays(from, latestFinish, holidayDates);
    }

    // Status thresholds: 0 overflow → feasible, 1-5 → at-risk, >5 → infeasible.
    // Numbers chosen to leave headroom for small slips without flashing
    // red; revisit once the UI exposes a user-tunable threshold.
    const status: ScheduleResult['feasibility']['status'] =
      overflowDays === 0 ? 'feasible' : overflowDays <= 5 ? 'at-risk' : 'infeasible';

    // ─── 10b. RESOURCE LEVELING (D2) ────────────────────────────────
    // After DAG dependencies pinned endDate (and the initial startDate
    // via duration), pack same-assignee hours into daily capacity.
    // Leveling can push startDate EARLIER (never endDate). Flags
    // `infeasible: 'overload'` when hours spill past baseDate.
    await this.levelByAssignee(scheduled, tasks, isWorkingDay, baseDate);

    // Post-leveling check: did any task's startDate drift below the
    // predecessor's end+1 working day constraint? If so, the leveling
    // violated the finish-to-start+1 rule (spec rule 3). We don't
    // "force" the plan — just flag.
    for (const [taskId, s] of scheduled) {
      if (s.skippedByOverride || s.infeasible) continue;
      const preds = predecessors.get(taskId) ?? [];
      for (const pId of preds) {
        const p = scheduled.get(pId);
        if (!p) continue;
        const minStart = nextWorkingDay(p.endDate, isWorkingDay);
        if (s.startDate.getTime() < minStart.getTime()) {
          s.infeasible = true;
          s.infeasibleReason = 'predecessor-conflict';
          break;
        }
      }
    }

    // ─── 11. WRITE-BACK (commit path only) ──────────────────────────
    if (opts.writeBack) {
      await this.prisma.$transaction(async (tx) => {
        for (const [taskId, s] of scheduled) {
          if (s.skippedByOverride) continue;
          await tx.task.update({
            where: { id: taskId },
            data: {
              estimatedStartDate: s.startDate,
              endDate: s.endDate,
              // Task.startDate (ACTUAL start) is left untouched by the
              // scheduler. Only `estimatedStartDate` moves on
              // re-schedule.
            },
          });
        }
      });
      this.logger.log(
        `scheduleDeliverable commit · deliverableId=${inputs.deliverableId} actor=${opts.actorId ?? 'system'} rows=${scheduled.size}`,
      );
    }

    return {
      scheduled: [...scheduled.values()],
      feasibility: {
        status,
        earliestForwardFinish: latestFinish,
        overflowDays,
      },
    };
  }

  // ─── helpers ─────────────────────────────────────────────────────

  /**
   * D2 · Resource leveling by daily capacity.
   *
   * After the backward pass pinned each task's endDate (via DAG) and
   * provisional startDate (via duration), pack same-assignee hours
   * into available working-day capacity. Walking BACKWARD from each
   * task's endDate, we fill a per-day bucket until the task's
   * budgetHours are placed; the task's final `startDate` becomes the
   * EARLIEST day it occupied (which may be well before the provisional
   * duration-only startDate when the assignee's days are already busy
   * with other tasks).
   *
   * Why backward: endDate is anchored by the DAG, and the engine's job
   * is to push Start back when the day is overloaded. Walking forward
   * would need to re-derive endDate.
   *
   * Interaction with D1: the gap rule is enforced in the backward pass
   * (endDate = prevWorkingDay(successor.start)). Leveling only moves
   * startDate earlier, which can VIOLATE the pred.end+1 rule — flagged
   * post-hoc as `predecessor-conflict`.
   *
   * Capacity source order (spec rule 6 + rule 8):
   *   1. `WorkSchedule` (active row, any day-of-week): shiftEnd −
   *      shiftStart − breakMinutes.
   *   2. assignee's `dailyStandardHours` × 60 (first assignee).
   *   3. org default 8h × 60 = 480 min.
   *
   * Skipped: `skippedByOverride` tasks and unassigned tasks (nothing
   * to level against). 0-hour tasks also skip the pack loop.
   */
  private async levelByAssignee(
    scheduled: Map<number, ScheduledTask>,
    tasks: TaskRow[],
    isWorkingDay: (d: Date) => boolean,
    baseDate: Date,
  ): Promise<void> {
    // Group scheduled tasks by first-assignee id.
    const byAssignee = new Map<number, Array<{ s: ScheduledTask; t: TaskRow }>>();
    for (const t of tasks) {
      const s = scheduled.get(t.id);
      if (!s) continue;
      if (s.skippedByOverride) continue;
      const assigneeId = s.assigneeId;
      if (assigneeId == null) continue;
      const list = byAssignee.get(assigneeId) ?? [];
      list.push({ s, t });
      byAssignee.set(assigneeId, list);
    }

    const fmt = (d: Date): string => d.toISOString().split('T')[0];

    for (const [assigneeId, items] of byAssignee) {
      // Resolve daily capacity in minutes. WorkSchedule rows are
      // per-day-of-week; the current spec treats capacity as a single
      // value, so we pick the first active row as representative. If
      // multiple shifts exist with different lengths, this is a
      // simplification — revisit once per-day capacity is modelled.
      const wsRow = await this.prisma.workSchedule.findFirst({
        where: { userId: assigneeId, isActive: true },
        select: { shiftStart: true, shiftEnd: true, breakMinutes: true },
      });
      const dsh = Number(
        items[0]?.t.assignees?.[0]?.user?.dailyStandardHours ?? DEFAULT_DAILY_STANDARD_HOURS,
      );
      const dailyMinutes = wsRow
        ? resolveWorkScheduleDailyMinutes(wsRow)
        : Math.max(1, dsh * 60);

      if (dailyMinutes <= 0) continue;

      // Sort by endDate desc, then taskId asc (stable). Latest-ending
      // tasks claim the latest days first; earlier-ending tasks fall
      // into the days they already own.
      const sorted = [...items].sort((a, b) => {
        const d = b.s.endDate.getTime() - a.s.endDate.getTime();
        if (d !== 0) return d;
        return a.s.taskId - b.s.taskId;
      });

      const dayBuckets = new Map<string, number>();

      for (const { s, t } of sorted) {
        const budgetHours = t.budgetHours != null ? Number(t.budgetHours) : 0;
        if (budgetHours <= 0) continue; // nothing to pack — keep backward-pass start

        let remaining = Math.round(budgetHours * 60);
        // Anchor cursor at task's endDate (snapped backward in case the
        // terminal task ended on a non-working anchor).
        let cursor = snapToWorkingDayBack(this.stripTime(s.endDate), isWorkingDay);
        let earliestUsed: Date | null = null;

        // Hard-bound against a runaway walk: at most 10k iterations
        // covers decades of working days at worst.
        for (let iter = 0; iter < 10000 && remaining > 0; iter++) {
          const key = fmt(cursor);
          const used = dayBuckets.get(key) ?? 0;
          const available = Math.max(0, dailyMinutes - used);
          if (available > 0) {
            const place = Math.min(remaining, available);
            dayBuckets.set(key, used + place);
            earliestUsed = new Date(cursor.getTime());
            remaining -= place;
            if (remaining === 0) break;
          }
          // Walk to previous working day.
          const prev = new Date(cursor.getTime());
          prev.setUTCDate(prev.getUTCDate() - 1);
          cursor = snapToWorkingDayBack(prev, isWorkingDay);
          if (cursor.getTime() < baseDate.getTime()) {
            // Ran out of runway — flag infeasible but still "place"
            // whatever is left on `cursor` so the computed start is
            // visible. We DON'T update any further buckets past this
            // point; the overload is surfaced to the PM instead.
            earliestUsed = earliestUsed ?? new Date(cursor.getTime());
            s.infeasible = true;
            s.infeasibleReason = 'overload';
            // Expose the below-baseDate cursor as the task's start so
            // the dashboard shows how far it ran over.
            s.startDate = this.stripTime(cursor);
            break;
          }
        }

        if (!s.infeasible && earliestUsed) {
          s.startDate = this.stripTime(earliestUsed);
        }
      }
    }
  }

  private resolveWorkingDaysDuration(task: TaskRow): number {
    const firstAssignee = task.assignees?.[0]?.user;
    const dsh = firstAssignee?.dailyStandardHours != null
      ? Number(firstAssignee.dailyStandardHours)
      : DEFAULT_DAILY_STANDARD_HOURS;
    const bh = task.budgetHours != null ? Number(task.budgetHours) : 0;
    if (bh > 0 && dsh > 0) return Math.max(1, Math.ceil(bh / dsh));
    return 1;
  }

  /**
   * Kahn's algorithm — in-degree BFS. Returns tasks in a topological
   * forward order (sources first). Any task that stays with non-zero
   * in-degree at the end (= member of a cycle) is DROPPED from the
   * returned list; the ExecutionPlanning feasibility engine already
   * surfaces cycle warnings separately, so this scheduler quietly
   * excludes them rather than throwing — the UI should still get a
   * partial schedule for the acyclic portion.
   */
  private kahnTopoSort(ids: number[], predecessors: Map<number, number[]>): number[] {
    const inDeg = new Map<number, number>();
    for (const id of ids) inDeg.set(id, (predecessors.get(id) ?? []).length);

    const successors = new Map<number, number[]>();
    for (const id of ids) successors.set(id, []);
    for (const [taskId, preds] of predecessors) {
      for (const p of preds) successors.get(p)?.push(taskId);
    }

    const queue: number[] = [];
    for (const [id, d] of inDeg) if (d === 0) queue.push(id);

    const out: number[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      out.push(id);
      for (const s of successors.get(id) ?? []) {
        const nd = (inDeg.get(s) ?? 0) - 1;
        inDeg.set(s, nd);
        if (nd === 0) queue.push(s);
      }
    }
    if (out.length !== ids.length) {
      this.logger.warn(
        `kahnTopoSort: cycle detected — ${ids.length - out.length} task(s) dropped from the schedule`,
      );
    }
    return out;
  }

  private emptyResult(reason: string): ScheduleResult {
    return {
      scheduled: [],
      feasibility: {
        status: 'infeasible',
        earliestForwardFinish: null,
        overflowDays: 0,
        reason,
      },
    };
  }

  private stripTime(d: Date): Date {
    // All stored Task date columns are @db.Date — Prisma returns a
    // midnight-UTC Date for them. Use UTC getters so a running
    // timezone (positive OR negative) can't shift the date by a day.
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
}

// ─── pure helpers (exported for tests) ──────────────────────────────

/**
 * Walk back `nWorkingDays` working days from `from`, counting
 * INCLUSIVELY: `from` (snapped back to the last working day on or
 * before it) is day 1. Returns day N.
 */
export function walkWorkingDaysBack(
  from: Date,
  nWorkingDays: number,
  isWorkingDay: (d: Date) => boolean,
): Date {
  if (nWorkingDays <= 1) {
    return snapToWorkingDayBack(from, isWorkingDay);
  }
  const cursor = snapToWorkingDayBack(from, isWorkingDay);
  let stepsRemaining = nWorkingDays - 1;
  // Bound the loop against pathological inputs — nWorkingDays × 7 is a
  // safe ceiling because at most 2 of every 7 days are rest + sparse
  // holidays.
  const hardCap = nWorkingDays * 7 + 32;
  let iter = 0;
  while (stepsRemaining > 0 && iter++ < hardCap) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (isWorkingDay(cursor)) stepsRemaining--;
  }
  return cursor;
}

/**
 * Walk forward `nWorkingDays` working days from `from`, counting
 * INCLUSIVELY: `from` (snapped forward to the next working day on or
 * after it) is day 1. Returns day N.
 */
export function walkWorkingDaysForward(
  from: Date,
  nWorkingDays: number,
  isWorkingDay: (d: Date) => boolean,
): Date {
  if (nWorkingDays <= 1) {
    return snapToWorkingDayForward(from, isWorkingDay);
  }
  const cursor = snapToWorkingDayForward(from, isWorkingDay);
  let stepsRemaining = nWorkingDays - 1;
  const hardCap = nWorkingDays * 7 + 32;
  let iter = 0;
  while (stepsRemaining > 0 && iter++ < hardCap) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isWorkingDay(cursor)) stepsRemaining--;
  }
  return cursor;
}

export function snapToWorkingDayBack(from: Date, isWorkingDay: (d: Date) => boolean): Date {
  const cursor = new Date(from.getTime());
  let iter = 0;
  while (!isWorkingDay(cursor) && iter++ < 32) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return cursor;
}

export function snapToWorkingDayForward(from: Date, isWorkingDay: (d: Date) => boolean): Date {
  const cursor = new Date(from.getTime());
  let iter = 0;
  while (!isWorkingDay(cursor) && iter++ < 32) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return cursor;
}

/**
 * Compute `WorkSchedule`-defined daily minutes:
 *   shiftEnd(HH:MM) − shiftStart(HH:MM) − breakMinutes.
 * Negative or malformed rows clamp to 0 (the caller then falls back
 * to `dailyStandardHours × 60`).
 *
 * Why `WorkSchedule.shiftStart/shiftEnd` are strings: they're stored
 * as "HH:MM" per schema. We parse defensively — a stray value becomes
 * 0 minutes, which triggers the fallback.
 */
export function resolveWorkScheduleDailyMinutes(ws: {
  shiftStart: string;
  shiftEnd: string;
  breakMinutes: number;
}): number {
  const parseHM = (s: string | null | undefined): number => {
    if (!s) return 0;
    const [h, m] = s.split(':').map((x) => parseInt(x, 10));
    if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
    return (h || 0) * 60 + (m || 0);
  };
  const start = parseHM(ws.shiftStart);
  const end = parseHM(ws.shiftEnd);
  const breakM = Number.isFinite(ws.breakMinutes) ? ws.breakMinutes : 0;
  return Math.max(0, end - start - breakM);
}

/**
 * Return the first working day STRICTLY BEFORE `from`. Used by D1
 * (gap = 1 working day) in the backward pass: predecessor's endDate =
 * prevWorkingDay(successor.startDate). The existing
 * `walkWorkingDaysBack(_, 1, _)` returns `from` itself (inclusive), so
 * we need this exclusive variant.
 */
export function prevWorkingDay(from: Date, isWorkingDay: (d: Date) => boolean): Date {
  const cursor = new Date(from.getTime());
  let iter = 0;
  do {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    iter++;
  } while (!isWorkingDay(cursor) && iter < 32);
  return cursor;
}

/**
 * Return the first working day STRICTLY AFTER `from`. Used by D1 in
 * the forward pass: successor's earliestStart = nextWorkingDay(
 * predecessor.earliestFinish). Exclusive counterpart to
 * `snapToWorkingDayForward`.
 */
export function nextWorkingDay(from: Date, isWorkingDay: (d: Date) => boolean): Date {
  const cursor = new Date(from.getTime());
  let iter = 0;
  do {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    iter++;
  } while (!isWorkingDay(cursor) && iter < 32);
  return cursor;
}
