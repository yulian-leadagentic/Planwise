import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateHrEmployeeDto } from './dto/update-employee.dto';
import { CreateEligibilityDto } from './dto/create-eligibility.dto';
import { UpdateEligibilityDto } from './dto/update-eligibility.dto';

/**
 * HR Phase A3 (2026-10-15) — business logic for the /hr/* surface.
 * Scope A: employee roster + per-employee SpecialHourBucket eligibility
 * CRUD. Everything else from the spec (monthly review, reports,
 * approvals, auto-credit math) ships in Phase B/C.
 */
@Injectable()
export class HrService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── SpecialHourBucket catalog ──────────────────────────────────────

  /**
   * List the SpecialHourBucket catalog so the FE "add eligibility"
   * dialog can offer a picker. Opt-in filters for the "B-behaviour,
   * active" case the HR drawer needs today. Phase B/C UI (admin
   * settings on the catalog itself) will surface the full list.
   */
  async listBuckets(opts: { behavior?: 'A' | 'B' | 'C'; activeOnly?: boolean } = {}) {
    const rows = await this.prisma.specialHourBucket.findMany({
      where: {
        ...(opts.behavior ? { behavior: opts.behavior } : {}),
        ...(opts.activeOnly ? { active: true } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return rows.map((b) => ({
      ...b,
      dailyAmount: b.dailyAmount != null ? Number(b.dailyAmount) : null,
      maxPerYear: b.maxPerYear != null ? Number(b.maxPerYear) : null,
      minDailyStandard: b.minDailyStandard != null ? Number(b.minDailyStandard) : null,
    }));
  }

  // ─── Employee roster ────────────────────────────────────────────────

  /**
   * HR roster — all users whose `userType` is 'employee'. Internal
   * staff only; external partners live under /partners. We DON'T hide
   * inactive rows here: HR needs to see every ex-employee in the
   * payroll month until the final paycheck lands.
   *
   * Returns the fields the FE table displays:
   *   id · firstName · lastName · orgUnit (as "department") ·
   *   dailyStandardHours · employmentType · accountingEmployeeNumber ·
   *   employmentDate · employmentEndDate · isActive
   */
  async listEmployees() {
    const rows = await this.prisma.user.findMany({
      where: {
        userType: 'employee',
        deletedAt: null,
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        firstNameHe: true,
        lastNameHe: true,
        email: true,
        dailyStandardHours: true,
        employmentType: true,
        accountingEmployeeNumber: true,
        employmentDate: true,
        employmentEndDate: true,
        isActive: true,
        orgUnit: { select: { id: true, name: true } },
      },
    });
    // Decimal → number so the FE doesn't have to .toString() every cell.
    return rows.map((r) => ({
      ...r,
      dailyStandardHours:
        r.dailyStandardHours != null ? Number(r.dailyStandardHours) : null,
    }));
  }

  async getEmployee(id: number) {
    const user = await this.prisma.user.findFirst({
      where: { id, userType: 'employee', deletedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        firstNameHe: true,
        lastNameHe: true,
        email: true,
        dailyStandardHours: true,
        employmentType: true,
        accountingEmployeeNumber: true,
        employmentDate: true,
        employmentEndDate: true,
        isActive: true,
        orgUnit: { select: { id: true, name: true } },
        bucketEligibilities: {
          orderBy: [{ active: 'desc' }, { startDate: 'desc' }],
          include: {
            bucket: {
              select: {
                id: true,
                code: true,
                nameHe: true,
                behavior: true,
                unit: true,
                requiresDocument: true,
                dailyAmount: true,
                maxPerYear: true,
                minDailyStandard: true,
                defaultCreditMode: true,
                active: true,
              },
            },
          },
        },
      },
    });
    if (!user) throw new NotFoundException(`Employee ${id} not found`);
    return {
      ...user,
      dailyStandardHours:
        user.dailyStandardHours != null ? Number(user.dailyStandardHours) : null,
      bucketEligibilities: user.bucketEligibilities.map((e) => ({
        ...e,
        dailyAmount: Number(e.dailyAmount),
        bucket: e.bucket
          ? {
              ...e.bucket,
              dailyAmount:
                e.bucket.dailyAmount != null ? Number(e.bucket.dailyAmount) : null,
              maxPerYear:
                e.bucket.maxPerYear != null ? Number(e.bucket.maxPerYear) : null,
              minDailyStandard:
                e.bucket.minDailyStandard != null
                  ? Number(e.bucket.minDailyStandard)
                  : null,
            }
          : null,
      })),
    };
  }

  async updateEmployee(id: number, dto: UpdateHrEmployeeDto) {
    const existing = await this.prisma.user.findFirst({
      where: { id, userType: 'employee', deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(`Employee ${id} not found`);

    const data: Record<string, unknown> = {};
    if ('employmentType' in dto) data.employmentType = dto.employmentType ?? null;
    if ('accountingEmployeeNumber' in dto)
      data.accountingEmployeeNumber = dto.accountingEmployeeNumber ?? null;
    if ('dailyStandardHours' in dto)
      data.dailyStandardHours = dto.dailyStandardHours ?? null;
    if ('employmentDate' in dto)
      data.employmentDate = dto.employmentDate ? new Date(dto.employmentDate) : null;
    if ('employmentEndDate' in dto)
      data.employmentEndDate = dto.employmentEndDate
        ? new Date(dto.employmentEndDate)
        : null;

    await this.prisma.user.update({ where: { id }, data });
    return this.getEmployee(id);
  }

  // ─── Per-employee bucket eligibilities ──────────────────────────────

  async listEligibilities(userId: number) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, userType: 'employee', deletedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException(`Employee ${userId} not found`);
    const rows = await this.prisma.employeeBucketEligibility.findMany({
      where: { userId },
      orderBy: [{ active: 'desc' }, { startDate: 'desc' }],
      include: {
        bucket: {
          select: {
            id: true,
            code: true,
            nameHe: true,
            behavior: true,
            unit: true,
            requiresDocument: true,
            dailyAmount: true,
            maxPerYear: true,
            minDailyStandard: true,
            defaultCreditMode: true,
            active: true,
          },
        },
      },
    });
    return rows.map((e) => ({
      ...e,
      dailyAmount: Number(e.dailyAmount),
      bucket: e.bucket
        ? {
            ...e.bucket,
            dailyAmount:
              e.bucket.dailyAmount != null ? Number(e.bucket.dailyAmount) : null,
            maxPerYear:
              e.bucket.maxPerYear != null ? Number(e.bucket.maxPerYear) : null,
            minDailyStandard:
              e.bucket.minDailyStandard != null
                ? Number(e.bucket.minDailyStandard)
                : null,
          }
        : null,
    }));
  }

  async createEligibility(
    userId: number,
    createdById: number,
    dto: CreateEligibilityDto,
  ): Promise<{ eligibility: Awaited<ReturnType<HrService['listEligibilities']>>[number]; warnings: string[] }> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, userType: 'employee', deletedAt: null },
      select: { id: true, dailyStandardHours: true, firstName: true, lastName: true },
    });
    if (!user) throw new NotFoundException(`Employee ${userId} not found`);

    const bucket = await this.prisma.specialHourBucket.findUnique({
      where: { id: dto.bucketId },
    });
    if (!bucket) throw new NotFoundException(`Bucket ${dto.bucketId} not found`);

    // Default start = today; default end = Dec 31 of current year.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = dto.startDate ? new Date(dto.startDate) : today;
    const endDate = dto.endDate
      ? new Date(dto.endDate)
      : new Date(today.getFullYear(), 11, 31);
    if (endDate < startDate) {
      throw new BadRequestException('endDate must be on or after startDate');
    }

    // Daily amount: use the supplied value or inherit from the bucket.
    // Bucket may be a behavior-A (null) bucket; require a numeric daily
    // amount since the row is NOT NULL on the DB.
    const amount =
      dto.dailyAmount ?? (bucket.dailyAmount != null ? Number(bucket.dailyAmount) : null);
    if (amount == null || amount <= 0) {
      throw new BadRequestException(
        `dailyAmount is required for this bucket (bucket "${bucket.code}" has no default; supply one)`,
      );
    }

    // Soft warning (per spec §7.1): if bucket demands a minimum daily
    // standard the employee doesn't meet, warn but DO NOT reject.
    const warnings: string[] = [];
    if (
      bucket.minDailyStandard != null &&
      user.dailyStandardHours != null &&
      Number(user.dailyStandardHours) < Number(bucket.minDailyStandard)
    ) {
      warnings.push(
        `Bucket "${bucket.code}" expects at least ${Number(
          bucket.minDailyStandard,
        )}h/day; ${user.firstName} ${user.lastName} is at ${Number(
          user.dailyStandardHours,
        )}h/day.`,
      );
    }

    const created = await this.prisma.employeeBucketEligibility.create({
      data: {
        userId,
        bucketId: dto.bucketId,
        dailyAmount: amount,
        startDate,
        endDate,
        creditMode: dto.creditMode ?? null,
        documentFileId: dto.documentFileId ?? null,
        createdById,
      },
      include: {
        bucket: {
          select: {
            id: true,
            code: true,
            nameHe: true,
            behavior: true,
            unit: true,
            requiresDocument: true,
            dailyAmount: true,
            maxPerYear: true,
            minDailyStandard: true,
            defaultCreditMode: true,
            active: true,
          },
        },
      },
    });

    return {
      eligibility: {
        ...created,
        dailyAmount: Number(created.dailyAmount),
        bucket: created.bucket
          ? {
              ...created.bucket,
              dailyAmount:
                created.bucket.dailyAmount != null
                  ? Number(created.bucket.dailyAmount)
                  : null,
              maxPerYear:
                created.bucket.maxPerYear != null
                  ? Number(created.bucket.maxPerYear)
                  : null,
              minDailyStandard:
                created.bucket.minDailyStandard != null
                  ? Number(created.bucket.minDailyStandard)
                  : null,
            }
          : null,
      },
      warnings,
    };
  }

  async updateEligibility(
    userId: number,
    eligibilityId: number,
    dto: UpdateEligibilityDto,
  ) {
    const existing = await this.prisma.employeeBucketEligibility.findFirst({
      where: { id: eligibilityId, userId },
    });
    if (!existing)
      throw new NotFoundException(`Eligibility ${eligibilityId} not found for employee ${userId}`);

    const data: Record<string, unknown> = {};
    if ('dailyAmount' in dto && dto.dailyAmount != null)
      data.dailyAmount = dto.dailyAmount;
    if ('startDate' in dto && dto.startDate)
      data.startDate = new Date(dto.startDate);
    if ('endDate' in dto && dto.endDate)
      data.endDate = new Date(dto.endDate);
    if ('creditMode' in dto) data.creditMode = dto.creditMode ?? null;
    if ('documentFileId' in dto) data.documentFileId = dto.documentFileId ?? null;
    if ('active' in dto && dto.active != null) data.active = dto.active;

    // Overlap guard: endDate must be >= startDate after the patch.
    const nextStart = (data.startDate as Date | undefined) ?? existing.startDate;
    const nextEnd = (data.endDate as Date | undefined) ?? existing.endDate;
    if (nextEnd < nextStart) {
      throw new BadRequestException('endDate must be on or after startDate');
    }

    await this.prisma.employeeBucketEligibility.update({
      where: { id: eligibilityId },
      data,
    });
    const list = await this.listEligibilities(userId);
    return list.find((e) => e.id === eligibilityId) ?? null;
  }

  /**
   * Soft-delete via `active=false`. Preserving the row keeps the audit
   * trail (who granted the bucket + when) intact for future reports.
   */
  async deactivateEligibility(userId: number, eligibilityId: number) {
    const existing = await this.prisma.employeeBucketEligibility.findFirst({
      where: { id: eligibilityId, userId },
    });
    if (!existing)
      throw new NotFoundException(`Eligibility ${eligibilityId} not found for employee ${userId}`);
    await this.prisma.employeeBucketEligibility.update({
      where: { id: eligibilityId },
      data: { active: false },
    });
    return { ok: true };
  }
}
