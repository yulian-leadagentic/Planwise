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
