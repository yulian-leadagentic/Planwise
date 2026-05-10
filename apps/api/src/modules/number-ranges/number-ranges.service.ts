import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export interface UpsertNumberRangeDto {
  objectCode: string;
  rangeName?: string;
  prefix?: string;
  padWidth?: number;
  fromNumber?: number | bigint;
  toNumber?: number | bigint;
  currentNumber?: number | bigint;
  isActive?: boolean;
  description?: string | null;
}

@Injectable()
export class NumberRangesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const rows = await this.prisma.numberRange.findMany({
      orderBy: [{ objectCode: 'asc' }, { rangeName: 'asc' }],
    });
    return rows.map(this.serialize);
  }

  async findOne(id: number) {
    const row = await this.prisma.numberRange.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Number range not found');
    return this.serialize(row);
  }

  async create(dto: UpsertNumberRangeDto) {
    if (!dto.objectCode?.trim()) {
      throw new BadRequestException('objectCode is required');
    }
    try {
      const created = await this.prisma.numberRange.create({
        data: {
          objectCode: dto.objectCode.trim(),
          rangeName: dto.rangeName?.trim() || 'default',
          prefix: dto.prefix ?? '',
          padWidth: dto.padWidth ?? 8,
          fromNumber: BigInt(dto.fromNumber ?? 1),
          toNumber: BigInt(dto.toNumber ?? 99999999),
          currentNumber: BigInt(dto.currentNumber ?? 0),
          isActive: dto.isActive ?? true,
          description: dto.description ?? null,
        },
      });
      return this.serialize(created);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          `Number range (${dto.objectCode}, ${dto.rangeName ?? 'default'}) already exists`,
        );
      }
      throw e;
    }
  }

  async update(id: number, dto: Partial<UpsertNumberRangeDto>) {
    const existing = await this.prisma.numberRange.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Number range not found');

    // Guard: currentNumber may only move forward, never backward — protects
    // already-issued codes from being re-handed-out.
    if (dto.currentNumber !== undefined) {
      const next = BigInt(dto.currentNumber);
      if (next < existing.currentNumber) {
        throw new BadRequestException(
          'currentNumber cannot move backward (already-issued codes would collide)',
        );
      }
    }

    const updated = await this.prisma.numberRange.update({
      where: { id },
      data: {
        prefix: dto.prefix ?? undefined,
        padWidth: dto.padWidth ?? undefined,
        fromNumber: dto.fromNumber !== undefined ? BigInt(dto.fromNumber) : undefined,
        toNumber: dto.toNumber !== undefined ? BigInt(dto.toNumber) : undefined,
        currentNumber:
          dto.currentNumber !== undefined ? BigInt(dto.currentNumber) : undefined,
        isActive: dto.isActive ?? undefined,
        description: dto.description === undefined ? undefined : dto.description,
      },
    });
    return this.serialize(updated);
  }

  async remove(id: number) {
    await this.prisma.numberRange.delete({ where: { id } });
    return { message: 'Number range deleted' };
  }

  /**
   * Atomically allocate the next code for an object. Locks the range row,
   * increments `current_number`, and returns the formatted code (e.g.
   * "00000001" or "EMP-00000001"). Throws if the range is exhausted or
   * disabled. Safe to call inside another transaction.
   */
  async next(objectCode: string, rangeName = 'default'): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      // Row-lock the matching range. MySQL: SELECT ... FOR UPDATE serialises
      // concurrent allocations so two callers can't collide on the same number.
      const rows = await tx.$queryRaw<
        Array<{
          id: number;
          prefix: string;
          pad_width: number;
          from_number: bigint;
          to_number: bigint;
          current_number: bigint;
          is_active: number;
        }>
      >(Prisma.sql`
        SELECT id, prefix, pad_width, from_number, to_number, current_number, is_active
          FROM number_ranges
          WHERE object_code = ${objectCode} AND range_name = ${rangeName}
          FOR UPDATE
      `);

      const row = rows[0];
      if (!row) {
        throw new NotFoundException(
          `Number range not configured for (${objectCode}, ${rangeName})`,
        );
      }
      if (!row.is_active) {
        throw new BadRequestException(
          `Number range (${objectCode}, ${rangeName}) is disabled`,
        );
      }

      const candidate = row.current_number + 1n;
      const lower = row.from_number;
      const upper = row.to_number;
      const next = candidate < lower ? lower : candidate;
      if (next > upper) {
        throw new BadRequestException(
          `Number range (${objectCode}, ${rangeName}) exhausted`,
        );
      }

      await tx.$executeRaw(Prisma.sql`
        UPDATE number_ranges
          SET current_number = ${next}, updated_at = CURRENT_TIMESTAMP(3)
          WHERE id = ${row.id}
      `);

      return this.format(row.prefix, row.pad_width, next);
    });
  }

  /**
   * Preview what the next code would look like without consuming a number.
   * Read-only; no row lock.
   */
  async peek(objectCode: string, rangeName = 'default') {
    const row = await this.prisma.numberRange.findUnique({
      where: { objectCode_rangeName: { objectCode, rangeName } },
    });
    if (!row) return null;
    const next = row.currentNumber + 1n;
    const candidate = next < row.fromNumber ? row.fromNumber : next;
    if (candidate > row.toNumber) return null;
    return this.format(row.prefix, row.padWidth, candidate);
  }

  private format(prefix: string, padWidth: number, value: bigint): string {
    return `${prefix}${value.toString().padStart(padWidth, '0')}`;
  }

  // BigInt isn't JSON-serialisable by default. The HTTP layer needs strings.
  private serialize(row: {
    id: number;
    objectCode: string;
    rangeName: string;
    prefix: string;
    padWidth: number;
    fromNumber: bigint;
    toNumber: bigint;
    currentNumber: bigint;
    isActive: boolean;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      objectCode: row.objectCode,
      rangeName: row.rangeName,
      prefix: row.prefix,
      padWidth: row.padWidth,
      fromNumber: row.fromNumber.toString(),
      toNumber: row.toNumber.toString(),
      currentNumber: row.currentNumber.toString(),
      isActive: row.isActive,
      description: row.description,
      preview: this.format(row.prefix, row.padWidth, row.currentNumber + 1n),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
