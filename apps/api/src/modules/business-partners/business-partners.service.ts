import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, PartnerType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { CreateBusinessPartnerDto } from './dto/create-business-partner.dto';
import { UpdateBusinessPartnerDto } from './dto/update-business-partner.dto';
import { QueryBusinessPartnersDto } from './dto/query-business-partners.dto';
import * as Sentry from '@sentry/node';

// BM2 ops-surfaces Phase B (2026-08-13): the compat `toLegacyOutgoing()`
// synth shim is gone. The include below returns the two real arrays
// (`partnerRelationshipsA` + `projectPartnerRoles`) unchanged — every
// consumer that used to read `outgoingRelationships` was migrated in
// Phase A.
const partnerInclude = {
  roles: { include: { roleType: true } },
  // party↔party edges where THIS bp is party A. BUT050 rows.
  partnerRelationshipsA: {
    include: {
      type: true,
      partyB: { select: { id: true, displayName: true, partnerType: true } },
    },
  },
  // project-participation edges where THIS bp is the party.
  projectPartnerRoles: {
    include: {
      role: true,
      project: { select: { id: true, name: true, number: true } },
    },
  },
  // People UX M6 (D1, 2026-09-27) — `email` is now surfaced so the
  // service can compute `isEmployee` per row without a second query.
  // No PII exposure change — the BP payload was already returning the
  // user id/isActive/roleId, and the User.email column is not sensitive
  // in this app (already surfaced across People / Contacts screens).
  user: { select: { id: true, isActive: true, lastLoginAt: true, roleId: true, email: true } },
  // Main Role — single primary categorization of the contact.
  // Surfaced in the drawer header + BP list badge + relationship pickers.
  mainRoleType: true,
  // BM2 QA-2 Commit 4 (2026-08-27) — Discipline classification (Architecture /
  // MEP / Structural / …). Display + search field only; NOT used by the
  // eligibility check on `project_partner_roles`. Surfaced so the Contacts
  // list can group and filter by it without a second round-trip.
  discipline: true,
  // Professions ("Job Titles") the party holds. Surfaced so the Project
  // Role assignment pickers can pre-filter candidates against a role's
  // requiredProfessionIds — without this the dropdown showed every
  // employee and the backend later 400'd on "must hold one of these
  // job titles".
  professions: { select: { professionId: true } },
  // QA4 R2 IMP-9 (2026-09-29) — additional emails beyond the primary
  // `email` column (contacts-import writes generic mailboxes on the
  // org's list and alt-personal addresses on the person's list). The
  // drawer surfaces primary + additional as one clean panel.
  // The whole partnerInclude is `as const` so Prisma keeps the exact
  // return-type narrowing; that recursively marks nested arrays as
  // readonly, which Prisma's orderBy input rejects. `satisfies` here
  // proves the shape without freezing the array.
  emails: {
    select: { id: true, email: true, isPrimary: true, createdAt: true },
    orderBy: [
      { isPrimary: 'desc' },
      { createdAt: 'asc' },
    ] as Prisma.BusinessPartnerEmailOrderByWithRelationInput[],
  },
} as const;

/**
 * BM2 Phase 3 helper — extract the lower-cased domain from an email.
 * Returns null when the email is empty or malformed.
 */
export function extractEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

/**
 * Hard-coded personal / free-email domains (small, ships in code).
 * The Phase 4 admin catalog `personal_email_domains` layers on top:
 * anything in the DB is *also* treated as personal, but the fallback
 * below guarantees the "gmail never binds an org" rule works even
 * when the catalog is empty.
 *
 * BM2 QA-2 Commit 12 (2026-08-30) — extended from 11 → 29 entries to
 * match the Israel-focused seed shipped in the `personal_email_domains`
 * catalog migration. Keep the two lists in sync when adding new hosts:
 * the fallback set is what guarantees the "no auto-match" rule when
 * the catalog is empty (fresh DB, integration tests, offline).
 */
export const PERSONAL_EMAIL_DOMAIN_FALLBACK: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.il',
  'ymail.com',
  'hotmail.com',
  'hotmail.co.il',
  'outlook.com',
  'outlook.co.il',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'yandex.com',
  'mail.com',
  'walla.com',
  'walla.co.il',
  'nana10.co.il',
  'nana.co.il',
  '012.net.il',
  '013.net',
  'bezeqint.net',
  'netvision.net.il',
  'zahav.net.il',
  'actcom.net.il',
  'barak.net.il',
]);

function toDisplayName(dto: { partnerType: PartnerType; firstName?: string | null; lastName?: string | null; companyName?: string | null; displayName?: string | null }): string {
  if (dto.displayName?.trim()) return dto.displayName.trim();
  if (dto.partnerType === 'person') {
    return `${dto.firstName ?? ''} ${dto.lastName ?? ''}`.trim() || '(unnamed)';
  }
  return dto.companyName?.trim() || '(unnamed)';
}

@Injectable()
export class BusinessPartnersService {
  constructor(
    private prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // People UX M6 (P-03 / D1) — home-org resolution.
  //
  // The AMEC organization is marked with `isHomeOrg = true` at the BP
  // row level (see migration 20260927100000_amec_home_org). Every
  // consumer that used to test `displayName === 'Internal'` should
  // instead read `getHomeOrg()` and derive its behaviour from the
  // home org's owned domain list. Renaming the org therefore has no
  // effect on employee classification — that was the entire point of
  // M6.
  //
  // Exactly one BP is expected to carry the flag. If several do
  // (data corruption), we return the lowest id and log a warning via
  // Sentry so a future admin can clean it up.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Return the AMEC home organization + its domains, or null when no
   * BP is flagged. Callers that need only the id/domains can destructure.
   *
   * NOTE: `getHomeOrg` is a hot path (called by every `excludeInternal`
   * query and by the person-payload enrichment). It's cheap — one row
   * with a small include — and the query cache handles repeat calls
   * inside a single request; a full memoisation layer would need
   * cache-busting on domain writes and isn't worth the complexity here.
   */
  async getHomeOrg() {
    const rows = await this.prisma.businessPartner.findMany({
      where: {
        partnerType: 'organization',
        isHomeOrg: true,
        deletedAt: null,
      },
      include: { domains: true },
      orderBy: { id: 'asc' },
      take: 2, // 2 so we notice the "more than one holder" corruption case.
    });
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      Sentry.captureMessage(
        `Multiple BPs carry isHomeOrg=true (ids: ${rows.map((r) => r.id).join(', ')}). ` +
        `Reading the lowest id; admin should demote the others.`,
        'warning',
      );
    }
    return rows[0];
  }

  /**
   * People UX M6 (D1) — pure helper. Given a user email + the list of
   * corporate domains the home org owns, does the email place the user
   * inside AMEC? Domain matching is case-insensitive and anchored to
   * the '@' so "amec.co.il" doesn't match "notamec.co.il".
   *
   * `null`-safe: any missing input short-circuits to `false`, so
   * "no user" and "no email" both classify as external.
   */
  private static emailBelongsToHomeOrg(
    email: string | null | undefined,
    ownedDomains: string[],
  ): boolean {
    if (!email) return false;
    const at = email.indexOf('@');
    if (at < 0 || at === email.length - 1) return false;
    const dom = email.slice(at + 1).trim().toLowerCase();
    return ownedDomains.includes(dom);
  }

  /**
   * People UX M6 (D1) — compute `isEmployee` for a payload row that
   * carries `partnerType` + optional `user.email`. Applied by the
   * findAll/findOne enrichment step so downstream UI reads a single
   * boolean instead of reconstructing the rule.
   */
  private computeIsEmployee(
    row: { partnerType: string; user?: { email?: string | null } | null },
    ownedDomains: string[],
  ): boolean {
    if (row.partnerType !== 'person') return false;
    if (!row.user) return false;
    return BusinessPartnersService.emailBelongsToHomeOrg(row.user.email ?? null, ownedDomains);
  }

  /**
   * People UX M6 (P-03) — enforce the "exactly one home org" invariant
   * at write time. Runs INSIDE a transaction so a caller flipping the
   * flag on a new row can't race with the demote of the previous
   * holder. `exceptId` lets an update re-affirm its own flag without
   * demoting itself.
   */
  private async demoteExistingHomeOrgs(
    tx: Prisma.TransactionClient,
    exceptId?: number,
  ): Promise<void> {
    await tx.businessPartner.updateMany({
      where: {
        isHomeOrg: true,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      data: { isHomeOrg: false },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CRUD
  // ─────────────────────────────────────────────────────────────────────────

  async findAll(query: QueryBusinessPartnersDto) {
    const where: Prisma.BusinessPartnerWhereInput = { deletedAt: null };

    if (query.partnerType) where.partnerType = query.partnerType;
    if (query.status) where.status = query.status;

    if (query.roleType) {
      // QA3 Commit D (Item 6b): when `includeProjectCustomers=true`, the
      // WHERE unions the businessPartnerRole tag match with orgs that
      // appear as `roleType` on any active ProjectPartnerRole. Reason:
      // pre-guard legacy data has orgs used as project customers whose
      // partner-role tag was never set (e.g. אסדן / טקרו / חדיף on
      // staging). The write path was later hardened (projects.create +
      // setProjectCustomer now auto-upsert the tag, see this commit's
      // Item 6b change), so this UNION is the read-side safety net for
      // legacy rows.
      const roleTag = { some: { roleType: { code: query.roleType } } };
      if (query.includeProjectCustomers) {
        const now = new Date();
        const orClause = [
          { roles: roleTag },
          {
            projectPartnerRoles: {
              some: {
                role: { code: query.roleType },
                status: 'active',
                validFrom: { lte: now },
                validTo: { gt: now },
              },
            },
          },
        ];
        // Preserve any pre-existing OR on `where` (currently only `search`
        // sets it later, but be defensive).
        where.OR = where.OR ? [...where.OR, ...orClause] : orClause;
      } else {
        where.roles = roleTag;
      }
    }

    // Employer filter — matches persons whose active worker_of edge
    // targets the given organization id. Uses `some` so a person with
    // multiple employers (rare but allowed) still matches on any of
    // them.
    // BM2 Phase 1 (2026-08-13): reads `partnerRelationshipsA` on the
    // BUT050 table `partner_relationships` — same semantic edge as the
    // pre-cleanup `outgoingRelationships` reader.
    if (query.employerId) {
      where.partnerRelationshipsA = {
        some: {
          partyBId: query.employerId,
          type: { code: 'worker_of' },
          validTo: { gt: new Date() },
        },
      };
    }

    // People UX M6 (P-03 / D1, 2026-09-27) — exclude EMPLOYEES from the
    // set. D1 employee = has a User AND that user's email domain is
    // owned by the AMEC "home org" (see `getHomeOrg` below). This
    // replaces the pre-M6 rule which matched the seeded org's literal
    // display_name = "Internal": that broke the moment the org was
    // renamed to "AMEC" and mis-classified anyone whose worker_of edge
    // still pointed at the legacy row.
    //
    // Two behaviours combined:
    //   1. `user IS NULL`  — no login account at all → definitely NOT an
    //      employee, always kept in the "external" bucket.
    //   2. If a user IS present, keep the row only when the user's email
    //      lives on a domain the home org does NOT own. The list of
    //      owned domains is read from `business_partner_domains` at the
    //      time of the query.
    //
    // Fallback: when the home org isn't set (fresh DB / seed didn't
    // find AMEC / no domains registered), the excludeInternal rule
    // degrades to the strict "user IS NULL" filter — safer to drop
    // authenticated identities than to leak internal staff.
    if (query.excludeInternal) {
      const homeOrg = await this.getHomeOrg();
      const ownedDomains = (homeOrg?.domains ?? [])
        .filter((d) => !d.isPersonal)
        .map((d) => d.domain.toLowerCase());

      if (ownedDomains.length === 0) {
        // No corporate domains claimed by the home org — collapse to
        // "no user account" as a defensive fallback so authenticated
        // identities are never leaked into the externals view even
        // when the seed data is incomplete.
        where.user = { is: null };
      } else {
        // D1 employee = user is present AND user.email ends with
        // "@<owned-domain>". We reject those rows via NOT so the
        // remaining set contains everyone else (no user, or user on a
        // non-owned domain). The leading '@' anchors the match to a
        // real domain boundary — "@amec.co.il" never matches
        // "notamec.co.il".
        const notEmployee: Prisma.BusinessPartnerWhereInput = {
          NOT: {
            AND: [
              { user: { isNot: null } },
              {
                user: {
                  is: {
                    OR: ownedDomains.map((d) => ({ email: { endsWith: `@${d}` } })),
                  },
                },
              },
            ],
          },
        };
        where.AND = [
          ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
          notEmployee,
        ];
      }
    }

    if (query.search) {
      const s = query.search.trim();
      // Bilingual search — see comment in users.service.findAll. The
      // person-name columns (firstName/lastName + Hebrew variants) are
      // included on top of displayName because admins routinely type
      // just the first or last name. (T3.3, 2026-06-28)
      const searchOr = [
        { displayName: { contains: s } },
        { firstName:   { contains: s } },
        { lastName:    { contains: s } },
        { firstNameHe: { contains: s } },
        { lastNameHe:  { contains: s } },
        { email:       { contains: s } },
        { companyName: { contains: s } },
        { phone:       { contains: s } },
        { mobile:      { contains: s } },
      ];
      // QA3 Commit D — if a prior clause already set OR (e.g. the
      // customer-role UNION), fold the two ORs into an AND so both
      // constraints hold. Otherwise the naive assignment used to drop
      // the earlier OR silently.
      if (where.OR) {
        where.AND = [
          ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
          { OR: where.OR },
          { OR: searchOr },
        ];
        delete where.OR;
      } else {
        where.OR = searchOr;
      }
    }

    const page = query.page ?? 1;
    const perPage = query.perPage ?? 50;

    const [data, total] = await Promise.all([
      this.prisma.businessPartner.findMany({
        where,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: [{ partnerType: 'asc' }, { displayName: 'asc' }],
        include: partnerInclude,
      }),
      this.prisma.businessPartner.count({ where }),
    ]);

    // BM2 ops-surfaces Phase B (2026-08-13): no more legacy shim — the
    // include returns partnerRelationshipsA + projectPartnerRoles directly
    // and the frontend consumers read those two arrays.
    const enriched = query.withProjects
      ? await this.attachProjectsForContacts(data as any[])
      : data;

    // People UX M6 (D1) — attach `isEmployee` to each person payload.
    // Only one home-org lookup per request; skipped when the query
    // returned zero rows or when every row is an org.
    const withEmployeeFlag = await this.attachIsEmployee(enriched as any[]);

    return {
      data: withEmployeeFlag,
      meta: { total, page, perPage, totalPages: Math.ceil(total / perPage) },
    };
  }

  /**
   * People UX M6 (D1) — enrich each person payload with an `isEmployee`
   * boolean derived from the home org's owned domain list. Orgs pass
   * through untouched. Cheap: one findFirst for the home org (cached
   * inside `getHomeOrg`) + an in-memory scan.
   */
  private async attachIsEmployee<T extends { id: number; partnerType: string; user?: { email?: string | null } | null }>(
    rows: T[],
  ): Promise<Array<T & { isEmployee?: boolean }>> {
    if (rows.length === 0) return rows as any;
    const hasPerson = rows.some((r) => r.partnerType === 'person');
    if (!hasPerson) return rows as any;
    const homeOrg = await this.getHomeOrg();
    const ownedDomains = (homeOrg?.domains ?? [])
      .filter((d) => !d.isPersonal)
      .map((d) => d.domain.toLowerCase());
    return rows.map((r) =>
      r.partnerType === 'person'
        ? { ...r, isEmployee: this.computeIsEmployee(r, ownedDomains) }
        : r,
    );
  }

  /**
   * For each BP in the page, compute the projects they touch. Two paths:
   *   1. Direct — project_partner_roles rows where party_id = bp.id.
   *      (Project leaders, BIM leads, customer-org wired via partyId, etc.)
   *   2. Indirect via employer — for a person BP that has a worker_of
   *      relationship with an organization, every project where THAT
   *      organization carries the `customer` project role.
   * Results are merged + de-duped per BP, split active vs archived using
   * project.status, and capped to keep the response light.
   */
  private async attachProjectsForContacts<T extends { id: number; partnerType: string; partnerRelationshipsA?: any[] }>(
    partners: T[],
  ): Promise<Array<T & { projectCount: { active: number; archived: number }; projects: Array<{ id: number; name: string; number: string | null; status: string; role: string | null; via: 'direct' | 'employer' }> }>> {
    if (partners.length === 0) return partners as any;

    // Resolve the project role-type id that means "customer", so we know
    // which project_partner_roles indicate an org is the project's customer.
    const customerRole = await this.prisma.projectRoleType.findUnique({
      where: { code: 'customer' },
      select: { id: true },
    });

    // For PERSONS — collect each one's worker_of employer org ids, so we can
    // look up "projects where this org is the customer" in one query.
    // BM2 Phase 1: reads `partnerRelationshipsA` (the raw new-shape include)
    // rather than the compat `outgoingRelationships`, since the compat mixes
    // in project rows we don't want here.
    const employerByPerson = new Map<number, number[]>();
    const allEmployerIds = new Set<number>();
    for (const p of partners) {
      if (p.partnerType !== 'person') continue;
      const employers: number[] = [];
      for (const r of p.partnerRelationshipsA ?? []) {
        if (r?.type?.code === 'worker_of') {
          employers.push(r.partyBId);
          allEmployerIds.add(r.partyBId);
        }
      }
      if (employers.length) employerByPerson.set(p.id, employers);
    }

    // Direct project_partner_roles for every BP in the page.
    const partnerIds = partners.map((p) => p.id);
    const directRoles = await this.prisma.projectPartnerRole.findMany({
      where: {
        partyId: { in: partnerIds },
        validTo: { gt: new Date() },
      },
      include: {
        role: { select: { code: true, name: true } },
        project: { select: { id: true, name: true, number: true, status: true, deletedAt: true } },
      },
    });

    // Indirect — projects where any of the employer orgs are the customer.
    // We restrict to the `customer` role-type to avoid pulling unrelated
    // assignments (e.g. an org happens to also be a supplier on a project).
    const employerCustomerRoles = allEmployerIds.size === 0 || !customerRole
      ? []
      : await this.prisma.projectPartnerRole.findMany({
          where: {
            partyId: { in: Array.from(allEmployerIds) },
            roleId: customerRole.id,
            validTo: { gt: new Date() },
          },
          include: {
            project: { select: { id: true, name: true, number: true, status: true, deletedAt: true } },
          },
        });
    // employerOrgId → projects[]
    const orgProjects = new Map<number, Array<{ id: number; name: string; number: string | null; status: string }>>();
    for (const r of employerCustomerRoles) {
      const p = r.project;
      if (!p || p.deletedAt) continue;
      const arr = orgProjects.get(r.partyId) ?? [];
      arr.push({ id: p.id, name: p.name, number: p.number, status: p.status });
      orgProjects.set(r.partyId, arr);
    }

    type ProjectEntry = { id: number; name: string; number: string | null; status: string; role: string | null; via: 'direct' | 'employer' };
    const ACTIVE_STATUSES = new Set(['active', 'draft', 'on_hold']);

    // Build per-BP project list with dedupe (direct > employer when same id).
    const byBp = new Map<number, Map<number, ProjectEntry>>();
    for (const r of directRoles) {
      const p = r.project;
      if (!p || p.deletedAt) continue;
      const m = byBp.get(r.partyId) ?? new Map<number, ProjectEntry>();
      m.set(p.id, {
        id: p.id, name: p.name, number: p.number, status: p.status,
        role: r.role?.name ?? r.role?.code ?? null,
        via: 'direct',
      });
      byBp.set(r.partyId, m);
    }
    for (const [personId, employers] of employerByPerson) {
      const m = byBp.get(personId) ?? new Map<number, ProjectEntry>();
      for (const orgId of employers) {
        for (const proj of orgProjects.get(orgId) ?? []) {
          if (!m.has(proj.id)) {
            m.set(proj.id, { ...proj, role: 'Customer contact', via: 'employer' });
          }
        }
      }
      if (m.size) byBp.set(personId, m);
    }

    return partners.map((bp) => {
      const projects = Array.from(byBp.get(bp.id)?.values() ?? []);
      let active = 0, archived = 0;
      for (const p of projects) (ACTIVE_STATUSES.has(p.status) ? active++ : archived++);
      // Stable ordering: active first, then by name.
      projects.sort((a, b) => {
        const aActive = ACTIVE_STATUSES.has(a.status) ? 0 : 1;
        const bActive = ACTIVE_STATUSES.has(b.status) ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return a.name.localeCompare(b.name);
      });
      return { ...bp, projectCount: { active, archived }, projects } as any;
    });
  }

  async findOne(id: number) {
    const bp = await this.prisma.businessPartner.findFirst({
      where: { id, deletedAt: null },
      include: partnerInclude,
    });
    if (!bp) throw new NotFoundException('Business partner not found');

    // BM2 Phase 1 (2026-08-13): incoming relationships now read from
    // `partner_relationships` (BUT050 party↔party). "Incoming" = rows
    // where THIS bp is party B; the caller (frontend) still sees the
    // legacy `{ id, sourcePartnerId, sourceName, sourceKind, … }` shape.
    const incoming = await this.prisma.partnerRelationship.findMany({
      where: {
        partyBId: id,
        status: 'active',
      },
      include: {
        type: true,
        partyA: { select: { id: true, partnerType: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // People UX M6 (D1) — enrich single fetch too so drawers can show
    // the "Employee" badge based on the same rule the list uses.
    const [enrichedBp] = await this.attachIsEmployee([bp as any]);

    return {
      ...(enrichedBp as any),
      incomingRelationships: incoming.map((r) => ({
        id: r.id,
        relationshipType: r.type,
        sourcePartnerId: r.partyAId,
        sourceName: r.partyA.displayName,
        sourceKind: r.partyA.partnerType,
        roleInContext: r.titleAtB,
        isPrimary: r.isPrimary,
        validFrom: r.validFrom,
        validTo: r.validTo,
        status: r.status,
        notes: r.notes,
      })),
    };
  }

  async create(dto: CreateBusinessPartnerDto, userId?: number) {
    if (dto.email) {
      // Global uniqueness across all partner_types — caught by DB unique
      // index too, but we want a friendly error.
      const dup = await this.prisma.businessPartner.findFirst({
        where: { email: dto.email, deletedAt: null },
      });
      if (dup) {
        throw new ConflictException(
          `A business partner with email "${dto.email}" already exists (id=${dup.id}). Reuse it instead of creating a duplicate.`,
        );
      }
    }

    if (dto.partnerType === 'organization' && !dto.companyName?.trim() && !dto.displayName?.trim()) {
      throw new BadRequestException('Organization partners require companyName or displayName');
    }
    if (dto.partnerType === 'person' && !dto.firstName?.trim() && !dto.lastName?.trim() && !dto.displayName?.trim()) {
      throw new BadRequestException('Person partners require firstName/lastName or displayName');
    }

    // People UX M6 (P-03) — `isHomeOrg` may only be set on orgs. On
    // persons we silently drop the flag rather than 400 so a UI form
    // that always sends the field can't get stuck.
    const wantsHomeOrg =
      dto.partnerType === 'organization' && dto.isHomeOrg === true;

    const bp = await this.prisma.$transaction(async (tx) => {
      // Demote every previous holder before creating the new one so
      // there's never a window where two rows carry the flag.
      if (wantsHomeOrg) {
        await this.demoteExistingHomeOrgs(tx);
      }
      return tx.businessPartner.create({
        data: {
          partnerType: dto.partnerType,
          displayName: toDisplayName(dto),
          firstName: dto.partnerType === 'person' ? dto.firstName ?? null : null,
          lastName: dto.partnerType === 'person' ? dto.lastName ?? null : null,
          // People UX M2c (P-11 / P-37): Hebrew names are DTO-validated but
          // used to be dropped on the floor here — bilingual search still
          // matched them because the CSV importer wrote directly to the
          // column, but the create-partner-modal's `firstNameHe/lastNameHe`
          // values never survived a POST. Persist them now so the drawer
          // parity edits round-trip cleanly.
          firstNameHe: dto.partnerType === 'person' ? dto.firstNameHe ?? null : null,
          lastNameHe: dto.partnerType === 'person' ? dto.lastNameHe ?? null : null,
          companyName: dto.companyName ?? null,
          taxId: dto.taxId ?? null,
          email: dto.email ?? null,
          phone: dto.phone ?? null,
          mobile: dto.mobile ?? null,
          address: dto.address ?? null,
          website: dto.website ?? null,
          linkedinUrl: dto.linkedinUrl ?? null,
          facebookUrl: dto.facebookUrl ?? null,
          twitterUrl: dto.twitterUrl ?? null,
          instagramUrl: dto.instagramUrl ?? null,
          notes: dto.notes ?? null,
          source: dto.source ?? 'manual',
          mainRoleTypeId: dto.mainRoleTypeId ?? null,
          disciplineId: dto.disciplineId ?? null,
          isHomeOrg: wantsHomeOrg,
          roles:
            dto.initialRoleTypeIds && dto.initialRoleTypeIds.length > 0
              ? {
                  createMany: {
                    data: [...new Set(dto.initialRoleTypeIds)].map((roleTypeId) => ({
                      roleTypeId,
                      isPrimary: false,
                    })),
                    skipDuplicates: true,
                  },
                }
              : undefined,
        },
        include: partnerInclude,
      });
    });

    // A BP's Main Role must also appear in its roles list, otherwise
    // role-based filters (e.g. the project Customer dropdown, which queries
    // `roleType=customer`) won't find it. The Partners UI's Main Role picker
    // used to write only `main_role_type_id`; this sync makes the two
    // representations consistent going forward.
    let finalBp = bp;
    if (dto.mainRoleTypeId) {
      await this.syncMainRoleIntoRoles(bp.id, dto.mainRoleTypeId);
      finalBp = await this.prisma.businessPartner.findUniqueOrThrow({
        where: { id: bp.id },
        include: partnerInclude,
      });
    }

    try {
      await this.activityLog.write({
        category: 'partner',
        action: 'partner.created',
        actorUserId: userId ?? null,
        projectId: null,
        entityType: 'business_partner',
        entityId: finalBp.id,
        entityName: finalBp.displayName,
        description: `Created ${finalBp.partnerType} partner "${finalBp.displayName}"`,
      });
    } catch (e) { Sentry.captureException(e); /* swallow */ }

    return finalBp;
  }

  /**
   * Ensure the BP's Main Role is also present in `business_partner_roles`.
   * Idempotent (upsert on the (businessPartnerId, roleTypeId) unique).
   * No-op when called with a null/undefined roleTypeId.
   */
  private async syncMainRoleIntoRoles(
    businessPartnerId: number,
    roleTypeId: number | null | undefined,
  ): Promise<void> {
    if (!roleTypeId) return;
    await this.prisma.businessPartnerRole.upsert({
      where: {
        businessPartnerId_roleTypeId: { businessPartnerId, roleTypeId },
      },
      create: { businessPartnerId, roleTypeId, isPrimary: true },
      update: { isPrimary: true },
    });
  }

  async update(id: number, dto: UpdateBusinessPartnerDto, userId?: number) {
    const existing = await this.findOne(id);

    if (dto.email && dto.email !== existing.email) {
      const dup = await this.prisma.businessPartner.findFirst({
        where: { email: dto.email, deletedAt: null, id: { not: id } },
      });
      if (dup) {
        throw new ConflictException(
          `Email "${dto.email}" is already used by another business partner (id=${dup.id}).`,
        );
      }
    }

    // Recompute displayName if any of its inputs changed and the caller
    // didn't pass an explicit one.
    const displayName =
      dto.displayName?.trim() ??
      (dto.firstName !== undefined || dto.lastName !== undefined || dto.companyName !== undefined
        ? toDisplayName({
            partnerType: existing.partnerType,
            firstName: dto.firstName ?? existing.firstName,
            lastName: dto.lastName ?? existing.lastName,
            companyName: dto.companyName ?? existing.companyName,
          })
        : undefined);

    // People UX M6 (P-03) — same rule as create: `isHomeOrg` only lives
    // on orgs, and setting it to `true` demotes every other holder
    // inside the same transaction.
    const wantsHomeOrgSet =
      existing.partnerType === 'organization' && dto.isHomeOrg === true;
    const wantsHomeOrgClear =
      existing.partnerType === 'organization' && dto.isHomeOrg === false;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (wantsHomeOrgSet) {
        await this.demoteExistingHomeOrgs(tx, id);
      }
      return tx.businessPartner.update({
        where: { id },
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          // People UX M2c — see create() above. Explicit-undefined leaves
          // the column untouched, so callers that don't touch these fields
          // are unaffected.
          firstNameHe: dto.firstNameHe,
          lastNameHe: dto.lastNameHe,
          companyName: dto.companyName,
          taxId: dto.taxId,
          email: dto.email,
          phone: dto.phone,
          mobile: dto.mobile,
          address: dto.address,
          website: dto.website,
          linkedinUrl: dto.linkedinUrl,
          facebookUrl: dto.facebookUrl,
          twitterUrl: dto.twitterUrl,
          instagramUrl: dto.instagramUrl,
          notes: dto.notes,
          status: dto.status,
          // Main Role — explicit-undefined vs explicit-null matters. If the
          // caller sent the field at all (including null = "clear it"),
          // forward it. If the field is absent from the PATCH body it
          // stays untouched.
          ...(dto.mainRoleTypeId !== undefined ? { mainRoleTypeId: dto.mainRoleTypeId } : {}),
          // Discipline — same explicit-null-vs-undefined pattern.
          ...(dto.disciplineId !== undefined ? { disciplineId: dto.disciplineId } : {}),
          ...(displayName !== undefined ? { displayName } : {}),
          // Home-org flag — only touched when the caller sent it AND
          // the row is an org.
          ...(wantsHomeOrgSet ? { isHomeOrg: true } : {}),
          ...(wantsHomeOrgClear ? { isHomeOrg: false } : {}),
        },
        include: partnerInclude,
      });
    });

    // Keep the Main Role / roles-list invariant in sync — a BP's main role
    // must also live in business_partner_roles so role-based filters (e.g.
    // the project Customer dropdown) see it.
    let finalBp = updated;
    if (dto.mainRoleTypeId) {
      await this.syncMainRoleIntoRoles(id, dto.mainRoleTypeId);
      finalBp = await this.prisma.businessPartner.findUniqueOrThrow({
        where: { id },
        include: partnerInclude,
      });
    }

    try {
      const changedFields = Object.keys(dto).filter((k) => k in dto);
      await this.activityLog.write({
        category: 'partner',
        action: 'partner.updated',
        actorUserId: userId ?? null,
        projectId: null,
        entityType: 'business_partner',
        entityId: finalBp.id,
        entityName: finalBp.displayName,
        description: `Updated partner "${finalBp.displayName}"` +
          (changedFields.length ? ` — ${changedFields.join(', ')}` : ''),
      });
    } catch (e) { Sentry.captureException(e); /* swallow */ }

    return finalBp;
  }

  /**
   * Soft delete. We deliberately do NOT cascade out to BPs that have an
   * attached User row — block that path so callers don't accidentally make
   * a live login user orphaned. The user can be deleted first via
   * /users/:id, which nulls business_partner_id on the User side.
   */
  async remove(id: number, userId?: number) {
    const bp = await this.prisma.businessPartner.findFirst({
      where: { id, deletedAt: null },
      include: { user: { select: { id: true, isActive: true } } },
    });
    if (!bp) throw new NotFoundException('Business partner not found');
    if (bp.user) {
      throw new BadRequestException(
        `This business partner is linked to a login user (user id=${bp.user.id}). Deactivate the user first, or delete the user to detach.`,
      );
    }
    await this.prisma.businessPartner.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    try {
      await this.activityLog.write({
        category: 'partner',
        action: 'partner.deleted',
        actorUserId: userId ?? null,
        projectId: null,
        entityType: 'business_partner',
        entityId: id,
        entityName: bp.displayName,
        description: `Deleted ${bp.partnerType} partner "${bp.displayName}"`,
        severity: 'warn',
      });
    } catch (e) { Sentry.captureException(e); /* swallow */ }

    return { message: 'Business partner removed' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Role management
  // ─────────────────────────────────────────────────────────────────────────

  async addRole(bpId: number, roleTypeId: number, isPrimary = false) {
    await this.findOne(bpId); // existence check + 404
    const roleType = await this.prisma.partnerRoleType.findUnique({ where: { id: roleTypeId } });
    if (!roleType) throw new NotFoundException('Role type not found');

    return this.prisma.businessPartnerRole.upsert({
      where: { businessPartnerId_roleTypeId: { businessPartnerId: bpId, roleTypeId } },
      update: { isPrimary },
      create: { businessPartnerId: bpId, roleTypeId, isPrimary },
      include: { roleType: true },
    });
  }

  async removeRole(bpId: number, roleId: number) {
    const role = await this.prisma.businessPartnerRole.findFirst({
      where: { id: roleId, businessPartnerId: bpId },
    });
    if (!role) throw new NotFoundException('Role not found on this partner');
    await this.prisma.businessPartnerRole.delete({ where: { id: roleId } });
    return { message: 'Role removed' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // M4a.3 — Job Title (Profession) management
  // ─────────────────────────────────────────────────────────────────────────

  /** List a partner's current job titles, with their primary flag. */
  async listProfessions(bpId: number) {
    await this.findOne(bpId);
    return this.prisma.businessPartnerProfession.findMany({
      where: { businessPartnerId: bpId },
      include: { profession: true },
      orderBy: [{ isPrimary: 'desc' }, { profession: { sortOrder: 'asc' } }],
    });
  }

  /**
   * Replace the partner's full job-title list with the given set. Adds new
   * ones, removes the dropped ones, and marks `primaryProfessionId` as the
   * primary (clearing isPrimary on the rest). Set-semantics: callers send
   * the desired final state and the service diffs.
   */
  async setProfessions(
    bpId: number,
    professionIds: number[],
    primaryProfessionId: number | null,
  ) {
    await this.findOne(bpId);

    // Sanity: every desired id must reference an existing profession.
    if (professionIds.length > 0) {
      const existing = await this.prisma.profession.findMany({
        where: { id: { in: professionIds } },
        select: { id: true },
      });
      const known = new Set(existing.map((p) => p.id));
      const missing = professionIds.filter((id) => !known.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(`Unknown profession id(s): ${missing.join(', ')}`);
      }
    }
    if (primaryProfessionId != null && !professionIds.includes(primaryProfessionId)) {
      throw new BadRequestException(
        'primaryProfessionId must be included in professionIds',
      );
    }

    const current = await this.prisma.businessPartnerProfession.findMany({
      where: { businessPartnerId: bpId },
      select: { id: true, professionId: true, isPrimary: true },
    });
    const currentIds = new Set(current.map((c) => c.professionId));
    const desiredIds = new Set(professionIds);

    const toAdd = professionIds.filter((id) => !currentIds.has(id));
    const toRemove = current.filter((c) => !desiredIds.has(c.professionId));

    await this.prisma.$transaction(async (tx) => {
      if (toRemove.length > 0) {
        await tx.businessPartnerProfession.deleteMany({
          where: { id: { in: toRemove.map((r) => r.id) } },
        });
      }
      for (const profId of toAdd) {
        await tx.businessPartnerProfession.create({
          data: {
            businessPartnerId: bpId,
            professionId: profId,
            isPrimary: profId === primaryProfessionId,
          },
        });
      }
      // Re-sync isPrimary on remaining rows.
      await tx.businessPartnerProfession.updateMany({
        where: { businessPartnerId: bpId },
        data: { isPrimary: false },
      });
      if (primaryProfessionId != null) {
        await tx.businessPartnerProfession.updateMany({
          where: { businessPartnerId: bpId, professionId: primaryProfessionId },
          data: { isPrimary: true },
        });
      }
    });

    return this.listProfessions(bpId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BM2 Phase D (2026-08-13) — org domain CRUD
  // A BP (org) can own multiple domains; the import de-dup matches
  // by-domain first. The drawer exposes list / add / delete via the
  // endpoints below.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List every domain owned by this BP. Ordered by domain asc so the
   * drawer renders a stable list.
   */
  async listDomains(bpId: number) {
    await this.findOne(bpId); // 404 + implicit soft-delete filter
    return this.prisma.businessPartnerDomain.findMany({
      where: { partnerId: bpId },
      orderBy: { domain: 'asc' },
    });
  }

  /**
   * Add a domain to an ORG BP. Persons don't own domains — the drawer
   * hides the section for them; we defend the endpoint anyway. Normalises
   * to lowercase + trims whitespace so "  Example.COM  " collapses to
   * "example.com" (matches the shape stored elsewhere and picked up by
   * `resolveOrgByDomainOrName` / `extractEmailDomain`).
   *
   * BM2 QA-2 Commit 12 (2026-08-30) — personal / free-email domains
   * (gmail.com, yahoo.co.il, walla.co.il, …) are ALLOWED. They are
   * marked `is_personal = true` and DO NOT bind an org for import
   * dedup / email→org auto-matching (`resolveOrgByDomainOrName` and
   * dedup.service both skip personal domains up-front). At the DB
   * level the exclusivity is now a MySQL 8 functional unique index on
   * `IF(is_personal=0, domain, NULL)`, so personal rows all collapse
   * to NULL and can be duplicated across orgs. A separate compound
   * `UNIQUE(partner_id, domain)` still prevents the SAME org from
   * listing the SAME domain twice.
   *
   * P2002 error surface after the change:
   *   • Compound (partner_id, domain) — same org, duplicate row.
   *     Message: "already attached to this partner".
   *   • Functional (non-personal) — a different org already claims
   *     this corporate domain. Message names the owner (unchanged).
   */
  async addDomain(bpId: number, rawDomain: string, userId?: number) {
    const bp = await this.findOne(bpId);
    if (bp.partnerType !== 'organization') {
      throw new BadRequestException(
        `Domains can only be attached to organization BPs; this one is a ${bp.partnerType}.`,
      );
    }
    const domain = (rawDomain ?? '').trim().toLowerCase();
    if (!domain) {
      throw new BadRequestException('Domain is required');
    }
    // Very light shape check — a strict RFC-compliant validator would
    // reject too many legitimate short/long TLDs we see in the wild.
    // The 255 cap matches the schema's VARCHAR(255) column.
    if (domain.length > 255 || !/^[a-z0-9][a-z0-9-.]*\.[a-z]{2,}$/i.test(domain)) {
      throw new BadRequestException(
        `"${domain}" doesn't look like a domain (expected e.g. example.com).`,
      );
    }
    // Detect personal at write time via the same helper used by the
    // resolver (fallback set OR catalog). Persist as a boolean so
    // downstream reads never have to re-consult the list.
    const isPersonal = await this.isPersonalDomain(domain);
    try {
      const created = await this.prisma.businessPartnerDomain.create({
        data: { partnerId: bpId, domain, isPersonal },
      });
      try {
        await this.activityLog.write({
          category: 'partner',
          action: 'partner.domain.added',
          actorUserId: userId ?? null,
          projectId: null,
          entityType: 'business_partner_domain',
          entityId: created.id,
          entityName: domain,
          description: `Attached ${isPersonal ? 'personal ' : ''}domain "${domain}" to partner "${bp.displayName}"`,
          metadata: { partnerId: bpId, domain, isPersonal },
        });
      } catch (e) { Sentry.captureException(e); /* swallow */ }
      return created;
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Same-org duplicate — compound (partner_id, domain) unique.
        const sameOrg = await this.prisma.businessPartnerDomain.findFirst({
          where: { partnerId: bpId, domain },
          select: { id: true },
        });
        if (sameOrg) {
          throw new ConflictException(
            `Domain "${domain}" is already attached to this partner.`,
          );
        }
        // Cross-org conflict on a NON-personal domain. Report which BP
        // owns it so the operator can go merge/reassign. Personal
        // domains cannot reach this branch (the functional index maps
        // them to NULL) but we guard defensively.
        const existing = await this.prisma.businessPartnerDomain.findFirst({
          where: { domain, isPersonal: false },
          include: { partner: { select: { id: true, displayName: true } } },
        });
        if (existing) {
          throw new ConflictException(
            `Domain "${domain}" is already owned by ${existing.partner.displayName} (BP id=${existing.partner.id}).`,
          );
        }
        throw new ConflictException(`Domain "${domain}" is already registered.`);
      }
      throw err;
    }
  }

  /**
   * Remove a domain from a BP. 404 if the domain row isn't owned by
   * this BP (defensive — prevents "detach any domain if you know its id").
   */
  async removeDomain(bpId: number, domainId: number, userId?: number) {
    const row = await this.prisma.businessPartnerDomain.findFirst({
      where: { id: domainId, partnerId: bpId },
      include: { partner: { select: { displayName: true } } },
    });
    if (!row) throw new NotFoundException('Domain not found on this partner');
    await this.prisma.businessPartnerDomain.delete({ where: { id: domainId } });

    try {
      await this.activityLog.write({
        category: 'partner',
        action: 'partner.domain.removed',
        actorUserId: userId ?? null,
        projectId: null,
        entityType: 'business_partner_domain',
        entityId: domainId,
        entityName: row.domain,
        description: `Detached domain "${row.domain}" from partner "${row.partner.displayName}"`,
        metadata: { partnerId: bpId, domain: row.domain },
      });
    } catch (e) { Sentry.captureException(e); /* swallow */ }

    return { message: 'Domain removed' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BM2 Phase 3 — org dedup (domain-first)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Resolve an existing organization BP by (in order):
   *   1. Any owned domain matching the email's domain — unless the domain
   *      is a personal / free-email domain (see `isPersonalDomain`).
   *   2. Normalized company name (case-insensitive, trimmed).
   * Returns `null` if nothing matches. Used by the importer and by any
   * future add-BP flow to prevent silent duplicates.
   */
  async resolveOrgByDomainOrName(input: {
    email?: string;
    companyName?: string;
  }): Promise<{ id: number; reason: 'domain' | 'name' } | null> {
    const emailDomain = input.email ? extractEmailDomain(input.email) : null;
    if (emailDomain && !(await this.isPersonalDomain(emailDomain))) {
      // BM2 QA-2 Commit 12 (2026-08-30) — `domain` is no longer a
      // top-level @unique field (the exclusivity migration replaced
      // it with a MySQL 8 functional partial index + a compound
      // partner_id+domain unique). Use findFirst with an explicit
      // is_personal=false filter — cheap defense in depth against a
      // catalog/fallback drift that would otherwise let a personal
      // row become an org match here.
      const domainRow = await this.prisma.businessPartnerDomain.findFirst({
        where: { domain: emailDomain, isPersonal: false },
        include: { partner: { select: { id: true, deletedAt: true } } },
      });
      if (domainRow?.partner && !domainRow.partner.deletedAt) {
        return { id: domainRow.partner.id, reason: 'domain' };
      }
    }
    const normalized = input.companyName?.trim();
    if (normalized) {
      const nameHit = await this.prisma.businessPartner.findFirst({
        where: {
          partnerType: 'organization',
          deletedAt: null,
          companyName: { equals: normalized },
        },
      });
      if (nameHit) return { id: nameHit.id, reason: 'name' };
    }
    return null;
  }

  /**
   * BM2 Phase 3 / Phase 4 — personal-email domain check.
   * Phase 3 falls back to a small hard-coded set below.
   * Phase 4 adds a `personal_email_domains` admin-managed table and
   * `isPersonalDomain` is re-plumbed to consult it (see `isPersonalDomainDb`).
   */
  private async isPersonalDomain(domain: string): Promise<boolean> {
    const normalized = domain.toLowerCase();
    if (PERSONAL_EMAIL_DOMAIN_FALLBACK.has(normalized)) return true;
    return this.isPersonalDomainDb(normalized);
  }

  /**
   * BM2 Phase 4 (2026-08-13) — consults the admin-managed
   * `personal_email_domains` catalog. Combined via OR with the
   * hard-coded fallback set so removing a fallback entry from the
   * catalog does not accidentally start binding gmail addresses to
   * orgs.
   */
  protected async isPersonalDomainDb(domain: string): Promise<boolean> {
    const row = await this.prisma.personalEmailDomain.findUnique({
      where: { domain },
    });
    return !!row;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CSV import
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Parse + import a CSV. Expected columns (case-insensitive, any order):
   *   partner_type   — 'person' | 'organization' (required)
   *   first_name     — for persons
   *   last_name      — for persons
   *   company_name   — for organizations (or person's employer)
   *   tax_id
   *   email
   *   phone
   *   mobile
   *   address
   *   website
   *   notes
   *   roles          — comma-separated role codes (e.g. "employee,consultant")
   *
   * Empty rows are skipped. Rows with parse errors are reported but don't
   * abort the import — successful rows still commit (each row in its own tx).
   */
  async importFromCsv(
    csvBuffer: Buffer,
    options: { skipExisting?: boolean; dryRun?: boolean; userEmail?: string } = {},
  ): Promise<{
    summary: { total: number; created: number; skipped: number; errors: number };
    errors: { row: number; reason: string }[];
    created: { row: number; id: number; displayName: string }[];
  }> {
    const text = csvBuffer.toString('utf8').replace(/^﻿/, ''); // strip BOM
    const rows = this.parseCsv(text);
    if (rows.length === 0) {
      return { summary: { total: 0, created: 0, skipped: 0, errors: 0 }, errors: [], created: [] };
    }

    const header = rows[0].map((h) => h.trim().toLowerCase());
    const required = ['partner_type'];
    for (const col of required) {
      if (!header.includes(col)) {
        throw new BadRequestException(`CSV must include a "${col}" column. Found: ${header.join(', ')}`);
      }
    }

    const idx = (col: string) => header.indexOf(col);
    const get = (row: string[], col: string) => {
      const i = idx(col);
      return i >= 0 ? (row[i] ?? '').trim() : '';
    };

    // Pre-load role types so we can validate "roles" cells
    const roleTypes = await this.prisma.partnerRoleType.findMany();
    const roleTypeByCode = new Map(roleTypes.map((rt) => [rt.code, rt.id]));

    const errors: { row: number; reason: string }[] = [];
    const created: { row: number; id: number; displayName: string }[] = [];
    let skipped = 0;

    for (let i = 1; i < rows.length; i++) {
      const rowNum = i + 1; // 1-based, with header on line 1
      const row = rows[i];
      if (row.every((cell) => !cell?.trim())) continue;

      const partnerType = get(row, 'partner_type').toLowerCase();
      if (partnerType !== 'person' && partnerType !== 'organization') {
        errors.push({ row: rowNum, reason: `partner_type must be "person" or "organization" (got "${partnerType}")` });
        continue;
      }

      const email = get(row, 'email') || null;
      const firstName = get(row, 'first_name') || null;
      const lastName = get(row, 'last_name') || null;
      const companyName = get(row, 'company_name') || null;

      // Basic per-type validation
      if (partnerType === 'person' && !firstName && !lastName) {
        errors.push({ row: rowNum, reason: 'Person requires first_name or last_name' });
        continue;
      }
      if (partnerType === 'organization' && !companyName) {
        errors.push({ row: rowNum, reason: 'Organization requires company_name' });
        continue;
      }

      // BM2 Phase 3 (2026-08-13) — dedup rules for import.
      // Rule 1: for ORG rows, match by owned domain first, then by
      //         normalized companyName (see `resolveOrgByDomainOrName`).
      // Rule 2: for PERSON rows, we still dedupe by email — but the
      //         email is not identity anymore (@unique dropped), so a
      //         match here surfaces as "already exists" instead of a
      //         hard DB constraint violation.
      // Rule 3: personal-domain rows (Phase 4) never bind an org; the
      //         importer skips domain resolution for those.
      if (partnerType === 'organization' && (email || companyName)) {
        const existing = await this.resolveOrgByDomainOrName({
          email: email ?? undefined,
          companyName: companyName ?? undefined,
        });
        if (existing) {
          if (options.skipExisting) {
            skipped++;
            continue;
          }
          errors.push({
            row: rowNum,
            reason: `Organization "${companyName ?? email}" matches an existing BP (id=${existing.id}, ${existing.reason})`,
          });
          continue;
        }
      } else if (partnerType === 'person' && email) {
        const dup = await this.prisma.businessPartner.findFirst({
          where: { email, deletedAt: null, partnerType: 'person' },
        });
        if (dup) {
          if (options.skipExisting) {
            skipped++;
            continue;
          }
          errors.push({ row: rowNum, reason: `Person with email "${email}" already exists (id=${dup.id})` });
          continue;
        }
      }

      // Parse role codes
      const rolesCell = get(row, 'roles');
      const roleIds: number[] = [];
      if (rolesCell) {
        const codes = rolesCell.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        for (const code of codes) {
          const id = roleTypeByCode.get(code);
          if (id) roleIds.push(id);
          else errors.push({ row: rowNum, reason: `Unknown role code "${code}" — skipped` });
        }
      }

      if (options.dryRun) {
        created.push({ row: rowNum, id: -1, displayName: this.computeDisplay({ partnerType, firstName, lastName, companyName }) });
        continue;
      }

      try {
        const bp = await this.prisma.businessPartner.create({
          data: {
            partnerType: partnerType as any,
            displayName: this.computeDisplay({ partnerType, firstName, lastName, companyName }),
            firstName,
            lastName,
            companyName,
            taxId: get(row, 'tax_id') || null,
            email,
            phone: get(row, 'phone') || null,
            mobile: get(row, 'mobile') || null,
            address: get(row, 'address') || null,
            website: get(row, 'website') || null,
            notes: get(row, 'notes') || null,
            source: 'import',
            roles:
              roleIds.length > 0
                ? {
                    createMany: {
                      data: [...new Set(roleIds)].map((roleTypeId) => ({ roleTypeId, isPrimary: false })),
                      skipDuplicates: true,
                    },
                  }
                : undefined,
          },
        });
        created.push({ row: rowNum, id: bp.id, displayName: bp.displayName });
      } catch (err: any) {
        errors.push({ row: rowNum, reason: err?.message ?? 'Unknown error' });
      }
    }

    return {
      summary: {
        total: rows.length - 1,
        created: created.length,
        skipped,
        errors: errors.length,
      },
      errors,
      created,
    };
  }

  // RFC4180-ish CSV parser — handles quoted fields with embedded commas,
  // escaped quotes ("" → "), and CRLF or LF line endings.
  private parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          field += ch;
        }
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
        continue;
      }
      if (ch === ',') {
        row.push(field);
        field = '';
        continue;
      }
      if (ch === '\r') {
        if (next === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        continue;
      }
      if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        continue;
      }
      field += ch;
    }
    if (field !== '' || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  private computeDisplay(o: { partnerType: string; firstName?: string | null; lastName?: string | null; companyName?: string | null }): string {
    if (o.partnerType === 'person') {
      return `${o.firstName ?? ''} ${o.lastName ?? ''}`.trim() || '(unnamed)';
    }
    return o.companyName?.trim() || '(unnamed)';
  }
}
