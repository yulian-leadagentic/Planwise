/**
 * Permissions round 4 (2026-11-23) — project routes.
 *
 *   • Every project-scoped read checks access (GET :id, members, activity).
 *   • Team, leader, settings, close / reopen and delete are leader-or-Admin
 *     (`assertProjectManage`); projects:write alone no longer adds anyone.
 *   • Changing the org unit is Admin only (an unchanged echo passes).
 *   • Dependency routes check access to the task's project.
 *
 * The controller runs against the REAL ProjectAccessService over a fake
 * Prisma, so these prove the wiring and the rule together.
 */
import { NotFoundException } from '@nestjs/common';

import { ProjectsController } from './projects.controller';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';

const perm = (route: string, flags: Record<string, boolean>) => ({ module: { route, name: route.slice(1) }, ...flags });
const WRITE = [perm('/projects', { canRead: true, canWrite: true, canDelete: true })];

const LEADER = { id: 7, isAdmin: false, roleModules: WRITE };
const MEMBER = { id: 3, isAdmin: false, roleModules: WRITE }; // projects:write, not the leader
const STRANGER = { id: 50, isAdmin: false, roleModules: WRITE };
const ADMIN = { id: 1, isAdmin: true, roleModules: [] as any[] };
const ASSIGNEE = { id: 60, isAdmin: false, roleModules: WRITE }; // assigned to a task of project 42
const ROLE_HOLDER = { id: 61, isAdmin: false, roleModules: WRITE }; // holds a partner role on 42

/**
 * Project 42: leader 7, user 3 has a member row, user 60 is assigned to
 * one of its tasks, user 61 holds a partner role on it.
 */
function fakePrisma() {
  return {
    project: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === 42 ? { id: 42, leaderId: 7, createdBy: 7, orgUnitId: null } : null,
      ),
      findMany: jest.fn(async () => []),
    },
    projectMember: {
      findFirst: jest.fn(async ({ where }: any) => (where.userId?.in?.includes(3) ? { id: 1 } : null)),
      findMany: jest.fn(async () => []),
    },
    projectPartnerRole: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.projectId === 42 && where.party?.user?.id?.in?.includes(61) ? { id: 4 } : null,
      ),
      findMany: jest.fn(async () => []),
    },
    taskAssignee: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.task?.projectId === 42 && where.userId?.in?.includes(60) ? { id: 5 } : null,
      ),
    },
    task: {
      findFirst: jest.fn(async () => ({ projectId: 42, createdBy: 7, assignees: [] })),
      findMany: jest.fn(async () => []),
    },
    user: { findUnique: jest.fn(async () => ({ orgUnitId: null })), findMany: jest.fn(async () => []) },
    orgUnit: { findMany: jest.fn(async () => []) },
  };
}

function makeController() {
  const access = new ProjectAccessService(fakePrisma() as any);
  const projectsService: any = {
    findOne: jest.fn(async () => ({ id: 42 })),
    getMembers: jest.fn(async () => []),
    getActivityLogs: jest.fn(async () => ({ data: [] })),
    addMember: jest.fn(async () => ({ id: 9 })),
    removeMember: jest.fn(async () => ({ message: 'Member removed' })),
    setLeader: jest.fn(async () => ({ id: 42 })),
    update: jest.fn(async () => ({ id: 42 })),
    remove: jest.fn(async () => ({ message: 'Project deleted' })),
    close: jest.fn(async () => ({ message: 'Project closed' })),
    reopen: jest.fn(async () => ({ message: 'Project re-opened' })),
    getMoneySnapshot: jest.fn(async () => ({ budget: null, estimatedValue: null })),
    getOrgUnitId: jest.fn(async () => 5),
    addDependency: jest.fn(async () => ({})),
    patchDependency: jest.fn(async () => ({})),
    removeDependency: jest.fn(async () => ({})),
  };
  return { ctrl: new ProjectsController(projectsService, access), projectsService };
}

const reasonOf = (e: any) => e?.getResponse?.()?.details?.reason;

describe('Projects controller — access on project reads (round 4)', () => {
  it.each([
    ['GET /projects/:id', (c: ProjectsController) => c.findOne(STRANGER, 42), 'findOne'],
    ['GET /:id/members', (c: ProjectsController) => c.getMembers(STRANGER, 42), 'getMembers'],
    ['GET /:id/activity-logs', (c: ProjectsController) => c.getActivityLogs(STRANGER, 42), 'getActivityLogs'],
  ])('%s refuses a stranger (NOT_PROJECT_MEMBER) and reads nothing', async (_route, call, method) => {
    const { ctrl, projectsService } = makeController();
    const err = await call(ctrl).catch((e: any) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(reasonOf(err)).toBe('NOT_PROJECT_MEMBER');
    expect(projectsService[method]).not.toHaveBeenCalled();
  });

  it('a member reads the project', async () => {
    const { ctrl, projectsService } = makeController();
    await expect(ctrl.findOne(MEMBER, 42)).resolves.toEqual({ id: 42 });
    expect(projectsService.findOne).toHaveBeenCalledWith(42, MEMBER);
  });

  it('a task assignee reads the whole project (not only his task)', async () => {
    const { ctrl, projectsService } = makeController();
    await ctrl.findOne(ASSIGNEE, 42);
    await ctrl.getMembers(ASSIGNEE, 42);
    await ctrl.getActivityLogs(ASSIGNEE, 42);
    expect(projectsService.findOne).toHaveBeenCalled();
    expect(projectsService.getMembers).toHaveBeenCalled();
    expect(projectsService.getActivityLogs).toHaveBeenCalled();
  });

  it('a partner-role holder reads the project', async () => {
    const { ctrl, projectsService } = makeController();
    await ctrl.findOne(ROLE_HOLDER, 42);
    expect(projectsService.findOne).toHaveBeenCalledWith(42, ROLE_HOLDER);
  });

  it('an assignee or role holder still cannot manage the project', async () => {
    const { ctrl } = makeController();
    await expect(ctrl.addMember(ASSIGNEE, 42, 60)).rejects.toBeInstanceOf(PermissionDeniedException);
    await expect(ctrl.update(ROLE_HOLDER, 42, { name: 'X' } as any)).rejects.toBeInstanceOf(PermissionDeniedException);
  });

  it('a missing project is a 404, not a 403', async () => {
    const { ctrl } = makeController();
    await expect(ctrl.findOne(STRANGER, 404)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Projects controller — managing the project is leader-or-Admin (round 4)', () => {
  it('a member with projects:write cannot add anyone (NOT_PROJECT_LEADER)', async () => {
    const { ctrl, projectsService } = makeController();
    const err = await ctrl.addMember(MEMBER, 42, 99).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(reasonOf(err)).toBe('NOT_PROJECT_LEADER');
    expect(projectsService.addMember).not.toHaveBeenCalled();
  });

  it('a stranger with projects:write cannot add himself', async () => {
    const { ctrl, projectsService } = makeController();
    await expect(ctrl.addMember(STRANGER, 42, STRANGER.id)).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(projectsService.addMember).not.toHaveBeenCalled();
  });

  it('the leader and an Admin can add a member', async () => {
    const { ctrl, projectsService } = makeController();
    await ctrl.addMember(LEADER, 42, 99, 'Engineer');
    await ctrl.addMember(ADMIN, 42, 98);
    expect(projectsService.addMember).toHaveBeenCalledTimes(2);
    expect(projectsService.addMember).toHaveBeenCalledWith(42, 99, 'Engineer');
  });

  it.each([
    ['DELETE /:id/members/:userId', (c: ProjectsController) => c.removeMember(MEMBER, 42, 7), 'removeMember'],
    ['PATCH /:id/leader', (c: ProjectsController) => c.setLeader(MEMBER, 42, 3), 'setLeader'],
    ['PATCH /:id', (c: ProjectsController) => c.update(MEMBER, 42, { name: 'X' } as any), 'update'],
    ['POST /:id/close', (c: ProjectsController) => c.close(MEMBER, 42), 'close'],
    ['POST /:id/reopen', (c: ProjectsController) => c.reopen(MEMBER, 42), 'reopen'],
    ['DELETE /:id', (c: ProjectsController) => c.remove(MEMBER, 42), 'remove'],
  ])('%s refuses a non-leader member', async (_route, call, method) => {
    const { ctrl, projectsService } = makeController();
    const err = await call(ctrl).catch((e: any) => e);
    expect(reasonOf(err)).toBe('NOT_PROJECT_LEADER');
    expect(projectsService[method]).not.toHaveBeenCalled();
  });

  it('the leader edits, closes and deletes his project', async () => {
    const { ctrl, projectsService } = makeController();
    await ctrl.update(LEADER, 42, { name: 'Tower B' } as any);
    await ctrl.close(LEADER, 42);
    await ctrl.remove(LEADER, 42);
    expect(projectsService.update).toHaveBeenCalled();
    expect(projectsService.close).toHaveBeenCalledWith(42, 7);
    expect(projectsService.remove).toHaveBeenCalledWith(42, 7);
  });
});

describe('Projects controller — org unit change is Admin only (round 4)', () => {
  it('the leader cannot change the org unit', async () => {
    const { ctrl, projectsService } = makeController();
    const err = await ctrl.update(LEADER, 42, { orgUnitId: 6 } as any).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(err.getResponse()).toMatchObject({ details: { field: 'orgUnitId', reason: 'ADMIN_ONLY' } });
    expect(projectsService.update).not.toHaveBeenCalled();
  });

  it('the leader cannot clear the org unit either', async () => {
    const { ctrl, projectsService } = makeController();
    await expect(ctrl.update(LEADER, 42, { orgUnitId: null } as any)).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(projectsService.update).not.toHaveBeenCalled();
  });

  it('an unchanged org unit echo passes for the leader', async () => {
    const { ctrl, projectsService } = makeController();
    await ctrl.update(LEADER, 42, { name: 'Tower B', orgUnitId: 5 } as any);
    expect(projectsService.update).toHaveBeenCalled();
  });

  it('an Admin changes the org unit', async () => {
    const { ctrl, projectsService } = makeController();
    await ctrl.update(ADMIN, 42, { orgUnitId: 6 } as any);
    expect(projectsService.getOrgUnitId).not.toHaveBeenCalled();
    expect(projectsService.update).toHaveBeenCalledWith(42, { orgUnitId: 6 }, 1);
  });
});

describe('Projects controller — task dependencies check the task’s project (round 4)', () => {
  it.each([
    ['POST', (c: ProjectsController) => c.addDependency(STRANGER, 10, { dependsOnId: 11 }), 'addDependency'],
    ['PATCH', (c: ProjectsController) => c.patchDependency(STRANGER, 10, 11, { lag: 1 }), 'patchDependency'],
    ['DELETE', (c: ProjectsController) => c.removeDependency(STRANGER, 10, 11), 'removeDependency'],
  ])('%s refuses a stranger', async (_verb, call, method) => {
    const { ctrl, projectsService } = makeController();
    await expect(call(ctrl)).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(projectsService[method]).not.toHaveBeenCalled();
  });

  it('a member adds a dependency', async () => {
    const { ctrl, projectsService } = makeController();
    await ctrl.addDependency(MEMBER, 10, { dependsOnId: 11 });
    expect(projectsService.addDependency).toHaveBeenCalledWith(10, { dependsOnId: 11 });
  });
});
