/**
 * QA6 decision 2 (26.11) — "ask the project manager to add me".
 *
 * Integration-style over the in-memory Prisma: the REAL
 * ProjectsController → ProjectAccessService → ProjectTeamRequestsService
 * → NotificationsService / ActivityLogService.
 *
 * Project 58 (unit 30): leader 104, Team member 101 (participant role).
 * 109 sees it only through his org unit (rule 6), 110 only through his
 * manager chain (rule 7: he manages unit 21, home of 101). 105 has no
 * access. 107 is an external contact holding a role on the project.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerGuard, ThrottlerStorageService } from '@nestjs/throttler';

import { MemoryDb, memoryPrisma, PLANWISE_RELATIONS } from '../../testing/memory-prisma';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { APP_THROTTLE } from '../../common/guards/per-user-throttle';
import { NotificationsService } from '../notifications/notifications.service';
import { ProjectsController } from './projects.controller';
import {
  ProjectTeamRequestsService,
  TEAM_JOIN_REQUEST_ACTION,
  TEAM_JOIN_REQUEST_LIMIT,
} from './project-team-requests.service';

const grant = (route: string) => ({ module: { route: `/${route}`, name: route }, canRead: true, canWrite: true, canDelete: true });
const MODULES = ['projects', 'tasks'].map(grant);
const as = (id: number, extra: Record<string, any> = {}) => ({ id, roleId: 6, isAdmin: false, roleModules: MODULES, ...extra });

const ORG_VIEWER = as(109);
const CHAIN_MANAGER = as(110);
const TEAM_MEMBER = as(101);
const LEADER = as(104);
const OUTSIDER = as(105);
const EXTERNAL = as(107);
const ADMIN = { id: 1, roleId: 1, isAdmin: true, roleModules: [] as any[] };

const ACTIVE = { status: 'active', validFrom: new Date('2026-01-01'), validTo: new Date('9999-12-31') };
const HOUR = 60 * 60 * 1000;

function seed() {
  const person = (id: number, extra: Record<string, any> = {}) => ({
    id, firstName: `First${id}`, lastName: `Last${id}`, email: `u${id}@amec.co.il`, roleId: 6, orgUnitId: 21,
    businessPartnerId: 1000 + id, userType: 'employee', isActive: true, deletedAt: null, ...extra,
  });
  return {
    user: [
      person(1, { roleId: 1, orgUnitId: null }),
      person(101),
      person(102, { orgUnitId: 30, isActive: false }),
      person(104, { orgUnitId: 40 }),
      person(105, { orgUnitId: 50 }),
      person(107, { userType: 'partner', email: 'arch@outside.com', orgUnitId: null }),
      person(109, { orgUnitId: 30 }),
      person(110, { orgUnitId: 20 }),
    ],
    businessPartner: [1101, 1107].map((id) => ({ id, partnerType: 'person', displayName: `BP ${id}`, deletedAt: null })),
    orgUnit: [
      { id: 20, name: 'BIM', path: '/1/20/' },
      { id: 21, name: 'BIM team', path: '/1/20/21/', managerUserId: 110 },
      { id: 30, name: 'Infra', path: '/1/30/' },
    ],
    project: [{ id: 58, name: 'ניסוי 8', leaderId: 104, createdBy: 104, orgUnitId: 30, deletedAt: null }],
    projectMember: [] as any[],
    projectPartnerRole: [
      { id: 1, projectId: 58, partyId: 1101, roleId: 1, ...ACTIVE },
      { id: 3, projectId: 58, partyId: 1107, roleId: 3, ...ACTIVE },
    ],
    notification: [] as any[],
    activityLog: [] as any[],
  };
}

function world() {
  const db = new MemoryDb(PLANWISE_RELATIONS, seed());
  const prisma = memoryPrisma(db);
  const access = new ProjectAccessService(prisma);
  const emitter = { emit: jest.fn() };
  const notifications = new NotificationsService(prisma, emitter as any);
  const activityLog = new ActivityLogService(prisma);
  const service = new ProjectTeamRequestsService(prisma, access, notifications, activityLog);
  const projectsService: any = { findOne: jest.fn(async (id: number) => ({ id })) };
  const ctrl = new ProjectsController(projectsService, access, service);
  const notificationsTo = (userId: number) => db.table('notification').filter((n) => n.userId === userId);
  const requests = () => db.table('activityLog').filter((r) => r.action === TEAM_JOIN_REQUEST_ACTION);
  return { db, access, service, ctrl, emitter, notificationsTo, requests };
}

const reasonOf = (e: any) => e?.getResponse?.()?.details?.reason;
const codeOf = (e: any) => e?.getResponse?.()?.code;

describe('QA6 decision 2 — GET /projects/:id tells the web whether the viewer is on the Team', () => {
  it('isOnTeam: Team member and leader yes; org-unit viewer, chain manager and Admin no', async () => {
    const w = world();
    await expect(w.ctrl.findOne(TEAM_MEMBER, 58)).resolves.toMatchObject({ canManage: false, isOnTeam: true });
    await expect(w.ctrl.findOne(LEADER, 58)).resolves.toMatchObject({ canManage: true, isOnTeam: true });
    await expect(w.ctrl.findOne(ORG_VIEWER, 58)).resolves.toMatchObject({ canManage: false, isOnTeam: false });
    await expect(w.ctrl.findOne(CHAIN_MANAGER, 58)).resolves.toMatchObject({ canManage: false, isOnTeam: false });
    await expect(w.ctrl.findOne(ADMIN, 58)).resolves.toMatchObject({ canManage: true, isOnTeam: false });
  });

  it('teamRequestedAt: the caller\'s own request of the last 24 hours, else null', async () => {
    const w = world();
    await expect(w.ctrl.findOne(ORG_VIEWER, 58)).resolves.toMatchObject({ teamRequestedAt: null });

    await w.ctrl.requestToJoinTeam(ORG_VIEWER, 58);
    const at = w.requests()[0].createdAt.toISOString();
    await expect(w.ctrl.findOne(ORG_VIEWER, 58)).resolves.toMatchObject({ isOnTeam: false, teamRequestedAt: at });
    // Someone else's request is not his.
    await expect(w.ctrl.findOne(CHAIN_MANAGER, 58)).resolves.toMatchObject({ teamRequestedAt: null });

    // 23 hours later it still counts; after 24 hours it is gone.
    w.requests()[0].createdAt = new Date(Date.now() - 23 * HOUR);
    await expect(w.ctrl.findOne(ORG_VIEWER, 58)).resolves.toMatchObject({
      teamRequestedAt: w.requests()[0].createdAt.toISOString(),
    });
    w.requests()[0].createdAt = new Date(Date.now() - 25 * HOUR);
    await expect(w.ctrl.findOne(ORG_VIEWER, 58)).resolves.toMatchObject({ teamRequestedAt: null });
  });
});

describe('QA6 decision 2 — POST /projects/:id/team-requests', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
  });

  it('an org-unit viewer asks: the leader gets one in-app notification that opens the Team tab, and the Activity Log records it', async () => {
    const out = await w.ctrl.requestToJoinTeam(ORG_VIEWER, 58);

    expect(out).toEqual({ alreadyRequested: false, requestedAt: expect.any(String) });
    const told = w.notificationsTo(104);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      type: 'team_join_request',
      title: 'First109 Last109 asked to join the team of ניסוי 8',
      entityType: 'project',
      entityId: 58,
      actorId: 109,
      data: { projectId: 58, requesterId: 109, link: '/projects/58?projectTab=team' },
    });
    expect(w.emitter.emit).toHaveBeenCalledWith('notification.created', expect.objectContaining({ userId: 104 }));
    expect(w.db.table('notification')).toHaveLength(1); // nobody else

    expect(w.requests()).toEqual([
      expect.objectContaining({
        category: 'project',
        projectId: 58,
        userId: 109,
        entityType: 'project_member',
        entityId: 109,
        entityName: 'First109 Last109',
        metadata: { notifiedUserId: 104 },
      }),
    ]);
    // Asking adds nobody to the Team.
    await expect(w.access.isOnProjectTeam(109, 58)).resolves.toBe(false);
  });

  it('a manager-chain viewer can ask too', async () => {
    await expect(w.ctrl.requestToJoinTeam(CHAIN_MANAGER, 58)).resolves.toMatchObject({ alreadyRequested: false });
    expect(w.notificationsTo(104)).toHaveLength(1);
  });

  it('idempotent for 24 hours: a repeat notifies nobody and says alreadyRequested, with the first request time', async () => {
    const first = await w.ctrl.requestToJoinTeam(ORG_VIEWER, 58);
    const again = await w.ctrl.requestToJoinTeam(ORG_VIEWER, 58);

    expect(again).toEqual({ alreadyRequested: true, requestedAt: w.requests()[0].createdAt.toISOString() });
    expect(new Date(again.requestedAt).getTime()).toBeLessThanOrEqual(new Date(first.requestedAt).getTime() + 1000);
    expect(w.notificationsTo(104)).toHaveLength(1);
    expect(w.requests()).toHaveLength(1);

    // Another person's request is his own.
    await expect(w.ctrl.requestToJoinTeam(CHAIN_MANAGER, 58)).resolves.toMatchObject({ alreadyRequested: false });
    expect(w.notificationsTo(104)).toHaveLength(2);
  });

  it('after 24 hours he may ask again', async () => {
    await w.ctrl.requestToJoinTeam(ORG_VIEWER, 58);
    w.requests()[0].createdAt = new Date(Date.now() - 25 * HOUR);

    await expect(w.ctrl.requestToJoinTeam(ORG_VIEWER, 58)).resolves.toMatchObject({ alreadyRequested: false });
    expect(w.notificationsTo(104)).toHaveLength(2);
    expect(w.requests()).toHaveLength(2);

    // 23 hours is still inside the window.
    w.requests()[1].createdAt = new Date(Date.now() - 23 * HOUR);
    await expect(w.ctrl.requestToJoinTeam(ORG_VIEWER, 58)).resolves.toMatchObject({ alreadyRequested: true });
  });

  it('already on the Team: 409 ALREADY_ON_TEAM, nothing sent', async () => {
    const err = await w.ctrl.requestToJoinTeam(TEAM_MEMBER, 58).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(codeOf(err)).toBe('ALREADY_ON_TEAM');
    expect(w.db.table('notification')).toHaveLength(0);
    expect(w.requests()).toHaveLength(0);
  });

  it('the leader and an Admin (assertProjectManage) add themselves: 409 CAN_MANAGE_PROJECT with a plain message, nothing sent', async () => {
    for (const me of [LEADER, ADMIN]) {
      const err = await w.ctrl.requestToJoinTeam(me, 58).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(codeOf(err)).toBe('CAN_MANAGE_PROJECT');
      expect(err.getResponse().message).toBe(
        "You can add yourself to this project's team directly in the Team tab, so there is no one to ask.",
      );
    }
    // An Admin is refused although he is not on the Team.
    await expect(w.access.isOnProjectTeam(ADMIN.id, 58)).resolves.toBe(false);
    expect(w.db.table('notification')).toHaveLength(0);
    expect(w.requests()).toHaveLength(0);
  });

  it('no project access: 403 NOT_PROJECT_MEMBER; a missing project: 404', async () => {
    const err = await w.ctrl.requestToJoinTeam(OUTSIDER, 58).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(reasonOf(err)).toBe('NOT_PROJECT_MEMBER');
    await expect(w.ctrl.requestToJoinTeam(ORG_VIEWER, 999)).rejects.toBeInstanceOf(NotFoundException);
    expect(w.db.table('notification')).toHaveLength(0);
  });

  it('an external contact cannot ask (403 TEAM_REQUEST_NOT_EMPLOYEE)', async () => {
    const err = await w.ctrl.requestToJoinTeam(EXTERNAL, 58).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(reasonOf(err)).toBe('TEAM_REQUEST_NOT_EMPLOYEE');
    expect(w.db.table('notification')).toHaveLength(0);
  });

  it('review 2 (A7): parallel requests of the same person notify the leader once; another person is not held back', async () => {
    const out = await Promise.all([1, 2, 3].map(() => w.ctrl.requestToJoinTeam(ORG_VIEWER, 58)));
    expect(out.filter((r) => !r.alreadyRequested)).toHaveLength(1);
    expect(out.filter((r) => r.alreadyRequested)).toHaveLength(2);
    expect(w.notificationsTo(104)).toHaveLength(1);
    expect(w.requests()).toHaveLength(1);

    const both = await Promise.all([w.ctrl.requestToJoinTeam(ORG_VIEWER, 58), w.ctrl.requestToJoinTeam(CHAIN_MANAGER, 58)]);
    expect(both.map((r) => r.alreadyRequested)).toEqual([true, false]);
    expect(w.notificationsTo(104)).toHaveLength(2);
  });

  it('review 2 (A7): a failed request does not block the next one of the same person', async () => {
    const notifications = (w.service as any).notifications;
    const create = notifications.create;
    notifications.create = async () => {
      throw new Error('notifications down');
    };
    await expect(w.ctrl.requestToJoinTeam(ORG_VIEWER, 58)).rejects.toThrow('notifications down');
    notifications.create = create;
    await expect(w.ctrl.requestToJoinTeam(ORG_VIEWER, 58)).resolves.toMatchObject({ alreadyRequested: false });
    expect(w.notificationsTo(104)).toHaveLength(1);
  });

  it('no leader (or an inactive one): the creator is asked; nobody to ask: 409 NO_PROJECT_MANAGER', async () => {
    const project = w.db.table('project')[0];
    project.leaderId = null;
    await w.ctrl.requestToJoinTeam(ORG_VIEWER, 58);
    expect(w.notificationsTo(104)).toHaveLength(1);

    project.leaderId = 102; // inactive
    await w.ctrl.requestToJoinTeam(CHAIN_MANAGER, 58);
    expect(w.notificationsTo(102)).toHaveLength(0);
    expect(w.notificationsTo(104)).toHaveLength(2);

    w.db.table('user').find((u) => u.id === 104)!.isActive = false;
    w.db.table('activityLog').splice(0); // a fresh request, outside any 24-hour window
    const err = await w.ctrl.requestToJoinTeam(ORG_VIEWER, 58).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(codeOf(err)).toBe('NO_PROJECT_MANAGER');
  });
});

describe('review 2 (A7): POST /projects/:id/team-requests is throttled per user', () => {
  const handler = ProjectsController.prototype.requestToJoinTeam;
  let storage: ThrottlerStorageService;
  let guard: ThrottlerGuard;
  beforeEach(async () => {
    storage = new ThrottlerStorageService();
    // The app's guard: the module options of app.module, the route's metadata.
    guard = new ThrottlerGuard([{ ttl: APP_THROTTLE.ttl, limit: APP_THROTTLE.limit }], storage, new Reflector());
    await guard.onModuleInit();
  });
  afterEach(() => storage.onApplicationShutdown());
  /** A request from one IP (behind the proxy, everybody's). `user` is set once JwtAuthGuard ran. */
  const ctx = (user: any) => {
    const req = { user, ip: '10.0.0.1', headers: {} };
    const res = { header: jest.fn() };
    return {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getHandler: () => handler,
      getClass: () => ProjectsController,
    } as any;
  };

  it('the route runs its own ThrottlerGuard, after the controller JwtAuthGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ProjectsController)).toEqual(expect.arrayContaining([JwtAuthGuard]));
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([ThrottlerGuard]);
  });

  it(`${TEAM_JOIN_REQUEST_LIMIT} a minute per signed-in user: the next one is 429; another user on the same IP has his own`, async () => {
    expect(TEAM_JOIN_REQUEST_LIMIT).toBe(3);
    for (let i = 0; i < TEAM_JOIN_REQUEST_LIMIT; i++) await expect(guard.canActivate(ctx(ORG_VIEWER))).resolves.toBe(true);
    const e = await guard.canActivate(ctx(ORG_VIEWER)).catch((x) => x);
    expect(e).toBeInstanceOf(ThrottlerException);
    expect(e.getStatus()).toBe(429);
    await expect(guard.canActivate(ctx(CHAIN_MANAGER))).resolves.toBe(true);
  });

  it('the app-wide pass (before JwtAuthGuard, no user yet) keeps the app-wide limit, so one IP is not held to 3', async () => {
    for (let i = 0; i < 10; i++) await expect(guard.canActivate(ctx(undefined))).resolves.toBe(true);
    // ... and it does not count against a user.
    await expect(guard.canActivate(ctx(ORG_VIEWER))).resolves.toBe(true);
  });
});
