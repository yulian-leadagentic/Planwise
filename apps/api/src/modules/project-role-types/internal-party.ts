// QA6 BM2-4 (2026-11-25) — "is this party AMEC?" for the eligible-
// parties picker. External project roles (Engineer, External Contact,
// Supplier …) must never offer the home organization or its staff.
//
// The rule mirrors the D1 employee rule the rest of the app uses
// (`BusinessPartnersService.computeIsEmployee` + the `excludeInternal`
// filter on /business-partners), plus the employer edge:
//
//   • organization → internal when it IS the home org (`isHomeOrg`).
//   • person       → internal when
//       - it has an active `worker_of` edge to the home org, OR
//       - it has a login User whose email domain is owned by the home
//         org (D1).
//     When the home org owns no corporate domain (fresh DB, incomplete
//     seed), any person WITH a login User counts as internal: the same
//     defensive fallback as `excludeInternal` (never leak staff into an
//     external list because the seed is incomplete).
//
// Pure and synchronous so the controller spec can pin it without a DB.

export interface HomeOrgContext {
  /** The home org's BP id, or null when no org carries `isHomeOrg`. */
  homeOrgId: number | null;
  /** Lower-cased corporate (non-personal) domains owned by the home org. */
  ownedDomains: string[];
}

export interface PartyForInternalCheck {
  id: number;
  partnerType: string;
  user?: { email?: string | null } | null;
  /** Ids of the organizations this person has an active worker_of edge to. */
  employerIds: number[];
}

function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

export function isInternalParty(party: PartyForInternalCheck, ctx: HomeOrgContext): boolean {
  if (party.partnerType === 'organization') {
    return ctx.homeOrgId != null && party.id === ctx.homeOrgId;
  }
  if (ctx.homeOrgId != null && party.employerIds.includes(ctx.homeOrgId)) return true;
  if (!party.user) return false;
  if (ctx.ownedDomains.length === 0) return true;
  const dom = emailDomain(party.user.email ?? null);
  return dom != null && ctx.ownedDomains.includes(dom);
}

/** `organizationId` query value: a positive org id, or `none` for people
 *  with no active employer. `undefined` = no organization filter. */
export type OrganizationFilter = number | 'none' | undefined;

/** Parse the `organizationId` query param. Returns `null` for a malformed
 *  value so the caller can 400 instead of silently widening the list. */
export function parseOrganizationFilter(raw: unknown): OrganizationFilter | null {
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v === 'none') return 'none';
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Truthy query flag (`1`, `true`, `yes`, `on`), same convention as the
 *  admin backfills' `dryRun` query param. */
export function parseQueryFlag(raw: unknown): boolean {
  return typeof raw === 'string' && ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

// ─── QA6 security review (2026-11-25): enforced on the write path ─────

/** Roles that staff the project with company employees (same set as the web picker). */
const INTERNAL_ROLE_CODES = new Set(['participant', 'team_leader']);

/**
 * Is this an EXTERNAL project role, i.e. one held by an outside party?
 * The same definition as the web picker's `isExternalProjectRole`
 * (role-org-first.ts, BM2-4 / 58a84db). Internal when any holds:
 *   • the code is `participant` or `team_leader`;
 *   • it requires the `employee` partner-role;
 *   • it requires a Qualification (`requiredProfessionIds` non-empty).
 * Everything else (Engineer, Architect, Inspector, External Contact,
 * Supplier, Customer …) is external.
 */
export function isExternalProjectRole(role: {
  code: string;
  requiredPartnerRoleCode?: string | null;
  requiredProfessionIds?: unknown;
}): boolean {
  if (INTERNAL_ROLE_CODES.has(role.code)) return false;
  if (role.requiredPartnerRoleCode === 'employee') return false;
  const profs = Array.isArray(role.requiredProfessionIds) ? role.requiredProfessionIds : [];
  return profs.length === 0;
}

/** The slice of Prisma the loaders below read (PrismaService or a transaction client). */
interface BusinessPartnerReader {
  businessPartner: {
    findFirst(args: any): Promise<any>;
    findMany(args: any): Promise<any[]>;
  };
}

/** The home org and its corporate domains, as the eligible-parties picker resolves them. */
export async function loadHomeOrgContext(prisma: BusinessPartnerReader): Promise<HomeOrgContext> {
  const home = await prisma.businessPartner.findFirst({
    where: { partnerType: 'organization', isHomeOrg: true, deletedAt: null },
    orderBy: { id: 'asc' },
    select: { id: true, domains: { select: { domain: true, isPersonal: true } } },
  });
  return {
    homeOrgId: home?.id ?? null,
    ownedDomains: ((home?.domains ?? []) as Array<{ domain: string; isPersonal: boolean }>)
      .filter((d) => !d.isPersonal)
      .map((d) => d.domain.toLowerCase()),
  };
}

/**
 * The parties among `partyIds` that are the home org or its people
 * (`isInternalParty`), with their display names. Unknown ids are left
 * to the caller's own not-found checks.
 */
export async function findInternalParties(
  prisma: BusinessPartnerReader,
  partyIds: Array<number | null | undefined>,
  ctx: HomeOrgContext,
): Promise<Array<{ id: number; displayName: string; partnerType: string }>> {
  const ids = [...new Set(partyIds.filter((id): id is number => Number.isInteger(id) && (id as number) > 0))];
  if (ids.length === 0) return [];
  const rows = await prisma.businessPartner.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      partnerType: true,
      displayName: true,
      user: { select: { email: true } },
      partnerRelationshipsA: {
        where: {
          type: { code: 'worker_of' },
          validTo: { gt: new Date() },
          partyB: { deletedAt: null, partnerType: 'organization' },
        },
        select: { partyBId: true },
      },
    },
  });
  return rows
    .filter((p: any) =>
      isInternalParty(
        {
          id: p.id,
          partnerType: p.partnerType,
          user: p.user ?? null,
          employerIds: p.partnerType === 'person' ? (p.partnerRelationshipsA ?? []).map((r: any) => r.partyBId) : [],
        },
        ctx,
      ),
    )
    .map((p: any) => ({ id: p.id, displayName: p.displayName, partnerType: p.partnerType }));
}
