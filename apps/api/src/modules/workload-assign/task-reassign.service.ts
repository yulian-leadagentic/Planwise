import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { isAdminUser } from '../../common/guards/roles.guard';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { isInternalEmployee } from '../../common/people/internal-employee';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { EmployeeScopeService, VisibleUserIds, isUserVisible } from '../../common/services/employee-scope.service';
import { LIVE_PREDECESSOR_EDGE, LIVE_SUCCESSOR_EDGE } from '../../common/task-dependency-filters';
import { NotificationsService } from '../notifications/notifications.service';
import { AssignmentPlan, TaskAssigneePolicyService } from '../tasks/task-assignee-policy.service';
import { ExecutionPlanningService, resolveTeamRange } from '../execution-planning/execution-planning.service';
import {
  MAX_MOVE_SPAN_DAYS,
  MoveDates,
  OrgCalendar,
  buildOrgCalendar,
  departmentOf,
  dowOf,
  fromDayProblem,
  isOrgWorkingDay,
  isValidYmd,
  keyOf,
  normalizeIdList,
  parseYmd,
  planMoveDates,
  providesService,
  resolveEffectiveServiceId,
  round2,
} from '../execution-planning/workload-engine';
import { loadOrgCalendar, todayKey } from '../execution-planning/workload-loader';
import {
  REQUEST_LIST_CAP,
  REQUEST_SELECT,
  ReassignmentRequest,
  UNDO_WINDOW_MS,
  decidableWhere,
  personName,
  shapeReassignmentRequest,
} from '../execution-planning/workload-assign';
import { REALTIME_INVALIDATE } from '../realtime/realtime.events';

/** Body of POST /tasks/:id/reassign (validated by hand: the web sends nulls). */
export interface ReassignBody {
  fromUserId?: unknown;
  toUserId?: unknown;
  fromDay?: unknown;
  toDay?: unknown;
  view?: { from?: unknown; to?: unknown } | null;
}

export interface ReassignWarning {
  code: 'PREDECESSOR_OVERLAP' | 'SUCCESSOR_OVERLAP';
  taskId: number;
  message: string;
}

type Actor = { id: number } & Record<string, any>;

interface Move {
  fromUserId: number | null;
  toUserId: number | null;
  fromDay: string | null;
  toDay: string | null;
}

interface PersonRow {
  id: number;
  firstName: string | null;
  lastName: string | null;
  orgUnitId: number | null;
  businessPartnerId: number | null;
  isActive: boolean;
}

/** Everything a move needs, validated, before anything is written. */
interface MovePlan {
  task: any;
  projectId: number;
  move: Move;
  /** Live assignee ids when the plan was made. */
  liveBefore: number[];
  dates: MoveDates;
  /** A leaves the task (A → B or A → tray). */
  removesFrom: boolean;
  /** QA6 assignee policy for B (null when B is not newly added). */
  plan: AssignmentPlan | null;
  names: Map<number, string>;
  fromDept: { id: number; name: string } | null;
  toDept: { id: number; name: string } | null;
  crossDepartment: boolean;
}

const CLOSED_STATUSES = ['completed', 'cancelled'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const TASK_SELECT = {
  id: true,
  code: true,
  name: true,
  projectId: true,
  isPersonal: true,
  isArchived: true,
  status: true,
  budgetHours: true,
  estimatedStartDate: true,
  startDate: true,
  endDate: true,
  dueDateOverridden: true,
  phaseId: true,
  projectDeliverable: { select: { serviceId: true } },
  deliverableTemplate: { select: { phaseId: true } },
  project: { select: { name: true, leaderId: true } },
  assignees: { where: { deletedAt: null }, select: { userId: true } },
} as const;

/** "Mon 23/11". */
function fmtDay(key: string | null): string {
  if (!key) return '';
  return `${DOW[dowOf(key)]} ${key.slice(8, 10)}/${key.slice(5, 7)}`;
}

/** "Mon 23/11" for one day, "22/11-24/11" for a range. */
function fmtWindow(start: string | null, end: string | null): string {
  if (!end) return 'no dates';
  const s = start ?? end;
  return s === end ? fmtDay(end) : `${s.slice(8, 10)}/${s.slice(5, 7)}-${end.slice(8, 10)}/${end.slice(5, 7)}`;
}

const dateOrNull = (key: string | null): Date | null => (key ? parseYmd(key) : null);
const sortIds = (ids: Iterable<number>) => [...new Set([...ids].map(Number))].sort((a, b) => a - b);
const sameIds = (a: Iterable<number>, b: Iterable<number>) => JSON.stringify(sortIds(a)) === JSON.stringify(sortIds(b));
const taskLabel = (t: { code?: string | null; name?: string | null }) => (t.code ? `${t.code} ${t.name ?? ''}`.trim() : t.name ?? 'Task');

function stale(message: string): ConflictException {
  return new ConflictException({ code: 'REASSIGN_STALE', message });
}

function notPending(status: string): ConflictException {
  return new ConflictException({
    code: 'REASSIGN_NOT_PENDING',
    message: `This request is no longer waiting for a decision (it is ${status}).`,
  });
}

function notAllowed(message: string): PermissionDeniedException {
  return new PermissionDeniedException(message, { module: 'tasks', reason: 'REASSIGN_NOT_ALLOWED' });
}

/**
 * Review 2 (A1): the first statement of every transaction that compares
 * the task's live assignees (a move, an undo). It locks the task row, so
 * two of them on the same task (two tray drops at once) run one after
 * the other: the second waits for the first to commit, then reads the
 * assignees it wrote and fails its compare (409). Without it, both read
 * "nobody assigned" and both write a different (task, user) row. An
 * insert into task_assignees (POST /tasks/:id/assignees) checks its
 * foreign key against this row too, so it waits for the move as well.
 */
async function lockTaskRow(tx: any, taskId: number): Promise<void> {
  await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${taskId} FOR UPDATE`;
}

/**
 * QA6 package 4 (PR-063) — drag-and-drop task assignment in
 * Operations › Workload. Locked spec: docs/bm2/qa6-pr063-locked-spec.md;
 * rules R1–R10 in qa6-pr063-research.md.
 *
 *   • POST /tasks/:id/reassign — one move: A → B (replace, not add; R2),
 *     a day move in A's lane (D5), tray → B (D6) or A → tray. Written in
 *     ONE transaction (R1) with a compare-and-set on A's live assignment
 *     (409 REASSIGN_STALE). The QA6 assignee policy decides B
 *     (planAssignment before, applyTeamAdd inside the transaction), the
 *     Qualifications gate decides the service (422 SERVICE_NOT_PROVIDED).
 *     A move to another top-level department (D1) becomes a pending
 *     request unless the actor is an Admin or in B's manager chain (D3);
 *     tray moves never wait (D4).
 *   • /workload/reassignments — list, approve (re-validated: the
 *     requester's own right to the move checked again, the policy
 *     re-planned with the REQUESTER as actor), reject, undo (D9: the actor
 *     or an Admin, 15 minutes, only while the task still equals the
 *     post-move snapshot, the actor's drag right and the Team rule for
 *     whoever gets the task back checked again; undo of a pending
 *     request = cancel).
 *
 * It never calls TasksService.addAssignee / removeAssignee: those are two
 * separate writes with an activity line each. One activity line per user
 * action instead (research §7); B still gets the usual assignment
 * notification through `task.assignee.added`.
 */
@Injectable()
export class TaskReassignService {
  private readonly logger = new Logger(TaskReassignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly employeeScope: EmployeeScopeService,
    private readonly policy: TaskAssigneePolicyService,
    private readonly eps: ExecutionPlanningService,
    private readonly activityLog: ActivityLogService,
    private readonly notifications: NotificationsService,
    private readonly events: EventEmitter2,
  ) {}

  // ─── POST /tasks/:id/reassign ──────────────────────────────────────────

  async reassign(user: Actor, taskId: number, body: ReassignBody) {
    const isAdmin = isAdminUser(user);
    const move = this.parseMove(body);
    const view = this.parseView(body?.view);
    if (move.fromUserId == null && move.toUserId == null) {
      throw new BadRequestException({ code: 'REASSIGN_NOOP', message: 'Choose the person the task moves from or to.' });
    }

    await this.access.assertTaskAccess(user.id, taskId, isAdmin);
    const task = await this.loadTask(taskId);
    this.assertMovable(task);
    await this.assertCanDrag(user, isAdmin, task.projectId, move.fromUserId);
    await this.assertNoPending(taskId);

    const mp = await this.prepare(task, move, user);
    const visible = await this.employeeScope.visibleUserIds(user);

    // D1 / D3 — another top-level department waits for its manager,
    // unless the actor is an Admin or would approve it himself.
    if (mp.crossDepartment) {
      const skip = isAdmin || (await this.employeeScope.isInManagerChain(user.id, mp.move.toUserId as number));
      if (!skip) return this.createPending(user, mp, view, visible);
    }

    const row = await this.applyMove(mp, { actorId: user.id });
    const actorName = await this.nameOf(user.id);
    await this.afterApplied(mp, row, { eventActorId: user.id, eventActorName: actorName, teamActor: user });
    await this.activityLog.logTaskReassignment({
      action: 'reassign',
      actorUserId: user.id,
      projectId: mp.projectId,
      entityId: mp.task.id,
      taskName: mp.task.name,
      description: this.describeMove(mp),
      changes: this.changesOf(mp),
      metadata: { via: 'workload', reassignmentId: row.id },
    });
    await this.notifyRemoved(mp, row, actorName, null);
    return this.moveResponse('applied', mp, row, user, view, visible);
  }

  // ─── /workload/reassignments ──────────────────────────────────────────

  async list(user: Actor, q: { status?: string; as?: string }): Promise<ReassignmentRequest[]> {
    const as = q.as == null || q.as === '' ? 'approver' : q.as;
    if (as !== 'approver' && as !== 'requester') {
      throw new BadRequestException({ code: 'REASSIGN_LIST_INVALID', message: 'as must be one of: approver, requester.' });
    }
    const statuses = ['pending', 'applied', 'approved', 'rejected', 'cancelled', 'undone', 'failed'];
    const status = q.status == null || q.status === '' ? 'pending' : q.status;
    if (status !== 'all' && !statuses.includes(status)) {
      throw new BadRequestException({
        code: 'REASSIGN_LIST_INVALID',
        message: `status must be one of: all, ${statuses.join(', ')}.`,
      });
    }
    const isAdmin = isAdminUser(user);
    let where: any;
    if (as === 'requester') {
      where = { actorId: user.id };
    } else if (isAdmin) {
      where = {};
    } else {
      const scope = await this.eps.loadAssignScope({ id: user.id, isAdmin });
      const decide = decidableWhere({ id: user.id, isAdmin }, scope.managedUserIds);
      where = { OR: [...decide.OR, { decidedById: user.id }] };
    }
    if (status !== 'all') where.status = status;
    const rows = await this.prisma.taskReassignment.findMany({
      where,
      select: REQUEST_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: REQUEST_LIST_CAP,
    });
    return (rows as any[]).map(shapeReassignmentRequest);
  }

  async approve(user: Actor, id: number, body: { view?: any } = {}) {
    const row = await this.loadRow(id);
    if (row.status !== 'pending') throw notPending(row.status);
    await this.assertCanDecide(user, row);
    const view = this.parseView(body?.view);
    const requester: Actor = { id: row.actorId, isAdmin: await this.isAdminUserId(row.actorId) };

    let mp: MovePlan;
    let applied: any;
    try {
      const task = await this.loadTask(row.taskId);
      this.assertMovable(task);
      await this.assertNoPending(row.taskId, row.id);
      // Review 2 (A2): the move is still the requester's, so he must still
      // be allowed to make it (he may have lost the project or the person).
      await this.assertRequesterMayMove(row, requester, task);
      mp = await this.prepare(
        task,
        { fromUserId: row.fromUserId, toUserId: row.toUserId, fromDay: keyOf(row.fromDay), toDay: keyOf(row.toDay) },
        requester,
        { approving: true },
      );
      // The request was cross-department when it was made; it is being approved now.
      mp.crossDepartment = row.crossDepartment === true;
      applied = await this.applyMove(mp, { actorId: row.actorId, approveRowId: row.id, decidedById: user.id });
    } catch (err) {
      const code = (err as any)?.getResponse?.()?.code;
      if (err instanceof HttpException && code !== 'REASSIGN_NOT_PENDING') await this.markFailed(row, user, err);
      throw err;
    }

    const [requesterName, deciderName] = await Promise.all([this.nameOf(row.actorId), this.nameOf(user.id)]);
    await this.afterApplied(mp, applied, { eventActorId: row.actorId, eventActorName: requesterName, teamActor: requester });
    await this.activityLog.logTaskReassignment({
      action: 'reassign_approve',
      actorUserId: user.id,
      projectId: mp.projectId,
      entityId: mp.task.id,
      taskName: mp.task.name,
      description: `Approved moving ${this.moveText(mp)}, requested by ${requesterName}`,
      changes: this.changesOf(mp),
      metadata: { via: 'workload', reassignmentId: row.id },
    });
    if (row.actorId !== user.id) {
      await this.notify({
        userId: row.actorId,
        type: 'reassign_result',
        title: `Approved: ${taskLabel(mp.task)} moved to ${this.nameIn(mp, mp.move.toUserId)}`,
        body: `${deciderName} approved moving ${this.moveText(mp)}.`,
        row: applied,
        mp,
        actorId: user.id,
        status: 'approved',
      });
    }
    await this.notifyRemoved(mp, applied, requesterName, deciderName);
    this.invalidate(mp.projectId, mp.task.id);
    const visible = await this.employeeScope.visibleUserIds(user);
    return this.moveResponse('approved', mp, applied, user, view, visible);
  }

  async reject(user: Actor, id: number, body: { note?: unknown } = {}) {
    const row = await this.loadRow(id);
    if (row.status !== 'pending') throw notPending(row.status);
    await this.assertCanDecide(user, row);
    const note = this.parseNote(body?.note);
    const done = await this.prisma.taskReassignment.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'rejected', pendingTaskId: null, decidedById: user.id, decidedAt: new Date(), decisionNote: note },
    });
    if (done.count === 0) throw notPending('decided');
    const updated = await this.loadRow(id);
    const deciderName = await this.nameOf(user.id);
    const text = this.requestText(updated);
    await this.activityLog.logTaskReassignment({
      action: 'reassign_reject',
      actorUserId: user.id,
      projectId: updated.projectId,
      entityId: updated.taskId,
      taskName: updated.task?.name ?? '',
      description: `Rejected moving ${text}, requested by ${personName(updated.actor)}${note ? `. Note: ${note}` : ''}`,
      changes: { fromUserId: updated.fromUserId, toUserId: updated.toUserId },
      metadata: { via: 'workload', reassignmentId: id },
    });
    if (updated.actorId !== user.id) {
      await this.notify({
        userId: updated.actorId,
        type: 'reassign_result',
        title: `Rejected: ${taskLabel(updated.task ?? {})} stays with ${personName(updated.fromUser)}`,
        body: `${deciderName} rejected moving ${text}.${note ? ` Note: ${note}` : ''}`,
        row: updated,
        actorId: user.id,
        status: 'rejected',
      });
    }
    this.invalidate(updated.projectId, updated.taskId);
    return { result: 'rejected' as const, reassignment: shapeReassignmentRequest(updated) };
  }

  async undo(user: Actor, id: number, body: { view?: any } = {}) {
    const row = await this.loadRow(id);
    const isAdmin = isAdminUser(user);
    const view = this.parseView(body?.view);
    const visible = await this.employeeScope.visibleUserIds(user);

    if (row.status === 'pending') return this.cancel(user, row, isAdmin, view, visible);
    if (row.status !== 'applied' && row.status !== 'approved') {
      throw new ConflictException({ code: 'UNDO_STALE', message: `This move can no longer be undone (it is ${row.status}).` });
    }
    // D9: the actor (for an approved request, the person who asked) or an
    // Admin. The approver is neither (review 2, A3).
    if (!isAdmin && row.actorId !== user.id) {
      throw notAllowed('Only the person who made this move or an administrator can undo it.');
    }
    const appliedAt = new Date(row.status === 'approved' ? row.decidedAt ?? row.createdAt : row.createdAt).getTime();
    if (Date.now() - appliedAt > UNDO_WINDOW_MS) {
      throw new ConflictException({
        code: 'UNDO_STALE',
        message: 'The 15 minutes to undo this move have passed.',
        details: { reason: 'UNDO_EXPIRED' },
      });
    }

    const prevIds = normalizeIdList(row.prevAssigneeIds);
    const newIds = normalizeIdList(row.newAssigneeIds);
    // Review 2 (A4): an undo is a move too. The actor must still be allowed
    // to move A's chip, and whoever gets the task back must still be an
    // active employee on the project Team (the transaction below requires
    // the live assignees to equal `newIds`, so these are the ones re-added).
    if (!isAdmin) {
      await this.access.assertTaskAccess(user.id, row.taskId, false);
      await this.assertCanDrag(user, false, row.projectId, row.fromUserId);
    }
    await this.assertCanGiveBack(row.projectId, prevIds.filter((uid) => !newIds.includes(uid)));
    const now = new Date();
    const changedStale = () =>
      new ConflictException({
        code: 'UNDO_STALE',
        message: 'The task changed after this move, so it cannot be undone. Refresh the board.',
      });
    await this.prisma.$transaction(async (tx: any) => {
      await lockTaskRow(tx, row.taskId);
      const task = await tx.task.findFirst({
        where: { id: row.taskId, deletedAt: null },
        select: { id: true, status: true, isArchived: true, estimatedStartDate: true, endDate: true, dueDateOverridden: true },
      });
      if (!task || task.isArchived || CLOSED_STATUSES.includes(task.status)) throw changedStale();
      const live = (await tx.taskAssignee.findMany({ where: { taskId: row.taskId, deletedAt: null }, select: { userId: true } }))
        .map((a: any) => a.userId);
      const same =
        sameIds(live, newIds) &&
        keyOf(task.estimatedStartDate) === keyOf(row.newEstimatedStartDate) &&
        keyOf(task.endDate) === keyOf(row.newEndDate) &&
        task.dueDateOverridden === row.newDueDateOverridden;
      if (!same) throw changedStale();

      for (const uid of prevIds) {
        if (live.includes(uid)) continue;
        await tx.taskAssignee.upsert({
          where: { taskId_userId: { taskId: row.taskId, userId: uid } },
          create: { taskId: row.taskId, userId: uid },
          update: { deletedAt: null },
        });
      }
      for (const uid of live) {
        if (prevIds.includes(uid)) continue;
        const r = await tx.taskAssignee.updateMany({
          where: { taskId: row.taskId, userId: uid, deletedAt: null },
          data: { deletedAt: now },
        });
        if (r.count === 0) throw changedStale();
      }
      const datesDiffer =
        keyOf(row.prevEstimatedStartDate) !== keyOf(row.newEstimatedStartDate) ||
        keyOf(row.prevEndDate) !== keyOf(row.newEndDate) ||
        row.prevDueDateOverridden !== row.newDueDateOverridden;
      if (datesDiffer) {
        const r = await tx.task.updateMany({
          where: {
            id: row.taskId,
            deletedAt: null,
            estimatedStartDate: row.newEstimatedStartDate ?? null,
            endDate: row.newEndDate ?? null,
            dueDateOverridden: row.newDueDateOverridden,
          },
          data: {
            estimatedStartDate: row.prevEstimatedStartDate ?? null,
            endDate: row.prevEndDate ?? null,
            dueDateOverridden: row.prevDueDateOverridden,
          },
        });
        if (r.count === 0) throw changedStale();
      }
      const r = await tx.taskReassignment.updateMany({
        where: { id: row.id, status: row.status },
        data: { status: 'undone' },
      });
      if (r.count === 0) throw changedStale();
    });

    const updated = await this.loadRow(id);
    const datesText =
      keyOf(row.prevEndDate) !== keyOf(row.newEndDate) || keyOf(row.prevEstimatedStartDate) !== keyOf(row.newEstimatedStartDate)
        ? `; dates back to ${fmtWindow(keyOf(row.prevEstimatedStartDate), keyOf(row.prevEndDate))}`
        : '';
    await this.activityLog.logTaskReassignment({
      action: 'reassign_undo',
      actorUserId: user.id,
      projectId: row.projectId,
      entityId: row.taskId,
      taskName: row.task?.name ?? '',
      description: `Undid ${this.undoText(row)}${datesText}`,
      changes: {
        fromUserId: row.fromUserId,
        toUserId: row.toUserId,
        prev: { start: keyOf(row.newEstimatedStartDate), end: keyOf(row.newEndDate) },
        next: { start: keyOf(row.prevEstimatedStartDate), end: keyOf(row.prevEndDate) },
      },
      metadata: { via: 'workload', reassignmentId: row.id },
    });
    this.invalidate(row.projectId, row.taskId);
    return {
      result: 'undone' as const,
      reassignment: shapeReassignmentRequest(updated),
      task: await this.taskSnapshot(row.taskId),
      people: await this.peopleFor(user, [row.fromUserId, row.toUserId], view, keyOf(row.toDay) ?? keyOf(row.fromDay), visible),
    };
  }

  // ─── Pending requests ──────────────────────────────────────────────────

  private async createPending(user: Actor, mp: MovePlan, view: { from: string; to: string } | null, visible: VisibleUserIds) {
    const approver = await this.resolveApprover(mp.toDept);
    let row: any;
    try {
      row = await this.prisma.taskReassignment.create({
        data: {
          ...this.snapshotData(mp, mp.liveBefore),
          actorId: user.id,
          status: 'pending',
          pendingTaskId: mp.task.id,
          approverUserId: approver?.id ?? null,
          addedToTeam: false,
        },
        select: REQUEST_SELECT,
      });
    } catch (err) {
      if ((err as any)?.code === 'P2002') throw this.pendingConflict();
      throw err;
    }
    const requesterName = await this.nameOf(user.id);
    const approverText = approver ? approver.name : 'an administrator';
    await this.activityLog.logTaskReassignment({
      action: 'reassign_request',
      actorUserId: user.id,
      projectId: mp.projectId,
      entityId: mp.task.id,
      taskName: mp.task.name,
      description: `Asked to move ${this.moveText(mp)}, waiting for approval by ${approverText}`,
      changes: this.changesOf(mp),
      metadata: { via: 'workload', reassignmentId: row.id },
    });
    const recipients = approver ? [approver.id] : await this.adminUserIds();
    const hours = round2(Number(mp.task.budgetHours ?? 0) || 0);
    for (const uid of recipients) {
      if (uid === user.id) continue;
      await this.notify({
        userId: uid,
        type: 'reassign_request',
        title: `Approval needed: move ${taskLabel(mp.task)} to ${this.nameIn(mp, mp.move.toUserId)}`,
        body: `${requesterName} asked to move ${taskLabel(mp.task)} (${mp.task.project?.name ?? 'project'}, ${hours}h) from ${this.nameIn(mp, mp.move.fromUserId)} to ${this.nameIn(mp, mp.move.toUserId)}.`,
        row,
        mp,
        actorId: user.id,
        status: 'pending',
      });
    }
    return this.moveResponse('pending', mp, row, user, view, visible);
  }

  private async cancel(user: Actor, row: any, isAdmin: boolean, view: { from: string; to: string } | null, visible: VisibleUserIds) {
    if (row.actorId !== user.id && !isAdmin) {
      throw notAllowed('Only the person who asked for this move or an administrator can cancel it.');
    }
    const done = await this.prisma.taskReassignment.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'cancelled', pendingTaskId: null, decidedById: user.id, decidedAt: new Date() },
    });
    if (done.count === 0) {
      throw new ConflictException({ code: 'UNDO_STALE', message: 'This request was already decided, so it cannot be cancelled.' });
    }
    const updated = await this.loadRow(row.id);
    const actorName = await this.nameOf(user.id);
    const text = this.requestText(updated);
    await this.activityLog.logTaskReassignment({
      action: 'reassign_cancel',
      actorUserId: user.id,
      projectId: updated.projectId,
      entityId: updated.taskId,
      taskName: updated.task?.name ?? '',
      description: `Cancelled the request to move ${text}`,
      changes: { fromUserId: updated.fromUserId, toUserId: updated.toUserId },
      metadata: { via: 'workload', reassignmentId: row.id },
    });
    const recipients = updated.approverUserId != null ? [updated.approverUserId] : await this.adminUserIds();
    for (const uid of recipients) {
      if (uid === user.id) continue;
      await this.notify({
        userId: uid,
        type: 'reassign_result',
        title: `Cancelled: move of ${taskLabel(updated.task ?? {})}`,
        body: `${actorName} cancelled the request to move ${text}.`,
        row: updated,
        actorId: user.id,
        status: 'cancelled',
      });
    }
    this.invalidate(updated.projectId, updated.taskId);
    return {
      result: 'cancelled' as const,
      reassignment: shapeReassignmentRequest(updated),
      task: await this.taskSnapshot(updated.taskId),
      people: await this.peopleFor(user, [updated.fromUserId, updated.toUserId], view, keyOf(updated.toDay) ?? keyOf(updated.fromDay), visible),
    };
  }

  private async markFailed(row: any, user: Actor, err: HttpException): Promise<void> {
    const reason = String((err.getResponse() as any)?.message ?? err.message ?? 'The task changed.').slice(0, 500);
    try {
      const done = await this.prisma.taskReassignment.updateMany({
        where: { id: row.id, status: 'pending' },
        data: { status: 'failed', pendingTaskId: null, decidedById: user.id, decidedAt: new Date(), decisionNote: reason },
      });
      if (done.count === 0) return;
      const updated = await this.loadRow(row.id);
      if (updated.actorId !== user.id) {
        await this.notify({
          userId: updated.actorId,
          type: 'reassign_result',
          title: `Could not move ${taskLabel(updated.task ?? {})}`,
          body: `${await this.nameOf(user.id)} approved moving ${this.requestText(updated)}, but it could not be applied: ${reason}`,
          row: updated,
          actorId: user.id,
          status: 'failed',
        });
      }
      this.invalidate(updated.projectId, updated.taskId);
    } catch (e) {
      this.logger.warn(`could not mark reassignment ${row.id} failed: ${(e as Error)?.message ?? e}`);
    }
  }

  // ─── The move ──────────────────────────────────────────────────────────

  /**
   * Validates the move against the task as it is now and plans the dates.
   * Writes nothing. `approving`: a stored request is being approved, so a
   * source day that is no longer one of the task's days means the task
   * changed since the request (409 stale), not a bad request.
   */
  private async prepare(task: any, rawMove: Move, policyActor: Actor, opts: { approving?: boolean } = {}): Promise<MovePlan> {
    const move: Move = {
      fromUserId: rawMove.fromUserId,
      toUserId: rawMove.toUserId,
      // From the tray there is no source column; back to the tray, no target day.
      fromDay: rawMove.fromUserId == null ? null : rawMove.fromDay,
      toDay: rawMove.toUserId == null ? null : rawMove.toDay,
    };
    const ids = sortIds([move.fromUserId, move.toUserId].filter((v): v is number => v != null));
    const [cal, people, units] = await Promise.all([
      loadOrgCalendar(this.prisma),
      this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, firstName: true, lastName: true, orgUnitId: true, businessPartnerId: true, isActive: true },
      }) as Promise<PersonRow[]>,
      this.prisma.orgUnit.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, parentId: true, path: true, managerUserId: true },
      }),
    ]);
    const byId = new Map(people.map((p) => [p.id, p]));
    const names = new Map(people.map((p) => [p.id, personName(p)]));
    for (const uid of ids) if (!byId.has(uid)) throw new NotFoundException(`User ${uid} not found`);
    const nameOf = (uid: number | null) => (uid == null ? '' : names.get(uid) ?? `User #${uid}`);

    if (move.toDay && !isOrgWorkingDay(move.toDay, cal)) {
      throw new BadRequestException({
        code: 'REASSIGN_INVALID_DAY',
        message: `${fmtDay(move.toDay)} is not a working day. Drop the task on a working day.`,
      });
    }
    if (move.fromDay) this.assertFromDay(task, move.fromDay, move.toDay, opts.approving === true);

    const live = sortIds((task.assignees ?? []).map((a: any) => a.userId));
    if (move.fromUserId != null && !live.includes(move.fromUserId)) {
      throw stale(`${nameOf(move.fromUserId)} is no longer assigned to this task. Refresh the board and try again.`);
    }
    if (move.fromUserId == null && live.length > 0) {
      throw stale('This task was assigned to someone meanwhile. Refresh the board and try again.');
    }

    const sameUser = move.fromUserId === move.toUserId;
    const dates = planMoveDates(task, move.fromDay, move.toDay, cal, todayKey());
    if (sameUser && !dates.changed) {
      throw new BadRequestException({ code: 'REASSIGN_NOOP', message: 'Nothing to change: the task is already there.' });
    }

    // B joins the task: the QA6 assignee policy, then the Qualifications gate.
    // B already on it (A → B merges): only A leaves, nothing to check for B.
    let plan: AssignmentPlan | null = null;
    if (move.toUserId != null && !sameUser && !live.includes(move.toUserId)) {
      plan = await this.policy.planAssignment(policyActor, task.projectId, move.toUserId);
      await this.assertProvidesService(task, byId.get(move.toUserId)!, nameOf(move.toUserId));
    }

    const unitsById = new Map<number, any>((units as any[]).map((u) => [u.id, u]));
    const deptOf = (p: PersonRow | undefined) => {
      if (!p || p.orgUnitId == null) return null;
      const d = departmentOf(unitsById.get(p.orgUnitId) ?? { id: p.orgUnitId, name: null, parentId: null, path: null }, unitsById);
      return d ? { id: d.id, name: String(d.name ?? ''), managerUserId: (d as any).managerUserId ?? null } : null;
    };
    const fromDept = move.fromUserId != null ? deptOf(byId.get(move.fromUserId)) : null;
    const toDept = move.toUserId != null ? deptOf(byId.get(move.toUserId)) : null;
    const crossDepartment =
      move.fromUserId != null && move.toUserId != null && !sameUser && (fromDept?.id ?? null) !== (toDept?.id ?? null);

    return {
      task,
      projectId: task.projectId,
      move,
      liveBefore: live,
      dates,
      removesFrom: move.fromUserId != null && !sameUser,
      plan,
      names,
      fromDept,
      toDept,
      crossDepartment,
    };
  }

  /** The prev / new snapshot columns of a task_reassignments row. */
  private snapshotData(mp: MovePlan, liveBefore: number[]) {
    const t = mp.task;
    const next = new Set(liveBefore);
    if (mp.removesFrom && mp.move.fromUserId != null) next.delete(mp.move.fromUserId);
    if (mp.move.toUserId != null) next.add(mp.move.toUserId);
    return {
      taskId: t.id,
      projectId: mp.projectId,
      fromUserId: mp.move.fromUserId,
      toUserId: mp.move.toUserId,
      fromDay: dateOrNull(mp.move.fromDay),
      toDay: dateOrNull(mp.move.toDay),
      prevAssigneeIds: sortIds(liveBefore),
      newAssigneeIds: sortIds(next),
      prevEstimatedStartDate: t.estimatedStartDate ?? null,
      prevEndDate: t.endDate ?? null,
      prevDueDateOverridden: t.dueDateOverridden === true,
      newEstimatedStartDate: mp.dates.changed ? dateOrNull(mp.dates.estimatedStartDate) : t.estimatedStartDate ?? null,
      newEndDate: mp.dates.changed ? dateOrNull(mp.dates.endDate) : t.endDate ?? null,
      // D8 — a date move from the board is a deliberate edit: keep it on the next scheduler run.
      newDueDateOverridden: mp.dates.changed ? true : t.dueDateOverridden === true,
      crossDepartment: mp.crossDepartment,
      fromOrgUnitId: mp.fromDept?.id ?? null,
      toOrgUnitId: mp.toDept?.id ?? null,
    };
  }

  /**
   * R1 — the whole move in ONE transaction, the task row locked first
   * (lockTaskRow), then the live assignees re-read and compared with the
   * plan: the Team role (when the
   * policy adds B), A's assignment off (compare-and-set: 0 rows = stale),
   * B's on (re-activating a removed row), the dates (compare-and-set on
   * the values the plan read), and the task_reassignments row. A throw
   * anywhere rolls all of it back.
   */
  private async applyMove(
    mp: MovePlan,
    opts: { actorId: number; approveRowId?: number; decidedById?: number },
  ): Promise<any> {
    const taskId = mp.task.id;
    const now = new Date();
    return this.prisma.$transaction(async (tx: any) => {
      await lockTaskRow(tx, taskId);
      const live = sortIds(
        (await tx.taskAssignee.findMany({ where: { taskId, deletedAt: null }, select: { userId: true } })).map((a: any) => a.userId),
      );
      if (mp.move.fromUserId == null && live.length > 0) {
        throw stale('This task was assigned to someone meanwhile. Refresh the board and try again.');
      }
      if (mp.move.fromUserId != null && !live.includes(mp.move.fromUserId)) {
        throw stale(`${this.nameIn(mp, mp.move.fromUserId)} is no longer assigned to this task. Refresh the board and try again.`);
      }
      const addsTo = mp.move.toUserId != null && !live.includes(mp.move.toUserId);
      // B was already on the task when the move was planned (so the policy
      // was not asked) and has been removed since: plan again, from scratch.
      if (addsTo && !mp.plan) throw stale("The task's assignees changed meanwhile. Refresh the board and try again.");
      if (addsTo && mp.plan?.needsTeamAdd) await this.policy.applyTeamAdd(mp.plan, tx);
      if (mp.removesFrom) {
        const off = await tx.taskAssignee.updateMany({
          where: { taskId, userId: mp.move.fromUserId, deletedAt: null },
          data: { deletedAt: now },
        });
        if (off.count === 0) {
          throw stale(`${this.nameIn(mp, mp.move.fromUserId)} is no longer assigned to this task. Refresh the board and try again.`);
        }
      }
      if (addsTo) {
        await tx.taskAssignee.upsert({
          where: { taskId_userId: { taskId, userId: mp.move.toUserId } },
          create: { taskId, userId: mp.move.toUserId },
          update: { deletedAt: null },
        });
      }
      if (mp.dates.changed) {
        const moved = await tx.task.updateMany({
          where: {
            id: taskId,
            deletedAt: null,
            estimatedStartDate: mp.task.estimatedStartDate ?? null,
            endDate: mp.task.endDate ?? null,
            dueDateOverridden: mp.task.dueDateOverridden === true,
          },
          data: {
            estimatedStartDate: dateOrNull(mp.dates.estimatedStartDate),
            endDate: dateOrNull(mp.dates.endDate),
            dueDateOverridden: true,
          },
        });
        if (moved.count === 0) throw stale("The task's dates changed meanwhile. Refresh the board and try again.");
      }
      const data = {
        ...this.snapshotData(mp, live),
        addedToTeam: addsTo && mp.plan?.needsTeamAdd === true,
      };
      if (opts.approveRowId != null) {
        const done = await tx.taskReassignment.updateMany({
          where: { id: opts.approveRowId, status: 'pending' },
          data: { ...data, status: 'approved', pendingTaskId: null, decidedById: opts.decidedById ?? null, decidedAt: now },
        });
        if (done.count === 0) throw notPending('decided');
        return tx.taskReassignment.findFirst({ where: { id: opts.approveRowId }, select: REQUEST_SELECT });
      }
      return tx.taskReassignment.create({
        data: { ...data, actorId: opts.actorId, status: 'applied' },
        select: REQUEST_SELECT,
      });
    });
  }

  /** After the commit: B's assignment event (notification, thread line, realtime) and the Team audit line. */
  private async afterApplied(
    mp: MovePlan,
    row: any,
    who: { eventActorId: number; eventActorName: string; teamActor: Actor },
  ): Promise<void> {
    const prev = normalizeIdList(row?.prevAssigneeIds);
    const to = mp.move.toUserId;
    if (to != null && !prev.includes(to)) {
      this.events.emit('task.assignee.added', {
        taskId: mp.task.id,
        userId: who.eventActorId,
        assigneeId: to,
        userName: who.eventActorName || 'System',
        assigneeName: this.nameIn(mp, to),
      });
      if (row?.addedToTeam && mp.plan) await this.policy.logTeamAdd(who.teamActor, mp.plan, mp.task.id);
    }
  }

  /** D10 — the person who lost the task hears about it (not when he moved it himself). */
  private async notifyRemoved(mp: MovePlan, row: any, actorName: string, approvedBy: string | null): Promise<void> {
    const from = mp.move.fromUserId;
    if (!mp.removesFrom || from == null || from === row?.actorId) return;
    const canOpen = await this.access.userHasProjectAccess(from, mp.projectId).catch(() => false);
    const what = canOpen ? taskLabel(mp.task) : 'A task you were assigned to';
    const to = mp.move.toUserId;
    const title =
      to != null
        ? `${what} was moved to ${this.nameIn(mp, to)} by ${actorName}`
        : `${what} was unassigned from you by ${actorName}`;
    await this.notify({
      userId: from,
      type: 'reassign_removed',
      title,
      body: approvedBy ? `Approved by ${approvedBy}.` : undefined,
      row,
      mp,
      actorId: row?.actorId ?? undefined,
      status: row?.status ?? 'applied',
    });
  }

  // ─── Response ──────────────────────────────────────────────────────────

  private async moveResponse(
    result: 'applied' | 'pending' | 'approved',
    mp: MovePlan,
    row: any,
    user: Actor,
    view: { from: string; to: string } | null,
    visible: VisibleUserIds,
  ) {
    const applied = result !== 'pending';
    const createdAt = new Date(result === 'approved' ? row.decidedAt ?? row.createdAt : row.createdAt).getTime();
    const [warnings, loggedStays, people, task] = await Promise.all([
      this.dependencyWarnings(mp.task.id, mp.dates),
      this.loggedStays(mp, user, visible),
      this.peopleFor(user, [mp.move.fromUserId, mp.move.toUserId], view, mp.move.toDay ?? mp.move.fromDay, visible),
      this.taskSnapshot(mp.task.id),
    ]);
    return {
      result,
      reassignment: {
        id: row.id,
        status: String(row.status),
        crossDepartment: row.crossDepartment === true,
        approver: row.approver ? { id: row.approver.id, name: personName(row.approver) } : null,
        undoUntil: new Date(createdAt + UNDO_WINDOW_MS).toISOString(),
      },
      task,
      changed: {
        assignee: applied && (mp.removesFrom || (mp.move.toUserId != null && mp.move.toUserId !== mp.move.fromUserId)),
        dates: applied && mp.dates.changed,
      },
      addedToTeam: applied && row.addedToTeam === true,
      loggedStays,
      warnings,
      people,
    };
  }

  private async taskSnapshot(taskId: number) {
    const t = await this.prisma.task.findFirst({
      where: { id: taskId },
      select: {
        id: true,
        estimatedStartDate: true,
        endDate: true,
        dueDateOverridden: true,
        assignees: { where: { deletedAt: null }, select: { userId: true } },
      },
    });
    return {
      id: taskId,
      assigneeIds: sortIds(((t as any)?.assignees ?? []).map((a: any) => a.userId)),
      estimatedStartDate: keyOf((t as any)?.estimatedStartDate),
      endDate: keyOf((t as any)?.endDate),
      dueDateOverridden: (t as any)?.dueDateOverridden === true,
    };
  }

  /** The removed person keeps his logged hours (research §6); hours only when the caller may see them. */
  private async loggedStays(mp: MovePlan, user: Actor, visible: VisibleUserIds) {
    const from = mp.move.fromUserId;
    if (!mp.removesFrom || from == null) return null;
    const sum = await this.prisma.timeEntry.aggregate({
      where: { taskId: mp.task.id, userId: from, deletedAt: null },
      _sum: { minutes: true },
    });
    const hours = Number(sum?._sum?.minutes ?? 0) / 60;
    if (!(hours > 0)) return null;
    const may = isUserVisible(visible, from) || mp.task.project?.leaderId === user.id;
    return { userId: from, name: this.nameIn(mp, from), hours: may ? round2(hours) : null };
  }

  /** R6 — after a date move, warn (never block) about a live open predecessor / successor that now overlaps. */
  private async dependencyWarnings(taskId: number, dates: MoveDates): Promise<ReassignWarning[]> {
    if (!dates.changed) return [];
    const start = dates.estimatedStartDate;
    const end = dates.endDate;
    const [preds, succs] = await Promise.all([
      this.prisma.taskDependency.findMany({
        where: { taskId, ...LIVE_PREDECESSOR_EDGE },
        select: { dependsOn: { select: { id: true, code: true, name: true, status: true, endDate: true, deletedAt: true } } },
      }),
      this.prisma.taskDependency.findMany({
        where: { dependsOnId: taskId, ...LIVE_SUCCESSOR_EDGE },
        select: {
          task: { select: { id: true, code: true, name: true, status: true, estimatedStartDate: true, startDate: true, deletedAt: true } },
        },
      }),
    ]);
    const open = (t: any) => t && t.deletedAt == null && !CLOSED_STATUSES.includes(t.status);
    const out: ReassignWarning[] = [];
    for (const p of (preds ?? []) as any[]) {
      const t = p.dependsOn;
      const pEnd = keyOf(t?.endDate);
      if (open(t) && pEnd && start && pEnd >= start) {
        out.push({ code: 'PREDECESSOR_OVERLAP', taskId: t.id, message: `${t.code || t.name} ends on or after the new start date` });
      }
    }
    for (const s of (succs ?? []) as any[]) {
      const t = s.task;
      const sStart = keyOf(t?.estimatedStartDate ?? t?.startDate);
      if (open(t) && sStart && end && sStart <= end) {
        out.push({ code: 'SUCCESSOR_OVERLAP', taskId: t.id, message: `${t.code || t.name} starts on or before the new end date` });
      }
    }
    return out;
  }

  /** TeamWorkloadPerson rows of the people a move touched, over `view` (or the drop day's work week). */
  private async peopleFor(
    user: Actor,
    ids: Array<number | null | undefined>,
    view: { from: string; to: string } | null,
    anchorDay: string | null,
    visible: VisibleUserIds,
  ): Promise<any[]> {
    const userIds = sortIds(ids.filter((v): v is number => v != null));
    if (userIds.length === 0) return [];
    const caller = { id: user.id, isAdmin: isAdminUser(user), visibleUserIds: visible };
    const q = view ? { from: view.from, to: view.to } : { weekOf: anchorDay ?? undefined };
    const out: any = await this.eps.getTeamWorkload(caller, q, { onlyUserIds: userIds });
    const order = ids.filter((v): v is number => v != null);
    const seen = new Set<number>();
    const rows: any[] = [];
    for (const id of order) {
      if (seen.has(id)) continue;
      seen.add(id);
      const p = (out?.people ?? []).find((x: any) => x.id === id);
      if (p) rows.push(p);
    }
    return rows;
  }

  // ─── Checks ────────────────────────────────────────────────────────────

  private parseMove(body: ReassignBody): Move {
    const id = (v: unknown, field: string): number | null => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new BadRequestException(`${field} must be a user id or null.`);
      return n;
    };
    const day = (v: unknown, field: string): string | null => {
      if (v === undefined || v === null || v === '') return null;
      if (!isValidYmd(v)) {
        throw new BadRequestException({ code: 'REASSIGN_INVALID_DAY', message: `${field} must be a date (YYYY-MM-DD).` });
      }
      return v;
    };
    return {
      fromUserId: id(body?.fromUserId, 'fromUserId'),
      toUserId: id(body?.toUserId, 'toUserId'),
      fromDay: day(body?.fromDay, 'fromDay'),
      toDay: day(body?.toDay, 'toDay'),
    };
  }

  /** `view` { from, to } as GET /workload/team takes it (both dates, at most 93 days), or null. */
  private parseView(raw: unknown): { from: string; to: string } | null {
    if (raw == null) return null;
    const v = raw as { from?: unknown; to?: unknown };
    if (typeof v !== 'object' || (v.from == null && v.to == null)) return null;
    const range = resolveTeamRange({ from: v.from as string, to: v.to as string }, buildOrgCalendar(undefined, []) as OrgCalendar, todayKey());
    return { from: range.from, to: range.to };
  }

  private parseNote(raw: unknown): string | null {
    if (raw == null) return null;
    if (typeof raw !== 'string') throw new BadRequestException('note must be text.');
    const note = raw.trim();
    if (note.length > 500) throw new BadRequestException('The note can be at most 500 characters.');
    return note || null;
  }

  private async loadTask(taskId: number): Promise<any> {
    const task = await this.prisma.task.findFirst({ where: { id: taskId, deletedAt: null }, select: TASK_SELECT });
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  private async loadRow(id: number): Promise<any> {
    const row = await this.prisma.taskReassignment.findFirst({ where: { id }, select: REQUEST_SELECT });
    if (!row) throw new NotFoundException('Reassignment request not found');
    return row;
  }

  /**
   * Review 2 (A6) — `fromDay` must be a day the chip can be on: within
   * MAX_MOVE_SPAN_DAYS of the drop day and inside the task's window
   * (fromDayProblem). 400 REASSIGN_INVALID_DAY; when approving a stored
   * request, a day that is no longer the task's means the task moved
   * since the request (409 REASSIGN_STALE).
   */
  private assertFromDay(task: any, fromDay: string, toDay: string | null, approving: boolean): void {
    const problem = fromDayProblem(task, fromDay, toDay, todayKey());
    if (!problem) return;
    if (problem === 'not_task_day' && approving) {
      throw stale("The task's dates changed after this move was requested. Refresh the board and try again.");
    }
    throw new BadRequestException({
      code: 'REASSIGN_INVALID_DAY',
      message:
        problem === 'too_far'
          ? `A task can move at most ${MAX_MOVE_SPAN_DAYS} days at a time, so it cannot go from ${fromDay} to ${toDay}.`
          : `The task is not on ${fmtDay(fromDay)}. Refresh the board and drag it from one of its days.`,
      details: { reason: problem === 'too_far' ? 'MOVE_TOO_FAR' : 'NOT_A_TASK_DAY' },
    });
  }

  private assertMovable(task: any): void {
    if (task.projectId == null || task.isPersonal === true) {
      throw new BadRequestException({ code: 'TASK_PERSONAL', message: 'Personal tasks cannot be moved on the Workload board.' });
    }
    if (task.isArchived === true || CLOSED_STATUSES.includes(task.status)) {
      throw new BadRequestException({ code: 'TASK_CLOSED', message: 'This task is completed or cancelled, so it cannot be moved.' });
    }
  }

  /**
   * Locked spec "Permissions": drag a chip of person A — Admin, the
   * project leader (assertProjectManage), or A's manager chain. A tray
   * chip (no A) — Admin or the leader only. Fresh checks on every write.
   */
  private async assertCanDrag(user: Actor, isAdmin: boolean, projectId: number | null, fromUserId: number | null): Promise<void> {
    if (isAdmin) return;
    if (projectId != null && (await this.access.canManageProject(user, projectId))) return;
    if (fromUserId != null && (await this.employeeScope.isInManagerChain(user.id, fromUserId))) return;
    if (fromUserId == null) {
      throw notAllowed('Only the project leader or an administrator can assign a task from the tray.');
    }
    throw notAllowed(
      `Only the project leader, an administrator or ${await this.nameOf(fromUserId)}'s manager can move this task.`,
    );
  }

  /**
   * Review 2 (A2) — on approve, the requester's own right to the move,
   * checked again: task access and the drag right on A's chip (the same
   * checks as POST /tasks/:id/reassign). A refusal is a 409 for the
   * approver (it is not his permission that is missing); `approve` marks
   * the request failed and tells the requester.
   */
  private async assertRequesterMayMove(row: any, requester: Actor, task: any): Promise<void> {
    const requesterIsAdmin = requester.isAdmin === true;
    try {
      await this.access.assertTaskAccess(row.actorId, row.taskId, requesterIsAdmin);
      await this.assertCanDrag(requester, requesterIsAdmin, task.projectId, row.fromUserId);
    } catch (err) {
      if (!(err instanceof PermissionDeniedException)) throw err;
      throw new ConflictException({
        code: 'REASSIGN_REQUESTER_NOT_ALLOWED',
        message: `${personName(row.actor) || `User #${row.actorId}`}, who asked for this move, is no longer allowed to move this task.`,
      });
    }
  }

  /**
   * Review 2 (A4) — the people an undo gives the task back to: each must
   * still be an active internal employee on the project Team (the QA6
   * assignee policy, without the leader's "add him to the Team": an undo
   * never brings anyone into a project). Otherwise 409 UNDO_STALE,
   * `details.reason: NOT_ON_TEAM`.
   */
  private async assertCanGiveBack(projectId: number, userIds: number[]): Promise<void> {
    if (userIds.length === 0) return;
    const people = await this.prisma.user.findMany({
      where: { id: { in: userIds }, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, userType: true, isActive: true, deletedAt: true },
    });
    for (const uid of userIds) {
      const person = (people as any[]).find((p) => p.id === uid);
      if (isInternalEmployee(person) && (await this.access.isOnProjectTeam(uid, projectId))) continue;
      throw new ConflictException({
        code: 'UNDO_STALE',
        message: `${personName(person) || `User #${uid}`} is no longer an active employee on this project's team, so the task cannot go back to them.`,
        details: { reason: 'NOT_ON_TEAM', userId: uid },
      });
    }
  }

  private pendingConflict(): ConflictException {
    return new ConflictException({
      code: 'REASSIGN_PENDING',
      message: 'This task already has a move waiting for approval. Wait for the decision, or cancel that request first.',
    });
  }

  /** One pending request per task (the unique pending_task_id backs this up). */
  private async assertNoPending(taskId: number, exceptId?: number): Promise<void> {
    const pending = await this.prisma.taskReassignment.findFirst({
      where: { taskId, status: 'pending', ...(exceptId != null ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (pending) throw this.pendingConflict();
  }

  /** The service gate (locked spec): B must hold one of the effective service's required qualifications. */
  private async assertProvidesService(task: any, person: PersonRow, name: string): Promise<void> {
    const serviceId = resolveEffectiveServiceId(task);
    if (serviceId == null) return;
    const service = await this.prisma.phase.findFirst({
      where: { id: serviceId },
      select: { id: true, name: true, kind: true, requiredProfessionIds: true },
    });
    if (!service) return;
    const required = normalizeIdList(service.requiredProfessionIds);
    const quals = await this.eps.loadQualifications([person.businessPartnerId]);
    const qualificationIds = person.businessPartnerId != null ? quals.get(person.businessPartnerId) ?? [] : [];
    if (providesService({ qualificationIds }, service)) return;
    const professions = await this.prisma.profession.findMany({
      where: { id: { in: required } },
      select: { name: true },
      orderBy: { name: 'asc' },
    });
    const list = professions.map((p: any) => p.name).filter(Boolean).join(', ');
    throw new UnprocessableEntityException({
      code: 'SERVICE_NOT_PROVIDED',
      message: `${name} does not provide ${service.name}: it needs one of these qualifications: ${list || 'not set'}.`,
      details: { serviceId: service.id, requiredQualificationIds: required },
    });
  }

  /** D2 — the approver, a manager in B's chain, or an Admin. */
  private async assertCanDecide(user: Actor, row: any): Promise<void> {
    if (isAdminUser(user)) return;
    if (row.approverUserId != null && row.approverUserId === user.id) return;
    if (row.toUserId != null && (await this.employeeScope.isInManagerChain(user.id, row.toUserId))) return;
    throw notAllowed(
      `Only the receiving department's manager, a manager of ${personName(row.toUser) || 'the receiving person'} or an administrator can decide on this request.`,
    );
  }

  /** D2 — the manager of the receiving department (top-level unit), when he is an active user; else null (Admins decide). */
  private async resolveApprover(dept: { id: number; managerUserId?: number | null } | null): Promise<{ id: number; name: string } | null> {
    const managerId = (dept as any)?.managerUserId ?? null;
    if (managerId == null) return null;
    const manager = await this.prisma.user.findFirst({
      where: { id: managerId, isActive: true, deletedAt: null },
      select: { id: true, firstName: true, lastName: true },
    });
    return manager ? { id: manager.id, name: personName(manager) } : null;
  }

  /** Active Admins (granted roles win over the legacy role, as in ProjectAccessService). */
  private async adminUserIds(): Promise<number[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        OR: [{ role: { name: 'Admin' } }, { userRoles: { some: { role: { name: 'Admin' } } } }],
      },
      select: { id: true, role: { select: { name: true } }, userRoles: { select: { role: { select: { name: true } } } } },
    });
    return (rows as any[])
      .filter((u) => {
        const granted = u.userRoles ?? [];
        return granted.length > 0 ? granted.some((ur: any) => ur.role?.name === 'Admin') : u.role?.name === 'Admin';
      })
      .map((u) => u.id);
  }

  private async isAdminUserId(userId: number): Promise<boolean> {
    return (await this.adminUserIds()).includes(userId);
  }

  // ─── Text, notifications, realtime ─────────────────────────────────────

  private nameIn(mp: MovePlan, uid: number | null): string {
    if (uid == null) return '';
    return mp.names.get(uid) ?? `User #${uid}`;
  }

  private async nameOf(userId: number): Promise<string> {
    const u = await this.prisma.user.findFirst({ where: { id: userId }, select: { id: true, firstName: true, lastName: true } });
    return u ? personName(u) : `User #${userId}`;
  }

  private datesText(mp: MovePlan): string {
    if (!mp.dates.changed) return '';
    const t = mp.task;
    const prevEnd = keyOf(t.endDate);
    const prevStart = keyOf(t.estimatedStartDate ?? t.startDate) ?? prevEnd;
    return ` (${fmtWindow(prevStart, prevEnd)} → ${fmtWindow(mp.dates.estimatedStartDate, mp.dates.endDate)})`;
  }

  /** "CRD-040 from Daniel Huri to Yair Goldfryd (Mon 23/11 → Tue 24/11)". */
  private moveText(mp: MovePlan): string {
    const label = taskLabel(mp.task);
    const { fromUserId, toUserId } = mp.move;
    if (fromUserId != null && toUserId != null && fromUserId !== toUserId) {
      return `${label} from ${this.nameIn(mp, fromUserId)} to ${this.nameIn(mp, toUserId)}${this.datesText(mp)}`;
    }
    if (fromUserId != null && toUserId === fromUserId) return `${label} for ${this.nameIn(mp, fromUserId)}${this.datesText(mp)}`;
    if (fromUserId == null) return `${label} from the tray to ${this.nameIn(mp, toUserId)}${this.datesText(mp)}`;
    return `${label} from ${this.nameIn(mp, fromUserId)} back to the tray`;
  }

  private describeMove(mp: MovePlan): string {
    const label = taskLabel(mp.task);
    const { fromUserId, toUserId } = mp.move;
    if (fromUserId == null) return `Assigned ${label} to ${this.nameIn(mp, toUserId)} from the tray${this.datesText(mp)}`;
    if (toUserId == null) return `Moved ${label} from ${this.nameIn(mp, fromUserId)} back to the tray`;
    return `Moved ${this.moveText(mp)}`;
  }

  /** A stored request as text (reject / cancel / failed): "CRD-040 from Daniel Huri to Yair Goldfryd". */
  private requestText(row: any): string {
    const label = taskLabel(row.task ?? {});
    const from = personName(row.fromUser);
    const to = personName(row.toUser);
    if (row.fromUserId != null && row.toUserId != null && row.fromUserId !== row.toUserId) return `${label} from ${from} to ${to}`;
    if (row.fromUserId != null && row.toUserId === row.fromUserId) return `${label} for ${from}`;
    if (row.fromUserId == null) return `${label} from the tray to ${to}`;
    return `${label} from ${from} back to the tray`;
  }

  private undoText(row: any): string {
    const label = taskLabel(row.task ?? {});
    const from = personName(row.fromUser);
    const to = personName(row.toUser);
    if (row.fromUserId == null) return `assigning ${label} to ${to}`;
    if (row.toUserId == null) return `unassigning ${label} from ${from}`;
    if (row.toUserId === row.fromUserId) return `moving ${label} for ${from}`;
    return `moving ${label} from ${from} to ${to}`;
  }

  private changesOf(mp: MovePlan): Prisma.InputJsonValue {
    const t = mp.task;
    return {
      fromUserId: mp.move.fromUserId,
      toUserId: mp.move.toUserId,
      prev: { start: keyOf(t.estimatedStartDate), end: keyOf(t.endDate) },
      next: mp.dates.changed
        ? { start: mp.dates.estimatedStartDate, end: mp.dates.endDate }
        : { start: keyOf(t.estimatedStartDate), end: keyOf(t.endDate) },
    } as Prisma.InputJsonValue;
  }

  /** Best effort: a failed notification never fails the move. */
  private async notify(n: {
    userId: number;
    type: 'reassign_request' | 'reassign_result' | 'reassign_removed';
    title: string;
    body?: string;
    row: any;
    mp?: MovePlan;
    actorId?: number;
    status: string;
  }): Promise<void> {
    const row = n.row ?? {};
    const toDay = n.mp?.move.toDay ?? keyOf(row.toDay);
    const weekOf =
      toDay ??
      (n.mp?.dates.changed ? n.mp.dates.estimatedStartDate : null) ??
      keyOf(row.newEstimatedStartDate) ??
      keyOf(row.newEndDate) ??
      todayKey();
    try {
      await this.notifications.create({
        userId: n.userId,
        type: n.type,
        title: n.title,
        body: n.body,
        entityType: 'task_reassignment',
        entityId: row.id ?? undefined,
        actorId: n.actorId,
        data: {
          reassignmentId: row.id ?? null,
          taskId: row.taskId ?? n.mp?.task.id ?? null,
          projectId: row.projectId ?? n.mp?.projectId ?? null,
          fromUserId: row.fromUserId ?? n.mp?.move.fromUserId ?? null,
          toUserId: row.toUserId ?? n.mp?.move.toUserId ?? null,
          toDay: toDay ?? null,
          weekOf,
          status: n.status,
        },
      });
    } catch (err) {
      this.logger.warn(`reassign notification to user ${n.userId} failed: ${(err as Error)?.message ?? err}`);
    }
  }

  /** Research §9 — the approve / reject / undo routes have no task param, so the service announces. */
  private invalidate(projectId: number | null | undefined, taskId: number | null | undefined): void {
    if (projectId == null || taskId == null) return;
    this.events.emit(REALTIME_INVALIDATE, { type: 'task.updated', projectId, taskId });
  }
}
