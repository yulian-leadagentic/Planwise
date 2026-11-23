import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateBillingDto } from './dto/create-billing.dto';

@Injectable()
export class BillingsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: number, dto: CreateBillingDto) {
    return this.prisma.billing.create({
      data: {
        contractId: dto.contractId,
        type: dto.type,
        amount: dto.amount,
        billingDate: new Date(dto.billingDate),
        description: dto.description,
        status: dto.status ?? 'draft',
        createdBy: userId,
      },
      include: {
        contract: { select: { id: true, name: true } },
      },
    });
  }

  /** Project of a contract (null = no project). 404 if missing. */
  async getContractProjectId(contractId: number): Promise<number | null> {
    const c = await this.prisma.contract.findFirst({ where: { id: contractId }, select: { projectId: true } });
    if (!c) throw new NotFoundException('Contract not found');
    return c.projectId ?? null;
  }

  /** Project of a billing, through its contract. 404 if missing. */
  async getBillingProjectId(id: number): Promise<number | null> {
    const b = await this.prisma.billing.findUnique({
      where: { id },
      select: { contract: { select: { projectId: true } } },
    });
    if (!b) throw new NotFoundException('Billing not found');
    return b.contract?.projectId ?? null;
  }

  /**
   * `projectIds` (round 4): null = every billing; an array limits the
   * list to contracts of those projects.
   */
  async findAll(query: any, projectIds: number[] | null = null) {
    const where: any = {};
    if (query.contractId) where.contractId = Number(query.contractId);
    if (query.status) where.status = query.status;
    if (projectIds) where.contract = { projectId: { in: projectIds } };

    return this.prisma.billing.findMany({
      where,
      include: {
        contract: { select: { id: true, name: true } },
        creator: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { billingDate: 'desc' },
    });
  }

  async findOne(id: number) {
    const billing = await this.prisma.billing.findUnique({
      where: { id },
      include: {
        contract: {
          include: {
            partner: { select: { id: true, firstName: true, lastName: true, companyName: true } },
            // Phase 4 · Stage 3 (2026-09-28) — additive: BP party.
            party: { select: { id: true, partnerType: true, displayName: true, companyName: true, email: true } },
            project: { select: { id: true, name: true } },
          },
        },
        creator: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    if (!billing) {
      throw new NotFoundException('Billing not found');
    }

    return billing;
  }

  async update(id: number, data: any) {
    await this.findOne(id);

    return this.prisma.billing.update({
      where: { id },
      data: {
        status: data.status,
        description: data.description,
        amount: data.amount,
        pdfUrl: data.pdfUrl,
      },
    });
  }
}
