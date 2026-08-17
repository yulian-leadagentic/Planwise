import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';

const FAR_FUTURE = new Date('9999-12-31T00:00:00Z');

/** Shape of one entry inside `partner_relationship_types.side_*_targets`. */
interface SideTarget {
  kind: 'person' | 'organization' | 'project' | 'any';
  roleCodes?: string[];
  categoryCodes?: string[];
}

interface PartyForCheck {
  partnerType: string;
  roles: Array<{ roleType: { code: string; category: string | null } }>;
}

/**
 * Validates a party against a SideTarget[]. Empty / null targets = accept
 * any party. Otherwise the party matches if AT LEAST ONE target passes
 * kind + roleCodes + categoryCodes.
 */
function checkSideTargets(
  party: PartyForCheck,
  targets: SideTarget[] | null | undefined,
  actualKind: string,
): { ok: boolean; reason: string } {
  if (!targets || targets.length === 0) return { ok: true, reason: '' };
  const codes = party.roles.map((r) => r.roleType.code);
  const cats = Array.from(
    new Set(party.roles.map((r) => r.roleType.category).filter((c): c is string => !!c)),
  );
  const kindOk = targets.filter((t) => t.kind === 'any' || t.kind === actualKind);
  if (kindOk.length === 0) {
    const allowed = Array.from(new Set(targets.map((t) => t.kind))).join(', ');
    return { ok: false, reason: `party kind must be ∈ {${allowed}}, got ${actualKind}` };
  }
  for (const t of kindOk) {
    const rolesOk = !t.roleCodes?.length || t.roleCodes.some((rc) => codes.includes(rc));
    const catsOk = !t.categoryCodes?.length || t.categoryCodes.some((cc) => cats.includes(cc));
    if (rolesOk && catsOk) return { ok: true, reason: '' };
  }
  const reasons: string[] = [];
  const wantRoles = Array.from(new Set(kindOk.flatMap((t) => t.roleCodes ?? [])));
  const wantCats = Array.from(new Set(kindOk.flatMap((t) => t.categoryCodes ?? [])));
  if (wantRoles.length) reasons.push(`role ∈ {${wantRoles.join(', ')}}`);
  if (wantCats.length) reasons.push(`category ∈ {${wantCats.join(', ')}}`);
  return { ok: false, reason: reasons.join(' or ') || 'no matching side target' };
}

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
  constructor(
    private prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
  ) {}

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

  async create(dto: CreateDto, userId?: number) {
    if (dto.partyAId === dto.partyBId) {
      throw new BadRequestException('Cannot relate a party to itself');
    }
    const [a, b, type] = await Promise.all([
      this.prisma.businessPartner.findFirst({
        where: { id: dto.partyAId, deletedAt: null },
        include: { roles: { include: { roleType: true } } },
      }),
      this.prisma.businessPartner.findFirst({
        where: { id: dto.partyBId, deletedAt: null },
        include: { roles: { include: { roleType: true } } },
      }),
      this.prisma.partnerRelationshipType.findUnique({ where: { id: dto.typeId } }),
    ]);
    if (!a)    throw new NotFoundException(`Party A (${dto.partyAId}) not found`);
    if (!b)    throw new NotFoundException(`Party B (${dto.partyBId}) not found`);
    if (!type) throw new NotFoundException(`Relationship type (${dto.typeId}) not found`);

    // Side-target validation.
    // BM2 Phase 1 (2026-08-13): the legacy single-shot `sideAKind` /
    // `sideBKind` columns were dropped alongside the retired
    // `business_partner_relationships` table. All kind + role gating now
    // reads the structured `sideATargets` / `sideBTargets` JSON. If a
    // relationship type has no targets on a side, that side accepts any
    // party — same behavior as the old "null kind = any" fallback.
    const projectSideAny = (targets: SideTarget[] | null | undefined) =>
      !!targets && targets.some((t) => t.kind === 'project');
    if (projectSideAny(type.sideBTargets as SideTarget[] | null) ||
        projectSideAny(type.sideATargets as SideTarget[] | null)) {
      throw new BadRequestException(
        `Type '${type.name}' targets a project — use /project-partner-roles instead`,
      );
    }
    const sideACheck = checkSideTargets(a, type.sideATargets as SideTarget[] | null, a.partnerType);
    if (!sideACheck.ok) {
      throw new BadRequestException(
        `Type '${type.name}' side A does not match party ${a.displayName}: ${sideACheck.reason}`,
      );
    }
    const sideBCheck = checkSideTargets(b, type.sideBTargets as SideTarget[] | null, b.partnerType);
    if (!sideBCheck.ok) {
      throw new BadRequestException(
        `Type '${type.name}' side B does not match party ${b.displayName}: ${sideBCheck.reason}`,
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

    let created;
    try {
      created = await this.prisma.partnerRelationship.create({
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

    // Audit — party↔party edge; NOT project-scoped, so projectId stays
    // null. Shows up on the admin Activity Log for a "who linked X to Y"
    // trail (the per-project tab doesn't display these because they
    // aren't tied to a project).
    try {
      await this.activityLog.write({
        category: 'partner',
        action: 'partner.relationship.created',
        actorUserId: userId ?? null,
        projectId: null,
        entityType: 'partner_relationship',
        entityId: created.id,
        entityName: `${a.displayName} → ${b.displayName}`,
        description: `Created "${type.name}" relationship: ${a.displayName} → ${b.displayName}` +
          (dto.titleAtB ? ` (${dto.titleAtB})` : ''),
        metadata: { typeCode: type.code, partyAId: dto.partyAId, partyBId: dto.partyBId },
      });
    } catch { /* swallow */ }

    return created;
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
  async remove(id: number, userId?: number) {
    const existing = await this.prisma.partnerRelationship.findUnique({
      where: { id },
      include: {
        type: true,
        partyA: { select: { displayName: true } },
        partyB: { select: { displayName: true } },
      },
    });
    if (!existing) throw new NotFoundException('Partner relationship not found');

    await this.prisma.partnerRelationship.update({
      where: { id },
      data: { validTo: new Date(), status: 'ended' },
    });

    try {
      await this.activityLog.write({
        category: 'partner',
        action: 'partner.relationship.ended',
        actorUserId: userId ?? null,
        projectId: null,
        entityType: 'partner_relationship',
        entityId: id,
        entityName: `${existing.partyA.displayName} → ${existing.partyB.displayName}`,
        description: `Ended "${existing.type.name}" relationship: ${existing.partyA.displayName} → ${existing.partyB.displayName}`,
        severity: 'warn',
      });
    } catch { /* swallow */ }

    return { message: 'Partner relationship ended' };
  }
}
