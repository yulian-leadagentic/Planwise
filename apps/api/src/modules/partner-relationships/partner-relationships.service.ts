import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

const FAR_FUTURE = new Date('9999-12-31T00:00:00Z');

interface CreateDto {
  partyAId: number;
  partyBId: number;
  typeId: number;
  isPrimary?: boolean;
  titleAtB?: string | null;
  validFrom?: string | Date;
  validTo?: string | Date;
  notes?: string | null;
}

interface UpdateDto {
  isPrimary?: boolean;
  titleAtB?: string | null;
  validFrom?: string | Date;
  validTo?: string | Date;
  status?: string;
  notes?: string | null;
}

interface QueryDto {
  partyAId?: number;
  partyBId?: number;
  /** Match both A and B (e.g. "show all of X's relationships"). */
  anyPartyId?: number;
  typeCode?: string;
  activeOnly?: boolean;
}

@Injectable()
export class PartnerRelationshipsService {
  constructor(private prisma: PrismaService) {}

  async list(q: QueryDto) {
    const now = new Date();
    const where: Prisma.PartnerRelationshipWhereInput = {};
    if (q.partyAId)   where.partyAId = q.partyAId;
    if (q.partyBId)   where.partyBId = q.partyBId;
    if (q.anyPartyId) {
      where.OR = [{ partyAId: q.anyPartyId }, { partyBId: q.anyPartyId }];
    }
    if (q.typeCode)   where.type = { code: q.typeCode };
    if (q.activeOnly !== false) {
      where.validFrom = { lte: now };
      where.validTo   = { gt: now };
    }
    return this.prisma.partnerRelationship.findMany({
      where,
      include: {
        type: true,
        partyA: { select: { id: true, partnerType: true, displayName: true } },
        partyB: { select: { id: true, partnerType: true, displayName: true } },
      },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async findOne(id: number) {
    const row = await this.prisma.partnerRelationship.findUnique({
      where: { id },
      include: {
        type: true,
        partyA: { select: { id: true, partnerType: true, displayName: true } },
        partyB: { select: { id: true, partnerType: true, displayName: true } },
      },
    });
    if (!row) throw new NotFoundException('Partner relationship not found');
    return row;
  }

  async create(dto: CreateDto) {
    if (dto.partyAId === dto.partyBId) {
      throw new BadRequestException('Cannot relate a party to itself');
    }
    const [a, b, type] = await Promise.all([
      this.prisma.businessPartner.findFirst({ where: { id: dto.partyAId, deletedAt: null } }),
      this.prisma.businessPartner.findFirst({ where: { id: dto.partyBId, deletedAt: null } }),
      this.prisma.partnerRelationshipType.findUnique({ where: { id: dto.typeId } }),
    ]);
    if (!a)    throw new NotFoundException(`Party A (${dto.partyAId}) not found`);
    if (!b)    throw new NotFoundException(`Party B (${dto.partyBId}) not found`);
    if (!type) throw new NotFoundException(`Relationship type (${dto.typeId}) not found`);

    // sideAKind / sideBKind validation
    const okSide = (kind: string | null, partnerType: string) =>
      !kind || kind === 'any' || kind === partnerType;
    if (!okSide(type.sideAKind, a.partnerType)) {
      throw new BadRequestException(
        `Type '${type.name}' requires side A to be a ${type.sideAKind}, got ${a.partnerType}`,
      );
    }
    if (!okSide(type.sideBKind, b.partnerType)) {
      throw new BadRequestException(
        `Type '${type.name}' requires side B to be a ${type.sideBKind}, got ${b.partnerType}`,
      );
    }
    if (type.sideBKind === 'project') {
      throw new BadRequestException(
        `Type '${type.name}' targets a project — use /project-partner-roles instead`,
      );
    }

    // allowsMultiple: if false, soft-end existing active rels of this type for partyA.
    if (!type.allowsMultiple) {
      const now = new Date();
      await this.prisma.partnerRelationship.updateMany({
        where: {
          partyAId: dto.partyAId,
          typeId: dto.typeId,
          validFrom: { lte: now },
          validTo:   { gt: now },
        },
        data: { validTo: now, status: 'replaced' },
      });
    }

    try {
      return await this.prisma.partnerRelationship.create({
        data: {
          partyAId: dto.partyAId,
          partyBId: dto.partyBId,
          typeId: dto.typeId,
          isPrimary: dto.isPrimary ?? false,
          titleAtB: dto.titleAtB ?? null,
          validFrom: dto.validFrom ? new Date(dto.validFrom) : new Date(),
          validTo: dto.validTo ? new Date(dto.validTo) : FAR_FUTURE,
          notes: dto.notes ?? null,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'A relationship of this type already exists between these parties at this validity',
        );
      }
      throw e;
    }
  }

  async update(id: number, dto: UpdateDto) {
    const existing = await this.prisma.partnerRelationship.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Partner relationship not found');
    return this.prisma.partnerRelationship.update({
      where: { id },
      data: {
        isPrimary: dto.isPrimary,
        titleAtB: dto.titleAtB === undefined ? undefined : (dto.titleAtB ?? null),
        validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined,
        validTo: dto.validTo ? new Date(dto.validTo) : undefined,
        status: dto.status,
        notes: dto.notes === undefined ? undefined : (dto.notes ?? null),
      },
    });
  }

  /** Soft-end (BUT050-style). For hard delete, an admin would do it via SQL. */
  async remove(id: number) {
    await this.prisma.partnerRelationship.update({
      where: { id },
      data: { validTo: new Date(), status: 'ended' },
    });
    return { message: 'Partner relationship ended' };
  }
}
