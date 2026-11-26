/**
 * Permissions round 4 (2026-11-23) — project-scoped routes outside the
 * projects controller: files, partner roles, status board, presence,
 * labels, scheduling, deliverables and team templates.
 *
 * Each controller runs against the REAL ProjectAccessService over a fake
 * Prisma: project 42 (leader 7), user 3 has a member row, user 50 is a
 * stranger with every module permission.
 */
import { BadRequestException } from '@nestjs/common';

import { ProjectAccessService } from '../common/services/project-access.service';
import { PermissionDeniedException } from '../common/errors/permission-denied';
import { ProjectFilesController } from './project-files/project-files.controller';
import { ProjectPartnerRolesController } from './project-partner-roles/project-partner-roles.controller';
import { ProjectStatusBoardController } from './project-status-board/project-status-board.controller';
import { PresenceController } from './presence/presence.controller';
import { LabelsController } from './labels/labels.controller';
import { LabelsService } from './labels/labels.service';
import { SchedulingController } from './scheduling/scheduling.controller';
import { SchedulerService } from './scheduling/scheduler.service';
import { ProjectDeliverablesController } from './project-deliverables/project-deliverables.controller';
import { ProjectDeliverablesService } from './project-deliverables/project-deliverables.service';
import { TeamTemplatesController } from './team-templates/team-templates.controller';

const perm = (route: string) => ({
  module: { route, name: route.slice(1) },
  canRead: true,
  canWrite: true,
  canDelete: true,
});
const ALL = ['/projects', '/projects/files', '/partners'].map(perm);

const LEADER = { id: 7, isAdmin: false, roleModules: ALL };
const MEMBER = { id: 3, isAdmin: false, roleModules: ALL };
const STRANGER = { id: 50, isAdmin: false, roleModules: ALL };
const ADMIN = { id: 1, isAdmin: true, roleModules: [] as any[] };
// QA6 round 3 · opens project 43 through its org unit 9 only; every module grant.
const ORG_VIEWER = { id: 70, isAdmin: false, roleModules: ALL };
const ORG_PROJECT = 43;
const ORG_UNIT = 9;

function realAccess(): ProjectAccessService {
  const prisma: any = {
    project: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === 42
          ? { id: 42, leaderId: 7, createdBy: 7, orgUnitId: null }
          : where.id === ORG_PROJECT
            ? { id: ORG_PROJECT, leaderId: 7, createdBy: 7, orgUnitId: ORG_UNIT }
            : null,
      ),
      // getAccessibleProjectIds: project 42 is led by 7.
      findMany: jest.fn(async ({ where }: any) =>
        where?.OR?.some((c: any) => c.leaderId?.in?.includes(7)) ? [{ id: 42 }] : [],
      ),
    },
    projectMember: {
      findFirst: jest.fn(async ({ where }: any) => (where.userId?.in?.includes(3) ? { id: 1 } : null)),
      findMany: jest.fn(async ({ where }: any) => (where.userId?.in?.includes(3) ? [{ projectId: 42 }] : [])),
    },
    projectPartnerRole: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    taskAssignee: { findFirst: jest.fn(async () => null) },
    task: {
      findFirst: jest.fn(async () => ({ projectId: 42, createdBy: 7, assignees: [] })),
      findMany: jest.fn(async () => []),
    },
    zone: { findFirst: jest.fn(async () => ({ projectId: 42 })) },
    user: {
      findUnique: jest.fn(async ({ where }: any) => ({ orgUnitId: where?.id === ORG_VIEWER.id ? ORG_UNIT : null })),
      findMany: jest.fn(async () => []),
    },
    orgUnit: { findMany: jest.fn(async () => []) },
  };
  return new ProjectAccessService(prisma);
}

const reasonOf = (e: any) => e?.getResponse?.()?.details?.reason;

async function expectStrangerRefused(call: Promise<unknown>, untouched: jest.Mock[]) {
  const err = await call.catch((e) => e);
  expect(err).toBeInstanceOf(PermissionDeniedException);
  expect(reasonOf(err)).toBe('NOT_PROJECT_MEMBER');
  for (const fn of untouched) expect(fn).not.toHaveBeenCalled();
}

// ─── Project files ────────────────────────────────────────────────

describe('ProjectFilesController (round 4)', () => {
  const make = () => {
    const service: any = {
      list: jest.fn(async () => []),
      addUpload: jest.fn(),
      addLink: jest.fn(),
      remove: jest.fn(),
      resolveUploadPath: jest.fn(),
    };
    return { ctrl: new ProjectFilesController(service, realAccess()), service };
  };

  it('a stranger can neither list, upload, link, delete nor download', async () => {
    const { ctrl, service } = make();
    const res: any = { set: jest.fn() };
    await expectStrangerRefused(ctrl.list(STRANGER, 42), [service.list]);
    await expectStrangerRefused(ctrl.upload(42, STRANGER, {} as any), [service.addUpload]);
    await expectStrangerRefused(ctrl.addLink(42, STRANGER, { name: 'n', url: 'u' }), [service.addLink]);
    await expectStrangerRefused(ctrl.remove(STRANGER, 42, 'p-5'), [service.remove]);
    await expectStrangerRefused(ctrl.download(STRANGER, 42, '5', res), [service.resolveUploadPath]);
  });

  it('a member lists the files', async () => {
    const { ctrl, service } = make();
    await ctrl.list(MEMBER, 42);
    expect(service.list).toHaveBeenCalledWith(42);
  });
});

// ─── Project partner roles ────────────────────────────────────────

describe('ProjectPartnerRolesController (round 4)', () => {
  const make = () => {
    const service: any = {
      list: jest.fn(async () => []),
      getEligibleRoles: jest.fn(async () => ({ eligible: [], ineligible: [] })),
      getProjectId: jest.fn(async () => 42),
      findOne: jest.fn(async () => ({ id: 8 })),
      create: jest.fn(async () => ({ id: 8 })),
      update: jest.fn(async () => ({ id: 8 })),
      remove: jest.fn(async () => ({ message: 'ended' })),
    };
    return { ctrl: new ProjectPartnerRolesController(service, realAccess()), service };
  };

  it('a stranger cannot read a project’s roles', async () => {
    const { ctrl, service } = make();
    await expectStrangerRefused(ctrl.list(STRANGER, '42'), [service.list]);
    await expectStrangerRefused(ctrl.eligibleRoles(STRANGER, 42, 5), [service.getEligibleRoles]);
    await expectStrangerRefused(ctrl.findOne(STRANGER, 8), [service.findOne]);
  });

  it('a list without projectId is limited to the caller’s projects', async () => {
    const { ctrl, service } = make();
    await ctrl.list(MEMBER, undefined, '12');
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ projectIds: [42], partyId: 12 }));
  });

  it('a list without projectId is empty for a caller with no projects', async () => {
    const { ctrl, service } = make();
    await expect(ctrl.list(STRANGER)).resolves.toEqual([]);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('an Admin list without projectId is not limited', async () => {
    const { ctrl, service } = make();
    await ctrl.list(ADMIN);
    expect(service.list.mock.calls[0][0].projectIds).toBeUndefined();
  });

  it('partners:write alone adds nobody: a member and a stranger are refused (NOT_PROJECT_LEADER)', async () => {
    const { ctrl, service } = make();
    for (const who of [MEMBER, STRANGER]) {
      const err = await ctrl.create(who, { projectId: 42, partyId: 9, roleId: 2 }).catch((e) => e);
      expect(reasonOf(err)).toBe('NOT_PROJECT_LEADER');
    }
    await expect(ctrl.update(MEMBER, 8, { notes: 'x' })).rejects.toBeInstanceOf(PermissionDeniedException);
    await expect(ctrl.remove(MEMBER, 8)).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(service.create).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  it('the leader and an Admin change the team', async () => {
    const { ctrl, service } = make();
    await ctrl.create(LEADER, { projectId: '42', partyId: 9, roleId: 2 });
    expect(service.create).toHaveBeenCalledWith({ projectId: 42, partyId: 9, roleId: 2 }, 7);
    await ctrl.remove(ADMIN, 8);
    expect(service.remove).toHaveBeenCalledWith(8, 1);
  });

  it('create without a projectId is a 400', async () => {
    const { ctrl } = make();
    await expect(ctrl.create(LEADER, { partyId: 9 })).rejects.toBeInstanceOf(BadRequestException);
  });

  // QA6 round 3 (26.11) · the Team tab is read-only on the web for a user
  // who opens the project through its org unit (project 43, unit 9) but
  // is not its leader. Customer (edit page), Team Leader and BIM Leader
  // are partner roles; every write is refused here too.
  it('QA6 round 3 · an org-unit viewer reads the roles but cannot add, change or end one (customer, leader, BIM Leader)', async () => {
    const { ctrl, service } = make();
    service.getProjectId.mockResolvedValue(ORG_PROJECT);
    await ctrl.list(ORG_VIEWER, String(ORG_PROJECT));
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ projectId: ORG_PROJECT }));

    for (const body of [
      { projectId: ORG_PROJECT, partyId: 9, roleId: 1, isPrimary: true }, // customer (edit page swap)
      { projectId: ORG_PROJECT, partyId: 12, roleId: 2 }, // team leader
      { projectId: String(ORG_PROJECT), partyId: 12, roleId: 3 }, // BIM Leader
    ]) {
      const err = await ctrl.create(ORG_VIEWER, body).catch((e) => e);
      expect(err).toBeInstanceOf(PermissionDeniedException);
      expect(err.getStatus()).toBe(403);
      expect(reasonOf(err)).toBe('NOT_PROJECT_LEADER');
    }
    for (const call of [() => ctrl.update(ORG_VIEWER, 8, { titleInProject: 'x' }), () => ctrl.remove(ORG_VIEWER, 8)]) {
      const err = await call().catch((e) => e);
      expect(reasonOf(err)).toBe('NOT_PROJECT_LEADER');
    }
    expect(service.create).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });
});

// ─── Status board ─────────────────────────────────────────────────

describe('ProjectStatusBoardController (round 4)', () => {
  const make = () => {
    const prisma: any = {
      projectStageMilestone: { findMany: jest.fn(async () => []) },
      project: { findMany: jest.fn(async () => []) },
      projectMilestoneStatus: { findMany: jest.fn(async () => []), findUnique: jest.fn(), upsert: jest.fn() },
    };
    return { ctrl: new ProjectStatusBoardController(prisma, realAccess()), prisma };
  };

  it('the board shows only the caller’s projects', async () => {
    const { ctrl, prisma } = make();
    await ctrl.getBoard(MEMBER);
    expect(prisma.project.findMany.mock.calls[0][0].where).toEqual({
      deletedAt: null,
      isArchived: false,
      id: { in: [42] },
    });
    expect(prisma.projectMilestoneStatus.findMany.mock.calls[0][0].where).toEqual({ projectId: { in: [42] } });
  });

  it('an Admin sees every project', async () => {
    const { ctrl, prisma } = make();
    await ctrl.getBoard(ADMIN);
    expect(prisma.project.findMany.mock.calls[0][0].where).toEqual({ deletedAt: null, isArchived: false });
  });

  it('a stranger cannot toggle a milestone', async () => {
    const { ctrl, prisma } = make();
    await expectStrangerRefused(ctrl.toggle(STRANGER, 42, 1, true), [prisma.projectMilestoneStatus.upsert]);
  });
});

// ─── Presence ─────────────────────────────────────────────────────

describe('PresenceController (round 4)', () => {
  const make = () => {
    const presence: any = { heartbeat: jest.fn(), leave: jest.fn(), listActiveUsers: jest.fn(async () => []) };
    return { ctrl: new PresenceController(presence, {} as any, realAccess()), presence };
  };

  it('a stranger cannot mark himself present or see who is online', async () => {
    const { ctrl, presence } = make();
    await expectStrangerRefused(ctrl.heartbeat({ projectId: 42 }, { user: STRANGER }), [presence.heartbeat]);
    await expectStrangerRefused(ctrl.listForProject({ user: STRANGER }, 42), [presence.listActiveUsers]);
  });

  it('a member heartbeats; leave needs no project check', async () => {
    const { ctrl, presence } = make();
    await expect(ctrl.heartbeat({ projectId: 42 }, { user: MEMBER })).resolves.toEqual({ ok: true });
    expect(presence.heartbeat).toHaveBeenCalledWith(42, 3);
    expect(ctrl.leave({ projectId: 42 }, { user: STRANGER })).toEqual({ ok: true });
  });
});

// ─── Labels ───────────────────────────────────────────────────────

describe('LabelsController (round 4)', () => {
  const make = () => {
    const labels: any = {
      getProjectId: jest.fn(async () => 42),
      create: jest.fn(),
      getTree: jest.fn(),
      findOne: jest.fn(async () => ({ id: 1, milestones: [] })),
      findByProject: jest.fn(),
      update: jest.fn(),
      reorder: jest.fn(),
      remove: jest.fn(),
    };
    return { ctrl: new LabelsController(labels, realAccess()), labels };
  };

  it('a stranger is refused on every label route', async () => {
    const { ctrl, labels } = make();
    await expectStrangerRefused(ctrl.create(STRANGER, { projectId: 42, name: 'L' } as any), [labels.create]);
    await expectStrangerRefused(ctrl.getTree(STRANGER, 42), [labels.getTree]);
    await expectStrangerRefused(ctrl.findOne(STRANGER, 1), [labels.findOne]);
    await expectStrangerRefused(ctrl.findByProject(STRANGER, 42), [labels.findByProject]);
    await expectStrangerRefused(ctrl.update(STRANGER, 1, { name: 'M' } as any), [labels.update]);
    await expectStrangerRefused(ctrl.reorder(STRANGER, 1, null, 0), [labels.reorder]);
    await expectStrangerRefused(ctrl.remove(STRANGER, 1), [labels.remove]);
  });

  it('a member reads the tree', async () => {
    const { ctrl, labels } = make();
    await ctrl.getTree(MEMBER, 42);
    expect(labels.getTree).toHaveBeenCalledWith(42);
  });
});

describe('LabelsService — no cross-project parents (round 4)', () => {
  const make = () => {
    const prisma: any = {
      label: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.id === 1
            ? { id: 1, projectId: 42, parentId: null, name: 'A', path: 'A', depth: 0 }
            : where.id === 2
              ? { id: 2, projectId: 77, parentId: null, name: 'B', path: 'B', depth: 0 }
              : null,
        ),
        findMany: jest.fn(async () => []),
        create: jest.fn(async () => ({})),
        update: jest.fn(async () => ({})),
      },
    };
    return { svc: new LabelsService(prisma), prisma };
  };

  it('create refuses a parent from another project', async () => {
    const { svc, prisma } = make();
    await expect(svc.create({ projectId: 42, parentId: 2, name: 'C' } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.label.create).not.toHaveBeenCalled();
  });

  it('reorder refuses a parent from another project', async () => {
    const { svc, prisma } = make();
    await expect(svc.reorder(1, 2, 0)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.label.update).not.toHaveBeenCalled();
  });

  it('update cannot move a label to another project', async () => {
    const { svc, prisma } = make();
    await expect(svc.update(1, { projectId: 77 } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.label.update).not.toHaveBeenCalled();
  });

  it('a rename rewrites descendant paths of the same project only', async () => {
    const { svc, prisma } = make();
    await svc.update(1, { name: 'A2' } as any);
    expect(prisma.label.findMany.mock.calls[0][0].where).toEqual({ projectId: 42, path: { startsWith: 'A / ' } });
  });
});

// ─── Scheduling ───────────────────────────────────────────────────

describe('SchedulingController (round 4)', () => {
  const make = () => {
    const scheduler: any = {
      getProjectIdForTarget: jest.fn(async () => 42),
      getProjectIdForProjectDeliverable: jest.fn(async () => 42),
      assertZoneInProject: jest.fn(async () => undefined),
      scheduleDeliverableDryRun: jest.fn(),
      scheduleProjectDeliverableDryRun: jest.fn(),
      scheduleDeliverableAndCommit: jest.fn(),
      scanProjectOverload: jest.fn(),
      scanAllActiveOverload: jest.fn(),
      saveAndUpdateDueDates: jest.fn(),
      previewReschedule: jest.fn(),
      applyReviewed: jest.fn(),
    };
    return { ctrl: new SchedulingController(scheduler, realAccess()), scheduler };
  };

  it('a stranger cannot scan, preview, save, apply, dry-run or commit', async () => {
    const { ctrl, scheduler } = make();
    await expectStrangerRefused(ctrl.dryRun(STRANGER, 5), [scheduler.scheduleDeliverableDryRun]);
    await expectStrangerRefused(ctrl.commit(5, STRANGER), [scheduler.scheduleDeliverableAndCommit]);
    await expectStrangerRefused(ctrl.scanProjectOverload(STRANGER, 42), [scheduler.scanProjectOverload]);
    await expectStrangerRefused(ctrl.saveAndUpdateDueDates(42, STRANGER), [scheduler.saveAndUpdateDueDates]);
    await expectStrangerRefused(ctrl.previewReschedule(STRANGER, 42), [scheduler.previewReschedule]);
    await expectStrangerRefused(ctrl.applyReviewed(42, STRANGER, { approvals: [] }), [scheduler.applyReviewed]);
  });

  it('the all-projects overload scan covers only the caller’s projects (Admin: all)', async () => {
    const { ctrl, scheduler } = make();
    await ctrl.scanAllOverload(MEMBER);
    expect(scheduler.scanAllActiveOverload).toHaveBeenLastCalledWith([42]);
    await ctrl.scanAllOverload(ADMIN);
    expect(scheduler.scanAllActiveOverload).toHaveBeenLastCalledWith(undefined);
  });

  it('the (deliverable × zone) dry-run checks the zone belongs to the project', async () => {
    const { ctrl, scheduler } = make();
    await ctrl.dryRunForProjectDeliverable(MEMBER, 9, { zoneId: 4 });
    expect(scheduler.assertZoneInProject).toHaveBeenCalledWith(4, 42);
  });
});

describe('SchedulerService helpers (round 4)', () => {
  const make = (zoneProjectId: number | null, target: any = { projectDeliverable: { projectId: 42, deletedAt: null } }) => {
    const prisma: any = {
      zone: { findFirst: jest.fn(async () => (zoneProjectId == null ? null : { projectId: zoneProjectId })) },
      zoneDeliverableTarget: { findUnique: jest.fn(async () => target) },
    };
    return new SchedulerService(prisma, {} as any);
  };

  it('a zone of another project is a 400', async () => {
    await expect(make(77).assertZoneInProject(4, 42)).rejects.toBeInstanceOf(BadRequestException);
    await expect(make(42).assertZoneInProject(4, 42)).resolves.toBeUndefined();
  });

  it('resolves a target to its project; a deleted deliverable reads as missing', async () => {
    await expect(make(42).getProjectIdForTarget(5)).resolves.toBe(42);
    await expect(
      make(42, { projectDeliverable: { projectId: 42, deletedAt: new Date() } }).getProjectIdForTarget(5),
    ).rejects.toThrow('Deliverable target not found');
  });
});

// ─── Project deliverables ─────────────────────────────────────────

describe('ProjectDeliverablesController (round 4)', () => {
  const make = () => {
    const service: any = {
      getProjectId: jest.fn(async () => 42),
      assertZoneInProject: jest.fn(async () => undefined),
      forceApplyTargetToTask: jest.fn(),
      setTarget: jest.fn(),
      batchSetTargets: jest.fn(),
    };
    return { ctrl: new ProjectDeliverablesController(service, realAccess()), service };
  };

  it('a stranger cannot force-apply a target to a task (was unchecked)', async () => {
    const { ctrl, service } = make();
    const err = await ctrl.forceApplyTargetToTask(STRANGER, 10).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(service.forceApplyTargetToTask).not.toHaveBeenCalled();
  });

  it('a target’s zone must be in the deliverable’s project', async () => {
    const { ctrl, service } = make();
    await ctrl.setTarget(MEMBER, 9, { months: 2, zoneId: 4 });
    expect(service.assertZoneInProject).toHaveBeenCalledWith(4, 42);
    await ctrl.batchTargets(MEMBER, { items: [{ id: 9, months: 1, zoneId: 5 }] });
    expect(service.assertZoneInProject).toHaveBeenCalledWith(5, 42);
  });
});

describe('ProjectDeliverablesService.assertZoneInProject (round 4)', () => {
  it('refuses a zone of another project', async () => {
    const prisma: any = { zone: { findFirst: jest.fn(async () => ({ projectId: 77 })) } };
    const svc = new ProjectDeliverablesService(prisma, {} as any);
    await expect(svc.assertZoneInProject(4, 42)).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── Team templates ───────────────────────────────────────────────

describe('TeamTemplatesController (round 4)', () => {
  it('only the leader or an Admin applies a template', async () => {
    const service: any = { apply: jest.fn(async () => ({ applied: [], skipped: [] })) };
    const ctrl = new TeamTemplatesController(service, realAccess());
    const err = await ctrl.apply(MEMBER, 1, { projectId: 42 }).catch((e) => e);
    expect(reasonOf(err)).toBe('NOT_PROJECT_LEADER');
    expect(service.apply).not.toHaveBeenCalled();
    await ctrl.apply(LEADER, 1, { projectId: 42 });
    expect(service.apply).toHaveBeenCalledWith(1, 42, 7);
  });
});
