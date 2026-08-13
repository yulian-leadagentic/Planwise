import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

const FAR_FUTURE = new Date('9999-12-31T00:00:00Z');

interface CreateProjectPartnerRoleDto {
  projectId: number;
  partyId: number;
  roleId: number;
  isPrimary?: boolean;
  titleInProject?: string | null;
  // BM2 Phase 2 (2026-08-13) — participation representation.
  contactPartyId?: number | null;
  onBehalfOfPartyId?: number | null;
  validFrom?: string | Date;
  validTo?: string | Date;
  notes?: string | null;
}

interface UpdateProjectPartnerRoleDto {
  isPrimary?: boolean;
  titleInProject?: string | null;
  contactPartyId?: number | null;
  onBehalfOfPartyId?: number | null;
  validFrom?: string | Date;
  validTo?: string | Date;
  status?: string;
  notes?: string | null;
}

interface QueryDto {
  projectId?: number;
  partyId?: number;
  roleCode?: string;
  activeOnly?: boolean;
}

@Injectable()
export class ProjectPartnerRolesService {
  constructor(private prisma: PrismaService) {}

  async list(q: QueryDto) {
    const now = new Date();
    const where: Prisma.ProjectPartnerRoleWhereInput = {};
    if (q.projectId) where.projectId = q.projectId;
    if (q.partyId)   where.partyId = q.partyId;
    if (q.roleCode)  where.role = { code: q.roleCode };
    if (q.activeOnly !== false) {
      // default: active rows only (the common case)
      where.validFrom = { lte: now };
      where.validTo   = { gt: now };
    }
    return this.prisma.projectPartnerRole.findMany({
      where,
      include: {
        role: true,
        party: { select: { id: true, partnerType: true, displayName: true } },
        project: { select: { id: true, name: true, number: true } },
        // BM2 Phase 2 (2026-08-13): representation surfaces on read so
        // the UI can render "Org X — contact: Person C" and
        // "Person C (on behalf of Org X)".
        contactParty: { select: { id: true, partnerType: true, displayName: true } },
        onBehalfOfParty: { select: { id: true, partnerType: true, displayName: true } },
      },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async findOne(id: number) {
    const row = await this.prisma.projectPartnerRole.findUnique({
      where: { id },
      include: {
        role: true,
        party: { select: { id: true, partnerType: true, displayName: true } },
        project: { select: { id: true, name: true, number: true } },
        // BM2 Phase 2 (2026-08-13): representation surfaces on read so
        // the UI can render "Org X — contact: Person C" and
        // "Person C (on behalf of Org X)".
        contactParty: { select: { id: true, partnerType: true, displayName: true } },
        onBehalfOfParty: { select: { id: true, partnerType: true, displayName: true } },
      },
    });
    if (!row) throw new NotFoundException('Project partner role not found');
    return row;
  }

  async create(dto: CreateProjectPartnerRoleDto) {
    // Validate FKs + business rules.
    const [project, party, role] = await Promise.all([
      this.prisma.project.findUnique({ where: { id: dto.projectId } }),
      this.prisma.businessPartner.findFirst({
        where: { id: dto.partyId, deletedAt: null },
        include: {
          roles: { include: { roleType: true } },
          professions: { include: { profession: true } },
        },
      }),
      this.prisma.projectRoleType.findUnique({ where: { id: dto.roleId } }),
    ]);
    if (!project) throw new NotFoundException(`Project ${dto.projectId} not found`);
    if (!party)   throw new NotFoundException(`Party ${dto.partyId} not found`);
    if (!role)    throw new NotFoundException(`Role ${dto.roleId} not found`);

    // allowedPartnerKind check
    if (role.allowedPartnerKind !== 'any' && role.allowedPartnerKind !== party.partnerType) {
      throw new BadRequestException(
        `Role '${role.name}' requires a ${role.allowedPartnerKind}, but party is a ${party.partnerType}`,
      );
    }
    // requiredPartnerRoleCode check (party must hold that party-role)
    if (role.requiredPartnerRoleCode) {
      const has = party.roles.some((r) => r.roleType.code === role.requiredPartnerRoleCode);
      if (!has) {
        throw new BadRequestException(
          `Role '${role.name}' requires the party to hold the '${role.requiredPartnerRoleCode}' partner-role first`,
        );
      }
    }
    // M4a.3 — required job titles (professions). Party must hold at least
    // one of the listed profession ids.
    const requiredProfIds = (role.requiredProfessionIds as number[] | null) ?? [];
    if (requiredProfIds.length > 0) {
      const partyProfIds = new Set(party.professions.map((p) => p.professionId));
      const hit = requiredProfIds.some((id) => partyProfIds.has(id));
      if (!hit) {
        const profNames = await this.prisma.profession.findMany({
          where: { id: { in: requiredProfIds } },
          select: { name: true },
        });
        throw new BadRequestException(
          `Role '${role.name}' requires the party to hold one of these job titles: ${profNames.map((p) => p.name).join(', ')}.`,
        );
      }
    }
    // BM2 Phase 2 (2026-08-13) — representation checks.
    // Rules mirror the analysis: contactPartyId is only meaningful when
    // the participant is an org (the contact is a person); onBehalfOfPartyId
    // is only meaningful when the participant is a person (they represent
    // an org). Both are soft-checked — invalid values throw 400, but
    // omitting them is always fine (the flow they power is optional).
    if (dto.contactPartyId != null) {
      if (party.partnerType !== 'organization') {
        throw new BadRequestException(
          `contactPartyId is only valid when the participant is an organization; this one is a ${party.partnerType}.`,
        );
      }
      const contact = await this.prisma.businessPartner.findFirst({
        where: { id: dto.contactPartyId, deletedAt: null },
        select: { id: true, partnerType: true },
      });
      if (!contact) {
        throw new NotFoundException(`Contact party ${dto.contactPartyId} not found`);
      }
      if (contact.partnerType !== 'person') {
        throw new BadRequestException(
          `contactPartyId must reference a person, got a ${contact.partnerType}.`,
        );
      }
    }
    if (dto.onBehalfOfPartyId != null) {
      if (party.partnerType !== 'person') {
        throw new BadRequestException(
          `onBehalfOfPartyId is only valid when the participant is a person; this one is a ${party.partnerType}.`,
        );
      }
      const onBehalf = await this.prisma.businessPartner.findFirst({
        where: { id: dto.onBehalfOfPartyId, deletedAt: null },
        select: { id: true, partnerType: true },
      });
      if (!onBehalf) {
        throw new NotFoundException(`On-behalf-of party ${dto.onBehalfOfPartyId} not found`);
      }
      if (onBehalf.partnerType !== 'organization') {
        throw new BadRequestException(
          `onBehalfOfPartyId must reference an organization, got a ${onBehalf.partnerType}.`,
        );
      }
    }

    // isPrimaryRequired: when set, demote previous primary so a single primary
    // exists. This way the form can mark a new primary without manual cleanup.
    if (role.isPrimaryRequired && dto.isPrimary) {
      await this.demoteExistingPrimary(dto.projectId, dto.roleId);
    }

    try {
      return await this.prisma.projectPartnerRole.create({
        data: {
          projectId: dto.projectId,
          partyId: dto.partyId,
          roleId: dto.roleId,
          isPrimary: dto.isPrimary ?? false,
          titleInProject: dto.titleInProject ?? null,
          contactPartyId: dto.contactPartyId ?? null,
          onBehalfOfPartyId: dto.onBehalfOfPartyId ?? null,
          validFrom: dto.validFrom ? new Date(dto.validFrom) : new Date(),
          validTo: dto.validTo ? new Date(dto.validTo) : FAR_FUTURE,
          notes: dto.notes ?? null,
        },
        include: {
          role: true,
          party: { select: { id: true, partnerType: true, displayName: true } },
          project: { select: { id: true, name: true, number: true } },
          contactParty: { select: { id: true, partnerType: true, displayName: true } },
          onBehalfOfParty: { select: { id: true, partnerType: true, displayName: true } },
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'A project-role assignment with these values already exists at this validity',
        );
      }
      throw e;
    }
  }

  async update(id: number, dto: UpdateProjectPartnerRoleDto) {
    const existing = await this.prisma.projectPartnerRole.findUnique({
      where: { id },
      include: { role: true },
    });
    if (!existing) throw new NotFoundException('Project partner role not found');

    if (existing.role.isPrimaryRequired && dto.isPrimary) {
      await this.demoteExistingPrimary(existing.projectId, existing.roleId, id);
    }

    return this.prisma.projectPartnerRole.update({
      where: { id },
      data: {
        isPrimary: dto.isPrimary,
        titleInProject: dto.titleInProject === undefined ? undefined : (dto.titleInProject ?? null),
        // BM2 Phase 2 (2026-08-13) — representation edits. Explicit-null
        // clears the link; undefined leaves the existing value alone.
        contactPartyId: dto.contactPartyId === undefined ? undefined : (dto.contactPartyId ?? null),
        onBehalfOfPartyId: dto.onBehalfOfPartyId === undefined ? undefined : (dto.onBehalfOfPartyId ?? null),
        validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined,
        validTo: dto.validTo ? new Date(dto.validTo) : undefined,
        status: dto.status,
        notes: dto.notes === undefined ? undefined : (dto.notes ?? null),
      },
      include: {
        role: true,
        party: { select: { id: true, partnerType: true, displayName: true } },
        project: { select: { id: true, name: true, number: true } },
        contactParty: { select: { id: true, partnerType: true, displayName: true } },
        onBehalfOfParty: { select: { id: true, partnerType: true, displayName: true } },
      },
    });
  }

  /** Soft-end (set valid_to = now). Preserves history; for hard delete, use forceRemove. */
  async remove(id: number) {
    await this.prisma.projectPartnerRole.update({
      where: { id },
      data: { validTo: new Date(), status: 'ended' },
    });
    return { message: 'Project partner role ended' };
  }

  private async demoteExistingPrimary(projectId: number, roleId: number, exceptId?: number) {
    const now = new Date();
    await this.prisma.projectPartnerRole.updateMany({
      where: {
        projectId,
        roleId,
        isPrimary: true,
        validFrom: { lte: now },
        validTo:   { gt: now },
        ...(exceptId != null ? { NOT: { id: exceptId } } : {}),
      },
      data: { isPrimary: false },
    });
  }
}
