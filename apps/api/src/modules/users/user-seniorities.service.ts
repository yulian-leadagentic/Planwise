/**
 * Date-effective seniority history per user.
 *
 * The project labor-cost calculation needs to know which seniority
 * level was active for a user on the date the work was logged — not
 * the user's current seniority. That accuracy matters when an
 * employee gets promoted mid-project: hours logged before the
 * promotion should bill at the old rate, hours after at the new rate.
 *
 * The history is a chain of [startDate, endDate] intervals per user.
 * Constraints (enforced here, not in the DB):
 *   1. startDate < endDate when both set
 *   2. No interval overlaps another for the same user
 *   3. At most one open-ended (endDate=NULL) interval per user
 *   4. The legacy users.seniority_level_id column is kept in sync —
 *      always = the current open-ended row's level, or the most
 *      recent closed row's level if none is open.
 *
 * Read API:
 *   - listForUser(userId)         → full history (newest first)
 *   - getEffectiveAt(userId, date) → SeniorityLevel active on `date`
 *
 * Write API:
 *   - addEntry(userId, dto)       → also closes the previous open row
 *                                  at startDate-1 when adding a new
 *                                  open-ended one (the "promotion" flow)
 *   - updateEntry(id, dto)
 *   - removeEntry(id)
 *
 * All writes call syncUserSeniorityLevel() at the end so the legacy
 * convenience column stays correct.
 */

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface AddSeniorityEntryDto {
  seniorityLevelId: number;
  /** YYYY-MM-DD */
  startDate: string;
  /** YYYY-MM-DD, optional (open-ended when omitted) */
  endDate?: string | null;
  notes?: string;
}

export interface UpdateSeniorityEntryDto {
  seniorityLevelId?: number;
  startDate?: string;
  endDate?: string | null;
  notes?: string | null;
}

/** Parse YYYY-MM-DD into a Date pinned to UTC midnight so DATE-typed
 *  columns round-trip without timezone drift. */
function parseDate(s: string): Date {
  // The string is treated as local-time then nudged to UTC midnight,
  // matching how Prisma stores @db.Date.
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Add days to a Date, returning a new Date. */
function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

@Injectable()
export class UserSenioritiesService {
  constructor(private prisma: PrismaService) {}

  /** Full history for a user, newest startDate first. */
  async listForUser(userId: number) {
    await this.assertUser(userId);
    return this.prisma.userSeniority.findMany({
      where: { userId },
      include: { seniorityLevel: { select: { id: true, code: true, name: true, defaultHourlyCost: true, currency: true } } },
      orderBy: { startDate: 'desc' },
    });
  }

  /**
   * Resolve the seniority level that was active for `userId` on `date`
   * (a Date or YYYY-MM-DD string). Returns the linked SeniorityLevel
   * record, or null when the user has no history covering that date.
   *
   * Used by the cost calculation paths — one row of TimeEntry → one
   * lookup against this. Cheap because the index on
   * (user_id, start_date) lets MySQL satisfy each query with a few
   * page reads.
   */
  async getEffectiveAt(userId: number, date: Date | string): Promise<{
    id: number;
    code: string;
    name: string;
    defaultHourlyCost: any;
    currency: string | null;
  } | null> {
    const target = typeof date === 'string' ? parseDate(date) : date;
    const row = await this.prisma.userSeniority.findFirst({
      where: {
        userId,
        startDate: { lte: target },
        OR: [{ endDate: null }, { endDate: { gte: target } }],
      },
      include: { seniorityLevel: { select: { id: true, code: true, name: true, defaultHourlyCost: true, currency: true } } },
      orderBy: { startDate: 'desc' },
    });
    return row?.seniorityLevel ?? null;
  }

  /**
   * Add a new entry. When `endDate` is omitted (open-ended = promotion
   * flow), the previously open row is automatically closed at the new
   * row's startDate minus one day. When `endDate` is set, the new row
   * is a closed historical entry and no auto-close happens — admins
   * use that path to add a missed historical entry.
   */
  async addEntry(userId: number, dto: AddSeniorityEntryDto) {
    await this.assertUser(userId);
    await this.assertLevel(dto.seniorityLevelId);

    const startDate = parseDate(dto.startDate);
    const endDate = dto.endDate ? parseDate(dto.endDate) : null;

    if (endDate && endDate < startDate) {
      throw new BadRequestException('End date must be on or after start date.');
    }

    const existing = await this.prisma.userSeniority.findMany({
      where: { userId },
      orderBy: { startDate: 'asc' },
    });

    // No two intervals may overlap. Treat NULL endDate as far-future.
    for (const row of existing) {
      const a = row.startDate;
      const b = row.endDate ?? new Date(8.64e15); // far future
      const newA = startDate;
      const newB = endDate ?? new Date(8.64e15);
      if (newA <= b && newB >= a) {
        throw new BadRequestException(
          `Date range overlaps an existing entry (id=${row.id}, ${row.startDate.toISOString().slice(0, 10)} → ${row.endDate?.toISOString().slice(0, 10) ?? 'current'}).`,
        );
      }
    }

    // Open-ended add → close any currently-open row at startDate-1
    // (the chain stays contiguous: prev ends the day before new starts).
    if (!endDate) {
      const open = existing.find((r) => r.endDate === null);
      if (open) {
        const newClose = addDays(startDate, -1);
        if (newClose < open.startDate) {
          throw new BadRequestException(
            `New start date (${dto.startDate}) is before the open-ended row's start (${open.startDate.toISOString().slice(0, 10)}). Pick a later date or edit the existing row first.`,
          );
        }
        await this.prisma.userSeniority.update({
          where: { id: open.id },
          data: { endDate: newClose },
        });
      }
    }

    const created = await this.prisma.userSeniority.create({
      data: {
        userId,
        seniorityLevelId: dto.seniorityLevelId,
        startDate,
        endDate,
        notes: dto.notes ?? null,
      },
      include: { seniorityLevel: true },
    });

    await this.syncUserSeniorityLevel(userId);
    return created;
  }

  async updateEntry(id: number, dto: UpdateSeniorityEntryDto) {
    const row = await this.prisma.userSeniority.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Seniority entry not found.');

    const next = {
      seniorityLevelId: dto.seniorityLevelId ?? row.seniorityLevelId,
      startDate: dto.startDate ? parseDate(dto.startDate) : row.startDate,
      endDate:
        dto.endDate === undefined
          ? row.endDate
          : dto.endDate === null
            ? null
            : parseDate(dto.endDate),
      notes: dto.notes === undefined ? row.notes : dto.notes,
    };

    if (next.endDate && next.endDate < next.startDate) {
      throw new BadRequestException('End date must be on or after start date.');
    }

    if (next.seniorityLevelId !== row.seniorityLevelId) {
      await this.assertLevel(next.seniorityLevelId);
    }

    // Overlap check against OTHER rows for the same user.
    const others = await this.prisma.userSeniority.findMany({
      where: { userId: row.userId, id: { not: id } },
    });
    for (const o of others) {
      const a = o.startDate;
      const b = o.endDate ?? new Date(8.64e15);
      const newA = next.startDate;
      const newB = next.endDate ?? new Date(8.64e15);
      if (newA <= b && newB >= a) {
        throw new BadRequestException(
          `Date range overlaps an existing entry (id=${o.id}, ${o.startDate.toISOString().slice(0, 10)} → ${o.endDate?.toISOString().slice(0, 10) ?? 'current'}).`,
        );
      }
    }

    const updated = await this.prisma.userSeniority.update({
      where: { id },
      data: next,
      include: { seniorityLevel: true },
    });

    await this.syncUserSeniorityLevel(row.userId);
    return updated;
  }

  async removeEntry(id: number) {
    const row = await this.prisma.userSeniority.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Seniority entry not found.');
    await this.prisma.userSeniority.delete({ where: { id } });
    await this.syncUserSeniorityLevel(row.userId);
    return { message: 'Seniority entry removed.' };
  }

  // ─────────────────────────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────────────────────────

  private async assertUser(userId: number) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!u) throw new NotFoundException(`User ${userId} not found.`);
  }

  private async assertLevel(levelId: number) {
    const l = await this.prisma.seniorityLevel.findUnique({ where: { id: levelId }, select: { id: true } });
    if (!l) throw new NotFoundException(`Seniority level ${levelId} not found.`);
  }

  /**
   * Refresh users.seniority_level_id from the history so the legacy
   * read paths (employee table column, edit form preview, etc.) stay
   * correct. The "current" level = the row with endDate=NULL; if no
   * row is open, falls back to the latest-ending closed row; if no
   * history exists, sets to NULL.
   */
  private async syncUserSeniorityLevel(userId: number) {
    const open = await this.prisma.userSeniority.findFirst({
      where: { userId, endDate: null },
      orderBy: { startDate: 'desc' },
    });
    const target =
      open
        ? open.seniorityLevelId
        : (await this.prisma.userSeniority.findFirst({
            where: { userId },
            orderBy: { endDate: 'desc' },
          }))?.seniorityLevelId ?? null;

    await this.prisma.user.update({
      where: { id: userId },
      data: { seniorityLevelId: target },
    });
  }
}
