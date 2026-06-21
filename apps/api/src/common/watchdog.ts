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
 *  - probe every 20s
 *  - timeout each probe at 8s
 *  - allow 2 consecutive failures before exit (~40s to recovery)
 *
 * Why no outer setTimeout: prior versions wrapped the probe loop in
 * `setTimeout(60s)` to defer the first probe past boot. That loop runs on
 * the main thread, so if the loop wedged inside the first 60s the timer
 * never fired and the watchdog was never armed. Staging incident
 * 2026-06-21 hit exactly that case (wedge at boot+7s, no auto-restart).
 * Grace is now enforced inline in recordFailure() instead — the probe
 * loop runs from t=0, failures during grace are silently dropped.
 */
import * as http from 'http';
import { Logger } from 'nestjs-pino';

// Tightened on 2026-06-14 after recurring wedges where the previous 90s
// window meant users were stuck a full minute+ before auto-restart kicked
// in. 20s × 2 = ~40s to recovery — fast enough that humans don't notice.
const PROBE_INTERVAL_MS = 20_000;
const PROBE_TIMEOUT_MS = 8_000;
const MAX_CONSECUTIVE_FAILURES = 2;

// Same idea as the wedge-killswitch: grace lives INLINE in recordFailure,
// not as a deferred setTimeout. Previously the entire probe loop started
// via setTimeout(60s) — which meant a wedge inside the first 60s froze
// the very timer that was supposed to arm us. (Staging incident 2026-06-21.)
const GRACE_PERIOD_MS = 60_000;

export function startWatchdog(port: number | string, logger: Logger): void {
  let consecutiveFailures = 0;
  let probeInFlight = false;
  const watchdogStartedAt = Date.now();
  const inGrace = () => Date.now() - watchdogStartedAt < GRACE_PERIOD_MS;

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
    if (inGrace()) {
      // Boot-time probes can legitimately fail (HTTP listener not up yet,
      // Prisma connecting). Don't count those against the budget.
      return;
    }
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

  // Start probing immediately. The grace period is enforced inline in
  // recordFailure() above, NOT by deferring this setInterval — see the
  // file header comment for the failure mode that approach caused.
  logger.log(
    `Watchdog armed — exit after ${MAX_CONSECUTIVE_FAILURES} consecutive probe failures (${GRACE_PERIOD_MS / 1000}s post-boot grace)`,
    'Watchdog',
  );
  setInterval(probe, PROBE_INTERVAL_MS).unref();
}
