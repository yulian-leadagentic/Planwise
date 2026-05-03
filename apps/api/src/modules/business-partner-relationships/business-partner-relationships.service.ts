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

@Injectable()
export class BusinessPartnerRelationshipsService {
  constructor(private prisma: PrismaService) {}

  async findAll(q: QueryRelationshipsDto) {
    const where: Prisma.BusinessPartnerRelationshipWhereInput = {};
    if (q.sourcePartnerId) where.sourcePartnerId = q.sourcePartnerId;
    if (q.targetType) where.targetType = q.targetType;
    if (q.targetId) where.targetId = q.targetId;
    if (q.status) where.status = q.status;
    if (q.relationshipTypeCode) {
      where.relationshipType = { code: q.relationshipTypeCode };
    }

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

  async create(dto: CreateRelationshipDto) {
    // Validate source partner
    const source = await this.prisma.businessPartner.findFirst({
      where: { id: dto.sourcePartnerId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Source partner not found');

    // Validate relationship type and applicability
    const relType = await this.prisma.partnerRelationshipType.findUnique({
      where: { id: dto.relationshipTypeId },
    });
    if (!relType) throw new NotFoundException('Relationship type not found');

    if (relType.applicableTargetTypes) {
      const allowed = relType.applicableTargetTypes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowed.length > 0 && !allowed.includes(dto.targetType)) {
        throw new BadRequestException(
          `Relationship type "${relType.code}" cannot be applied to target_type=${dto.targetType}. Allowed: ${allowed.join(', ')}.`,
        );
      }
    }

    // Validate target exists in its respective table
    await this.assertTargetExists(dto.targetType, dto.targetId);

    try {
      return await this.prisma.businessPartnerRelationship.create({
        data: {
          sourcePartnerId: dto.sourcePartnerId,
          targetType: dto.targetType,
          targetId: dto.targetId,
          relationshipTypeId: dto.relationshipTypeId,
          roleInContext: dto.roleInContext ?? null,
          isPrimary: dto.isPrimary ?? false,
          validFrom: dto.validFrom ? new Date(dto.validFrom) : null,
          validTo: dto.validTo ? new Date(dto.validTo) : null,
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
        validFrom: dto.validFrom !== undefined ? (dto.validFrom ? new Date(dto.validFrom) : null) : undefined,
        validTo: dto.validTo !== undefined ? (dto.validTo ? new Date(dto.validTo) : null) : undefined,
        status: dto.status,
        notes: dto.notes,
      },
      include,
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.businessPartnerRelationship.delete({ where: { id } });
    return { message: 'Relationship removed' };
  }

  // Convenience: list relationships for a target (e.g. all BPs on project 42).
  async findForTarget(targetType: RelationshipTarget, targetId: number) {
    return this.prisma.businessPartnerRelationship.findMany({
      where: { targetType, targetId, status: 'active' },
      include,
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Used by other modules (e.g. ProjectsService when adding a project_member)
   * to keep the legacy ProjectMember table and the new relationship table
   * in sync.
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
    if (!user?.businessPartnerId) {
      // No BP linked yet (unusual but possible — backfill missed it). No-op.
      return null;
    }

    const relType = await this.prisma.partnerRelationshipType.findUnique({
      where: { code: 'project_member' },
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

  /** Inverse of upsertProjectMemberRelationship — called when a member is removed. */
  async removeProjectMemberRelationship(args: { userId: number; projectId: number }) {
    const user = await this.prisma.user.findUnique({
      where: { id: args.userId },
      select: { businessPartnerId: true },
    });
    if (!user?.businessPartnerId) return null;

    const relType = await this.prisma.partnerRelationshipType.findUnique({
      where: { code: 'project_member' },
    });
    if (!relType) return null;

    await this.prisma.businessPartnerRelationship.deleteMany({
      where: {
        sourcePartnerId: user.businessPartnerId,
        targetType: 'project',
        targetId: args.projectId,
        relationshipTypeId: relType.id,
      },
    });
    return null;
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
        // No team table yet — treat as opaque target_id, accept it.
        return;
      default:
        return;
    }
    if (!exists) {
      throw new NotFoundException(`Target ${type}/${id} not found`);
    }
  }
}
