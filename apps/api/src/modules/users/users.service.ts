import { Injectable, NotFoundException, ConflictException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { Prisma, UserType } from '@prisma/client';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../../prisma/prisma.service';
import { NumberRangesService } from '../number-ranges/number-ranges.service';
import { UserSenioritiesService } from './user-seniorities.service';
import { BusinessPartnersService } from '../business-partners/business-partners.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';
import { buildCostRateResolver, isRateableOutcome } from '../projects/cost-rate-resolver';
import * as Sentry from '@sentry/node';

@Injectable()
export class UsersService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private numberRanges: NumberRangesService,
    private userSeniorities: UserSenioritiesService,
    private bpService: BusinessPartnersService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 4 · Stage 1c — D1 rule as the SINGLE source of truth for
  // `User.userType`. The DTO field is accepted for backward compatibility
  // (existing FE forms still send it) but IGNORED — we always derive
  // from the user's email against the home org's owned domains.
  //
  // Rule (locked 2026-09-28 §9 review):
  //   email domain ∈ home-org corporate domains  →  'employee'
  //   otherwise (including null email)           →  'partner'  (External User)
  //
  // The 'both' enum value is preserved by the schema but never written by
  // this path; a follow-up ticket will drop the enum value once all
  // legacy readers are gone.
  //
  // Access is DECOUPLED from userType — it flows from Access Role (D3).
  // Flipping a user's email onto/off a home domain toggles their
  // employee status + role `employee` sync but never widens or narrows
  // permissions.
  // ─────────────────────────────────────────────────────────────────────────

  /** Compute `userType` from an email using the home-org owned domains. */
  private async deriveUserType(email: string | null | undefined): Promise<UserType> {
    if (!email) return 'partner';
    const at = email.lastIndexOf('@');
    if (at < 0 || at === email.length - 1) return 'partner';
    const dom = email.slice(at + 1).trim().toLowerCase();
    const homeOrg = await this.bpService.getHomeOrg();
    const ownedDomains = (homeOrg?.domains ?? [])
      .filter((d) => !d.isPersonal)
      .map((d) => d.domain.toLowerCase());
    return ownedDomains.includes(dom) ? 'employee' : 'partner';
  }

  /**
   * Sync the `employee` BusinessPartnerRole on the linked BP so it
   * matches the derived userType. Add-or-remove — idempotent.
   */
  private async syncEmployeeBpRole(
    businessPartnerId: number | null | undefined,
    derived: UserType,
  ): Promise<void> {
    if (!businessPartnerId) return;
    const employeeRole = await this.prisma.partnerRoleType.findUnique({
      where: { code: 'employee' },
    });
    if (!employeeRole) return;
    if (derived === 'employee') {
      await this.prisma.businessPartnerRole.upsert({
        where: {
          businessPartnerId_roleTypeId: {
            businessPartnerId,
            roleTypeId: employeeRole.id,
          },
        },
        create: { businessPartnerId, roleTypeId: employeeRole.id, isPrimary: false },
        update: {},
      });
    } else {
      await this.prisma.businessPartnerRole.deleteMany({
        where: { businessPartnerId, roleTypeId: employeeRole.id },
      });
    }
  }

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

    // 2) Phase 4 · Stage 1c — derive userType from the D1 rule. The DTO
    // field is IGNORED. Employee = user's email domain is owned by the
    // home org; everyone else is a partner (External User). The BP role
    // `employee` is synced to match.
    const derivedUserType = await this.deriveUserType(dto.email);
    await this.syncEmployeeBpRole(businessPartnerId, derivedUserType);

    // 3) Wire the worker_of relationship to the chosen organization.
    // BM2 Phase 1 (2026-08-13): writes to `partner_relationships` (BUT050).
    // The legacy `employee_of` type was folded into `worker_of` by the
    // 20260503 relationship_validity_and_rules migration; keeping only
    // `worker_of` here matches what `business-partners.service` reads.
    if (employerOrgId) {
      const employerOrg = await this.prisma.businessPartner.findFirst({
        where: { id: employerOrgId, partnerType: 'organization', deletedAt: null },
      });
      const workerOfType = await this.prisma.partnerRelationshipType.findUnique({
        where: { code: 'worker_of' },
      });
      if (employerOrg && workerOfType) {
        // Check for an existing active edge; if none, create.
        const now = new Date();
        const existing = await this.prisma.partnerRelationship.findFirst({
          where: {
            partyAId: businessPartnerId,
            partyBId: employerOrg.id,
            typeId: workerOfType.id,
            validTo: { gt: now },
          },
        });
        if (!existing) {
          await this.prisma.partnerRelationship.create({
            data: {
              partyAId: businessPartnerId,
              partyBId: employerOrg.id,
              typeId: workerOfType.id,
              isPrimary: true,
            },
          });
        } else if (existing.status !== 'active') {
          await this.prisma.partnerRelationship.update({
            where: { id: existing.id },
            data: { status: 'active' },
          });
        }
      }
    }

    // M1.1 — Resolve the business code (employee number) from the
    // EMPLOYEE entity kind's number range. Strip from userData so it
    // doesn't double-pass into Prisma below.
    const { code: codeFromDto, ...restUserData } = userData;
    const code = await this.resolveUserCode(codeFromDto);

    // 4) Create the User row, linking to the BP. `userType` is
    // overwritten by the derived value from step 2 — the DTO's field
    // (if any) is dropped so the D1 rule owns writes.
    const { userType: _dtoUserType, ...restNoUserType } = restUserData as any;
    void _dtoUserType;
    const user = await this.prisma.user.create({
      data: {
        ...restNoUserType,
        userType: derivedUserType,
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
        // Retire-User.department Step 3/3 (2026-09-28) — the free-text
        // `department` column is gone. OrgUnit is now the sole source
        // of truth for org-tree membership.
        orgUnitId: true,
        orgUnit: { select: { id: true, name: true } },
        companyName: true,
        roleId: true,
        isActive: true,
        createdAt: true,
        businessPartnerId: true,
        role: true,
      },
    });

    // 5) M17 — Labor Category single source. If the DTO carried a
    // seniorityLevelId, seed the first UserSeniority history row so
    // the cost resolver has a date-effective interval to hit. This
    // mirrors what the users importer already does (see
    // users-importer.service.ts). Uses employmentDate when present;
    // falls back to today when not. Skip-on-error keeps the user row
    // safe if the history seed hiccups — the mismatch report will
    // catch it and the admin resolves manually.
    if (dto.seniorityLevelId) {
      const startIso = (dto.employmentDate ?? new Date().toISOString()).slice(0, 10);
      try {
        await this.userSeniorities.addEntry(user.id, {
          seniorityLevelId: dto.seniorityLevelId,
          startDate: startIso,
        });
      } catch (e) {
        Sentry.captureException(e);
        /* swallow — user row already committed; mismatch report surfaces it */
      }
    }

    // 6) Mirror Job Title onto the BP's professions list — see syncPositionToProfession().
    // Same skip-on-error policy as update(): the user create already
    // committed; a failed mirror just delays role-picker visibility.
    if (dto.position) {
      try { await this.syncPositionToProfession(user.id, dto.position); }
      catch (e) { Sentry.captureException(e); /* swallow */ }
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
          // Retire-User.department Step 3/3 — OrgUnit is the sole source
          // of truth; free-text `department` retired in this commit.
          orgUnitId: true,
          orgUnit: { select: { id: true, name: true } },
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

    // QA3 round-3 item 7 — compute each user's CURRENT effective hourly
    // rate ("today"). Same resolver the cost engine uses, so the value
    // displayed on the Employees table always matches what the labor-cost
    // paths would bill for a right-now entry. `rateSource` tags each
    // value with the winning layer so the FE can render an "override"
    // pill when applicable. Non-employees keep null/null.
    const employeeIds = data
      .filter((u: any) => u.userType === 'employee')
      .map((u: any) => u.id);
    const resolver = employeeIds.length === 0
      ? null
      : await buildCostRateResolver(this.prisma, employeeIds);
    const today = new Date();

    // Flatten role so the response matches the shared UserListItem shape
    const flat = data.map((u: any) => {
      const outcome = resolver && u.userType === 'employee'
        ? resolver.resolve(u.id, today)
        : null;
      let effectiveHourlyCost: number | null = null;
      let rateSource: 'override' | 'level' | 'default' | null = null;
      if (outcome && isRateableOutcome(outcome)) {
        effectiveHourlyCost = outcome.hourlyCost;
        rateSource =
          outcome.source === 'user_override' ? 'override'
          : outcome.source === 'level_rate_history' ? 'level'
          : 'default';
      }
      return {
        ...u,
        roleName: u.role?.name ?? null,
        effectiveHourlyCost,
        rateSource,
      };
    });

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
        // Retire-User.department Step 3/3 — OrgUnit only.
        orgUnitId: true,
        orgUnit: { select: { id: true, name: true } },
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
    const existing = await this.findOne(id);

    const data: any = { ...dto };

    if (dto.password) {
      data.password = await bcrypt.hash(dto.password, 12);
    }

    // Phase 4 · Stage 1c — the DTO field `userType` is read-only from
    // the outside; the rule owns writes. Drop it silently.
    if ('userType' in data) {
      delete data.userType;
    }

    // If the email changed (or was set for the first time on an
    // existing row), re-derive userType from the D1 rule and sync the
    // BP `employee` role. When email is untouched, keep the row's
    // current userType — the M6 write path already keeps this in sync
    // on domain-list changes via a separate hook.
    const nextEmail = 'email' in dto ? dto.email : (existing as any).email;
    const emailChanged = 'email' in dto && dto.email !== (existing as any).email;
    if (emailChanged) {
      data.userType = await this.deriveUserType(nextEmail);
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

    // M17 — Labor Category single source. `PATCH /users/:id` used to
    // write `seniorityLevelId` straight onto the User row, bypassing
    // the UserSeniority history and leaving the cost resolver's
    // date-effective lookup with no interval to hit. Now: if a caller
    // still sends `seniorityLevelId` (inline table edit, edit modal
    // fallback path), we transparently route it through the history
    // service — one open-ended row starting today, previous open row
    // auto-closed at the day before. The `syncUserSeniorityLevel()`
    // step inside addEntry keeps `User.seniorityLevelId` correct as
    // the cache the FE reads. Strip from the direct update so we
    // don't double-write; the sync call inside addEntry owns it.
    const routedSeniorityLevelId =
      'seniorityLevelId' in data ? (data.seniorityLevelId as number | null | undefined) : undefined;
    if ('seniorityLevelId' in data) {
      delete data.seniorityLevelId;
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
        // Retire-User.department Step 3/3 — OrgUnit only.
        orgUnitId: true,
        orgUnit: { select: { id: true, name: true } },
        companyName: true,
        dailyStandardHours: true,
        employmentDate: true,
        employmentEndDate: true,
        isActive: true,
        role: { select: { id: true, name: true } },
      },
    });

    // M17 — after the direct update, route `seniorityLevelId` through
    // the history service if it was on the DTO. `null` clears — since
    // addEntry only accepts a real level id we translate null into
    // "close any current open history row without adding a replacement"
    // (the direct update above ALREADY cleared the cache column, and
    // syncUserSeniorityLevel would just re-set it; do the closure
    // ourselves so the semantics match "no current category").
    if (routedSeniorityLevelId !== undefined) {
      if (routedSeniorityLevelId === null) {
        // Close the current open-ended row so history reflects "no
        // category as of today"; leave the cache column null.
        await this.prisma.userSeniority.updateMany({
          where: { userId: id, endDate: null },
          data: { endDate: new Date() },
        });
        await this.prisma.user.update({ where: { id }, data: { seniorityLevelId: null } });
      } else {
        // Effective-date = today by default. If we already have an open
        // row on the same level, skip — no state change to record.
        const openRow = await this.prisma.userSeniority.findFirst({
          where: { userId: id, endDate: null },
          orderBy: { startDate: 'desc' },
        });
        if (!openRow || openRow.seniorityLevelId !== routedSeniorityLevelId) {
          const today = new Date().toISOString().slice(0, 10);
          try {
            await this.userSeniorities.addEntry(id, {
              seniorityLevelId: routedSeniorityLevelId,
              startDate: today,
            });
          } catch (e) {
            // If the previous open row started today, addEntry would
            // fail the overlap check. In that case reassign the open
            // row's level in-place — this is the same "correcting a
            // just-made change" semantics the History section already
            // supports via updateEntry.
            if (openRow && openRow.startDate.toISOString().slice(0, 10) === today) {
              await this.userSeniorities.updateEntry(openRow.id, {
                seniorityLevelId: routedSeniorityLevelId,
              });
            } else {
              throw e;
            }
          }
        }
      }
    }

    // Mirror Job Title onto the linked BP's professions list so the
    // project role-pickers see it. Safe to skip-on-error: the user write
    // already succeeded; a failed mirror just means the role-picker won't
    // pre-list them yet, no data loss.
    if ('position' in data) {
      try { await this.syncPositionToProfession(id, data.position); }
      catch (e) { Sentry.captureException(e); /* swallow — user.update already committed */ }
    }

    // Phase 4 · Stage 1c — when the email moved on/off a home domain,
    // sync the BP `employee` role to match the newly-derived userType.
    // Skip-on-error: the user row is already committed; a failed sync
    // just delays the tag flip until the next write.
    if (emailChanged) {
      try {
        const bpId = (existing as any).businessPartnerId ?? null;
        await this.syncEmployeeBpRole(bpId, data.userType as UserType);
      } catch (e) { Sentry.captureException(e); /* swallow */ }
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
