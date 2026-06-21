/**
 * Out-of-loop wedge killswitch.
 *
 * Why a SECOND watchdog when we already have ./watchdog.ts?
 * The existing watchdog runs on the main event loop. When the main loop is
 * hard-blocked (sync CPU work, native binding deadlock, ReDoS, anything that
 * stops timer dispatch), the watchdog's own `setTimeout` / `http` probe
 * timers never fire — so it can't call `exit(1)`. We've seen exactly this
 * pattern on staging: vitals logs go silent, the container stays "alive" to
 * Railway, the user hits 502s for minutes, restart is manual.
 *
 * This module spawns a worker_threads worker. Workers run in a separate V8
 * isolate with their own event loop, so a block on the main thread does NOT
 * freeze the worker. The worker pings the main thread every 10s; the main
 * thread answers with 'pong'. If the worker misses 3 consecutive pongs
 * (~30-40s of unresponsiveness), it calls `process.kill(process.pid, 'SIGKILL')`
 * — kernel-level termination, uncatchable, regardless of how stuck JS is.
 * Railway's `restartPolicy=ON_FAILURE` then restarts the container in ~30s.
 *
 * Worker code lives inline as a string with `{ eval: true }` so there's no
 * separate .js file to ship — avoids path-resolution headaches between
 * dev (ts-node) and prod (compiled dist/). It's ~25 lines of plain JS.
 *
 * Leave ./watchdog.ts in place: it catches a different failure mode (HTTP
 * listener wedge with loop still ticking — e.g. socket lock-up). The two
 * complement each other.
 */
import { Worker } from 'worker_threads';
import { Logger } from 'nestjs-pino';
import {
  getInFlightRequestCount,
  getLastSlowRoute,
} from './interceptors/slow-request.interceptor';

// Tunables. With PING_INTERVAL=10s and MAX_MISSES=3, recovery latency is
// roughly (3 - 1) * 10s + restart-time = ~50s end-to-end. Tighter than this
// risks SIGKILLing during legitimate brief stalls (GC pause, sync crypto).
//
// Overrides via env vars are supported so the verification script can run
// the whole loop in ~10s instead of waiting two minutes. Production deploys
// should leave them unset.
const PING_INTERVAL_MS = Number(process.env.WEDGE_PING_INTERVAL_MS) || 10_000;
const MAX_CONSECUTIVE_MISSES = Number(process.env.WEDGE_MAX_MISSES) || 3;

// Grace period after boot so initial Prisma connect + migrations don't trip
// the killswitch. CRITICAL: this lives INSIDE the worker — see comment on
// startWedgeKillswitch below for why.
const GRACE_PERIOD_MS = Number(process.env.WEDGE_GRACE_MS) || 60_000;

const WORKER_SOURCE = `
  // Runs in a separate V8 isolate. Plain JS so no compile step needed.
  const { parentPort } = require('worker_threads');

  const PING_INTERVAL_MS = ${PING_INTERVAL_MS};
  const MAX_CONSECUTIVE_MISSES = ${MAX_CONSECUTIVE_MISSES};
  const GRACE_PERIOD_MS = ${GRACE_PERIOD_MS};

  let pingInFlight = false;
  let misses = 0;
  const workerStartedAt = Date.now();
  // Last "what was happening" snapshot we got from the main thread via a
  // pong message. When the wedge kills us, we log this so the post-mortem
  // shows the last known in-flight count + the slowest recent route —
  // critical for diagnosing what triggered the freeze.
  let lastInFlight = -1;
  let lastSlowRoute = null;

  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'pong') {
      pingInFlight = false;
      misses = 0;
      if (typeof msg.inFlight === 'number') lastInFlight = msg.inFlight;
      if (msg.lastSlow !== undefined) lastSlowRoute = msg.lastSlow;
    }
  });

  setInterval(() => {
    const inGrace = (Date.now() - workerStartedAt) < GRACE_PERIOD_MS;
    if (pingInFlight && !inGrace) {
      // No pong arrived between the last tick and this one. Count one miss.
      misses += 1;
      const elapsedSec = (misses * PING_INTERVAL_MS) / 1000;
      // Log via process.stderr.write — bypasses Node's console.* batching,
      // which silently drops lines on some platforms (Windows + Git Bash)
      // when the parent dies milliseconds later. Railway captures the
      // worker's stderr alongside Nest's logs.
      process.stderr.write(
        '[wedge-killswitch] main loop unresponsive ~' + elapsedSec + 's (' +
        misses + '/' + MAX_CONSECUTIVE_MISSES + ') ' +
        'lastInFlight=' + lastInFlight + ' lastSlowRoute=' + (lastSlowRoute || '-') + '\\n'
      );
      if (misses >= MAX_CONSECUTIVE_MISSES) {
        process.stderr.write(
          '[wedge-killswitch] FATAL — sending SIGKILL to pid=' + process.pid +
          '. lastInFlight=' + lastInFlight +
          ' lastSlowRoute=' + (lastSlowRoute || '-') +
          ' Railway will restart the container.\\n'
        );
        // Give stderr a brief moment to flush before SIGKILL. The kernel
        // tears down the whole process group instantly, racing against
        // the worker's IPC buffer — without this the FATAL line gets eaten
        // on systems with buffered stderr. 50ms is invisible against the
        // 30s wedge that triggered us.
        setTimeout(() => {
          try {
            // process.pid in a worker is the parent process's pid. SIGKILL
            // is uncatchable by the kernel — the whole process group is
            // torn down.
            process.kill(process.pid, 'SIGKILL');
          } catch (e) {
            process.stderr.write(
              '[wedge-killswitch] SIGKILL failed: ' + (e && e.message) + '\\n'
            );
            // Last-resort: exit the worker so at least the diagnostic line
            // makes it to the logs.
            process.exit(1);
          }
        }, 50);
      }
    }
    pingInFlight = true;
    parentPort.postMessage('ping');
  }, PING_INTERVAL_MS);
`;

export function startWedgeKillswitch(logger: Logger): void {
  // Arm the worker IMMEDIATELY on bootstrap. Previously we wrapped this in a
  // main-thread `setTimeout(60s)` so the worker wouldn't count boot-time
  // stalls against the kill budget — but that meant a wedge in the first
  // 60s would freeze the very setTimeout that was supposed to arm us, and
  // the killswitch never existed. That's exactly the failure mode we saw on
  // staging on 2026-06-21 (boot at 05:38:58, wedge at 05:39:05, no
  // SIGKILL, process sat dead for 5m 40s until manual restart). The grace
  // period now lives INSIDE the worker (see WORKER_SOURCE) — the worker
  // itself ignores missed pongs for the first GRACE_PERIOD_MS so boot
  // churn still doesn't trip it.
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true });
  } catch (err) {
    logger.error(
      `Wedge-killswitch could not start worker: ${(err as Error).message}`,
      'WedgeKillswitch',
    );
    return;
  }

  // Main-thread responder. If the loop is blocked this listener never
  // fires — that's exactly the signal the worker is watching for. We
  // piggyback live in-flight context onto the pong so the worker has
  // forensics ready when it has to SIGKILL.
  worker.on('message', (msg) => {
    if (msg === 'ping') {
      worker.postMessage({
        type: 'pong',
        inFlight: getInFlightRequestCount(),
        lastSlow: getLastSlowRoute(),
      });
    }
  });

  worker.on('error', (err) => {
    logger.error(
      `Wedge-killswitch worker error: ${err.message}`,
      'WedgeKillswitch',
    );
  });

  worker.on('exit', (code) => {
    // Code 0 = clean shutdown alongside the parent. Anything else means
    // either the killswitch fired (we're dying anyway) or the worker
    // crashed (we've lost the safety net — surface loudly so it gets
    // noticed before the next wedge).
    if (code !== 0) {
      logger.warn(
        `Wedge-killswitch worker exited with code ${code} — out-of-loop watchdog is GONE until restart`,
        'WedgeKillswitch',
      );
    }
  });

  // Don't let this worker hold the process open if the parent wants to
  // exit cleanly (graceful shutdown). The main thread terminates the
  // worker as part of process teardown.
  worker.unref();

  const wedgeBudgetSec = (MAX_CONSECUTIVE_MISSES * PING_INTERVAL_MS) / 1000;
  const graceSec = GRACE_PERIOD_MS / 1000;
  logger.log(
    `Wedge-killswitch armed — SIGKILL after ${wedgeBudgetSec}s of main-loop unresponsiveness (${graceSec}s post-boot grace)`,
    'WedgeKillswitch',
  );
}
