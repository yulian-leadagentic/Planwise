import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export type NumberRangeMode = 'auto' | 'manual' | 'external';

export interface UpsertNumberRangeDto {
  code: string;
  name?: string;
  mode?: NumberRangeMode;
  prefix?: string;
  padWidth?: number;
  fromNumber?: number | bigint | string;
  toNumber?: number | bigint | string;
  currentNumber?: number | bigint | string;
  externalPattern?: string | null;
  isActive?: boolean;
  description?: string | null;
}

@Injectable()
export class NumberRangesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const rows = await this.prisma.numberRange.findMany({
      orderBy: [{ code: 'asc' }],
    });
    return rows.map((r) => this.serialize(r));
  }

  async findOne(id: number) {
    const row = await this.prisma.numberRange.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Number range not found');
    return this.serialize(row);
  }

  async findByCode(code: string) {
    const row = await this.prisma.numberRange.findUnique({ where: { code } });
    if (!row) return null;
    return this.serialize(row);
  }

  async create(dto: UpsertNumberRangeDto) {
    if (!dto.code?.trim()) {
      throw new BadRequestException('code is required');
    }
    const mode = (dto.mode ?? 'auto') as NumberRangeMode;
    if (!['auto', 'manual', 'external'].includes(mode)) {
      throw new BadRequestException(`Invalid mode "${dto.mode}"`);
    }
    try {
      const created = await this.prisma.numberRange.create({
        data: {
          code: dto.code.trim().toUpperCase(),
          name: dto.name?.trim() || null,
          mode,
          prefix: dto.prefix ?? '',
          padWidth: dto.padWidth ?? 8,
          fromNumber: BigInt(dto.fromNumber ?? 1),
          toNumber: BigInt(dto.toNumber ?? 99999999),
          currentNumber: BigInt(dto.currentNumber ?? 0),
          externalPattern: dto.externalPattern ?? null,
          isActive: dto.isActive ?? true,
          description: dto.description ?? null,
        },
      });
      return this.serialize(created);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Number range "${dto.code}" already exists`);
      }
      throw e;
    }
  }

  async update(id: number, dto: Partial<UpsertNumberRangeDto>) {
    const existing = await this.prisma.numberRange.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Number range not found');

    // currentNumber may only move forward — protects already-issued codes
    // from being re-handed-out.
    if (dto.currentNumber !== undefined) {
      const next = BigInt(dto.currentNumber);
      if (next < existing.currentNumber) {
        throw new BadRequestException(
          'currentNumber cannot move backward (already-issued codes would collide)',
        );
      }
    }
    if (dto.mode && !['auto', 'manual', 'external'].includes(dto.mode)) {
      throw new BadRequestException(`Invalid mode "${dto.mode}"`);
    }

    const updated = await this.prisma.numberRange.update({
      where: { id },
      data: {
        // `code` is intentionally immutable — other tables reference it.
        // If renaming is ever needed, add a separate rename endpoint with
        // ON UPDATE CASCADE on the FKs (entity_kinds already has it).
        name: dto.name === undefined ? undefined : (dto.name?.trim() || null),
        mode: dto.mode,
        prefix: dto.prefix ?? undefined,
        padWidth: dto.padWidth ?? undefined,
        fromNumber: dto.fromNumber !== undefined ? BigInt(dto.fromNumber) : undefined,
        toNumber: dto.toNumber !== undefined ? BigInt(dto.toNumber) : undefined,
        currentNumber:
          dto.currentNumber !== undefined ? BigInt(dto.currentNumber) : undefined,
        externalPattern: dto.externalPattern === undefined ? undefined : (dto.externalPattern || null),
        isActive: dto.isActive ?? undefined,
        description: dto.description === undefined ? undefined : (dto.description ?? null),
      },
    });
    return this.serialize(updated);
  }

  async remove(id: number) {
    await this.prisma.numberRange.delete({ where: { id } });
    return { message: 'Number range deleted' };
  }

  /**
   * Atomically allocate the next code for the given range (by code).
   * Only valid for mode='auto'. Throws for manual/external/exhausted/disabled.
   * Safe to call inside another transaction.
   */
  async next(code: string): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      // SELECT ... FOR UPDATE serialises concurrent allocations.
      const rows = await tx.$queryRaw<
        Array<{
          id: number;
          mode: string;
          prefix: string;
          pad_width: number;
          from_number: bigint;
          to_number: bigint;
          current_number: bigint;
          is_active: number;
        }>
      >(Prisma.sql`
        SELECT id, mode, prefix, pad_width, from_number, to_number, current_number, is_active
          FROM number_ranges
          WHERE code = ${code}
          FOR UPDATE
      `);

      const row = rows[0];
      if (!row) {
        throw new NotFoundException(`Number range "${code}" not configured`);
      }
      if (!row.is_active) {
        throw new BadRequestException(`Number range "${code}" is disabled`);
      }
      if (row.mode !== 'auto') {
        throw new BadRequestException(
          `Number range "${code}" is in ${row.mode} mode — caller must provide the code instead of allocating`,
        );
      }

      const candidate = row.current_number + 1n;
      const lower = row.from_number;
      const upper = row.to_number;
      const next = candidate < lower ? lower : candidate;
      if (next > upper) {
        throw new BadRequestException(`Number range "${code}" exhausted`);
      }

      await tx.$executeRaw(Prisma.sql`
        UPDATE number_ranges
          SET current_number = ${next}, updated_at = CURRENT_TIMESTAMP(3)
          WHERE id = ${row.id}
      `);

      return this.format(row.prefix, row.pad_width, next);
    });
  }

  /** Preview next code without consuming. Returns null for manual/external. */
  async peek(code: string) {
    const row = await this.prisma.numberRange.findUnique({ where: { code } });
    if (!row) return null;
    if (row.mode !== 'auto') return null;
    const next = row.currentNumber + 1n;
    const candidate = next < row.fromNumber ? row.fromNumber : next;
    if (candidate > row.toNumber) return null;
    return this.format(row.prefix, row.padWidth, candidate);
  }

  /**
   * Validate a user-supplied code against a range's pattern. Used in
   * manual/external mode at entity-create time. Throws on mismatch.
   */
  async validateManual(code: string, candidate: string) {
    const row = await this.prisma.numberRange.findUnique({ where: { code } });
    if (!row) {
      throw new NotFoundException(`Number range "${code}" not configured`);
    }
    if (row.mode === 'auto') {
      throw new BadRequestException(
        `Number range "${code}" is auto — callers should not pass a manual code`,
      );
    }
    if (row.externalPattern) {
      const re = new RegExp(row.externalPattern);
      if (!re.test(candidate)) {
        throw new BadRequestException(
          `Code "${candidate}" does not match the pattern for range "${code}" (${row.externalPattern})`,
        );
      }
    }
    return candidate;
  }

  private format(prefix: string, padWidth: number, value: bigint): string {
    return `${prefix}${value.toString().padStart(padWidth, '0')}`;
  }

  // BigInt isn't JSON-serialisable. The HTTP layer needs strings.
  private serialize(row: {
    id: number;
    code: string;
    name: string | null;
    mode: string;
    prefix: string;
    padWidth: number;
    fromNumber: bigint;
    toNumber: bigint;
    currentNumber: bigint;
    externalPattern: string | null;
    isActive: boolean;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      mode: row.mode,
      prefix: row.prefix,
      padWidth: row.padWidth,
      fromNumber: row.fromNumber.toString(),
      toNumber: row.toNumber.toString(),
      currentNumber: row.currentNumber.toString(),
      externalPattern: row.externalPattern,
      isActive: row.isActive,
      description: row.description,
      preview:
        row.mode === 'auto'
          ? this.format(row.prefix, row.padWidth, row.currentNumber + 1n)
          : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
