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

// Tunables. With PING_INTERVAL=10s and MAX_MISSES=3, recovery latency is
// roughly (3 - 1) * 10s + restart-time = ~50s end-to-end. Tighter than this
// risks SIGKILLing during legitimate brief stalls (GC pause, sync crypto).
const PING_INTERVAL_MS = 10_000;
const MAX_CONSECUTIVE_MISSES = 3;

// Grace period after boot so initial Prisma connect + migrations don't trip
// the killswitch — same rationale as the existing watchdog.
const GRACE_PERIOD_MS = 60_000;

const WORKER_SOURCE = `
  // Runs in a separate V8 isolate. Plain JS so no compile step needed.
  const { parentPort } = require('worker_threads');

  const PING_INTERVAL_MS = ${PING_INTERVAL_MS};
  const MAX_CONSECUTIVE_MISSES = ${MAX_CONSECUTIVE_MISSES};

  let pingInFlight = false;
  let misses = 0;

  parentPort.on('message', (msg) => {
    if (msg === 'pong') {
      pingInFlight = false;
      misses = 0;
    }
  });

  setInterval(() => {
    if (pingInFlight) {
      // No pong arrived between the last tick and this one. Count one miss.
      misses += 1;
      const elapsedSec = (misses * PING_INTERVAL_MS) / 1000;
      // Log to stderr — workers share the parent's stdio, so Railway picks
      // this up alongside Nest's logs.
      console.error(
        '[wedge-killswitch] main loop unresponsive ~' + elapsedSec + 's (' +
        misses + '/' + MAX_CONSECUTIVE_MISSES + ')'
      );
      if (misses >= MAX_CONSECUTIVE_MISSES) {
        console.error(
          '[wedge-killswitch] FATAL — sending SIGKILL to pid=' + process.pid +
          '. Railway will restart the container.'
        );
        try {
          // process.pid in a worker is the parent process's pid. SIGKILL is
          // uncatchable by the kernel — the whole process group is torn down.
          process.kill(process.pid, 'SIGKILL');
        } catch (e) {
          console.error('[wedge-killswitch] SIGKILL failed:', e && e.message);
          // Last-resort: exit the worker so at least the diagnostic line
          // makes it to the logs.
          process.exit(1);
        }
      }
    }
    pingInFlight = true;
    parentPort.postMessage('ping');
  }, PING_INTERVAL_MS);
`;

export function startWedgeKillswitch(logger: Logger): void {
  // Delay worker startup so boot-time work doesn't get counted against the
  // killswitch budget.
  setTimeout(() => {
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
    // fires — that's exactly the signal the worker is watching for.
    worker.on('message', (msg) => {
      if (msg === 'ping') worker.postMessage('pong');
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
    logger.log(
      `Wedge-killswitch enabled — SIGKILL after ${wedgeBudgetSec}s of main-loop unresponsiveness`,
      'WedgeKillswitch',
    );
  }, GRACE_PERIOD_MS).unref();
}
