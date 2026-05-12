import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, RelationshipTarget } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateRelationshipDto } from './dto/create-relationship.dto';
import { UpdateRelationshipDto } from './dto/update-relationship.dto';
import { QueryRelationshipsDto } from './dto/query-relationships.dto';

const include = {
  source: { select: { id: true, displayName: true, partnerType: true } },
  relationshipType: true,
} as const;

const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');

function activeWhere(now = new Date()): Prisma.BusinessPartnerRelationshipWhereInput {
  return { validFrom: { lte: now }, validTo: { gt: now } };
}

@Injectable()
export class BusinessPartnerRelationshipsService {
  constructor(private prisma: PrismaService) {}

  async findAll(q: QueryRelationshipsDto & { activeOnly?: boolean } = {} as any) {
    const where: Prisma.BusinessPartnerRelationshipWhereInput = {};
    if (q.sourcePartnerId) where.sourcePartnerId = q.sourcePartnerId;
    if (q.targetType) where.targetType = q.targetType;
    if (q.targetId) where.targetId = q.targetId;
    if (q.status) where.status = q.status;
    if (q.relationshipTypeCode) where.relationshipType = { code: q.relationshipTypeCode };
    if (q.activeOnly !== false) Object.assign(where, activeWhere());

    return this.prisma.businessPartnerRelationship.findMany({
      where,
      include,
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async findOne(id: number) {
    const r = await this.prisma.businessPartnerRelationship.findUnique({
      where: { id },
      include,
    });
    if (!r) throw new NotFoundException('Relationship not found');
    return r;
  }

  /**
   * Create a relationship after fully validating it against the rules
   * carried in PartnerRelationshipType. The rules are data-driven so an
   * admin can define new types in the UI without code changes.
   */
  async create(dto: CreateRelationshipDto) {
    // 1. Source partner must exist and not be soft-deleted.
    const source = await this.prisma.businessPartner.findFirst({
      where: { id: dto.sourcePartnerId, deletedAt: null },
      include: { roles: { include: { roleType: true } } },
    });
    if (!source) throw new NotFoundException('Source partner not found');

    // 2. Relationship type must exist.
    const relType = await this.prisma.partnerRelationshipType.findUnique({
      where: { id: dto.relationshipTypeId },
    });
    if (!relType) throw new NotFoundException('Relationship type not found');

    // 3. Source partner_type must satisfy applicableSourceType (CSV).
    if (relType.applicableSourceType) {
      const allowedSources = relType.applicableSourceType
        .split(',').map((s) => s.trim()).filter(Boolean);
      if (allowedSources.length > 0 && !allowedSources.includes(source.partnerType)) {
        throw new BadRequestException(
          `Relationship "${relType.code}" requires source partner_type ∈ {${allowedSources.join(', ')}}; got "${source.partnerType}".`,
        );
      }
    }

    // 4. Target type must satisfy applicableTargetTypes (CSV).
    if (relType.applicableTargetTypes) {
      const allowedTargets = relType.applicableTargetTypes
        .split(',').map((s) => s.trim()).filter(Boolean);
      if (allowedTargets.length > 0 && !allowedTargets.includes(dto.targetType)) {
        throw new BadRequestException(
          `Relationship "${relType.code}" cannot point at target_type=${dto.targetType}. Allowed: {${allowedTargets.join(', ')}}.`,
        );
      }
    }

    // 5. Source must hold the required role, if specified.
    if (relType.requiredSourceRoleCode) {
      const codes = source.roles.map((r) => r.roleType.code);
      if (!codes.includes(relType.requiredSourceRoleCode)) {
        throw new BadRequestException(
          `Relationship "${relType.code}" requires the source to hold role "${relType.requiredSourceRoleCode}". This partner holds: {${codes.join(', ') || 'none'}}.`,
        );
      }
    }

    // 5b. Target BP must hold the required role, if specified. Only meaningful
    // when the target is itself a BP (targetType === 'organization' here —
    // 'project'/'department'/'team' targets aren't BPs and so never have roles).
    if ((relType as any).requiredTargetRoleCode && dto.targetType === 'organization') {
      const targetBp = await this.prisma.businessPartner.findFirst({
        where: { id: dto.targetId, deletedAt: null },
        include: { roles: { include: { roleType: true } } },
      });
      const targetCodes = (targetBp?.roles ?? []).map((r: any) => r.roleType.code);
      const required = (relType as any).requiredTargetRoleCode as string;
      if (!targetCodes.includes(required)) {
        throw new BadRequestException(
          `Relationship "${relType.code}" requires the target organization to hold role "${required}". This organization holds: {${targetCodes.join(', ') || 'none'}}.`,
        );
      }
    }

    // 6. Target row must exist (when we can verify it).
    await this.assertTargetExists(dto.targetType, dto.targetId);

    // 7. customer_of_project: enforce uniqueness — at most one ACTIVE per project.
    if (relType.code === 'customer_of_project' && dto.targetType === 'project') {
      const existing = await this.prisma.businessPartnerRelationship.findFirst({
        where: {
          relationshipTypeId: relType.id,
          targetType: 'project',
          targetId: dto.targetId,
          ...activeWhere(),
        },
      });
      if (existing) {
        throw new ConflictException(
          `Project ${dto.targetId} already has an active customer (relationship id=${existing.id}). End the existing one first.`,
        );
      }
    }

    try {
      return await this.prisma.businessPartnerRelationship.create({
        data: {
          sourcePartnerId: dto.sourcePartnerId,
          targetType: dto.targetType,
          targetId: dto.targetId,
          relationshipTypeId: dto.relationshipTypeId,
          roleInContext: dto.roleInContext ?? null,
          isPrimary: dto.isPrimary ?? false,
          validFrom: dto.validFrom ? new Date(dto.validFrom) : new Date(),
          validTo: dto.validTo ? new Date(dto.validTo) : FAR_FUTURE,
          notes: dto.notes ?? null,
        },
        include,
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException(
          'This exact relationship already exists (same source, target, and type). Edit the existing one instead.',
        );
      }
      throw err;
    }
  }

  async update(id: number, dto: UpdateRelationshipDto) {
    await this.findOne(id);
    return this.prisma.businessPartnerRelationship.update({
      where: { id },
      data: {
        roleInContext: dto.roleInContext,
        isPrimary: dto.isPrimary,
        validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined,
        validTo: dto.validTo ? new Date(dto.validTo) : undefined,
        status: dto.status,
        notes: dto.notes,
      },
      include,
    });
  }

  /**
   * Soft "disconnect": set valid_to = now() instead of physical delete.
   * History is preserved for audit / SAP-style time travel.
   */
  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.businessPartnerRelationship.update({
      where: { id },
      data: { validTo: new Date() },
    });
    return { message: 'Relationship ended (soft-disconnected)' };
  }

  /** List active relationships pointing at a specific target. */
  async findForTarget(targetType: RelationshipTarget, targetId: number) {
    return this.prisma.businessPartnerRelationship.findMany({
      where: { targetType, targetId, status: 'active', ...activeWhere() },
      include,
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Helpers used by other modules (project create/update, member add/remove).
  // M3d cutover: writes now go to project_partner_roles, NOT to the legacy
  // business_partner_relationships table.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Add (or re-activate) a user's participation in a project as a
   * project_partner_role row with role.code='participant'.
   */
  async upsertProjectMemberRelationship(args: {
    userId: number;
    projectId: number;
    roleInContext?: string | null;
  }) {
    const user = await this.prisma.user.findUnique({
      where: { id: args.userId },
      select: { businessPartnerId: true },
    });
    if (!user?.businessPartnerId) return null;

    const role = await this.prisma.projectRoleType.findUnique({
      where: { code: 'participant' },
    });
    if (!role) return null;

    const now = new Date();
    // Look for any existing assignment regardless of validity. If active,
    // just touch it; if expired (soft-ended earlier), re-open it.
    const existing = await this.prisma.projectPartnerRole.findFirst({
      where: { projectId: args.projectId, partyId: user.businessPartnerId, roleId: role.id },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      return this.prisma.projectPartnerRole.update({
        where: { id: existing.id },
        data: {
          titleInProject: args.roleInContext ?? undefined,
          status: 'active',
          validTo: FAR_FUTURE,
        },
      });
    }
    return this.prisma.projectPartnerRole.create({
      data: {
        projectId: args.projectId,
        partyId: user.businessPartnerId,
        roleId: role.id,
        titleInProject: args.roleInContext ?? null,
        validFrom: now,
      },
    });
  }

  async removeProjectMemberRelationship(args: { userId: number; projectId: number }) {
    const user = await this.prisma.user.findUnique({
      where: { id: args.userId },
      select: { businessPartnerId: true },
    });
    if (!user?.businessPartnerId) return null;

    const role = await this.prisma.projectRoleType.findUnique({
      where: { code: 'participant' },
    });
    if (!role) return null;

    const now = new Date();
    await this.prisma.projectPartnerRole.updateMany({
      where: {
        projectId: args.projectId,
        partyId: user.businessPartnerId,
        roleId: role.id,
        validFrom: { lte: now },
        validTo: { gt: now },
      },
      data: { validTo: now, status: 'ended' },
    });
    return null;
  }

  /**
   * Set the customer for a project. Creates a project_partner_role row with
   * role.code='customer' marked isPrimary=true. Soft-ends any previous
   * primary customer assignment on the same project (history preserved).
   */
  async setProjectCustomer(projectId: number, customerOrgId: number) {
    const customer = await this.prisma.businessPartner.findFirst({
      where: { id: customerOrgId, partnerType: 'organization', deletedAt: null },
      include: { roles: { include: { roleType: true } } },
    });
    if (!customer) {
      throw new BadRequestException(`Organization ${customerOrgId} not found`);
    }
    const hasCustomerRole = customer.roles.some((r) => r.roleType.code === 'customer');
    if (!hasCustomerRole) {
      throw new BadRequestException(
        `Organization "${customer.displayName}" does not hold the "customer" partner-role.`,
      );
    }
    const role = await this.prisma.projectRoleType.findUnique({
      where: { code: 'customer' },
    });
    if (!role) {
      throw new BadRequestException(
        'project_role_types.code="customer" missing — schema seed is broken.',
      );
    }
    const now = new Date();
    // Soft-end the previous primary customer (if any).
    await this.prisma.projectPartnerRole.updateMany({
      where: {
        projectId,
        roleId: role.id,
        isPrimary: true,
        validFrom: { lte: now },
        validTo: { gt: now },
      },
      data: { validTo: now, status: 'ended' },
    });
    return this.prisma.projectPartnerRole.create({
      data: {
        projectId,
        partyId: customerOrgId,
        roleId: role.id,
        isPrimary: true,
      },
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────────────────────────────────

  private async assertTargetExists(type: RelationshipTarget, id: number) {
    let exists: any;
    switch (type) {
      case 'project':
        exists = await this.prisma.project.findFirst({ where: { id, deletedAt: null } });
        break;
      case 'organization':
        exists = await this.prisma.businessPartner.findFirst({
          where: { id, partnerType: 'organization', deletedAt: null },
        });
        break;
      case 'department':
        exists = await this.prisma.department.findUnique({ where: { id } });
        break;
      case 'team':
        return;
      default:
        return;
    }
    if (!exists) {
      throw new NotFoundException(`Target ${type}/${id} not found`);
    }
  }
}
