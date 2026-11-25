import type { ProjectRoleTypeRow } from './types';

/* QA6 BM2-4 (2026-11-25) — organization-first picking for EXTERNAL
   project roles (Engineer, Architect, External Contact, Supplier …).

   Before: Team › Add person › <external role> listed every party in one
   flat <select> (178 of 252 on staging), AMEC staff included. Now the
   operator picks the organization first and then one of ITS contacts;
   the API call carries `excludeInternal=true`, so the home org and its
   people never show up for these roles.

   The pure helpers live here (not in the picker component) so the
   predicate and the grouping are unit-tested on their own. */

/** Row shape of `GET /admin/project-role-types/:code/eligible-parties`. */
export interface EligibleParty {
  id: number;
  userId: number | null;
  partnerType: 'person' | 'organization';
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  avatarUrl: string | null;
  position: string | null;
  department: string | null;
  /** Active `worker_of` employers (people only; older APIs omit it). */
  employers?: Array<{ id: number; displayName: string }>;
  eligible: boolean;
  reasons: string[];
}

/** Roles that staff the project with company employees. Everything else
 *  is an external role and gets the organization-first flow. */
const INTERNAL_ROLE_CODES = new Set(['participant', 'team_leader']);

/**
 * Is this an EXTERNAL project role, i.e. one held by an outside party?
 *
 * Internal when any of these holds:
 *   • the code is `participant` or `team_leader` (company staff roles);
 *   • it requires the `employee` partner-role;
 *   • it requires a Qualification (`requiredProfessionIds`): since the
 *     QA4 Position / Qualification split those gate functional staff
 *     roles (BIM Manager, Team Leader …) that AMEC people hold, so
 *     hiding AMEC from them would empty the list.
 * Otherwise external: Engineer, Architect, Inspector, External Contact,
 * Supplier, Customer, and any admin-made role without those gates.
 */
export function isExternalProjectRole(
  role: Pick<ProjectRoleTypeRow, 'code' | 'requiredPartnerRoleCode' | 'requiredProfessionIds'>,
): boolean {
  if (INTERNAL_ROLE_CODES.has(role.code)) return false;
  if (role.requiredPartnerRoleCode === 'employee') return false;
  const profs = Array.isArray(role.requiredProfessionIds) ? role.requiredProfessionIds : [];
  return profs.length === 0;
}

export interface OrgOption {
  id: number;
  displayName: string;
  /** The organization itself can hold the role (kind allows it and it
   *  passed the role's checks). */
  selfEligible: boolean;
  /** Eligible people with an active worker_of edge to this org. */
  contactCount: number;
}

/** `<select>` value for the "no organization" bucket. Matches the API's
 *  `organizationId=none`. */
export const NO_ORG_KEY = 'none';

/**
 * Step 1 of the flow: the organizations to choose from, built from the
 * (already AMEC-free) eligible-parties payload.
 *   • an eligible organization row is listed (it can hold the role);
 *   • every employer of an eligible person is listed, so person-only
 *     roles still reach their people through the organization.
 * `independentCount` = eligible people with no employer at all; the
 * picker offers them under "No organization".
 * Sorted by name with Hebrew collation (Hebrew names first, then
 * English, case-insensitive).
 */
export function buildOrgOptions(candidates: EligibleParty[]): {
  orgs: OrgOption[];
  independentCount: number;
} {
  const byId = new Map<number, OrgOption>();
  const ensure = (id: number, displayName: string): OrgOption => {
    let o = byId.get(id);
    if (!o) {
      o = { id, displayName, selfEligible: false, contactCount: 0 };
      byId.set(id, o);
    }
    return o;
  };
  let independentCount = 0;
  for (const c of candidates) {
    if (!c.eligible) continue;
    if (c.partnerType === 'organization') {
      ensure(c.id, c.displayName).selfEligible = true;
      continue;
    }
    const employers = c.employers ?? [];
    if (employers.length === 0) {
      independentCount += 1;
      continue;
    }
    for (const e of employers) ensure(e.id, e.displayName).contactCount += 1;
  }
  const orgs = Array.from(byId.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName, ['he', 'en'], { sensitivity: 'base' }),
  );
  return { orgs, independentCount };
}

/** Option label for an organization in step 1. */
export function orgOptionLabel(o: OrgOption): string {
  if (o.contactCount === 0) return o.displayName;
  return `${o.displayName} (${o.contactCount} ${o.contactCount === 1 ? 'contact' : 'contacts'})`;
}
