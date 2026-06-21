/**
 * Periodic vitals logger.
 *
 * Why this exists: the API has wedged multiple times in production where
 * every request returns 0 bytes (HTTP listener stuck), CPU sits at ~1 vCPU
 * with no traffic, and the request logs go silent. Without per-second
 * resource visibility the post-mortem is "logs stopped at HH:MM:SS" — no
 * way to tell which subsystem hit the wall.
 *
 * This logger emits a single JSON line every 30s with:
 *   - elu       — event loop utilization fraction (0-1). Sustained >0.9
 *                 means the loop is CPU-bound, can't process new I/O.
 *   - lagMs     — synchronous block-on-loop in ms. >100ms = something
 *                 ran sync work that long.
 *   - heapMb    — current heap allocation. Growth over time = leak.
 *   - rssMb     — total process memory. Sudden jumps = burst allocations.
 *   - handles   — active libuv handles (timers, sockets, etc.). Growth
 *                 without a ceiling = handle leak.
 *   - sockets   — active TCP sockets. WebSocket leak surfaces here.
 *
 * The line is intentionally JSON so a future ingestor can parse it; we
 * also log it as a normal info line so it shows up in Railway logs
 * without any extra plumbing.
 */
import { Logger } from 'nestjs-pino';
import { performance, monitorEventLoopDelay } from 'perf_hooks';
import {
  getInFlightRequestCount,
  getLastSlowRoute,
} from './interceptors/slow-request.interceptor';

// eventLoopUtilization is a method on performance, not a named export.
// Some @types/node versions don't expose it on perf_hooks at all; access
// it through performance with a typed alias to keep the call sites clean.
const elu = (performance as any).eventLoopUtilization as (
  prev?: any,
  next?: any,
) => { idle: number; active: number; utilization: number };

const TICK_MS = 30_000;

export function startVitalsLogger(logger: Logger): void {
  // monitorEventLoopDelay samples the loop at high resolution and tracks
  // a histogram. We read+reset every tick to get the worst-case lag in
  // the last 30s — that's what reveals sync work blocking the loop.
  const histogram = monitorEventLoopDelay({ resolution: 50 });
  histogram.enable();

  let lastELU = elu();

  const tick = () => {
    try {
      const mem = process.memoryUsage();
      const eluNow = elu();
      const eluDelta = elu(eluNow, lastELU);
      lastELU = eluNow;
      const maxLagMs = Number((histogram.max / 1e6).toFixed(1));
      const handles = (process as any)._getActiveHandles?.().length ?? -1;
      const sockets = (process as any)._getActiveHandles?.()
        ?.filter((h: any) => h?.constructor?.name === 'Socket').length ?? -1;
      const inFlight = getInFlightRequestCount();
      const lastSlow = getLastSlowRoute();
      const slowSuffix = lastSlow ? ` lastSlow="${lastSlow}"` : '';

      // Pino picks up the second-arg object as structured fields, so we
      // get both a human line in Railway and parseable JSON in Datadog
      // (or wherever we point logs later).
      logger.log(
        `vitals elu=${eluDelta.utilization.toFixed(2)} lagMs=${maxLagMs} heapMb=${(mem.heapUsed / 1024 / 1024).toFixed(0)} rssMb=${(mem.rss / 1024 / 1024).toFixed(0)} handles=${handles} sockets=${sockets} inFlight=${inFlight}${slowSuffix}`,
        'Vitals',
      );

      histogram.reset();
    } catch {
      // Never let the logger itself crash the process.
    }
  };

  // First tick after 30s so boot churn doesn't show up as anomaly.
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS).unref();
  }, TICK_MS).unref();
}
