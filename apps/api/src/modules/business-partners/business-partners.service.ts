import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, PartnerType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateBusinessPartnerDto } from './dto/create-business-partner.dto';
import { UpdateBusinessPartnerDto } from './dto/update-business-partner.dto';
import { QueryBusinessPartnersDto } from './dto/query-business-partners.dto';

const partnerInclude = {
  roles: { include: { roleType: true } },
  outgoingRelationships: { include: { relationshipType: true } },
  user: { select: { id: true, isActive: true, lastLoginAt: true, roleId: true } },
  // Main Role — single primary categorization of the contact.
  // Surfaced in the drawer header + BP list badge + relationship pickers.
  mainRoleType: true,
  // Professions ("Job Titles") the party holds. Surfaced so the Project
  // Role assignment pickers can pre-filter candidates against a role's
  // requiredProfessionIds — without this the dropdown showed every
  // employee and the backend later 400'd on "must hold one of these
  // job titles".
  professions: { select: { professionId: true } },
} as const;

function toDisplayName(dto: { partnerType: PartnerType; firstName?: string | null; lastName?: string | null; companyName?: string | null; displayName?: string | null }): string {
  if (dto.displayName?.trim()) return dto.displayName.trim();
  if (dto.partnerType === 'person') {
    return `${dto.firstName ?? ''} ${dto.lastName ?? ''}`.trim() || '(unnamed)';
  }
  return dto.companyName?.trim() || '(unnamed)';
}

@Injectable()
export class BusinessPartnersService {
  constructor(private prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────────────────
  // CRUD
  // ─────────────────────────────────────────────────────────────────────────

  async findAll(query: QueryBusinessPartnersDto) {
    const where: Prisma.BusinessPartnerWhereInput = { deletedAt: null };

    if (query.partnerType) where.partnerType = query.partnerType;
    if (query.status) where.status = query.status;

    if (query.roleType) {
      where.roles = {
        some: { roleType: { code: query.roleType } },
      };
    }

    // Employer filter — matches persons whose active worker_of edge
    // targets the given organization id. Uses `some` so a person with
    // multiple employers (rare but allowed) still matches on any of
    // them. `targetType: 'organization'` is redundant given the id
    // but keeps the where-clause aligned with the polymorphic column
    // pair the DB is actually indexed on.
    if (query.employerId) {
      where.outgoingRelationships = {
        some: {
          targetType: 'organization',
          targetId: query.employerId,
          relationshipType: { code: 'worker_of' },
          validTo: { gt: new Date() },
        },
      };
    }

    if (query.search) {
      const s = query.search.trim();
      // Bilingual search — see comment in users.service.findAll. The
      // person-name columns (firstName/lastName + Hebrew variants) are
      // included on top of displayName because admins routinely type
      // just the first or last name. (T3.3, 2026-06-28)
      where.OR = [
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

    const enriched = query.withProjects
      ? await this.attachProjectsForContacts(data as any[])
      : data;

    return {
      data: enriched,
      meta: { total, page, perPage, totalPages: Math.ceil(total / perPage) },
    };
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
  private async attachProjectsForContacts<T extends { id: number; partnerType: string; outgoingRelationships?: any[] }>(
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
    const employerByPerson = new Map<number, number[]>();
    const allEmployerIds = new Set<number>();
    for (const p of partners) {
      if (p.partnerType !== 'person') continue;
      const employers: number[] = [];
      for (const r of p.outgoingRelationships ?? []) {
        if (r?.relationshipType?.code === 'worker_of' && r?.targetType === 'organization') {
          employers.push(r.targetId);
          allEmployerIds.add(r.targetId);
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
    const withTargets = await this.attachRelationshipTargets(bp);

    // M3 — also load incoming relationships: rows where this BP is the
    // *target* (target_type='organization' AND target_id=this.id). Lets
    // a customer org show its contacts; an employer show its workers; etc.
    const incoming = await this.prisma.businessPartnerRelationship.findMany({
      where: {
        targetType: 'organization' as any,
        targetId: id,
        status: 'active',
      },
      include: {
        relationshipType: true,
        source: { select: { id: true, partnerType: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      ...withTargets,
      incomingRelationships: incoming.map((r) => ({
        id: r.id,
        relationshipType: r.relationshipType,
        sourcePartnerId: r.sourcePartnerId,
        sourceName: r.source.displayName,
        sourceKind: r.source.partnerType,
        roleInContext: r.roleInContext,
        isPrimary: r.isPrimary,
        validFrom: r.validFrom,
        validTo: r.validTo,
        status: r.status,
        notes: r.notes,
      })),
    };
  }

  // ─── Relationship target hydration (interim — pre-M3) ─────────────────────
  // Each BusinessPartnerRelationship row carries (targetType, targetId) as a
  // polymorphic reference. The drawer's Relationships tab needs human-readable
  // labels. Until M3 collapses targets into Party↔Party, this helper
  // batch-fetches names per target type and decorates the in-memory rows
  // with `targetName` and `targetCode` so the UI can render a sentence
  // ("Customer of → Project Alpha (P-001)") instead of "project #1".
  private async attachRelationshipTargets<
    T extends { outgoingRelationships: Array<{ targetType: string; targetId: number }> },
  >(bp: T): Promise<T> {
    const rels = bp.outgoingRelationships;
    if (rels.length === 0) return bp;

    const idsByType: Record<string, Set<number>> = {};
    for (const r of rels) {
      (idsByType[r.targetType] ||= new Set()).add(r.targetId);
    }

    const nameMap: Record<string, Record<number, { name: string; code?: string | null }>> = {};

    if (idsByType.project?.size) {
      const rows = await this.prisma.project.findMany({
        where: { id: { in: [...idsByType.project] } },
        select: { id: true, name: true, number: true },
      });
      nameMap.project = Object.fromEntries(rows.map((p) => [p.id, { name: p.name, code: p.number }]));
    }
    if (idsByType.organization?.size) {
      const rows = await this.prisma.businessPartner.findMany({
        where: { id: { in: [...idsByType.organization] } },
        select: { id: true, displayName: true },
      });
      nameMap.organization = Object.fromEntries(rows.map((o) => [o.id, { name: o.displayName }]));
    }
    if (idsByType.department?.size) {
      const rows = await this.prisma.department.findMany({
        where: { id: { in: [...idsByType.department] } },
        select: { id: true, name: true, code: true },
      });
      nameMap.department = Object.fromEntries(rows.map((d) => [d.id, { name: d.name, code: d.code }]));
    }
    // 'team' has no backing model in the current schema — leave name unset
    // and let the UI fall back to "team #N" gracefully.

    for (const r of rels as Array<typeof rels[number] & { targetName?: string; targetCode?: string | null }>) {
      const hit = nameMap[r.targetType]?.[r.targetId];
      if (hit) {
        r.targetName = hit.name;
        r.targetCode = hit.code ?? null;
      }
    }

    return bp;
  }

  async create(dto: CreateBusinessPartnerDto) {
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

    const bp = await this.prisma.businessPartner.create({
      data: {
        partnerType: dto.partnerType,
        displayName: toDisplayName(dto),
        firstName: dto.partnerType === 'person' ? dto.firstName ?? null : null,
        lastName: dto.partnerType === 'person' ? dto.lastName ?? null : null,
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

    // A BP's Main Role must also appear in its roles list, otherwise
    // role-based filters (e.g. the project Customer dropdown, which queries
    // `roleType=customer`) won't find it. The Partners UI's Main Role picker
    // used to write only `main_role_type_id`; this sync makes the two
    // representations consistent going forward.
    if (dto.mainRoleTypeId) {
      await this.syncMainRoleIntoRoles(bp.id, dto.mainRoleTypeId);
      return this.prisma.businessPartner.findUniqueOrThrow({
        where: { id: bp.id },
        include: partnerInclude,
      });
    }
    return bp;
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

  async update(id: number, dto: UpdateBusinessPartnerDto) {
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

    const updated = await this.prisma.businessPartner.update({
      where: { id },
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
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
        ...(displayName !== undefined ? { displayName } : {}),
      },
      include: partnerInclude,
    });

    // Keep the Main Role / roles-list invariant in sync — a BP's main role
    // must also live in business_partner_roles so role-based filters (e.g.
    // the project Customer dropdown) see it.
    if (dto.mainRoleTypeId) {
      await this.syncMainRoleIntoRoles(id, dto.mainRoleTypeId);
      return this.prisma.businessPartner.findUniqueOrThrow({
        where: { id },
        include: partnerInclude,
      });
    }
    return updated;
  }

  /**
   * Soft delete. We deliberately do NOT cascade out to BPs that have an
   * attached User row — block that path so callers don't accidentally make
   * a live login user orphaned. The user can be deleted first via
   * /users/:id, which nulls business_partner_id on the User side.
   */
  async remove(id: number) {
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

      // Dedupe by email
      if (email) {
        const dup = await this.prisma.businessPartner.findFirst({
          where: { email, deletedAt: null },
        });
        if (dup) {
          if (options.skipExisting) {
            skipped++;
            continue;
          }
          errors.push({ row: rowNum, reason: `Email "${email}" already exists (id=${dup.id})` });
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
