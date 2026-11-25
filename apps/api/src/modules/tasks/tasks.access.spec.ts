/**
 * Permissions round 4 (2026-11-23) — task routes.
 *
 *   • D-09: checklist edit / delete / reorder and restore check access
 *     to the task (restore: the archived task's project).
 *   • D-10 / §2: a task never leaves its project; zone and deliverable
 *     must be in the task's project; a reply stays on its task.
 *   • D-20 / §3: approve only from In Review, only by the project
 *     leader, an Admin or a tasks:approve holder, through the
 *     stage-transition rules.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';

const perm = (route: string, flags: Record<string, boolean>) => ({ module: { route, name: route.slice(1) }, ...flags });
const MEMBER = { id: 2, roleId: 5, isAdmin: false, roleModules: [perm('/tasks', { canRead: true, canWrite: true })] };
const STRANGER = { id: 9, roleId: 5, isAdmin: false, roleModules: [perm('/tasks', { canRead: true, canWrite: true })] };
const LEADER = { id: 7, roleId: 5, isAdmin: false, roleModules: [perm('/tasks', { canRead: true, canWrite: true })] };
const APPROVER = {
  id: 8,
  roleId: 4,
  isAdmin: false,
  roleModules: [perm('/tasks', { canRead: true, canWrite: true, canApprove: true })],
};
const ADMIN = { id: 1, roleId: 1, isAdmin: true, roleModules: [] };

const notMember = () =>
  new PermissionDeniedException("You're not a member of this project.", { module: 'projects', reason: 'NOT_PROJECT_MEMBER' });

/** Project 59 has members 2, 7, 8; task 11 and 12 are in it, task 21 is in project 60. */
function fakeAccess() {
  const members = new Set([2, 7, 8]);
  const taskProject: Record<number, number> = { 11: 59, 12: 59, 21: 60 };
  const check = (userId: number, projectId: number, isAdmin: boolean) => {
    if (isAdmin) return;
    if (projectId !== 59 || !members.has(userId)) throw notMember();
  };
  return {
    assertProjectAccess: jest.fn(async (u: number, p: number, a: boolean) => check(u, p, a)),
    assertTaskAccess: jest.fn(async (u: number, t: number, a: boolean) => {
      check(u, taskProject[t], a);
      return taskProject[t];
    }),
    assertZoneAccess: jest.fn(async (u: number, _z: number, a: boolean) => {
      check(u, 59, a);
      return 59;
    }),
    getAccessibleProjectIds: jest.fn(async () => ({ all: false, projectIds: [59] })),
  };
}

function makeController() {
  const tasksService: any = {
    restore: jest.fn(async () => ({ message: 'Task restored' })),
    findArchivedForAccess: jest.fn(async () => ({ projectId: 59, createdBy: 2, assigneeIds: [] })),
    recordReview: jest.fn(async () => ({ task: { id: 11, status: 'completed' } })),
    getReviewContext: jest.fn(async () => ({ status: 'in_review', leaderId: 7 })),
    update: jest.fn(async () => ({ id: 11 })),
    findOne: jest.fn(async () => ({ id: 11, status: 'in_progress' })),
    getMoneySnapshot: jest.fn(async () => null),
  };
  const checklist: any = {
    getItemTaskId: jest.fn(async () => 11),
    getItemsTaskIds: jest.fn(async () => [11, 21]),
    update: jest.fn(async () => ({ id: 1 })),
    remove: jest.fn(async () => ({ message: 'Checklist item removed' })),
    reorder: jest.fn(async () => ({ message: 'Reordered' })),
  };
  const access = fakeAccess();
  const transitions: any = { assertTransition: jest.fn(async () => undefined) };
  const ctrl = new TasksController(tasksService, access as any, transitions, checklist, {} as any);
  return { ctrl, tasksService, checklist, access, transitions };
}

describe('TasksController — checklist (D-09)', () => {
  it('PATCH checklist item: a stranger to the task\'s project is denied, nothing written', async () => {
    const { ctrl, checklist } = makeController();
    await expect(ctrl.updateChecklistItem(STRANGER, 1, { isDone: true })).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(checklist.update).not.toHaveBeenCalled();
    await ctrl.updateChecklistItem(MEMBER, 1, { isDone: true });
    expect(checklist.update).toHaveBeenCalledWith(1, 2, { isDone: true });
  });

  it('DELETE checklist item: a stranger is denied', async () => {
    const { ctrl, checklist } = makeController();
    await expect(ctrl.removeChecklistItem(STRANGER, 1)).rejects.toBeInstanceOf(ForbiddenException);
    expect(checklist.remove).not.toHaveBeenCalled();
  });

  it('reorder: every task the items belong to needs access', async () => {
    const { ctrl, checklist } = makeController();
    // Items span task 11 (project 59) and task 21 (project 60).
    await expect(
      ctrl.reorderChecklist(MEMBER, { items: [{ id: 1, sortOrder: 0 }, { id: 2, sortOrder: 1 }] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(checklist.reorder).not.toHaveBeenCalled();
  });
});

describe('TasksController — restore (D-09)', () => {
  it('a stranger cannot restore an archived task of another project', async () => {
    const { ctrl, tasksService, access } = makeController();
    await expect(ctrl.restore(STRANGER, 11)).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.assertProjectAccess).toHaveBeenCalledWith(9, 59, false);
    expect(tasksService.restore).not.toHaveBeenCalled();
  });

  it('a project member restores', async () => {
    const { ctrl, tasksService } = makeController();
    await ctrl.restore(MEMBER, 11);
    expect(tasksService.restore).toHaveBeenCalledWith(11);
  });

  it('an archived personal task: only its creator or assignees', async () => {
    const { ctrl, tasksService } = makeController();
    tasksService.findArchivedForAccess.mockResolvedValue({ projectId: null, createdBy: 2, assigneeIds: [8] });
    await expect(ctrl.restore(STRANGER, 11)).rejects.toMatchObject({ details: { reason: 'PERSONAL_TASK' } });
    await ctrl.restore(MEMBER, 11);
    await ctrl.restore(APPROVER, 11);
    expect(tasksService.restore).toHaveBeenCalledTimes(2);
  });

  it('a live task goes through the normal task check', async () => {
    const { ctrl, tasksService, access } = makeController();
    tasksService.findArchivedForAccess.mockResolvedValue(null);
    await expect(ctrl.restore(STRANGER, 21)).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.assertTaskAccess).toHaveBeenCalledWith(9, 21, false);
  });
});

describe('TasksController — PATCH target zone / project needs access', () => {
  it('a zone the caller cannot reach is refused before the update', async () => {
    const { ctrl, tasksService, access } = makeController();
    access.assertZoneAccess.mockRejectedValueOnce(notMember());
    await expect(ctrl.update(11, { zoneId: 99 } as any, MEMBER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tasksService.update).not.toHaveBeenCalled();
  });
});

describe('TasksController — review approve (D-20)', () => {
  it('a member who is not the leader and has no tasks:approve cannot approve', async () => {
    const { ctrl, tasksService } = makeController();
    await expect(ctrl.recordReview(11, { action: 'approve' }, MEMBER)).rejects.toMatchObject({
      details: { module: 'tasks', action: 'approve' },
    });
    expect(tasksService.recordReview).not.toHaveBeenCalled();
  });

  it('the project leader, a tasks:approve holder and an Admin may approve, through the transition rules', async () => {
    const { ctrl, tasksService, transitions } = makeController();
    for (const u of [LEADER, APPROVER, ADMIN]) {
      await ctrl.recordReview(11, { action: 'approve' }, u);
    }
    expect(tasksService.recordReview).toHaveBeenCalledTimes(3);
    expect(transitions.assertTransition).toHaveBeenCalledWith(LEADER, 'in_review', 'completed');
  });

  it('approve from a status other than In Review → 400 TASK_NOT_IN_REVIEW', async () => {
    const { ctrl, tasksService } = makeController();
    tasksService.getReviewContext.mockResolvedValue({ status: 'in_progress', leaderId: 7 });
    const err = await ctrl.recordReview(11, { action: 'approve' }, LEADER).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'TASK_NOT_IN_REVIEW' });
    expect(tasksService.recordReview).not.toHaveBeenCalled();
  });

  it('a stage-transition rule that blocks In Review → Done blocks approve', async () => {
    const { ctrl, tasksService, transitions } = makeController();
    transitions.assertTransition.mockRejectedValueOnce(
      new PermissionDeniedException('blocked', { module: 'tasks', reason: 'STAGE_TRANSITION' }),
    );
    await expect(ctrl.recordReview(11, { action: 'approve' }, LEADER)).rejects.toMatchObject({
      details: { reason: 'STAGE_TRANSITION' },
    });
    expect(tasksService.recordReview).not.toHaveBeenCalled();
  });

  it('submit and return keep their old gate (task access only)', async () => {
    const { ctrl, tasksService } = makeController();
    await ctrl.recordReview(11, { action: 'submit' }, MEMBER);
    expect(tasksService.getReviewContext).not.toHaveBeenCalled();
    expect(tasksService.recordReview).toHaveBeenCalled();
  });

  it('the review-summary route is gone', () => {
    expect((TasksController.prototype as any).reviewSummary).toBeUndefined();
  });
});

describe('TasksController — PATCH status cannot bypass approve (review fix)', () => {
  // Every board (kanban drag, bulk status, My Tasks, planning grid) moves
  // a task with PATCH /tasks/:id, so Done there follows the approve rule.
  const ctx = (status: string, requiresReview: boolean) => ({ status, requiresReview, leaderId: 7 });

  it('a plain member cannot complete a requires-review task that is In Review', async () => {
    const { ctrl, tasksService } = makeController();
    tasksService.getReviewContext.mockResolvedValue(ctx('in_review', true));
    await expect(ctrl.update(11, { status: 'completed' } as any, MEMBER)).rejects.toMatchObject({
      details: { module: 'tasks', action: 'approve' },
    });
    expect(tasksService.update).not.toHaveBeenCalled();
  });

  it('a plain member cannot skip review by moving a requires-review task straight to Done', async () => {
    const { ctrl, tasksService } = makeController();
    tasksService.getReviewContext.mockResolvedValue(ctx('in_progress', true));
    await expect(ctrl.update(11, { status: 'completed' } as any, MEMBER)).rejects.toBeInstanceOf(
      PermissionDeniedException,
    );
    expect(tasksService.update).not.toHaveBeenCalled();
  });

  it('an approver moving a requires-review task to Done from outside In Review → 400 TASK_NOT_IN_REVIEW', async () => {
    const { ctrl, tasksService } = makeController();
    tasksService.getReviewContext.mockResolvedValue(ctx('in_progress', true));
    const err = await ctrl.update(11, { status: 'completed' } as any, LEADER).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'TASK_NOT_IN_REVIEW' });
    expect(tasksService.update).not.toHaveBeenCalled();
  });

  it('the leader, a tasks:approve holder and an Admin complete from In Review, through the transition rules', async () => {
    const { ctrl, tasksService, transitions } = makeController();
    tasksService.getReviewContext.mockResolvedValue(ctx('in_review', true));
    for (const u of [LEADER, APPROVER, ADMIN]) {
      await ctrl.update(11, { status: 'completed' } as any, u);
    }
    expect(tasksService.update).toHaveBeenCalledTimes(3);
    expect(transitions.assertTransition).toHaveBeenCalledWith(APPROVER, 'in_review', 'completed');
  });

  it('a task In Review needs the approver even when it does not require review', async () => {
    const { ctrl, tasksService } = makeController();
    tasksService.getReviewContext.mockResolvedValue(ctx('in_review', false));
    await expect(ctrl.update(11, { status: 'completed' } as any, MEMBER)).rejects.toBeInstanceOf(
      PermissionDeniedException,
    );
    expect(tasksService.update).not.toHaveBeenCalled();
  });

  it('a task without review keeps today\'s rule: a member moves it to Done through the transition rules', async () => {
    const { ctrl, tasksService, transitions } = makeController();
    tasksService.getReviewContext.mockResolvedValue(ctx('in_progress', false));
    await ctrl.update(11, { status: 'completed' } as any, MEMBER);
    expect(transitions.assertTransition).toHaveBeenCalledWith(MEMBER, 'in_progress', 'completed');
    expect(tasksService.update).toHaveBeenCalledWith(11, { status: 'completed' }, 2, MEMBER);
  });

  it('other moves on a reviewed task (e.g. submit to In Review) keep the plain transition rule', async () => {
    const { ctrl, tasksService, transitions } = makeController();
    tasksService.getReviewContext.mockResolvedValue(ctx('in_progress', true));
    await ctrl.update(11, { status: 'in_review' } as any, MEMBER);
    expect(transitions.assertTransition).toHaveBeenCalledWith(MEMBER, 'in_progress', 'in_review');
    expect(tasksService.update).toHaveBeenCalled();
  });

  it('switching review off — alone or with Done in the same request — needs the approver', async () => {
    const { ctrl, tasksService } = makeController();
    tasksService.getReviewContext.mockResolvedValue(ctx('in_progress', true));
    await expect(
      ctrl.update(11, { status: 'completed', requiresReview: false } as any, MEMBER),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
    await expect(ctrl.update(11, { requiresReview: false } as any, MEMBER)).rejects.toMatchObject({
      details: { action: 'approve' },
    });
    expect(tasksService.update).not.toHaveBeenCalled();

    await ctrl.update(11, { requiresReview: false } as any, LEADER);
    expect(tasksService.update).toHaveBeenCalledTimes(1);
  });

  it('a PATCH without status or review flag does not load the review context', async () => {
    const { ctrl, tasksService } = makeController();
    await ctrl.update(11, { name: 'x' } as any, MEMBER);
    expect(tasksService.getReviewContext).not.toHaveBeenCalled();
    expect(tasksService.update).toHaveBeenCalled();
  });
});

// ─── Service: placement and review ─────────────────────────────────────

function makeService() {
  const prisma: any = {
    task: {
      findFirst: jest.fn(),
      findUnique: jest.fn(async () => ({ budgetHours: 8, status: 'completed' })),
      findMany: jest.fn(),
      update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })),
      create: jest.fn(),
    },
    zone: { findFirst: jest.fn(), findMany: jest.fn() },
    projectDeliverable: { findFirst: jest.fn() },
    taskComment: { findFirst: jest.fn(), create: jest.fn(), findUnique: jest.fn() },
    taskReviewEvent: { create: jest.fn(async () => ({ id: 1 })) },
    timeEntry: { aggregate: jest.fn(async () => ({ _sum: { minutes: 0 }, _max: { date: null } })) },
    user: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops(prisma))),
  };
  const activityLog: any = {
    logTaskCreated: jest.fn(),
    logTaskUpdated: jest.fn(),
    logTaskStatusChange: jest.fn(),
  };
  const service = new TasksService(
    prisma,
    { emit: jest.fn() } as any,
    activityLog,
    { create: jest.fn() } as any,
    { materializeFromTasks: jest.fn() } as any,
  );
  return { service, prisma, activityLog };
}

const TASK = {
  id: 11,
  projectId: 59,
  zoneId: 10,
  isPersonal: false,
  status: 'in_progress',
  code: 'T-11',
  name: 'Model L2',
  endDate: null,
  estimatedStartDate: null,
  budgetHours: 8,
  dueDateOverridden: false,
};

describe('TasksService.update — cross-project placement (§2)', () => {
  it('changing projectId → 400 CROSS_PROJECT_MOVE, nothing written', async () => {
    const { service, prisma } = makeService();
    prisma.task.findFirst.mockResolvedValue({ ...TASK });
    const err = await service.update(11, { projectId: 60 } as any, 2).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'CROSS_PROJECT_MOVE' });
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  it('taking the task out of its project (projectId null + personal) → CROSS_PROJECT_MOVE', async () => {
    const { service, prisma } = makeService();
    prisma.task.findFirst.mockResolvedValue({ ...TASK });
    const err = await service.update(11, { projectId: null, isPersonal: true } as any, 2).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'CROSS_PROJECT_MOVE' });
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  it('a zone of another project → CROSS_PROJECT_MOVE', async () => {
    const { service, prisma } = makeService();
    prisma.task.findFirst.mockResolvedValue({ ...TASK });
    prisma.zone.findFirst.mockResolvedValue({ projectId: 60 });
    const err = await service.update(11, { zoneId: 30 } as any, 2).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'CROSS_PROJECT_MOVE' });
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  it('a zone move inside the same project is accepted', async () => {
    const { service, prisma } = makeService();
    prisma.task.findFirst.mockResolvedValue({ ...TASK });
    prisma.zone.findFirst.mockResolvedValue({ projectId: 59 });
    await service.update(11, { zoneId: 12 } as any, 2);
    const data = prisma.task.update.mock.calls[0][0].data;
    expect(data.zoneId).toBe(12);
    expect(data).not.toHaveProperty('projectId');
  });

  it('echoing the same projectId passes', async () => {
    const { service, prisma } = makeService();
    prisma.task.findFirst.mockResolvedValue({ ...TASK });
    await service.update(11, { projectId: 59, name: 'x' } as any, 2);
    expect(prisma.task.update).toHaveBeenCalled();
  });

  it('a deliverable of another project → 400 CROSS_PROJECT_PLACEMENT', async () => {
    const { service, prisma } = makeService();
    prisma.task.findFirst.mockResolvedValue({ ...TASK });
    prisma.projectDeliverable.findFirst.mockResolvedValue(null);
    const err = await service.update(11, { projectDeliverableId: 300 } as any, 2).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'CROSS_PROJECT_PLACEMENT' });
    expect(prisma.projectDeliverable.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 300, projectId: 59 }) }),
    );
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  it('a personal task without a project that gets a zone joins the zone\'s project', async () => {
    const { service, prisma } = makeService();
    prisma.task.findFirst.mockResolvedValue({ ...TASK, projectId: null, zoneId: null, isPersonal: true });
    prisma.zone.findFirst.mockResolvedValue({ projectId: 59 });
    await service.update(11, { zoneId: 12 } as any, 2);
    expect(prisma.task.update.mock.calls[0][0].data).toMatchObject({ zoneId: 12, projectId: 59 });
  });
});

describe('TasksService.create — placement (§2)', () => {
  it('a zone of one project with the projectId of another → 400 CROSS_PROJECT_PLACEMENT', async () => {
    const { service, prisma } = makeService();
    prisma.zone.findFirst.mockResolvedValue({ id: 30, projectId: 60 });
    const err = await service
      .create(2, { name: 'x', zoneId: 30, projectId: 59 } as any)
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'CROSS_PROJECT_PLACEMENT' });
    expect(prisma.task.create).not.toHaveBeenCalled();
  });

  it('a deliverable of another project → 400 CROSS_PROJECT_PLACEMENT', async () => {
    const { service, prisma } = makeService();
    prisma.projectDeliverable.findFirst.mockResolvedValue(null);
    const err = await service
      .create(2, { name: 'x', projectId: 59, projectDeliverableId: 300 } as any)
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'CROSS_PROJECT_PLACEMENT' });
    expect(prisma.task.create).not.toHaveBeenCalled();
  });
});

describe('TasksService.batchReorder — zone moves stay in the project', () => {
  it('a zone of another project → CROSS_PROJECT_MOVE; nothing written', async () => {
    const { service, prisma } = makeService();
    prisma.task.findMany.mockResolvedValue([{ id: 11, projectId: 59 }]);
    prisma.zone.findMany.mockResolvedValue([{ id: 30, projectId: 60 }]);
    const err = await service.batchReorder([{ id: 11, sortOrder: 1000, zoneId: 30 }]).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'CROSS_PROJECT_MOVE' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a zone of the same project is accepted', async () => {
    const { service, prisma } = makeService();
    prisma.task.findMany.mockResolvedValue([{ id: 11, projectId: 59 }]);
    prisma.zone.findMany.mockResolvedValue([{ id: 12, projectId: 59 }]);
    await service.batchReorder([{ id: 11, sortOrder: 1000, zoneId: 12 }]);
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

describe('TasksService.addComment — a reply stays on its task', () => {
  it('a parent comment from another task → 400 COMMENT_PARENT_MISMATCH', async () => {
    const { service, prisma } = makeService();
    prisma.task.findFirst.mockResolvedValue({ ...TASK });
    prisma.taskComment.findFirst.mockResolvedValue(null);
    const err = await service.addComment(11, 2, { content: 'hi', parentId: 500 }).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'COMMENT_PARENT_MISMATCH' });
    expect(prisma.taskComment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 500, taskId: 11 } }),
    );
    expect(prisma.taskComment.create).not.toHaveBeenCalled();
  });
});

describe('TasksService.recordReview — approve (§3)', () => {
  it('approve from a status other than In Review → 400 TASK_NOT_IN_REVIEW, nothing written', async () => {
    const { service, prisma } = makeService();
    for (const status of ['not_started', 'in_progress', 'on_hold', 'cancelled', 'completed']) {
      prisma.task.findFirst.mockResolvedValue({ ...TASK, status, requiresReview: true });
      const err = await service.recordReview(11, 7, 'approve').catch((e) => e);
      expect(err.getResponse()).toMatchObject({ code: 'TASK_NOT_IN_REVIEW' });
    }
    expect(prisma.taskReviewEvent.create).not.toHaveBeenCalled();
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  it('approve from In Review completes the task with the normal follow-up (activity log, completion %)', async () => {
    const { service, prisma, activityLog } = makeService();
    prisma.task.findFirst.mockResolvedValue({ ...TASK, status: 'in_review', requiresReview: true });
    await service.recordReview(11, 7, 'approve');
    expect(prisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 11 }, data: { status: 'completed' } }),
    );
    expect(activityLog.logTaskStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ oldStatus: 'in_review', newStatus: 'completed', projectId: 59 }),
    );
    expect(prisma.task.update).toHaveBeenCalledWith({ where: { id: 11 }, data: { completionPct: 100 } });
  });
});
