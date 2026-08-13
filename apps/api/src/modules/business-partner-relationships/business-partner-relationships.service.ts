import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateRelationshipDto, BprTargetType } from './dto/create-relationship.dto';
import { UpdateRelationshipDto } from './dto/update-relationship.dto';
import { QueryRelationshipsDto } from './dto/query-relationships.dto';

/**
 * BM2 Phase 1 (2026-08-13) — compat adapter.
 *
 * The legacy `business_partner_relationships` table was retired. This
 * service used to be a thin CRUD over that table; it's now a routing
 * facade over the two replacements:
 *   • `partner_relationships`   for `targetType='organization'`
 *   • `project_partner_roles`   for `targetType='project'`
 * `department` and `team` targets are rejected with 400 (there's no
 * live UI writing them, and no replacement table).
 *
 * ID namespace across the split (return / accept round-trip):
 *   • id in [1, 999_999_999]      → partner_relationships row
 *   • id in [1_000_000_000, …]    → project_partner_roles row
 *
 * The follow-up branch (`refactor/bp-ops-surfaces`) will migrate the
 * frontend to call the two clean endpoints directly and this file can
 * be deleted then.
 */

const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');
const PPR_ID_OFFSET = 1_000_000_000;

type LegacyShape = {
  id: number;
  sourcePartnerId: number;
  targetType: BprTargetType;
  targetId: number;
  relationshipTypeId: number;
  relationshipType: { id: number; code: string; name: string; inverseLabel: string | null } | null;
  source?: { id: number; displayName: string; partnerType: string };
  roleInContext: string | null;
  isPrimary: boolean;
  validFrom: Date;
  validTo: Date;
  status: string;
  notes: string | null;
};

@Injectable()
export class BusinessPartnerRelationshipsService {
  constructor(private prisma: PrismaService) {}

  // ─── Routing helpers ────────────────────────────────────────────────────

  private decodeId(id: number): { table: 'pr' | 'ppr'; realId: number } {
    if (id >= PPR_ID_OFFSET) return { table: 'ppr', realId: id - PPR_ID_OFFSET };
    return { table: 'pr', realId: id };
  }

  private encodePprId(id: number): number {
    return id + PPR_ID_OFFSET;
  }

  // ─── List / read ────────────────────────────────────────────────────────

  async findAll(q: QueryRelationshipsDto & { activeOnly?: boolean } = {} as any) {
    // Route by targetType. If none specified, aggregate both tables.
    const includeOrg = !q.targetType || q.targetType === 'organization';
    const includeProject = !q.targetType || q.targetType === 'project';

    const now = new Date();
    const rows: LegacyShape[] = [];

    if (includeOrg) {
      const where: Prisma.PartnerRelationshipWhereInput = {};
      if (q.sourcePartnerId) where.partyAId = q.sourcePartnerId;
      if (q.targetId && q.targetType === 'organization') where.partyBId = q.targetId;
      if (q.status) where.status = q.status;
      if (q.relationshipTypeCode) where.type = { code: q.relationshipTypeCode };
      if (q.activeOnly !== false) {
        where.validFrom = { lte: now };
        where.validTo = { gt: now };
      }
      const prs = await this.prisma.partnerRelationship.findMany({
        where,
        include: {
          type: true,
          partyA: { select: { id: true, displayName: true, partnerType: true } },
        },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
      });
      for (const r of prs) rows.push(this.prToLegacy(r));
    }

    if (includeProject) {
      const where: Prisma.ProjectPartnerRoleWhereInput = {};
      if (q.sourcePartnerId) where.partyId = q.sourcePartnerId;
      if (q.targetId && q.targetType === 'project') where.projectId = q.targetId;
      if (q.status) where.status = q.status;
      if (q.relationshipTypeCode) {
        // Map legacy PartnerRelationshipType code → new ProjectRoleType code.
        const projectCode = this.mapPartnerRelTypeCodeToProjectRoleCode(q.relationshipTypeCode);
        if (projectCode) where.role = { code: projectCode };
        else return rows; // no mapping = no matches in the project table
      }
      if (q.activeOnly !== false) {
        where.validFrom = { lte: now };
        where.validTo = { gt: now };
      }
      const pprs = await this.prisma.projectPartnerRole.findMany({
        where,
        include: {
          role: true,
          party: { select: { id: true, displayName: true, partnerType: true } },
        },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
      });
      for (const r of pprs) rows.push(this.pprToLegacy(r));
    }

    return rows;
  }

  async findOne(id: number) {
    const { table, realId } = this.decodeId(id);
    if (table === 'pr') {
      const r = await this.prisma.partnerRelationship.findUnique({
        where: { id: realId },
        include: {
          type: true,
          partyA: { select: { id: true, displayName: true, partnerType: true } },
        },
      });
      if (!r) throw new NotFoundException('Relationship not found');
      return this.prToLegacy(r);
    }
    const r = await this.prisma.projectPartnerRole.findUnique({
      where: { id: realId },
      include: {
        role: true,
        party: { select: { id: true, displayName: true, partnerType: true } },
      },
    });
    if (!r) throw new NotFoundException('Relationship not found');
    return this.pprToLegacy(r);
  }

  async findForTarget(targetType: BprTargetType, targetId: number) {
    return this.findAll({ targetType, targetId, activeOnly: true } as any);
  }

  // ─── Create / update / delete ───────────────────────────────────────────

  async create(dto: CreateRelationshipDto) {
    if (dto.targetType === 'department' || dto.targetType === 'team') {
      throw new BadRequestException(
        `targetType='${dto.targetType}' is retired. Use partner_relationships for party-to-party or project_partner_roles for project participation.`,
      );
    }

    if (dto.targetType === 'organization') {
      return this.createPartnerRelationship(dto);
    }
    // project
    return this.createProjectPartnerRole(dto);
  }

  private async createPartnerRelationship(dto: CreateRelationshipDto) {
    const source = await this.prisma.businessPartner.findFirst({
      where: { id: dto.sourcePartnerId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Source partner not found');

    const target = await this.prisma.businessPartner.findFirst({
      where: { id: dto.targetId, deletedAt: null },
    });
    if (!target) throw new NotFoundException('Target organization not found');

    const type = await this.prisma.partnerRelationshipType.findUnique({
      where: { id: dto.relationshipTypeId },
    });
    if (!type) throw new NotFoundException('Relationship type not found');

    // allowsMultiple=false: soft-end existing active rels of this type
    // for the source (same behaviour as the new partner-relationships svc).
    if (!type.allowsMultiple) {
      const now = new Date();
      await this.prisma.partnerRelationship.updateMany({
        where: {
          partyAId: dto.sourcePartnerId,
          typeId: dto.relationshipTypeId,
          validFrom: { lte: now },
          validTo: { gt: now },
        },
        data: { validTo: now, status: 'replaced' },
      });
    }

    try {
      const row = await this.prisma.partnerRelationship.create({
        data: {
          partyAId: dto.sourcePartnerId,
          partyBId: dto.targetId,
          typeId: dto.relationshipTypeId,
          isPrimary: dto.isPrimary ?? false,
          titleAtB: dto.roleInContext ?? null,
          validFrom: dto.validFrom ? new Date(dto.validFrom) : new Date(),
          validTo: dto.validTo ? new Date(dto.validTo) : FAR_FUTURE,
          notes: dto.notes ?? null,
        },
        include: {
          type: true,
          partyA: { select: { id: true, displayName: true, partnerType: true } },
        },
      });
      return this.prToLegacy(row);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException(
          'A relationship of this type already exists between these parties at this validity',
        );
      }
      throw err;
    }
  }

  private async createProjectPartnerRole(dto: CreateRelationshipDto) {
    const source = await this.prisma.businessPartner.findFirst({
      where: { id: dto.sourcePartnerId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Source partner not found');

    const project = await this.prisma.project.findFirst({
      where: { id: dto.targetId, deletedAt: null },
    });
    if (!project) throw new NotFoundException('Target project not found');

    // Map legacy PartnerRelationshipType → ProjectRoleType via code.
    const type = await this.prisma.partnerRelationshipType.findUnique({
      where: { id: dto.relationshipTypeId },
    });
    if (!type) throw new NotFoundException('Relationship type not found');
    const projectRoleCode = this.mapPartnerRelTypeCodeToProjectRoleCode(type.code);
    if (!projectRoleCode) {
      throw new BadRequestException(
        `Relationship type "${type.code}" cannot target a project. Use one of: customer_of_project, supplier_of_project, participates_in_project.`,
      );
    }
    const role = await this.prisma.projectRoleType.findUnique({ where: { code: projectRoleCode } });
    if (!role) {
      throw new BadRequestException(
        `project_role_types.code="${projectRoleCode}" missing — schema seed is broken.`,
      );
    }

    // customer_of_project uniqueness: at most one active per project.
    if (projectRoleCode === 'customer') {
      const now = new Date();
      const existing = await this.prisma.projectPartnerRole.findFirst({
        where: {
          projectId: dto.targetId,
          roleId: role.id,
          isPrimary: true,
          validFrom: { lte: now },
          validTo: { gt: now },
        },
      });
      if (existing) {
        throw new ConflictException(
          `Project ${dto.targetId} already has an active customer (project_partner_role id=${this.encodePprId(existing.id)}). End the existing one first.`,
        );
      }
    }

    try {
      const row = await this.prisma.projectPartnerRole.create({
        data: {
          projectId: dto.targetId,
          partyId: dto.sourcePartnerId,
          roleId: role.id,
          isPrimary: dto.isPrimary ?? (projectRoleCode === 'customer'),
          titleInProject: dto.roleInContext ?? null,
          validFrom: dto.validFrom ? new Date(dto.validFrom) : new Date(),
          validTo: dto.validTo ? new Date(dto.validTo) : FAR_FUTURE,
          notes: dto.notes ?? null,
        },
        include: {
          role: true,
          party: { select: { id: true, displayName: true, partnerType: true } },
        },
      });
      return this.pprToLegacy(row);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException(
          'This exact project participation already exists (same project, party, role, validFrom).',
        );
      }
      throw err;
    }
  }

  async update(id: number, dto: UpdateRelationshipDto) {
    const { table, realId } = this.decodeId(id);
    if (table === 'pr') {
      await this.assertPrExists(realId);
      const row = await this.prisma.partnerRelationship.update({
        where: { id: realId },
        data: {
          titleAtB: dto.roleInContext,
          isPrimary: dto.isPrimary,
          validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined,
          validTo: dto.validTo ? new Date(dto.validTo) : undefined,
          status: dto.status,
          notes: dto.notes,
        },
        include: {
          type: true,
          partyA: { select: { id: true, displayName: true, partnerType: true } },
        },
      });
      return this.prToLegacy(row);
    }
    await this.assertPprExists(realId);
    const row = await this.prisma.projectPartnerRole.update({
      where: { id: realId },
      data: {
        titleInProject: dto.roleInContext,
        isPrimary: dto.isPrimary,
        validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined,
        validTo: dto.validTo ? new Date(dto.validTo) : undefined,
        status: dto.status,
        notes: dto.notes,
      },
      include: {
        role: true,
        party: { select: { id: true, displayName: true, partnerType: true } },
      },
    });
    return this.pprToLegacy(row);
  }

  /**
   * Soft "disconnect": set valid_to = now() instead of physical delete.
   * History preserved for audit / SAP-style time travel.
   */
  async remove(id: number) {
    const { table, realId } = this.decodeId(id);
    if (table === 'pr') {
      await this.assertPrExists(realId);
      await this.prisma.partnerRelationship.update({
        where: { id: realId },
        data: { validTo: new Date(), status: 'ended' },
      });
    } else {
      await this.assertPprExists(realId);
      await this.prisma.projectPartnerRole.update({
        where: { id: realId },
        data: { validTo: new Date(), status: 'ended' },
      });
    }
    return { message: 'Relationship ended (soft-disconnected)' };
  }

  // ─── Helpers used by other modules (project create/update, etc.) ────────
  // These already speak the new project_partner_roles / partner_relationships
  // domain — they were migrated in the M3d cutover. Kept as-is here.

  /**
   * Add (or re-activate) a user's participation in a project as a
   * project_partner_role row with role.code='participant'.
   */
  async upsertProjectMemberRelationship(args: {
    userId: number;
    projectId: number;
    roleInContext?: string | null;
  }) {
    // Auto-link a BusinessPartner when the user is missing one (bm2 fix #7).
    // Legacy users seeded before the BP-per-user pattern had
    // businessPartnerId=NULL; this method used to silently return null and
    // getTeam — which reads from ProjectPartnerRole, not ProjectMember —
    // never showed the added person. Fetching a wider selection here lets
    // us mint (or reuse-by-email) a BP for those legacy accounts on the fly.
    const user = await this.prisma.user.findUnique({
      where: { id: args.userId },
      select: {
        id: true,
        businessPartnerId: true,
        firstName: true,
        lastName: true,
        firstNameHe: true,
        lastNameHe: true,
        email: true,
        phone: true,
      },
    });
    if (!user) return null;

    let businessPartnerId = user.businessPartnerId;
    if (!businessPartnerId) {
      const existingBp = await this.prisma.businessPartner.findFirst({
        where: { email: user.email, deletedAt: null },
      });
      if (existingBp) {
        businessPartnerId = existingBp.id;
      } else {
        const bp = await this.prisma.businessPartner.create({
          data: {
            partnerType: 'person',
            displayName: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            firstNameHe: user.firstNameHe ?? null,
            lastNameHe: user.lastNameHe ?? null,
            email: user.email,
            phone: user.phone ?? null,
            source: 'manual',
          },
        });
        businessPartnerId = bp.id;
      }
      await this.prisma.user.update({
        where: { id: user.id },
        data: { businessPartnerId },
      });
    }

    const role = await this.prisma.projectRoleType.findUnique({
      where: { code: 'participant' },
    });
    if (!role) return null;

    const now = new Date();
    const existing = await this.prisma.projectPartnerRole.findFirst({
      where: { projectId: args.projectId, partyId: businessPartnerId, roleId: role.id },
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
        partyId: businessPartnerId,
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
   * Set the customer for a project. Creates a project_partner_role row
   * with role.code='customer' marked isPrimary=true. Soft-ends any
   * previous primary customer assignment on the same project (history
   * preserved).
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

  // ─── Private helpers ─────────────────────────────────────────────────────

  private async assertPrExists(id: number) {
    const row = await this.prisma.partnerRelationship.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Relationship not found');
  }

  private async assertPprExists(id: number) {
    const row = await this.prisma.projectPartnerRole.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Relationship not found');
  }

  /** Map legacy PartnerRelationshipType.code → ProjectRoleType.code. */
  private mapPartnerRelTypeCodeToProjectRoleCode(code: string): string | null {
    switch (code) {
      case 'customer_of_project':
        return 'customer';
      case 'supplier_of_project':
        return 'supplier';
      case 'participates_in_project':
        return 'participant';
      default:
        return null;
    }
  }

  private prToLegacy(r: {
    id: number; partyAId: number; partyBId: number; typeId: number;
    type: { id: number; code: string; name: string; inverseLabel: string | null };
    partyA?: { id: number; displayName: string; partnerType: string };
    titleAtB: string | null; isPrimary: boolean;
    validFrom: Date; validTo: Date; status: string; notes: string | null;
  }): LegacyShape {
    return {
      id: r.id,
      sourcePartnerId: r.partyAId,
      targetType: 'organization',
      targetId: r.partyBId,
      relationshipTypeId: r.typeId,
      relationshipType: {
        id: r.type.id, code: r.type.code, name: r.type.name, inverseLabel: r.type.inverseLabel,
      },
      source: r.partyA ? {
        id: r.partyA.id, displayName: r.partyA.displayName, partnerType: r.partyA.partnerType,
      } : undefined,
      roleInContext: r.titleAtB,
      isPrimary: r.isPrimary,
      validFrom: r.validFrom,
      validTo: r.validTo,
      status: r.status,
      notes: r.notes,
    };
  }

  private pprToLegacy(r: {
    id: number; projectId: number; partyId: number; roleId: number;
    role: { id: number; code: string; name: string };
    party?: { id: number; displayName: string; partnerType: string };
    titleInProject: string | null; isPrimary: boolean;
    validFrom: Date; validTo: Date; status: string; notes: string | null;
  }): LegacyShape {
    // The `relationshipTypeId` in the legacy view was a
    // PartnerRelationshipType id; the new domain uses ProjectRoleType.id.
    // We synthesize a relationshipType with the project-role code/name so
    // the frontend's `relationshipType.code / name` display still works.
    return {
      id: this.encodePprId(r.id),
      sourcePartnerId: r.partyId,
      targetType: 'project',
      targetId: r.projectId,
      relationshipTypeId: r.roleId,
      relationshipType: {
        id: r.roleId, code: r.role.code, name: r.role.name, inverseLabel: null,
      },
      source: r.party ? {
        id: r.party.id, displayName: r.party.displayName, partnerType: r.party.partnerType,
      } : undefined,
      roleInContext: r.titleInProject,
      isPrimary: r.isPrimary,
      validFrom: r.validFrom,
      validTo: r.validTo,
      status: r.status,
      notes: r.notes,
    };
  }
}
