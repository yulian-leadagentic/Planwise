import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * Generic per-user key/value preference store (QA5 UI-13).
 *
 * The service NEVER interprets the JSON blob — the feature that owns
 * a key owns the shape. Reads return `null` when nothing is set so the
 * caller can fall back to a feature-local default.
 */
@Injectable()
export class UserPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read one preference. Returns `null` when the user has no row for
   * that key — the caller treats that as "use the feature default".
   */
  async get(userId: number, key: string): Promise<Prisma.JsonValue | null> {
    const row = await this.prisma.userPreference.findUnique({
      where: { userId_key: { userId, key } },
      select: { value: true },
    });
    return row?.value ?? null;
  }

  /**
   * Write / overwrite the whole blob for a (userId, key). Upserts so
   * the first write doesn't need a separate "create" path, which is
   * what the FE's debounced PUT depends on.
   */
  async set(userId: number, key: string, value: Prisma.InputJsonValue) {
    await this.prisma.userPreference.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, value },
      update: { value },
    });
    return { success: true as const };
  }
}
