/**
 * QA6 security review (2026-11-25) — an EXTERNAL project role is never
 * held by the home organization (AMEC) or its people, enforced on the
 * server: POST /project-partner-roles (and project create, which goes
 * through the same ProjectPartnerRolesService.create) and PATCH.
 *
 * "External" is the web picker's definition (58a84db): not participant /
 * team_leader, no `employee` partner-role requirement, no required
 * Qualification. "AMEC" is `isInternalParty`: the home org, a person
 * with an active worker_of edge to it, or a login on a home-org domain.
 *
 * Real ProjectPartnerRolesService over the in-memory Prisma.
 */
import { BadRequestException } from '@nestjs/common';

import { MemoryDb, memoryPrisma, PLANWISE_RELATIONS, type Relations } from '../../testing/memory-prisma';
import { EXTERNAL_ROLE_INTERNAL_PARTY, ProjectPartnerRolesService } from './project-partner-roles.service';
import { isExternalProjectRole } from '../project-role-types/internal-party';

const RELATIONS: Relations = {
  ...PLANWISE_RELATIONS,
  businessPartner: {
    ...PLANWISE_RELATIONS.businessPartner,
    domains: { model: 'businessPartnerDomain', from: 'id', to: 'partnerId', many: true },
    partnerRelationshipsA: { model: 'partnerRelationship', from: 'id', to: 'partyAId', many: true },
  },
  partnerRelationship: {
    type: { model: 'partnerRelationshipType', from: 'typeId', to: 'id' },
    partyB: { model: 'businessPartner', from: 'partyBId', to: 'id' },
  },
};

const HOME = 1;
const ACME = 50;
const FAR = new Date('9999-12-31T00:00:00Z');

function seed() {
  const bp = (id: number, partnerType: string, displayName: string) => ({
    id, partnerType, displayName, deletedAt: null, isHomeOrg: id === HOME, professions: [] as any[],
  });
  return {
    businessPartner: [
      bp(HOME, 'organization', 'AMEC'),
      bp(ACME, 'organization', 'Acme Engineering'),
      bp(201, 'person', 'Dana Staff'), // AMEC login (home-org domain)
      bp(202, 'person', 'Moshe Worker'), // worker_of AMEC, no login
      bp(203, 'person', 'Eli Outside'), // worker_of Acme
      bp(204, 'person', 'Rina Freelance'), // no employer, personal-domain login
    ],
    businessPartnerDomain: [
      { id: 1, partnerId: HOME, domain: 'amec.co.il', isPersonal: false },
      { id: 2, partnerId: HOME, domain: 'gmail.com', isPersonal: true },
    ],
    user: [
      { id: 11, businessPartnerId: 201, email: 'dana@amec.co.il', isActive: true, deletedAt: null },
      { id: 14, businessPartnerId: 204, email: 'rina@gmail.com', isActive: true, deletedAt: null },
    ],
    partnerRelationshipType: [{ id: 1, code: 'worker_of' }],
    partnerRelationship: [
      { id: 1, partyAId: 202, partyBId: HOME, typeId: 1, validTo: FAR },
      { id: 2, partyAId: 203, partyBId: ACME, typeId: 1, validTo: FAR },
    ],
    project: [{ id: 58, name: 'P58', deletedAt: null }],
    projectRoleType: [
      { id: 1, code: 'participant', name: 'Participant', allowedPartnerKind: 'person', requiredPartnerRoleCode: null, requiredProfessionIds: null },
      { id: 2, code: 'engineer', name: 'Engineer', allowedPartnerKind: 'any', requiredPartnerRoleCode: null, requiredProfessionIds: null },
      { id: 3, code: 'supplier', name: 'Supplier', allowedPartnerKind: 'organization', requiredPartnerRoleCode: null, requiredProfessionIds: [] },
      { id: 4, code: 'bim_manager', name: 'BIM Manager', allowedPartnerKind: 'person', requiredPartnerRoleCode: null, requiredProfessionIds: [9] },
    ],
    projectPartnerRole: [] as any[],
  };
}

function world() {
  const db = new MemoryDb(RELATIONS, seed());
  const prisma = memoryPrisma(db);
  const activityLog: any = { write: jest.fn() };
  return { db, svc: new ProjectPartnerRolesService(prisma, activityLog) };
}

const add = (svc: ProjectPartnerRolesService, roleId: number, partyId: number, extra: Record<string, any> = {}) =>
  svc.create({ projectId: 58, roleId, partyId, ...extra }, 1);

const codeOf = (e: any) => e?.getResponse?.()?.code;

describe('QA6 · external project roles are never the home org or its people (server side)', () => {
  it('the role predicate matches the web picker', () => {
    expect(isExternalProjectRole({ code: 'engineer', requiredPartnerRoleCode: null, requiredProfessionIds: null })).toBe(true);
    expect(isExternalProjectRole({ code: 'supplier', requiredPartnerRoleCode: null, requiredProfessionIds: [] })).toBe(true);
    expect(isExternalProjectRole({ code: 'participant' })).toBe(false);
    expect(isExternalProjectRole({ code: 'team_leader' })).toBe(false);
    expect(isExternalProjectRole({ code: 'x', requiredPartnerRoleCode: 'employee' })).toBe(false);
    expect(isExternalProjectRole({ code: 'bim_manager', requiredProfessionIds: [9] })).toBe(false);
  });

  it.each([
    ['the home org itself', 3, HOME],
    ['a person with a login on a home-org domain', 2, 201],
    ['a person with an active worker_of edge to the home org', 2, 202],
  ])('POST refuses %s with 400 EXTERNAL_ROLE_INTERNAL_PARTY; nothing written', async (_label, roleId, partyId) => {
    const w = world();
    const err = await add(w.svc, roleId, partyId).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(codeOf(err)).toBe(EXTERNAL_ROLE_INTERNAL_PARTY);
    expect(w.db.table('projectPartnerRole')).toHaveLength(0);
  });

  it('POST accepts an outside org, its worker and a freelancer on a personal-domain login', async () => {
    const w = world();
    await add(w.svc, 3, ACME);
    await add(w.svc, 2, 203);
    await add(w.svc, 2, 204);
    expect(w.db.table('projectPartnerRole').map((r) => r.partyId)).toEqual([ACME, 203, 204]);
  });

  it('an AMEC contact person or on-behalf-of org on an external role is refused too', async () => {
    const w = world();
    const contact = await add(w.svc, 3, ACME, { contactPartyId: 201 }).catch((e) => e);
    expect(codeOf(contact)).toBe(EXTERNAL_ROLE_INTERNAL_PARTY);
    const onBehalf = await add(w.svc, 2, 204, { onBehalfOfPartyId: HOME }).catch((e) => e);
    expect(codeOf(onBehalf)).toBe(EXTERNAL_ROLE_INTERNAL_PARTY);
    expect(w.db.table('projectPartnerRole')).toHaveLength(0);
  });

  it('internal roles keep taking AMEC people', async () => {
    const w = world();
    await add(w.svc, 1, 201); // participant
    expect(w.db.table('projectPartnerRole')).toHaveLength(1);
  });

  it('PATCH refuses an AMEC contact / on-behalf-of on an external role, and still edits a row otherwise', async () => {
    const w = world();
    const row: any = await add(w.svc, 3, ACME);
    const err = await w.svc.update(row.id, { contactPartyId: 202 }).catch((e) => e);
    expect(codeOf(err)).toBe(EXTERNAL_ROLE_INTERNAL_PARTY);
    expect(w.db.table('projectPartnerRole')[0].contactPartyId).toBeNull();

    await w.svc.update(row.id, { contactPartyId: 203, titleInProject: 'Main supplier' });
    expect(w.db.table('projectPartnerRole')[0]).toMatchObject({ contactPartyId: 203, titleInProject: 'Main supplier' });
  });
});
