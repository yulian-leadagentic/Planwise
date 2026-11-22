import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import {
  EmployeeScopeService,
  isUserVisible,
  toLeaderView,
  LEADER_HIDDEN_ENTRY_KEYS,
} from './employee-scope.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Permissions round 3 — privacy (2026-11-22). EmployeeScopeService
 * decides who sees whose attendance and time entries:
 *   view    = self | hr:read | manager chain (manager of the employee's
 *             unit or of any ancestor). Admin without hr: no exception.
 *   edit    = hr:write | chain, never self.
 *   approve = hr:approve | chain, never self.
 * The chain check is uncached — a home-unit change applies at once.
 */

const perm = (route: string, flags: Record<string, boolean>) => ({ module: { route, name: route.slice(1) }, ...flags });

const HR_READER = { id: 10, isAdmin: false, roleModules: [perm('/hr', { canRead: true })] };
const HR_FULL = {
  id: 11,
  isAdmin: false,
  roleModules: [perm('/hr', { canRead: true, canWrite: true, canApprove: true })],
};
const MANAGER = { id: 20, isAdmin: false, roleModules: [perm('/time', { canRead: true, canWrite: true })] };
const STRANGER = {
  id: 40,
  isAdmin: false,
  roleModules: [perm('/time', { canRead: true, canWrite: true, canApprove: true })],
};
// Admin with every module but HR — admins get no HR shortcut.
const ADMIN_NO_HR = {
  id: 1,
  isAdmin: true,
  roleModules: [
    perm('/time', { canRead: true, canWrite: true, canApprove: true }),
    perm('/reports', { canRead: true }),
    perm('/admin', { canRead: true, canWrite: true }),
  ],
};
const EMPLOYEE_ID = 30;

describe('EmployeeScopeService', () => {
  let service: EmployeeScopeService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      user: {
        // Employee 30 lives in unit 7 → path /1/5/7/.
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === EMPLOYEE_ID ? { orgUnitId: 7, orgUnit: { path: '/1/5/7/' } } : { orgUnitId: null, orgUnit: null },
        ),
        findMany: jest.fn(async () => []),
      },
      orgUnit: {
        count: jest.fn(async () => 0),
        findMany: jest.fn(async () => []),
      },
      project: {
        findMany: jest.fn(async () => []),
        findFirst: jest.fn(async () => null),
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [EmployeeScopeService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(EmployeeScopeService);
  });

  describe('isInManagerChain', () => {
    it('looks for a live unit on the target path (own unit included) managed by the caller', async () => {
      prisma.orgUnit.count.mockResolvedValueOnce(1);
      await expect(service.isInManagerChain(MANAGER.id, EMPLOYEE_ID)).resolves.toBe(true);
      const where = prisma.orgUnit.count.mock.calls[0][0].where;
      expect(where.managerUserId).toBe(MANAGER.id);
      expect(where.deletedAt).toBeNull();
      expect([...where.id.in].sort((a: number, b: number) => a - b)).toEqual([1, 5, 7]);
    });

    it('false when no unit on the path is managed by the caller', async () => {
      prisma.orgUnit.count.mockResolvedValueOnce(0);
      await expect(service.isInManagerChain(STRANGER.id, EMPLOYEE_ID)).resolves.toBe(false);
    });

    it('false (no unit query) when the target has no home unit', async () => {
      await expect(service.isInManagerChain(MANAGER.id, 999)).resolves.toBe(false);
      expect(prisma.orgUnit.count).not.toHaveBeenCalled();
    });

    it('counts the home unit even when its path was never written ("/")', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ orgUnitId: 7, orgUnit: { path: '/' } });
      prisma.orgUnit.count.mockResolvedValueOnce(1);
      await service.isInManagerChain(MANAGER.id, EMPLOYEE_ID);
      expect(prisma.orgUnit.count.mock.calls[0][0].where.id.in).toEqual([7]);
    });

    it('is not memoised — a home-unit change applies on the next call', async () => {
      prisma.orgUnit.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
      await expect(service.isInManagerChain(MANAGER.id, EMPLOYEE_ID)).resolves.toBe(true);
      await expect(service.isInManagerChain(MANAGER.id, EMPLOYEE_ID)).resolves.toBe(false);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
      expect(prisma.orgUnit.count).toHaveBeenCalledTimes(2);
    });
  });

  describe('canViewEmployee', () => {
    it('self — no query', async () => {
      await expect(service.canViewEmployee(STRANGER, STRANGER.id)).resolves.toBe(true);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('hr:read — anyone, no query', async () => {
      await expect(service.canViewEmployee(HR_READER, EMPLOYEE_ID)).resolves.toBe(true);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('manager chain — yes', async () => {
      prisma.orgUnit.count.mockResolvedValueOnce(1);
      await expect(service.canViewEmployee(MANAGER, EMPLOYEE_ID)).resolves.toBe(true);
    });

    it('stranger — no', async () => {
      await expect(service.canViewEmployee(STRANGER, EMPLOYEE_ID)).resolves.toBe(false);
    });

    it('admin without hr — no exception', async () => {
      await expect(service.canViewEmployee(ADMIN_NO_HR, EMPLOYEE_ID)).resolves.toBe(false);
    });

    it('assertCanViewEmployee throws PERMISSION_DENIED with a plain message', async () => {
      const err: any = await service.assertCanViewEmployee(STRANGER, EMPLOYEE_ID, 'attendance').catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({
        code: 'PERMISSION_DENIED',
        message: expect.stringContaining('You can only view attendance of employees you manage.'),
        details: { reason: 'NOT_IN_MANAGER_CHAIN' },
      });
    });
  });

  describe('canEditAttendance / canApproveAttendance', () => {
    it('never one’s own record — not even with full HR rights', async () => {
      await expect(service.canEditAttendance(HR_FULL, HR_FULL.id)).resolves.toBe(false);
      await expect(service.canApproveAttendance(HR_FULL, HR_FULL.id)).resolves.toBe(false);
    });

    it('hr:write edits, hr:approve approves — hr:read alone does neither', async () => {
      await expect(service.canEditAttendance(HR_FULL, EMPLOYEE_ID)).resolves.toBe(true);
      await expect(service.canApproveAttendance(HR_FULL, EMPLOYEE_ID)).resolves.toBe(true);
      await expect(service.canEditAttendance(HR_READER, EMPLOYEE_ID)).resolves.toBe(false);
      await expect(service.canApproveAttendance(HR_READER, EMPLOYEE_ID)).resolves.toBe(false);
    });

    it('the manager chain edits and approves without any extra permission', async () => {
      prisma.orgUnit.count.mockResolvedValue(1);
      await expect(service.canEditAttendance(MANAGER, EMPLOYEE_ID)).resolves.toBe(true);
      await expect(service.canApproveAttendance(MANAGER, EMPLOYEE_ID)).resolves.toBe(true);
    });

    it('time:approve / Admin are not enough', async () => {
      await expect(service.canApproveAttendance(STRANGER, EMPLOYEE_ID)).resolves.toBe(false);
      await expect(service.canEditAttendance(ADMIN_NO_HR, EMPLOYEE_ID)).resolves.toBe(false);
      await expect(service.canApproveAttendance(ADMIN_NO_HR, EMPLOYEE_ID)).resolves.toBe(false);
    });
  });

  describe('visibleUserIds', () => {
    it("hr:read → 'all' without touching the org tree", async () => {
      await expect(service.visibleUserIds(HR_READER)).resolves.toBe('all');
      expect(prisma.orgUnit.findMany).not.toHaveBeenCalled();
    });

    it('non-manager → only himself', async () => {
      await expect(service.visibleUserIds(STRANGER)).resolves.toEqual([STRANGER.id]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('admin without hr → only himself', async () => {
      await expect(service.visibleUserIds(ADMIN_NO_HR)).resolves.toEqual([ADMIN_NO_HR.id]);
    });

    it('manager → himself + everyone whose home unit is in his subtree', async () => {
      prisma.orgUnit.findMany
        .mockResolvedValueOnce([{ id: 5, path: '/1/5/' }]) // managed units
        .mockResolvedValueOnce([{ id: 5 }, { id: 7 }]); // subtree
      prisma.user.findMany.mockResolvedValueOnce([{ id: 30 }, { id: 31 }]);
      const ids = await service.visibleUserIds(MANAGER);
      expect(ids).toEqual([MANAGER.id, 30, 31]);

      expect(prisma.orgUnit.findMany.mock.calls[0][0].where).toEqual({ managerUserId: MANAGER.id, deletedAt: null });
      expect(prisma.orgUnit.findMany.mock.calls[1][0].where.OR).toEqual([
        { id: { in: [5] } },
        { path: { startsWith: '/1/5/' } },
      ]);
      expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ orgUnitId: { in: [5, 7] }, id: { not: MANAGER.id } });
    });

    it('a managed unit with an unwritten path ("/") does not expand to the whole tree', async () => {
      prisma.orgUnit.findMany.mockResolvedValueOnce([{ id: 5, path: '/' }]).mockResolvedValueOnce([{ id: 5 }]);
      prisma.user.findMany.mockResolvedValueOnce([{ id: 30 }]);
      await service.visibleUserIds(MANAGER);
      expect(prisma.orgUnit.findMany.mock.calls[1][0].where.OR).toEqual([{ id: { in: [5] } }]);
    });

    it('is computed fresh on every call (no memo)', async () => {
      prisma.orgUnit.findMany
        .mockResolvedValueOnce([{ id: 5, path: '/1/5/' }])
        .mockResolvedValueOnce([{ id: 5 }])
        .mockResolvedValueOnce([]); // second call: no longer a manager
      prisma.user.findMany.mockResolvedValueOnce([{ id: 30 }]);
      await expect(service.visibleUserIds(MANAGER)).resolves.toEqual([MANAGER.id, 30]);
      await expect(service.visibleUserIds(MANAGER)).resolves.toEqual([MANAGER.id]);
    });
  });

  describe('project leader helpers', () => {
    it('ledProjectIds — live projects whose leaderId is the caller (leader only, not members)', async () => {
      prisma.project.findMany.mockResolvedValueOnce([{ id: 59 }, { id: 60 }]);
      await expect(service.ledProjectIds(20)).resolves.toEqual([59, 60]);
      expect(prisma.project.findMany.mock.calls[0][0].where).toEqual({ leaderId: 20, deletedAt: null });
    });

    it('isProjectLeader', async () => {
      prisma.project.findFirst.mockResolvedValueOnce({ leaderId: 20 });
      await expect(service.isProjectLeader(20, 59)).resolves.toBe(true);
      prisma.project.findFirst.mockResolvedValueOnce({ leaderId: 21 });
      await expect(service.isProjectLeader(20, 59)).resolves.toBe(false);
      await expect(service.isProjectLeader(20, null)).resolves.toBe(false);
    });

    it("timeEntryScope — hr:read sees all and needs no leader lookup", async () => {
      await expect(service.timeEntryScope(HR_READER)).resolves.toEqual({ visibleUserIds: 'all', ledProjectIds: [] });
      expect(prisma.project.findMany).not.toHaveBeenCalled();
    });

    it('timeEntryScope — others get visible ids + led projects', async () => {
      prisma.project.findMany.mockResolvedValueOnce([{ id: 59 }]);
      await expect(service.timeEntryScope(STRANGER)).resolves.toEqual({ visibleUserIds: [STRANGER.id], ledProjectIds: [59] });
    });
  });

  describe('pure helpers', () => {
    it('isUserVisible', () => {
      expect(isUserVisible('all', 5)).toBe(true);
      expect(isUserVisible([1, 5], 5)).toBe(true);
      expect(isUserVisible([1], 5)).toBe(false);
      expect(isUserVisible([], 5)).toBe(false);
    });

    it('toLeaderView keeps date / task / hours / note and drops location, bucket and clock data', () => {
      const entry = {
        id: 1,
        userId: 30,
        date: '2026-11-02',
        minutes: 120,
        note: 'modeling',
        task: { id: 11, name: 'Model L2' },
        location: 'home',
        specialHourBucketId: 3,
        specialHourBucket: { id: 3 },
        timeClockId: 77,
        startTime: '08:00',
        endTime: '10:00',
      };
      const out = toLeaderView(entry);
      expect(out).toEqual({ id: 1, userId: 30, date: '2026-11-02', minutes: 120, note: 'modeling', task: { id: 11, name: 'Model L2' } });
      for (const k of LEADER_HIDDEN_ENTRY_KEYS) expect(out).not.toHaveProperty(k);
      expect(entry.location).toBe('home'); // never mutates
    });
  });
});
