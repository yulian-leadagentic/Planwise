import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Lightweight in-memory presence tracker. The frontend POSTs a heartbeat
 * every ~20s while a user is on a project page; the backend tracks the
 * (projectId, userId) pair with a `lastSeenAt` timestamp. A scheduled
 * sweep prunes anyone whose last heartbeat is older than 60s — those
 * users are considered "offline" / no longer on the page.
 *
 * Storage is intentionally in-memory only: presence is ephemeral by
 * nature, surviving an API restart isn't useful, and avoiding the DB
 * keeps heartbeat traffic cheap.
 */
type PresenceEntry = { userId: number; lastSeenAt: number };

@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);
  private readonly map = new Map<number, Map<number, PresenceEntry>>();
  private readonly TTL_MS = 60_000;

  /** Record (or refresh) a user's presence on a project. */
  heartbeat(projectId: number, userId: number) {
    if (!this.map.has(projectId)) this.map.set(projectId, new Map());
    this.map.get(projectId)!.set(userId, { userId, lastSeenAt: Date.now() });
  }

  /** Explicit leave — fires on page unmount when the browser sends beacon. */
  leave(projectId: number, userId: number) {
    this.map.get(projectId)?.delete(userId);
  }

  /** Active user IDs on a project (within TTL). */
  activeUserIds(projectId: number): number[] {
    const entries = this.map.get(projectId);
    if (!entries) return [];
    const now = Date.now();
    return Array.from(entries.values())
      .filter((e) => now - e.lastSeenAt <= this.TTL_MS)
      .map((e) => e.userId);
  }

  /** Resolve to user records (firstName/lastName/avatarUrl) so the frontend
   *  can render avatars without a second round-trip. Filters out
   *  deactivated users — they should never appear as "online" even if a
   *  stale browser session is still pinging heartbeats. */
  async listActiveUsers(projectId: number, prisma: PrismaService) {
    const ids = this.activeUserIds(projectId);
    if (ids.length === 0) return [];
    const users = await prisma.user.findMany({
      where: { id: { in: ids }, isActive: true },
      select: { id: true, firstName: true, lastName: true, avatarUrl: true },
    });
    return users;
  }

  /** Prune entries older than TTL. Runs every minute. */
  @Cron(CronExpression.EVERY_MINUTE)
  sweep() {
    const startedAt = Date.now();
    let removed = 0;
    let totalEntries = 0;
    for (const [projectId, entries] of this.map.entries()) {
      for (const [userId, entry] of entries.entries()) {
        totalEntries++;
        if (startedAt - entry.lastSeenAt > this.TTL_MS) {
          entries.delete(userId);
          removed++;
        }
      }
      if (entries.size === 0) this.map.delete(projectId);
    }
    const tookMs = Date.now() - startedAt;
    // Always log: presence sweep is the only EVERY_MINUTE cron we have,
    // so its log line is a useful "API is still healthy" heartbeat. If
    // these lines stop appearing in Railway logs we know the scheduler
    // (or the event loop) has died.
    this.logger.log(
      `cron sweep — entries=${totalEntries} pruned=${removed} tookMs=${tookMs}`,
      'PresenceCron',
    );
  }
}
