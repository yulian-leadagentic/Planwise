/**
 * QA6 package 4 (PR-063) — drag-and-drop task assignment in
 * Operations › Workload, end to end over the in-memory Prisma: the REAL
 * WorkloadAssignController → TaskReassignService → ProjectAccessService,
 * EmployeeScopeService, TaskAssigneePolicyService (+ partner roles),
 * ExecutionPlanningService (GET /workload/team, /workload/tray),
 * ActivityLogService and NotificationsService.
 *
 * Org tree (locked spec D1, the staging shape):
 *   Building (1, no manager) › BIM management (2, manager Dana 55),
 *                              MEP coordination (3) › Team Asaf (4, manager Asaf 60)
 *   Infrastructure (10, manager Ido 70) · CAD (11, no manager)
 * People: Admin 1; Ofir 9 (leader of project 59, BIM management);
 * Daniel Huri 12 (BIM management); Yair Goldfryd 34 (Team Asaf);
 * Professonal 40 (BIM management); Noa 71 (Infrastructure); Rami 80
 * (CAD); Gil 90 (BIM management, not on the Team of 59).
 * Project 59 ("ניסוי 9", unit 2): Team 12, 34, 40, 60, 71, 80.
 * Project 61 (unit 10, leader 70): secret for the BIM people; Daniel holds a task there.
 * Project 62 (unit 10, leader Ido 70): Team 12, 71.
 * All dates are in NEXT work week (Sun..Thu), so "today" never matters.
 */
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';

import { MemoryDb, memoryPrisma, PLANWISE_RELATIONS, Relations } from '../../testing/memory-prisma';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { EmployeeScopeService } from '../../common/services/employee-scope.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ProjectPartnerRolesService } from '../project-partner-roles/project-partner-roles.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TaskAssigneePolicyService } from '../tasks/task-assignee-policy.service';
import { ExecutionPlanningService } from '../execution-planning/execution-planning.service';
import { ExecutionPlanningController } from '../execution-planning/execution-planning.controller';
import { addDaysYmd, workWeekOf } from '../execution-planning/workload-engine';
import { todayKey } from '../execution-planning/workload-loader';
import { REALTIME_INVALIDATE } from '../realtime/realtime.events';
import { REALTIME_ROUTES } from '../realtime/realtime-routes';
import { TaskReassignService } from './task-reassign.service';
import { WorkloadAssignController } from './workload-assign.controller';

const WEEK = workWeekOf(todayKey(), [5, 6]);
const N = (i: number) => addDaysYmd(WEEK.from, 7 + i); // N(0) = next Sunday … N(4) = Thursday, N(5) = Friday
const VIEW = { from: N(0), to: N(6) };
const at = (key: string) => new Date(`${key}T00:00:00Z`);

const grant = (route: string, extra: Record<string, boolean> = {}) => ({
  module: { route: `/${route}`, name: route },
  canRead: true, canWrite: true, canDelete: false, canApprove: false, canExport: false, ...extra,
});
const MODULES = ['projects', 'tasks', 'operations'].map((r) => grant(r));
const u = (id: number, extra: Record<string, any> = {}) => ({ id, isAdmin: false, roleModules: MODULES, ...extra });

const ADMIN = u(1, { isAdmin: true, roleModules: [] });
const LEADER = u(9); // Ofir, leader of 59
const DANIEL = u(12);
const PRO = u(40); // Professonal: tasks:write, no drag rights
const DANA = u(55); // manager of BIM management (Daniel's chain)
const ASAF = u(60); // manager of Team Asaf (Yair's chain)
const IDO = u(70); // manager of Infrastructure, leader of 62

const ACTIVE = { status: 'active', validFrom: new Date('2026-01-01'), validTo: new Date('9999-12-31') };

const RELATIONS: Relations = {
  ...PLANWISE_RELATIONS,
  user: {
    ...PLANWISE_RELATIONS.user,
    userRoles: { model: 'userRole', from: 'id', to: 'userId', many: true },
  },
  userRole: { role: { model: 'role', from: 'roleId', to: 'id' } },
  task: {
    ...PLANWISE_RELATIONS.task,
    projectDeliverable: { model: 'projectDeliverable', from: 'projectDeliverableId', to: 'id' },
    deliverableTemplate: { model: 'template', from: 'deliverableTemplateId', to: 'id' },
  },
  taskReassignment: {
    task: { model: 'task', from: 'taskId', to: 'id' },
    actor: { model: 'user', from: 'actorId', to: 'id' },
    fromUser: { model: 'user', from: 'fromUserId', to: 'id' },
    toUser: { model: 'user', from: 'toUserId', to: 'id' },
    approver: { model: 'user', from: 'approverUserId', to: 'id' },
    decidedBy: { model: 'user', from: 'decidedById', to: 'id' },
  },
  taskDependency: {
    task: { model: 'task', from: 'taskId', to: 'id' },
    dependsOn: { model: 'task', from: 'dependsOnId', to: 'id' },
  },
};

function seed() {
  const person = (id: number, firstName: string, lastName: string, orgUnitId: number | null, extra: Record<string, any> = {}) => ({
    id, firstName, lastName, email: `u${id}@amec.co.il`, roleId: 6, orgUnitId, businessPartnerId: 1000 + id,
    userType: 'employee', isActive: true, deletedAt: null, dailyStandardHours: 8, position: null, avatarUrl: null, ...extra,
  });
  const task = (id: number, projectId: number | null, code: string, extra: Record<string, any> = {}) => ({
    id, projectId, zoneId: null, code, name: `Task ${code}`, status: 'in_progress', requiresReview: false,
    isPersonal: false, isArchived: false, createdBy: 9, deletedAt: null, budgetHours: 8, dueDateOverridden: false,
    estimatedStartDate: null, startDate: null, endDate: null, phaseId: null, projectDeliverableId: null, deliverableTemplateId: null,
    createdAt: new Date('2026-11-01T08:00:00Z'), ...extra,
  });
  const member = (id: number, projectId: number, userId: number) => ({ id, projectId, userId, role: null });
  const people = [
    person(1, 'Admin', 'User', null, { roleId: 1 }),
    person(9, 'Ofir', 'Leader', 2, { roleId: 7 }),
    person(12, 'Daniel', 'Huri', 2),
    person(34, 'Yair', 'Goldfryd', 4),
    person(40, 'Pro', 'Fessional', 2),
    person(55, 'Dana', 'Manager', 2, { roleId: 7 }),
    person(60, 'Asaf', 'Lead', 4, { roleId: 7 }),
    person(70, 'Ido', 'Infra', 10, { roleId: 7 }),
    person(71, 'Noa', 'Engineer', 10),
    person(80, 'Rami', 'Drafter', 11),
    person(90, 'Gil', 'Outsider', 2),
  ];
  return {
    role: [{ id: 1, name: 'Admin' }, { id: 6, name: 'Professonal' }, { id: 7, name: 'Depatment lead' }],
    userRole: [] as any[],
    user: people,
    businessPartner: people.map((p) => ({ id: 1000 + p.id, partnerType: 'person', displayName: `${p.firstName} ${p.lastName}`, email: p.email, deletedAt: null })),
    partnerRoleType: [{ id: 1, code: 'employee', name: 'Employee' }],
    businessPartnerRole: people.map((p, i) => ({ id: i + 1, businessPartnerId: 1000 + p.id, roleTypeId: 1 })),
    projectRoleType: [{ id: 1, code: 'participant', name: 'Participant' }],
    profession: [{ id: 3, name: 'BIM Coordinator' }, { id: 4, name: 'Modeler' }],
    businessPartnerProfession: [
      { id: 1, businessPartnerId: 1034, professionId: 3 },
      { id: 2, businessPartnerId: 1071, professionId: 4 },
    ],
    phase: [
      { id: 7, name: 'BIM Coordination', kind: 'service', isActive: true, requiredProfessionIds: null, sortOrder: 1 },
      { id: 8, name: 'Design', kind: 'phase', isActive: true, requiredProfessionIds: [3], sortOrder: 2 },
    ],
    orgUnit: [
      { id: 1, name: 'Building', parentId: null, path: '/1/', depth: 0, sortOrder: 0, managerUserId: null, deletedAt: null },
      { id: 2, name: 'BIM management', parentId: 1, path: '/1/2/', depth: 1, sortOrder: 0, managerUserId: 55, deletedAt: null },
      { id: 3, name: 'MEP coordination', parentId: 1, path: '/1/3/', depth: 1, sortOrder: 1, managerUserId: null, deletedAt: null },
      { id: 4, name: 'Team Asaf', parentId: 3, path: '/1/3/4/', depth: 2, sortOrder: 0, managerUserId: 60, deletedAt: null },
      { id: 10, name: 'Infrastructure', parentId: null, path: '/10/', depth: 0, sortOrder: 1, managerUserId: 70, deletedAt: null },
      { id: 11, name: 'CAD', parentId: null, path: '/11/', depth: 0, sortOrder: 2, managerUserId: null, deletedAt: null },
    ],
    project: [
      { id: 59, name: 'ניסוי 9', leaderId: 9, createdBy: 9, orgUnitId: 2, deletedAt: null },
      { id: 61, name: 'Secret', leaderId: 70, createdBy: 70, orgUnitId: 10, deletedAt: null },
      { id: 62, name: 'Infra job', leaderId: 70, createdBy: 70, orgUnitId: 10, deletedAt: null },
    ],
    projectMember: [
      member(1, 59, 12), member(2, 59, 34), member(3, 59, 40), member(4, 59, 60), member(5, 59, 71), member(6, 59, 80),
      member(7, 61, 71), member(8, 62, 12), member(9, 62, 71),
    ],
    projectPartnerRole: [] as any[],
    task: [
      task(4019, 59, 'CRD-039', { estimatedStartDate: at(N(0)), endDate: at(N(1)) }), // predecessor of 4021
      task(4021, 59, 'CRD-040', { estimatedStartDate: at(N(2)), endDate: at(N(2)), phaseId: 7 }), // Tue, Daniel
      task(4022, 59, 'CRD-041', { budgetHours: 6, estimatedStartDate: at(N(0)), endDate: at(N(2)) }), // Sun..Tue, Daniel + Pro
      task(4023, 59, 'CRD-042', { budgetHours: 4, estimatedStartDate: at(N(2)), endDate: at(N(3)) }), // unassigned, Tue..Wed
      task(4024, 59, 'CRD-043', { budgetHours: 3, endDate: at('2026-01-08') }), // overdue, Daniel
      task(4025, 59, 'CRD-044', { budgetHours: 5, estimatedStartDate: at(N(3)), endDate: at(N(3)) }), // Wed, Daniel, 1.5h logged
      task(4030, null, 'ME-1', { isPersonal: true, createdBy: 12, estimatedStartDate: at(N(1)), endDate: at(N(1)) }),
      task(4031, 59, 'CRD-099', { status: 'completed', estimatedStartDate: at(N(1)), endDate: at(N(1)) }),
      task(6101, 61, 'SEC-1', { budgetHours: 4, estimatedStartDate: at(N(0)), endDate: at(N(0)) }), // Daniel, masked for BIM people
      task(6102, 61, 'SEC-2', { budgetHours: 2, estimatedStartDate: at(N(1)), endDate: at(N(1)) }), // unassigned, secret
      task(6201, 62, 'INF-1', { budgetHours: 4, estimatedStartDate: at(N(1)), endDate: at(N(1)) }), // Daniel
    ],
    taskAssignee: [
      { id: 1, taskId: 4019, userId: 34, deletedAt: null },
      { id: 2, taskId: 4021, userId: 12, deletedAt: null },
      { id: 3, taskId: 4022, userId: 12, deletedAt: null },
      { id: 4, taskId: 4022, userId: 40, deletedAt: null },
      { id: 5, taskId: 4024, userId: 12, deletedAt: null },
      { id: 6, taskId: 4025, userId: 12, deletedAt: null },
      { id: 7, taskId: 4030, userId: 12, deletedAt: null },
      { id: 8, taskId: 4031, userId: 12, deletedAt: null },
      { id: 9, taskId: 6101, userId: 12, deletedAt: null },
      { id: 10, taskId: 6201, userId: 12, deletedAt: null },
    ],
    taskDependency: [{ id: 1, taskId: 4021, dependsOnId: 4019, lag: 0 }],
    timeEntry: [{ id: 1, taskId: 4025, userId: 12, minutes: 90, date: at(N(0)), deletedAt: null }],
    taskReassignment: [] as any[],
    activityLog: [] as any[],
    notification: [] as any[],
    hrSettings: [{ id: 1, weeklyRestDays: [5, 6] }],
    calendarDay: [] as any[],
    workSchedule: [] as any[],
    absenceRecord: [] as any[],
  };
}

function world() {
  const db = new MemoryDb(RELATIONS, seed());
  const prisma = memoryPrisma(db);
  const events = { emit: jest.fn() };
  const access = new ProjectAccessService(prisma);
  const scope = new EmployeeScopeService(prisma);
  const activityLog = new ActivityLogService(prisma);
  const partnerRoles = new ProjectPartnerRolesService(prisma, activityLog);
  const policy = new TaskAssigneePolicyService(prisma, access, partnerRoles, activityLog);
  const eps = new ExecutionPlanningService(prisma, access, scope);
  const notifications = new NotificationsService(prisma, events as any);
  const service = new TaskReassignService(prisma, access, scope, policy, eps, activityLog, notifications, events as any);
  const ctrl = new WorkloadAssignController(service);
  const epsCtrl = new ExecutionPlanningController(eps, access, scope);
  const assignees = (taskId: number) =>
    db.table('taskAssignee').filter((a) => a.taskId === taskId && a.deletedAt == null).map((a) => a.userId).sort((a, b) => a - b);
  const taskRow = (id: number) => db.table('task').find((t) => t.id === id)!;
  const lines = (action?: string) =>
    db.table('activityLog').filter((l) => l.category === 'task' && String(l.action).startsWith('reassign') && (!action || l.action === action));
  const notes = (userId: number, type?: string) =>
    db.table('notification').filter((n) => n.userId === userId && (!type || n.type === type));
  const team = (asUser: any) => epsCtrl.getTeamWorkload(asUser, VIEW.from, VIEW.to) as Promise<any>;
  const tray = (asUser: any) => epsCtrl.getWorkloadTray(asUser, VIEW.from, VIEW.to) as Promise<any>;
  const move = (asUser: any, taskId: number, body: Record<string, any>) => ctrl.reassignTask(asUser, taskId, { view: VIEW, ...body }) as Promise<any>;
  return { db, prisma, events, ctrl, epsCtrl, service, assignees, taskRow, lines, notes, team, tray, move };
}

const err = async (p: Promise<any>) => p.then(() => { throw new Error('expected an error'); }, (e) => e);
const codeOf = (e: any) => e?.getResponse?.()?.code;
const reasonOf = (e: any) => e?.getResponse?.()?.details?.reason;
const ymd = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const day = (person: any, key: string) => person.days.find((x: any) => x.date === key);

describe('QA6 PR-063 — GET /workload/team drag-and-drop fields', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => { w = world(); });

  it('people carry the D1 department, qualifications and canDragFrom; existing fields are unchanged', async () => {
    const out = await w.team(ADMIN);
    const p = (id: number) => out.people.find((x: any) => x.id === id);
    expect(p(12)).toMatchObject({ orgUnit: { id: 2, name: 'BIM management' }, departmentId: 1, departmentName: 'Building', qualificationIds: [], canDragFrom: true });
    expect(p(34)).toMatchObject({ orgUnit: { id: 4, name: 'Team Asaf' }, departmentId: 1, departmentName: 'Building', qualificationIds: [3] });
    expect(p(71)).toMatchObject({ departmentId: 10, departmentName: 'Infrastructure', qualificationIds: [4] });
    expect(p(1)).toMatchObject({ departmentId: null, departmentName: null });
    // Day chips keep their shape.
    expect(day(p(12), N(2)).tasks).toContainEqual({ taskId: 4021, code: 'CRD-040', name: 'Task CRD-040', projectId: 59, projectName: 'ניסוי 9', hours: 8 });
  });

  it('the tasks index and the assign block (Admin)', async () => {
    const out = await w.team(ADMIN);
    expect(out.tasks['4021']).toEqual({
      id: 4021, code: 'CRD-040', name: 'Task CRD-040', projectId: 59, projectName: 'ניסוי 9',
      service: { id: 7, name: 'BIM Coordination' }, status: 'in_progress',
      estimatedStartDate: N(2), startDate: null, endDate: N(2), budgetHours: 8, remainingHours: 8,
      assigneeIds: [12], loggedUserIds: [], loggedHoursByUser: null, overdue: false, canDrag: true, pending: null,
    });
    expect(out.tasks['4022'].assigneeIds).toEqual([12, 40]);
    expect(out.assign.canAssign).toBe(true);
    expect(out.assign.projects['59']).toEqual({ canManage: true, teamUserIds: [9, 12, 34, 40, 60, 71, 80] });
    expect(out.assign.services).toEqual({}); // no service has a requirement yet (a lifecycle phase never counts)
    expect(out.assign.approvalsWaitingForMe).toBe(0);
  });

  it('a Professonal: masked chips never get a tasks entry; nothing draggable; read-only lanes', async () => {
    const out = await w.team(PRO);
    const daniel = out.people.find((x: any) => x.id === 12);
    expect(day(daniel, N(0)).tasks).toContainEqual(expect.objectContaining({ taskId: null, name: 'Other project', masked: true }));
    expect(Object.keys(out.tasks)).not.toContain('6101');
    expect(JSON.stringify(out.tasks)).not.toMatch(/SEC-1|Secret/);
    expect(out.people.every((p: any) => p.canDragFrom === false)).toBe(true);
    expect(Object.values(out.tasks).every((t: any) => t.canDrag === false)).toBe(true);
    expect(out.assign.canAssign).toBe(false);
    expect(out.assign.projects['59'].canManage).toBe(false);
  });

  it("a department manager may drag his people's chips (canDragFrom), not the project's (canDrag)", async () => {
    const out = await w.team(DANA);
    const p = (id: number) => out.people.find((x: any) => x.id === id);
    expect(p(12).canDragFrom).toBe(true);
    expect(p(40).canDragFrom).toBe(true);
    expect(p(34).canDragFrom).toBe(false);
    expect(out.tasks['4021'].canDrag).toBe(false);
    expect(out.assign.canAssign).toBe(true);
  });

  it('logged hours: ⏱ ids for everyone who sees the task, hours only for the leader / visible people', async () => {
    const leader = await w.team(LEADER);
    expect(leader.tasks['4025']).toMatchObject({ loggedUserIds: [12], loggedHoursByUser: { '12': 1.5 }, remainingHours: 3.5 });
    const pro = await w.team(PRO);
    expect(pro.tasks['4025']).toMatchObject({ loggedUserIds: [12], loggedHoursByUser: null });
    const dana = await w.team(DANA); // Daniel is in her chain
    expect(dana.tasks['4025'].loggedHoursByUser).toEqual({ '12': 1.5 });
  });
});

describe('QA6 PR-063 — POST /tasks/:id/reassign', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => { w = world(); });

  it('D1 same top-level department: applied at once; dates move (D5) and the override is set (D8); one activity line', async () => {
    const out = await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 34, fromDay: N(2), toDay: N(3) });
    expect(out.result).toBe('applied');
    expect(out.reassignment).toMatchObject({ status: 'applied', crossDepartment: false, approver: null });
    expect(new Date(out.reassignment.undoUntil).getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    expect(out.task).toEqual({ id: 4021, assigneeIds: [34], estimatedStartDate: N(3), endDate: N(3), dueDateOverridden: true });
    expect(out.changed).toEqual({ assignee: true, dates: true });
    expect(out.addedToTeam).toBe(false);
    expect(out.loggedStays).toBeNull();
    expect(w.assignees(4021)).toEqual([34]);
    // Both people over the view, updated, in the order from → to.
    expect(out.people.map((p: any) => p.id)).toEqual([12, 34]);
    const [daniel, yair] = out.people;
    expect(day(daniel, N(2)).tasks.some((c: any) => c.taskId === 4021)).toBe(false);
    expect(day(yair, N(3)).tasks).toContainEqual(expect.objectContaining({ taskId: 4021, hours: 8 }));
    expect(yair).toMatchObject({ departmentId: 1, canDragFrom: false }); // the leader is not Yair's manager
    // One line, the task's project.
    expect(w.lines()).toHaveLength(1);
    expect(w.lines('reassign')[0]).toMatchObject({
      projectId: 59, entityType: 'task', entityId: 4021, userId: 9,
      metadata: { via: 'workload', reassignmentId: out.reassignment.id },
    });
    expect(w.lines('reassign')[0].description).toMatch(/^Moved CRD-040 Task CRD-040 from Daniel Huri to Yair Goldfryd \(/);
    expect(w.lines('reassign')[0].description).not.toMatch(/[—–]/);
    // B: the usual assignment flow; A: the D10 notice.
    expect(w.events.emit).toHaveBeenCalledWith('task.assignee.added', expect.objectContaining({ taskId: 4021, assigneeId: 34, userId: 9 }));
    expect(w.notes(12, 'reassign_removed')[0]).toMatchObject({
      title: 'CRD-040 Task CRD-040 was moved to Yair Goldfryd by Ofir Leader', entityType: 'task_reassignment',
    });
    expect(w.db.table('taskReassignment')[0]).toMatchObject({ status: 'applied', prevAssigneeIds: [12], newAssigneeIds: [34] });
    expect(w.db.table('taskReassignment')[0].pendingTaskId ?? null).toBeNull();
  });

  it('same column, other person (delta 0): a pure reassign, dates and override untouched', async () => {
    const out = await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 34, fromDay: N(2), toDay: N(2) });
    expect(out.task).toEqual({ id: 4021, assigneeIds: [34], estimatedStartDate: N(2), endDate: N(2), dueDateOverridden: false });
    expect(out.changed).toEqual({ assignee: true, dates: false });
  });

  it('D7 a day move of a task with two assignees moves the task for both; R2 replace keeps the others', async () => {
    const out = await w.move(LEADER, 4022, { fromUserId: 12, toUserId: 12, fromDay: N(0), toDay: N(1) });
    expect(out.task).toMatchObject({ assigneeIds: [12, 40], estimatedStartDate: N(1), endDate: N(3) });
    expect(out.changed).toEqual({ assignee: false, dates: true });
    expect(w.lines('reassign')[0].description).toMatch(/^Moved CRD-041 Task CRD-041 for Daniel Huri \(/);
    // Replace, not add: Daniel → Yair keeps Pro.
    const again = await w.move(LEADER, 4022, { fromUserId: 12, toUserId: 34, fromDay: N(1), toDay: N(1) });
    expect(again.task.assigneeIds).toEqual([34, 40]);
  });

  it('D1 another top-level department → pending; the chip and the load stay with Daniel; the approver (D2) decides', async () => {
    const out = await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 71, fromDay: N(2), toDay: N(2) });
    expect(out.result).toBe('pending');
    expect(out.reassignment).toMatchObject({ status: 'pending', crossDepartment: true, approver: { id: 70, name: 'Ido Infra' } });
    expect(out.task.assigneeIds).toEqual([12]);
    expect(out.changed).toEqual({ assignee: false, dates: false });
    expect(w.assignees(4021)).toEqual([12]);
    expect(day(out.people[0], N(2)).planned).toBe(8 + 1); // Daniel still carries it (plus his 1h/day share of 4022)
    expect(w.lines('reassign_request')[0].description).toMatch(/waiting for approval by Ido Infra$/);
    expect(w.notes(70, 'reassign_request')[0]).toMatchObject({
      title: 'Approval needed: move CRD-040 Task CRD-040 to Noa Engineer',
      data: expect.objectContaining({ taskId: 4021, projectId: 59, toDay: N(2), weekOf: N(2), status: 'pending' }),
    });
    expect(w.notes(12)).toHaveLength(0); // nothing for Daniel until it happens

    // The board shows APPROVAL; the task is not draggable while pending.
    const board = await w.team(LEADER);
    expect(board.tasks['4021'].pending).toMatchObject({ id: out.reassignment.id, fromUserId: 12, toUserId: 71, toName: 'Noa Engineer', approver: { id: 70 }, requestedBy: { id: 9, name: 'Ofir Leader' } });
    expect(board.tasks['4021'].canDrag).toBe(false);
    const idos = await w.team(IDO);
    expect(idos.assign.approvalsWaitingForMe).toBe(1);
    // A second move of the same task waits for the decision.
    expect(codeOf(await err(w.move(LEADER, 4021, { fromUserId: 12, toUserId: 34, fromDay: N(2), toDay: N(2) })))).toBe('REASSIGN_PENDING');

    // The approver approves: only then the task moves.
    const ok: any = await w.ctrl.approve(IDO, out.reassignment.id, { view: VIEW });
    expect(ok.result).toBe('approved');
    expect(ok.task.assigneeIds).toEqual([71]);
    expect(w.assignees(4021)).toEqual([71]);
    expect(ok.people.map((p: any) => p.id)).toEqual([12, 71]);
    expect(w.db.table('taskReassignment')[0]).toMatchObject({ status: 'approved', pendingTaskId: null, decidedById: 70 });
    expect(w.lines('reassign_approve')[0]).toMatchObject({ userId: 70, projectId: 59 });
    expect(w.notes(9, 'reassign_result')[0].title).toBe('Approved: CRD-040 Task CRD-040 moved to Noa Engineer');
    expect(w.notes(12, 'reassign_removed')).toHaveLength(1);
    expect(w.events.emit).toHaveBeenCalledWith(REALTIME_INVALIDATE, { type: 'task.updated', projectId: 59, taskId: 4021 });
    expect(w.lines()).toHaveLength(2); // request + approve
  });

  it('D2 a department without a manager: no approver, every Admin is told and an Admin decides; others get 403', async () => {
    const out = await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 80, fromDay: N(2), toDay: N(2) });
    expect(out.result).toBe('pending');
    expect(out.reassignment.approver).toBeNull();
    expect(w.notes(1, 'reassign_request')).toHaveLength(1);
    expect(w.lines('reassign_request')[0].description).toMatch(/waiting for approval by an administrator$/);
    const denied = await err(w.ctrl.approve(PRO, out.reassignment.id, {}));
    expect(denied).toBeInstanceOf(PermissionDeniedException);
    expect(reasonOf(denied)).toBe('REASSIGN_NOT_ALLOWED');
    const tray = await w.tray(ADMIN);
    expect(tray.approvals.map((r: any) => r.id)).toEqual([out.reassignment.id]);
    const ok: any = await w.ctrl.approve(ADMIN, out.reassignment.id, {});
    expect(ok.result).toBe('approved');
    expect(w.assignees(4021)).toEqual([80]);
  });

  it('reject: the task stays; the requester hears; the task can be moved again', async () => {
    const out = await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 71, fromDay: N(2), toDay: N(2) });
    const res: any = await w.ctrl.reject(IDO, out.reassignment.id, { note: 'Noa is full this week' });
    expect(res.result).toBe('rejected');
    expect(res.reassignment).toMatchObject({ status: 'rejected', decisionNote: 'Noa is full this week' });
    expect(w.assignees(4021)).toEqual([12]);
    expect(w.notes(9, 'reassign_result')[0].title).toBe('Rejected: CRD-040 Task CRD-040 stays with Daniel Huri');
    expect(w.lines('reassign_reject')).toHaveLength(1);
    expect(codeOf(await err(w.ctrl.approve(IDO, out.reassignment.id, {})))).toBe('REASSIGN_NOT_PENDING');
    const next = await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 34, fromDay: N(2), toDay: N(2) });
    expect(next.result).toBe('applied');
  });

  it('D3 an Admin, or a manager in the receiving chain, skips the approval', async () => {
    const admin = await w.move(ADMIN, 4021, { fromUserId: 12, toUserId: 71, fromDay: N(2), toDay: N(2) });
    expect(admin).toMatchObject({ result: 'applied', reassignment: { crossDepartment: true, status: 'applied' } });
    // Ido leads 62 and manages Infrastructure: Daniel → Noa is cross-department, but he would approve it himself.
    const ido = await w.move(IDO, 6201, { fromUserId: 12, toUserId: 71, fromDay: N(1), toDay: N(1) });
    expect(ido).toMatchObject({ result: 'applied', reassignment: { crossDepartment: true } });
    expect(w.assignees(6201)).toEqual([71]);
    expect(w.lines('reassign_request')).toHaveLength(0);
  });

  it('D4 tray moves never wait: assign from the tray (D6 anchoring) and back to the tray', async () => {
    // Inside the window, not overdue: dates kept.
    const inside = await w.move(LEADER, 4023, { fromUserId: null, toUserId: 71, fromDay: null, toDay: N(3) });
    expect(inside).toMatchObject({ result: 'applied', reassignment: { crossDepartment: false } });
    expect(inside.task).toEqual({ id: 4023, assigneeIds: [71], estimatedStartDate: N(2), endDate: N(3), dueDateOverridden: false });
    expect(w.lines('reassign')[0].description).toBe('Assigned CRD-042 Task CRD-042 to Noa Engineer from the tray');
    // Back to the tray: unassigned, dates untouched (R2).
    const back = await w.move(LEADER, 4023, { fromUserId: 71, toUserId: null, fromDay: N(2), toDay: null });
    expect(back).toMatchObject({ result: 'applied', changed: { assignee: true, dates: false } });
    expect(w.assignees(4023)).toEqual([]);
    expect(back.people.map((p: any) => p.id)).toEqual([71]);
    expect(w.lines('reassign')[1].description).toBe('Moved CRD-042 Task CRD-042 from Noa Engineer back to the tray');
    // Outside the window: it starts on the drop day with its 2 working days (Thu → Sun).
    const outside = await w.move(LEADER, 4023, { fromUserId: null, toUserId: 34, toDay: N(4) });
    expect(outside.task).toMatchObject({ estimatedStartDate: N(4), endDate: N(7), dueDateOverridden: true });
  });

  it('D6 an overdue task dropped from the tray starts on the drop day', async () => {
    const out = await w.move(LEADER, 4024, { fromUserId: 12, toUserId: 12, fromDay: null, toDay: N(1) });
    expect(out.task).toMatchObject({ assigneeIds: [12], estimatedStartDate: N(1), endDate: N(1), dueDateOverridden: true });
  });

  it('hours already logged stay with the original person; the response says so', async () => {
    const out = await w.move(LEADER, 4025, { fromUserId: 12, toUserId: 34, fromDay: N(3), toDay: N(3) });
    expect(out.loggedStays).toEqual({ userId: 12, name: 'Daniel Huri', hours: 1.5 });
    expect(w.db.table('timeEntry')).toEqual([expect.objectContaining({ taskId: 4025, userId: 12, minutes: 90 })]);
    // Yair carries only the remaining 3.5h.
    expect(day(out.people[1], N(3)).tasks).toContainEqual(expect.objectContaining({ taskId: 4025, hours: 3.5 }));
    // Someone who neither leads the project nor sees Daniel's timesheet gets the flag without the hours
    // (an Admin has no timesheet exception, round 3).
    w = world();
    const admin = await w.move(ADMIN, 4025, { fromUserId: 12, toUserId: 60, fromDay: N(3), toDay: N(3) });
    expect(admin.loggedStays).toEqual({ userId: 12, name: 'Daniel Huri', hours: null });
  });

  it('the QA6 assignee policy: a chain manager cannot bring in someone outside the Team (403); the leader adds him as participant', async () => {
    const e = await err(w.move(DANA, 4021, { fromUserId: 12, toUserId: 90, fromDay: N(2), toDay: N(2) }));
    expect(e).toBeInstanceOf(PermissionDeniedException);
    expect(reasonOf(e)).toBe('ASSIGNEE_NOT_ON_TEAM');
    expect(w.assignees(4021)).toEqual([12]);
    // Dana may move Daniel's chip to someone on the Team.
    const ok = await w.move(DANA, 4021, { fromUserId: 12, toUserId: 40, fromDay: N(2), toDay: N(2) });
    expect(ok.result).toBe('applied');

    w = world();
    const lead = await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 90, fromDay: N(2), toDay: N(2) });
    expect(lead).toMatchObject({ result: 'applied', addedToTeam: true });
    expect(w.db.table('projectPartnerRole').filter((r) => r.projectId === 59 && r.partyId === 1090 && r.roleId === 1)).toHaveLength(1);
    expect(w.db.table('activityLog').filter((l) => l.action === 'member_add')).toHaveLength(1);
    expect(w.lines()).toHaveLength(1);
  });

  it('the service gate: once a service needs a qualification, the drop is refused with 422 for people without it', async () => {
    w.db.table('phase').find((p) => p.id === 7)!.requiredProfessionIds = [3];
    const board = await w.team(LEADER);
    expect(board.assign.services).toEqual({ '7': { requiredQualificationIds: [3] } });
    const e = await err(w.move(LEADER, 4021, { fromUserId: 12, toUserId: 40, fromDay: N(2), toDay: N(2) }));
    expect(e.getStatus()).toBe(422);
    expect(codeOf(e)).toBe('SERVICE_NOT_PROVIDED');
    expect(e.getResponse().message).toBe('Pro Fessional does not provide BIM Coordination: it needs one of these qualifications: BIM Coordinator.');
    expect(w.assignees(4021)).toEqual([12]);
    // Yair holds BIM Coordinator.
    expect((await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 34, fromDay: N(2), toDay: N(2) })).result).toBe('applied');
  });

  it('who may drag: a Professonal (403 REASSIGN_NOT_ALLOWED), a tray chip only for the leader / Admin', async () => {
    const e = await err(w.move(PRO, 4021, { fromUserId: 12, toUserId: 34, fromDay: N(2), toDay: N(2) }));
    expect(e).toBeInstanceOf(PermissionDeniedException);
    expect(reasonOf(e)).toBe('REASSIGN_NOT_ALLOWED');
    const tray = await err(w.move(DANA, 4023, { fromUserId: null, toUserId: 40, toDay: N(2) }));
    expect(reasonOf(tray)).toBe('REASSIGN_NOT_ALLOWED');
    // Asaf manages Yair, not Daniel, and does not lead 59.
    expect(reasonOf(await err(w.move(ASAF, 4021, { fromUserId: 12, toUserId: 34, fromDay: N(2), toDay: N(2) })))).toBe('REASSIGN_NOT_ALLOWED');
    // A task of a project he cannot open: 403 before anything else.
    expect(await err(w.move(DANA, 6101, { fromUserId: 12, toUserId: 40, fromDay: N(0), toDay: N(0) }))).toBeInstanceOf(PermissionDeniedException);
    expect(w.lines()).toHaveLength(0);
  });

  it('the route needs tasks:write (RolesGuard): an Employee without it gets 403', () => {
    const handler = WorkloadAssignController.prototype.reassignTask;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('tasks/:id/reassign');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    const guard = new RolesGuard(new Reflector());
    const ctx = (user: any) => ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => handler,
      getClass: () => WorkloadAssignController,
    }) as any;
    const employee = { id: 41, isAdmin: false, roleModules: [grant('tasks', { canWrite: false }), grant('operations')] };
    expect(() => guard.canActivate(ctx(employee))).toThrow();
    expect(guard.canActivate(ctx(LEADER))).toBe(true);
    expect(REALTIME_ROUTES['POST tasks/:id/reassign']).toEqual({ type: 'task.updated', source: { kind: 'task', param: 'id' } });
  });

  it('stale, noop and invalid moves', async () => {
    // Daniel is not on 4023.
    expect(codeOf(await err(w.move(LEADER, 4023, { fromUserId: 12, toUserId: 34, fromDay: N(2), toDay: N(2) })))).toBe('REASSIGN_STALE');
    // 4021 has an assignee: not a tray task any more.
    expect(codeOf(await err(w.move(LEADER, 4021, { fromUserId: null, toUserId: 34, toDay: N(2) })))).toBe('REASSIGN_STALE');
    expect(codeOf(await err(w.move(LEADER, 4021, { fromUserId: 12, toUserId: 12, fromDay: N(2), toDay: N(2) })))).toBe('REASSIGN_NOOP');
    expect(codeOf(await err(w.move(LEADER, 4021, { fromUserId: null, toUserId: null })))).toBe('REASSIGN_NOOP');
    expect(codeOf(await err(w.move(LEADER, 4021, { fromUserId: 12, toUserId: 34, fromDay: N(2), toDay: N(5) })))).toBe('REASSIGN_INVALID_DAY');
    expect(codeOf(await err(w.move(LEADER, 4021, { fromUserId: 12, toUserId: 34, fromDay: 'Tuesday', toDay: N(2) })))).toBe('REASSIGN_INVALID_DAY');
    expect(codeOf(await err(w.move(DANIEL, 4030, { fromUserId: 12, toUserId: 12, fromDay: N(1), toDay: N(2) })))).toBe('TASK_PERSONAL');
    expect(codeOf(await err(w.move(LEADER, 4031, { fromUserId: 12, toUserId: 34, fromDay: N(1), toDay: N(1) })))).toBe('TASK_CLOSED');
    expect(w.db.table('taskReassignment')).toHaveLength(0);
    expect(w.lines()).toHaveLength(0);
  });

  it('the write is one transaction: a failure after A was removed leaves nothing behind', async () => {
    const orig = w.prisma.taskReassignment.create;
    w.prisma.taskReassignment.create = async () => { throw new Error('disk full'); };
    await expect(w.move(LEADER, 4021, { fromUserId: 12, toUserId: 90, fromDay: N(2), toDay: N(3) })).rejects.toThrow('disk full');
    w.prisma.taskReassignment.create = orig;
    expect(w.assignees(4021)).toEqual([12]);
    expect(ymd(w.taskRow(4021).endDate)).toBe(N(2));
    expect(w.db.table('projectPartnerRole')).toHaveLength(0); // the participant role rolled back too
    expect(w.lines()).toHaveLength(0);
  });

  it('R6 dependency warnings: a predecessor that now ends on or after the new start (not blocking)', async () => {
    const out = await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 12, fromDay: N(2), toDay: N(1) });
    expect(out.result).toBe('applied');
    expect(out.warnings).toEqual([{ code: 'PREDECESSOR_OVERLAP', taskId: 4019, message: 'CRD-039 ends on or after the new start date' }]);
    const later = await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 12, fromDay: N(1), toDay: N(3) });
    expect(later.warnings).toEqual([]);
  });
});

describe('QA6 PR-063 — undo (D9)', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => { w = world(); });

  it('restores the assignee, the dates and the override flag', async () => {
    const out = await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 34, fromDay: N(2), toDay: N(3) });
    const res: any = await w.ctrl.undo(LEADER, out.reassignment.id, { view: VIEW });
    expect(res.result).toBe('undone');
    expect(res.task).toEqual({ id: 4021, assigneeIds: [12], estimatedStartDate: N(2), endDate: N(2), dueDateOverridden: false });
    expect(res.people.map((p: any) => p.id)).toEqual([12, 34]);
    expect(w.db.table('taskReassignment')[0].status).toBe('undone');
    expect(w.lines('reassign_undo')[0].description).toMatch(/^Undid moving CRD-040 Task CRD-040 from Daniel Huri to Yair Goldfryd; dates back to /);
    expect(w.events.emit).toHaveBeenCalledWith(REALTIME_INVALIDATE, { type: 'task.updated', projectId: 59, taskId: 4021 });
    // Twice: no.
    expect(codeOf(await err(w.ctrl.undo(LEADER, out.reassignment.id, {})))).toBe('UNDO_STALE');
  });

  it('keeps the participant role a move created', async () => {
    const out = await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 90, fromDay: N(2), toDay: N(2) });
    await w.ctrl.undo(LEADER, out.reassignment.id, {});
    expect(w.assignees(4021)).toEqual([12]);
    expect(w.db.table('projectPartnerRole').filter((r) => r.partyId === 1090 && r.status === 'active')).toHaveLength(1);
  });

  it('409 UNDO_STALE once the task changed; 409 after 15 minutes; 403 for someone else', async () => {
    const out = await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 34, fromDay: N(2), toDay: N(3) });
    expect(reasonOf(await err(w.ctrl.undo(DANA, out.reassignment.id, {})))).toBe('REASSIGN_NOT_ALLOWED');
    w.taskRow(4021).endDate = at(N(4)); // someone edited the task
    expect(codeOf(await err(w.ctrl.undo(LEADER, out.reassignment.id, {})))).toBe('UNDO_STALE');
    expect(w.assignees(4021)).toEqual([34]);

    const second = await w.move(LEADER, 4025, { fromUserId: 12, toUserId: 34, fromDay: N(3), toDay: N(3) });
    w.db.table('taskReassignment').find((r) => r.id === second.reassignment.id)!.createdAt = new Date(Date.now() - 16 * 60 * 1000);
    const expired = await err(w.ctrl.undo(LEADER, second.reassignment.id, {}));
    expect(codeOf(expired)).toBe('UNDO_STALE');
    expect(expired.getResponse().details).toEqual({ reason: 'UNDO_EXPIRED' });
    // An Admin may undo someone else's move (inside the window).
    const third = await w.move(LEADER, 4022, { fromUserId: 40, toUserId: 34, fromDay: N(0), toDay: N(0) });
    expect(((await w.ctrl.undo(ADMIN, third.reassignment.id, {})) as any).result).toBe('undone');
    expect(w.assignees(4022)).toEqual([12, 40]);
  });

  it('undo of a pending request cancels it; the approver hears; only the requester or an Admin may', async () => {
    const out = await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 71, fromDay: N(2), toDay: N(2) });
    expect(reasonOf(await err(w.ctrl.undo(IDO, out.reassignment.id, {})))).toBe('REASSIGN_NOT_ALLOWED');
    const res: any = await w.ctrl.undo(LEADER, out.reassignment.id, {});
    expect(res.result).toBe('cancelled');
    expect(res.task.assigneeIds).toEqual([12]);
    expect(w.db.table('taskReassignment')[0]).toMatchObject({ status: 'cancelled', pendingTaskId: null });
    expect(w.notes(70, 'reassign_result')[0].title).toBe('Cancelled: move of CRD-040 Task CRD-040');
    expect(w.lines('reassign_cancel')).toHaveLength(1);
    expect(codeOf(await err(w.ctrl.approve(IDO, out.reassignment.id, {})))).toBe('REASSIGN_NOT_PENDING');
  });

  it('approve of a request whose task changed meanwhile: 409 REASSIGN_STALE and the request becomes failed', async () => {
    const out = await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 71, fromDay: N(2), toDay: N(2) });
    w.db.table('taskAssignee').find((a) => a.taskId === 4021 && a.userId === 12)!.deletedAt = new Date();
    expect(codeOf(await err(w.ctrl.approve(IDO, out.reassignment.id, {})))).toBe('REASSIGN_STALE');
    expect(w.db.table('taskReassignment')[0]).toMatchObject({ status: 'failed', pendingTaskId: null, decidedById: 70 });
    expect(w.notes(9, 'reassign_result')[0].title).toBe('Could not move CRD-040 Task CRD-040');
    expect(w.assignees(4021)).toEqual([]);
  });
});

describe('QA6 PR-063 — GET /workload/tray and /workload/reassignments', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => { w = world(); });

  it('unassigned and overdue items of projects the caller can open; masked tasks never listed', async () => {
    const out = await w.tray(LEADER);
    expect(out.unassigned.items.map((t: any) => t.id)).toEqual([4023]);
    expect(out.unassigned.total).toBe(1);
    expect(out.unassigned.items[0]).toMatchObject({ code: 'CRD-042', assigneeIds: [], canDrag: true, overdue: false, pending: null });
    expect(out.overdue.items).toEqual([expect.objectContaining({ id: 4024, overdue: true, assigneeId: 12, assigneeName: 'Daniel Huri', canDrag: true })]);
    expect(out.assign.projects['59']).toMatchObject({ canManage: true });
    expect(JSON.stringify(out)).not.toMatch(/SEC-2|Secret/);
    // Admin sees the secret project's unassigned task too.
    const admin = await w.tray(ADMIN);
    expect(admin.unassigned.items.map((t: any) => t.id).sort()).toEqual([4023, 6102]);
    // A department manager: the tray chips are not his to drag.
    const dana = await w.tray(DANA);
    expect(dana.unassigned.items[0].canDrag).toBe(false);
  });

  it('approvals: pending requests the caller may decide; the list by role', async () => {
    const out = await w.move(LEADER, 4021, { fromUserId: 12, toUserId: 71, fromDay: N(2), toDay: N(3) });
    const ido = await w.tray(IDO);
    expect(ido.approvals).toEqual([
      expect.objectContaining({
        id: out.reassignment.id, status: 'pending',
        // D11: code, name, project and hours travel with the request.
        task: { id: 4021, code: 'CRD-040', name: 'Task CRD-040', projectId: 59, projectName: 'ניסוי 9', hours: 8 },
        from: { id: 12, name: 'Daniel Huri', orgUnitName: 'BIM management' },
        to: { id: 71, name: 'Noa Engineer', orgUnitName: 'Infrastructure' },
        fromDay: N(2), toDay: N(3), newEstimatedStartDate: N(3), newEndDate: N(3),
        requestedBy: { id: 9, name: 'Ofir Leader' }, approver: { id: 70, name: 'Ido Infra' }, decidedAt: null, decisionNote: null,
      }),
    ]);
    expect((await w.tray(DANA)).approvals).toEqual([]);
    expect(((await w.ctrl.list(IDO)) as any[]).map((r) => r.id)).toEqual([out.reassignment.id]);
    expect(((await w.ctrl.list(LEADER, undefined, 'requester')) as any[]).map((r) => r.id)).toEqual([out.reassignment.id]);
    expect(await w.ctrl.list(DANA)).toEqual([]);
    expect(((await w.ctrl.list(ADMIN, 'all')) as any[])).toHaveLength(1);
    await expect(w.ctrl.list(IDO, 'maybe')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'REASSIGN_LIST_INVALID' }) });
  });
});
