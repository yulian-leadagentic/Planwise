/**
 * Permissions round 4 (review fix) — a partner's project rows must not
 * list projects the caller has no access to:
 *   • `projectPartnerRoles` on GET /business-partners, GET /:id, PATCH /:id
 *     and GET /lookups/customer-orgs is cut to getAccessibleProjectIds;
 *   • the `withProjects` list column (direct roles + "customer contact"
 *     through the employer) only counts and lists those projects;
 *   • an Admin sees everything;
 *   • GET /admin/project-role-types/:code/eligible-parties?projectId=
 *     reveals that project's team, so it needs project access.
 */
import { NotFoundException } from '@nestjs/common';

import { BusinessPartnersService, PartnerProjectScope } from './business-partners.service';
import { BusinessPartnersController } from './business-partners.controller';
import { LookupsController } from '../lookups/lookups.controller';
import { ProjectRoleTypesController } from '../project-role-types/project-role-types.controller';
import { PermissionDeniedException } from '../../common/errors/permission-denied';

const MEMBER_59: PartnerProjectScope = { all: false, projectIds: [59] };
const ALL: PartnerProjectScope = { all: true, projectIds: [] };

const role = (id: number, projectId: number, partyId = 1, roleCode = 'designer') => ({
  id,
  partyId,
  projectId,
  roleId: roleCode === 'customer' ? 2 : 1,
  role: { code: roleCode, name: roleCode },
  project: { id: projectId, name: `P${projectId}`, number: null, status: 'active', deletedAt: null },
});

/** Person 1 holds roles on projects 59 and 60 and works for org 50, the customer of 59 and 61. */
function makeService() {
  const person = {
    id: 1,
    partnerType: 'person',
    displayName: 'Dana',
    email: 'dana@x.com',
    user: null,
    partnerRelationshipsA: [{ partyBId: 50, type: { code: 'worker_of' } }],
    projectPartnerRoles: [role(1, 59), role(2, 60)],
  };
  const allRoles = [role(1, 59), role(2, 60), role(3, 59, 50, 'customer'), role(4, 61, 50, 'customer')];
  const inScope = (where: any) => (r: any) =>
    (where.partyId?.in ?? [r.partyId]).includes(r.partyId) &&
    (where.roleId == null || r.roleId === where.roleId) &&
    (where.projectId?.in == null || where.projectId.in.includes(r.projectId));
  const prisma: any = {
    businessPartner: {
      findFirst: jest.fn(async () => ({ ...person })),
      findMany: jest.fn(async () => [{ ...person }]),
      count: jest.fn(async () => 1),
    },
    partnerRelationship: { findMany: jest.fn(async () => []) },
    partnerRelationshipType: { findUnique: jest.fn(async () => null) },
    projectRoleType: { findUnique: jest.fn(async () => ({ id: 2 })) },
    projectPartnerRole: {
      findMany: jest.fn(async ({ where }: any) => allRoles.filter(inScope(where))),
    },
  };
  const service = new BusinessPartnersService(prisma, { write: jest.fn() } as any);
  jest.spyOn(service, 'getHomeOrg').mockResolvedValue(null as any);
  return { service, prisma };
}

describe('BusinessPartnersService — project rows cut to the caller\'s projects', () => {
  it('findOne keeps only the roles on projects the caller can access', async () => {
    const { service } = makeService();
    const bp: any = await service.findOne(1, MEMBER_59);
    expect(bp.projectPartnerRoles.map((r: any) => r.projectId)).toEqual([59]);
  });

  it('an Admin (all) sees every role', async () => {
    const { service } = makeService();
    const bp: any = await service.findOne(1, ALL);
    expect(bp.projectPartnerRoles.map((r: any) => r.projectId)).toEqual([59, 60]);
  });

  it('a caller on no project sees no project rows', async () => {
    const { service } = makeService();
    const bp: any = await service.findOne(1, { all: false, projectIds: [] });
    expect(bp.projectPartnerRoles).toEqual([]);
  });

  it('the list cuts projectPartnerRoles and the withProjects column (direct + employer) to the scope', async () => {
    const { service, prisma } = makeService();
    const out: any = await service.findAll({ withProjects: true } as any, MEMBER_59);
    const row = out.data[0];
    expect(row.projectPartnerRoles.map((r: any) => r.projectId)).toEqual([59]);
    // Project 60 (direct role) and 61 (employer is customer) are outside the scope.
    expect(row.projects.map((p: any) => p.id)).toEqual([59]);
    expect(row.projectCount).toEqual({ active: 1, archived: 0 });
    for (const [args] of prisma.projectPartnerRole.findMany.mock.calls) {
      expect(args.where.projectId).toEqual({ in: [59] });
    }
  });

  it('the list for an Admin is unchanged', async () => {
    const { service, prisma } = makeService();
    const out: any = await service.findAll({ withProjects: true } as any, ALL);
    expect(out.data[0].projects.map((p: any) => p.id).sort()).toEqual([59, 60, 61]);
    for (const [args] of prisma.projectPartnerRole.findMany.mock.calls) {
      expect(args.where).not.toHaveProperty('projectId');
    }
  });
});

describe('Controllers pass the caller\'s project scope', () => {
  const USER = { id: 4, isAdmin: false, roleModules: [] };
  const access: any = { getAccessibleProjectIds: jest.fn(async () => MEMBER_59) };

  it('GET /business-partners, GET /:id and PATCH /:id', async () => {
    const service: any = {
      findAll: jest.fn(async () => ({ data: [] })),
      findOne: jest.fn(async () => ({ id: 1 })),
      update: jest.fn(async () => ({ id: 1 })),
    };
    const ctrl = new BusinessPartnersController(service, access);
    await ctrl.findAll(USER, {} as any);
    await ctrl.findOne(USER, 1);
    await ctrl.update(USER, 1, { notes: 'x' } as any);
    expect(access.getAccessibleProjectIds).toHaveBeenCalledWith(4, false);
    expect(service.findAll).toHaveBeenCalledWith({}, MEMBER_59);
    expect(service.findOne).toHaveBeenCalledWith(1, MEMBER_59);
    expect(service.update).toHaveBeenCalledWith(1, { notes: 'x' }, 4, MEMBER_59);
  });

  it('GET /lookups/customer-orgs', async () => {
    const partners: any = { findAll: jest.fn(async () => ({ data: [] })) };
    const ctrl = new LookupsController({} as any, partners, {} as any, access);
    await ctrl.listCustomerOrgs(USER);
    expect(partners.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ partnerType: 'organization', roleType: 'customer' }),
      MEMBER_59,
    );
  });
});

describe('GET /admin/project-role-types/:code/eligible-parties — projectId needs access', () => {
  function make() {
    const prisma: any = {
      projectRoleType: {
        findUnique: jest.fn(async () => ({
          id: 1,
          code: 'designer',
          name: 'Designer',
          allowedPartnerKind: 'person',
          requiredPartnerRoleCode: null,
          requiredProfessionIds: [],
        })),
      },
      projectPartnerRole: { findMany: jest.fn(async () => [{ partyId: 3 }]) },
      businessPartner: { findMany: jest.fn(async () => []) },
      profession: { findMany: jest.fn(async () => []) },
    };
    const access: any = {
      assertProjectAccess: jest.fn(async (userId: number, projectId: number, isAdmin: boolean) => {
        if (projectId === 404) throw new NotFoundException('Project not found');
        if (isAdmin || (userId === 4 && projectId === 59)) return;
        throw new PermissionDeniedException("You're not a member of this project.", {
          module: 'projects',
          reason: 'NOT_PROJECT_MEMBER',
        });
      }),
    };
    return { ctrl: new ProjectRoleTypesController(prisma, access), prisma, access };
  }
  const MEMBER = { id: 4, isAdmin: false, roleModules: [] };
  const STRANGER = { id: 9, isAdmin: false, roleModules: [] };

  it('a stranger to the project → 403 NOT_PROJECT_MEMBER; the team is not read', async () => {
    const { ctrl, prisma } = make();
    const err = await ctrl.eligibleParties(STRANGER, 'designer', { projectId: '60' }).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(err.details.reason).toBe('NOT_PROJECT_MEMBER');
    expect(prisma.projectPartnerRole.findMany).not.toHaveBeenCalled();
  });

  it('a project member gets the list with the team excluded', async () => {
    const { ctrl, prisma, access } = make();
    await ctrl.eligibleParties(MEMBER, 'designer', { projectId: '59' });
    expect(access.assertProjectAccess).toHaveBeenCalledWith(4, 59, false);
    expect(prisma.businessPartner.findMany.mock.calls[0][0].where.id).toEqual({ notIn: [3] });
  });

  it('without a projectId (New Project form) there is no project check', async () => {
    const { ctrl, access } = make();
    await ctrl.eligibleParties(STRANGER, 'designer', {});
    expect(access.assertProjectAccess).not.toHaveBeenCalled();
  });
});
