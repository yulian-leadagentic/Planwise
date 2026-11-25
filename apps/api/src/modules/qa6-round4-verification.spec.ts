/**
 * QA6 package 0 (2026-11-25) — round-4 verification for the three live
 * staging access roles: Professonal, BIM leader and Depatment lead
 * (spelled as in the staging DB; they are not in the seeds).
 *
 * The repo has no test-DB harness, so this is integration-style over
 * the in-memory Prisma (src/testing/memory-prisma.ts): the REAL
 * RolesGuard, ProjectAccessService, StageTransitionService,
 * TasksController + TasksService (findOne / findAll / findMine /
 * getReviewContext), MessageAccessService and MessagesService run
 * against one seeded "staging-like" database. Only TasksService.update
 * is replaced (it applies the patch to the row): the gates under test
 * all run before it.
 *
 * Module grants per role are the staging ones (permissions audit
 * 00-SUMMARY.md). Professonal's stage-transition table is not in the
 * repo; the fixture uses a table with no move into Done, which is what
 * QA reported on 23.11.
 *
 * Cases (qa6-fix-instructions.md › חבילה 0), for each role:
 *   1. GET / PATCH a task of a project where he is on the Team → 200.
 *   2. A task of an unrelated project → 403 NOT_PROJECT_MEMBER.
 *   3. Move to Done: blocked by Professonal's transition table, and by
 *      the review rule for all three (none holds tasks:approve).
 *   4. A thread he is mentioned in (on an unrelated project) is
 *      readable and listed in his Inbox; a sibling thread is not.
 *   5. GET /tasks/mine returns his live assignments.
 */
import { Reflector } from '@nestjs/core';
import { BadRequestException, ExecutionContext } from '@nestjs/common';

import { MemoryDb, memoryPrisma, PLANWISE_RELATIONS } from '../testing/memory-prisma';
import { ProjectAccessService } from '../common/services/project-access.service';
import { StageTransitionService } from '../common/services/stage-transition.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { PermissionDeniedException } from '../common/errors/permission-denied';
import { TasksController } from './tasks/tasks.controller';
import { TasksService } from './tasks/tasks.service';
import { TaskAssigneePolicyService } from './tasks/task-assignee-policy.service';
import { ProjectPartnerRolesService } from './project-partner-roles/project-partner-roles.service';
import { MessagesController } from './messages/messages.controller';
import { MessagesService } from './messages/messages.service';
import { MessageAccessService } from './messages/message-access.service';

// ─── Roles (staging grants) ──────────────────────────────────────────

type Flags = Partial<Record<'canRead' | 'canWrite' | 'canDelete' | 'canApprove' | 'canExport', boolean>>;
const grant = (route: string, flags: Flags) => ({ module: { route: `/${route}`, name: route }, ...flags });
const RW: Flags = { canRead: true, canWrite: true };
const RWD: Flags = { canRead: true, canWrite: true, canDelete: true };

const ROLE = { PROFESSONAL: 6, BIM_LEADER: 7, DEPATMENT_LEAD: 3 } as const;

const MODULES: Record<number, any[]> = {
  // Professonal: projects RW, tasks RWD, time RWD, partners RWD.
  [ROLE.PROFESSONAL]: [grant('projects', RW), grant('tasks', RWD), grant('time', RWD), grant('partners', RWD)],
  // BIM leader: projects RWDAE, tasks RW, partners RW, finance R, time R, reports R.
  [ROLE.BIM_LEADER]: [
    grant('projects', { ...RWD, canApprove: true, canExport: true }),
    grant('tasks', RW),
    grant('partners', RW),
    grant('finance', { canRead: true }),
    grant('time', { canRead: true }),
    grant('reports', { canRead: true }),
  ],
  // Depatment lead: projects / tasks / time / reports / templates RW, partners RW.
  [ROLE.DEPATMENT_LEAD]: ['projects', 'tasks', 'time', 'reports', 'templates', 'partners'].map((m) => grant(m, RW)),
};

const user = (id: number, roleId: number, roleName: string) => ({
  id,
  roleId,
  role: { id: roleId, name: roleName },
  roleName,
  isAdmin: false,
  roleModules: MODULES[roleId],
});

const PROFESSONAL = user(101, ROLE.PROFESSONAL, 'Professonal');
const BIM_LEADER = user(102, ROLE.BIM_LEADER, 'BIM leader');
const DEPATMENT_LEAD = user(103, ROLE.DEPATMENT_LEAD, 'Depatment lead');
const PROJECT_LEADER = user(104, ROLE.BIM_LEADER, 'BIM leader');

const ROLES = [
  { label: 'Professonal', who: PROFESSONAL, ownTask: 4021 },
  { label: 'BIM leader', who: BIM_LEADER, ownTask: 4025 },
  { label: 'Depatment lead', who: DEPATMENT_LEAD, ownTask: 4026 },
];

// ─── Seed ────────────────────────────────────────────────────────────
//
// Project 58 ("ניסוי 8") — leader 104, org unit 30 (none of the three
// is in unit 30, so rule 6 does not admit them). Its Team tab:
// Professonal and Depatment lead as `participant`, BIM leader as
// `bim_leader`. Project 99 — unrelated: leader 200, unit 40, no role.

const ACTIVE = { status: 'active', validFrom: new Date('2026-01-01'), validTo: new Date('9999-12-31') };
const T0 = new Date('2026-11-20T08:00:00Z');

function seed() {
  const task = (id: number, projectId: number | null, extra: Record<string, any> = {}) => ({
    id,
    projectId,
    zoneId: null,
    code: `T-${id}`,
    name: `Task ${id}`,
    status: 'in_progress',
    requiresReview: false,
    isPersonal: false,
    isArchived: false,
    createdBy: 104,
    deletedAt: null,
    estimatedStartDate: null,
    endDate: null,
    createdAt: T0,
    ...extra,
  });
  const assign = (id: number, taskId: number, userId: number, deletedAt: Date | null = null) => ({
    id, taskId, userId, deletedAt, createdAt: T0,
  });
  return {
    role: [
      { id: ROLE.PROFESSONAL, name: 'Professonal' },
      { id: ROLE.BIM_LEADER, name: 'BIM leader' },
      { id: ROLE.DEPATMENT_LEAD, name: 'Depatment lead' },
    ],
    orgUnit: [
      { id: 1, name: 'AMEC', path: '/1/', managerUserId: null, deletedAt: null },
      { id: 20, name: 'Building', path: '/1/20/', managerUserId: 103, deletedAt: null },
      { id: 21, name: 'BIM team', path: '/1/20/21/', managerUserId: null, deletedAt: null },
      { id: 30, name: 'Infra', path: '/1/30/', managerUserId: null, deletedAt: null },
      { id: 40, name: 'Other', path: '/1/40/', managerUserId: null, deletedAt: null },
    ],
    user: [
      { id: 101, firstName: 'QA', lastName: 'Professional', email: 'qa.professional@amec.co.il', roleId: 6, orgUnitId: 21, businessPartnerId: 1101, userType: 'employee', isActive: true, deletedAt: null },
      { id: 102, firstName: 'QA', lastName: 'BIM', email: 'qa.bimleader@amec.co.il', roleId: 7, orgUnitId: 21, businessPartnerId: 1102, userType: 'employee', isActive: true, deletedAt: null },
      { id: 103, firstName: 'QA', lastName: 'Dept', email: 'qa.deptlead@amec.co.il', roleId: 3, orgUnitId: 20, businessPartnerId: 1103, userType: 'employee', isActive: true, deletedAt: null },
      { id: 104, firstName: 'Project', lastName: 'Leader', email: 'leader@amec.co.il', roleId: 7, orgUnitId: 30, businessPartnerId: 1104, userType: 'employee', isActive: true, deletedAt: null },
      { id: 200, firstName: 'Other', lastName: 'Leader', email: 'other@amec.co.il', roleId: 7, orgUnitId: 40, businessPartnerId: 1200, userType: 'employee', isActive: true, deletedAt: null },
    ],
    businessPartner: [1101, 1102, 1103, 1104, 1200].map((id) => ({
      id, partnerType: 'person', displayName: `BP ${id}`, firstName: 'BP', lastName: String(id), deletedAt: null,
    })),
    projectRoleType: [
      { id: 1, code: 'participant', name: 'Participant' },
      { id: 2, code: 'bim_leader', name: 'BIM Leader' },
    ],
    project: [
      { id: 58, name: 'ניסוי 8', number: 'P-58', leaderId: 104, createdBy: 104, orgUnitId: 30, deletedAt: null },
      { id: 99, name: 'Unrelated', number: 'P-99', leaderId: 200, createdBy: 200, orgUnitId: 40, deletedAt: null },
    ],
    projectMember: [] as any[],
    projectPartnerRole: [
      { id: 1, projectId: 58, partyId: 1101, roleId: 1, ...ACTIVE },
      { id: 2, projectId: 58, partyId: 1102, roleId: 2, ...ACTIVE },
      { id: 3, projectId: 58, partyId: 1103, roleId: 1, ...ACTIVE },
    ],
    task: [
      task(4021, 58), // the Professonal's task, no review step
      task(4022, 58, { status: 'in_review', requiresReview: true }),
      task(4023, 58, { requiresReview: true }),
      task(4024, 58), // he WAS assigned, then removed
      task(4025, 58),
      task(4026, 58),
      task(4030, null, { isPersonal: true, createdBy: 101 }), // personal task
      task(9901, 99, { createdBy: 200 }),
    ],
    taskAssignee: [
      assign(1, 4021, 101),
      assign(2, 4022, 101),
      assign(3, 4023, 101),
      assign(4, 4024, 101, new Date('2026-11-21')),
      assign(5, 4025, 102),
      assign(6, 4026, 103),
      assign(7, 4030, 101),
      assign(8, 9901, 200),
    ],
    // Professonal's Kanban table: no move into Done (BIM leader and
    // Depatment lead: no rows = unrestricted).
    roleStageTransition: [
      ['not_started', 'in_progress'],
      ['in_progress', 'not_started'],
      ['in_progress', 'in_review'],
      ['in_review', 'in_progress'],
    ].map(([fromStatus, toStatus], i) => ({ id: i + 1, roleId: ROLE.PROFESSONAL, fromStatus, toStatus })),
    // Threads on the UNRELATED project 99: 700 mentions the three QA
    // users, 701 does not.
    message: [
      { id: 700, entityType: 'project', entityId: 99, parentId: null, authorId: 200, type: 'user', content: 'please check', deletedAt: null, createdAt: T0, updatedAt: T0 },
      { id: 701, entityType: 'project', entityId: 99, parentId: null, authorId: 200, type: 'user', content: 'internal', deletedAt: null, createdAt: T0, updatedAt: T0 },
    ],
    messageMention: [
      { id: 1, messageId: 700, userId: 101 },
      { id: 2, messageId: 700, userId: 102 },
      { id: 3, messageId: 700, userId: 103 },
    ],
    timeEntry: [] as any[],
    taskComment: [] as any[],
    zone: [] as any[],
  };
}

function world() {
  const db = new MemoryDb(PLANWISE_RELATIONS, seed());
  const prisma = memoryPrisma(db);
  const access = new ProjectAccessService(prisma);
  const transitions = new StageTransitionService(prisma);
  const activityLog: any = { logTaskCreated: jest.fn(), logTaskUpdated: jest.fn(), logTaskStatusChange: jest.fn() };
  const tasksService = new TasksService(
    prisma,
    { emit: jest.fn() } as any,
    activityLog,
    { create: jest.fn() } as any,
    { materializeFromTasks: jest.fn() } as any,
  );
  // The gates run before update(); here it only applies the patch.
  jest.spyOn(tasksService, 'update').mockImplementation(async (id: number, dto: any) => {
    const row = db.table('task').find((t) => t.id === id)!;
    Object.assign(row, dto);
    return { ...row } as any;
  });
  const assigneePolicy = new TaskAssigneePolicyService(
    prisma,
    access,
    new ProjectPartnerRolesService(prisma, activityLog),
    { logProjectMemberAdded: jest.fn() } as any,
  );
  const tasks = new TasksController(tasksService, access, transitions, {} as any, assigneePolicy);
  const msgAccess = new MessageAccessService(prisma, access);
  const messages = new MessagesController(new MessagesService(prisma, { emit: jest.fn() } as any, msgAccess));
  return { db, prisma, access, tasks, tasksService, messages };
}

/** The real RolesGuard on a controller handler, as Nest runs it before the handler. */
function guardAllows(who: any, controller: any, handler: string): boolean {
  const ctx = {
    getHandler: () => controller.prototype[handler],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: who }) }),
  } as unknown as ExecutionContext;
  try {
    return new RolesGuard(new Reflector()).canActivate(ctx);
  } catch {
    return false;
  }
}

const reasonOf = (e: any) => e?.getResponse?.()?.details?.reason ?? e?.details?.reason;

describe.each(ROLES)('QA6 P0 — round 4 for $label', ({ who, ownTask }) => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
  });

  describe('1. a task of a project where he is on the Team', () => {
    it('the route permissions let him in (GET and PATCH /tasks/:id)', () => {
      expect(guardAllows(who, TasksController, 'findOne')).toBe(true);
      expect(guardAllows(who, TasksController, 'update')).toBe(true);
    });

    it('GET /tasks/4021 → 200 with the task', async () => {
      const task: any = await w.tasks.findOne(who, 4021);
      expect(task.id).toBe(4021);
      expect(task.project.id).toBe(58);
    });

    it('PATCH /tasks/4021 (a field edit) → 200', async () => {
      const out: any = await w.tasks.update(4021, { name: 'Edited by QA' } as any, who);
      expect(out.name).toBe('Edited by QA');
      expect(w.tasksService.update).toHaveBeenCalledWith(4021, { name: 'Edited by QA' }, who.id, who);
    });

    it('the project is in his accessible list and its task list opens', async () => {
      const acc = await w.access.getAccessibleProjectIds(who.id, false);
      expect(acc.projectIds).toContain(58);
      const list: any = await w.tasks.findAll(who, { projectId: 58 } as any);
      expect(list.data.map((t: any) => t.id)).toContain(4021);
    });
  });

  describe('2. a task of an unrelated project', () => {
    it('GET and PATCH /tasks/9901 → 403 NOT_PROJECT_MEMBER, nothing written', async () => {
      const read = await w.tasks.findOne(who, 9901).catch((e) => e);
      expect(read).toBeInstanceOf(PermissionDeniedException);
      expect(reasonOf(read)).toBe('NOT_PROJECT_MEMBER');

      const write = await w.tasks.update(9901, { name: 'x' } as any, who).catch((e) => e);
      expect(write).toBeInstanceOf(PermissionDeniedException);
      expect(reasonOf(write)).toBe('NOT_PROJECT_MEMBER');
      expect(w.tasksService.update).not.toHaveBeenCalled();
    });

    it('the project list and GET /tasks?projectId=99 leave it out', async () => {
      const acc = await w.access.getAccessibleProjectIds(who.id, false);
      expect(acc.projectIds).not.toContain(99);
      const err = await w.tasks.findAll(who, { projectId: 99 } as any).catch((e) => e);
      expect(reasonOf(err)).toBe('NOT_PROJECT_MEMBER');
    });
  });

  describe('3. moving a task to Done', () => {
    it('a task that requires review, In Review → Done: refused (approve rule)', async () => {
      const err = await w.tasks.update(4022, { status: 'completed' } as any, who).catch((e) => e);
      expect(err).toBeInstanceOf(PermissionDeniedException);
      expect(err.getResponse().details).toMatchObject({ module: 'tasks', action: 'approve' });
      const viaReview = await w.tasks.recordReview(4022, { action: 'approve' }, who).catch((e) => e);
      expect(viaReview).toBeInstanceOf(PermissionDeniedException);
      expect(w.db.table('task').find((t) => t.id === 4022)!.status).toBe('in_review');
    });

    it('a task that requires review cannot skip In Review', async () => {
      const err = await w.tasks.update(4023, { status: 'completed' } as any, who).catch((e) => e);
      expect(err).toBeInstanceOf(PermissionDeniedException);
      expect(w.tasksService.update).not.toHaveBeenCalled();
    });

    it('the project leader approves the same task (control)', async () => {
      await w.tasks.update(4022, { status: 'completed' } as any, PROJECT_LEADER);
      expect(w.db.table('task').find((t) => t.id === 4022)!.status).toBe('completed');
    });
  });

  describe('4. a thread he is mentioned in', () => {
    it('opens (GET /messages/700) though the project is not his; the sibling thread does not', async () => {
      const thread: any = await w.messages.findOne(700, who);
      expect(thread.id).toBe(700);
      const other = await w.messages.findOne(701, who).catch((e) => e);
      expect(reasonOf(other)).toBe('NOT_PROJECT_MEMBER');
    });

    it('is in his Inbox, flagged as mention-only (the web opens the thread, not the project)', async () => {
      const inbox: any = await w.messages.inbox(who);
      expect(inbox.data.map((m: any) => m.id)).toEqual([700]);
      expect(inbox.data[0].canOpenEntity).toBe(false);
    });
  });

  describe('5. GET /tasks/mine', () => {
    it('the route permission lets him in', () => {
      expect(guardAllows(who, TasksController, 'findMine')).toBe(true);
    });

    it('returns his live assignments', async () => {
      const mine: any[] = await w.tasks.findMine(who);
      expect(mine.map((t) => t.id)).toContain(ownTask);
      expect(mine.every((t) => t.assignees.some((a: any) => a.userId === who.id))).toBe(true);
    });
  });
});

describe('QA6 P0 — Professonal specifics', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
  });

  it('his transition table blocks In Progress → Done on a task without review (403 STAGE_TRANSITION)', async () => {
    const err = await w.tasks.update(4021, { status: 'completed' } as any, PROFESSONAL).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(reasonOf(err)).toBe('STAGE_TRANSITION');
    expect(err.message).toBe('Your access role can\'t move a task from "In Progress" to "Done". Ask your administrator.');
    expect(w.db.table('task').find((t) => t.id === 4021)!.status).toBe('in_progress');
  });

  it('a move his table allows (In Progress → In Review) goes through', async () => {
    await w.tasks.update(4021, { status: 'in_review' } as any, PROFESSONAL);
    expect(w.db.table('task').find((t) => t.id === 4021)!.status).toBe('in_review');
  });

  it('GET /tasks/allowed-transitions shows no Done target from In Progress', async () => {
    const res = await w.tasks.getAllowedTransitions(PROFESSONAL, 'in_progress');
    expect(res).toEqual({ fromStatus: 'in_progress', targets: ['not_started', 'in_review'] });
  });

  it('BIM leader and Depatment lead have no table: a task without review moves to Done', async () => {
    await w.tasks.update(4025, { status: 'completed' } as any, BIM_LEADER);
    await w.tasks.update(4026, { status: 'completed' } as any, DEPATMENT_LEAD);
    expect(w.db.table('task').filter((t) => [4025, 4026].includes(t.id)).map((t) => t.status)).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('/tasks/mine: all his live tasks incl. the personal one; not the task he was removed from', async () => {
    const mine: any[] = await w.tasks.findMine(PROFESSONAL);
    expect(mine.map((t) => t.id).sort()).toEqual([4021, 4022, 4023, 4030]);
  });

  it('the Dashboard list (GET /tasks?assigneeId=me) agrees with /tasks/mine on project tasks', async () => {
    // The Dashboard reads GET /tasks?assigneeId; a removed assignment
    // must not count there either (it used to: no deletedAt on the filter).
    const dash: any = await w.tasks.findAll(PROFESSONAL, { assigneeId: 101, perPage: 50 } as any);
    expect(dash.data.map((t: any) => t.id).sort()).toEqual([4021, 4022, 4023]);
    expect(dash.meta.total).toBe(3);
  });

  it('PATCH with the personal task still works for its owner', async () => {
    const out: any = await w.tasks.update(4030, { name: 'mine' } as any, PROFESSONAL);
    expect(out.name).toBe('mine');
  });
});

describe('QA6 P0 — Depatment lead sees his unit through the manager chain (rule 7)', () => {
  it('a project of a subordinate he is NOT on the Team of opens', async () => {
    const w = world();
    // Project 77: only the Professonal (unit 21, under Building 20 which
    // the Depatment lead manages) is on its Team.
    w.db.table('project').push({ id: 77, name: 'Sub', leaderId: 200, createdBy: 200, orgUnitId: 40, deletedAt: null });
    w.db.table('projectPartnerRole').push({ id: 9, projectId: 77, partyId: 1101, roleId: 1, ...ACTIVE });
    w.db.table('task').push({ id: 7701, projectId: 77, status: 'not_started', requiresReview: false, isArchived: false, deletedAt: null, createdBy: 200, createdAt: T0 });
    await expect(w.access.assertProjectAccess(103, 77, false)).resolves.toBeUndefined();
    const task: any = await w.tasks.findOne(DEPATMENT_LEAD, 7701);
    expect(task.id).toBe(7701);
    // ... but not the BIM leader, a peer in the same unit.
    await expect(w.tasks.findOne(BIM_LEADER, 7701)).rejects.toBeInstanceOf(PermissionDeniedException);
  });

  it('approve from a status other than In Review is a 400, even for the leader', async () => {
    const w = world();
    const err = await w.tasks.update(4023, { status: 'completed' } as any, PROJECT_LEADER).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'TASK_NOT_IN_REVIEW' });
  });
});
