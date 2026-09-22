/**
 * Per-request query timeout guard — QA3 Wave-1 Commit 2 · load-path defense.
 *
 * Why (deep-dive §6): "harden the load path so one bad project can never
 * stall the loop — bounded/defensive includes, timeouts on hot queries, and
 * a query that returns a clean error instead of hanging." The integrity
 * scan cleared migrated projects of data corruption, but wedges still
 * happen with an unknown root cause. This is the containment side of the
 * fix: even if a single query eventually gets stuck (Prisma bug, DB
 * lock, network stall), the request rejects cleanly and the calling
 * client sees a 503 instead of a 30s hang that stacks up event-loop
 * pressure.
 *
 * Mechanism: `Promise.race` between the actual query and a rejection
 * timer. On timeout the caller sees `ServiceUnavailableException` (Nest
 * maps it to 503 through the global HttpExceptionFilter, no custom
 * mapping needed).
 *
 * Caveats you should know before adding this everywhere:
 *  * The underlying MySQL query keeps running in the connection until
 *    it completes or the driver notices the client abandoned. That
 *    means a repeated timeout pattern will hold connections in the
 *    Prisma pool until they naturally return. This is a first-pass
 *    guard against event-loop stall; a MySQL-side `MAX_EXECUTION_TIME`
 *    hint would be a follow-up if we start seeing connection-pool
 *    exhaustion in the vitals.
 *  * The `SlowRequestInterceptor` still logs "STILL IN FLIGHT" at 2s
 *    and the socket-level `requestTimeout` (main.ts) still fires at
 *    45s — this sits in the middle for the specific class of "one
 *    query hung, the rest of the request would return fine."
 *
 * Tunable: 10s. Well above p99 for the endpoints this currently guards
 * (planning-data: ~50-500ms in normal cases, up to a few seconds on a
 * project with hundreds of tasks and dozens of zones). Well below the
 * 45s socket timeout so the guard rejects cleanly BEFORE the http
 * server layer forces a 502. Override per-call via the second argument
 * if a particular endpoint needs more or less headroom.
 */
import { ServiceUnavailableException } from '@nestjs/common';

export const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

export async function withQueryTimeout<T>(
  fn: () => Promise<T>,
  ms: number = DEFAULT_QUERY_TIMEOUT_MS,
  label = 'query',
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ServiceUnavailableException(
              `${label} exceeded ${ms}ms — returning 503 to prevent loop stall`,
            ),
          );
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
