/**
 * QA6 BM2-4 — organization-first picking for external project roles.
 *
 * GET /admin/project-role-types/:code/eligible-parties gains two
 * optional params:
 *   • excludeInternal=true → no AMEC (home org, its worker_of people,
 *     D1 employees);
 *   • organizationId=<id|none> → only that org + its active workers, or
 *     only people with no employer.
 * Person rows carry `employers`. The Round 4 project-access check on
 * `projectId` is unchanged.
 */
import { BadRequestException } from '@nestjs/common';

import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { ProjectRoleTypesController } from './project-role-types.controller';
import {
  isInternalParty,
  parseOrganizationFilter,
  parseQueryFlag,
} from './internal-party';

const HOME_ID = 1;
const ACME_ID = 50;

const engineerRole = {
  id: 7,
  code: 'engineer',
  name: 'Engineer',
  allowedPartnerKind: 'any',
  requiredPartnerRoleCode: null,
  requiredProfessionIds: null,
};

const org = (id: number, displayName: string) => ({
  id,
  partnerType: 'organization',
  displayName,
  firstName: null,
  lastName: null,
  email: null,
  user: null,
  partnerRelationshipsA: [],
  roles: [],
  professions: [],
});

const person = (
  id: number,
  displayName: string,
  opts: { userEmail?: string; employers?: Array<{ id: number; displayName: string }> } = {},
) => ({
  id,
  partnerType: 'person',
  displayName,
  firstName: displayName,
  lastName: null,
  email: `${displayName.toLowerCase()}@mail.test`,
  user: opts.userEmail
    ? { id: id + 1000, email: opts.userEmail, avatarUrl: null, position: null, orgUnit: null }
    : null,
  partnerRelationshipsA: (opts.employers ?? []).map((partyB) => ({ partyB })),
  roles: [],
  professions: [],
});

const AMEC = org(HOME_ID, 'AMEC');
const ACME = org(ACME_ID, 'Acme Engineering');
const ROWS = [
  AMEC,
  ACME,
  // AMEC staff with a login on the home domain (D1 employee).
  person(10, 'Yossi', { userEmail: 'yossi@amec.co.il', employers: [{ id: HOME_ID, displayName: 'AMEC' }] }),
  // AMEC staff imported without a login: worker_of AMEC only.
  person(11, 'Noa', { employers: [{ id: HOME_ID, displayName: 'AMEC' }] }),
  // D1 employee whose employer edge is missing.
  person(12, 'Dvir', { userEmail: 'dvir@AMEC.co.il' }),
  // External contact at Acme.
  person(20, 'Dana', { employers: [{ id: ACME_ID, displayName: 'Acme Engineering' }] }),
  // External person WITH a login on a foreign domain (a client user).
  person(21, 'Rami', { userEmail: 'rami@acme.test', employers: [{ id: ACME_ID, displayName: 'Acme Engineering' }] }),
  // Freelancer, no employer.
  person(30, 'Lior'),
];

function make(rows = ROWS, opts: { homeDomains?: string[]; noHomeOrg?: boolean } = {}) {
  const prisma: any = {
    projectRoleType: { findUnique: jest.fn(async () => ({ ...engineerRole })) },
    projectPartnerRole: { findMany: jest.fn(async () => []) },
    profession: { findMany: jest.fn(async () => []) },
    businessPartner: {
      findMany: jest.fn(async () => rows),
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.isHomeOrg) {
          if (opts.noHomeOrg) return null;
          return {
            id: HOME_ID,
            domains: (opts.homeDomains ?? ['amec.co.il']).map((domain) => ({ domain, isPersonal: false }))
              .concat([{ domain: 'gmail.com', isPersonal: true }]),
          };
        }
        const hit = rows.find((r) => r.id === where.id && r.partnerType === where.partnerType);
        return hit ? { id: hit.id } : null;
      }),
    },
  };
  const access: any = {
    assertProjectAccess: jest.fn(async (userId: number) => {
      if (userId === 9) {
        throw new PermissionDeniedException("You're not a member of this project.", {
          module: 'projects',
          reason: 'NOT_PROJECT_MEMBER',
        });
      }
    }),
  };
  return { ctrl: new ProjectRoleTypesController(prisma, access), prisma, access };
}

const USER = { id: 4, isAdmin: false, roleModules: [] };
const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id).sort((a, b) => a - b);

describe('isInternalParty (QA6 BM2-4)', () => {
  const ctx = { homeOrgId: HOME_ID, ownedDomains: ['amec.co.il'] };
  const p = (over: Partial<Parameters<typeof isInternalParty>[0]>) =>
    ({ id: 99, partnerType: 'person', user: null, employerIds: [], ...over });

  it('the home org is internal, any other org is not', () => {
    expect(isInternalParty(p({ id: HOME_ID, partnerType: 'organization' }), ctx)).toBe(true);
    expect(isInternalParty(p({ id: ACME_ID, partnerType: 'organization' }), ctx)).toBe(false);
  });

  it('a person working for the home org is internal, with or without a login', () => {
    expect(isInternalParty(p({ employerIds: [ACME_ID, HOME_ID] }), ctx)).toBe(true);
  });

  it('a login on a home-org domain is internal (D1), case-insensitive', () => {
    expect(isInternalParty(p({ user: { email: 'X@Amec.Co.Il' } }), ctx)).toBe(true);
  });

  it('a look-alike domain is NOT the home domain', () => {
    expect(isInternalParty(p({ user: { email: 'x@notamec.co.il' } }), ctx)).toBe(false);
  });

  it('a person without login or AMEC employer is external', () => {
    expect(isInternalParty(p({ employerIds: [ACME_ID] }), ctx)).toBe(false);
    expect(isInternalParty(p({ user: { email: 'client@acme.test' } }), ctx)).toBe(false);
  });

  it('with no owned domain, any login counts as internal (same fallback as excludeInternal)', () => {
    const bare = { homeOrgId: null, ownedDomains: [] };
    expect(isInternalParty(p({ user: { email: 'client@acme.test' } }), bare)).toBe(true);
    expect(isInternalParty(p({}), bare)).toBe(false);
    expect(isInternalParty(p({ id: HOME_ID, partnerType: 'organization' }), bare)).toBe(false);
  });
});

describe('query parsing (QA6 BM2-4)', () => {
  it('organizationId: absent → no filter, id or "none" → filter, junk → null (400)', () => {
    expect(parseOrganizationFilter(undefined)).toBeUndefined();
    expect(parseOrganizationFilter('')).toBeUndefined();
    expect(parseOrganizationFilter('50')).toBe(50);
    expect(parseOrganizationFilter(' NONE ')).toBe('none');
    for (const bad of ['0', '-3', '1.5', 'abc', '50abc', ['50']]) {
      expect(parseOrganizationFilter(bad)).toBeNull();
    }
  });

  it('excludeInternal accepts the usual truthy spellings only', () => {
    for (const yes of ['1', 'true', 'TRUE', 'yes', 'on']) expect(parseQueryFlag(yes)).toBe(true);
    for (const no of [undefined, '', '0', 'false', 'no']) expect(parseQueryFlag(no)).toBe(false);
  });
});

describe('GET /admin/project-role-types/:code/eligible-parties — org-first params (QA6 BM2-4)', () => {
  it('without the new params the list is unchanged (AMEC included) and no home-org lookup runs', async () => {
    const { ctrl, prisma } = make();
    const out = await ctrl.eligibleParties(USER, 'engineer', {});
    expect(ids(out)).toEqual(ids(ROWS));
    expect(prisma.businessPartner.findFirst).not.toHaveBeenCalled();
    expect(prisma.businessPartner.findMany.mock.calls[0][0].where.AND).toBeUndefined();
  });

  it('excludeInternal=true drops the home org, its staff and D1 employees; keeps external people and orgs', async () => {
    const { ctrl } = make();
    const out = await ctrl.eligibleParties(USER, 'engineer', { excludeInternal: 'true' });
    expect(ids(out)).toEqual([20, 21, 30, ACME_ID].sort((a, b) => a - b));
  });

  it('person rows carry their active employers; orgs carry none', async () => {
    const { ctrl } = make();
    const out: any[] = await ctrl.eligibleParties(USER, 'engineer', { excludeInternal: '1' });
    expect(out.find((r) => r.id === 20).employers).toEqual([{ id: ACME_ID, displayName: 'Acme Engineering' }]);
    expect(out.find((r) => r.id === 30).employers).toEqual([]);
    expect(out.find((r) => r.id === ACME_ID).employers).toEqual([]);
    // The login email is read for the D1 rule but never echoed back.
    expect(JSON.stringify(out)).not.toContain('rami@acme.test');
  });

  it('the employers relation is limited to active worker_of edges to live organizations', async () => {
    const { ctrl, prisma } = make();
    await ctrl.eligibleParties(USER, 'engineer', {});
    const rel = prisma.businessPartner.findMany.mock.calls[0][0].select.partnerRelationshipsA;
    expect(rel.where.type).toEqual({ code: 'worker_of' });
    expect(rel.where.validTo.gt).toBeInstanceOf(Date);
    expect(rel.where.partyB).toEqual({ deletedAt: null, partnerType: 'organization' });
  });

  it('organizationId=<org> scopes the query to the org itself and its active workers', async () => {
    const { ctrl, prisma } = make();
    await ctrl.eligibleParties(USER, 'engineer', { organizationId: String(ACME_ID) });
    const where = prisma.businessPartner.findMany.mock.calls[0][0].where;
    const [scope] = where.AND;
    expect(scope.OR[0]).toEqual({ id: ACME_ID });
    expect(scope.OR[1].partnerType).toBe('person');
    expect(scope.OR[1].partnerRelationshipsA.some).toMatchObject({
      partyBId: ACME_ID,
      type: { code: 'worker_of' },
    });
    expect(where.deletedAt).toBeNull();
  });

  it('organizationId=none keeps only people with no active employer', async () => {
    const { ctrl, prisma } = make();
    await ctrl.eligibleParties(USER, 'engineer', { organizationId: 'none' });
    const [scope] = prisma.businessPartner.findMany.mock.calls[0][0].where.AND;
    expect(scope.partnerType).toBe('person');
    expect(scope.partnerRelationshipsA.none).toMatchObject({
      type: { code: 'worker_of' },
      partyB: { deletedAt: null, partnerType: 'organization' },
    });
  });

  it('organizationId of the home org with excludeInternal → empty, the party list is not even read', async () => {
    const { ctrl, prisma } = make();
    const out = await ctrl.eligibleParties(USER, 'engineer', {
      organizationId: String(HOME_ID),
      excludeInternal: 'true',
    });
    expect(out).toEqual([]);
    expect(prisma.businessPartner.findMany).not.toHaveBeenCalled();
  });

  it('a malformed organizationId is a 400, never a silently wider list', async () => {
    const { ctrl, prisma } = make();
    const err = await ctrl.eligibleParties(USER, 'engineer', { organizationId: 'acme' }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(prisma.businessPartner.findMany).not.toHaveBeenCalled();
  });

  it('an organizationId that is a person (or unknown) is a 400', async () => {
    const { ctrl } = make();
    for (const id of ['20', '999']) {
      const err = await ctrl.eligibleParties(USER, 'engineer', { organizationId: id }).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
    }
  });

  it('Round 4 project-access check still runs before anything is read', async () => {
    const { ctrl, prisma, access } = make();
    const err = await ctrl
      .eligibleParties({ id: 9, isAdmin: false, roleModules: [] }, 'engineer', {
        projectId: '59',
        organizationId: String(ACME_ID),
        excludeInternal: 'true',
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(access.assertProjectAccess).toHaveBeenCalledWith(9, 59, false);
    expect(prisma.businessPartner.findMany).not.toHaveBeenCalled();
  });

  it('no home org flagged and no owned domain → logins are treated as internal (fallback)', async () => {
    const { ctrl } = make(ROWS, { noHomeOrg: true });
    const out = await ctrl.eligibleParties(USER, 'engineer', { excludeInternal: 'true' });
    // Users 10/12/21 dropped (have logins); Noa (11) has no login and
    // no flagged home org to work for, so she stays; both orgs stay.
    expect(ids(out)).toEqual([HOME_ID, 11, 20, 30, ACME_ID].sort((a, b) => a - b));
  });
});
