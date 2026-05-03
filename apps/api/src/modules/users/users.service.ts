import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateUserDto) {
    const existing = await this.prisma.user.findFirst({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email already exists');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);

    // Pull out fields that don't belong on User itself (or we want to handle
    // separately) so the rest can be spread into the User.create.
    const { employerOrgId, ...userData } = dto;

    // 1) Create or link a BusinessPartner record. Every login user is also a BP.
    const existingBp = await this.prisma.businessPartner.findFirst({
      where: { email: dto.email, deletedAt: null },
    });

    let businessPartnerId: number;
    if (existingBp) {
      // BP already exists with this email — link to it.
      businessPartnerId = existingBp.id;
    } else {
      const bp = await this.prisma.businessPartner.create({
        data: {
          partnerType: 'person',
          displayName: `${dto.firstName} ${dto.lastName}`.trim() || dto.email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          phone: dto.phone ?? null,
          source: 'manual',
        },
      });
      businessPartnerId = bp.id;
    }

    // 2) Add the 'employee' role on the BP if user is an employee or both.
    if (dto.userType === 'employee' || dto.userType === 'both') {
      const employeeRole = await this.prisma.partnerRoleType.findUnique({
        where: { code: 'employee' },
      });
      if (employeeRole) {
        await this.prisma.businessPartnerRole.upsert({
          where: { businessPartnerId_roleTypeId: { businessPartnerId, roleTypeId: employeeRole.id } },
          create: { businessPartnerId, roleTypeId: employeeRole.id, isPrimary: true },
          update: {},
        });
      }
    }

    // 3) Wire the employee_of relationship to the chosen organization.
    if (employerOrgId) {
      const employerOrg = await this.prisma.businessPartner.findFirst({
        where: { id: employerOrgId, partnerType: 'organization', deletedAt: null },
      });
      const employeeOfType = await this.prisma.partnerRelationshipType.findUnique({
        where: { code: 'employee_of' },
      });
      if (employerOrg && employeeOfType) {
        await this.prisma.businessPartnerRelationship.upsert({
          where: {
            sourcePartnerId_targetType_targetId_relationshipTypeId: {
              sourcePartnerId: businessPartnerId,
              targetType: 'organization',
              targetId: employerOrg.id,
              relationshipTypeId: employeeOfType.id,
            },
          },
          create: {
            sourcePartnerId: businessPartnerId,
            targetType: 'organization',
            targetId: employerOrg.id,
            relationshipTypeId: employeeOfType.id,
            isPrimary: true,
          },
          update: { status: 'active' },
        });
      }
    }

    // 4) Create the User row, linking to the BP.
    const user = await this.prisma.user.create({
      data: {
        ...userData,
        password: hashedPassword,
        businessPartnerId,
        employmentDate: dto.employmentDate ? new Date(dto.employmentDate) : undefined,
        employmentEndDate: dto.employmentEndDate ? new Date(dto.employmentEndDate) : undefined,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        userType: true,
        position: true,
        department: true,
        companyName: true,
        roleId: true,
        isActive: true,
        createdAt: true,
        businessPartnerId: true,
        role: true,
      },
    });

    return user;
  }

  async findAll(query: QueryUsersDto) {
    const where: Prisma.UserWhereInput = {};

    if (query.userType) where.userType = query.userType;
    if (query.roleId) where.roleId = query.roleId;
    if (query.isActive !== undefined) where.isActive = query.isActive;

    if (query.search) {
      where.OR = [
        { firstName: { contains: query.search } },
        { lastName: { contains: query.search } },
        { email: { contains: query.search } },
        { companyName: { contains: query.search } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: query.skip,
        take: query.take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          avatarUrl: true,
          userType: true,
          position: true,
          department: true,
          companyName: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
          roleId: true,
          role: { select: { id: true, name: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    // Flatten role so the response matches the shared UserListItem shape
    const flat = data.map((u: any) => ({
      ...u,
      roleName: u.role?.name ?? null,
    }));

    return {
      data: flat,
      meta: {
        total,
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
        totalPages: Math.ceil(total / (query.perPage ?? 20)),
      },
    };
  }

  async findOne(id: number) {
    const user = await this.prisma.user.findFirst({
      where: { id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatarUrl: true,
        userType: true,
        position: true,
        department: true,
        companyName: true,
        taxId: true,
        address: true,
        website: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        role: {
          include: {
            roleModules: { include: { module: true } },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async findByEmail(email: string) {
    return this.prisma.user.findFirst({
      where: { email },
      include: {
        role: {
          include: {
            roleModules: { include: { module: true } },
          },
        },
      },
    });
  }

  async update(id: number, dto: UpdateUserDto) {
    await this.findOne(id);

    const data: any = { ...dto };

    if (dto.password) {
      data.password = await bcrypt.hash(dto.password, 12);
    }

    return this.prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatarUrl: true,
        userType: true,
        position: true,
        department: true,
        companyName: true,
        isActive: true,
        role: { select: { id: true, name: true } },
      },
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.user.delete({ where: { id } });
    return { message: 'User deleted' };
  }
}
