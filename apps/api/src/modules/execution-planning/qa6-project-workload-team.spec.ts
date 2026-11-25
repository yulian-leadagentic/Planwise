/**
 * QA6 security review (2026-11-25) — the project workload panel
 * (GET /projects/:id/workload) lists the project's whole Team, not only
 * ProjectMember rows: the leader, every member and every active
 * partner-role holder (participant included) who is an active internal
 * employee. Since D1 and QA6 people join a Team through a role, so a
 * participant added by the leader was missing from the panel.
 *
 * Real ExecutionPlanningService over the in-memory Prisma.
 */
import { MemoryDb, memoryPrisma, PLANWISE_RELATIONS } from '../../testing/memory-prisma';
import { ExecutionPlanningService } from './execution-planning.service';

const ACTIVE = { status: 'active', validFrom: new Date('2026-01-01'), validTo: new Date('9999-12-31') };

function seed() {
  const person = (id: number, extra: Record<string, any> = {}) => ({
    id, firstName: `F${id}`, lastName: `L${id}`, position: 'Modeler', dailyStandardHours: 8,
    businessPartnerId: 1000 + id, userType: 'employee', isActive: true, deletedAt: null, ...extra,
  });
  return {
    user: [
      person(104), // leader
      person(110), // ProjectMember row
      person(101), // participant role
      person(102), // bim_leader role
      person(107, { userType: 'partner' }), // external contact with a role
      person(108, { isActive: false }), // inactive, participant role
      person(109), // participant role that ended
      person(111), // participant on ANOTHER project
    ],
    businessPartner: [1101, 1102, 1107, 1108, 1109, 1111].map((id) => ({ id, partnerType: 'person', displayName: `BP ${id}`, deletedAt: null })),
    projectRoleType: [
      { id: 1, code: 'participant', name: 'Participant' },
      { id: 2, code: 'bim_leader', name: 'BIM Leader' },
      { id: 3, code: 'architect', name: 'Architect' },
    ],
    project: [
      { id: 58, name: 'P58', leaderId: 104, createdBy: 104, deletedAt: null },
      { id: 59, name: 'P59', leaderId: 104, createdBy: 104, deletedAt: null },
    ],
    projectMember: [{ id: 1, projectId: 58, userId: 110, role: 'Modeler' }],
    projectPartnerRole: [
      { id: 1, projectId: 58, partyId: 1101, roleId: 1, isPrimary: false, createdAt: new Date('2026-02-01'), ...ACTIVE },
      { id: 2, projectId: 58, partyId: 1102, roleId: 2, isPrimary: true, createdAt: new Date('2026-02-02'), ...ACTIVE },
      { id: 3, projectId: 58, partyId: 1107, roleId: 3, isPrimary: false, createdAt: new Date('2026-02-03'), ...ACTIVE },
      { id: 4, projectId: 58, partyId: 1108, roleId: 1, isPrimary: false, createdAt: new Date('2026-02-04'), ...ACTIVE },
      { id: 5, projectId: 58, partyId: 1109, roleId: 1, isPrimary: false, createdAt: new Date('2026-02-05'), ...ACTIVE, status: 'ended', validTo: new Date('2026-06-01') },
      { id: 6, projectId: 59, partyId: 1111, roleId: 1, isPrimary: false, createdAt: new Date('2026-02-06'), ...ACTIVE },
      // The bim_leader also holds participant: one row, both names.
      { id: 7, projectId: 58, partyId: 1102, roleId: 1, isPrimary: false, createdAt: new Date('2026-02-07'), ...ACTIVE },
    ],
  };
}

describe('QA6 · project workload panel = the whole Team', () => {
  it('leader, members and active internal partner-role holders (participant included); no externals, inactive or ended', async () => {
    const prisma = memoryPrisma(new MemoryDb(PLANWISE_RELATIONS, seed()));
    const svc = new ExecutionPlanningService(prisma, {} as any);
    const out: any = await svc.getProjectWorkload(58, '2026-11-22', '2026-11-26', 'all');

    expect(out.members.map((m: any) => [m.user.id, m.role])).toEqual([
      [104, 'Project Leader'],
      [110, 'Modeler'],
      [102, 'BIM Leader / Participant'],
      [101, 'Participant'],
    ]);
    expect(out.members[0].user).toEqual({ id: 104, firstName: 'F104', lastName: 'L104', position: 'Modeler' });
    // Each row carries the workload as before.
    expect(out.members[0].workload.summary.totalCapacity).toBe(40);
  });
});
