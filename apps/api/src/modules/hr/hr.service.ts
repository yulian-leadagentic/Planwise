import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';

import { PrismaService } from '../../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { UpdateHrEmployeeDto } from './dto/update-employee.dto';
import { CreateEligibilityDto } from './dto/create-eligibility.dto';
import { UpdateEligibilityDto } from './dto/update-eligibility.dto';
import { UpdateHrSettingsDto } from './dto/update-hr-settings.dto';
// §15 R2 (2026-10-18) — CalendarDay CRUD moved out of /hr; Admin →
// Calendar is the single source of truth now, so the related DTOs
// no longer have a caller inside this service.
import {
  CreateAbsenceTypeDto,
  UpdateAbsenceTypeDto,
} from './dto/absence-type.dto';
import {
  CreateAbsenceRecordDto,
  UpdateAbsenceRecordDto,
} from './dto/absence-record.dto';
import {
  CreateSpecialHourBucketDto,
  UpdateSpecialHourBucketDto,
} from './dto/bucket.dto';

/**
 * Date-only "today" marker for picker eligibility windows. Matches
 * how `@db.Date` columns (CalendarDay, EmployeeBucketEligibility) are
 * compared in the engine — UTC midnight for the local calendar day.
 * See `listPickableBucketsForCaller` for rationale.
 */
function todayDateOnly(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/**
 * HR Phase A3+B3 (2026-10-15) — business logic for the /hr/* surface.
 *
 * Growing but still one domain — kept in a single service so the
 * cross-resource invariants (an attachment's user id must match the
 * route param, bucket.isSystem partial-locks, bereavement 7-day
 * span) sit next to each other.
 *
 * Audit: HR writes feed ActivityLogService under category='admin'
 * with entityType identifying the resource (hr_settings, calendar_day,
 * absence_type, absence_record, bucket, hr_attachment). An audit-log
 * failure never breaks the business write.
 */
@Injectable()
export class HrService {
  private readonly log = new Logger(HrService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly activityLog: ActivityLogService,
  ) {}

  // ═══ SpecialHourBucket catalog ══════════════════════════════════════

  async listBuckets(opts: { behavior?: 'A' | 'B' | 'C'; activeOnly?: boolean } = {}) {
    const rows = await this.prisma.specialHourBucket.findMany({
      where: {
        ...(opts.behavior ? { behavior: opts.behavior } : {}),
        ...(opts.activeOnly ? { active: true } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return rows.map((b) => this.decimalBucket(b));
  }

  private decimalBucket<T extends { dailyAmount: any; maxPerYear: any; minDailyStandard: any }>(b: T) {
    return {
      ...b,
      dailyAmount: b.dailyAmount != null ? Number(b.dailyAmount) : null,
      maxPerYear: b.maxPerYear != null ? Number(b.maxPerYear) : null,
      minDailyStandard: b.minDailyStandard != null ? Number(b.minDailyStandard) : null,
    };
  }

  async createBucket(dto: CreateSpecialHourBucketDto, actorId: number) {
    const dup = await this.prisma.specialHourBucket.findUnique({ where: { code: dto.code } });
    if (dup) throw new ConflictException(`Bucket code "${dto.code}" already exists`);

    const created = await this.prisma.specialHourBucket.create({
      data: {
        code: dto.code,
        nameHe: dto.nameHe,
        behavior: dto.behavior,
        unit: dto.unit,
        requiresDocument: dto.requiresDocument ?? false,
        dailyAmount: dto.dailyAmount ?? null,
        maxPerYear: dto.maxPerYear ?? null,
        minDailyStandard: dto.minDailyStandard ?? null,
        defaultCreditMode: dto.defaultCreditMode ?? 'REPORTED',
        active: dto.active ?? true,
        sortOrder: dto.sortOrder ?? 0,
        // Explicit: user-created rows are never system — the Q10 lock
        // on PATCH/DELETE keys off `isSystem`, so trusting the client
        // would open the admin UI to permanent-row injection.
        isSystem: false,
      },
    });
    this.writeAudit({
      actorId,
      action: 'hr.bucket.created',
      entityType: 'special_hour_bucket',
      entityId: created.id,
      entityName: created.nameHe,
      description: `Created special-hour bucket "${created.nameHe}" (${created.code})`,
    });
    return this.decimalBucket(created);
  }

  async updateBucket(id: number, dto: UpdateSpecialHourBucketDto, actorId: number) {
    const existing = await this.prisma.specialHourBucket.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Bucket ${id} not found`);

    const data: Prisma.SpecialHourBucketUpdateInput = {};
    const stripped: string[] = [];

    const applyField = <K extends keyof UpdateSpecialHourBucketDto>(
      key: K,
      value: UpdateSpecialHourBucketDto[K],
    ) => {
      (data as any)[key] = value;
    };

    // Q10 partial lock on `isSystem=true`. Strip code/behavior/unit/
    // requiresDocument/isSystem from the payload; nameHe + dailyAmount
    // + maxPerYear + minDailyStandard + defaultCreditMode + active +
    // sortOrder all flow. Match AbsenceType's semantics so the admin UI
    // doesn't surface two different lock sets.
    const SYSTEM_LOCKED = new Set(['code', 'behavior', 'unit', 'requiresDocument']);

    for (const k of Object.keys(dto) as (keyof UpdateSpecialHourBucketDto)[]) {
      if (existing.isSystem && SYSTEM_LOCKED.has(k as string)) {
        stripped.push(k as string);
        continue;
      }
      applyField(k, dto[k]);
    }

    if (stripped.length > 0) {
      this.log.warn(
        `[hr/buckets] isSystem row ${id} — stripped locked fields: ${stripped.join(', ')}`,
      );
    }

    const updated = await this.prisma.specialHourBucket.update({ where: { id }, data });
    this.writeAudit({
      actorId,
      action: 'hr.bucket.updated',
      entityType: 'special_hour_bucket',
      entityId: id,
      entityName: updated.nameHe,
      description: `Updated bucket "${updated.nameHe}"` +
        (stripped.length ? ` (locked: ${stripped.join(', ')})` : ''),
    });
    return this.decimalBucket(updated);
  }

  async deleteBucket(id: number, actorId: number) {
    const existing = await this.prisma.specialHourBucket.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Bucket ${id} not found`);
    if (existing.isSystem) {
      throw new ConflictException(
        `Bucket "${existing.code}" is a system row — soft-deactivate it via PATCH { active: false } instead.`,
      );
    }
    await this.prisma.specialHourBucket.update({ where: { id }, data: { active: false } });
    this.writeAudit({
      actorId,
      action: 'hr.bucket.deactivated',
      entityType: 'special_hour_bucket',
      entityId: id,
      entityName: existing.nameHe,
      description: `Deactivated bucket "${existing.nameHe}" (${existing.code})`,
    });
    return { ok: true, id };
  }

  /**
   * HR §9.1 (2026-10-16) — caller-scoped pickable buckets.
   *
   * Returned to **any authenticated user** (no `hr:*` guard). The
   * admin catalog at `GET /hr/buckets` stays `hr:read`; this endpoint
   * is intentionally narrower: it leaks nothing beyond the bucket's
   * category labels (which the picker needs to render A/C/B groups)
   * and never surfaces `isSystem` or the `active` flag — both are
   * implicit in the filter.
   *
   * Visibility rules:
   *   • A + C buckets with `active=true` → shown to everyone, because
   *     "שעות שאינן על פרויקט" (meetings/culture/breadth/training
   *     for A, pregnancy/fertility/childcare for C) must be reportable
   *     by the employee themselves. Hiding the whole picker from
   *     non-HR users would break the core "time outside projects"
   *     flow (Yulian 2026-10-15 §9.1 Option A).
   *   • B buckets only when the caller holds an active
   *     `EmployeeBucketEligibility` row whose window brackets *today*
   *     (`active=true AND start_date <= today <= end_date`) AND the
   *     resolved credit mode is `REPORTED`. Resolved mode is
   *     `eligibility.creditMode ?? bucket.defaultCreditMode` — a
   *     B·AUTO bucket is server-credited and never shown to the user
   *     (would double-count). A non-eligible user never sees B at all.
   *
   * Order: `(behavior ASC, sortOrder ASC)` — A first, then B, then C,
   * so the picker's grouped render has A on top.
   *
   * Server-side enforcement on `TimeEntry` writes (B eligibility and
   * B·AUTO rejection) lives in `TimeEntriesService.assertUsableBucket`;
   * this picker is UX only. See `planwise-hr-module-spec.md` §9.1.
   */
  async listPickableBucketsForCaller(userId: number) {
    const [activeBuckets, eligibilities] = await Promise.all([
      this.prisma.specialHourBucket.findMany({
        where: { active: true },
        orderBy: [{ behavior: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
      }),
      // Date-only comparison. Prisma stores @db.Date as midnight UTC;
      // comparing against `new Date()` at the server's local midnight
      // can skew by a day near 00:00. Build the "today" date-only
      // marker in UTC to match how calendarDay / eligibility rows are
      // persisted (migration backfill wrote `DATE 'YYYY-MM-DD'`).
      this.prisma.employeeBucketEligibility.findMany({
        where: {
          userId,
          active: true,
          startDate: { lte: todayDateOnly() },
          endDate: { gte: todayDateOnly() },
        },
        select: {
          bucketId: true,
          creditMode: true,
        },
      }),
    ]);

    // Resolve the caller's B-eligibility map: bucketId → resolved mode.
    // Multiple active eligibilities for the same bucket on the same day
    // are not expected (createEligibility rejects overlaps) but we take
    // the first encountered to stay deterministic if the DB ever drifts.
    const callerBEligibility = new Map<number, 'REPORTED' | 'AUTO'>();
    for (const e of eligibilities) {
      if (callerBEligibility.has(e.bucketId)) continue;
      const bucket = activeBuckets.find((b) => b.id === e.bucketId);
      if (!bucket || bucket.behavior !== 'B') continue;
      const mode = (e.creditMode ?? bucket.defaultCreditMode) as 'REPORTED' | 'AUTO';
      callerBEligibility.set(e.bucketId, mode);
    }

    const pickable = activeBuckets.filter((b) => {
      if (b.behavior === 'A' || b.behavior === 'C') return true;
      // behavior B: only when caller has eligibility AND resolved
      // mode is REPORTED. A B·AUTO eligibility stays server-side.
      return callerBEligibility.get(b.id) === 'REPORTED';
    });

    // Minimal projection — no isSystem, no active, no eligibility
    // metadata. The caller only needs what the picker renders.
    return pickable.map((b) => ({
      id: b.id,
      code: b.code,
      nameHe: b.nameHe,
      behavior: b.behavior,
      unit: b.unit,
      requiresDocument: b.requiresDocument,
      dailyAmount: b.dailyAmount != null ? Number(b.dailyAmount) : null,
      maxPerYear: b.maxPerYear != null ? Number(b.maxPerYear) : null,
      minDailyStandard: b.minDailyStandard != null ? Number(b.minDailyStandard) : null,
      defaultCreditMode: b.defaultCreditMode,
      sortOrder: b.sortOrder,
    }));
  }

  // ═══ Unified time-category catalog (F5, 2026-10-19) ══════════════════
  // Composition (NO migration — kind is DERIVED):
  //   • kind = ABSENCE          → every active AbsenceType
  //   • kind = WORK_NON_PROJECT → every active SpecialHourBucket where behavior='A'
  //   • kind = QUOTA            → every active SpecialHourBucket where behavior='C'
  //                               AND the caller has an active EmployeeBucketEligibility
  //                               covering today (privacy constraint).
  // ENTITLEMENT (B) is intentionally omitted — the engine auto-credits
  // those, they are never user-reported through the time-categories picker.
  //
  // Sort order: kind (ABSENCE → WORK_NON_PROJECT → QUOTA) → sortOrder → nameHe.
  //
  // Caller gating lives on `TimeEntry`/`AbsenceRecord` create — this
  // endpoint is UX only. Keep it un-permissioned so every logged-in user
  // can render their picker.
  async listTimeCategoriesForCaller(userId: number) {
    const [absenceTypes, buckets, eligibilities] = await Promise.all([
      this.prisma.absenceType.findMany({
        where: { active: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.specialHourBucket.findMany({
        where: { active: true, behavior: { in: ['A', 'C'] } },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.employeeBucketEligibility.findMany({
        where: {
          userId,
          active: true,
          startDate: { lte: todayDateOnly() },
          endDate: { gte: todayDateOnly() },
        },
        select: { bucketId: true },
      }),
    ]);

    const callerBucketIds = new Set(eligibilities.map((e) => e.bucketId));

    type TimeCategoryKind = 'ABSENCE' | 'WORK_NON_PROJECT' | 'QUOTA';
    const rows: Array<{
      kind: TimeCategoryKind;
      absenceTypeId?: number;
      bucketId?: number;
      code: string;
      nameHe: string;
      unit: 'DAY' | 'HOUR';
      requiresDocument: boolean;
      maxPerYear: number | null;
      active: true;
      sortOrder: number;
    }> = [];

    for (const t of absenceTypes) {
      rows.push({
        kind: 'ABSENCE',
        absenceTypeId: t.id,
        code: t.code,
        nameHe: t.nameHe,
        unit: t.unit as 'DAY' | 'HOUR',
        requiresDocument: t.requiresDocument,
        maxPerYear: t.maxPerYear ?? null,
        active: true,
        sortOrder: t.sortOrder,
      });
    }

    for (const b of buckets) {
      if (b.behavior === 'A') {
        rows.push({
          kind: 'WORK_NON_PROJECT',
          bucketId: b.id,
          code: b.code,
          nameHe: b.nameHe,
          unit: b.unit as 'DAY' | 'HOUR',
          requiresDocument: b.requiresDocument,
          maxPerYear: b.maxPerYear != null ? Number(b.maxPerYear) : null,
          active: true,
          sortOrder: b.sortOrder,
        });
      } else if (b.behavior === 'C') {
        // Privacy constraint — only surface C buckets to users who have
        // an active eligibility covering today. Users without a grant
        // never see the bucket in their picker.
        if (!callerBucketIds.has(b.id)) continue;
        rows.push({
          kind: 'QUOTA',
          bucketId: b.id,
          code: b.code,
          nameHe: b.nameHe,
          unit: b.unit as 'DAY' | 'HOUR',
          requiresDocument: b.requiresDocument,
          maxPerYear: b.maxPerYear != null ? Number(b.maxPerYear) : null,
          active: true,
          sortOrder: b.sortOrder,
        });
      }
    }

    // Final sort: kind first (ABSENCE → WORK_NON_PROJECT → QUOTA), then
    // sortOrder, then Hebrew name as the deterministic tiebreak.
    const kindRank: Record<TimeCategoryKind, number> = {
      ABSENCE: 0,
      WORK_NON_PROJECT: 1,
      QUOTA: 2,
    };
    rows.sort((a, b) => {
      if (kindRank[a.kind] !== kindRank[b.kind]) {
        return kindRank[a.kind] - kindRank[b.kind];
      }
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.nameHe.localeCompare(b.nameHe, 'he');
    });

    return rows;
  }

  // ═══ HR settings (singleton row id=1) ════════════════════════════════

  async getSettings() {
    // Create on first read so admin never sees a 404 before the seed
    // has run. The migration already seeds the singleton, but staging
    // may wipe + reseed, and tests spin up blank DBs.
    let row = await this.prisma.hrSettings.findUnique({ where: { id: 1 } });
    if (!row) {
      row = await this.prisma.hrSettings.create({
        data: { id: 1 },
      });
    }
    return {
      id: row.id,
      shortDayHoursHolidayEve: Number(row.shortDayHoursHolidayEve),
      shortDayHoursCholHamoed: Number(row.shortDayHoursCholHamoed),
      minHoursPerDay: Number(row.minHoursPerDay),
      updatedAt: row.updatedAt,
    };
  }

  async updateSettings(dto: UpdateHrSettingsDto, actorId: number) {
    // Ensure row exists first (shares the create-on-read path).
    await this.getSettings();
    const data: Prisma.HrSettingsUpdateInput = {};
    const changed: string[] = [];
    if (dto.shortDayHoursHolidayEve != null) {
      data.shortDayHoursHolidayEve = dto.shortDayHoursHolidayEve;
      changed.push('holidayEve');
    }
    if (dto.shortDayHoursCholHamoed != null) {
      data.shortDayHoursCholHamoed = dto.shortDayHoursCholHamoed;
      changed.push('cholHamoed');
    }
    if (dto.minHoursPerDay != null) {
      data.minHoursPerDay = dto.minHoursPerDay;
      changed.push('minHours');
    }
    const row = await this.prisma.hrSettings.update({ where: { id: 1 }, data });
    this.writeAudit({
      actorId,
      action: 'hr.settings.updated',
      entityType: 'hr_settings',
      entityId: 1,
      description: `Updated HR settings — ${changed.join(', ') || 'no fields'}`,
    });
    return {
      id: row.id,
      shortDayHoursHolidayEve: Number(row.shortDayHoursHolidayEve),
      shortDayHoursCholHamoed: Number(row.shortDayHoursCholHamoed),
      minHoursPerDay: Number(row.minHoursPerDay),
      updatedAt: row.updatedAt,
    };
  }

  // §15 R2 (2026-10-18) — CalendarDay CRUD under /hr/* was removed.
  // Admin → Calendar (`/calendar/*`) is now the single source of truth
  // for calendar exceptions. The HR monthly engine still reads the
  // same `CalendarDay` table via PrismaService, so the enum remap
  // (HOLIDAY / HOLIDAY_EVE / CHOL_HAMOED / REST) stays intact.

  // ═══ AbsenceType admin CRUD ═════════════════════════════════════════

  async listAbsenceTypes(opts: { activeOnly?: boolean } = {}) {
    return this.prisma.absenceType.findMany({
      where: {
        ...(opts.activeOnly ? { active: true } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  }

  async createAbsenceType(dto: CreateAbsenceTypeDto, actorId: number) {
    const dup = await this.prisma.absenceType.findUnique({ where: { code: dto.code } });
    if (dup) throw new ConflictException(`Absence type code "${dto.code}" already exists`);

    const created = await this.prisma.absenceType.create({
      data: {
        code: dto.code,
        nameHe: dto.nameHe,
        unit: dto.unit,
        requiresDocument: dto.requiresDocument ?? false,
        deductsFromSick: dto.deductsFromSick ?? false,
        maxPerYear: dto.maxPerYear ?? null,
        halfDay: dto.halfDay ?? false,
        active: dto.active ?? true,
        sortOrder: dto.sortOrder ?? 0,
        isSystem: false,
      },
    });
    this.writeAudit({
      actorId,
      action: 'hr.absence_type.created',
      entityType: 'absence_type',
      entityId: created.id,
      entityName: created.nameHe,
      description: `Created absence type "${created.nameHe}" (${created.code})`,
    });
    return created;
  }

  async updateAbsenceType(id: number, dto: UpdateAbsenceTypeDto, actorId: number) {
    const existing = await this.prisma.absenceType.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Absence type ${id} not found`);

    const SYSTEM_LOCKED = new Set([
      'code',
      'unit',
      'requiresDocument',
      'deductsFromSick',
      'halfDay',
    ]);

    const data: Prisma.AbsenceTypeUpdateInput = {};
    const stripped: string[] = [];
    for (const k of Object.keys(dto) as (keyof UpdateAbsenceTypeDto)[]) {
      if (existing.isSystem && SYSTEM_LOCKED.has(k as string)) {
        stripped.push(k as string);
        continue;
      }
      (data as any)[k] = dto[k];
    }
    if (stripped.length > 0) {
      this.log.warn(
        `[hr/absence-types] isSystem row ${id} — stripped locked fields: ${stripped.join(', ')}`,
      );
    }
    const updated = await this.prisma.absenceType.update({ where: { id }, data });
    this.writeAudit({
      actorId,
      action: 'hr.absence_type.updated',
      entityType: 'absence_type',
      entityId: id,
      entityName: updated.nameHe,
      description: `Updated absence type "${updated.nameHe}"` +
        (stripped.length ? ` (locked: ${stripped.join(', ')})` : ''),
    });
    return updated;
  }

  async deleteAbsenceType(id: number, actorId: number) {
    const existing = await this.prisma.absenceType.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Absence type ${id} not found`);
    if (existing.isSystem) {
      throw new ConflictException(
        `Absence type "${existing.code}" is a system row — soft-deactivate it via PATCH { active: false }.`,
      );
    }
    await this.prisma.absenceType.update({ where: { id }, data: { active: false } });
    this.writeAudit({
      actorId,
      action: 'hr.absence_type.deactivated',
      entityType: 'absence_type',
      entityId: id,
      entityName: existing.nameHe,
      description: `Deactivated absence type "${existing.nameHe}" (${existing.code})`,
    });
    return { ok: true, id };
  }

  // ═══ AbsenceRecord — per-employee CRUD ══════════════════════════════

  /**
   * Bereavement 1st-degree carries a 7-day span (per spec §3.4). The
   * seeded `code` on AbsenceType is `bereavement_1st_degree`.
   */
  private static readonly BEREAVEMENT_CODE = 'bereavement_1st_degree';

  async listAbsencesForEmployee(
    userId: number,
    opts: { year?: number; typeId?: number } = {},
  ) {
    await this.assertEmployee(userId);
    const where: Prisma.AbsenceRecordWhereInput = { userId };
    if (opts.year != null && Number.isFinite(opts.year)) {
      const start = new Date(opts.year, 0, 1);
      const end = new Date(opts.year + 1, 0, 1);
      where.dateFrom = { gte: start, lt: end };
    }
    if (opts.typeId != null && Number.isFinite(opts.typeId)) {
      where.absenceTypeId = opts.typeId;
    }
    const rows = await this.prisma.absenceRecord.findMany({
      where,
      orderBy: { dateFrom: 'asc' },
      include: {
        absenceType: {
          select: {
            id: true,
            code: true,
            nameHe: true,
            unit: true,
            requiresDocument: true,
            halfDay: true,
          },
        },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        document: { select: { id: true, fileName: true, fileUrl: true, mimeType: true, fileSize: true } },
      },
    });
    return rows.map((r) => ({
      ...r,
      amount: Number(r.amount),
    }));
  }

  async createAbsence(userId: number, dto: CreateAbsenceRecordDto, actorId: number) {
    await this.assertEmployee(userId);
    const type = await this.prisma.absenceType.findUnique({
      where: { id: dto.absenceTypeId },
    });
    if (!type) throw new NotFoundException(`Absence type ${dto.absenceTypeId} not found`);
    if (!type.active) {
      throw new BadRequestException(`Absence type "${type.code}" is inactive`);
    }

    if (type.requiresDocument && dto.documentFileId == null) {
      throw new BadRequestException({
        message: `Absence type "${type.nameHe}" requires an uploaded document.`,
        code: 'HR_ABSENCE_DOCUMENT_REQUIRED',
      });
    }

    const [fy, fm, fd] = dto.dateFrom.split('-').map(Number);
    const dateFrom = new Date(fy, fm - 1, fd);
    let dateTo: Date;

    if (dto.dateTo) {
      const [ty, tm, td] = dto.dateTo.split('-').map(Number);
      dateTo = new Date(ty, tm - 1, td);
    } else {
      dateTo = dateFrom;
    }

    // Bereavement 7-day auto-span (spec §3.4): a missing-or-equal dateTo
    // expands to dateFrom + 6 days (contiguous calendar days inclusive).
    const isSingleDayPayload =
      dateTo.getTime() === dateFrom.getTime();
    if (type.code === HrService.BEREAVEMENT_CODE && isSingleDayPayload) {
      dateTo = new Date(dateFrom);
      dateTo.setDate(dateFrom.getDate() + 6);
    }

    if (dateTo < dateFrom) {
      throw new BadRequestException('dateTo must be on or after dateFrom');
    }

    if (dto.documentFileId != null) {
      await this.assertAttachmentOwnedBy(userId, dto.documentFileId);
    }

    const created = await this.prisma.absenceRecord.create({
      data: {
        userId,
        absenceTypeId: dto.absenceTypeId,
        dateFrom,
        dateTo,
        amount: dto.amount,
        documentFileId: dto.documentFileId ?? null,
        note: dto.note ?? null,
        createdById: actorId,
      },
      include: {
        absenceType: {
          select: { id: true, code: true, nameHe: true, unit: true, requiresDocument: true, halfDay: true },
        },
        document: { select: { id: true, fileName: true, fileUrl: true, mimeType: true, fileSize: true } },
      },
    });

    this.writeAudit({
      actorId,
      action: 'hr.absence.created',
      entityType: 'absence_record',
      entityId: created.id,
      entityName: `${type.nameHe}`,
      description:
        `Logged absence "${type.nameHe}" ${dto.dateFrom}` +
        (dto.dateTo && dto.dateTo !== dto.dateFrom ? ` → ${dto.dateTo}` : '') +
        ` (${dto.amount}${type.unit === 'DAY' ? 'd' : 'h'})` +
        ` for employee ${userId}`,
    });

    return { ...created, amount: Number(created.amount) };
  }

  async updateAbsence(
    userId: number,
    recordId: number,
    dto: UpdateAbsenceRecordDto,
    actorId: number,
  ) {
    const existing = await this.prisma.absenceRecord.findFirst({
      where: { id: recordId, userId },
      include: { absenceType: true },
    });
    if (!existing) throw new NotFoundException(`Absence ${recordId} not found for employee ${userId}`);

    // Resolve absence type: either the override on the patch, or the
    // existing one. We only re-validate requiresDocument against the
    // final (new or kept) type.
    const nextTypeId = dto.absenceTypeId ?? existing.absenceTypeId;
    const nextType =
      dto.absenceTypeId && dto.absenceTypeId !== existing.absenceTypeId
        ? await this.prisma.absenceType.findUnique({ where: { id: nextTypeId } })
        : existing.absenceType;
    if (!nextType) throw new NotFoundException(`Absence type ${nextTypeId} not found`);
    if (!nextType.active) {
      throw new BadRequestException(`Absence type "${nextType.code}" is inactive`);
    }

    const data: Prisma.AbsenceRecordUpdateInput = {};
    if (dto.absenceTypeId) data.absenceType = { connect: { id: dto.absenceTypeId } };
    if (dto.dateFrom) {
      const [y, m, d] = dto.dateFrom.split('-').map(Number);
      data.dateFrom = new Date(y, m - 1, d);
    }
    if (dto.dateTo) {
      const [y, m, d] = dto.dateTo.split('-').map(Number);
      data.dateTo = new Date(y, m - 1, d);
    }
    if (dto.amount != null) data.amount = dto.amount;
    if (dto.note !== undefined) data.note = dto.note ?? null;

    if (dto.documentFileId !== undefined) {
      if (dto.documentFileId == null) {
        if (nextType.requiresDocument) {
          throw new BadRequestException({
            message: `Absence type "${nextType.nameHe}" requires an uploaded document.`,
            code: 'HR_ABSENCE_DOCUMENT_REQUIRED',
          });
        }
        data.document = { disconnect: true };
      } else {
        await this.assertAttachmentOwnedBy(userId, dto.documentFileId);
        data.document = { connect: { id: dto.documentFileId } };
      }
    } else if (
      dto.absenceTypeId &&
      nextType.requiresDocument &&
      existing.documentFileId == null
    ) {
      // Type changed to one that requires a doc, but patch didn't
      // supply one and existing had none — reject so UI prompts.
      throw new BadRequestException({
        message: `Absence type "${nextType.nameHe}" requires an uploaded document.`,
        code: 'HR_ABSENCE_DOCUMENT_REQUIRED',
      });
    }

    const nextStart = (data.dateFrom as Date | undefined) ?? existing.dateFrom;
    const nextEnd = (data.dateTo as Date | undefined) ?? existing.dateTo;
    if (nextEnd < nextStart) {
      throw new BadRequestException('dateTo must be on or after dateFrom');
    }

    const updated = await this.prisma.absenceRecord.update({
      where: { id: recordId },
      data,
      include: {
        absenceType: {
          select: { id: true, code: true, nameHe: true, unit: true, requiresDocument: true, halfDay: true },
        },
        document: { select: { id: true, fileName: true, fileUrl: true, mimeType: true, fileSize: true } },
      },
    });

    this.writeAudit({
      actorId,
      action: 'hr.absence.updated',
      entityType: 'absence_record',
      entityId: recordId,
      entityName: nextType.nameHe,
      description: `Updated absence #${recordId} for employee ${userId}`,
    });

    return { ...updated, amount: Number(updated.amount) };
  }

  async deleteAbsence(userId: number, recordId: number, actorId: number) {
    const existing = await this.prisma.absenceRecord.findFirst({
      where: { id: recordId, userId },
      include: { absenceType: { select: { nameHe: true } } },
    });
    if (!existing) {
      throw new NotFoundException(`Absence ${recordId} not found for employee ${userId}`);
    }
    await this.prisma.absenceRecord.delete({ where: { id: recordId } });
    this.writeAudit({
      actorId,
      action: 'hr.absence.deleted',
      entityType: 'absence_record',
      entityId: recordId,
      entityName: existing.absenceType.nameHe,
      severity: 'warn',
      description:
        `Deleted absence "${existing.absenceType.nameHe}"` +
        ` from ${existing.dateFrom.toISOString().slice(0, 10)}` +
        ` for employee ${userId}`,
    });
    return { ok: true, id: recordId };
  }

  // ═══ EmployeeAttachment — HR document store ═════════════════════════

  async uploadEmployeeAttachment(
    userId: number,
    actorId: number,
    file: Express.Multer.File,
  ) {
    await this.assertEmployee(userId);
    if (!file) throw new BadRequestException('No file provided');

    // Reuse the central FilesService — the 'hr' folder was allow-
    // listed in A1 so the whitelist check passes.
    const { url, originalName } = await this.files.uploadFile(file, 'hr');

    const created = await this.prisma.employeeAttachment.create({
      data: {
        userId,
        fileName: originalName,
        fileUrl: url,
        fileSize: file.size ?? null,
        mimeType: file.mimetype ?? null,
        uploadedBy: actorId,
      },
    });
    this.writeAudit({
      actorId,
      action: 'hr.attachment.uploaded',
      entityType: 'employee_attachment',
      entityId: created.id,
      entityName: originalName,
      description: `Uploaded HR document "${originalName}" for employee ${userId}`,
    });
    return {
      id: created.id,
      url: created.fileUrl,
      fileName: created.fileName,
      fileSize: created.fileSize,
      mimeType: created.mimeType,
      createdAt: created.createdAt,
    };
  }

  async listEmployeeAttachments(userId: number) {
    await this.assertEmployee(userId);
    return this.prisma.employeeAttachment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        uploader: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async deleteEmployeeAttachment(
    userId: number,
    attachmentId: number,
    actorId: number,
  ) {
    const row = await this.prisma.employeeAttachment.findFirst({
      where: { id: attachmentId, userId },
    });
    if (!row) {
      throw new NotFoundException(
        `Attachment ${attachmentId} not found for employee ${userId}`,
      );
    }
    // Nullable FKs on `absence_records.document_file_id` +
    // `employee_bucket_eligibilities.document_file_id` set NULL
    // automatically via `ON DELETE SET NULL` from B1 — nothing extra.
    // TODO: when FilesService adds a `deleteFile(url)` helper, unlink
    // the on-disk blob too; today we leave the file in place
    // (orphaned) and only drop the DB row.
    await this.prisma.employeeAttachment.delete({ where: { id: attachmentId } });
    this.writeAudit({
      actorId,
      action: 'hr.attachment.deleted',
      entityType: 'employee_attachment',
      entityId: attachmentId,
      entityName: row.fileName,
      severity: 'warn',
      description: `Deleted HR document "${row.fileName}" for employee ${userId}`,
    });
    return { ok: true, id: attachmentId };
  }

  // ═══ Employee roster (A3, unchanged shape) ═══════════════════════════

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
    // HR F1 (2026-10-19) — column is NOT NULL + default 8.40. Treat an
    // explicit null from a stale FE as a no-op (don't try to write null).
    // The field stays writable with a real number.
    if ('dailyStandardHours' in dto && dto.dailyStandardHours != null)
      data.dailyStandardHours = dto.dailyStandardHours;
    if ('employmentDate' in dto)
      data.employmentDate = dto.employmentDate ? new Date(dto.employmentDate) : null;
    if ('employmentEndDate' in dto)
      data.employmentEndDate = dto.employmentEndDate
        ? new Date(dto.employmentEndDate)
        : null;

    await this.prisma.user.update({ where: { id }, data });
    return this.getEmployee(id);
  }

  // ═══ Eligibilities (A3, unchanged) ══════════════════════════════════

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

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = dto.startDate ? new Date(dto.startDate) : today;
    const endDate = dto.endDate
      ? new Date(dto.endDate)
      : new Date(today.getFullYear(), 11, 31);
    if (endDate < startDate) {
      throw new BadRequestException('endDate must be on or after startDate');
    }

    const amount =
      dto.dailyAmount ?? (bucket.dailyAmount != null ? Number(bucket.dailyAmount) : null);
    if (amount == null || amount <= 0) {
      throw new BadRequestException(
        `dailyAmount is required for this bucket (bucket "${bucket.code}" has no default; supply one)`,
      );
    }

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

    if (dto.documentFileId != null) {
      await this.assertAttachmentOwnedBy(userId, dto.documentFileId);
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
    if ('documentFileId' in dto) {
      if (dto.documentFileId != null) {
        await this.assertAttachmentOwnedBy(userId, dto.documentFileId);
      }
      data.documentFileId = dto.documentFileId ?? null;
    }
    if ('active' in dto && dto.active != null) data.active = dto.active;

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

  // ═══ Internal helpers ═══════════════════════════════════════════════

  private async assertEmployee(userId: number) {
    const u = await this.prisma.user.findFirst({
      where: { id: userId, userType: 'employee', deletedAt: null },
      select: { id: true },
    });
    if (!u) throw new NotFoundException(`Employee ${userId} not found`);
  }

  /**
   * Guards: an eligibility / absence can only link to a document that
   * was uploaded for the SAME employee. Prevents mis-linking across
   * users (the FE just hands us a numeric id).
   */
  private async assertAttachmentOwnedBy(userId: number, attachmentId: number) {
    const att = await this.prisma.employeeAttachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, userId: true },
    });
    if (!att) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }
    if (att.userId !== userId) {
      throw new BadRequestException(
        `Attachment ${attachmentId} does not belong to employee ${userId}`,
      );
    }
  }

  /**
   * Fire-and-forget audit write. Shares ActivityLogService with every
   * other domain so /admin/activity-logs sees HR events too.
   */
  private writeAudit(params: {
    actorId: number | null;
    action: string;
    entityType: string;
    entityId?: number | null;
    entityName?: string | null;
    description: string;
    severity?: 'info' | 'warn' | 'error' | 'critical';
  }) {
    this.activityLog
      .write({
        category: 'admin',
        action: params.action,
        description: params.description,
        actorUserId: params.actorId ?? null,
        entityType: params.entityType,
        entityId: params.entityId ?? null,
        entityName: params.entityName ?? null,
        severity: params.severity ?? 'info',
      })
      .catch((e) => Sentry.captureException(e));
  }
}
