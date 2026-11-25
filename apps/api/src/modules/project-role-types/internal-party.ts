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
