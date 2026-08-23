import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Unit tests for the parts of TasksService that carry real security and
 * data-integrity risk: assignee upsert/removal and attachment URL
 * validation. These fixed live bugs (duplicate-assignee unique-constraint
 * failures, path-traversal/XSS via attachment URLs) — the tests lock in
 * the behavior.
 *
 * PrismaClient is fully mocked — no DB required. Integration tests that
 * exercise the full transaction can live under /test and run against a
 * dedicated test database.
 */
describe('TasksService', () => {
  let service: TasksService;
  let prisma: {
    task: any;
    taskAssignee: any;
    taskAttachment: any;
    user: any;
    timeEntry: any;
  };

  beforeEach(async () => {
    prisma = {
      task: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      taskAssignee: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
      },
      taskAttachment: {
        create: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      timeEntry: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { minutes: 0 }, _max: { date: null } }),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        // ActivityLogService + NotificationsService are injected by the
        // service but the tests here don't assert on them — provide
        // no-op stubs so the DI graph resolves.
        {
          provide: ActivityLogService,
          useValue: {
            logTaskCreated: jest.fn(),
            logTaskUpdated: jest.fn(),
            logTaskStatusChange: jest.fn(),
            logTaskDeleted: jest.fn(),
            logAssigneeAdded: jest.fn(),
            logAssigneeRemoved: jest.fn(),
          },
        },
        {
          provide: NotificationsService,
          useValue: { create: jest.fn() },
        },
      ],
    }).compile();

    service = moduleRef.get(TasksService);
  });

  describe('addAssignee', () => {
    const TASK_ID = 10;
    const USER_ID = 42;

    beforeEach(() => {
      // findOne is called first inside addAssignee — return a valid task
      prisma.task.findFirst.mockResolvedValue({ id: TASK_ID, projectId: 1 });
      // Default the active-user lookup to an active row so existing tests
      // (that don't care about this guard) pass through to the next check.
      prisma.user.findFirst.mockResolvedValue({
        id: USER_ID, isActive: true, firstName: 'Active', lastName: 'User',
      });
    });

    it('rejects with BadRequestException when the target user is inactive', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: USER_ID, isActive: false, firstName: 'Shifi', lastName: 'Cohen',
      });

      await expect(
        service.addAssignee(TASK_ID, { userId: USER_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.taskAssignee.findFirst).not.toHaveBeenCalled();
      expect(prisma.taskAssignee.upsert).not.toHaveBeenCalled();
    });

    it('rejects with NotFoundException when the target user does not exist', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.addAssignee(TASK_ID, { userId: 9999 }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.taskAssignee.upsert).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the user is already actively assigned', async () => {
      prisma.taskAssignee.findFirst.mockResolvedValue({
        id: 1, taskId: TASK_ID, userId: USER_ID, deletedAt: null,
      });

      await expect(
        service.addAssignee(TASK_ID, { userId: USER_ID }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.taskAssignee.upsert).not.toHaveBeenCalled();
    });

    it('upserts via the (taskId, userId) compound key when no active row exists', async () => {
      prisma.taskAssignee.findFirst.mockResolvedValue(null);
      prisma.taskAssignee.upsert.mockResolvedValue({
        id: 2, taskId: TASK_ID, userId: USER_ID, user: { id: USER_ID, firstName: 'A', lastName: 'B' },
      });

      await service.addAssignee(TASK_ID, { userId: USER_ID, role: 'reviewer' });

      expect(prisma.taskAssignee.upsert).toHaveBeenCalledTimes(1);
      const args = prisma.taskAssignee.upsert.mock.calls[0][0];
      expect(args.where).toEqual({ taskId_userId: { taskId: TASK_ID, userId: USER_ID } });
      // On create path, deletedAt is implicit null; on update path it's cleared.
      expect(args.update).toMatchObject({ deletedAt: null, role: 'reviewer' });
    });

    it('does NOT run any date-overlap check at assignment time (policy reversal 2026-06-18)', async () => {
      // Per user direction: assignment is about responsibility, not
      // scheduling. The same person can legitimately own several tasks
      // whose date ranges touch (planning headcount, review duty, etc.).
      // The previous policy (#29) wrapped this in a hard reject and
      // produced spurious 409s in real data; the entire query is gone.
      // Time-entry overlap is unaffected — that check lives in
      // time-entries.service.ts and protects actual logged hours.
      prisma.taskAssignee.findFirst.mockResolvedValue(null);
      prisma.taskAssignee.upsert.mockResolvedValue({
        id: 9, taskId: TASK_ID, userId: USER_ID,
      });

      await service.addAssignee(TASK_ID, { userId: USER_ID });

      // findMany must NOT be called — that was the overlap-candidate
      // search. Its absence is the contract this test guards.
      expect(prisma.taskAssignee.findMany).not.toHaveBeenCalled();
      expect(prisma.taskAssignee.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeAssignee', () => {
    it('uses deleteMany so duplicates and soft-deleted rows are cleaned up', async () => {
      prisma.taskAssignee.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.removeAssignee(10, 42);

      expect(prisma.taskAssignee.deleteMany).toHaveBeenCalledWith({
        where: { taskId: 10, userId: 42 },
      });
      expect(result).toEqual({ message: 'Assignee removed' });
    });

    it('is idempotent when no row exists', async () => {
      prisma.taskAssignee.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.removeAssignee(10, 42)).resolves.toEqual({ message: 'Assignee removed' });
    });
  });

  describe('addAttachment', () => {
    const TASK_ID = 10;

    beforeEach(() => {
      prisma.task.findFirst.mockResolvedValue({ id: TASK_ID });
    });

    it('rejects external http:// URLs (open-redirect / stored XSS defense)', async () => {
      await expect(
        service.addAttachment(TASK_ID, 1, { fileName: 'x', fileUrl: 'http://evil.example/x' }),
      ).rejects.toThrow('fileUrl must be a relative path');
    });

    it('rejects javascript: URLs', async () => {
      await expect(
        service.addAttachment(TASK_ID, 1, { fileName: 'x', fileUrl: 'javascript:alert(1)' }),
      ).rejects.toThrow();
    });

    it('rejects protocol-relative //host/x URLs', async () => {
      await expect(
        service.addAttachment(TASK_ID, 1, { fileName: 'x', fileUrl: '//evil.example/x' }),
      ).rejects.toThrow(); // Fails the '://' or leading '/' check differently per impl; either way rejects.
    });

    it('accepts a relative path returned by the uploader', async () => {
      prisma.taskAttachment.create.mockResolvedValue({
        id: 1, fileUrl: '/attachments/a.pdf',
        uploader: { id: 1, firstName: 'A', lastName: 'B' },
      });

      const result = await service.addAttachment(TASK_ID, 1, {
        fileName: 'a.pdf',
        fileUrl: '/attachments/a.pdf',
      });

      expect(prisma.taskAttachment.create).toHaveBeenCalledTimes(1);
      expect(result).toHaveProperty('fileUrl', '/attachments/a.pdf');
    });
  });

  describe('update — core-fields guardrail gating (PR-010/011)', () => {
    // The guardrail is now scoped to updates that actually touch a
    // core field. Two representative scenarios:
    //   1) A status-only PATCH on an incomplete legacy task (missing
    //      serviceTypeId) must SUCCEED — historically this 400'd.
    //   2) A PATCH that clears a required core column (serviceTypeId
    //      set to null explicitly) on a non-personal task must STILL
    //      400 — the invariant on real core-field edits is intact.
    const TASK_ID = 77;
    const incompleteTask = {
      id: TASK_ID,
      projectId: 1,
      code: 'T-1',
      name: 'Legacy Task',
      status: 'not_started',
      isPersonal: false,
      // Missing serviceTypeId — the exact case that used to throw on
      // a harmless status change.
      serviceTypeId: null,
      zoneId: 10,
      projectDeliverableId: 5,
      deliverableTemplateId: null,
      requiresReview: false,
      endDate: null,
      budgetHours: 8,
    };

    it('lets a status-only update on an incomplete task pass (does not run missingCoreFields)', async () => {
      prisma.task.findFirst.mockResolvedValue(incompleteTask);
      prisma.task.update.mockResolvedValue({ ...incompleteTask, status: 'in_progress' });
      prisma.task.findUnique.mockResolvedValue({ budgetHours: 8, status: 'in_progress' });

      const result = await service.update(TASK_ID, { status: 'in_progress' } as any);

      expect(result).toBeDefined();
      // The PATCH went through — no BadRequestException was thrown.
      expect(prisma.task.update).toHaveBeenCalled();
    });

    it('still throws when a core field is being cleared on a non-personal task', async () => {
      prisma.task.findFirst.mockResolvedValue(incompleteTask);

      // Explicit null = "clearing" — the DTO touches serviceTypeId, so
      // the gate opens and the guardrail runs on the merged state.
      // The merged state has no service (existing null + clearing), no
      // template, so missingCoreFields returns entries → 400.
      await expect(
        service.update(TASK_ID, { serviceTypeId: null } as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.task.update).not.toHaveBeenCalled();
    });
  });

  describe('assertAttachmentAccess', () => {
    it('runs the provided check with the attachment\'s taskId', async () => {
      (prisma as any).taskAttachment.findUnique = jest.fn().mockResolvedValue({ taskId: 99 });
      const check = jest.fn().mockResolvedValue(undefined);

      await service.assertAttachmentAccess(5, check);

      expect(check).toHaveBeenCalledWith(99);
    });

    it('throws NotFoundException when the attachment does not exist', async () => {
      (prisma as any).taskAttachment.findUnique = jest.fn().mockResolvedValue(null);
      const check = jest.fn();

      await expect(service.assertAttachmentAccess(5, check)).rejects.toBeInstanceOf(NotFoundException);
      expect(check).not.toHaveBeenCalled();
    });
  });
});
