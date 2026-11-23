/**
 * Permissions round 4 (2026-11-23) — D-08: binding a time entry to a task
 * or project needs access to it, and the entry's project is its task's
 * project. `POST /time-entries/batch` is gone.
 */
import { BadRequestException } from '@nestjs/common';

import { TimeEntriesController } from './time-entries.controller';
import { TimeEntriesService } from './time-entries.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';

const USER = { id: 2, isAdmin: false, roleModules: [] };

/** User 2 can reach project 59 (task 11) only; task 21 is in project 60. */
function fakeAccess() {
  const deny = () =>
    new PermissionDeniedException("You're not a member of this project.", { reason: 'NOT_PROJECT_MEMBER' });
  return {
    assertTaskAccess: jest.fn(async (_u: number, taskId: number) => {
      if (taskId !== 11) throw deny();
      return 59;
    }),
    assertProjectAccess: jest.fn(async (_u: number, projectId: number) => {
      if (projectId !== 59) throw deny();
    }),
  };
}

function makeController() {
  const svc: any = {
    create: jest.fn(async () => ({ id: 1 })),
    update: jest.fn(async () => ({ id: 1 })),
    findOne: jest.fn(async () => ({ id: 1, userId: 2, taskId: 11, projectId: 59 })),
  };
  const access = fakeAccess();
  const ctrl = new TimeEntriesController(svc, {} as any, {} as any, access as any);
  return { ctrl, svc, access };
}

describe('TimeEntriesController — binding needs access (D-08)', () => {
  it('POST: a task of a project the caller cannot reach is refused, nothing written', async () => {
    const { ctrl, svc } = makeController();
    await expect(
      ctrl.create(USER, { taskId: 21, date: '2026-11-23', minutes: 60 } as any),
    ).rejects.toMatchObject({ details: { reason: 'NOT_PROJECT_MEMBER' } });
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('POST: an explicit project the caller cannot reach is refused', async () => {
    const { ctrl, svc } = makeController();
    await expect(
      ctrl.create(USER, { taskId: 11, projectId: 60, date: '2026-11-23', minutes: 60 } as any),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('POST: own task on an accessible project goes through', async () => {
    const { ctrl, svc } = makeController();
    await ctrl.create(USER, { taskId: 11, date: '2026-11-23', minutes: 60 } as any);
    expect(svc.create).toHaveBeenCalled();
  });

  it('PATCH: moving the entry to an unreachable task is refused', async () => {
    const { ctrl, svc } = makeController();
    await expect(ctrl.update(USER, 1, { taskId: 21 })).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(svc.update).not.toHaveBeenCalled();
  });

  it('PATCH: echoing the stored task / project is not re-checked', async () => {
    const { ctrl, svc, access } = makeController();
    await ctrl.update(USER, 1, { taskId: 11, projectId: 59, minutes: 90 });
    expect(access.assertTaskAccess).not.toHaveBeenCalled();
    expect(access.assertProjectAccess).not.toHaveBeenCalled();
    expect(svc.update).toHaveBeenCalled();
  });

  it('POST /time-entries/batch is gone', () => {
    expect((TimeEntriesController.prototype as any).batchCreate).toBeUndefined();
    expect((TimeEntriesService.prototype as any).batchCreate).toBeUndefined();
  });
});

describe('TimeEntriesService — the entry\'s project is its task\'s project', () => {
  function makeService() {
    const prisma: any = {
      task: { findUnique: jest.fn(async () => ({ projectId: 59 })) },
      timeEntry: {
        findMany: jest.fn(async () => []),
        findFirst: jest.fn(async () => ({ id: 1, userId: 2, taskId: 11, projectId: 59, date: new Date(2026, 10, 23) })),
        create: jest.fn(async (args: any) => ({ id: 1, minutes: 60, ...args.data })),
        update: jest.fn(async (args: any) => ({ id: 1, ...args.data })),
        aggregate: jest.fn(async () => ({ _sum: { minutes: 0 } })),
      },
    };
    return { prisma, service: new TimeEntriesService(prisma, { write: jest.fn() } as any) };
  }

  it('create: a projectId other than the task\'s → 400 TIME_ENTRY_PROJECT_MISMATCH', async () => {
    const { service, prisma } = makeService();
    const err = await service
      .create(2, { taskId: 11, projectId: 60, date: '2026-11-23', minutes: 60 } as any)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'TIME_ENTRY_PROJECT_MISMATCH' });
    expect(prisma.timeEntry.create).not.toHaveBeenCalled();
  });

  it('update: a new task brings its own project with it', async () => {
    const { service, prisma } = makeService();
    prisma.task.findUnique.mockResolvedValue({ projectId: 61 });
    await service.update(1, { taskId: 31 }, 2);
    expect(prisma.timeEntry.update.mock.calls[0][0].data).toMatchObject({ taskId: 31, projectId: 61 });
  });
});
