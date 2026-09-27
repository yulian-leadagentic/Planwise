import type { Prisma } from '@prisma/client';

// QA3 round-5 · single-source-of-truth for role eligibility.
//
// A ProjectRoleType enforces three orthogonal rules on parties who may
// hold it:
//   1. allowedPartnerKind    — the party must be that kind (person /
//      organization / any).
//   2. requiredPartnerRoleCode — the party must hold that partner-role
//      code (e.g. "employee") via BusinessPartnerRole → ProjectRoleType.
//   3. requiredProfessionIds — the party must hold at least one of the
//      listed Profession ids ("Job Title").
//
// The write path (`project-partner-roles.service.create` :117–146)
// enforced all three, but the two pickers each enforced only PART, so
// ineligible people appeared in the picker and then 400'd on submit.
// This helper builds one Prisma `where` clause that mirrors all three
// checks so any picker using it can never show a party the write path
// would reject.

export interface EligibilityRule {
  allowedPartnerKind: string | null;
  requiredPartnerRoleCode: string | null;
  requiredProfessionIds: number[];
}

/** Extract the eligibility rule from a ProjectRoleType row. Handles
 *  the JSON-column shape of `requiredProfessionIds`. */
export function extractEligibilityRule(role: {
  allowedPartnerKind: string | null;
  requiredPartnerRoleCode: string | null;
  requiredProfessionIds: unknown;
}): EligibilityRule {
  return {
    allowedPartnerKind: role.allowedPartnerKind,
    requiredPartnerRoleCode: role.requiredPartnerRoleCode,
    requiredProfessionIds: Array.isArray(role.requiredProfessionIds)
      ? (role.requiredProfessionIds as number[])
      : [],
  };
}

/** Prisma `where` clause matching every business partner the write path
 *  would accept for the given role. Callers add their own `.select` +
 *  `.orderBy`. Empty rule (no kind constraint, no required role, no
 *  required professions) yields just `{ deletedAt: null }` — the
 *  "everyone" bag. */
export function buildEligibleWhere(rule: EligibilityRule): Prisma.BusinessPartnerWhereInput {
  const where: Prisma.BusinessPartnerWhereInput = { deletedAt: null };
  const kind = rule.allowedPartnerKind ?? 'any';
  if (kind === 'person' || kind === 'organization') {
    where.partnerType = kind;
  }
  if (rule.requiredProfessionIds.length > 0) {
    where.professions = {
      some: { professionId: { in: rule.requiredProfessionIds } },
    };
  }
  if (rule.requiredPartnerRoleCode) {
    where.roles = {
      some: { roleType: { code: rule.requiredPartnerRoleCode } },
    };
  }
  return where;
}
