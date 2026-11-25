/**
 * QA6 package 9 · Supplier (2026-11-25) — classify organizations as
 * suppliers so the project "Supplier" role has someone to offer.
 *
 * Endpoint: `POST /admin/backfills/qa6-supplier-classification`
 * (BackfillsController). Body `{ dryRun?: boolean, orgIds?: number[] }`.
 *
 * WHY NO ORGANIZATION QUALIFIES (diagnosis, from the code):
 *   The project role `supplier` is seeded (migration
 *   20260511010000_m3b…) with `allowed_partner_kind = 'organization'`
 *   and `required_partner_role_code = 'supplier'`. An organization is
 *   eligible only when it holds a `business_partner_roles` row whose
 *   partner role type is `supplier` (`isPartyEligibleForRole`, the
 *   eligible-parties picker and the write path all read that).
 *   Nothing writes that row automatically:
 *     • the contacts import gives every new org the `partner` type by
 *       default (QA4 IW-2), and older imports left orgs untyped;
 *     • a D4 `supplier_of` relationship (org → customer) does not tag
 *       the org;
 *     • project `supplier` assignments migrated from the legacy
 *       `supplier_of_project` edges never tagged the org either;
 *     • unlike the customer path (`setProjectCustomer` auto-tags the
 *       org with `customer`), there is no supplier equivalent.
 *   So the only way in is a person setting the org's Role(s) to
 *   Supplier by hand, and on staging nobody has. The condition itself
 *   is consistent with the design (same shape as Customer); this is a
 *   data gap, hence a backfill and not a code change.
 *
 * WHAT IT DOES:
 *   Adds the `supplier` partner role to organizations that carry an
 *   objective supplier signal:
 *     • `main_role`             main role (Type) is Supplier but the
 *                               role row is missing (drift);
 *     • `supplier_of`           side A of an active D4 `supplier_of`
 *                               relationship;
 *     • `supplier_project_role` holds (or held) the project Supplier
 *                               role on some project (legacy data that
 *                               predates the gate);
 *     • `explicit`              listed in `orgIds` (a hand-picked list
 *                               after reviewing the dry-run).
 *   With `orgIds` the run is limited to exactly those organizations and
 *   each one is classified; without it, only signalled organizations
 *   are. The home organization (AMEC) is never classified. Organizations
 *   with no main role get Supplier as their main role too; an existing
 *   main role is never changed and no other role row is touched.
 *
 * DRY-RUN IS THE DEFAULT: only the boolean `dryRun: false` writes. The
 * dry-run returns the rule as configured in the DB, plain-English
 * findings (why nothing qualifies), the plan with reasons, the
 * organizations it would leave alone, and counts. Idempotent: a
 * classified organization holds the role, so a second run plans
 * nothing for it.
 */
import { BadRequestException } from '@nestjs/common';

import type { PrismaService } from '../../prisma/prisma.service';
import { isPartyEligibleForRole } from '../project-partner-roles/project-partner-roles.service';

export const SUPPLIER_CODE = 'supplier';

export type SupplierSignal = 'main_role' | 'supplier_of' | 'supplier_project_role' | 'explicit';

export interface SupplierRule {
  code: string;
  name: string;
  allowedPartnerKind: string | null;
  requiredPartnerRoleCode: string | null;
  requiredProfessionIds: unknown;
}

export interface SupplierOrgRow {
  id: number;
  displayName: string;
  isHomeOrg: boolean;
  mainRole: { code: string; name: string } | null;
  roleCodes: string[];
  professionIds: number[];
  /** Customers this org is an active `supplier_of`. */
  supplierOf: Array<{ id: number; displayName: string }>;
  /** Projects where the org holds/held the project Supplier role. */
  supplierProjectIds: number[];
}

export interface PlannedOrg {
  id: number;
  displayName: string;
  mainRole: string | null;
  roles: string[];
  reasons: Array<{ signal: SupplierSignal; detail: string }>;
  /** True when the org has no main role, so Supplier becomes its main role. */
  setsMainRole: boolean;
  /** Eligible for the project Supplier role once classified. */
  eligibleAfter: boolean;
  /** Why it would still be ineligible (only when `eligibleAfter` is false). */
  stillBlockedBy: string | null;
}

export interface SupplierPlan {
  toClassify: PlannedOrg[];
  skipped: Array<{ id: number; displayName: string | null; reason: string }>;
  otherOrganizations: Array<{ id: number; displayName: string; mainRole: string | null }>;
  totals: {
    organizations: number;
    alreadySupplier: number;
    eligibleNow: number;
    toClassify: number;
    eligibleAfter: number;
    skipped: number;
  };
  byMainRole: Array<{ code: string | null; name: string; count: number }>;
  findings: string[];
}

export interface Qa6SupplierResult extends SupplierPlan {
  dryRun: boolean;
  rule: (Omit<SupplierRule, 'requiredProfessionIds'> & { requiredProfessionIds: number[] }) | null;
  supplierPartnerRole: { id: number; code: string; name: string } | null;
  written: { rolesCreated: number; mainRoleSet: number } | null;
}

/** Body parser, same contract as `parseP1CopiesToRefsBody`: only the
 *  boolean `false` writes; a malformed `orgIds` is a 400 so a bad filter
 *  can never widen a real run. */
export function parseQa6SupplierBody(body: unknown): { dryRun: boolean; orgIds?: number[] } {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const dryRun = raw.dryRun !== false;
  if (raw.orgIds == null) return { dryRun };
  const ids = raw.orgIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((n) => Number.isInteger(n) && n > 0)) {
    throw new BadRequestException({
      code: 'QA6_SUPPLIER_BAD_ORG_IDS',
      message: 'orgIds, when given, must be a non-empty array of positive integers.',
    });
  }
  return { dryRun, orgIds: [...new Set(ids as number[])] };
}

function profIds(rule: SupplierRule | null): number[] {
  return Array.isArray(rule?.requiredProfessionIds) ? (rule!.requiredProfessionIds as number[]) : [];
}

function eligibility(org: SupplierOrgRow, roleCodes: string[], rule: SupplierRule) {
  return isPartyEligibleForRole(
    {
      partnerType: 'organization',
      roles: roleCodes.map((code) => ({ roleType: { code } })),
      professions: org.professionIds.map((professionId) => ({ professionId })),
    },
    rule,
  );
}

/**
 * Pure planner. `orgs` = every live organization; `unknownIds` = ids from
 * `orgIds` that are not a live organization (with the reason).
 */
export function planSupplierClassification(input: {
  orgs: SupplierOrgRow[];
  rule: SupplierRule | null;
  supplierPartnerRoleExists: boolean;
  orgIds?: number[];
  unknownIds?: Array<{ id: number; displayName: string | null; reason: string }>;
}): SupplierPlan {
  const { orgs, rule, supplierPartnerRoleExists } = input;
  const requested = input.orgIds ? new Set(input.orgIds) : null;
  const toClassify: PlannedOrg[] = [];
  const skipped: SupplierPlan['skipped'] = [...(input.unknownIds ?? [])];
  const other: SupplierPlan['otherOrganizations'] = [];
  let alreadySupplier = 0;
  let eligibleNow = 0;

  for (const org of orgs) {
    const isSupplier = org.roleCodes.includes(SUPPLIER_CODE);
    if (isSupplier) alreadySupplier += 1;
    if (rule && eligibility(org, org.roleCodes, rule).eligible) eligibleNow += 1;

    const inScope = requested ? requested.has(org.id) : true;
    if (!inScope) continue;

    if (org.isHomeOrg) {
      if (requested) skipped.push({ id: org.id, displayName: org.displayName, reason: 'home organization: never a supplier' });
      continue;
    }
    if (isSupplier) {
      if (requested) skipped.push({ id: org.id, displayName: org.displayName, reason: 'already a supplier' });
      continue;
    }

    const reasons: PlannedOrg['reasons'] = [];
    if (org.mainRole?.code === SUPPLIER_CODE) {
      reasons.push({ signal: 'main_role', detail: 'Main role is Supplier but the Supplier role row is missing' });
    }
    if (org.supplierOf.length > 0) {
      reasons.push({
        signal: 'supplier_of',
        detail: `Supplier of ${org.supplierOf.map((c) => c.displayName).join(', ')} (relationship)`,
      });
    }
    if (org.supplierProjectIds.length > 0) {
      const n = org.supplierProjectIds.length;
      reasons.push({
        signal: 'supplier_project_role',
        detail: `Holds the project Supplier role on ${n} project${n === 1 ? '' : 's'} (#${org.supplierProjectIds.join(', #')})`,
      });
    }
    if (requested) reasons.push({ signal: 'explicit', detail: 'Listed in orgIds' });

    if (reasons.length === 0) {
      other.push({ id: org.id, displayName: org.displayName, mainRole: org.mainRole?.name ?? null });
      continue;
    }
    if (!supplierPartnerRoleExists) {
      skipped.push({ id: org.id, displayName: org.displayName, reason: "partner role 'supplier' does not exist" });
      continue;
    }

    const after = rule ? eligibility(org, [...org.roleCodes, SUPPLIER_CODE], rule) : null;
    toClassify.push({
      id: org.id,
      displayName: org.displayName,
      mainRole: org.mainRole?.name ?? null,
      roles: org.roleCodes,
      reasons,
      setsMainRole: org.mainRole == null,
      eligibleAfter: after?.eligible ?? false,
      stillBlockedBy: after == null
        ? "project role 'supplier' does not exist"
        : after.eligible ? null : after.reason ?? 'not eligible',
    });
  }

  // Main-role distribution: the quickest read of "what are these orgs".
  const byMain = new Map<string, { code: string | null; name: string; count: number }>();
  for (const org of orgs) {
    const key = org.mainRole?.code ?? '';
    const row = byMain.get(key) ?? { code: org.mainRole?.code ?? null, name: org.mainRole?.name ?? 'not set', count: 0 };
    row.count += 1;
    byMain.set(key, row);
  }
  const byMainRole = Array.from(byMain.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const findings: string[] = [];
  const total = orgs.length;
  if (!rule) {
    findings.push("The project role 'supplier' does not exist, so there is no Supplier role to fill.");
  } else {
    const profs = profIds(rule);
    findings.push(
      `Project role Supplier accepts: kind = ${rule.allowedPartnerKind ?? 'any'}, partner role = ${rule.requiredPartnerRoleCode ?? 'none'}, qualifications = ${profs.length > 0 ? profs.join(', ') : 'none'}.`,
    );
    if (rule.allowedPartnerKind === 'person') {
      findings.push('The role is set to people only, so no organization can ever qualify. Fix the role in Admin › Project Role Types.');
    }
    if (rule.requiredPartnerRoleCode && rule.requiredPartnerRoleCode !== SUPPLIER_CODE) {
      findings.push(
        `The role requires the '${rule.requiredPartnerRoleCode}' partner role, not 'supplier': classifying organizations as suppliers will not make them eligible.`,
      );
    }
    if (profs.length > 0) {
      const withProf = orgs.filter((o) => o.professionIds.some((id) => profs.includes(id))).length;
      findings.push(
        `The role also requires a qualification; ${withProf} of ${total} organizations hold one. Organizations rarely carry qualifications, so this alone can block every organization.`,
      );
    }
  }
  if (!supplierPartnerRoleExists) {
    findings.push("The partner role 'supplier' does not exist, so no organization can be classified.");
  }
  findings.push(`${alreadySupplier} of ${total} organizations hold the Supplier partner role; ${eligibleNow} are eligible for the project Supplier role today.`);
  const supplierOfCount = orgs.filter((o) => o.supplierOf.length > 0).length;
  const projectRoleCount = orgs.filter((o) => o.supplierProjectIds.length > 0).length;
  findings.push(
    `Supplier signals found: ${supplierOfCount} with a 'supplier_of' relationship, ${projectRoleCount} holding the project Supplier role, ${orgs.filter((o) => o.mainRole?.code === SUPPLIER_CODE && !o.roleCodes.includes(SUPPLIER_CODE)).length} with main role Supplier but no role row.`,
  );
  if (!requested && toClassify.length === 0) {
    findings.push(
      'No organization carries a supplier signal. Pick the real suppliers from otherOrganizations and re-run with orgIds, or set Role(s) to Supplier on each organization under Organizations.',
    );
  }

  return {
    toClassify,
    skipped,
    otherOrganizations: other,
    totals: {
      organizations: total,
      alreadySupplier,
      eligibleNow,
      toClassify: toClassify.length,
      eligibleAfter: eligibleNow + toClassify.filter((o) => o.eligibleAfter).length,
      skipped: skipped.length,
    },
    byMainRole,
    findings,
  };
}

/** Loader + executor. Reads only organizations, roles, relationships and
 *  project Supplier assignments; writes only `business_partner_roles`
 *  (+ `main_role_type_id` where it was null), in one transaction. */
export async function runQa6SupplierClassification(
  prisma: PrismaService,
  options: { dryRun: boolean; orgIds?: number[] },
): Promise<Qa6SupplierResult> {
  const dryRun = options.dryRun !== false;
  const [ruleRow, supplierRole] = await Promise.all([
    prisma.projectRoleType.findUnique({
      where: { code: SUPPLIER_CODE },
      select: {
        code: true,
        name: true,
        allowedPartnerKind: true,
        requiredPartnerRoleCode: true,
        requiredProfessionIds: true,
      },
    }),
    prisma.partnerRoleType.findUnique({
      where: { code: SUPPLIER_CODE },
      select: { id: true, code: true, name: true },
    }),
  ]);

  const now = new Date();
  const rows = await prisma.businessPartner.findMany({
    where: { partnerType: 'organization', deletedAt: null },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      displayName: true,
      isHomeOrg: true,
      mainRoleType: { select: { code: true, name: true } },
      roles: { select: { roleType: { select: { code: true } } } },
      professions: { select: { professionId: true } },
      partnerRelationshipsA: {
        where: { type: { code: 'supplier_of' }, validTo: { gt: now } },
        select: { partyB: { select: { id: true, displayName: true } } },
      },
      projectPartnerRoles: {
        where: { role: { code: SUPPLIER_CODE } },
        select: { projectId: true },
      },
    },
  });
  const orgs: SupplierOrgRow[] = rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    isHomeOrg: r.isHomeOrg,
    mainRole: r.mainRoleType ? { code: r.mainRoleType.code, name: r.mainRoleType.name } : null,
    roleCodes: r.roles.map((x) => x.roleType.code),
    professionIds: r.professions.map((x) => x.professionId),
    supplierOf: r.partnerRelationshipsA.map((x) => x.partyB),
    supplierProjectIds: [...new Set(r.projectPartnerRoles.map((x) => x.projectId))].sort((a, b) => a - b),
  }));

  let unknownIds: Array<{ id: number; displayName: string | null; reason: string }> = [];
  if (options.orgIds) {
    const live = new Set(orgs.map((o) => o.id));
    const missing = options.orgIds.filter((id) => !live.has(id));
    if (missing.length > 0) {
      const found = await prisma.businessPartner.findMany({
        where: { id: { in: missing } },
        select: { id: true, displayName: true, partnerType: true, deletedAt: true },
      });
      const byId = new Map(found.map((f) => [f.id, f]));
      unknownIds = missing.map((id) => {
        const f = byId.get(id);
        if (!f) return { id, displayName: null, reason: 'not found' };
        if (f.partnerType !== 'organization') return { id, displayName: f.displayName, reason: 'not an organization' };
        return { id, displayName: f.displayName, reason: 'deleted' };
      });
    }
  }

  const rule: SupplierRule | null = ruleRow;
  const plan = planSupplierClassification({
    orgs,
    rule,
    supplierPartnerRoleExists: !!supplierRole,
    orgIds: options.orgIds,
    unknownIds,
  });

  let written: Qa6SupplierResult['written'] = null;
  if (!dryRun && supplierRole && plan.toClassify.length > 0) {
    const asMain = plan.toClassify.filter((o) => o.setsMainRole).map((o) => o.id);
    const asExtra = plan.toClassify.filter((o) => !o.setsMainRole).map((o) => o.id);
    written = await prisma.$transaction(async (tx) => {
      const a = await tx.businessPartnerRole.createMany({
        data: asMain.map((businessPartnerId) => ({ businessPartnerId, roleTypeId: supplierRole.id, isPrimary: true })),
        skipDuplicates: true,
      });
      const b = await tx.businessPartnerRole.createMany({
        data: asExtra.map((businessPartnerId) => ({ businessPartnerId, roleTypeId: supplierRole.id, isPrimary: false })),
        skipDuplicates: true,
      });
      const m = asMain.length > 0
        ? await tx.businessPartner.updateMany({
            where: { id: { in: asMain }, mainRoleTypeId: null },
            data: { mainRoleTypeId: supplierRole.id },
          })
        : { count: 0 };
      return { rolesCreated: a.count + b.count, mainRoleSet: m.count };
    });
  }

  return {
    dryRun,
    rule: ruleRow ? { ...ruleRow, requiredProfessionIds: profIds(ruleRow) } : null,
    supplierPartnerRole: supplierRole,
    ...plan,
    written,
  };
}
