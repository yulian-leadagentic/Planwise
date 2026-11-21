import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ArgumentsHost, BadRequestException, ConflictException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { TasksService } from './tasks.service';
import { UpdateTaskDto } from './dto/update-task.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ProjectDeliverablesService } from '../project-deliverables/project-deliverables.service';

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
        // §12 (2026-11-14) · TasksService has injected
        // ProjectDeliverablesService since DP-EMPTY-3 (c14ad26,
        // 2026-11-08) but this module never provided it, so `compile()`
        // threw and EVERY spec in this file failed in `beforeEach`.
        // Only `create()` calls it (materializeFromTasks) — a no-op stub
        // is enough for the paths covered here.
        {
          provide: ProjectDeliverablesService,
          useValue: { materializeFromTasks: jest.fn() },
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
      // Setup: non-personal task placed by zoneId (projectId null). The
      // DTO clears zoneId → merged state has neither zoneId nor projectId
      // on a non-personal task → missingCoreFields trips.
      // (Post-2026-08-31 QA3 relaxation: Service / Deliverable / Review
      // are optional; the only placement invariant is zoneId OR projectId
      // for non-personal rows.)
      const taskPlacedByZone = { ...incompleteTask, projectId: null, zoneId: 10 };
      prisma.task.findFirst.mockResolvedValue(taskPlacedByZone);

      await expect(
        service.update(TASK_ID, { zoneId: null } as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.task.update).not.toHaveBeenCalled();
    });
  });

  // ─── Missing required fields reach the web (2026-11-21) ──────────────
  //
  // The guard used to throw `{ error: 'missing_required_fields', missing }`.
  // HttpExceptionFilter only forwards code / message / details, so the web
  // never saw the list and the create-task modal never lit its fields.
  // The list now rides in `details.missing` under MISSING_REQUIRED_FIELDS.
  describe('missing required fields → API envelope (2026-11-21)', () => {
    /** Runs a rejection through the real global filter; returns status + body. */
    function toEnvelope(err: unknown) {
      const filter = new HttpExceptionFilter();
      (filter as any).logger = { error: jest.fn(), warn: jest.fn() };
      const json = jest.fn();
      const status = jest.fn().mockReturnValue({ json });
      const host = {
        switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => ({}) }),
      } as unknown as ArgumentsHost;
      filter.catch(err, host);
      return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] };
    }

    async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
      try {
        await p;
      } catch (e) {
        return e;
      }
      throw new Error('expected a rejection');
    }

    it('create: a core task with neither zone nor project → MISSING_REQUIRED_FIELDS + details.missing', async () => {
      const err = await rejectionOf(service.create(1, { code: 'T-1', name: 'x' } as any));
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'MISSING_REQUIRED_FIELDS',
        details: { missing: ['zoneId'] },
      });

      const { status, body } = toEnvelope(err);
      expect(status).toBe(400);
      expect(body).toEqual({
        success: false,
        error: {
          code: 'MISSING_REQUIRED_FIELDS',
          message: 'Non-personal tasks need a Zone (or a project for project-root tasks).',
          details: { missing: ['zoneId'] },
        },
      });
    });

    it('create: a personal task without a Service → details.missing = [serviceTypeId]', async () => {
      const err = await rejectionOf(service.create(1, { code: 'T-1', name: 'x', isPersonal: true } as any));
      const { body } = toEnvelope(err);
      expect(body.error).toEqual({
        code: 'MISSING_REQUIRED_FIELDS',
        message: 'Service is required for personal tasks.',
        details: { missing: ['serviceTypeId'] },
      });
    });

    it('update: clearing the only placement → the same envelope', async () => {
      prisma.task.findFirst.mockResolvedValue({
        id: 77, projectId: null, zoneId: 10, isPersonal: false, status: 'not_started',
      });
      const err = await rejectionOf(service.update(77, { zoneId: null } as any));
      const { status, body } = toEnvelope(err);
      expect(status).toBe(400);
      expect(body.error).toMatchObject({
        code: 'MISSING_REQUIRED_FIELDS',
        details: { missing: ['zoneId'] },
      });
      expect(prisma.task.update).not.toHaveBeenCalled();
    });
  });

  // ─── §12 (2026-11-14) · estimatedStartDate never ends up after endDate ──
  //
  // Every due-date editor in the web PATCHes `{ endDate }` alone. Moving
  // the due date before the stored estimated start used to leave the
  // start behind — staging had tasks stored as start 2027-01-25 / end
  // 2027-01-11 after a target was pulled two weeks earlier through the
  // Deliverable-Planning tasks modal.
  describe('update — an end-only edit keeps estimatedStartDate ≤ endDate (§12)', () => {
    const TASK_ID = 88;
    const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
    const iso = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : v);
    const stored = (over: Record<string, unknown> = {}) => ({
      id: TASK_ID,
      projectId: 1,
      code: 'BIM-021',
      name: 'Model level 1',
      status: 'in_progress',
      isPersonal: false,
      zoneId: 695,
      budgetHours: 8,
      estimatedStartDate: d('2027-01-18'),
      endDate: d('2027-01-25'), // 7 calendar days long
      ...over,
    });
    /** Runs the update and returns the `data` handed to Prisma. */
    async function patch(existing: Record<string, unknown>, dto: Record<string, unknown>) {
      prisma.task.findFirst.mockResolvedValue(existing);
      prisma.task.update.mockImplementation(async ({ data }: any) => ({ ...existing, ...data }));
      await service.update(TASK_ID, dto as any, 7);
      return prisma.task.update.mock.calls[0][0].data;
    }

    it('end moved BEFORE the stored start → the start moves too and the task keeps its length', async () => {
      // The tasks-modal payload: `{ endDate, manualDueDate }`, two weeks earlier.
      const data = await patch(stored(), { endDate: '2027-01-11', manualDueDate: true });

      expect(iso(data.endDate)).toBe('2027-01-11');
      expect(iso(data.estimatedStartDate)).toBe('2027-01-04'); // still 7 days
      expect(data.dueDateOverridden).toBe(true); // the manual flag is unaffected
      expect('manualDueDate' in data).toBe(false);
    });

    it('accepts a full ISO timestamp for the new end (compared by UTC day)', async () => {
      const data = await patch(stored(), { endDate: '2027-01-11T00:00:00.000Z' });
      expect(iso(data.estimatedStartDate)).toBe('2027-01-04');
    });

    it('end moved earlier but still on/after the start → a shorten; the start is not touched', async () => {
      const data = await patch(stored(), { endDate: '2027-01-20' });

      expect(iso(data.endDate)).toBe('2027-01-20');
      expect(data.estimatedStartDate).toBeUndefined(); // Prisma leaves the column alone

      // Boundary: the end lands exactly ON the start.
      prisma.task.update.mockClear();
      const sameDay = await patch(stored(), { endDate: '2027-01-18' });
      expect(sameDay.estimatedStartDate).toBeUndefined();
    });

    it('end moved later → a lengthen; the start is not touched', async () => {
      const data = await patch(stored(), { endDate: '2027-02-08' });
      expect(data.estimatedStartDate).toBeUndefined();
    });

    it('a request that carries estimatedStartDate keeps full control of it — even a start after the end, even null', async () => {
      const both = await patch(stored(), { endDate: '2027-01-11', estimatedStartDate: '2027-01-15' });
      expect(iso(both.estimatedStartDate)).toBe('2027-01-15'); // not rejected, not rewritten

      prisma.task.update.mockClear();
      const cleared = await patch(stored(), { endDate: '2027-01-11', estimatedStartDate: null });
      expect(cleared.estimatedStartDate).toBeNull();
    });

    it('no valid previous length → the budget-based length forceApplyTargetToTask uses', async () => {
      // (a) already stored inverted (start after end): end-only edit to a
      //     day that is still before the start → due − ceil(100h/40) = 3 weeks.
      const inverted = await patch(
        stored({ estimatedStartDate: d('2027-01-25'), endDate: d('2027-01-11'), budgetHours: 100 }),
        { endDate: '2027-01-18' },
      );
      expect(iso(inverted.estimatedStartDate)).toBe('2026-12-28');

      // (b) no stored end at all, no budget → one week.
      prisma.task.update.mockClear();
      const noEnd = await patch(stored({ endDate: null, budgetHours: null }), { endDate: '2027-01-11' });
      expect(iso(noEnd.estimatedStartDate)).toBe('2027-01-04');

      // (c) a budget change in the same request is the one that counts.
      prisma.task.update.mockClear();
      const rebudgeted = await patch(stored({ endDate: null }), { endDate: '2027-01-11', budgetHours: 80 });
      expect(iso(rebudgeted.estimatedStartDate)).toBe('2026-12-28'); // 80h → 2 weeks
    });

    it('never invents a start: no stored start, a cleared end, or an unchanged end leave it alone', async () => {
      const noStart = await patch(stored({ estimatedStartDate: null }), { endDate: '2027-01-11' });
      expect(noStart.estimatedStartDate).toBeUndefined();

      prisma.task.update.mockClear();
      const cleared = await patch(stored(), { endDate: null });
      expect(cleared.endDate).toBeNull();
      expect(cleared.estimatedStartDate).toBeUndefined();

      // Re-sending the stored end of an already-inverted row is not an
      // end change — only a real move repairs it.
      prisma.task.update.mockClear();
      const resent = await patch(
        stored({ estimatedStartDate: d('2027-01-25'), endDate: d('2027-01-11') }),
        { endDate: '2027-01-11' },
      );
      expect(resent.estimatedStartDate).toBeUndefined();

      // An update with no dates at all.
      prisma.task.update.mockClear();
      const rename = await patch(stored(), { name: 'Renamed' });
      expect(rename.estimatedStartDate).toBeUndefined();
      expect(rename.endDate).toBeUndefined();
    });

    it('records the moved start in the activity log next to the fields the request named', async () => {
      const activityLog = (service as any).activityLog;

      await patch(stored(), { endDate: '2027-01-11', manualDueDate: true });

      expect(activityLog.logTaskUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: TASK_ID,
          changedFields: ['endDate', 'manualDueDate', 'estimatedStartDate'],
        }),
      );
    });
  });

  // ─── §14 (2026-11-15) · PATCH /tasks/:id can release a manual due date ──
  //
  // `dueDateOverridden` ("manual due date") pins a task for the
  // scheduler. Until §14 nothing in `update` could clear it: "Clear"
  // (`endDate: null`) left a task with no date still flagged manual, and
  // there was no way to say "keep the date, but let the scheduler own it
  // again".
  describe('update — releasing a manual due date (§14)', () => {
    const TASK_ID = 91;
    const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
    const iso = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : v);
    /** A task the PM dated by hand. */
    const manualTask = (over: Record<string, unknown> = {}) => ({
      id: TASK_ID,
      projectId: 1,
      code: 'BIM-030',
      name: 'Coordinate level 2',
      status: 'in_progress',
      isPersonal: false,
      zoneId: 695,
      budgetHours: 8,
      estimatedStartDate: d('2026-11-23'),
      endDate: d('2026-11-30'),
      dueDateOverridden: true,
      ...over,
    });
    /** Runs the update and returns the `data` handed to Prisma. */
    async function patch(existing: Record<string, unknown>, dto: UpdateTaskDto) {
      prisma.task.update.mockClear();
      prisma.task.findFirst.mockResolvedValue(existing);
      prisma.task.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...existing,
        ...data,
      }));
      await service.update(TASK_ID, dto, 7);
      return prisma.task.update.mock.calls[0][0].data;
    }

    it('an explicit endDate: null clears the flag together with the date', async () => {
      const data = await patch(manualTask(), { endDate: null });

      expect(data.endDate).toBeNull();
      expect(data.dueDateOverridden).toBe(false);
    });

    it('endDate: null clears the flag whatever manualDueDate says — a task without a due date has no manual date', async () => {
      const withTrue = await patch(manualTask(), { endDate: null, manualDueDate: true });
      expect(withTrue.endDate).toBeNull();
      expect(withTrue.dueDateOverridden).toBe(false);

      const withFalse = await patch(manualTask(), { endDate: null, manualDueDate: false });
      expect(withFalse.dueDateOverridden).toBe(false);
      expect('manualDueDate' in withFalse).toBe(false);
    });

    it('manualDueDate: false alone hands the stored date back to the scheduler — the date itself is not touched', async () => {
      const data = await patch(manualTask(), { manualDueDate: false });

      expect(data.dueDateOverridden).toBe(false);
      expect(data.endDate).toBeUndefined(); // Prisma leaves the column alone
      expect(data.estimatedStartDate).toBeUndefined();
      expect('manualDueDate' in data).toBe(false); // transport-only — never reaches Prisma
    });

    it('manualDueDate: false next to an endDate stores the new end as an ordinary, non-manual date', async () => {
      const changed = await patch(manualTask(), { endDate: '2026-12-07', manualDueDate: false });
      expect(iso(changed.endDate)).toBe('2026-12-07');
      expect(changed.dueDateOverridden).toBe(false);

      // Also when the end sent is the one already stored.
      const same = await patch(manualTask(), { endDate: '2026-11-30', manualDueDate: false });
      expect(iso(same.endDate)).toBe('2026-11-30');
      expect(same.dueDateOverridden).toBe(false);
    });

    it('manualDueDate left out → the flag is not part of the update at all (every automatic caller)', async () => {
      // A changed end, the stored end re-sent, another date, and an update with no dates.
      for (const dto of [
        { endDate: '2026-12-07' },
        { endDate: '2026-11-30' },
        { estimatedStartDate: '2026-11-16' },
        { name: 'Renamed' },
      ]) {
        const data = await patch(manualTask(), dto);
        expect('dueDateOverridden' in data).toBe(false);
      }
      // Same for a task that is not manual.
      const plain = await patch(manualTask({ dueDateOverridden: false }), { endDate: '2026-12-07' });
      expect('dueDateOverridden' in plain).toBe(false);
    });

    it('manualDueDate: true is unchanged: it marks only together with a changed, non-null end', async () => {
      const marked = await patch(manualTask({ dueDateOverridden: false }), {
        endDate: '2026-12-07',
        manualDueDate: true,
      });
      expect(iso(marked.endDate)).toBe('2026-12-07');
      expect(marked.dueDateOverridden).toBe(true);

      // The stored end re-sent, or no end at all → no mark, and no release either.
      const resent = await patch(manualTask({ dueDateOverridden: false }), {
        endDate: '2026-11-30',
        manualDueDate: true,
      });
      expect('dueDateOverridden' in resent).toBe(false);
      const noEnd = await patch(manualTask(), { manualDueDate: true });
      expect('dueDateOverridden' in noEnd).toBe(false);
    });

    it('records the released flag in the activity log — only when a stored manual flag really flips', async () => {
      const { activityLog } = service as unknown as { activityLog: { logTaskUpdated: jest.Mock } };
      const lastFields = () => activityLog.logTaskUpdated.mock.calls.at(-1)?.[0].changedFields;

      await patch(manualTask(), { endDate: null });
      expect(lastFields()).toEqual(['endDate', 'dueDateOverridden']);

      await patch(manualTask(), { manualDueDate: false });
      expect(lastFields()).toEqual(['manualDueDate', 'dueDateOverridden']);

      // Nothing flipped: the task was not manual to begin with…
      await patch(manualTask({ dueDateOverridden: false }), { endDate: null });
      expect(lastFields()).toEqual(['endDate']);
      // …or the request does not release.
      await patch(manualTask(), { endDate: '2026-12-07' });
      expect(lastFields()).toEqual(['endDate']);
    });

    it('the DTO lets manualDueDate: false and endDate: null through the global ValidationPipe', async () => {
      // Same options as main.ts. `false` and `null` are the two values a
      // validator / transformer most easily drops as "not sent".
      const pipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      });
      const meta = { type: 'body' as const, metatype: UpdateTaskDto };

      const released: UpdateTaskDto = await pipe.transform({ manualDueDate: false }, meta);
      expect(released.manualDueDate).toBe(false);

      const cleared: UpdateTaskDto = await pipe.transform({ endDate: null, manualDueDate: false }, meta);
      expect(cleared.endDate).toBeNull();
      expect(cleared.manualDueDate).toBe(false);

      const marked: UpdateTaskDto = await pipe.transform({ endDate: '2026-12-07', manualDueDate: true }, meta);
      expect(marked.manualDueDate).toBe(true);

      const untouched: UpdateTaskDto = await pipe.transform({ endDate: '2026-12-07' }, meta);
      expect(untouched.manualDueDate).toBeUndefined();
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

  // 2026-11-19 — soft task delete keeps TaskDependency rows (restore
  // brings them back); the soft-delete middleware only filters the
  // top-level query, so the nested dependency includes must drop edges
  // whose other end is deleted themselves.
  describe('dependency edges with a soft-deleted end are not shipped', () => {
    it('GET /tasks/:id — predecessors and successors both filter the other end on deletedAt', async () => {
      prisma.task.findFirst.mockResolvedValue({ id: 7, dependencies: [], dependedBy: [] });

      await service.findOne(7);

      const include = prisma.task.findFirst.mock.calls[0][0].include;
      expect(include.dependencies.where).toEqual({ dependsOn: { deletedAt: null } });
      expect(include.dependedBy.where).toEqual({ task: { deletedAt: null } });
      // The embedded task shapes the drawer reads are unchanged.
      expect(include.dependencies.include.dependsOn.select).toEqual({ id: true, code: true, name: true, endDate: true });
      expect(include.dependedBy.include.task.select).toEqual({ id: true, code: true, name: true, endDate: true });
    });

    it('GET /tasks — the predecessor include filters deleted predecessors', async () => {
      prisma.task.findMany = jest.fn().mockResolvedValue([]);
      prisma.task.count = jest.fn().mockResolvedValue(0);

      await service.findAll({} as any);

      const include = prisma.task.findMany.mock.calls[0][0].include;
      expect(include.dependencies.where).toEqual({ dependsOn: { deletedAt: null } });
      expect(include.dependencies.include.dependsOn.select).toEqual({ id: true, code: true, name: true, endDate: true });
    });
  });

  // ─── 2026-11-20 · task restore: its deleted zone comes back, and so does its status ──
  //
  // Zone delete archives the zone's tasks; restoring one used to bring
  // the task back under a zone that stayed deleted (no place in the
  // planning tree, no UI to restore the zone). And delete flips status
  // to 'cancelled' while restore always wrote 'not_started', so a
  // completed task came back as not started.
  describe('restore — deleted zone chain and previous status', () => {
    const TASK_ID = 5;
    const DELETED_AT = new Date('2026-11-19T08:00:00.000Z');

    type ZoneRow = { id: number; projectId: number; parentId: number | null; name: string; deletedAt: Date | null };
    type TaskRow = {
      id: number;
      zoneId: number | null;
      status: string;
      statusBeforeDelete: string | null;
      deletedAt: Date | null;
    };

    /**
     * In-memory task + zone tables behind the mocked Prisma. The
     * interactive transaction hands the same client to the callback,
     * so writes inside it land in these rows. `findFirst` honours the
     * explicit `deletedAt` predicates restore and findOne use.
     */
    function seed(task: TaskRow, zones: ZoneRow[] = []) {
      const taskRow = { ...task };
      const zoneRows = new Map(zones.map((z) => [z.id, { ...z }]));
      const p = prisma as any;

      p.task.findFirst.mockImplementation(async ({ where }: any) => {
        if (where.id !== taskRow.id) return null;
        const deleted = taskRow.deletedAt != null;
        if (where.deletedAt === null && deleted) return null;
        if (where.deletedAt && 'not' in where.deletedAt && !deleted) return null;
        return { ...taskRow };
      });
      p.task.update.mockImplementation(async ({ where, data }: any) => {
        if (where.id !== taskRow.id) throw new Error(`unexpected task.update on ${where.id}`);
        Object.assign(taskRow, data);
        return { ...taskRow };
      });
      p.task.updateMany = jest.fn();
      p.zone = {
        findUnique: jest.fn(async ({ where }: any) => {
          const z = zoneRows.get(where.id);
          return z ? { ...z } : null;
        }),
        findFirst: jest.fn(async ({ where }: any) => {
          const hit = [...zoneRows.values()].find(
            (z) =>
              z.projectId === where.projectId &&
              z.name === where.name &&
              (where.deletedAt !== null || z.deletedAt == null),
          );
          return hit ? { id: hit.id } : null;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          Object.assign(zoneRows.get(where.id)!, data);
          return { ...zoneRows.get(where.id)! };
        }),
        updateMany: jest.fn(),
      };
      p.$transaction = jest.fn(async (fn: any) => fn(p));
      return { taskRow, zoneRows };
    }

    const zone = (id: number, parentId: number | null, name: string, deleted: boolean): ZoneRow => ({
      id,
      projectId: 59,
      parentId,
      name: deleted ? `${name} #deleted-${id}-${DELETED_AT.getTime()}` : name,
      deletedAt: deleted ? DELETED_AT : null,
    });

    it('(a) zone is live → only the task is restored, no zone writes, restoredZones: []', async () => {
      const { taskRow } = seed(
        { id: TASK_ID, zoneId: 10, status: 'cancelled', statusBeforeDelete: 'in_progress', deletedAt: DELETED_AT },
        [zone(1, null, 'Site', false), zone(10, 1, 'Level 1', false)],
      );
      const p = prisma as any;

      const result = await service.restore(TASK_ID);

      expect(result).toEqual({ message: 'Task restored', id: TASK_ID, restoredZones: [] });
      // The archived row is found by an explicit deletedAt predicate (the middleware would hide it otherwise).
      expect(p.task.findFirst.mock.calls[0][0].where).toEqual({ id: TASK_ID, deletedAt: { not: null } });
      expect(p.zone.update).not.toHaveBeenCalled();
      expect(p.task.update).toHaveBeenCalledTimes(1);
      expect(p.task.update).toHaveBeenCalledWith({
        where: { id: TASK_ID },
        data: { deletedAt: null, status: 'in_progress', statusBeforeDelete: null },
      });
      expect(p.$transaction).toHaveBeenCalledTimes(1);
      expect(taskRow.deletedAt).toBeNull();
    });

    it('a project-root task (no zone) restores without looking at zones', async () => {
      seed({ id: TASK_ID, zoneId: null, status: 'cancelled', statusBeforeDelete: 'on_hold', deletedAt: DELETED_AT });
      const p = prisma as any;

      const result = await service.restore(TASK_ID);

      expect(result).toEqual({ message: 'Task restored', id: TASK_ID, restoredZones: [] });
      expect(p.zone.findUnique).not.toHaveBeenCalled();
      expect(p.task.update.mock.calls[0][0].data.status).toBe('on_hold');
    });

    it('(b) deleted zone with a deleted parent and a live grandparent → both deleted zones restored, suffix stripped; nothing else', async () => {
      // 1 Site (live) → 11 Building A (deleted) → 12 Level 1 (deleted, the task's zone)
      //                                         → 13 Level 2 (deleted sibling)
      //                                         12 → 14 Room (deleted descendant)
      const { zoneRows } = seed(
        { id: TASK_ID, zoneId: 12, status: 'cancelled', statusBeforeDelete: 'completed', deletedAt: DELETED_AT },
        [
          zone(1, null, 'Site', false),
          zone(11, 1, 'Building A', true),
          zone(12, 11, 'Level 1', true),
          zone(13, 11, 'Level 2', true),
          zone(14, 12, 'Room', true),
        ],
      );
      const p = prisma as any;

      const result = await service.restore(TASK_ID);

      // Outermost ancestor first.
      expect(result).toEqual({
        message: 'Task restored',
        id: TASK_ID,
        restoredZones: [
          { id: 11, name: 'Building A' },
          { id: 12, name: 'Level 1' },
        ],
      });
      expect(p.zone.update.mock.calls.map((c: any) => c[0])).toEqual([
        { where: { id: 11 }, data: { deletedAt: null, name: 'Building A' } },
        { where: { id: 12 }, data: { deletedAt: null, name: 'Level 1' } },
      ]);
      // The walk stopped at the live grandparent; it was read, never written.
      expect(p.zone.findUnique.mock.calls.map((c: any) => c[0].where.id)).toEqual([12, 11, 1]);
      expect(zoneRows.get(1)).toMatchObject({ name: 'Site', deletedAt: null });
      // Sibling and descendant zones stay deleted.
      expect(zoneRows.get(13)!.deletedAt).toEqual(DELETED_AT);
      expect(zoneRows.get(14)!.deletedAt).toEqual(DELETED_AT);
      // path / depth / parentId are not part of the write.
      expect(zoneRows.get(12)!.parentId).toBe(11);
      // Only this task: one single-row update, no bulk task / zone writes.
      expect(p.task.update).toHaveBeenCalledTimes(1);
      expect(p.task.update.mock.calls[0][0].where).toEqual({ id: TASK_ID });
      expect(p.task.updateMany).not.toHaveBeenCalled();
      expect(p.zone.updateMany).not.toHaveBeenCalled();
      // Zone chain and task in the same transaction.
      expect(p.$transaction).toHaveBeenCalledTimes(1);
    });

    it('stops at a missing ancestor row and at the project root', async () => {
      seed(
        { id: TASK_ID, zoneId: 12, status: 'cancelled', statusBeforeDelete: null, deletedAt: DELETED_AT },
        [zone(12, 999, 'Level 1', true)], // parent 999 does not exist
      );
      const missing = await service.restore(TASK_ID);
      expect((missing as any).restoredZones).toEqual([{ id: 12, name: 'Level 1' }]);

      seed(
        { id: TASK_ID, zoneId: 1, status: 'cancelled', statusBeforeDelete: null, deletedAt: DELETED_AT },
        [zone(1, null, 'Site', true)],
      );
      const root = await service.restore(TASK_ID);
      expect((root as any).restoredZones).toEqual([{ id: 1, name: 'Site' }]);
    });

    it('(c) a live zone already has the name → "<name> (restored)", then "(restored 2)", …', async () => {
      seed(
        { id: TASK_ID, zoneId: 12, status: 'cancelled', statusBeforeDelete: null, deletedAt: DELETED_AT },
        [zone(1, null, 'Site', false), zone(12, 1, 'Level 1', true), zone(20, 1, 'Level 1', false)],
      );
      const first = await service.restore(TASK_ID);
      expect((first as any).restoredZones).toEqual([{ id: 12, name: 'Level 1 (restored)' }]);

      seed(
        { id: TASK_ID, zoneId: 12, status: 'cancelled', statusBeforeDelete: null, deletedAt: DELETED_AT },
        [
          zone(1, null, 'Site', false),
          zone(12, 1, 'Level 1', true),
          zone(20, 1, 'Level 1', false),
          zone(21, 1, 'Level 1 (restored)', false),
          // A deleted zone holding the exact name does not count
          // (explodeTypical soft-deletes without the #deleted suffix).
          { ...zone(22, 1, 'Level 1 (restored 2)', false), deletedAt: DELETED_AT },
        ],
      );
      const second = await service.restore(TASK_ID);
      expect((second as any).restoredZones).toEqual([{ id: 12, name: 'Level 1 (restored 2)' }]);
    });

    it('(c) a restored ancestor counts as taken for a same-named descendant restored with it', async () => {
      seed(
        { id: TASK_ID, zoneId: 12, status: 'cancelled', statusBeforeDelete: null, deletedAt: DELETED_AT },
        [zone(1, null, 'Site', false), zone(11, 1, 'Level', true), zone(12, 11, 'Level', true)],
      );
      const result = await service.restore(TASK_ID);
      expect((result as any).restoredZones).toEqual([
        { id: 11, name: 'Level' },
        { id: 12, name: 'Level (restored)' },
      ]);
    });

    it('(d) completed → delete → restore comes back completed, statusBeforeDelete cleared', async () => {
      const { taskRow } = seed({
        id: TASK_ID,
        zoneId: null,
        status: 'completed',
        statusBeforeDelete: null,
        deletedAt: null,
      });
      const p = prisma as any;

      await service.remove(TASK_ID);

      expect(p.task.update.mock.calls[0][0]).toEqual({
        where: { id: TASK_ID },
        data: { deletedAt: expect.any(Date), statusBeforeDelete: 'completed', status: 'cancelled' },
      });
      expect(taskRow).toMatchObject({ status: 'cancelled', statusBeforeDelete: 'completed' });

      await service.restore(TASK_ID);

      expect(taskRow).toMatchObject({ status: 'completed', statusBeforeDelete: null, deletedAt: null });
    });

    it('(d) statusBeforeDelete null: cancelled → not_started (deleted before the column existed); any other status is kept', async () => {
      const legacy = seed({ id: TASK_ID, zoneId: null, status: 'cancelled', statusBeforeDelete: null, deletedAt: DELETED_AT });
      await service.restore(TASK_ID);
      expect(legacy.taskRow).toMatchObject({ status: 'not_started', statusBeforeDelete: null });

      // A middleware soft delete (e.g. project delete) never touched the status.
      const viaMiddleware = seed({ id: TASK_ID, zoneId: null, status: 'in_progress', statusBeforeDelete: null, deletedAt: DELETED_AT });
      await service.restore(TASK_ID);
      expect(viaMiddleware.taskRow).toMatchObject({ status: 'in_progress', statusBeforeDelete: null });
    });

    it('keeps the alreadyActive / 404 answers and writes nothing for them', async () => {
      seed({ id: TASK_ID, zoneId: 12, status: 'in_progress', statusBeforeDelete: null, deletedAt: null });
      const p = prisma as any;

      await expect(service.restore(TASK_ID)).resolves.toEqual({ message: 'Task is not archived', alreadyActive: true });
      await expect(service.restore(404)).rejects.toBeInstanceOf(NotFoundException);
      expect(p.$transaction).not.toHaveBeenCalled();
      expect(p.task.update).not.toHaveBeenCalled();
    });
  });
});
