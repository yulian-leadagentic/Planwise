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
import { SystemMessagesListener } from '../messages/system-messages.listener';
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
    // QA6 security review — a zone of project 58, for "a task joins a project".
    zone: [{ id: 580, projectId: 58, name: 'Zone A', path: '580', deletedAt: null }],
    notification: [] as any[],
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
    logTaskUpdated: jest.fn(),
  };
  const notifications = { create: jest.fn(async () => ({})) };
  const partnerRoles = new ProjectPartnerRolesService(prisma, activityLog);
  const policy = new TaskAssigneePolicyService(prisma, access, partnerRoles, activityLog);
  const tasksService = new TasksService(
    prisma,
    { emit: jest.fn() } as any,
    activityLog,
    notifications as any,
    { materializeFromTasks: jest.fn() } as any,
    policy,
    access,
  );
  const ctrl = new TasksController(tasksService, access, {} as any, {} as any, policy);
  const projects = new ProjectsService(prisma, access, partnerRoles, {} as any, activityLog);
  const assignees = (taskId: number) =>
    db.table('taskAssignee').filter((a) => a.taskId === taskId && a.deletedAt == null).map((a) => a.userId);
  const participantRolesOf = (partyId: number | null | undefined) =>
    db.table('projectPartnerRole').filter((r) => r.projectId === 58 && r.roleId === 1 && r.partyId === partyId);
  return { db, prisma, access, ctrl, tasksService, projects, activityLog, notifications, assignees, participantRolesOf };
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

/**
 * QA6 security review (2026-11-25), finding 2 — a personal task takes
 * any employee as assignee, and a PATCH with a zoneId / projectId moved
 * it into a project. That carried the assignee into the project past
 * "only the leader or an Admin adds an outsider". Now every live
 * assignee (but the creator himself) goes through the assignee policy
 * before the move is written.
 */
describe('QA6 security review — a task that joins a project takes its assignees through the policy', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
  });

  const personalTaskBy = async (who: any) => {
    const t: any = await w.ctrl.create(who, { isPersonal: true, name: 'Mine', serviceTypeId: 1 } as any);
    return t.id as number;
  };
  const row = (id: number) => w.db.table('task').find((t) => t.id === id)!;

  it('personal task → assign B → PATCH zoneId into project 58 by a non-leader: 403 ASSIGNEE_NOT_ON_TEAM, nothing written', async () => {
    const id = await personalTaskBy(PROFESSONAL);
    const assigned: any = await w.ctrl.addAssignee(id, { userId: 105 }, PROFESSONAL);
    expect(assigned.addedToTeam).toBe(false); // a personal task: any employee
    expect(w.assignees(id)).toEqual([101, 105]);

    const err = await w.ctrl.update(id, { zoneId: 580 } as any, PROFESSONAL).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(reasonOf(err)).toBe('ASSIGNEE_NOT_ON_TEAM');
    expect(row(id)).toMatchObject({ projectId: null, zoneId: null });
    expect(w.participantRolesOf(1105)).toHaveLength(0);
    await expect(w.access.isOnProjectTeam(105, 58)).resolves.toBe(false);
    expect(w.activityLog.logProjectMemberAdded).not.toHaveBeenCalled();
  });

  it('the same move through projectId is refused the same way', async () => {
    const id = await personalTaskBy(PROFESSONAL);
    await w.ctrl.addAssignee(id, { userId: 105 }, PROFESSONAL);
    const err = await w.ctrl.update(id, { projectId: 58 } as any, PROFESSONAL).catch((e) => e);
    expect(reasonOf(err)).toBe('ASSIGNEE_NOT_ON_TEAM');
    expect(row(id).projectId).toBeNull();
  });

  it('the leader doing it adds B to the Team as participant, in the same write as the move', async () => {
    const id = await personalTaskBy(LEADER);
    await w.ctrl.addAssignee(id, { userId: 105 }, LEADER);

    await w.ctrl.update(id, { zoneId: 580 } as any, LEADER);
    expect(row(id)).toMatchObject({ projectId: 58, zoneId: 580 });
    expect(w.participantRolesOf(1105)).toHaveLength(1);
    await expect(w.access.isOnProjectTeam(105, 58)).resolves.toBe(true);
    expect(w.activityLog.logProjectMemberAdded).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 104, projectId: 58, entityId: 105, metadata: expect.objectContaining({ via: 'task-assign', taskId: id }) }),
    );
  });

  it('an assignee already on the Team moves with the task; nothing is added', async () => {
    const id = await personalTaskBy(PROFESSONAL);
    await w.ctrl.addAssignee(id, { userId: 102 }, PROFESSONAL); // BIM leader of 58
    await w.ctrl.update(id, { zoneId: 580 } as any, PROFESSONAL);
    expect(row(id).projectId).toBe(58);
    expect(w.activityLog.logProjectMemberAdded).not.toHaveBeenCalled();
  });

  it('the creator assigned to his own task is not planned: moving it into a project he can open is allowed', async () => {
    // 120 is in the project's org unit (rule 6: access) but not on its Team.
    w.db.table('user').push({
      id: 120, firstName: 'Unit', lastName: 'Mate', email: 'u120@amec.co.il', roleId: 6, orgUnitId: 30,
      businessPartnerId: null, userType: 'employee', isActive: true, deletedAt: null,
    });
    const UNIT_MATE = { ...PROFESSONAL, id: 120 };
    const id = await personalTaskBy(UNIT_MATE);
    expect(w.assignees(id)).toEqual([120]);

    await w.ctrl.update(id, { zoneId: 580 } as any, UNIT_MATE);
    expect(row(id).projectId).toBe(58);
    expect(w.db.table('projectPartnerRole').filter((r) => r.projectId === 58)).toHaveLength(3);
  });

  it('a task that already has its project is not re-planned (a plain edit)', async () => {
    w.db.table('taskAssignee').push({ id: 50, taskId: 4022, userId: 105, deletedAt: null }); // legacy, not on Team
    const out: any = await w.tasksService.update(4022, { name: 'renamed' } as any, 104, LEADER);
    expect(out.name).toBe('renamed');
    expect(w.participantRolesOf(1105)).toHaveLength(0);
  });

  it('a failed move leaves no Team role behind', async () => {
    const id = await personalTaskBy(LEADER);
    await w.ctrl.addAssignee(id, { userId: 105 }, LEADER);
    const update = w.prisma.task.update;
    w.prisma.task.update = async () => {
      throw new Error('write failed');
    };
    await expect(w.ctrl.update(id, { zoneId: 580 } as any, LEADER)).rejects.toThrow('write failed');
    w.prisma.task.update = update;
    expect(w.participantRolesOf(1105)).toHaveLength(0);
    expect(row(id).projectId).toBeNull();
    expect(w.activityLog.logProjectMemberAdded).not.toHaveBeenCalled();
  });
});

describe('QA6 security review — the Team role and the assignment are one transaction', () => {
  it('a failed assignment leaves no participant role (and no audit line)', async () => {
    const w = world();
    const upsert = w.prisma.taskAssignee.upsert;
    w.prisma.taskAssignee.upsert = async () => {
      throw new Error('assignment write failed');
    };
    await expect(w.ctrl.addAssignee(4021, { userId: 105 }, LEADER)).rejects.toThrow('assignment write failed');
    w.prisma.taskAssignee.upsert = upsert;

    expect(w.participantRolesOf(1105)).toHaveLength(0);
    expect(w.assignees(4021)).toEqual([101]);
    expect(w.activityLog.logProjectMemberAdded).not.toHaveBeenCalled();

    // The same call succeeds once the write works: role + assignment.
    const out: any = await w.ctrl.addAssignee(4021, { userId: 105 }, LEADER);
    expect(out.addedToTeam).toBe(true);
    expect(w.participantRolesOf(1105)).toHaveLength(1);
    expect(w.assignees(4021)).toEqual([101, 105]);
  });

  it('a conflict (already assigned) writes no role either', async () => {
    const w = world();
    w.db.table('taskAssignee').push({ id: 60, taskId: 4021, userId: 105, deletedAt: null }); // legacy, not on Team
    const err = await w.ctrl.addAssignee(4021, { userId: 105 }, LEADER).catch((e) => e);
    expect(err?.getStatus?.()).toBe(409);
    expect(w.participantRolesOf(1105)).toHaveLength(0);
  });
});

/**
 * Finding 3 — an assignment no longer grants the project, so it must not
 * show the project's tasks or send their news either.
 */
describe('QA6 security review — an assignment alone shows nothing of the project', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
    // 105 kept an assignment on 4022 from before QA6; he is not on the Team.
    w.db.table('taskAssignee').push({ id: 70, taskId: 4022, userId: 105, deletedAt: null });
    w.db.table('taskAssignee').push({ id: 71, taskId: 4022, userId: 102, deletedAt: null });
    // ... and has a personal task of his own.
    w.db.table('task').push({
      id: 4031, projectId: null, zoneId: null, code: 'T-4031', name: 'Own', status: 'not_started', requiresReview: false,
      isPersonal: true, isArchived: false, createdBy: 105, deletedAt: null, createdAt: T0,
    });
    w.db.table('taskAssignee').push({ id: 72, taskId: 4031, userId: 105, deletedAt: null });
  });

  it('GET /tasks/mine leaves out tasks of projects he cannot open; his personal task stays', async () => {
    const mine: any[] = await w.ctrl.findMine(NOA);
    expect(mine.map((t) => t.id)).toEqual([4031]);
    // On the Team: his project task is there.
    const bim: any[] = await w.ctrl.findMine(BIM_LEADER);
    expect(bim.map((t) => t.id)).toEqual([4022]);
    // Admin: every assignment.
    w.db.table('taskAssignee').push({ id: 73, taskId: 4023, userId: 1, deletedAt: null });
    expect((await w.ctrl.findMine(ADMIN)).map((t: any) => t.id)).toEqual([4023]);
  });

  it('an attachment notifies only the assignees who can open the project', async () => {
    await w.tasksService.addAttachment(4022, 101, { fileName: 'plan.pdf', fileUrl: '/files/plan.pdf' });
    const told = w.notifications.create.mock.calls.map((c: any[]) => c[0].userId);
    expect(told).toEqual([102]);
  });

  it('a status change notifies only the assignees who can open the project', async () => {
    const listener = new SystemMessagesListener(w.prisma, { createSystemMessage: jest.fn() } as any, w.access);
    await listener.handleTaskStatusChanged({
      taskId: 4022, projectId: 58, userId: 101, oldStatus: 'not_started', newStatus: 'in_progress', userName: 'QA',
    });
    expect(w.db.table('notification').map((n) => n.userId)).toEqual([102]);
  });

  it('userHasProjectAccess: an Admin (by his roles) yes; an outsider and a missing project no', async () => {
    w.db.table('role').push({ id: 1, name: 'Admin' });
    w.db.table('taskAssignee').push({ id: 74, taskId: 4022, userId: 1, deletedAt: null });
    await expect(w.access.userHasProjectAccess(1, 58)).resolves.toBe(true);
    await expect(w.access.userHasProjectAccess(105, 58)).resolves.toBe(false);
    await expect(w.access.userHasProjectAccess(105, 999)).resolves.toBe(false);
  });
});

/**
 * QA6 decision 2 (26.11) — no self-assign for a viewer who is not on the
 * Team. 109 sees project 58 only through his org unit (rule 6: home unit
 * 30 = the project's unit); 110 only through his manager chain (rule 7:
 * he manages unit 21, home of Team member 101). Neither is on the Team,
 * neither passes assertProjectManage, so assigning HIMSELF is the same
 * 403 ASSIGNEE_NOT_ON_TEAM as assigning any outsider. Every self-assign
 * surface of the web (task drawer, planning picker and its multi-row
 * assign, the timesheet quick task) posts POST /tasks/:id/assignees, so
 * this is the one gate.
 */
describe('QA6 decision 2 — a viewer who is not on the Team cannot assign himself', () => {
  const ORG_VIEWER = { id: 109, roleId: 6, isAdmin: false, roleModules: MODULES };
  const CHAIN_MANAGER = { id: 110, roleId: 7, isAdmin: false, roleModules: MODULES };
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
    const person = (id: number, orgUnitId: number) => ({
      id, firstName: `First${id}`, lastName: `Last${id}`, email: `u${id}@amec.co.il`, roleId: 6, orgUnitId,
      businessPartnerId: 1000 + id, userType: 'employee', isActive: true, deletedAt: null,
    });
    w.db.table('user').push(person(109, 30), person(110, 20));
    w.db.table('businessPartner').push(
      { id: 1109, partnerType: 'person', displayName: 'BP 1109', deletedAt: null },
      { id: 1110, partnerType: 'person', displayName: 'BP 1110', deletedAt: null },
    );
    w.db.table('orgUnit').find((u) => u.id === 21)!.managerUserId = 110;
  });

  it('both see the project, neither is on the Team', async () => {
    for (const u of [109, 110]) {
      await expect(w.access.assertProjectAccess(u, 58, false)).resolves.toBeUndefined();
      await expect(w.access.isOnProjectTeam(u, 58)).resolves.toBe(false);
    }
  });

  it.each([
    ['rule 6 (org unit)', ORG_VIEWER],
    ['rule 7 (manager chain)', CHAIN_MANAGER],
  ])('%s: self-assign is 403 ASSIGNEE_NOT_ON_TEAM; no assignment, no Team role', async (_rule, me) => {
    const err = await w.ctrl.addAssignee(4021, { userId: me.id }, me).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(reasonOf(err)).toBe('ASSIGNEE_NOT_ON_TEAM');
    expect(w.assignees(4021)).toEqual([101]);
    expect(w.participantRolesOf(1000 + me.id)).toHaveLength(0);
    await expect(w.access.isOnProjectTeam(me.id, 58)).resolves.toBe(false);
    expect(w.activityLog.logProjectMemberAdded).not.toHaveBeenCalled();
  });

  it('the timesheet quick task: he may create the task, but assigning himself to it is refused the same way', async () => {
    const created: any = await w.ctrl.create(ORG_VIEWER, { zoneId: 580, code: 'QT-1', name: 'Quick' } as any);
    const err = await w.ctrl.addAssignee(created.id, { userId: 109 }, ORG_VIEWER).catch((e) => e);
    expect(reasonOf(err)).toBe('ASSIGNEE_NOT_ON_TEAM');
    expect(w.assignees(created.id)).toEqual([]);
  });

  it('assigning someone who IS on the Team stays allowed (package 1 unchanged)', async () => {
    const out: any = await w.ctrl.addAssignee(4021, { userId: 102 }, ORG_VIEWER);
    expect(out.addedToTeam).toBe(false);
    expect(w.assignees(4021)).toEqual([101, 102]);
  });

  it('once the leader adds him (assigning him), he can assign himself to another task', async () => {
    await w.ctrl.addAssignee(4021, { userId: 109 }, LEADER);
    await expect(w.access.isOnProjectTeam(109, 58)).resolves.toBe(true);
    const out: any = await w.ctrl.addAssignee(4022, { userId: 109 }, ORG_VIEWER);
    expect(out.addedToTeam).toBe(false);
    expect(w.assignees(4022)).toEqual([109]);
  });
});
