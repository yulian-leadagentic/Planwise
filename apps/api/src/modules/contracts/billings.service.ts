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

  async findAll(query: any) {
    const where: any = {};
    if (query.contractId) where.contractId = Number(query.contractId);
    if (query.status) where.status = query.status;

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
