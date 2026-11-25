/**
 * QA6 package 1 (2026-11-25) — `POST /admin/backfills/qa6-assignees-to-team`.
 *
 * The real Qa6AssigneesToTeamService + ProjectPartnerRolesService +
 * ProjectAccessService over the in-memory Prisma.
 *
 * Project 58 (leader 104) and 59 (leader 104). Team of 58: 101
 * (participant); 110 has a legacy ProjectMember row on 58.
 *   • 105 employee, assigned to 4022 + 4023 (58), not on the Team → add, taskCount 2
 *   • 112 employee, assigned to his personal task 5901 linked to 59 → add
 *   • 107 external (userType partner) on 4022 → skipped EXTERNAL_CONTACT
 *   • 108 inactive on 4023 → skipped INACTIVE_USER
 *   • 109 deleted user on 4023 → skipped USER_DELETED
 *   • 101 (participant), 104 (leader), 110 (member) → on the Team, not listed
 *   • 111 removed assignment, 113 on a deleted task, 114 on a deleted
 *     project's task → not live, not listed
 */
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { MemoryDb, memoryPrisma, PLANWISE_RELATIONS } from '../../testing/memory-prisma';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { ProjectPartnerRolesService } from '../project-partner-roles/project-partner-roles.service';
import { BackfillsController } from './backfills.controller';
import { Qa6AssigneesToTeamService, parseQa6AssigneesToTeamBody } from './qa6-assignees-to-team.service';

const ACTIVE = { status: 'active', validFrom: new Date('2026-01-01'), validTo: new Date('9999-12-31') };

function seed() {
  const person = (id: number, extra: Record<string, any> = {}) => ({
    id, firstName: `First${id}`, lastName: `Last${id}`, email: `u${id}@amec.co.il`,
    businessPartnerId: 1000 + id, userType: 'employee', isActive: true, deletedAt: null, ...extra,
  });
  const task = (id: number, projectId: number | null, extra: Record<string, any> = {}) => ({
    id, projectId, name: `Task ${id}`, isPersonal: false, deletedAt: null, ...extra,
  });
  let n = 0;
  const assign = (taskId: number, userId: number, deletedAt: Date | null = null) => ({ id: ++n, taskId, userId, deletedAt });
  return {
    user: [
      person(101), person(104), person(105), person(107, { userType: 'partner' }), person(108, { isActive: false }),
      person(109, { deletedAt: new Date('2026-11-01') }), person(110), person(111), person(112), person(113), person(114),
    ],
    businessPartner: [101, 104, 105, 107, 108, 109, 110, 111, 112, 113, 114].map((u) => ({
      id: 1000 + u, partnerType: 'person', displayName: `BP ${u}`, deletedAt: null,
    })),
    projectRoleType: [{ id: 1, code: 'participant', name: 'Participant' }],
    project: [
      { id: 58, name: 'ניסוי 8', leaderId: 104, createdBy: 104, deletedAt: null },
      { id: 59, name: 'ניסוי 9', leaderId: 104, createdBy: 104, deletedAt: null },
      { id: 60, name: 'Deleted', leaderId: 104, createdBy: 104, deletedAt: new Date('2026-10-01') },
    ],
    projectMember: [{ id: 1, projectId: 58, userId: 110 }],
    projectPartnerRole: [{ id: 1, projectId: 58, partyId: 1101, roleId: 1, ...ACTIVE }],
    task: [
      task(4021, 58), task(4022, 58), task(4023, 58), task(4024, 58, { deletedAt: new Date('2026-11-02') }),
      task(5901, 59, { isPersonal: true, createdBy: 112 }), task(6001, 60),
    ],
    taskAssignee: [
      assign(4021, 101), assign(4021, 104), assign(4021, 110),
      assign(4022, 105), assign(4023, 105),
      assign(4022, 107), assign(4023, 108), assign(4023, 109),
      assign(4022, 111, new Date('2026-11-03')),
      assign(4024, 113),
      assign(6001, 114),
      assign(5901, 112),
    ],
  };
}

function world() {
  const db = new MemoryDb(PLANWISE_RELATIONS, seed());
  const prisma = memoryPrisma(db);
  const activityLog: any = { logProjectMemberAdded: jest.fn() };
  const svc = new Qa6AssigneesToTeamService(prisma, new ProjectPartnerRolesService(prisma, activityLog), activityLog);
  return { db, prisma, svc, activityLog, access: new ProjectAccessService(prisma) };
}

const pairs = (rows: Array<{ projectId: number; userId: number }>) => rows.map((r) => `${r.projectId}:${r.userId}`);

describe('QA6 P1 — qa6-assignees-to-team backfill', () => {
  it('dry-run lists who would be added and who is skipped, and writes nothing', async () => {
    const w = world();
    const before = JSON.stringify(w.db.tables);
    const res = await w.svc.run({ dryRun: true, actorId: 1 });

    expect(res.dryRun).toBe(true);
    expect(res.toAdd).toEqual([
      { projectId: 58, projectName: 'ניסוי 8', userId: 105, userName: 'First105 Last105', taskCount: 2 },
      { projectId: 59, projectName: 'ניסוי 9', userId: 112, userName: 'First112 Last112', taskCount: 1 },
    ]);
    expect(res.skipped.map((s) => [s.userId, s.reason])).toEqual([
      [107, 'EXTERNAL_CONTACT'],
      [108, 'INACTIVE_USER'],
      [109, 'USER_DELETED'],
    ]);
    expect(res.totals).toEqual({ toAdd: 2, skipped: 3, projects: 2 });
    expect(res.rolesWritten).toBe(0);
    expect(JSON.stringify(w.db.tables)).toBe(before);
    expect(w.activityLog.logProjectMemberAdded).not.toHaveBeenCalled();
  });

  it('the real run creates the participant roles (and only those); they are on the Team after', async () => {
    const w = world();
    const res = await w.svc.run({ dryRun: false, actorId: 1 });
    expect(res.rolesWritten).toBe(2);
    expect(pairs(res.toAdd)).toEqual(['58:105', '59:112']);

    const created = w.db.table('projectPartnerRole').filter((r) => r.id !== 1);
    expect(created.map((r) => [r.projectId, r.partyId, r.roleId, r.status])).toEqual([
      [58, 1105, 1, 'active'],
      [59, 1112, 1, 'active'],
    ]);
    await expect(w.access.isOnProjectTeam(105, 58)).resolves.toBe(true);
    await expect(w.access.assertTaskAccess(112, 5901, false)).resolves.toBe(59);
    // Skipped people got nothing.
    for (const uid of [107, 108, 109]) await expect(w.access.isOnProjectTeam(uid, 58)).resolves.toBe(false);
    expect(w.activityLog.logProjectMemberAdded).toHaveBeenCalledTimes(2);
  });

  it('a second run finds nothing to add and writes nothing (idempotent)', async () => {
    const w = world();
    await w.svc.run({ dryRun: false });
    const rolesAfterFirst = w.db.table('projectPartnerRole').length;
    const again = await w.svc.run({ dryRun: false });
    expect(again.toAdd).toEqual([]);
    expect(again.rolesWritten).toBe(0);
    expect(again.totals.toAdd).toBe(0);
    expect(w.db.table('projectPartnerRole')).toHaveLength(rolesAfterFirst);
  });

  it('an ended participant role is re-activated, not duplicated', async () => {
    const w = world();
    w.db.table('projectPartnerRole').push({
      id: 50, projectId: 58, partyId: 1105, roleId: 1, status: 'ended', validFrom: new Date('2026-01-01'), validTo: new Date('2026-06-01'),
    });
    const dry = await w.svc.run({ dryRun: true });
    expect(pairs(dry.toAdd)).toContain('58:105');
    await w.svc.run({ dryRun: false });
    const rows = w.db.table('projectPartnerRole').filter((r) => r.partyId === 1105);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 50, status: 'active' });
  });
});

describe('QA6 P1 — backfill endpoint contract', () => {
  it.each([
    [undefined, true],
    [{}, true],
    [{ dryRun: true }, true],
    [{ dryRun: 'false' }, true],
    [{ dryRun: 0 }, true],
    [{ dryRun: false }, false],
  ])('body %j → dryRun %p (only the boolean false writes)', (body, dryRun) => {
    expect(parseQa6AssigneesToTeamBody(body)).toEqual({ dryRun });
  });

  it('POST /admin/backfills/qa6-assignees-to-team needs admin:write and passes the actor', async () => {
    const meta = Reflect.getMetadata(ROLES_KEY, BackfillsController.prototype.runQa6AssigneesToTeam);
    expect(meta).toEqual([{ module: 'admin', action: 'write' }]);
    const run = jest.fn(async () => ({ dryRun: true }));
    const ctrl = new BackfillsController({} as never, {} as never, {} as never, {} as never, { run } as never);
    await ctrl.runQa6AssigneesToTeam({ id: 1 }, undefined);
    expect(run).toHaveBeenCalledWith({ dryRun: true, actorId: 1 });
    await ctrl.runQa6AssigneesToTeam({ id: 1 }, { dryRun: false });
    expect(run).toHaveBeenLastCalledWith({ dryRun: false, actorId: 1 });
  });
});
