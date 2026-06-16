/**
 * Process watchdog.
 *
 * Background: on 2026-06-10 we hit a production wedge where the API container
 * stayed alive (memory steady, CPU ~1 vCPU) but the HTTP listener stopped
 * completing requests. Restart fixed it but only manually. Railway's external
 * healthcheck handles the deploy-time path; this watchdog covers the runtime
 * path: if our OWN HTTP listener stops responding to its OWN liveness probe,
 * something is wedged — exit(1) so Railway's restartPolicy=ON_FAILURE kicks in.
 *
 * Why self-probe instead of just listening to an external healthcheck?
 * Belt-and-suspenders. Railway's runtime healthcheck behavior varies by plan
 * and has been inconsistent in our experience. A self-probe always runs.
 *
 * Tuning:
 *  - probe every 30s
 *  - timeout each probe at 10s
 *  - allow 3 consecutive failures before exit (so a transient 30s burst doesn't
 *    cause spurious restarts; ~1.5min of unresponsiveness => restart)
 */
import * as http from 'http';
import { Logger } from 'nestjs-pino';

// Tightened on 2026-06-14 after recurring wedges where the previous 90s
// window meant users were stuck a full minute+ before auto-restart kicked
// in. 20s × 2 = ~40s to recovery — fast enough that humans don't notice.
const PROBE_INTERVAL_MS = 20_000;
const PROBE_TIMEOUT_MS = 8_000;
const MAX_CONSECUTIVE_FAILURES = 2;

export function startWatchdog(port: number | string, logger: Logger): void {
  let consecutiveFailures = 0;
  let probeInFlight = false;

  const probe = () => {
    if (probeInFlight) {
      // Previous probe still running (which means the listener is unhealthy
      // anyway). Count this as a failure path: do nothing, the in-flight
      // probe's timeout/error handler will increment the counter.
      return;
    }
    probeInFlight = true;

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/health/live',
        method: 'GET',
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        // Drain the response so the socket can be reused / closed.
        res.resume();
        res.on('end', () => {
          probeInFlight = false;
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
            // 2xx/3xx/4xx all mean the HTTP listener is alive. 5xx would mean
            // crash inside the handler — also a wedge signal, but rare.
            consecutiveFailures = 0;
          } else {
            recordFailure(`unexpected status ${res.statusCode}`);
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('watchdog probe timeout'));
    });

    req.on('error', (err) => {
      probeInFlight = false;
      recordFailure(err.message);
    });

    req.end();
  };

  const recordFailure = (reason: string) => {
    consecutiveFailures += 1;
    logger.warn(
      `Watchdog probe failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${reason}`,
      'Watchdog',
    );
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.error(
        `Watchdog: HTTP listener wedged — exiting so Railway restarts the container`,
        'Watchdog',
      );
      // Give the logger a tick to flush, then hard-exit. process.exit(1) gives
      // Nest's shutdown hooks no time to run, which is intentional: we already
      // know the loop is wedged, normal shutdown would hang too.
      setTimeout(() => process.exit(1), 100);
    }
  };

  // Start probing after a 60s grace period so initial boot work (Prisma
  // connection, migrations on container start) doesn't trigger a false alarm.
  setTimeout(() => {
    logger.log('Watchdog enabled', 'Watchdog');
    setInterval(probe, PROBE_INTERVAL_MS).unref();
  }, 60_000).unref();
}
