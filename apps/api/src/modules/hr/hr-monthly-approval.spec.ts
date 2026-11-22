import { ForbiddenException } from '@nestjs/common';

import { HrMonthlyService, SELF_APPROVAL_NOT_ALLOWED } from './hr-monthly.service';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';

/**
 * Permissions round 3 (2026-11-22) — monthly attendance approval:
 *   • nobody approves his own month, an HR approver included
 *     (403 SELF_APPROVAL_NOT_ALLOWED);
 *   • approve / reopen / lock write an HR audit row with the actor;
 *   • locking no longer overwrites approvedBy* with the locker.
 */

const flush = () => new Promise((r) => setImmediate(r));

function make(row: any) {
  const prisma: any = {
    monthlyAttendance: {
      findUnique: jest.fn(async () => row),
      update: jest.fn(async ({ data }: any) => ({ ...row, ...data })),
    },
  };
  const activityLog: any = { logHrEvent: jest.fn(async () => undefined) };
  return { svc: new HrMonthlyService(prisma, activityLog), prisma, activityLog };
}

const ROW = {
  id: 11,
  userId: 42,
  year: 2026,
  month: 10,
  status: 'OPEN',
  approvedById: null,
  approvedAt: null,
  monthlyStandard: 180,
  actualHours: 180,
  weightedHours: 180,
  deviation: 0,
  sickDays: 0,
  vacationDays: 0,
};

describe('HrMonthlyService.approve — no self-approval', () => {
  it('refuses when the approver is the employee (403 SELF_APPROVAL_NOT_ALLOWED)', async () => {
    const { svc, prisma, activityLog } = make(ROW);
    const err = await svc.approve({ userId: 42, year: 2026, month: 10, approverId: 42 }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({
      code: SELF_APPROVAL_NOT_ALLOWED,
      message: "You can't approve your own month — another HR approver must do it.",
    });
    expect(prisma.monthlyAttendance.update).not.toHaveBeenCalled();
    await flush();
    expect(activityLog.logHrEvent).not.toHaveBeenCalled();
  });

  it('the code survives the HttpExceptionFilter (the web reads it)', async () => {
    const { svc } = make(ROW);
    const err = await svc.approve({ userId: 42, year: 2026, month: 10, approverId: 42 }).catch((e) => e);
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    const host: any = {
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ method: 'POST', url: '/hr/monthly/42/approve' }) }),
    };
    new HttpExceptionFilter().catch(err, host);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json.mock.calls[0][0].error.code).toBe(SELF_APPROVAL_NOT_ALLOWED);
  });

  it('refuses self-approval even when the row is not computed yet', async () => {
    const { svc } = make(null);
    await expect(svc.approve({ userId: 42, year: 2026, month: 10, approverId: 42 })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('another HR approver can approve; the audit row names him', async () => {
    const { svc, prisma, activityLog } = make(ROW);
    await svc.approve({ userId: 42, year: 2026, month: 10, approverId: 7 });
    expect(prisma.monthlyAttendance.update.mock.calls[0][0].data).toMatchObject({ status: 'APPROVED', approvedById: 7 });
    await flush();
    expect(activityLog.logHrEvent.mock.calls[0][0]).toMatchObject({
      action: 'hr.monthly.approved',
      actorUserId: 7,
      entityType: 'monthly_attendance',
      entityId: 11,
      metadata: { employeeId: 42, year: 2026, month: 10 },
      changes: { status: { from: 'OPEN', to: 'APPROVED' } },
    });
  });
});

describe('HrMonthlyService.lockMonth — keeps the approver', () => {
  it('locking an APPROVED row changes only the status and audits the locker', async () => {
    const approvedAt = new Date('2026-11-02T08:00:00Z');
    const { svc, prisma, activityLog } = make({ ...ROW, status: 'APPROVED', approvedById: 7, approvedAt });
    const out = await svc.lockMonth({ userId: 42, year: 2026, month: 10, lockerId: 99 });
    expect(prisma.monthlyAttendance.update.mock.calls[0][0].data).toEqual({ status: 'LOCKED' });
    expect(out.approvedById).toBe(7);
    await flush();
    expect(activityLog.logHrEvent.mock.calls[0][0]).toMatchObject({
      action: 'hr.monthly.locked',
      actorUserId: 99,
      metadata: { employeeId: 42 },
      changes: { status: { from: 'APPROVED', to: 'LOCKED' } },
    });
  });
});

describe('HrMonthlyService.lockMonth — no self-lock before approval', () => {
  const SELF_LOCK_MESSAGE = "You can't lock your own month before another HR approver approves it.";

  it('refuses locking his own OPEN month (403 SELF_APPROVAL_NOT_ALLOWED), writes nothing', async () => {
    const { svc, prisma, activityLog } = make(ROW);
    const err = await svc.lockMonth({ userId: 42, year: 2026, month: 10, lockerId: 42 }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({
      code: SELF_APPROVAL_NOT_ALLOWED,
      message: SELF_LOCK_MESSAGE,
      details: { userId: 42, year: 2026, month: 10, status: 'OPEN' },
    });
    expect(prisma.monthlyAttendance.update).not.toHaveBeenCalled();
    await flush();
    expect(activityLog.logHrEvent).not.toHaveBeenCalled();
  });

  it('refuses before computing when his own month has no row yet', async () => {
    const { svc, prisma } = make(null);
    const compute = jest.spyOn(svc, 'computeMonth');
    const err = await svc.lockMonth({ userId: 42, year: 2026, month: 10, lockerId: 42 }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ code: SELF_APPROVAL_NOT_ALLOWED, details: { status: null } });
    expect(compute).not.toHaveBeenCalled();
    expect(prisma.monthlyAttendance.update).not.toHaveBeenCalled();
  });

  it.each([
    ['approved by himself (legacy row)', 42],
    ['approved with no recorded approver', null],
  ])('refuses his own month %s', async (_label, approvedById) => {
    const { svc, prisma } = make({ ...ROW, status: 'APPROVED', approvedById, approvedAt: new Date() });
    await expect(svc.lockMonth({ userId: 42, year: 2026, month: 10, lockerId: 42 })).rejects.toMatchObject({
      response: { code: SELF_APPROVAL_NOT_ALLOWED },
    });
    expect(prisma.monthlyAttendance.update).not.toHaveBeenCalled();
  });

  it('locks his own month once another HR approver approved it', async () => {
    const { svc, prisma, activityLog } = make({ ...ROW, status: 'APPROVED', approvedById: 7, approvedAt: new Date() });
    const out = await svc.lockMonth({ userId: 42, year: 2026, month: 10, lockerId: 42 });
    expect(prisma.monthlyAttendance.update.mock.calls[0][0].data).toEqual({ status: 'LOCKED' });
    expect(out.status).toBe('LOCKED');
    expect(out.approvedById).toBe(7);
    await flush();
    expect(activityLog.logHrEvent.mock.calls[0][0]).toMatchObject({ action: 'hr.monthly.locked', actorUserId: 42 });
  });

  it('his own already-LOCKED month stays an idempotent no-op', async () => {
    const { svc, prisma } = make({ ...ROW, status: 'LOCKED', approvedById: 7, approvedAt: new Date() });
    const out = await svc.lockMonth({ userId: 42, year: 2026, month: 10, lockerId: 42 });
    expect(out.status).toBe('LOCKED');
    expect(prisma.monthlyAttendance.update).not.toHaveBeenCalled();
  });

  it("someone else's OPEN month still locks directly", async () => {
    const { svc, prisma } = make(ROW);
    const out = await svc.lockMonth({ userId: 42, year: 2026, month: 10, lockerId: 99 });
    expect(prisma.monthlyAttendance.update.mock.calls[0][0].data).toEqual({ status: 'LOCKED' });
    expect(out.status).toBe('LOCKED');
  });
});

describe('HrMonthlyService.reopen — records who reopened', () => {
  it('clears the approval and writes the reopener + the undone approver to the audit', async () => {
    const { svc, prisma, activityLog } = make({ ...ROW, status: 'APPROVED', approvedById: 7, approvedAt: new Date() });
    await svc.reopen({ userId: 42, year: 2026, month: 10, actorId: 8 });
    expect(prisma.monthlyAttendance.update.mock.calls[0][0].data).toEqual({
      status: 'OPEN',
      approvedById: null,
      approvedAt: null,
    });
    await flush();
    expect(activityLog.logHrEvent.mock.calls[0][0]).toMatchObject({
      action: 'hr.monthly.reopened',
      actorUserId: 8,
      severity: 'warn',
      metadata: { employeeId: 42 },
      changes: { status: { from: 'APPROVED', to: 'OPEN' }, approvedById: { from: 7, to: null } },
    });
  });

  it('a no-op reopen of an OPEN row writes nothing', async () => {
    const { svc, prisma, activityLog } = make(ROW);
    await svc.reopen({ userId: 42, year: 2026, month: 10, actorId: 8 });
    expect(prisma.monthlyAttendance.update).not.toHaveBeenCalled();
    await flush();
    expect(activityLog.logHrEvent).not.toHaveBeenCalled();
  });
});
