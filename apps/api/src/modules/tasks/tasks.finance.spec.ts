/**
 * Permissions round 2 (2026-11-20) — task money.
 *
 *   • B-08: `GET /tasks/:id` includes the whole project row; the
 *     controller strips `project.budget` / `estimatedValue`, the task's
 *     `budgetAmount` and assignee `hourlyRate` for callers without
 *     finance:read.
 *   • B-09: `GET /tasks` / `/tasks/mine` rows go through the global
 *     finance interceptor (budgetAmount, assignee hourlyRate).
 *   • B-13: `POST /tasks`, `PATCH /tasks/:id` (budgetAmount) and
 *     `POST /tasks/:id/assignees` (legacy hourlyRate, untyped body) need
 *     finance:write to set / change money; an unchanged echo passes.
 */
import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { redactFinanceFields } from '../../common/finance/finance-access';

const perm = (route: string, flags: Record<string, boolean>) => ({ module: { route, name: route.slice(1) }, ...flags });
const EMPLOYEE = { id: 2, roleId: 5, isAdmin: false, roleModules: [perm('/tasks', { canRead: true, canWrite: true })] };
const FINANCE = {
  id: 3,
  roleId: 6,
  isAdmin: false,
  roleModules: [perm('/tasks', { canRead: true, canWrite: true }), perm('/finance', { canRead: true, canWrite: true })],
};

function detail() {
  return {
    id: 11,
    name: 'Model L2',
    status: 'in_progress',
    budgetHours: new Prisma.Decimal('16'),
    budgetAmount: new Prisma.Decimal('4800'),
    project: { id: 59, name: 'Tower A', budget: new Prisma.Decimal('900000'), estimatedValue: new Prisma.Decimal('1000000') },
    assignees: [{ userId: 7, hourlyRate: new Prisma.Decimal('120'), user: { id: 7 } }],
  };
}

function makeController() {
  const tasksService: any = {
    findOne: jest.fn(async () => detail()),
    findAll: jest.fn(async () => ({ data: [detail()], meta: { total: 1 } })),
    create: jest.fn(async () => ({ id: 12 })),
    update: jest.fn(async () => ({ id: 11 })),
    addAssignee: jest.fn(async () => ({ id: 1 })),
    getMoneySnapshot: jest.fn(async () => ({ budgetAmount: new Prisma.Decimal('4800.00') })),
  };
  const access: any = {
    assertTaskAccess: jest.fn(async () => undefined),
    assertProjectAccess: jest.fn(async () => undefined),
    assertZoneAccess: jest.fn(async () => undefined),
    getAccessibleProjectIds: jest.fn(async () => ({ all: true, projectIds: [] })),
  };
  const transitions: any = { assertTransition: jest.fn(async () => undefined) };
  const assigneePolicy: any = {
    planAssignment: jest.fn(async (_actor: any, projectId: any, userId: number) => ({ userId, projectId, name: "x", needsTeamAdd: false })),
    applyTeamAdd: jest.fn(async () => undefined),
    logTeamAdd: jest.fn(async () => undefined),
  };
  return { ctrl: new TasksController(tasksService, access, transitions, {} as any, assigneePolicy), tasksService, assigneePolicy };
}

describe('GET /tasks/:id — detail (B-08)', () => {
  it('without finance:read: no project budget / estimated value, no task or assignee money', async () => {
    const { ctrl } = makeController();
    const out: any = await ctrl.findOne(EMPLOYEE, 11);
    expect(out.project).toEqual({ id: 59, name: 'Tower A' });
    expect(out).not.toHaveProperty('budgetAmount');
    expect(out.assignees[0]).toEqual({ userId: 7, user: { id: 7 } });
    expect(Number(out.budgetHours)).toBe(16);
  });

  it('with finance:read everything is there', async () => {
    const { ctrl } = makeController();
    const out: any = await ctrl.findOne(FINANCE, 11);
    expect(Number(out.project.budget)).toBe(900000);
    expect(Number(out.budgetAmount)).toBe(4800);
  });
});

describe('GET /tasks — list (B-09)', () => {
  it('the interceptor removes budgetAmount and assignee hourlyRate from every row', async () => {
    const { ctrl } = makeController();
    const out: any = redactFinanceFields(await ctrl.findAll(EMPLOYEE, {} as any));
    expect(out.data[0]).not.toHaveProperty('budgetAmount');
    expect(out.data[0].assignees[0]).not.toHaveProperty('hourlyRate');
    expect(out.data[0].project).not.toHaveProperty('budget');
    expect(out.meta.total).toBe(1);
  });
});

describe('task money writes (B-13)', () => {
  it('POST /tasks with a budgetAmount and no finance:write → 403', async () => {
    const { ctrl, tasksService } = makeController();
    await expect(ctrl.create(EMPLOYEE, { projectId: 59, name: 'x', budgetAmount: 100 } as any)).rejects.toThrow(
      /You can't change budget amounts — that needs permission to change financial data/,
    );
    expect(tasksService.create).not.toHaveBeenCalled();
    await ctrl.create(EMPLOYEE, { projectId: 59, name: 'x', budgetHours: 8 } as any);
    expect(tasksService.create).toHaveBeenCalled();
  });

  it('PATCH /tasks/:id changing budgetAmount without finance:write → 403; an unchanged echo passes', async () => {
    const { ctrl, tasksService } = makeController();
    await expect(ctrl.update(11, { budgetAmount: 5000 } as any, EMPLOYEE)).rejects.toThrow(ForbiddenException);
    expect(tasksService.update).not.toHaveBeenCalled();
    await ctrl.update(11, { name: 'renamed', budgetAmount: 4800 } as any, EMPLOYEE);
    expect(tasksService.update).toHaveBeenCalledTimes(1);
  });

  it('PATCH /tasks/:id by a finance writer changes it', async () => {
    const { ctrl, tasksService } = makeController();
    await ctrl.update(11, { budgetAmount: 5000 } as any, FINANCE);
    expect(tasksService.update).toHaveBeenCalled();
    expect(tasksService.getMoneySnapshot).not.toHaveBeenCalled();
  });

  it('POST /tasks/:id/assignees with an hourlyRate and no finance:write → 403', async () => {
    const { ctrl, tasksService } = makeController();
    await expect(ctrl.addAssignee(11, { userId: 7, hourlyRate: 150 }, EMPLOYEE)).rejects.toThrow(
      /You can't change hourly rates — that needs permission to change financial data/,
    );
    expect(tasksService.addAssignee).not.toHaveBeenCalled();
    await ctrl.addAssignee(11, { userId: 7 }, EMPLOYEE);
    expect(tasksService.addAssignee).toHaveBeenCalled();
  });

  it('a catalog pick copies the price server-side (live catalog value first), not through the client', async () => {
    const findUnique = jest.fn(async () => ({
      defaultBudgetAmount: new Prisma.Decimal('100'),
      catalogTask: { defaultBudgetAmount: new Prisma.Decimal('250') },
    }));
    const svc = new TasksService({ templateTask: { findUnique } } as any, {} as any, {} as any, {} as any, {} as any);
    expect(Number(await (svc as any).resolveTemplatePrice(9))).toBe(250);
    findUnique.mockResolvedValueOnce({ defaultBudgetAmount: new Prisma.Decimal('100'), catalogTask: null } as any);
    expect(Number(await (svc as any).resolveTemplatePrice(9))).toBe(100);
    findUnique.mockResolvedValueOnce(null as any);
    expect(await (svc as any).resolveTemplatePrice(9)).toBeNull();
  });

  it('sourceTemplateTaskId is create-only (PATCH rejects it as an unknown field)', async () => {
    const { ValidationPipe } = await import('@nestjs/common');
    const { UpdateTaskDto } = await import('./dto/update-task.dto');
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    await expect(
      pipe.transform({ sourceTemplateTaskId: 9 }, { type: 'body', metatype: UpdateTaskDto }),
    ).rejects.toBeDefined();
  });

  it('re-adding a removed assignee no longer wipes their stored hourlyRate', async () => {
    const upsert = jest.fn(async () => ({ userId: 7, user: { firstName: 'D', lastName: 'L' } }));
    const prisma: any = {
      task: { findFirst: jest.fn(async () => ({ id: 11 })), findUnique: jest.fn(async () => null) },
      taskAssignee: { findFirst: jest.fn(async () => null), upsert },
      user: { findFirst: jest.fn(async () => ({ id: 7, isActive: true })), findUnique: jest.fn(async () => null) },
    };
    const svc = new TasksService(prisma, { emit: jest.fn() } as any, {} as any, {} as any, {} as any);
    jest.spyOn(svc, 'findOne').mockResolvedValue({ id: 11 } as any);
    await svc.addAssignee(11, { userId: 7 } as any);
    const args: any = (upsert.mock.calls[0] as any[])[0];
    expect(args.update).not.toHaveProperty('hourlyRate');
    expect(args.update.deletedAt).toBeNull();
  });
});
