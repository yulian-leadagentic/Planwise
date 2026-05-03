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
  // Helpers used by other modules to write through legacy <-> new model.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Mirror a (User joining a project) write into the new relationship
   * table as `participates_in_project` (replaces old project_member type).
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

    const relType = await this.prisma.partnerRelationshipType.findUnique({
      where: { code: 'participates_in_project' },
    });
    if (!relType) return null;

    return this.prisma.businessPartnerRelationship.upsert({
      where: {
        sourcePartnerId_targetType_targetId_relationshipTypeId: {
          sourcePartnerId: user.businessPartnerId,
          targetType: 'project',
          targetId: args.projectId,
          relationshipTypeId: relType.id,
        },
      },
      update: {
        roleInContext: args.roleInContext ?? undefined,
        status: 'active',
        validTo: FAR_FUTURE, // re-open if previously soft-ended
      },
      create: {
        sourcePartnerId: user.businessPartnerId,
        targetType: 'project',
        targetId: args.projectId,
        relationshipTypeId: relType.id,
        roleInContext: args.roleInContext ?? null,
      },
    });
  }

  async removeProjectMemberRelationship(args: { userId: number; projectId: number }) {
    const user = await this.prisma.user.findUnique({
      where: { id: args.userId },
      select: { businessPartnerId: true },
    });
    if (!user?.businessPartnerId) return null;

    const relType = await this.prisma.partnerRelationshipType.findUnique({
      where: { code: 'participates_in_project' },
    });
    if (!relType) return null;

    // Soft-end any active row matching this user/project.
    await this.prisma.businessPartnerRelationship.updateMany({
      where: {
        sourcePartnerId: user.businessPartnerId,
        targetType: 'project',
        targetId: args.projectId,
        relationshipTypeId: relType.id,
        ...activeWhere(),
      },
      data: { validTo: new Date() },
    });
    return null;
  }

  /**
   * Set the customer for a project (creates the customer_of_project row).
   * Used by ProjectsService.create. Validates that the org holds the
   * "customer" role — same rule as a manual create call would.
   */
  async setProjectCustomer(projectId: number, customerOrgId: number) {
    const relType = await this.prisma.partnerRelationshipType.findUnique({
      where: { code: 'customer_of_project' },
    });
    if (!relType) {
      throw new BadRequestException(
        'customer_of_project relationship type missing — schema seed is broken.',
      );
    }
    return this.create({
      sourcePartnerId: customerOrgId,
      targetType: 'project',
      targetId: projectId,
      relationshipTypeId: relType.id,
      isPrimary: true,
    } as CreateRelationshipDto);
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
