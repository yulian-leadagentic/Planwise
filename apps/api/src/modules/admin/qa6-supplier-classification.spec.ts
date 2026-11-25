/**
 * QA6 package 9 · Supplier — `POST /admin/backfills/qa6-supplier-classification`.
 *
 * Prisma is an in-memory fake that really applies the writes, so a
 * second run sees what the first one left (idempotency) without a DB.
 */
import { BadRequestException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { BackfillsController } from './backfills.controller';
import {
  parseQa6SupplierBody,
  planSupplierClassification,
  runQa6SupplierClassification,
  type SupplierOrgRow,
  type SupplierRule,
} from './qa6-supplier-classification';

const SUPPLIER_RULE: SupplierRule = {
  code: 'supplier',
  name: 'Supplier',
  allowedPartnerKind: 'organization',
  requiredPartnerRoleCode: 'supplier',
  requiredProfessionIds: null,
};

const org = (id: number, displayName: string, over: Partial<SupplierOrgRow> = {}): SupplierOrgRow => ({
  id,
  displayName,
  isHomeOrg: false,
  mainRole: { code: 'partner', name: 'Partner' },
  roleCodes: ['partner'],
  professionIds: [],
  supplierOf: [],
  supplierProjectIds: [],
  ...over,
});

describe('parseQa6SupplierBody', () => {
  it('dry-run unless the body says dryRun: false', () => {
    expect(parseQa6SupplierBody(undefined)).toEqual({ dryRun: true });
    expect(parseQa6SupplierBody({})).toEqual({ dryRun: true });
    expect(parseQa6SupplierBody({ dryRun: 'false' })).toEqual({ dryRun: true });
    expect(parseQa6SupplierBody({ dryRun: 0 })).toEqual({ dryRun: true });
    expect(parseQa6SupplierBody({ dryRun: false })).toEqual({ dryRun: false });
  });

  it('orgIds: de-duplicated; malformed lists are a 400', () => {
    expect(parseQa6SupplierBody({ orgIds: [5, 5, 7] })).toEqual({ dryRun: true, orgIds: [5, 7] });
    for (const bad of [[], [0], [-1], [1.5], ['5'], 'all', 5]) {
      expect(() => parseQa6SupplierBody({ orgIds: bad })).toThrow(BadRequestException);
    }
  });
});

describe('planSupplierClassification', () => {
  const base = { rule: SUPPLIER_RULE, supplierPartnerRoleExists: true };

  it('the staging shape: no supplier anywhere, no signal → nothing planned, every org listed for a manual pick', () => {
    const orgs = [
      org(1, 'AMEC', { isHomeOrg: true, mainRole: null, roleCodes: [] }),
      org(2, 'Acme'),
      org(3, 'Beta', { mainRole: null, roleCodes: [] }),
    ];
    const plan = planSupplierClassification({ ...base, orgs });
    expect(plan.toClassify).toEqual([]);
    expect(plan.totals).toMatchObject({ organizations: 3, alreadySupplier: 0, eligibleNow: 0, toClassify: 0, eligibleAfter: 0 });
    expect(plan.otherOrganizations.map((o) => o.id)).toEqual([2, 3]); // never the home org
    expect(plan.byMainRole).toEqual([
      { code: null, name: 'not set', count: 2 },
      { code: 'partner', name: 'Partner', count: 1 },
    ]);
    expect(plan.findings.join('\n')).toContain('0 of 3 organizations hold the Supplier partner role');
    expect(plan.findings.join('\n')).toContain('No organization carries a supplier signal');
  });

  it('plans every signal with its reason; skips orgs already classified', () => {
    const orgs = [
      org(10, 'Drift', { mainRole: { code: 'supplier', name: 'Supplier' }, roleCodes: [] }),
      org(11, 'Steel Co', { supplierOf: [{ id: 90, displayName: 'Tidhar' }] }),
      org(12, 'Legacy Co', { supplierProjectIds: [59, 60] }),
      org(13, 'Already', { roleCodes: ['supplier'] }),
    ];
    const plan = planSupplierClassification({ ...base, orgs });
    expect(plan.toClassify.map((o) => [o.id, o.reasons.map((r) => r.signal)])).toEqual([
      [10, ['main_role']],
      [11, ['supplier_of']],
      [12, ['supplier_project_role']],
    ]);
    expect(plan.toClassify[1].reasons[0].detail).toBe('Supplier of Tidhar (relationship)');
    expect(plan.toClassify[2].reasons[0].detail).toContain('2 projects (#59, #60)');
    expect(plan.toClassify.every((o) => o.eligibleAfter && o.stillBlockedBy === null)).toBe(true);
    expect(plan.totals).toMatchObject({ alreadySupplier: 1, eligibleNow: 1, toClassify: 3, eligibleAfter: 4 });
  });

  it('the home org is never planned, even with a signal', () => {
    const orgs = [org(1, 'AMEC', { isHomeOrg: true, supplierOf: [{ id: 90, displayName: 'Tidhar' }] })];
    expect(planSupplierClassification({ ...base, orgs }).toClassify).toEqual([]);
  });

  it('setsMainRole only for orgs without a main role', () => {
    const orgs = [
      org(10, 'No type', { mainRole: null, roleCodes: [], supplierProjectIds: [1] }),
      org(11, 'Partner type', { supplierProjectIds: [1] }),
    ];
    const plan = planSupplierClassification({ ...base, orgs });
    expect(plan.toClassify.map((o) => [o.id, o.setsMainRole])).toEqual([[10, true], [11, false]]);
  });

  it('orgIds: classifies exactly the listed orgs; home / already / unknown are skipped with a reason', () => {
    const orgs = [
      org(1, 'AMEC', { isHomeOrg: true }),
      org(2, 'Acme'),
      org(3, 'Beta', { supplierOf: [{ id: 90, displayName: 'Tidhar' }] }),
      org(4, 'Already', { roleCodes: ['supplier'] }),
      org(5, 'Not listed', { supplierProjectIds: [9] }),
    ];
    const plan = planSupplierClassification({
      ...base,
      orgs,
      orgIds: [1, 2, 3, 4, 77],
      unknownIds: [{ id: 77, displayName: 'Dana', reason: 'not an organization' }],
    });
    expect(plan.toClassify.map((o) => [o.id, o.reasons.map((r) => r.signal)])).toEqual([
      [2, ['explicit']],
      [3, ['supplier_of', 'explicit']],
    ]);
    expect(plan.skipped).toEqual([
      { id: 77, displayName: 'Dana', reason: 'not an organization' },
      { id: 1, displayName: 'AMEC', reason: 'home organization: never a supplier' },
      { id: 4, displayName: 'Already', reason: 'already a supplier' },
    ]);
    // Org 5 has a signal but was not listed: untouched in this run.
    expect(plan.toClassify.some((o) => o.id === 5)).toBe(false);
  });

  it('a qualification on the Supplier role blocks orgs even after classifying: reported, not hidden', () => {
    const plan = planSupplierClassification({
      ...base,
      rule: { ...SUPPLIER_RULE, requiredProfessionIds: [4] },
      orgs: [org(2, 'Acme', { supplierProjectIds: [1] })],
    });
    expect(plan.toClassify[0]).toMatchObject({ eligibleAfter: false, stillBlockedBy: 'Party is missing a required job title.' });
    expect(plan.totals.eligibleAfter).toBe(0);
    expect(plan.findings.join('\n')).toContain('also requires a qualification; 0 of 1 organizations hold one');
  });

  it('a role re-pointed to another partner role, or to people only, is called out', () => {
    const plan = planSupplierClassification({
      ...base,
      rule: { ...SUPPLIER_RULE, requiredPartnerRoleCode: 'vendor', allowedPartnerKind: 'person' },
      orgs: [org(2, 'Acme')],
    });
    const text = plan.findings.join('\n');
    expect(text).toContain("requires the 'vendor' partner role, not 'supplier'");
    expect(text).toContain('people only, so no organization can ever qualify');
  });

  it('a missing supplier partner role: nothing can be written, every candidate is skipped', () => {
    const plan = planSupplierClassification({
      ...base,
      supplierPartnerRoleExists: false,
      orgs: [org(2, 'Acme', { supplierProjectIds: [1] })],
    });
    expect(plan.toClassify).toEqual([]);
    expect(plan.skipped).toEqual([{ id: 2, displayName: 'Acme', reason: "partner role 'supplier' does not exist" }]);
  });
});

// ─── runner against an in-memory fake ───────────────────────────────

type BpFx = {
  id: number;
  partnerType: 'organization' | 'person';
  displayName: string;
  isHomeOrg?: boolean;
  deletedAt?: Date | null;
  mainRoleTypeId: number | null;
  supplierOf?: Array<{ id: number; displayName: string }>;
  supplierProjectIds?: number[];
};

const ROLE_TYPES = [
  { id: 1, code: 'partner', name: 'Partner' },
  { id: 2, code: 'customer', name: 'Customer' },
  { id: 3, code: 'supplier', name: 'Supplier' },
];

function makeFake(bps: BpFx[], roles: Array<{ businessPartnerId: number; roleTypeId: number; isPrimary: boolean }>) {
  const db = { bps: bps.map((b) => ({ deletedAt: null, isHomeOrg: false, ...b })), roles: [...roles] };
  const rt = (id: number | null) => ROLE_TYPES.find((r) => r.id === id) ?? null;
  const tx = {
    businessPartnerRole: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) => {
        let count = 0;
        for (const d of data) {
          const dup = db.roles.some((r) => r.businessPartnerId === d.businessPartnerId && r.roleTypeId === d.roleTypeId);
          if (dup && skipDuplicates) continue;
          db.roles.push({ ...d });
          count += 1;
        }
        return { count };
      }),
    },
    businessPartner: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const b of db.bps) {
          if (where.id.in.includes(b.id) && b.mainRoleTypeId === where.mainRoleTypeId) {
            b.mainRoleTypeId = data.mainRoleTypeId;
            count += 1;
          }
        }
        return { count };
      }),
    },
  };
  const prisma: any = {
    projectRoleType: { findUnique: jest.fn(async () => ({ ...SUPPLIER_RULE })) },
    partnerRoleType: { findUnique: jest.fn(async ({ where }: any) => ROLE_TYPES.find((r) => r.code === where.code) ?? null) },
    businessPartner: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.id?.in) {
          return db.bps
            .filter((b) => where.id.in.includes(b.id))
            .map((b) => ({ id: b.id, displayName: b.displayName, partnerType: b.partnerType, deletedAt: b.deletedAt }));
        }
        return db.bps
          .filter((b) => b.partnerType === 'organization' && !b.deletedAt)
          .map((b) => ({
            id: b.id,
            displayName: b.displayName,
            isHomeOrg: b.isHomeOrg,
            mainRoleType: rt(b.mainRoleTypeId) ? { code: rt(b.mainRoleTypeId)!.code, name: rt(b.mainRoleTypeId)!.name } : null,
            roles: db.roles.filter((r) => r.businessPartnerId === b.id).map((r) => ({ roleType: { code: rt(r.roleTypeId)!.code } })),
            professions: [],
            partnerRelationshipsA: (b.supplierOf ?? []).map((partyB) => ({ partyB })),
            projectPartnerRoles: (b.supplierProjectIds ?? []).map((projectId) => ({ projectId })),
          }));
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  return { prisma, db, tx };
}

describe('runQa6SupplierClassification', () => {
  const seed = () =>
    makeFake(
      [
        { id: 1, partnerType: 'organization', displayName: 'AMEC', isHomeOrg: true, mainRoleTypeId: null },
        { id: 2, partnerType: 'organization', displayName: 'Steel Co', mainRoleTypeId: null, supplierOf: [{ id: 9, displayName: 'Tidhar' }] },
        { id: 3, partnerType: 'organization', displayName: 'Legacy Co', mainRoleTypeId: 1, supplierProjectIds: [59] },
        { id: 4, partnerType: 'organization', displayName: 'Plain Co', mainRoleTypeId: 1 },
        { id: 5, partnerType: 'organization', displayName: 'Gone Co', mainRoleTypeId: 1, deletedAt: new Date(), supplierProjectIds: [59] },
        { id: 6, partnerType: 'person', displayName: 'Dana', mainRoleTypeId: null },
      ],
      [
        { businessPartnerId: 3, roleTypeId: 1, isPrimary: true },
        { businessPartnerId: 4, roleTypeId: 1, isPrimary: true },
      ],
    );

  it('dry-run (the default) plans and writes nothing', async () => {
    const { prisma, db } = seed();
    const res = await runQa6SupplierClassification(prisma, { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.written).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(res.toClassify.map((o) => o.id)).toEqual([2, 3]); // deleted org 5 is never read
    expect(res.otherOrganizations.map((o) => o.id)).toEqual([4]);
    expect(res.rule).toMatchObject({ allowedPartnerKind: 'organization', requiredPartnerRoleCode: 'supplier', requiredProfessionIds: [] });
    expect(db.roles).toHaveLength(2);
  });

  it('a real run tags the orgs, sets Supplier as main role only where none was set, and is idempotent', async () => {
    const { prisma, db } = seed();
    const res = await runQa6SupplierClassification(prisma, { dryRun: false });
    expect(res.written).toEqual({ rolesCreated: 2, mainRoleSet: 1 });
    expect(db.roles).toEqual(expect.arrayContaining([
      { businessPartnerId: 2, roleTypeId: 3, isPrimary: true },
      { businessPartnerId: 3, roleTypeId: 3, isPrimary: false },
    ]));
    expect(db.bps.find((b) => b.id === 2)!.mainRoleTypeId).toBe(3);
    expect(db.bps.find((b) => b.id === 3)!.mainRoleTypeId).toBe(1); // Partner kept
    expect(db.bps.find((b) => b.id === 1)!.mainRoleTypeId).toBeNull(); // AMEC untouched

    const again = await runQa6SupplierClassification(prisma, { dryRun: false });
    expect(again.toClassify).toEqual([]);
    expect(again.written).toBeNull();
    expect(again.totals).toMatchObject({ alreadySupplier: 2, eligibleNow: 2 });
  });

  it('orgIds: explicit picks, with unknown ids explained (person / deleted / missing)', async () => {
    const { prisma, db } = seed();
    const res = await runQa6SupplierClassification(prisma, { dryRun: false, orgIds: [4, 5, 6, 404] });
    expect(res.toClassify.map((o) => o.id)).toEqual([4]);
    expect(res.skipped).toEqual([
      { id: 5, displayName: 'Gone Co', reason: 'deleted' },
      { id: 6, displayName: 'Dana', reason: 'not an organization' },
      { id: 404, displayName: null, reason: 'not found' },
    ]);
    expect(res.written).toEqual({ rolesCreated: 1, mainRoleSet: 0 });
    expect(db.roles.filter((r) => r.roleTypeId === 3).map((r) => r.businessPartnerId)).toEqual([4]);
  });

  it('the endpoint: admin:write on POST admin/backfills/qa6-supplier-classification, dry-run unless dryRun:false', async () => {
    const handler = BackfillsController.prototype.runQa6SupplierClassification;
    expect(Reflect.getMetadata(PATH_METADATA, BackfillsController)).toBe('admin/backfills');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('qa6-supplier-classification');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([{ module: 'admin', action: 'write' }]);
    expect(Reflect.getMetadata(GUARDS_METADATA, BackfillsController)).toEqual([JwtAuthGuard, RolesGuard]);

    const { prisma, db } = seed();
    const controller = new BackfillsController(prisma, {} as never, {} as never, {} as never, {} as never, {} as never);
    const dry = await controller.runQa6SupplierClassification(undefined);
    expect(dry.dryRun).toBe(true);
    expect(db.roles).toHaveLength(2);
    await expect(controller.runQa6SupplierClassification({ orgIds: [] })).rejects.toBeInstanceOf(BadRequestException);
    const real = await controller.runQa6SupplierClassification({ dryRun: false });
    expect(real.written).toEqual({ rolesCreated: 2, mainRoleSet: 1 });
  });
});
