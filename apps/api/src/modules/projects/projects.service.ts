import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { QueryProjectsDto } from './dto/query-projects.dto';
import { BusinessPartnerRelationshipsService } from '../business-partner-relationships/business-partner-relationships.service';

@Injectable()
export class ProjectsService {
  constructor(
    private prisma: PrismaService,
    private bpRelationships: BusinessPartnerRelationshipsService,
  ) {}

  async create(userId: number, dto: CreateProjectDto) {
    const { memberIds, leaderId, customerOrgId, roleAssignments, ...rest } = dto;

    // Validate the customer organization up-front so we don't leave a
    // dangling project if the relationship rules reject it.
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

    const project = await this.prisma.project.create({
      data: {
        ...rest,
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

  async findAll(query: QueryProjectsDto) {
    const where: Prisma.ProjectWhereInput = {};

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
   * from their assigned SeniorityLevel.defaultHourlyCost.
   *
   * Resolution rule (intentionally simple for v1):
   *   cost = sum(timeEntry.minutes / 60 * user.seniorityLevel.defaultHourlyCost)
   *
   * Users whose cost can't be resolved (no seniority, or seniority has no
   * defaultHourlyCost) are split out into `unrateable` so admins see the
   * gap and can fix the assignments — not silently bucketed at 0 which
   * would understate the project's true cost.
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
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            position: true,
            seniorityLevel: {
              select: {
                id: true,
                name: true,
                defaultHourlyCost: true,
                currency: true,
              },
            },
          },
        },
      },
    });

    // Bucket minutes by user. One pass through the entries; no DB
    // calls in the loop. Sets the per-user seniority snapshot the first
    // time we see them (it's the same user across all entries).
    interface UserBucket {
      user: {
        id: number;
        firstName: string;
        lastName: string;
        avatarUrl: string | null;
        position: string | null;
      };
      seniorityLevel: { id: number; name: string; defaultHourlyCost: any; currency: string | null } | null;
      minutes: number;
    }
    const byUserId = new Map<number, UserBucket>();
    for (const e of entries) {
      let b = byUserId.get(e.userId);
      if (!b) {
        b = {
          user: {
            id: e.user.id,
            firstName: e.user.firstName,
            lastName: e.user.lastName,
            avatarUrl: e.user.avatarUrl,
            position: e.user.position,
          },
          seniorityLevel: e.user.seniorityLevel ?? null,
          minutes: 0,
        };
        byUserId.set(e.userId, b);
      }
      b.minutes += e.minutes;
    }

    const byUser: Array<{
      user: UserBucket['user'];
      seniorityLevel: { id: number; name: string } | null;
      hours: number;
      hourlyCost: number;
      currency: string;
      cost: number;
    }> = [];
    const unrateable: Array<{
      user: UserBucket['user'];
      hours: number;
      reason: string;
    }> = [];
    // Per-currency totals. Map keys are 3-letter currency codes
    // (or 'UNK' when a seniority has no currency set).
    const totalsByCurrency = new Map<string, { hours: number; cost: number; userCount: number }>();
    let totalUnrateableHours = 0;

    for (const b of byUserId.values()) {
      const hours = b.minutes / 60;
      if (!b.seniorityLevel) {
        unrateable.push({ user: b.user, hours, reason: 'No seniority level assigned' });
        totalUnrateableHours += hours;
        continue;
      }
      if (b.seniorityLevel.defaultHourlyCost == null) {
        unrateable.push({
          user: b.user,
          hours,
          reason: `Seniority "${b.seniorityLevel.name}" has no hourly cost configured`,
        });
        totalUnrateableHours += hours;
        continue;
      }
      const hourlyCost = Number(b.seniorityLevel.defaultHourlyCost);
      // Currency on the SeniorityLevel is optional (column is nullable);
      // when missing we still surface the cost number but tag it 'UNK'
      // so the UI can flag the data gap without dropping the row.
      const currency = b.seniorityLevel.currency || 'UNK';
      const cost = hours * hourlyCost;
      byUser.push({
        user: b.user,
        seniorityLevel: { id: b.seniorityLevel.id, name: b.seniorityLevel.name },
        hours,
        hourlyCost,
        currency,
        cost,
      });
      const cur = totalsByCurrency.get(currency) ?? { hours: 0, cost: 0, userCount: 0 };
      cur.hours += hours;
      cur.cost += cost;
      cur.userCount += 1;
      totalsByCurrency.set(currency, cur);
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
}
