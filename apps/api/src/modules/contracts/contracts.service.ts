import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateContractDto } from './dto/create-contract.dto';
import { CreateExpenseDto } from './dto/create-expense.dto';

@Injectable()
export class ContractsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: number, dto: CreateContractDto) {
    return this.prisma.contract.create({
      data: {
        name: dto.name,
        projectId: dto.projectId,
        partnerId: dto.partnerId,
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
      },
    });
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

  async update(id: number, dto: Partial<CreateContractDto>) {
    await this.findOne(id);

    return this.prisma.contract.update({
      where: { id },
      data: {
        ...dto,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
      },
      include: {
        project: { select: { id: true, name: true } },
        partner: { select: { id: true, firstName: true, lastName: true, companyName: true } },
      },
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.contract.delete({ where: { id } });
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
  async createContact(data: any) {
    return this.prisma.contact.create({
      data: {
        partnerId: data.partnerId,
        name: data.name,
        email: data.email,
        phone: data.phone,
        role: data.role,
      },
    });
  }

  async getContacts(partnerId: number) {
    return this.prisma.contact.findMany({
      where: { partnerId },
      orderBy: { name: 'asc' },
    });
  }

  async removeContact(id: number) {
    await this.prisma.contact.delete({ where: { id } });
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
