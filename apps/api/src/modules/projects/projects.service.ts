import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { QueryProjectsDto } from './dto/query-projects.dto';
import { BusinessPartnerRelationshipsService } from '../business-partner-relationships/business-partner-relationships.service';
import { NumberRangesService } from '../number-ranges/number-ranges.service';

@Injectable()
export class ProjectsService {
  constructor(
    private prisma: PrismaService,
    private access: ProjectAccessService,
    private bpRelationships: BusinessPartnerRelationshipsService,
    private numberRanges: NumberRangesService,
  ) {}

  /**
   * Resolve the number range assigned to the PROJECT entity kind and report
   * how the project-number field should behave. Used by the create form to
   * lock the field (auto) or hint the pattern (manual/external).
   */
  async getNumberConfig(): Promise<{
    assigned: boolean;
    mode: 'auto' | 'manual' | 'external' | null;
    preview: string | null;
    externalPattern: string | null;
  }> {
    const kind = await this.prisma.entityKind.findUnique({
      where: { code: 'PROJECT' },
      select: { numberRangeCode: true },
    });
    const code = kind?.numberRangeCode ?? null;
    if (!code) return { assigned: false, mode: null, preview: null, externalPattern: null };
    const range = await this.prisma.numberRange.findUnique({ where: { code } });
    if (!range || !range.isActive) {
      return { assigned: false, mode: null, preview: null, externalPattern: null };
    }
    return {
      assigned: true,
      mode: range.mode as 'auto' | 'manual' | 'external',
      preview: range.mode === 'auto' ? await this.numberRanges.peek(code) : null,
      externalPattern: range.externalPattern ?? null,
    };
  }

  /**
   * Decide the project number to persist, honoring the PROJECT entity kind's
   * number range:
   *   • auto     → allocate the next code (the supplied number is ignored).
   *   • manual/external → require + validate the supplied number.
   *   • no range → use the supplied number as-is (free text, legacy behavior).
   * Existing/old project numbers don't matter here: `projects.number` has no
   * unique constraint and auto codes come from the range's own counter.
   */
  private async resolveProjectNumber(supplied?: string | null): Promise<string | null> {
    const kind = await this.prisma.entityKind.findUnique({
      where: { code: 'PROJECT' },
      select: { numberRangeCode: true },
    });
    const code = kind?.numberRangeCode ?? null;
    if (!code) return supplied?.trim() ? supplied.trim() : null;

    const range = await this.prisma.numberRange.findUnique({ where: { code } });
    if (!range || !range.isActive) return supplied?.trim() ? supplied.trim() : null;

    if (range.mode === 'auto') {
      // System-assigned — allocate the next code; ignore any client input.
      return this.numberRanges.next(code);
    }
    // manual / external — the user must supply a valid code.
    if (!supplied?.trim()) {
      throw new BadRequestException(
        `Project number is required (number range "${code}" is in ${range.mode} mode).`,
      );
    }
    return this.numberRanges.validateManual(code, supplied.trim());
  }

  async create(userId: number, dto: CreateProjectDto) {
    const { memberIds, leaderId, customerOrgId, roleAssignments, ...rest } = dto;

    // Validate the customer organization up-front so we don't leave a
    // dangling project if the relationship rules reject it. A customer is an
    // ORGANIZATION that holds the "customer" role (persons are excluded).
    const customerOrg = await this.prisma.businessPartner.findFirst({
      where: { id: customerOrgId, partnerType: 'organization', deletedAt: null },
      include: { roles: { include: { roleType: true } } },
    });
    if (!customerOrg) {
      throw new BadRequestException(
        `Customer organization (BP id=${customerOrgId}) not found. Pick an existing organization or use the "Internal" org for internal projects.`,
      );
    }
    const hasCustomerRole = customerOrg.roles.some((r) => r.roleType.code === 'customer');
    if (!hasCustomerRole) {
      throw new BadRequestException(
        `Organization "${customerOrg.displayName}" does not hold the "customer" role. Add it from /partners → Organizations before using this org as a project customer.`,
      );
    }

    // M4a.2 — Validate role assignments BEFORE creating the project so we
    // can fail fast without rolling back. Every ProjectRoleType with
    // isPrimaryRequired=true (excluding 'customer', which is handled
    // separately via customerOrgId) must have at least one assignment
    // marked isPrimary=true in the payload.
    const requiredRoles = await this.prisma.projectRoleType.findMany({
      where: { isPrimaryRequired: true, code: { not: 'customer' } },
    });
    if (requiredRoles.length > 0) {
      const provided = roleAssignments ?? [];
      for (const rt of requiredRoles) {
        const match = provided.find((a) => a.roleId === rt.id && a.isPrimary === true);
        if (!match) {
          throw new BadRequestException(
            `Project role "${rt.name}" is required (isPrimaryRequired=true). Provide a primary assignment for this role.`,
          );
        }
      }
    }

    // Resolve the project number from the PROJECT number range (auto → system
    // allocates and the supplied value is ignored; manual/external → validate;
    // no range → keep the free-text value). Done last, after all fail-fast
    // validation, so an auto code isn't burned on a rejected create.
    const number = await this.resolveProjectNumber(rest.number);

    const project = await this.prisma.project.create({
      data: {
        ...rest,
        number,
        leaderId: leaderId && leaderId > 0 ? leaderId : null,
        createdBy: userId,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
      },
      include: {
        projectType: true, department: true, categories: { include: { serviceType: true } },
        creator: { select: { id: true, firstName: true, lastName: true } },
        leader: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
      },
    });

    // Wire the customer_of_project relationship.
    try {
      await this.bpRelationships.setProjectCustomer(project.id, customerOrgId);
    } catch (err) {
      // Roll back the project to keep things consistent — a project without
      // a customer breaks our invariant.
      await this.prisma.project.delete({ where: { id: project.id } }).catch(() => undefined);
      throw err;
    }

    // M4a.2 — Persist the role assignments. The picker on the frontend
    // already filters candidates by allowedPartnerKind/requiredPartnerRoleCode,
    // and the create endpoint on project-partner-roles re-checks server-side.
    // We use the same service so the same validation runs.
    if (roleAssignments?.length) {
      for (const a of roleAssignments) {
        try {
          await this.prisma.projectPartnerRole.create({
            data: {
              projectId: project.id,
              partyId: a.partyId,
              roleId: a.roleId,
              isPrimary: a.isPrimary ?? false,
              titleInProject: a.titleInProject ?? null,
            },
          });
        } catch (err) {
          // Roll back: project + customer rel + any already-created assignments.
          await this.prisma.projectPartnerRole.deleteMany({ where: { projectId: project.id } }).catch(() => undefined);
          await this.prisma.project.delete({ where: { id: project.id } }).catch(() => undefined);
          throw new BadRequestException(
            `Failed to create role assignment (roleId=${a.roleId}, partyId=${a.partyId}): ${(err as Error).message}`,
          );
        }
      }
    }

    // Auto-add leader as a member with role "Project Leader"
    if (dto.leaderId) {
      await this.prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: project.id, userId: dto.leaderId } },
        create: { projectId: project.id, userId: dto.leaderId, role: 'Project Leader' },
        update: { role: 'Project Leader' },
      });
      try {
        await this.bpRelationships.upsertProjectMemberRelationship({
          userId: dto.leaderId,
          projectId: project.id,
          roleInContext: 'Project Leader',
        });
      } catch { /* best-effort write-through */ }
      // Also sync the team_leader Project Role assignment — the new
      // relation-based model that replaces Project.leaderId. Dual-write
      // keeps old read paths (which still consult leaderId) working
      // while new read paths use the relation. leaderId gets dropped
      // in M7 cleanup once all reads are migrated.
      await this.syncTeamLeaderRole(project.id, dto.leaderId);
    }

    // Create ProjectMember records for each member ID
    if (memberIds && memberIds.length > 0) {
      const memberData = memberIds
        .filter((id) => id !== dto.leaderId) // avoid duplicate if leader is also in memberIds
        .map((memberId) => ({ projectId: project.id, userId: memberId }));
      if (memberData.length > 0) {
        await this.prisma.projectMember.createMany({
          data: memberData,
          skipDuplicates: true,
        });
        for (const m of memberData) {
          try {
            await this.bpRelationships.upsertProjectMemberRelationship({
              userId: m.userId,
              projectId: project.id,
              roleInContext: null,
            });
          } catch { /* best-effort */ }
        }
      }
    }

    return project;
  }

  async findAll(query: QueryProjectsDto, userId?: number, roleId?: number | null) {
    const where: Prisma.ProjectWhereInput = {};

    // Project visibility scope. Admins (roleId=1) see everything; everyone
    // else only sees projects they're a member/leader/creator of. Same
    // accessor the execution board uses, so the two views agree. Falling
    // back to "show all" when userId isn't passed keeps backwards-compat
    // for any internal callers (seeds, scripts) that didn't supply it.
    if (userId != null) {
      const accessible = await this.access.getAccessibleProjectIds(userId, roleId);
      if (!accessible.all) {
        // No accessible projects → return empty result immediately rather
        // than passing `{ in: [] }` which Prisma treats as "match nothing"
        // anyway but is clearer to short-circuit here.
        if (accessible.projectIds.length === 0) {
          return {
            data: [],
            meta: { total: 0, page: query.page ?? 1, perPage: query.perPage ?? 20, totalPages: 0 },
          };
        }
        where.id = { in: accessible.projectIds };
      }
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.projectTypeId) {
      where.projectTypeId = query.projectTypeId;
    }

    if (query.search) {
      where.OR = [
        { name: { contains: query.search } },
        { number: { contains: query.search } },
      ];
    }

    if (query.isArchived !== undefined) {
      where.isArchived = query.isArchived;
    }

    // Member filter — match projects where the user is either the leader
    // OR an active member of the team. Combines with any existing AND/OR.
    if (query.memberId) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        {
          OR: [
            { leaderId: query.memberId },
            { members: { some: { userId: query.memberId } } },
          ],
        },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.project.findMany({
        where,
        skip: query.skip,
        take: query.take,
        orderBy: { createdAt: 'desc' },
        include: {
          projectType: true, department: true, categories: { include: { serviceType: true } },
          creator: { select: { id: true, firstName: true, lastName: true } },
          leader: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
          _count: { select: { members: true, labels: true, tasks: true, zones: true } },
          // Project Role assignments — surfaces the people-by-role so
          // the list page can render configurable columns (one per
          // ProjectRoleType the admin opts in to). Filtered to active
          // assignments so ended/historical rows don't clutter the
          // list. Minimal party fields kept to bound payload size.
          // The relation is named `partnerRoles` on the Project model
          // (the inverse side `projectPartnerRoles` lives on
          // BusinessPartner — easy to mix up).
          partnerRoles: {
            where: { status: 'active' },
            select: {
              id: true,
              roleId: true,
              isPrimary: true,
              titleInProject: true,
              party: {
                select: {
                  id: true,
                  displayName: true,
                  partnerType: true,
                  user: { select: { id: true, avatarUrl: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.project.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
        totalPages: Math.ceil(total / (query.perPage ?? 20)),
      },
    };
  }

  async findOne(id: number) {
    const project = await this.prisma.project.findFirst({
      where: { id },
      include: {
        projectType: true, department: true, categories: { include: { serviceType: true } },
        creator: { select: { id: true, firstName: true, lastName: true, email: true } },
        leader: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
        members: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
          },
        },
        labels: {
          where: { parentId: null },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return project;
  }

  async update(id: number, dto: UpdateProjectDto) {
    await this.findOne(id);
    const { memberIds, ...rest } = dto;

    const project = await this.prisma.project.update({
      where: { id },
      data: {
        ...rest,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
      },
      include: {
        projectType: true, department: true, categories: { include: { serviceType: true } },
        creator: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    // Ensure leader is a member
    if (dto.leaderId && dto.leaderId > 0) {
      await this.prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: id, userId: dto.leaderId } },
        create: { projectId: id, userId: dto.leaderId, role: 'Project Leader' },
        update: { role: 'Project Leader' },
      });
      // Dual-write to the new team_leader Project Role assignment.
      // See syncTeamLeaderRole() docstring for the rationale.
      await this.syncTeamLeaderRole(id, dto.leaderId);
    } else if (dto.leaderId === null) {
      // Leader explicitly cleared — end any active team_leader role.
      await this.syncTeamLeaderRole(id, null);
    }

    // Sync team members if provided: add new ones, remove ones no longer in the list
    // (but always keep the leader)
    if (memberIds !== undefined) {
      const existing = await this.prisma.projectMember.findMany({
        where: { projectId: id },
        select: { userId: true, role: true },
      });
      const existingIds = new Set(existing.map((m) => m.userId));
      const desiredIds = new Set(memberIds);
      if (dto.leaderId && dto.leaderId > 0) desiredIds.add(dto.leaderId);

      // Add new members
      const toAdd = [...desiredIds].filter((uid) => !existingIds.has(uid));
      if (toAdd.length > 0) {
        await this.prisma.projectMember.createMany({
          data: toAdd.map((uid) => ({
            projectId: id,
            userId: uid,
            role: uid === dto.leaderId ? 'Project Leader' : null,
          })),
          skipDuplicates: true,
        });
      }

      // Remove members no longer in the list (but never remove the leader)
      const toRemove = [...existingIds].filter(
        (uid) => !desiredIds.has(uid) && uid !== dto.leaderId,
      );
      if (toRemove.length > 0) {
        await this.prisma.projectMember.deleteMany({
          where: { projectId: id, userId: { in: toRemove } },
        });
      }
    }

    return project;
  }

  async remove(id: number) {
    const project = await this.prisma.project.findFirst({ where: { id } });
    if (!project) throw new NotFoundException('Project not found');

    // Delete in order: task assignees → tasks → zones → members → project
    await this.prisma.taskAssignee.deleteMany({ where: { task: { projectId: id } } });
    await this.prisma.taskComment.deleteMany({ where: { task: { projectId: id } } });
    await this.prisma.task.deleteMany({ where: { projectId: id } });
    await this.prisma.zone.deleteMany({ where: { projectId: id } });
    await this.prisma.projectMember.deleteMany({ where: { projectId: id } });
    await this.prisma.project.update({ where: { id }, data: { deletedAt: new Date() } });
    return { message: 'Project deleted' };
  }

  async addMember(projectId: number, userId: number, role?: string) {
    await this.findOne(projectId);

    const existing = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });

    if (existing) {
      throw new ConflictException('User is already a member of this project');
    }

    const member = await this.prisma.projectMember.create({
      data: { projectId, userId, role },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
      },
    });

    // Mirror to the new Business Partner relationships table.
    // Best-effort — a failure here shouldn't block the legacy write that the
    // rest of the app still reads from.
    try {
      await this.bpRelationships.upsertProjectMemberRelationship({
        userId,
        projectId,
        roleInContext: role ?? null,
      });
    } catch {
      // swallow — see comment above
    }

    return member;
  }

  async getMembers(projectId: number) {
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true, position: true } },
      },
    });
  }

  /**
   * Structured project team view, categorised by the relationship model:
   *
   *   - customer:           the single org with customer_of_project active
   *   - myTeam:             persons with participates_in_project who have
   *                          a User row (= internal employee of OUR co)
   *   - customerContacts:   persons with participates_in_project who are
   *                          worker_of the project's customer org
   *   - suppliers:          orgs with supplier_of_project, each with the
   *                          subset of myTeam-style participants who are
   *                          worker_of THAT supplier
   *
   * All data comes from the relationships table; no project columns added.
   * "Active" = validFrom <= now < validTo (BUT050-style time-bounded).
   */
  async getTeam(projectId: number) {
    await this.findOne(projectId);
    const now = new Date();

    // Customer + Project Team now come from project_partner_roles. Legacy
    // business_partner_relationships rows of types customer_of_project /
    // supplier_of_project / participates_in_project were deleted in
    // migration 20260511050000.
    const customerRoleType = await this.prisma.projectRoleType.findUnique({
      where: { code: 'customer' },
    });
    const participantRoleType = await this.prisma.projectRoleType.findUnique({
      where: { code: 'participant' },
    });

    const customerAssignment = customerRoleType
      ? await this.prisma.projectPartnerRole.findFirst({
          where: {
            projectId,
            roleId: customerRoleType.id,
            isPrimary: true,
            validFrom: { lte: now },
            validTo: { gt: now },
          },
          include: {
            party: {
              select: { id: true, displayName: true, email: true, phone: true },
            },
          },
        })
      : null;

    const participantAssignments = participantRoleType
      ? await this.prisma.projectPartnerRole.findMany({
          where: {
            projectId,
            roleId: participantRoleType.id,
            validFrom: { lte: now },
            validTo: { gt: now },
          },
          include: {
            party: {
              select: {
                id: true,
                partnerType: true,
                displayName: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                user: { select: { id: true, position: true } },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    const customerOrgId = customerAssignment?.party.id ?? null;

    // Project Team = participants whose party has a User row (internal staff).
    const projectTeam = participantAssignments
      .filter((a) => a.party.user?.id)
      .map((a) => ({
        relationshipId: a.id,
        businessPartnerId: a.party.id,
        userId: a.party.user!.id,
        displayName: a.party.displayName,
        firstName: a.party.firstName,
        lastName: a.party.lastName,
        email: a.party.email,
        phone: a.party.phone,
        position: a.party.user?.position ?? null,
        roleInContext: a.titleInProject,
        validFrom: a.validFrom,
        validTo: a.validTo,
      }));

    // Customer Contacts — anyone with an active relationship pointing at
    // the customer org (any rel type, source is a person). Org-level
    // association: contacts surface on every project of that customer.
    let customerContacts: any[] = [];
    if (customerOrgId != null) {
      const rows = await this.prisma.businessPartnerRelationship.findMany({
        where: {
          targetType: 'organization' as any,
          targetId: customerOrgId,
          status: 'active',
          validFrom: { lte: now },
          validTo: { gt: now },
          source: { partnerType: 'person', deletedAt: null },
        },
        include: {
          relationshipType: true,
          source: {
            select: {
              id: true,
              partnerType: true,
              displayName: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              user: { select: { id: true, position: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      });
      // Dedupe by source — a person might have multiple rels to the
      // customer org (e.g. worker_of + contact_of_customer).
      const seen = new Set<number>();
      customerContacts = rows
        .filter((r) => {
          if (seen.has(r.source.id)) return false;
          seen.add(r.source.id);
          return true;
        })
        .map((r) => ({
          relationshipId: r.id,
          relationshipTypeCode: r.relationshipType.code,
          relationshipTypeName: r.relationshipType.name,
          businessPartnerId: r.source.id,
          userId: r.source.user?.id ?? null,
          displayName: r.source.displayName,
          firstName: r.source.firstName,
          lastName: r.source.lastName,
          email: r.source.email,
          phone: r.source.phone,
          position: r.source.user?.position ?? null,
          validFrom: r.validFrom,
          validTo: r.validTo,
        }));
    }

    // Role-driven sections — all project_partner_role rows for this project,
    // enriched with role type + party metadata. Frontend renders one
    // section per ProjectRoleType using these. We exclude customer and
    // participant since those have their own pinned sections.
    const roleAssignments = await this.prisma.projectPartnerRole.findMany({
      where: {
        projectId,
        status: 'active',
        validFrom: { lte: now },
        validTo: { gt: now },
        role: { code: { notIn: ['customer', 'participant'] } },
      },
      include: {
        role: true,
        party: {
          select: {
            id: true,
            partnerType: true,
            displayName: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
      },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });

    return {
      customer: customerAssignment ? {
        relationshipId: customerAssignment.id,
        organizationId: customerAssignment.party.id,
        displayName: customerAssignment.party.displayName,
        email: customerAssignment.party.email,
        phone: customerAssignment.party.phone,
      } : null,
      customerContacts,
      projectTeam,
      roleAssignments: roleAssignments.map((a) => ({
        id: a.id,
        role: a.role,
        party: a.party,
        isPrimary: a.isPrimary,
        titleInProject: a.titleInProject,
        validFrom: a.validFrom,
        validTo: a.validTo,
        status: a.status,
      })),
    };
  }

  async removeMember(projectId: number, userId: number) {
    await this.prisma.projectMember.delete({
      where: { projectId_userId: { projectId, userId } },
    });
    try {
      await this.bpRelationships.removeProjectMemberRelationship({ userId, projectId });
    } catch {
      // best-effort write-through
    }
    return { message: 'Member removed' };
  }

  async setLeader(projectId: number, userId: number) {
    return this.prisma.project.update({
      where: { id: projectId },
      data: { leaderId: userId },
      include: { leader: { select: { id: true, firstName: true, lastName: true } } },
    });
  }

  async addDependency(taskId: number, dependsOnId: number) {
    // Prevent self-dependency
    if (taskId === dependsOnId) throw new BadRequestException('Task cannot depend on itself');
    // Prevent circular (A→B→A)
    const reverse = await this.prisma.taskDependency.findFirst({
      where: { taskId: dependsOnId, dependsOnId: taskId },
    });
    if (reverse) throw new BadRequestException('Circular dependency detected');

    return this.prisma.taskDependency.create({
      data: { taskId, dependsOnId },
      include: { dependsOn: { select: { id: true, code: true, name: true } } },
    });
  }

  async removeDependency(taskId: number, dependsOnId: number) {
    await this.prisma.taskDependency.delete({
      where: { taskId_dependsOnId: { taskId, dependsOnId } },
    });
    return { message: 'Dependency removed' };
  }

  async getBudgetSummary(projectId: number) {
    const project = await this.prisma.project.findFirstOrThrow({
      where: { id: projectId },
      include: { contracts: { where: { deletedAt: null } } },
    });

    const totals = await this.prisma.task.aggregate({
      where: { projectId, deletedAt: null, isArchived: false },
      _sum: { budgetHours: true, budgetAmount: true },
      _count: true,
    });

    // Helper to convert BigInt values to numbers in raw query results
    const serializeRaw = (rows: any[]) =>
      rows.map((row: any) => {
        const obj: any = {};
        for (const [k, v] of Object.entries(row)) {
          obj[k] = typeof v === 'bigint' ? Number(v) : v;
        }
        return obj;
      });

    const byZone = serializeRaw(await this.prisma.$queryRaw`
      SELECT z.id, z.name, z.path, z.depth,
        COALESCE(SUM(t.budget_hours), 0) as total_hours,
        COALESCE(SUM(t.budget_amount), 0) as total_amount,
        COUNT(t.id) as task_count
      FROM zones z
      LEFT JOIN tasks t ON t.zone_id = z.id AND t.deleted_at IS NULL AND t.is_archived = false
      WHERE z.project_id = ${projectId} AND z.deleted_at IS NULL
      GROUP BY z.id ORDER BY z.path
    `);

    const byServiceType = serializeRaw(await this.prisma.$queryRaw`
      SELECT st.id, st.name, st.code, st.color,
        COALESCE(SUM(t.budget_hours), 0) as total_hours,
        COALESCE(SUM(t.budget_amount), 0) as total_amount,
        COUNT(t.id) as task_count
      FROM tasks t
      LEFT JOIN service_types st ON st.id = t.service_type_id
      WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL AND t.is_archived = false
      GROUP BY st.id
    `);

    const byPhase = serializeRaw(await this.prisma.$queryRaw`
      SELECT p.id, p.name,
        COALESCE(SUM(t.budget_hours), 0) as total_hours,
        COALESCE(SUM(t.budget_amount), 0) as total_amount
      FROM tasks t
      LEFT JOIN phases p ON p.id = t.phase_id
      WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL AND t.is_archived = false
      GROUP BY p.id
    `);

    const contractTotal = (project.contracts || []).reduce(
      (sum: number, c: any) => sum + Number(c.totalAmount || 0), 0
    );

    return {
      project: { id: project.id, name: project.name, budget: project.budget },
      totals: {
        hours: Number(totals._sum.budgetHours || 0),
        amount: Number(totals._sum.budgetAmount || 0),
        taskCount: totals._count,
      },
      byZone,
      byServiceType,
      byPhase,
      comparison: {
        contractAmount: contractTotal,
        tasksTotal: Number(totals._sum.budgetAmount || 0),
        remaining: contractTotal - Number(totals._sum.budgetAmount || 0),
        remainingPct: contractTotal > 0
          ? Number(((contractTotal - Number(totals._sum.budgetAmount || 0)) / contractTotal * 100).toFixed(1))
          : null,
        status: Number(totals._sum.budgetAmount || 0) > contractTotal ? 'over_budget' : 'within_budget',
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // M5 — Project labor cost
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sums logged time on a project and resolves an hourly cost per user
   * using DATE-EFFECTIVE seniority — the level that was active for the
   * user on the day each TimeEntry was logged. Critical for accuracy
   * when an employee gets promoted mid-project: hours before the
   * promotion bill at the old rate, hours after at the new rate.
   *
   * Resolution rule:
   *   for each entry e:
   *     level = user_seniorities row where userId=e.userId AND
   *             startDate <= e.date <= (endDate ?? infinity)
   *     cost += (e.minutes / 60) * level.defaultHourlyCost
   *
   * The output groups by (user, level), so a user with multiple levels
   * during the project surfaces as multiple rows ("Alice as Senior:
   * 10h" + "Alice as Lead: 5h"). UI rendering doesn't change — same
   * row shape as before, just more rows for promoted users.
   *
   * Users whose entries have no covering seniority row (or whose level
   * has no defaultHourlyCost) land in `unrateable` so admins see the
   * gap and can fix it via the seniority-history editor.
   *
   * Costs are grouped per-currency. We deliberately do NOT FX-convert
   * (no rate table, no policy decision), so a mixed-currency project
   * surfaces both totals separately.
   */
  async getLaborCost(projectId: number) {
    await this.prisma.project.findFirstOrThrow({
      where: { id: projectId, deletedAt: null },
      select: { id: true },
    });

    const entries = await this.prisma.timeEntry.findMany({
      // Resolve project membership via the task, NOT entry.projectId.
      // That column is NULL on many historical entries (QuickTimeLog /
      // TaskDrawer paths didn't set it consistently), so filtering on
      // it would silently drop their hours from the cost rollup.
      where: { deletedAt: null, task: { projectId } },
      select: {
        minutes: true,
        userId: true,
        date: true,
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            position: true,
          },
        },
      },
    });

    // Pre-load every contributor's full seniority history in ONE query
    // so the per-entry effective-level lookup runs entirely in memory.
    // N+1 would explode quickly on large projects.
    const userIds = Array.from(new Set(entries.map((e) => e.userId)));
    const histories = userIds.length === 0 ? [] : await this.prisma.userSeniority.findMany({
      where: { userId: { in: userIds } },
      include: {
        seniorityLevel: { select: { id: true, name: true, defaultHourlyCost: true, currency: true } },
      },
      orderBy: { startDate: 'desc' },
    });
    const historyByUser = new Map<number, typeof histories>();
    for (const h of histories) {
      if (!historyByUser.has(h.userId)) historyByUser.set(h.userId, []);
      historyByUser.get(h.userId)!.push(h);
    }

    /** Resolve the seniority level effective for userId on date. */
    const effectiveAt = (userId: number, date: Date) => {
      const list = historyByUser.get(userId) ?? [];
      // history is sorted descending by startDate; first match wins.
      for (const row of list) {
        if (row.startDate <= date && (row.endDate === null || row.endDate >= date)) {
          return row.seniorityLevel;
        }
      }
      return null;
    };

    // Local snapshot type. Exported as a `type` (vs interface) so
    // TypeScript can synthesize a structural return type for
    // getLaborCost() without requiring the type itself to be exported.
    type UserSnapshot = {
      id: number;
      firstName: string;
      lastName: string;
      avatarUrl: string | null;
      position: string | null;
    };
    const userById = new Map<number, UserSnapshot>();
    for (const e of entries) {
      if (!userById.has(e.userId)) {
        userById.set(e.userId, {
          id: e.user.id,
          firstName: e.user.firstName,
          lastName: e.user.lastName,
          avatarUrl: e.user.avatarUrl,
          position: e.user.position,
        });
      }
    }

    // Bucket per (userId, levelId). A user with multiple seniority
    // periods on the same project shows as multiple rows.
    interface RateableBucket {
      user: UserSnapshot;
      seniorityLevel: { id: number; name: string };
      hourlyCost: number;
      currency: string;
      minutes: number;
    }
    const rateable = new Map<string, RateableBucket>();
    const unrateableMinutes = new Map<number, { user: UserSnapshot; reason: string; minutes: number }>();

    for (const e of entries) {
      const level = effectiveAt(e.userId, e.date);
      const user = userById.get(e.userId)!;
      if (!level) {
        const cur = unrateableMinutes.get(e.userId) ?? { user, reason: 'No seniority history covers the entry date', minutes: 0 };
        cur.minutes += e.minutes;
        unrateableMinutes.set(e.userId, cur);
        continue;
      }
      if (level.defaultHourlyCost == null) {
        const cur = unrateableMinutes.get(e.userId) ?? { user, reason: `Seniority "${level.name}" has no hourly cost configured`, minutes: 0 };
        cur.minutes += e.minutes;
        unrateableMinutes.set(e.userId, cur);
        continue;
      }
      const key = `${e.userId}|${level.id}`;
      let b = rateable.get(key);
      if (!b) {
        b = {
          user,
          seniorityLevel: { id: level.id, name: level.name },
          hourlyCost: Number(level.defaultHourlyCost),
          // Currency on the SeniorityLevel is optional; tag 'UNK' so
          // the UI can flag the data gap without dropping the row.
          currency: level.currency || 'UNK',
          minutes: 0,
        };
        rateable.set(key, b);
      }
      b.minutes += e.minutes;
    }

    const byUser: Array<{
      user: UserSnapshot;
      seniorityLevel: { id: number; name: string } | null;
      hours: number;
      hourlyCost: number;
      currency: string;
      cost: number;
    }> = [];
    const unrateable: Array<{
      user: UserSnapshot;
      hours: number;
      reason: string;
    }> = [];
    const totalsByCurrency = new Map<string, { hours: number; cost: number; userCount: number }>();
    let totalUnrateableHours = 0;

    for (const b of rateable.values()) {
      const hours = b.minutes / 60;
      const cost = hours * b.hourlyCost;
      byUser.push({
        user: b.user,
        seniorityLevel: b.seniorityLevel,
        hours,
        hourlyCost: b.hourlyCost,
        currency: b.currency,
        cost,
      });
      const cur = totalsByCurrency.get(b.currency) ?? { hours: 0, cost: 0, userCount: 0 };
      cur.hours += hours;
      cur.cost += cost;
      // userCount counts distinct (user, level) pairs in this bucket —
      // good enough for the summary (mostly matches "distinct users").
      cur.userCount += 1;
      totalsByCurrency.set(b.currency, cur);
    }
    for (const u of unrateableMinutes.values()) {
      const hours = u.minutes / 60;
      unrateable.push({ user: u.user, hours, reason: u.reason });
      totalUnrateableHours += hours;
    }

    // Sort byUser descending by cost so the most expensive contributors
    // float to the top of the breakdown table — that's typically what
    // the project manager wants to see first.
    byUser.sort((a, b) => b.cost - a.cost);

    return {
      projectId,
      totals: {
        // Per-currency aggregates rather than a single number, because
        // FX conversion is a separate decision we're not making here.
        byCurrency: Array.from(totalsByCurrency.entries()).map(([currency, t]) => ({
          currency,
          totalHours: +t.hours.toFixed(2),
          totalCost: +t.cost.toFixed(2),
          userCount: t.userCount,
        })),
        // Grand total of logged hours — sums every contributor, rated or
        // not, so the UI can show "X hours logged total, Y$ resolved".
        totalLoggedHours: +(byUser.reduce((s, u) => s + u.hours, 0) + totalUnrateableHours).toFixed(2),
        unrateableHours: +totalUnrateableHours.toFixed(2),
        unrateableUserCount: unrateable.length,
      },
      byUser: byUser.map((u) => ({
        ...u,
        hours: +u.hours.toFixed(2),
        cost: +u.cost.toFixed(2),
      })),
      unrateable: unrateable.map((u) => ({
        ...u,
        hours: +u.hours.toFixed(2),
      })),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Team Leader → ProjectPartnerRole sync
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Mirrors `Project.leaderId` onto the team_leader ProjectPartnerRole.
   * Called from create() and update() whenever the leader changes.
   *
   * Why dual-write: the new model treats Team Leader as just another
   * Project Role Type (alongside BIM Leader, Architect, …). The legacy
   * leaderId column will be dropped in M7 once every read path is
   * migrated; until then we keep both representations in sync so old
   * and new reads agree.
   *
   * Behavior:
   *   - leaderUserId set    → end any active team_leader role, then
   *                           create a fresh one for the new user
   *   - leaderUserId null   → end any active team_leader role only
   *
   * Skips silently when the user has no linked BusinessPartner — the
   * relation requires a party_id (BP), not a user_id.
   */
  private async syncTeamLeaderRole(projectId: number, leaderUserId: number | null): Promise<void> {
    const teamLeaderRole = await this.prisma.projectRoleType.findUnique({
      where: { code: 'team_leader' },
      select: { id: true },
    });
    if (!teamLeaderRole) return; // role-type catalog hasn't been seeded yet

    const now = new Date();

    // End any currently-active team_leader assignment(s). Hard-delete
    // rather than soft-end so the unique constraint
    // (projectId, partyId, roleId, validFrom) doesn't collide with the
    // new row we're about to insert.
    await this.prisma.projectPartnerRole.deleteMany({
      where: {
        projectId,
        roleId: teamLeaderRole.id,
        status: 'active',
      },
    });

    if (leaderUserId == null) return;

    const user = await this.prisma.user.findUnique({
      where: { id: leaderUserId },
      select: { businessPartnerId: true },
    });
    if (!user?.businessPartnerId) return; // user has no linked BP → can't be a party

    await this.prisma.projectPartnerRole.create({
      data: {
        projectId,
        partyId: user.businessPartnerId,
        roleId: teamLeaderRole.id,
        isPrimary: true,
        validFrom: now,
        status: 'active',
      },
    });
  }
}
