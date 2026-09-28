import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { CreateContractDto } from './dto/create-contract.dto';
import { CreateExpenseDto } from './dto/create-expense.dto';
import * as Sentry from '@sentry/node';

@Injectable()
export class ContractsService {
  constructor(
    private prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
  ) {}

  /**
   * Phase 4 · Stage 3 (2026-09-28) — Resolve the `partyId` +
   * `partnerId` pair from a caller-supplied combination. Rules:
   *   • Neither given → 400.
   *   • `partyId` given → look up the BP; if it has a linked User,
   *     use that as the legacy `partnerId`. If not (e.g. an org with
   *     no login user), the legacy column can't be populated, so we
   *     reject until the follow-up migration drops that NOT NULL.
   *   • `partnerId` given (legacy only) → look up the user; if they
   *     have a linked BP, populate `partyId` from that. Otherwise
   *     `partyId` stays null (a legacy-only write).
   * Returns both resolved values.
   */
  private async resolvePartyAndLegacyPartner(input: {
    partyId?: number | null;
    partnerId?: number | null;
  }): Promise<{ partyId: number | null; partnerId: number }> {
    if (input.partyId) {
      const party = await this.prisma.businessPartner.findFirst({
        where: { id: input.partyId, deletedAt: null },
        include: { user: { select: { id: true } } },
      });
      if (!party) {
        throw new NotFoundException(`Business partner ${input.partyId} not found`);
      }
      // Prefer an explicit `partnerId` if the caller sent one AND it
      // matches the BP's linked User (defensive against inconsistent
      // dual submits).
      const legacyId = input.partnerId ?? party.user?.id ?? null;
      if (legacyId == null) {
        // Contracts.partnerId is still NOT NULL on the DB column
        // until the follow-up migration retires it. Until then, a
        // party-with-no-User can't be persisted through this write
        // path — the caller must create the User first, or the
        // follow-up column drop must land.
        throw new BadRequestException(
          `Business partner ${input.partyId} has no linked User account. ` +
          `Attach a login user to the partner, or wait for the follow-up ` +
          `migration that retires contracts.partner_id.`,
        );
      }
      return { partyId: party.id, partnerId: legacyId };
    }
    if (input.partnerId) {
      const user = await this.prisma.user.findFirst({
        where: { id: input.partnerId },
        select: { id: true, businessPartnerId: true },
      });
      if (!user) throw new NotFoundException(`User ${input.partnerId} not found`);
      return { partyId: user.businessPartnerId ?? null, partnerId: user.id };
    }
    throw new BadRequestException(
      'Contract requires either `partyId` (BusinessPartner) or `partnerId` (User).',
    );
  }

  async create(userId: number, dto: CreateContractDto) {
    // Phase 4 · Stage 3 (2026-09-28) — accept either `partyId` (new,
    // BusinessPartner FK — preferred) or `partnerId` (legacy, User
    // FK). If only `partyId` is given, look up a linked User to
    // populate the legacy `partnerId` (still NOT NULL on the column
    // until the follow-up drops it). If neither is given, 400.
    const { partyId, partnerId: legacyPartnerId } = await this.resolvePartyAndLegacyPartner({
      partyId: dto.partyId,
      partnerId: dto.partnerId,
    });

    const contract = await this.prisma.contract.create({
      data: {
        name: dto.name,
        projectId: dto.projectId,
        partnerId: legacyPartnerId,
        partyId: partyId ?? undefined,
        status: dto.status,
        totalAmount: dto.totalAmount,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        notes: dto.notes,
        createdBy: userId,
      },
      include: {
        project: { select: { id: true, name: true } },
        partner: { select: { id: true, firstName: true, lastName: true, companyName: true } },
        party: { select: { id: true, partnerType: true, displayName: true, companyName: true, email: true } },
      },
    });

    // Audit trail — contract create is a high-value event; project-scoped
    // so the per-project Activity tab picks it up via the (project_id,
    // created_at) composite index. Wrapped defensively — logging must
    // never break the underlying write (the service already swallows on
    // fail internally; this is belt-and-suspenders).
    try {
      await this.activityLog.write({
        category: 'contract',
        action: 'contract.created',
        actorUserId: userId,
        projectId: contract.projectId ?? null,
        entityType: 'contract',
        entityId: contract.id,
        entityName: contract.name,
        description: `Created contract "${contract.name}"`,
      });
    } catch (e) { Sentry.captureException(e); /* swallow — audit failure never fails the write */ }

    return contract;
  }

  async findAll(query: any) {
    const page = Number(query.page) || 1;
    const perPage = Number(query.perPage) || 20;
    const skip = (page - 1) * perPage;

    const where: Prisma.ContractWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.projectId) where.projectId = Number(query.projectId);
    if (query.partnerId) where.partnerId = Number(query.partnerId);

    const [data, total] = await Promise.all([
      this.prisma.contract.findMany({
        where,
        skip,
        take: perPage,
        orderBy: { createdAt: 'desc' },
        include: {
          project: { select: { id: true, name: true } },
          partner: { select: { id: true, firstName: true, lastName: true, companyName: true } },
          // Phase 4 · Stage 3 (2026-09-28) — additive: expose the BP
          // party relation so readers can prefer `party.displayName`
          // over the legacy User-based `partner` name. Null when the
          // row predates the Stage 3 migration and its User has no
          // linked BP.
          party: { select: { id: true, partnerType: true, displayName: true, companyName: true, email: true } },
          _count: { select: { items: true, billings: true } },
        },
      }),
      this.prisma.contract.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, perPage, totalPages: Math.ceil(total / perPage) },
    };
  }

  async findOne(id: number) {
    const contract = await this.prisma.contract.findFirst({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
        partner: { select: { id: true, firstName: true, lastName: true, companyName: true, email: true } },
        // Phase 4 · Stage 3 (2026-09-28) — additive: BP party relation.
        party: { select: { id: true, partnerType: true, displayName: true, companyName: true, email: true } },
        creator: { select: { id: true, firstName: true, lastName: true } },
        items: {
          include: {
            label: { select: { id: true, name: true, path: true } },
            milestone: { select: { id: true, name: true } },
          },
          orderBy: { sortOrder: 'asc' },
        },
        billings: { orderBy: { billingDate: 'desc' } },
      },
    });

    if (!contract) {
      throw new NotFoundException('Contract not found');
    }

    return contract;
  }

  async update(id: number, dto: Partial<CreateContractDto>, userId?: number) {
    const existing = await this.findOne(id);

    const updated = await this.prisma.contract.update({
      where: { id },
      data: {
        ...dto,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
      },
      include: {
        project: { select: { id: true, name: true } },
        partner: { select: { id: true, firstName: true, lastName: true, companyName: true } },
        // Phase 4 · Stage 3 (2026-09-28) — additive: BP party relation.
        party: { select: { id: true, partnerType: true, displayName: true, companyName: true, email: true } },
      },
    });

    try {
      const changedFields = Object.keys(dto).filter((k) => k in dto);
      await this.activityLog.write({
        category: 'contract',
        action: 'contract.updated',
        actorUserId: userId ?? null,
        projectId: updated.projectId ?? existing.projectId ?? null,
        entityType: 'contract',
        entityId: updated.id,
        entityName: updated.name,
        description: `Updated contract "${updated.name}"` +
          (changedFields.length ? ` — ${changedFields.join(', ')}` : ''),
      });
    } catch (e) { Sentry.captureException(e); /* swallow */ }

    return updated;
  }

  async remove(id: number, userId?: number) {
    const existing = await this.findOne(id);
    await this.prisma.contract.delete({ where: { id } });

    try {
      await this.activityLog.write({
        category: 'contract',
        action: 'contract.deleted',
        actorUserId: userId ?? null,
        projectId: existing.projectId ?? null,
        entityType: 'contract',
        entityId: id,
        entityName: existing.name,
        description: `Deleted contract "${existing.name}"`,
        severity: 'warn',
      });
    } catch (e) { Sentry.captureException(e); /* swallow */ }

    return { message: 'Contract deleted' };
  }

  // Contract Items
  async addItem(contractId: number, data: any) {
    return this.prisma.contractItem.create({
      data: {
        contractId,
        labelId: data.labelId,
        milestoneId: data.milestoneId,
        description: data.description,
        quantity: data.quantity ?? 1,
        unitPrice: data.unitPrice,
        total: data.total ?? data.quantity * data.unitPrice,
        sortOrder: data.sortOrder ?? 0,
      },
      include: {
        label: { select: { id: true, name: true } },
        milestone: { select: { id: true, name: true } },
      },
    });
  }

  async updateItem(itemId: number, data: any) {
    return this.prisma.contractItem.update({
      where: { id: itemId },
      data: {
        description: data.description,
        quantity: data.quantity,
        unitPrice: data.unitPrice,
        total: data.total,
        sortOrder: data.sortOrder,
        labelId: data.labelId,
        milestoneId: data.milestoneId,
      },
    });
  }

  async removeItem(itemId: number) {
    await this.prisma.contractItem.delete({ where: { id: itemId } });
    return { message: 'Contract item deleted' };
  }

  // Milestones
  async createMilestone(userId: number, data: any) {
    return this.prisma.labelMilestone.create({
      data: {
        labelId: data.labelId,
        partnerId: data.partnerId,
        name: data.name,
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
        amount: data.amount,
        notes: data.notes,
        createdBy: userId,
      },
    });
  }

  async updateMilestone(id: number, data: any) {
    return this.prisma.labelMilestone.update({
      where: { id },
      data: {
        name: data.name,
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
        amount: data.amount,
        isCompleted: data.isCompleted,
        completedAt: data.isCompleted ? new Date() : null,
        notes: data.notes,
      },
    });
  }

  async removeMilestone(id: number) {
    await this.prisma.labelMilestone.delete({ where: { id } });
    return { message: 'Milestone deleted' };
  }

  // Contacts
  //
  // BM2 Phase 5 (2026-08-13): repointed off the legacy `Contact` → User
  // model onto `BusinessPartner(person)`. There is now exactly one
  // "contact" concept — a person BP. The endpoint shape is unchanged
  // so nothing in the UI breaks; `partnerId` on the request/query is
  // interpreted as the OWNING organization's BusinessPartner.id, and
  // the created contact is a person BP linked to it via a `worker_of`
  // party↔party edge (BUT050). `getContacts` reads those edges back.
  //
  // Legacy semantic notes:
  //   - Old `Contact.partnerId` referenced `users.id` (the user acting
  //     as the "partner" on the contract). Post-Phase-1 party↔party
  //     lives in `partner_relationships`, so a contact of an org is
  //     any person BP with an active `worker_of` edge to that org.
  //   - `createContact({ partnerId, name, email, phone, role })` now
  //     expects `partnerId` = the organization BP's id.
  async createContact(data: {
    partnerId: number;      // organization BP.id
    name: string;
    email?: string | null;
    phone?: string | null;
    role?: string | null;   // becomes titleAtB on the worker_of edge
  }) {
    const org = await this.prisma.businessPartner.findFirst({
      where: { id: data.partnerId, partnerType: 'organization', deletedAt: null },
    });
    if (!org) {
      throw new NotFoundException(`Organization business partner ${data.partnerId} not found`);
    }
    const workerOf = await this.prisma.partnerRelationshipType.findUnique({
      where: { code: 'worker_of' },
    });
    if (!workerOf) {
      throw new NotFoundException('worker_of PartnerRelationshipType is missing — schema seed broken');
    }
    // Split the name into first / last so the person BP has structured
    // fields the rest of the app can rely on.
    const trimmed = (data.name ?? '').trim();
    const parts = trimmed.split(/\s+/);
    const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : trimmed;
    const lastName = parts.length > 1 ? parts[parts.length - 1] : null;

    const person = await this.prisma.businessPartner.create({
      data: {
        partnerType: 'person',
        displayName: trimmed || '(unnamed)',
        firstName: firstName || null,
        lastName,
        email: data.email ?? null,
        phone: data.phone ?? null,
        source: 'manual',
      },
    });
    // Link them via worker_of. `titleAtB` carries the free-text role.
    await this.prisma.partnerRelationship.create({
      data: {
        partyAId: person.id,
        partyBId: org.id,
        typeId: workerOf.id,
        titleAtB: data.role ?? null,
      },
    });
    return person;
  }

  async getContacts(partnerId: number) {
    // Return person BPs linked to this organization via active worker_of.
    const now = new Date();
    const rows = await this.prisma.partnerRelationship.findMany({
      where: {
        partyBId: partnerId,
        type: { code: 'worker_of' },
        validFrom: { lte: now },
        validTo: { gt: now },
        partyA: { partnerType: 'person', deletedAt: null },
      },
      include: {
        partyA: {
          select: { id: true, displayName: true, firstName: true, lastName: true, email: true, phone: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.partyA.id,
      partnerId,
      name: r.partyA.displayName,
      email: r.partyA.email,
      phone: r.partyA.phone,
      role: r.titleAtB,
    }));
  }

  async removeContact(id: number) {
    // `id` is now a BusinessPartner.id (person). Soft-delete the person
    // rather than the edge — matches the pre-Phase-5 semantic ("delete
    // the contact") more closely, since the frontend passes the person id.
    // The @relation onDelete:Cascade on partner_relationships cleans the
    // party↔party edges automatically.
    const bp = await this.prisma.businessPartner.findFirst({
      where: { id, partnerType: 'person', deletedAt: null },
    });
    if (!bp) throw new NotFoundException(`Contact ${id} not found`);
    await this.prisma.businessPartner.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { message: 'Contact deleted' };
  }

  // Expenses
  async createExpense(userId: number, dto: CreateExpenseDto) {
    return this.prisma.expense.create({
      data: {
        projectId: dto.projectId,
        expenseType: dto.expenseType,
        amount: dto.amount,
        date: new Date(dto.date),
        description: dto.description,
        receiptUrl: dto.receiptUrl,
        createdBy: userId,
      },
    });
  }

  async getExpenses(projectId: number) {
    return this.prisma.expense.findMany({
      where: { projectId },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { date: 'desc' },
    });
  }

  // Terms
  async createTerm(data: any) {
    return this.prisma.term.create({
      data: {
        userId: data.userId,
        title: data.title,
        monthlySalary: data.monthlySalary,
        hourlyRate: data.hourlyRate,
        startDate: new Date(data.startDate),
        endDate: data.endDate ? new Date(data.endDate) : null,
      },
    });
  }

  async getTerms(userId: number) {
    return this.prisma.term.findMany({
      where: { userId },
      orderBy: { startDate: 'desc' },
    });
  }
}
