import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';

import { PrismaService } from '../../prisma/prisma.service';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { QueryProjectsDto } from './dto/query-projects.dto';
import { ProjectPartnerRolesService } from '../project-partner-roles/project-partner-roles.service';
import { NumberRangesService } from '../number-ranges/number-ranges.service';
import { rollupTaskCompletion } from '../../common/task-completion';
import * as Sentry from '@sentry/node';

/**
 * True when the caller can see financial data. Mirrors the frontend's
 * finance:read gate so the same user sees the same surfaces top-to-bottom
 * (no "I can't see budget on the row but I can scrape it from
 * /projects/:id directly via DevTools" gap).
 */
function callerCanReadFinance(user: any): boolean {
  if (!user) return false;
  if (user.roleId === 1) return true;
  const mods: any[] = user.roleModules ?? [];
  return mods.some((rm) => {
    const route = rm.module?.route ?? '';
    const name = (rm.module?.name ?? '').toLowerCase();
    return (route === 'finance' || route === '/finance' || name === 'finance') && !!rm.canRead;
  });
}

/**
 * Strip finance-sensitive fields from a project payload. Pure — never mutates.
 *
 * `actualCost` is the rolled-up labor cost (logged hours × seniority hourly
 * cost) added by `findAll` for the projects list. It's the same shape of data
 * as `budget` / `estimatedValue`, so it rides on the same finance gate. Hours
 * and completion % are NOT stripped — the list header shows them regardless.
 */
function omitBudget<T extends Record<string, any>>(p: T): Omit<T, 'budget' | 'estimatedValue' | 'actualCost'> {
  if (!p) return p as any;
  const { budget: _b, estimatedValue: _e, actualCost: _c, ...rest } = p;
  return rest as any;
}

@Injectable()
export class ProjectsService {
  constructor(
    private prisma: PrismaService,
    private access: ProjectAccessService,
    private projectPartnerRoles: ProjectPartnerRolesService,
    private numberRanges: NumberRangesService,
    private activityLog: ActivityLogService,
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
      await this.projectPartnerRoles.setProjectCustomer(project.id, customerOrgId);
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
        await this.projectPartnerRoles.upsertProjectMemberRelationship({
          userId: dto.leaderId,
          projectId: project.id,
          roleInContext: 'Project Leader',
        });
      } catch (e) { Sentry.captureException(e); /* best-effort write-through */ }
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
            await this.projectPartnerRoles.upsertProjectMemberRelationship({
              userId: m.userId,
              projectId: project.id,
              roleInContext: null,
            });
          } catch (e) { Sentry.captureException(e); /* best-effort */ }
        }
      }
    }

    // Audit trail — surfaced in the project's Activity tab.
    await this.activityLog.logProjectCreated({
      actorUserId: userId,
      projectId: project.id,
      entityId: project.id,
      projectName: project.name,
    });

    return project;
  }

  async findAll(query: QueryProjectsDto, userId?: number, roleId?: number | null, caller?: any) {
    const where: Prisma.ProjectWhereInput = {};

    // Project visibility scope. Admins (roleId=1) see everything; everyone
    // else only sees projects they're a member/leader/creator of. Same
    // accessor the execution board uses, so the two views agree. Falling
    // back to "show all" when userId isn't passed keeps backwards-compat
    // for any internal callers (seeds, scripts) that didn't supply it.
    const hasFinance = callerCanReadFinance(caller);

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

    // Hide CLOSED projects from the default list. T3.6+7, 2026-06-28.
    // Three states (closedOnly takes precedence over includeClosed):
    //   • closedOnly=true  → ONLY closed projects     (closedAt IS NOT NULL)
    //   • includeClosed=true → include both          (no closedAt filter)
    //   • default          → only open projects      (closedAt IS NULL)
    if (query.closedOnly) {
      where.closedAt = { not: null };
    } else if (!query.includeClosed) {
      where.closedAt = null;
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

    // Member filter — match projects where ANY of the requested users
    // is on the project via ANY of the paths we consider "on the team":
    //   • leader (project.leaderId)
    //   • legacy internal team (ProjectMember.userId)
    //   • ProjectPartnerRole.party.user  (person party)
    //   • ProjectPartnerRole.contactParty.user  (contact person on an
    //     org party — e.g. the BIM Manager who represents a firm)
    // UNION across users AND across paths — a chip stack "Alice, Bob"
    // returns projects on which Alice OR Bob appears via ANY path.
    //
    // fix/people-filter (2026-08-25). The previous single-`memberId`
    // form only walked the first two paths, so a person present ONLY
    // as a project-partner-role holder (BIM Manager, BIM Coordinator,
    // ...) was invisible to the filter — Alex Isakov on 3 projects,
    // filter returned 2. `memberId` still accepted as an alias for a
    // one-element `memberIds`.
    const memberIds: number[] = query.memberIds
      ? Array.from(new Set(query.memberIds))
      : query.memberId
        ? [query.memberId]
        : [];
    if (memberIds.length > 0) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        {
          OR: memberIds.flatMap((userId) => [
            { leaderId: userId },
            { members: { some: { userId } } },
            {
              partnerRoles: {
                some: {
                  status: 'active',
                  OR: [
                    { party: { user: { id: userId } } },
                    { contactParty: { user: { id: userId } } },
                  ],
                },
              },
            },
          ]),
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

    // Per-project actuals for the list — Hours + Cost + Completion %.
    // Computed BATCHED across every project id on this page (up to 100
    // rows) so the list stays a small handful of queries no matter how
    // many projects come back. Doing this per-row would issue an
    // O(N × [entries + seniority + tasks]) fan-out and re-implement
    // getLaborCost() / getProjectProgress() at the wrong scale.
    //
    // Formulas MUST match the in-project surfaces so the list agrees
    // with the detail page:
    //   • Hours + Cost mirror `getLaborCost` (:1500+) — same seniority
    //     history resolution, same "unrateable minutes still count
    //     toward Hours but not toward Cost" rule.
    //   • Completion mirrors `execution-planning.service#getProjectProgress`
    //     (:319+) — budget-hours-weighted average of `task.completionPct`,
    //     with a simple-mean fallback when the whole bucket has zero
    //     budget hours so a project of Done tasks reads 100 and not 0.
    //     `task.completionPct` itself is already status-aware (100 for
    //     completed/cancelled, 90 for in_review) — see
    //     `time-entries.service#syncTaskCompletion` — so we just trust
    //     the stored value.
    const pageIds: number[] = data.map((p) => p.id);

    // ── Hours + Cost ─────────────────────────────────────────────────
    // Resolve project via `task.projectId`, NOT `entry.projectId`. The
    // scalar on TimeEntry is nullable and historically NULL on many
    // rows (QuickTimeLog / TaskDrawer paths didn't populate it), so a
    // filter on `entry.projectId` silently drops those hours. See the
    // matching note in `getLaborCost` (:1507–1511).
    const entries = pageIds.length === 0 ? [] : await this.prisma.timeEntry.findMany({
      where: { deletedAt: null, task: { projectId: { in: pageIds } } },
      select: {
        minutes: true,
        userId: true,
        date: true,
        task: { select: { projectId: true } },
      },
    });

    // Pre-load every contributor's seniority history in ONE query so
    // the per-entry effective-level lookup runs entirely in memory.
    // Shape mirrors `getLaborCost` (:1532–1543); kept inline (rather
    // than extracted to a shared helper) because the per-row rollup
    // here is narrower — we only need hourlyCost, not currency or the
    // per-user breakdown — and coupling the list rollup to the detail
    // aggregator would make future changes to either side awkward.
    const contributorIds = Array.from(new Set(entries.map((e) => e.userId)));
    const histories = contributorIds.length === 0 ? [] : await this.prisma.userSeniority.findMany({
      where: { userId: { in: contributorIds } },
      include: {
        seniorityLevel: { select: { id: true, defaultHourlyCost: true } },
      },
      orderBy: { startDate: 'desc' },
    });
    const historyByUser = new Map<number, typeof histories>();
    for (const h of histories) {
      if (!historyByUser.has(h.userId)) historyByUser.set(h.userId, []);
      historyByUser.get(h.userId)!.push(h);
    }
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

    const hoursByProject = new Map<number, number>();
    const costByProject = new Map<number, number>();
    for (const e of entries) {
      const projectId = e.task?.projectId ?? null;
      if (projectId == null) continue;
      const hours = e.minutes / 60;
      // Hours always count — even for unrateable users (no seniority,
      // or a seniority with no hourly cost). Same treatment as
      // `getLaborCost`, which surfaces those minutes in a separate
      // `unrateable` bucket but includes them in `totalLoggedHours`.
      hoursByProject.set(projectId, (hoursByProject.get(projectId) ?? 0) + hours);
      const level = effectiveAt(e.userId, e.date);
      if (!level || level.defaultHourlyCost == null) continue;
      costByProject.set(
        projectId,
        (costByProject.get(projectId) ?? 0) + hours * Number(level.defaultHourlyCost),
      );
    }

    // ── Completion % ─────────────────────────────────────────────────
    // Same filter as `execution-planning.service#getProjectProgress`:
    // exclude soft-deleted, archived, and personal tasks. Personal
    // tasks are a user's own to-do list and shouldn't drag a project's
    // completion bar around (Tier D #1).
    //
    // Status + budget + logged minutes come out per task; the rollup
    // itself is delegated to `rollupTaskCompletion` (../../common/
    // task-completion) so this surface, `execution-planning.service#
    // getProjectProgress`, and the web helper `apps/web/src/lib/
    // completion-rollup.ts` can never drift. Per-task value is now
    // recomputed from status at READ time — a stale stored
    // `completionPct` on a completed task no longer collapses the
    // whole project's Completion to 0 (the BIM-management repro).
    const tasksForRollup = pageIds.length === 0 ? [] : await this.prisma.task.findMany({
      where: {
        projectId: { in: pageIds },
        deletedAt: null,
        isArchived: false,
        isPersonal: false,
      },
      select: { id: true, projectId: true, status: true, budgetHours: true },
    });
    // Aggregate logged minutes per task in one groupBy — mirrors the
    // pattern used by `execution-board.service` / the enriched
    // getProjectProgress above so all completion surfaces derive from
    // the same source of truth.
    const rollupTaskIds = tasksForRollup.map((t) => t.id);
    const rollupTimeAgg = rollupTaskIds.length === 0 ? [] : await this.prisma.timeEntry.groupBy({
      by: ['taskId'],
      where: { taskId: { in: rollupTaskIds }, deletedAt: null },
      _sum: { minutes: true },
    });
    const loggedByRollupTask = new Map<number, number>();
    for (const row of rollupTimeAgg) {
      if (row.taskId) loggedByRollupTask.set(row.taskId, row._sum.minutes ?? 0);
    }

    const tasksByProject = new Map<number, Array<{ status: string; budgetHours: unknown; loggedMinutes: number }>>();
    for (const t of tasksForRollup) {
      if (t.projectId == null) continue;
      if (!tasksByProject.has(t.projectId)) tasksByProject.set(t.projectId, []);
      tasksByProject.get(t.projectId)!.push({
        status: t.status,
        budgetHours: t.budgetHours as unknown,
        loggedMinutes: loggedByRollupTask.get(t.id) ?? 0,
      });
    }

    // Merge the rollups into each row. Numbers are rounded to 2dp
    // (Hours/Cost) and 0dp (%) at the API boundary so the client
    // renders a stable label and doesn't need to re-round.
    const enriched = data.map((p) => ({
      ...p,
      actualHours: +(hoursByProject.get(p.id) ?? 0).toFixed(2),
      actualCost: +(costByProject.get(p.id) ?? 0).toFixed(2),
      completionPct: rollupTaskCompletion(tasksByProject.get(p.id) ?? []),
    }));

    return {
      // Strip budget + estimatedValue + actualCost when the caller
      // lacks finance:read. This is the response-shaping side of the
      // gate; the UI side lives in project-list-page.tsx /
      // project-detail-page.tsx. actualHours + completionPct are NOT
      // gated (the header shows Completion to everyone; Hours is
      // already behind `showFinance` on the client, but there's no
      // reason to hide raw hours from a non-finance user server-side).
      data: hasFinance ? enriched : enriched.map((p: any) => omitBudget(p)),
      meta: {
        total,
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
        totalPages: Math.ceil(total / (query.perPage ?? 20)),
      },
    };
  }

  async findOne(id: number, caller?: any) {
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

    // Resolve BIM Leader for the task drawer "BIM Leader" row. Read from
    // ProjectPartnerRole (the canonical home for project role assignments,
    // alongside team_leader/customer/etc.). We look up the BP, then walk
    // back to the User row so the UI gets the same shape as `leader`.
    let bimLeader: { id: number; firstName: string | null; lastName: string | null; avatarUrl: string | null } | null = null;
    const bimRoleType = await this.prisma.projectRoleType.findUnique({ where: { code: 'bim_leader' } });
    if (bimRoleType) {
      const now = new Date();
      const ppr = await this.prisma.projectPartnerRole.findFirst({
        where: {
          projectId: id,
          roleId: bimRoleType.id,
          OR: [{ validTo: { gte: now } as any }, { validTo: undefined as any }],
        },
        // Pull firstName/lastName off the BP too — when the role's party
        // isn't linked to a User account, we'd previously fall back to
        // just `displayName` (often a short string like "Ea") which
        // didn't read as a person's name. With first/last available we
        // can build a proper "Firstname Lastname" label.
        include: {
          party: {
            select: { id: true, displayName: true, firstName: true, lastName: true },
          },
        },
      });
      if (ppr?.party?.id) {
        const u = await this.prisma.user.findFirst({
          where: { businessPartnerId: ppr.party.id, isActive: true },
          select: { id: true, firstName: true, lastName: true, avatarUrl: true },
        });
        if (u) {
          bimLeader = u;
        } else {
          // Build the best label from BP fields. Priority:
          //   1. firstName + lastName  (full name when both stored)
          //   2. displayName           (legacy single-string fallback)
          const bp = ppr.party;
          const hasFullName = !!(bp.firstName && bp.lastName);
          bimLeader = {
            id: -bp.id,
            firstName: hasFullName ? bp.firstName : (bp.firstName ?? bp.displayName),
            lastName: hasFullName ? bp.lastName : (bp.lastName ?? null),
            avatarUrl: null,
          };
        }
      }
    }

    const enriched = { ...project, bimLeader };
    return callerCanReadFinance(caller) ? enriched : omitBudget(enriched);
  }

  async update(id: number, dto: UpdateProjectDto, actorUserId?: number) {
    await this.findOne(id);
    const { memberIds, ...rest } = dto;

    // Capture which keys are actually being changed (any value supplied,
    // including null) so the activity-log description can name the fields
    // — gives the audit feed entries like "Updated 'Tower 1' — name, leader"
    // instead of a generic "updated project".
    const changedKeys = Object.keys(rest);

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

    if (changedKeys.length > 0) {
      await this.activityLog.logProjectUpdated({
        actorUserId,
        projectId: id,
        entityId: id,
        projectName: project.name,
        changedFields: changedKeys,
      });
    }

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

  /**
   * Mark a project as CLOSED. Distinct from soft-delete: closing means
   * "the work is done, freeze the data", whereas delete means "this
   * project was a mistake, hide it." Closed projects keep all their
   * data and remain queryable for audit / billing / cost reporting —
   * the project list just defaults to hiding them. Idempotent: re-closing
   * an already-closed project no-ops.
   */
  async close(id: number, actorUserId?: number) {
    const project = await this.prisma.project.findFirst({ where: { id } });
    if (!project) throw new NotFoundException('Project not found');
    if (project.closedAt) {
      return { message: 'Project already closed', closedAt: project.closedAt };
    }
    const closedAt = new Date();
    await this.prisma.project.update({ where: { id }, data: { closedAt } });
    await this.activityLog.write({
      actorUserId,
      projectId: id,
      category: 'project',
      action: 'close',
      entityType: 'project',
      entityId: id,
      entityName: project.name,
      description: `Closed project "${project.name}"`,
    });
    return { message: 'Project closed', closedAt };
  }

  /**
   * Re-open a previously-closed project (clears `closedAt`). Idempotent
   * the other way too: re-opening an active project is a no-op.
   */
  async reopen(id: number, actorUserId?: number) {
    const project = await this.prisma.project.findFirst({ where: { id } });
    if (!project) throw new NotFoundException('Project not found');
    if (!project.closedAt) {
      return { message: 'Project is already open' };
    }
    await this.prisma.project.update({ where: { id }, data: { closedAt: null } });
    await this.activityLog.write({
      actorUserId,
      projectId: id,
      category: 'project',
      action: 'reopen',
      entityType: 'project',
      entityId: id,
      entityName: project.name,
      description: `Re-opened project "${project.name}"`,
    });
    return { message: 'Project re-opened' };
  }

  async remove(id: number, actorUserId?: number) {
    const project = await this.prisma.project.findFirst({ where: { id } });
    if (!project) throw new NotFoundException('Project not found');

    // Log BEFORE the cascade so the entry survives the delete.
    await this.activityLog.logProjectDeleted({
      actorUserId,
      projectId: id,
      entityId: id,
      projectName: project.name,
    });

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
      await this.projectPartnerRoles.upsertProjectMemberRelationship({
        userId,
        projectId,
        roleInContext: role ?? null,
      });
    } catch (e) {
      Sentry.captureException(e);
      // swallow — see comment above
    }

    return member;
  }

  /**
   * Per-project activity feed — pulls ActivityLog rows where project_id
   * matches, newest first. The (project_id, created_at) composite index
   * keeps this O(log n) even at scale. Joined with `user` for actor
   * names so the UI doesn't need a second round-trip.
   *
   * BigInt id is serialized to string because JSON can't represent
   * 64-bit integers — bigint.toString() avoids a Number-precision loss
   * on the wire.
   */
  async getActivityLogs(
    projectId: number,
    opts: { perPage: number; page: number },
  ): Promise<{ data: any[]; meta: { total: number; page: number; perPage: number } }> {
    const take = opts.perPage;
    const skip = (opts.page - 1) * take;
    const [rows, total] = await Promise.all([
      this.prisma.activityLog.findMany({
        where: { projectId },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        },
      }),
      this.prisma.activityLog.count({ where: { projectId } }),
    ]);
    const data = rows.map((r) => ({
      ...r,
      id: r.id.toString(),
    }));
    return { data, meta: { total, page: opts.page, perPage: take } };
  }

  async getMembers(projectId: number) {
    // Filter out members whose user is deactivated. Project member rows
    // outlive their user's tenure (we keep the row so historical task
    // assignment chains stay intact), but they should not surface in
    // pickers / member lists once the employee is off the system.
    return this.prisma.projectMember.findMany({
      where: { projectId, user: { isActive: true } },
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

  /** Flat Excel export of every task on the project. No grouping, no
   *  client-side filters — one row per task, in a shape that's easy to
   *  slice in Excel/Sheets. Called by GET /projects/:id/tasks/export.
   *  (Tier B #5, 2026-06-30.) */
  async exportTasksExcel(projectId: number): Promise<{ buffer: Buffer; filename: string }> {
    await this.findOne(projectId);
    const [project, tasks] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, number: true },
      }),
      this.prisma.task.findMany({
        where: { projectId, deletedAt: null, isArchived: false },
        orderBy: [{ zoneId: 'asc' }, { id: 'asc' }],
        include: {
          zone: { select: { name: true, zoneType: true } },
          phase: { select: { name: true } },
          serviceType: { select: { name: true } },
          deliverableTemplate: { select: { name: true } },
          assignees: {
            where: { deletedAt: null },
            include: { user: { select: { firstName: true, lastName: true } } },
          },
        },
      }),
    ]);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Planwise';
    wb.created = new Date();
    const ws = wb.addWorksheet('Tasks');
    ws.columns = [
      { header: 'Code', key: 'code', width: 14 },
      { header: 'Task', key: 'name', width: 42 },
      // Personal flag — client feedback 2026-08-02: personal tasks
      // must be filterable in every report. Row-level Yes/No lets
      // users toggle personal work in Excel via AutoFilter without a
      // backend query param round-trip.
      { header: 'Personal?', key: 'isPersonal', width: 10 },
      { header: 'Zone', key: 'zone', width: 24 },
      { header: 'Deliverable', key: 'deliverable', width: 26 },
      { header: 'Service', key: 'service', width: 20 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Priority', key: 'priority', width: 12 },
      { header: 'Requires Review', key: 'requiresReview', width: 16 },
      { header: 'Est. Hours', key: 'budgetHours', width: 12 },
      { header: 'Logged (min)', key: 'loggedMinutes', width: 14 },
      { header: 'Amount (₪)', key: 'budgetAmount', width: 14 },
      { header: 'Start Date', key: 'startDate', width: 12 },
      { header: 'Due Date', key: 'endDate', width: 12 },
      { header: 'Completion %', key: 'completionPct', width: 14 },
      { header: 'Assignees', key: 'assignees', width: 40 },
      { header: 'Description', key: 'description', width: 48 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF1F5F9' },
    };

    const fmtDate = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : '');
    for (const t of tasks) {
      const names = (t.assignees ?? [])
        .map((a: any) => `${a.user?.firstName ?? ''} ${a.user?.lastName ?? ''}`.trim())
        .filter(Boolean)
        .join(', ');
      const deliverable = t.deliverableTemplate?.name || t.serviceType?.name || '';
      ws.addRow({
        code: t.code ?? '',
        name: t.name ?? '',
        isPersonal: t.isPersonal ? 'Yes' : 'No',
        zone: t.zone?.name ?? '',
        deliverable,
        service: t.phase?.name ?? '',
        status: t.status ?? '',
        priority: t.priority ?? '',
        requiresReview: t.requiresReview ? 'Yes' : 'No',
        budgetHours: Number(t.budgetHours ?? 0),
        loggedMinutes: 0, // fill from time-entry aggregation if we ever want the roll-up on export
        budgetAmount: Number(t.budgetAmount ?? 0),
        startDate: fmtDate(t.startDate),
        endDate: fmtDate(t.endDate),
        completionPct: t.completionPct ?? 0,
        assignees: names,
        description: (t.description ?? '').replace(/\r?\n/g, ' '),
      });
    }
    // Enable AutoFilter on the header row so users can toggle the
    // Personal? column without hunting for a menu.
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: ws.columns.length },
    };

    // Metadata sheet — makes the exported workbook self-describing.
    const meta = wb.addWorksheet('_meta');
    meta.addRow(['Project', project?.name ?? '']);
    meta.addRow(['Project #', project?.number ?? '']);
    meta.addRow(['Exported at', new Date().toISOString()]);
    meta.addRow(['Total tasks', tasks.length]);

    const arrayBuffer = await wb.xlsx.writeBuffer();

    // Filename derived from the project (client feedback 2026-08-03).
    // Strip filesystem-hostile characters and collapse whitespace so
    // both ASCII and Hebrew names round-trip cleanly. Falls back to
    // the numeric project id when the project has no name (unusual).
    const safeName = (project?.name ?? `project-${projectId}`)
      .replace(/[\/\\:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const numberSuffix = project?.number ? `-${project.number}` : '';
    const dateSuffix = new Date().toISOString().slice(0, 10);
    const filename = `${safeName}${numberSuffix} - tasks ${dateSuffix}.xlsx`;

    return { buffer: Buffer.from(arrayBuffer), filename };
  }

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

    // Customer Contacts — anyone with an active party↔party relationship
    // pointing at the customer org (any rel type, party A is a person).
    // Org-level association: contacts surface on every project of that
    // customer.
    // BM2 Phase 1 (2026-08-13): reads from `partner_relationships`
    // (BUT050 party↔party). The legacy `business_partner_relationships`
    // reader was retired with the table; edges of type `worker_of` +
    // `contact_of_customer` land here.
    let customerContacts: any[] = [];
    if (customerOrgId != null) {
      const rows = await this.prisma.partnerRelationship.findMany({
        where: {
          partyBId: customerOrgId,
          status: 'active',
          validFrom: { lte: now },
          validTo: { gt: now },
          partyA: { partnerType: 'person', deletedAt: null },
        },
        include: {
          type: true,
          partyA: {
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
      // Dedupe by party A — a person might have multiple rels to the
      // customer org (e.g. worker_of + contact_of_customer).
      const seen = new Set<number>();
      customerContacts = rows
        .filter((r) => {
          if (seen.has(r.partyA.id)) return false;
          seen.add(r.partyA.id);
          return true;
        })
        .map((r) => ({
          relationshipId: r.id,
          relationshipTypeCode: r.type.code,
          relationshipTypeName: r.type.name,
          businessPartnerId: r.partyA.id,
          userId: r.partyA.user?.id ?? null,
          displayName: r.partyA.displayName,
          firstName: r.partyA.firstName,
          lastName: r.partyA.lastName,
          email: r.partyA.email,
          phone: r.partyA.phone,
          position: r.partyA.user?.position ?? null,
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
        // BM2 Phase 2 — representation surfaces on the team endpoint so
        // the UI can render "Org X — contact: Person C" and
        // "Person C (on behalf of Org X)" without a follow-up fetch.
        contactParty: {
          select: { id: true, displayName: true, partnerType: true },
        },
        onBehalfOfParty: {
          select: { id: true, displayName: true, partnerType: true },
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
        contactParty: a.contactParty,
        onBehalfOfParty: a.onBehalfOfParty,
      })),
    };
  }

  /**
   * Unified candidate list for the task-tree / bulk assignee picker.
   *
   * Post-BP-refactor, project participation lives in three places:
   *   1. `ProjectMember` (legacy internal-team table — still authoritative
   *      for older projects that predate the refactor).
   *   2. `ProjectPartnerRole` with role.code = 'participant' — internal
   *      project team as party↔project rows (write-through of #1).
   *   3. `ProjectPartnerRole` with any other role (BIM Leader, Architect,
   *      coordinator, model manager, …) — the person may be internal
   *      (User row linked via BusinessPartner) or an external contact.
   *
   * The previous /planning-data endpoint fed the picker `pd.members`
   * sourced ONLY from #1, which post-refactor was often near-empty on
   * projects staffed via #3 → operators saw a single stray legacy
   * member (Daniel Malka on QA STG) and no real role-holders.
   *
   * This method walks all three, dedupes by BusinessPartner id (falling
   * back to userId), and returns one row per person with their role +
   * discipline resolved. `canAssign` reflects whether the person has a
   * User account — TaskAssignee.userId still writes to User.id, so an
   * external contact is surfaced but disabled at the picker level with
   * a reason. (Branch 2 · fix/assignee-source, PR-001/009.)
   */
  async getAssigneeCandidates(projectId: number): Promise<
    Array<{
      userId: number | null;
      partyId: number | null;
      firstName: string | null;
      lastName: string | null;
      displayName: string;
      email: string | null;
      avatarUrl: string | null;
      role: string | null;
      discipline: string | null;
      canAssign: boolean;
    }>
  > {
    // Bail early on a missing / soft-deleted project. Callers reach this
    // via the controller after assertProjectAccess, so a 404 here is the
    // "project no longer exists" case, not an authz miss.
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    const now = new Date();

    // [1] Legacy internal ProjectMember rows. Kept for pre-refactor
    // projects whose team never got a participant-role write-through.
    const legacyMembers = await this.prisma.projectMember.findMany({
      where: { projectId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            avatarUrl: true,
            position: true,
            department: true,
            businessPartnerId: true,
          },
        },
      },
    });

    // [2 + 3] Every active ProjectPartnerRole on the project. Excluding
    // 'customer' since the customer is the org buying the project, not
    // someone task-assignable. Including 'participant' — those persons
    // ARE the internal team surfaced by the Team tab and are the right
    // set for task assignment.
    const roleAssignments = await this.prisma.projectPartnerRole.findMany({
      where: {
        projectId,
        status: 'active',
        validFrom: { lte: now },
        validTo: { gt: now },
        role: { code: { not: 'customer' } },
      },
      include: {
        role: { select: { id: true, code: true, name: true } },
        party: {
          select: {
            id: true,
            partnerType: true,
            displayName: true,
            firstName: true,
            lastName: true,
            email: true,
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                avatarUrl: true,
                position: true,
                department: true,
              },
            },
          },
        },
        // When the role's party is an organization, contactParty is the
        // person representing that org on the project. That person is
        // the assignable individual (an org can't hold a task itself),
        // so we surface the contact — not the org — in the picker.
        contactParty: {
          select: {
            id: true,
            partnerType: true,
            displayName: true,
            firstName: true,
            lastName: true,
            email: true,
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                avatarUrl: true,
                position: true,
                department: true,
              },
            },
          },
        },
      },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });

    // Dedupe by BP id where present, else by userId. When the same
    // person shows up under multiple roles (e.g. also holds "BIM
    // Leader") we join the role names with " / " and prefer the most
    // specific titleInProject we've seen. Internal members from [1]
    // are folded into the same row if their BP/userId matches a
    // participant/role entry so no one appears twice.
    type Candidate = {
      userId: number | null;
      partyId: number | null;
      firstName: string | null;
      lastName: string | null;
      displayName: string;
      email: string | null;
      avatarUrl: string | null;
      roles: string[];
      titles: string[];
      position: string | null;
      department: string | null;
    };
    const byKey = new Map<string, Candidate>();
    const keyFor = (partyId: number | null, userId: number | null) =>
      partyId != null ? `p:${partyId}` : userId != null ? `u:${userId}` : null;

    const upsert = (
      seed: Omit<Candidate, 'roles' | 'titles'> & { role?: string | null; title?: string | null },
    ) => {
      const key = keyFor(seed.partyId, seed.userId);
      if (!key) return;
      const existing = byKey.get(key);
      if (existing) {
        // Prefer the entry with a resolved userId (assignable) — the row
        // that carries the real User wins even if the first sighting
        // was via a role assignment with no user linkage.
        if (existing.userId == null && seed.userId != null) {
          existing.userId = seed.userId;
          existing.firstName = seed.firstName ?? existing.firstName;
          existing.lastName = seed.lastName ?? existing.lastName;
          existing.email = seed.email ?? existing.email;
          existing.avatarUrl = seed.avatarUrl ?? existing.avatarUrl;
          existing.position = seed.position ?? existing.position;
          existing.department = seed.department ?? existing.department;
        }
        if (seed.role && !existing.roles.includes(seed.role)) existing.roles.push(seed.role);
        if (seed.title && !existing.titles.includes(seed.title)) existing.titles.push(seed.title);
      } else {
        byKey.set(key, {
          userId: seed.userId,
          partyId: seed.partyId,
          firstName: seed.firstName,
          lastName: seed.lastName,
          displayName: seed.displayName,
          email: seed.email,
          avatarUrl: seed.avatarUrl,
          position: seed.position,
          department: seed.department,
          roles: seed.role ? [seed.role] : [],
          titles: seed.title ? [seed.title] : [],
        });
      }
    };

    // Fold in legacy internal members first — their role label defaults
    // to "Team Member" so they surface with SOME context even when the
    // person doesn't hold a formal ProjectPartnerRole entry yet.
    for (const m of legacyMembers) {
      if (!m.user) continue;
      const fullName = `${m.user.firstName ?? ''} ${m.user.lastName ?? ''}`.trim() || m.user.email || `User #${m.user.id}`;
      upsert({
        userId: m.user.id,
        partyId: m.user.businessPartnerId ?? null,
        firstName: m.user.firstName ?? null,
        lastName: m.user.lastName ?? null,
        displayName: fullName,
        email: m.user.email ?? null,
        avatarUrl: m.user.avatarUrl ?? null,
        position: m.user.position ?? null,
        department: m.user.department ?? null,
        role: m.role ?? 'Team Member',
        title: null,
      });
    }

    // Now the role assignments — for each one, pick the person we want
    // in the picker: org rows contribute their contactParty; person rows
    // contribute the party itself. Skip rows that produce neither.
    for (const a of roleAssignments) {
      const partyIsPerson = a.party.partnerType === 'person';
      const candidate = partyIsPerson ? a.party : a.contactParty;
      if (!candidate) continue; // org role with no contact person → nothing to assign
      const user = candidate.user;
      const fullName = `${candidate.firstName ?? ''} ${candidate.lastName ?? ''}`.trim()
        || candidate.displayName
        || candidate.email
        || `Partner #${candidate.id}`;
      upsert({
        userId: user?.id ?? null,
        partyId: candidate.id,
        firstName: candidate.firstName ?? user?.firstName ?? null,
        lastName: candidate.lastName ?? user?.lastName ?? null,
        displayName: fullName,
        email: candidate.email ?? user?.email ?? null,
        avatarUrl: user?.avatarUrl ?? null,
        position: user?.position ?? null,
        department: user?.department ?? null,
        role: a.role.name,
        title: a.titleInProject,
      });
    }

    // Stable sort — assignable rows first (so the common case is at the
    // top of the picker), then alphabetically by display name so the
    // list reads naturally.
    const rows = Array.from(byKey.values())
      .map((c) => ({
        userId: c.userId,
        partyId: c.partyId,
        firstName: c.firstName,
        lastName: c.lastName,
        displayName: c.displayName,
        email: c.email,
        avatarUrl: c.avatarUrl,
        role: c.roles.length > 0 ? c.roles.join(' / ') : null,
        discipline: c.titles.length > 0
          ? c.titles.join(' / ')
          : (c.position ?? c.department ?? null),
        canAssign: c.userId != null,
      }))
      .sort((a, b) => {
        if (a.canAssign !== b.canAssign) return a.canAssign ? -1 : 1;
        return a.displayName.localeCompare(b.displayName);
      });

    return rows;
  }

  async removeMember(projectId: number, userId: number) {
    await this.prisma.projectMember.delete({
      where: { projectId_userId: { projectId, userId } },
    });
    try {
      await this.projectPartnerRoles.removeProjectMemberRelationship({ userId, projectId });
    } catch (e) {
      Sentry.captureException(e);
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
