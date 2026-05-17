import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../../prisma/prisma.service';
import { NumberRangesService } from '../number-ranges/number-ranges.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private numberRanges: NumberRangesService,
  ) {}

  /**
   * M1.1 — Allocate or validate a User business code (employee number).
   * Looks up the EMPLOYEE entity kind, finds its assigned NumberRange,
   * and either:
   *   auto     → allocates the next code atomically.
   *   manual   → uses the user-supplied code (uniqueness only).
   *   external → uses the user-supplied code with optional regex check.
   * If EMPLOYEE isn't bound to a range, returns null and the User row
   * is created without a code (admins can backfill later).
   */
  private async resolveUserCode(suppliedCode: string | undefined): Promise<string | null> {
    const kind = await this.prisma.entityKind.findUnique({
      where: { code: 'EMPLOYEE' },
      include: { numberRange: true },
    });
    const range = kind?.numberRange;
    if (!range || !range.isActive) {
      // No assignment yet — let the caller proceed without a code. Admin
      // can backfill via Object Numbering then edit the user.
      return suppliedCode?.trim() || null;
    }
    if (range.mode === 'auto') {
      if (suppliedCode?.trim()) {
        throw new BadRequestException(
          `Range "${range.code}" is auto — the system allocates the code. Don't supply one.`,
        );
      }
      return this.numberRanges.next(range.code);
    }
    if (!suppliedCode?.trim()) {
      throw new BadRequestException(
        `Range "${range.code}" is ${range.mode} — please supply a code for the new user.`,
      );
    }
    await this.numberRanges.validateManual(range.code, suppliedCode.trim());
    return suppliedCode.trim();
  }

  async create(dto: CreateUserDto) {
    const existing = await this.prisma.user.findFirst({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email already exists');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);

    // Pull out fields that don't belong on User itself (or we want to handle
    // separately) so the rest can be spread into the User.create.
    const { employerOrgId, businessPartnerId: explicitBpId, ...userData } = dto;

    // 1) Pick the BusinessPartner this login will reference. Three paths:
    //    a. Caller picked an explicit BP → use it (must be partner_type=person
    //       and not soft-deleted, and not already linked to another User).
    //    b. A BP with the same email already exists → link to it.
    //    c. Otherwise, create a fresh BP from the user's name/email/phone.
    let businessPartnerId: number;
    if (explicitBpId) {
      const explicit = await this.prisma.businessPartner.findFirst({
        where: { id: explicitBpId, deletedAt: null },
        include: { user: { select: { id: true } } },
      });
      if (!explicit) {
        throw new NotFoundException(`Business partner ${explicitBpId} not found`);
      }
      if (explicit.partnerType !== 'person') {
        throw new ConflictException('Only person partners can be linked to a login user');
      }
      if (explicit.user) {
        throw new ConflictException(
          `Business partner ${explicitBpId} is already linked to user ${explicit.user.id}`,
        );
      }
      businessPartnerId = explicit.id;
    } else {
      const existingBp = await this.prisma.businessPartner.findFirst({
        where: { email: dto.email, deletedAt: null },
      });
      if (existingBp) {
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

    // M1.1 — Resolve the business code (employee number) from the
    // EMPLOYEE entity kind's number range. Strip from userData so it
    // doesn't double-pass into Prisma below.
    const { code: codeFromDto, ...restUserData } = userData;
    const code = await this.resolveUserCode(codeFromDto);

    // 4) Create the User row, linking to the BP.
    const user = await this.prisma.user.create({
      data: {
        ...restUserData,
        code,
        password: hashedPassword,
        businessPartnerId,
        employmentDate: dto.employmentDate ? new Date(dto.employmentDate) : undefined,
        employmentEndDate: dto.employmentEndDate ? new Date(dto.employmentEndDate) : undefined,
      },
      select: {
        id: true,
        code: true,
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
          code: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          avatarUrl: true,
          userType: true,
          position: true,
          department: true,
          companyName: true,
          // M4a.4 — employment fields surfaced on the Employees list/edit.
          dailyStandardHours: true,
          employmentDate: true,
          employmentEndDate: true,
          seniorityLevelId: true,
          seniorityLevel: { select: { id: true, code: true, name: true, defaultHourlyCost: true, currency: true } },
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
        code: true,
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
        // M4a.4 — employment fields needed by the Employees edit modal.
        dailyStandardHours: true,
        employmentDate: true,
        employmentEndDate: true,
        roleId: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        businessPartnerId: true,
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
        code: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatarUrl: true,
        userType: true,
        position: true,
        department: true,
        companyName: true,
        dailyStandardHours: true,
        employmentDate: true,
        employmentEndDate: true,
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
