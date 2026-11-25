import { describe, expect, it } from 'vitest';

import {
  buildOrgOptions,
  isExternalProjectRole,
  orgOptionLabel,
  type EligibleParty,
} from './role-org-first';

const role = (over: Partial<{ code: string; requiredPartnerRoleCode: string | null; requiredProfessionIds: number[] | null }>) => ({
  code: 'engineer',
  requiredPartnerRoleCode: null,
  requiredProfessionIds: null,
  ...over,
});

describe('isExternalProjectRole (QA6 BM2-4)', () => {
  it('Engineer, Architect, Inspector, External Contact and Supplier are external', () => {
    for (const code of ['engineer', 'architect', 'inspector', 'external_contact']) {
      expect(isExternalProjectRole(role({ code }))).toBe(true);
    }
    expect(isExternalProjectRole(role({ code: 'supplier', requiredPartnerRoleCode: 'supplier' }))).toBe(true);
  });

  it('an empty qualification list does not make a role internal', () => {
    expect(isExternalProjectRole(role({ requiredProfessionIds: [] }))).toBe(true);
  });

  it('participant and team_leader are internal', () => {
    expect(isExternalProjectRole(role({ code: 'participant' }))).toBe(false);
    expect(isExternalProjectRole(role({ code: 'team_leader' }))).toBe(false);
  });

  it('a role that requires the employee partner-role is internal', () => {
    expect(isExternalProjectRole(role({ code: 'site_manager', requiredPartnerRoleCode: 'employee' }))).toBe(false);
  });

  it('a qualification-gated role (BIM Manager) is internal', () => {
    expect(isExternalProjectRole(role({ code: 'bim_manager', requiredProfessionIds: [3] }))).toBe(false);
  });
});

const party = (over: Partial<EligibleParty> & Pick<EligibleParty, 'id' | 'displayName'>): EligibleParty => ({
  userId: null,
  partnerType: 'person',
  firstName: null,
  lastName: null,
  email: null,
  avatarUrl: null,
  position: null,
  department: null,
  employers: [],
  eligible: true,
  reasons: [],
  ...over,
});

describe('buildOrgOptions (QA6 BM2-4)', () => {
  const acme = { id: 50, displayName: 'Acme' };
  const beta = { id: 60, displayName: 'Beta Planners' };

  it('lists eligible orgs and the employers of eligible people, with contact counts', () => {
    const { orgs, independentCount } = buildOrgOptions([
      party({ id: 50, displayName: 'Acme', partnerType: 'organization' }),
      party({ id: 1, displayName: 'Dana', employers: [acme] }),
      party({ id: 2, displayName: 'Rami', employers: [acme, beta] }),
      party({ id: 3, displayName: 'Lior' }),
    ]);
    expect(orgs).toEqual([
      { id: 50, displayName: 'Acme', selfEligible: true, contactCount: 2 },
      { id: 60, displayName: 'Beta Planners', selfEligible: false, contactCount: 1 },
    ]);
    expect(independentCount).toBe(1);
  });

  it('ignores ineligible rows entirely', () => {
    const { orgs, independentCount } = buildOrgOptions([
      party({ id: 50, displayName: 'Acme', partnerType: 'organization', eligible: false, reasons: ['Must be a supplier'] }),
      party({ id: 1, displayName: 'Dana', employers: [beta], eligible: false }),
      party({ id: 3, displayName: 'Lior', eligible: false }),
    ]);
    expect(orgs).toEqual([]);
    expect(independentCount).toBe(0);
  });

  it('tolerates an older API without `employers` (person counts as independent)', () => {
    const p = party({ id: 1, displayName: 'Dana' });
    delete p.employers;
    expect(buildOrgOptions([p]).independentCount).toBe(1);
  });

  it('sorts organizations by name: Hebrew first (he collation), then English, case-insensitive', () => {
    const { orgs } = buildOrgOptions([
      party({ id: 3, displayName: 'תדהר', partnerType: 'organization' }),
      party({ id: 2, displayName: 'beta', partnerType: 'organization' }),
      party({ id: 1, displayName: 'Alpha', partnerType: 'organization' }),
    ]);
    expect(orgs.map((o) => o.displayName)).toEqual(['תדהר', 'Alpha', 'beta']);
  });

  it('labels an org with its contact count, singular and plural', () => {
    expect(orgOptionLabel({ id: 1, displayName: 'Acme', selfEligible: true, contactCount: 0 })).toBe('Acme');
    expect(orgOptionLabel({ id: 1, displayName: 'Acme', selfEligible: true, contactCount: 1 })).toBe('Acme (1 contact)');
    expect(orgOptionLabel({ id: 1, displayName: 'Acme', selfEligible: false, contactCount: 3 })).toBe('Acme (3 contacts)');
  });
});
