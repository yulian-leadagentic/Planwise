import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { PrismaService } from '../../prisma/prisma.service';

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
      },
      taskAssignee: {
        findFirst: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
      },
      taskAttachment: {
        create: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
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
