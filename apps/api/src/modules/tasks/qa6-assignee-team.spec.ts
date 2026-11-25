/**
 * QA6 package 1 (2026-11-25) — assigning a task is not a way into a
 * project.
 *
 * Integration-style over the in-memory Prisma (no test-DB harness in
 * the repo): the REAL TasksController.addAssignee → ProjectAccessService
 * → TaskAssigneePolicyService → ProjectPartnerRolesService
 * .upsertProjectMemberRelationship → TasksService.addAssignee, and
 * ProjectsService.getAssigneeCandidates for "he appears in Team".
 *
 * Project 58: leader 104. Team: Professonal 101 (participant), BIM
 * leader 102 (bim_leader), external contact 107 (a `partner` login
 * holding an architect role). Not on the Team: employee 105 (whose BP
 * lacks the 'employee' partner role, as seen on staging), employee 106
 * (no BP at all), inactive employee 108.
 */
import { BadRequestException } from '@nestjs/common';

import { MemoryDb, memoryPrisma, PLANWISE_RELATIONS } from '../../testing/memory-prisma';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { ProjectPartnerRolesService } from '../project-partner-roles/project-partner-roles.service';
import { ProjectsService } from '../projects/projects.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskAssigneePolicyService } from './task-assignee-policy.service';

const grant = (route: string) => ({ module: { route: `/${route}`, name: route }, canRead: true, canWrite: true, canDelete: true });
const MODULES = ['projects', 'tasks', 'time', 'partners'].map(grant);

const PROFESSONAL = { id: 101, roleId: 6, isAdmin: false, roleModules: MODULES };
const BIM_LEADER = { id: 102, roleId: 7, isAdmin: false, roleModules: MODULES };
const LEADER = { id: 104, roleId: 7, isAdmin: false, roleModules: MODULES };
const ADMIN = { id: 1, roleId: 1, isAdmin: true, roleModules: [] as any[] };
const NOA = { id: 105, roleId: 6, isAdmin: false, roleModules: MODULES };

const ACTIVE = { status: 'active', validFrom: new Date('2026-01-01'), validTo: new Date('9999-12-31') };
const T0 = new Date('2026-11-20T08:00:00Z');

function seed() {
  const person = (id: number, extra: Record<string, any> = {}) => ({
    id, firstName: `First${id}`, lastName: `Last${id}`, email: `u${id}@amec.co.il`,
    roleId: 6, orgUnitId: 21, businessPartnerId: 1000 + id, userType: 'employee', isActive: true, deletedAt: null, ...extra,
  });
  const task = (id: number, projectId: number | null, extra: Record<string, any> = {}) => ({
    id, projectId, zoneId: null, code: `T-${id}`, name: `Task ${id}`, status: 'not_started', requiresReview: false,
    isPersonal: false, isArchived: false, createdBy: 104, deletedAt: null, createdAt: T0, ...extra,
  });
  return {
    user: [
      person(1, { roleId: 1 }),
      person(101),
      person(102, { roleId: 7 }),
      person(104, { roleId: 7, orgUnitId: 30 }),
      person(105),
      person(106, { businessPartnerId: null }),
      person(107, { userType: 'partner', email: 'arch@outside.com' }),
      person(108, { isActive: false }),
    ],
    businessPartner: [1001, 1101, 1102, 1104, 1105, 1107, 1108].map((id) => ({
      id, partnerType: 'person', displayName: `BP ${id}`, firstName: 'BP', lastName: String(id), email: null, deletedAt: null,
    })),
    partnerRoleType: [{ id: 1, code: 'employee', name: 'Employee' }],
    // 105 deliberately has NO 'employee' partner role (staging finding).
    businessPartnerRole: [1101, 1102, 1104].map((bp, i) => ({ id: i + 1, businessPartnerId: bp, roleTypeId: 1 })),
    projectRoleType: [
      { id: 1, code: 'participant', name: 'Participant' },
      { id: 2, code: 'bim_leader', name: 'BIM Leader' },
      { id: 3, code: 'architect', name: 'Architect' },
    ],
    orgUnit: [{ id: 21, name: 'BIM team', path: '/1/20/21/' }, { id: 30, name: 'Infra', path: '/1/30/' }],
    project: [{ id: 58, name: 'ניסוי 8', leaderId: 104, createdBy: 104, orgUnitId: 30, deletedAt: null }],
    projectMember: [] as any[],
    projectPartnerRole: [
      { id: 1, projectId: 58, partyId: 1101, roleId: 1, ...ACTIVE },
      { id: 2, projectId: 58, partyId: 1102, roleId: 2, ...ACTIVE },
      { id: 3, projectId: 58, partyId: 1107, roleId: 3, ...ACTIVE },
    ],
    task: [task(4021, 58), task(4022, 58), task(4023, 58), task(4030, null, { isPersonal: true, createdBy: 101 })],
    taskAssignee: [{ id: 1, taskId: 4021, userId: 101, deletedAt: null }],
    timeEntry: [] as any[],
    taskComment: [] as any[],
  };
}

function world() {
  const db = new MemoryDb(PLANWISE_RELATIONS, seed());
  const prisma = memoryPrisma(db);
  const access = new ProjectAccessService(prisma);
  const activityLog: any = {
    logAssigneeAdded: jest.fn(),
    logProjectMemberAdded: jest.fn(),
    logTaskCreated: jest.fn(),
  };
  const partnerRoles = new ProjectPartnerRolesService(prisma, activityLog);
  const tasksService = new TasksService(prisma, { emit: jest.fn() } as any, activityLog, {} as any, {} as any);
  const policy = new TaskAssigneePolicyService(prisma, access, partnerRoles, activityLog);
  const ctrl = new TasksController(tasksService, access, {} as any, {} as any, policy);
  const projects = new ProjectsService(prisma, access, partnerRoles, {} as any, activityLog);
  const assignees = (taskId: number) =>
    db.table('taskAssignee').filter((a) => a.taskId === taskId && a.deletedAt == null).map((a) => a.userId);
  const participantRolesOf = (partyId: number | null | undefined) =>
    db.table('projectPartnerRole').filter((r) => r.projectId === 58 && r.roleId === 1 && r.partyId === partyId);
  return { db, access, ctrl, projects, activityLog, assignees, participantRolesOf };
}

const reasonOf = (e: any) => e?.getResponse?.()?.details?.reason;
const codeOf = (e: any) => e?.getResponse?.()?.code;

describe('QA6 P1 — POST /tasks/:id/assignees', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
  });

  it('a Professonal cannot assign an employee who is not on the Team (403 ASSIGNEE_NOT_ON_TEAM); nothing is written', async () => {
    const err = await w.ctrl.addAssignee(4021, { userId: 105 }, PROFESSONAL).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(reasonOf(err)).toBe('ASSIGNEE_NOT_ON_TEAM');
    expect(err.message).toBe(
      "First105 Last105 is not on this project's team. Only the project leader or an administrator can add someone new to the project.",
    );
    expect(w.assignees(4021)).toEqual([101]);
    expect(w.participantRolesOf(1105)).toHaveLength(0);
    await expect(w.access.isOnProjectTeam(105, 58)).resolves.toBe(false);
  });

  it('a Professonal assigns a Team member as before', async () => {
    const out: any = await w.ctrl.addAssignee(4021, { userId: 102 }, PROFESSONAL);
    expect(out.addedToTeam).toBe(false);
    expect(w.assignees(4021)).toEqual([101, 102]);
    expect(w.activityLog.logProjectMemberAdded).not.toHaveBeenCalled();
  });

  it('the leader assigns him: a participant role first, then the assignment; he is on the Team and opens the project', async () => {
    // Before: rule 5 is gone, so an old assignment alone would not open it either.
    await expect(w.access.assertProjectAccess(105, 58, false)).rejects.toBeInstanceOf(PermissionDeniedException);

    const out: any = await w.ctrl.addAssignee(4021, { userId: 105 }, LEADER);
    expect(out.addedToTeam).toBe(true);
    expect(w.assignees(4021)).toEqual([101, 105]);

    const roles = w.participantRolesOf(1105);
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ status: 'active' });
    await expect(w.access.isOnProjectTeam(105, 58)).resolves.toBe(true);
    await expect(w.access.assertTaskAccess(105, 4022, false)).resolves.toBe(58);

    // The Team / picker source lists him, assignable.
    const team = await w.projects.getAssigneeCandidates(58);
    expect(team.find((c) => c.userId === 105)).toMatchObject({ role: 'Participant', canAssign: true, isEmployee: true });

    expect(w.activityLog.logProjectMemberAdded).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 104, projectId: 58, entityId: 105, metadata: expect.objectContaining({ via: 'task-assign', taskId: 4021 }) }),
    );
  });

  it('a second assignment of the same person does not add a second role', async () => {
    await w.ctrl.addAssignee(4021, { userId: 105 }, LEADER);
    const out: any = await w.ctrl.addAssignee(4022, { userId: 105 }, LEADER);
    expect(out.addedToTeam).toBe(false);
    expect(w.participantRolesOf(1105)).toHaveLength(1);
  });

  it('an Admin adds an employee with no BP yet: a BP is created and linked, then the role', async () => {
    const out: any = await w.ctrl.addAssignee(4021, { userId: 106 }, ADMIN);
    expect(out.addedToTeam).toBe(true);
    const bpId = w.db.table('user').find((u) => u.id === 106)!.businessPartnerId;
    expect(bpId).toEqual(expect.any(Number));
    expect(w.participantRolesOf(bpId)).toHaveLength(1);
    expect(w.assignees(4021)).toContain(106);
  });

  it('an external contact is never assignable (400 ASSIGNEE_EXTERNAL_CONTACT), even on the Team, even by the leader', async () => {
    const err = await w.ctrl.addAssignee(4021, { userId: 107 }, LEADER).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(codeOf(err)).toBe('ASSIGNEE_EXTERNAL_CONTACT');
    expect(w.assignees(4021)).toEqual([101]);
    const candidate = (await w.projects.getAssigneeCandidates(58)).find((c) => c.userId === 107);
    expect(candidate).toMatchObject({ canAssign: false, isEmployee: false });
  });

  it('an inactive employee: 400, and no Team role is created for him', async () => {
    const err = await w.ctrl.addAssignee(4021, { userId: 108 }, LEADER).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(w.participantRolesOf(1108)).toHaveLength(0);
  });

  it('a personal task (no project) has no Team: any employee, never an external', async () => {
    const out: any = await w.ctrl.addAssignee(4030, { userId: 105 }, PROFESSONAL);
    expect(out.addedToTeam).toBe(false);
    expect(w.assignees(4030)).toEqual([105]);
    const err = await w.ctrl.addAssignee(4030, { userId: 107 }, PROFESSONAL).catch((e) => e);
    expect(codeOf(err)).toBe('ASSIGNEE_EXTERNAL_CONTACT');
  });

  it('a missing userId is a 400', async () => {
    await expect(w.ctrl.addAssignee(4021, {} as any, LEADER)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an assignee from before QA6 who is not on the Team no longer opens the project', async () => {
    w.db.table('taskAssignee').push({ id: 9, taskId: 4022, userId: 105, deletedAt: null });
    const err = await w.access.assertTaskAccess(NOA.id, 4022, false).catch((e) => e);
    expect(reasonOf(err)).toBe('NOT_PROJECT_MEMBER');
  });
});
