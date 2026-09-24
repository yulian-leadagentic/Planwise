import type { PrismaService } from '../../prisma/prisma.service';

// QA3 item 1 (2026-09-24) — one place that resolves "what does user U's
// hour on date D cost?".  Three surfaces in projects.service.ts
// (list rollup, computeProjectActualCost, getLaborCost) all share this
// helper so their semantics can never drift.
//
// Resolution order (per time entry at date D, user U):
//   1. UserRate covering D  ── per-employee override (global across projects)
//   2. SeniorityRate for L covering D, where L = UserSeniority.effectiveAt(U,D)
//   3. SeniorityLevel.defaultHourlyCost as the rollout-era fallback
//   4. else: unrateable — hours still count, cost skipped
//
// Currency: when the winning source has a null currency we fall back to
// the level's currency, then to 'UNK' so the per-currency rollup can
// flag the data gap without dropping the row.

export interface ResolvedRate {
  hourlyCost: number;
  currency: string;
  seniorityLevel: { id: number; name: string } | null;
  /** Which layer supplied the rate — used by /getLaborCost to explain
   *  the number to admins (e.g. "override" vs "level rate"). */
  source: 'user_override' | 'level_rate_history' | 'level_default';
}

export interface ResolveFailure {
  kind: 'no_seniority' | 'no_rate';
  seniorityLevel: { id: number; name: string } | null;
}

export type ResolveOutcome = ResolvedRate | ResolveFailure;

export function isRateableOutcome(o: ResolveOutcome): o is ResolvedRate {
  return (o as ResolvedRate).hourlyCost !== undefined;
}

interface EffectiveRow<T> {
  startDate: Date;
  endDate: Date | null;
  value: T;
}

function firstCovering<T>(list: EffectiveRow<T>[] | undefined, date: Date): T | null {
  if (!list || list.length === 0) return null;
  // list is sorted DESC by startDate; first row whose window covers
  // `date` wins. Both bounds are inclusive on startDate; endDate=null
  // means open-ended.
  for (const row of list) {
    if (row.startDate <= date && (row.endDate === null || row.endDate >= date)) {
      return row.value;
    }
  }
  return null;
}

interface LevelSnapshot {
  id: number;
  name: string;
  defaultHourlyCost: number | null;
  currency: string | null;
}

export interface CostRateResolver {
  resolve(userId: number, date: Date): ResolveOutcome;
}

/** Preload all rate + seniority history for the given users in ONE
 *  round trip each and return a resolver bound to that snapshot. Callers
 *  build the resolver once per request and reuse it inside the
 *  per-entry loop. */
export async function buildCostRateResolver(
  prisma: PrismaService,
  userIds: number[],
): Promise<CostRateResolver> {
  if (userIds.length === 0) {
    return { resolve: () => ({ kind: 'no_seniority', seniorityLevel: null }) };
  }

  // Preload every contributor's seniority history plus each level's
  // rate history + defaults in one pass. Kept flat + Map-indexed so the
  // per-entry hot loop is pure in-memory lookup.
  const seniorityRows = await prisma.userSeniority.findMany({
    where: { userId: { in: userIds } },
    include: {
      seniorityLevel: {
        select: { id: true, name: true, defaultHourlyCost: true, currency: true },
      },
    },
    orderBy: { startDate: 'desc' },
  });

  const seniorityByUser = new Map<number, EffectiveRow<LevelSnapshot>[]>();
  const levelIds = new Set<number>();
  for (const row of seniorityRows) {
    levelIds.add(row.seniorityLevelId);
    const level: LevelSnapshot = {
      id: row.seniorityLevel.id,
      name: row.seniorityLevel.name,
      defaultHourlyCost:
        row.seniorityLevel.defaultHourlyCost == null
          ? null
          : Number(row.seniorityLevel.defaultHourlyCost),
      currency: row.seniorityLevel.currency,
    };
    const arr = seniorityByUser.get(row.userId) ?? [];
    arr.push({ startDate: row.startDate, endDate: row.endDate, value: level });
    seniorityByUser.set(row.userId, arr);
  }

  interface RateRow {
    hourlyCost: number;
    currency: string | null;
  }

  const [seniorityRates, userRates] = await Promise.all([
    levelIds.size === 0
      ? Promise.resolve([] as Array<{ seniorityLevelId: number; hourlyCost: any; currency: string | null; startDate: Date; endDate: Date | null }>)
      : prisma.seniorityRate.findMany({
          where: { seniorityLevelId: { in: Array.from(levelIds) } },
          orderBy: { startDate: 'desc' },
        }),
    prisma.userRate.findMany({
      where: { userId: { in: userIds } },
      orderBy: { startDate: 'desc' },
    }),
  ]);

  const seniorityRatesByLevel = new Map<number, EffectiveRow<RateRow>[]>();
  for (const r of seniorityRates) {
    const arr = seniorityRatesByLevel.get(r.seniorityLevelId) ?? [];
    arr.push({
      startDate: r.startDate,
      endDate: r.endDate,
      value: { hourlyCost: Number(r.hourlyCost), currency: r.currency },
    });
    seniorityRatesByLevel.set(r.seniorityLevelId, arr);
  }

  const userRatesByUser = new Map<number, EffectiveRow<RateRow>[]>();
  for (const r of userRates) {
    const arr = userRatesByUser.get(r.userId) ?? [];
    arr.push({
      startDate: r.startDate,
      endDate: r.endDate,
      value: { hourlyCost: Number(r.hourlyCost), currency: r.currency },
    });
    userRatesByUser.set(r.userId, arr);
  }

  return {
    resolve(userId: number, date: Date): ResolveOutcome {
      const level = firstCovering(seniorityByUser.get(userId), date);
      const levelSummary = level ? { id: level.id, name: level.name } : null;

      // Layer 1 — per-employee override
      const userRate = firstCovering(userRatesByUser.get(userId), date);
      if (userRate) {
        return {
          hourlyCost: userRate.hourlyCost,
          currency: userRate.currency || level?.currency || 'UNK',
          seniorityLevel: levelSummary,
          source: 'user_override',
        };
      }

      if (!level) return { kind: 'no_seniority', seniorityLevel: null };

      // Layer 2 — level rate history
      const levelRate = firstCovering(seniorityRatesByLevel.get(level.id), date);
      if (levelRate) {
        return {
          hourlyCost: levelRate.hourlyCost,
          currency: levelRate.currency || level.currency || 'UNK',
          seniorityLevel: levelSummary,
          source: 'level_rate_history',
        };
      }

      // Layer 3 — legacy fallback
      if (level.defaultHourlyCost != null) {
        return {
          hourlyCost: level.defaultHourlyCost,
          currency: level.currency || 'UNK',
          seniorityLevel: levelSummary,
          source: 'level_default',
        };
      }

      return { kind: 'no_rate', seniorityLevel: levelSummary };
    },
  };
}
