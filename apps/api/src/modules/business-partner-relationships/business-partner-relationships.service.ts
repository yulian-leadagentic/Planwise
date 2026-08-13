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

/**
 * Shape of one entry inside `partner_relationship_types.side_a_targets` /
 * `side_b_targets` (JSON column). Documented at the schema definition.
 */
interface SideTarget {
  kind: 'person' | 'organization' | 'project' | 'any';
  roleCodes?: string[];
  categoryCodes?: string[];
}

interface PartnerForValidation {
  partnerType: string;
  mainRoleType: { code: string; category: string | null } | null;
  roles: Array<{ roleType: { code: string; category: string | null } }>;
}

/**
 * Resolves a partner's role for validation, preferring the new Main Role
 * (single FK) and falling back to the legacy multi-role chips for
 * partial-data BPs. Returns role codes + role categories in two arrays
 * so SideTarget rules can check either dimension.
 */
function partnerRolesForValidation(bp: PartnerForValidation): {
  codes: string[];
  categories: string[];
} {
  if (bp.mainRoleType?.code) {
    return {
      codes: [bp.mainRoleType.code],
      categories: bp.mainRoleType.category ? [bp.mainRoleType.category] : [],
    };
  }
  // Legacy chip fallback — kept until the data migration to Main Role is
  // complete (some BPs may still have NULL main_role_type_id).
  return {
    codes: bp.roles.map((r) => r.roleType.code),
    categories: Array.from(
      new Set(
        bp.roles
          .map((r) => r.roleType.category)
          .filter((c): c is string => !!c),
      ),
    ),
  };
}

/**
 * Validates a partner against a SideTarget[] (JSON). The partner matches
 * if at least ONE entry passes ALL of: kind matches, roleCodes empty or
 * the partner holds one, categoryCodes empty or the partner holds one.
 *
 * Returns the matching entries' merged expected codes so the error
 * message can be specific ("must hold one of [supplier, customer]").
 */
function checkSideTargets(
  bp: PartnerForValidation,
  targets: SideTarget[] | null | undefined,
  actualKind: string,
): { ok: boolean; expectedCodes: string[]; expectedCategories: string[] } {
  if (!targets || targets.length === 0) return { ok: true, expectedCodes: [], expectedCategories: [] };

  const { codes, categories } = partnerRolesForValidation(bp);
  const kindMatched = targets.filter((t) => t.kind === 'any' || t.kind === actualKind);
  if (kindMatched.length === 0) {
    return { ok: false, expectedCodes: [], expectedCategories: [] };
  }

  for (const t of kindMatched) {
    const roleOk = !t.roleCodes?.length || t.roleCodes.some((rc) => codes.includes(rc));
    const catOk = !t.categoryCodes?.length || t.categoryCodes.some((cc) => categories.includes(cc));
    if (roleOk && catOk) return { ok: true, expectedCodes: [], expectedCategories: [] };
  }

  // No match — collect what was expected for the error message.
  const expectedCodes = Array.from(new Set(kindMatched.flatMap((t) => t.roleCodes ?? [])));
  const expectedCategories = Array.from(new Set(kindMatched.flatMap((t) => t.categoryCodes ?? [])));
  return { ok: false, expectedCodes, expectedCategories };
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
    // mainRoleType is loaded for the new role-validation path
    // (see partnerRolesForValidation). Legacy `roles` chips are loaded
    // too as the fallback when main role isn't set.
    const source = await this.prisma.businessPartner.findFirst({
      where: { id: dto.sourcePartnerId, deletedAt: null },
      include: {
        roles: { include: { roleType: true } },
        mainRoleType: true,
      },
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

    // ─── 5. SIDE-A (source) role validation ──────────────────────────
    // Prefer the structured sideATargets JSON (set via the admin Relationship
    // Type editor). When absent, fall back to the legacy requiredSourceRoleCode.
    // Either way the partner's Main Role is what we check against — that's
    // the single source of truth for "what role does this contact hold"
    // post the Roles -> Main Role simplification.
    const sideATargets = (relType as any).sideATargets as SideTarget[] | null;
    if (sideATargets && sideATargets.length > 0) {
      const r = checkSideTargets(source, sideATargets, source.partnerType);
      if (!r.ok) {
        const expected = [
          r.expectedCodes.length ? `main role ∈ {${r.expectedCodes.join(', ')}}` : null,
          r.expectedCategories.length ? `category ∈ {${r.expectedCategories.join(', ')}}` : null,
        ].filter(Boolean).join(' or ');
        const actual = source.mainRoleType?.code ?? '(none)';
        throw new BadRequestException(
          `Relationship "${relType.code}" requires the source partner to have ${expected || 'a matching role'}. This partner's main role is "${actual}".`,
        );
      }
    } else if (relType.requiredSourceRoleCode) {
      const { codes } = partnerRolesForValidation(source);
      if (!codes.includes(relType.requiredSourceRoleCode)) {
        throw new BadRequestException(
          `Relationship "${relType.code}" requires the source to hold role "${relType.requiredSourceRoleCode}". This partner holds: {${codes.join(', ') || 'none'}}.`,
        );
      }
    }

    // ─── 5b. SIDE-B (target) role validation ─────────────────────────
    // Only meaningful when the target is itself a BP. The current
    // RelationshipTarget enum makes 'organization' the only BP-typed
    // option — 'project' / 'department' / 'team' aren't BPs and so
    // never have a Main Role. (M2 may add 'person'; revisit then.)
    if (dto.targetType === 'organization') {
      const sideBTargets = (relType as any).sideBTargets as SideTarget[] | null;
      const legacyRequired = (relType as any).requiredTargetRoleCode as string | null;

      if ((sideBTargets && sideBTargets.length > 0) || legacyRequired) {
        const targetBp = await this.prisma.businessPartner.findFirst({
          where: { id: dto.targetId, deletedAt: null },
          include: {
            roles: { include: { roleType: true } },
            mainRoleType: true,
          },
        });
        if (!targetBp) throw new NotFoundException('Target partner not found');

        if (sideBTargets && sideBTargets.length > 0) {
          const r = checkSideTargets(targetBp, sideBTargets, dto.targetType);
          if (!r.ok) {
            const expected = [
              r.expectedCodes.length ? `main role ∈ {${r.expectedCodes.join(', ')}}` : null,
              r.expectedCategories.length ? `category ∈ {${r.expectedCategories.join(', ')}}` : null,
            ].filter(Boolean).join(' or ');
            const actual = targetBp.mainRoleType?.code ?? '(none)';
            throw new BadRequestException(
              `Relationship "${relType.code}" requires the target ${dto.targetType} to have ${expected || 'a matching role'}. This partner's main role is "${actual}".`,
            );
          }
        } else if (legacyRequired) {
          const { codes } = partnerRolesForValidation(targetBp);
          if (!codes.includes(legacyRequired)) {
            throw new BadRequestException(
              `Relationship "${relType.code}" requires the target ${dto.targetType} to hold role "${legacyRequired}". This partner holds: {${codes.join(', ') || 'none'}}.`,
            );
          }
        }
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
    // We now auto-link a BusinessPartner when the user is missing one
    // (bm2 fix #7). Legacy users seeded before the BP-per-user pattern
    // had businessPartnerId=NULL, so this method used to silently
    // return null and getTeam — which reads from ProjectPartnerRole,
    // not ProjectMember — never showed the added person. Fetching a
    // wider selection here lets us mint (or reuse-by-email) a BP for
    // those legacy accounts on the fly.
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
      // Backfill on demand — match the pattern used by
      // UsersService.create: first look for an existing BP with the
      // same email so we don't fork a duplicate person record, then
      // fall back to creating a fresh 'person' partner. Finally, link
      // it onto the user row so subsequent adds hit the fast path.
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
    // Look for any existing assignment regardless of validity. If active,
    // just touch it; if expired (soft-ended earlier), re-open it.
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
