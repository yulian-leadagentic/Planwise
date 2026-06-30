import { Injectable, NotFoundException, ConflictException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../../prisma/prisma.service';
import { NumberRangesService } from '../number-ranges/number-ranges.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';

@Injectable()
export class UsersService implements OnModuleInit {
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
            // Mirror Hebrew names onto the linked BP so the bilingual
            // search hits work from either entry point (People page or
            // Contacts page). T3.3, 2026-06-28.
            firstNameHe: dto.firstNameHe ?? null,
            lastNameHe: dto.lastNameHe ?? null,
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

    // 5) Mirror Job Title onto the BP's professions list — see syncPositionToProfession().
    // Same skip-on-error policy as update(): the user create already
    // committed; a failed mirror just delays role-picker visibility.
    if (dto.position) {
      try { await this.syncPositionToProfession(user.id, dto.position); }
      catch { /* swallow */ }
    }

    return user;
  }

  async findAll(query: QueryUsersDto) {
    const where: Prisma.UserWhereInput = {};

    if (query.userType) where.userType = query.userType;
    if (query.roleId) where.roleId = query.roleId;

    // Default to ACTIVE-ONLY when isActive is not specified. This is the
    // safe default for every picker in the app (assignees, timesheet user
    // select, project member dropdowns, mention search, etc.) — inactive
    // staff should never appear in selection UI. To see inactive users
    // pass ?isActive=false; to see BOTH pass ?isActive=all (only the
    // admin People page does this, behind an explicit status filter).
    if (query.isActive === undefined) {
      where.isActive = true;
    } else if (typeof query.isActive === 'boolean') {
      where.isActive = query.isActive;
    }
    // (isActive === 'all' falls through — no filter applied)

    if (query.search) {
      // Bilingual search — matches the typed string against EITHER the
      // English first/last name or the Hebrew rendition (T3.3,
      // 2026-06-28). One typed query, two languages tried; admins find
      // "Yossi" by typing "yossi" or "יוסי".
      where.OR = [
        { firstName: { contains: query.search } },
        { lastName: { contains: query.search } },
        { firstNameHe: { contains: query.search } },
        { lastNameHe: { contains: query.search } },
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
          // T3.3 — Hebrew names must be returned so the People edit modal
          // can pre-fill the form with the current values. Without these,
          // the modal would always render empty Hebrew fields even when
          // the row had values, making it look like the column is unset.
          firstNameHe: true,
          lastNameHe: true,
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
        // T3.3 — Hebrew names; see findAll's note for the rationale.
        firstNameHe: true,
        lastNameHe: true,
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

    // Coerce date-only strings ("2026-06-14") to Date so Prisma accepts them
    // as DateTime. Frontend sends date-only because the input is <input type="date">,
    // but Prisma's DateTime field rejects anything that's not a full ISO-8601.
    // Empty string is treated as null (user cleared the field). Same logic as
    // create() above, kept consistent so both paths handle dates identically.
    for (const field of ['employmentDate', 'employmentEndDate'] as const) {
      if (field in data) {
        const v = data[field];
        if (v === '' || v == null) {
          data[field] = null;
        } else if (typeof v === 'string') {
          data[field] = new Date(v);
        }
      }
    }

    const updated = await this.prisma.user.update({
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

    // Mirror Job Title onto the linked BP's professions list so the
    // project role-pickers see it. Safe to skip-on-error: the user write
    // already succeeded; a failed mirror just means the role-picker won't
    // pre-list them yet, no data loss.
    if ('position' in data) {
      try { await this.syncPositionToProfession(id, data.position); }
      catch { /* swallow — user.update already committed */ }
    }

    return updated;
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.user.delete({ where: { id } });
    return { message: 'User deleted' };
  }

  /**
   * Mirror User.position (the People admin's "Job Title" text field) onto
   * the linked BusinessPartner's professions list.
   *
   * Background: the People admin writes `User.position` as a plain string;
   * the project-role picker (and its backend validator) reads professions
   * from `business_partner_professions` — a M2M to the Profession catalog.
   * Before this sync, setting "BIM Coordinator" on Moran Pinto's profile
   * never created the matching profession row, so the picker filtered her
   * out and the backend rejected manual submits with "must hold one of
   * these job titles".
   *
   * Behavior:
   *  • No-op when the user has no linked BusinessPartner (legacy data).
   *  • Position is matched to Profession by NAME (case-insensitive, trimmed).
   *  • If no matching Profession exists, we ignore — the position is then
   *    free-text outside the catalog; admins can add it via Job Titles.
   *  • Only ADDS the link; never removes other professions. People can
   *    legitimately hold several, and removing on edit risks data loss.
   */
  private async syncPositionToProfession(userId: number, position: string | null | undefined): Promise<void> {
    const trimmed = position?.trim();
    if (!trimmed) return; // Empty / cleared — leave existing professions alone.

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { businessPartnerId: true },
    });
    if (!user?.businessPartnerId) return;

    const profession = await this.prisma.profession.findFirst({
      where: { name: { equals: trimmed } },
      select: { id: true },
    });
    if (!profession) return; // Free-text position outside the catalog.

    await this.prisma.businessPartnerProfession.upsert({
      where: {
        businessPartnerId_professionId: {
          businessPartnerId: user.businessPartnerId,
          professionId: profession.id,
        },
      },
      update: {},
      create: {
        businessPartnerId: user.businessPartnerId,
        professionId: profession.id,
      },
    });
  }

  /**
   * Boot hook: auto-run the position → professions backfill if (and only
   * if) we detect at least one user with a Job Title that hasn't been
   * mirrored. Cheap pre-check (single findFirst on an indexed FK), so a
   * cold start where everyone is already in sync costs ~1 query. Wrapped
   * in try/catch so an issue here never blocks bootstrap.
   *
   * Rationale: the forward-fix below only syncs on user create/update,
   * so legacy users (the People admin page predated the sync) need a
   * one-shot catch-up. Making this automatic on boot means the picker
   * starts working as soon as the new code lands — no admin button-click,
   * no console-paste, no operations checklist.
   */
  async onModuleInit(): Promise<void> {
    try {
      const stale = await this.prisma.user.findFirst({
        where: {
          position: { not: null },
          businessPartnerId: { not: null },
          businessPartner: { professions: { none: {} } },
        },
        select: { id: true },
      });
      if (!stale) return;
      const summary = await this.backfillPositionsToProfessions();
      // eslint-disable-next-line no-console
      console.log(`[UsersService] auto-backfill position→professions: ${JSON.stringify(summary)}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[UsersService] auto-backfill skipped: ${(err as Error).message}`);
    }
  }

  /**
   * One-shot: sync every active user's `position` onto their BP's
   * professions list. Idempotent — re-running is safe. Returns a summary
   * so the admin endpoint that wraps this can report counts.
   */
  async backfillPositionsToProfessions(): Promise<{ scanned: number; linked: number; skippedNoBP: number; skippedNoMatch: number }> {
    const users = await this.prisma.user.findMany({
      where: { position: { not: null } },
      select: { id: true, position: true, businessPartnerId: true },
    });
    let linked = 0;
    let skippedNoBP = 0;
    let skippedNoMatch = 0;
    for (const u of users) {
      const trimmed = u.position?.trim();
      if (!trimmed) continue;
      if (!u.businessPartnerId) { skippedNoBP++; continue; }
      const profession = await this.prisma.profession.findFirst({
        where: { name: { equals: trimmed } },
        select: { id: true },
      });
      if (!profession) { skippedNoMatch++; continue; }
      await this.prisma.businessPartnerProfession.upsert({
        where: {
          businessPartnerId_professionId: {
            businessPartnerId: u.businessPartnerId,
            professionId: profession.id,
          },
        },
        update: {},
        create: { businessPartnerId: u.businessPartnerId, professionId: profession.id },
      });
      linked++;
    }
    return { scanned: users.length, linked, skippedNoBP, skippedNoMatch };
  }
}
