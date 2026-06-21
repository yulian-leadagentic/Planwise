/**
 * Manual verification of the wedge killswitch.
 *
 * Default (production-realistic) run (~2 min):
 *     npx ts-node scripts/test-wedge-killswitch.ts
 *
 * Fast run (~10s) — use this to confirm the killswitch works without
 * waiting 2 minutes. Tightens grace/interval/misses so the whole
 * boot→wedge→SIGKILL cycle finishes quickly:
 *     WEDGE_GRACE_MS=2000 WEDGE_PING_INTERVAL_MS=1000 WEDGE_MAX_MISSES=2 \
 *       npx ts-node scripts/test-wedge-killswitch.ts --fast
 *
 * Restart-loop demo (shows what Railway would do after SIGKILL):
 *     bash scripts/test-wedge-restart-loop.sh
 *
 * Default-mode expected timeline:
 *   t=0s    script starts, worker armed ("Wedge-killswitch armed")
 *           — worker ignores misses for its first 60s (grace)
 *   t=90s   main loop blocked with a tight while(true)
 *   t=120s  worker logs "main loop unresponsive ~30s (3/3) lastInFlight=..."
 *           then SIGKILL — script exits with non-zero, OS-level
 *
 * Fast-mode expected timeline:
 *   t=0s    armed (2s grace, 1s ping interval, 2 misses)
 *   t=5s    main loop blocked
 *   t=7s    "main loop unresponsive ~2s (2/2)" → SIGKILL
 *
 * If the script keeps running past the expected SIGKILL time, the
 * killswitch is broken. If it dies BEFORE the expected time, the
 * tunables are too aggressive.
 *
 * Note about logs in this demo: the wedge here is a tight CPU loop on
 * the main thread, which starves libuv. The worker's stderr is piped
 * through the parent's libuv, so its "main loop unresponsive ~Ns" and
 * FATAL lines may not reach the terminal before SIGKILL — the kernel
 * tears down the whole process group instantly. Verification is the
 * NON-ZERO EXIT CODE within the expected window. On Railway, real
 * wedges are usually slow I/O (Prisma queries, network) which leave
 * libuv pumping stdio — the worker's logs will appear in those cases.
 */
import type { Logger } from 'nestjs-pino';
import { startWedgeKillswitch } from '../src/common/wedge-killswitch';

const FAST = process.argv.includes('--fast');
const WEDGE_AT_MS = FAST ? 5_000 : 90_000;
const SAFETY_NET_MS = FAST ? 20_000 : 180_000;

const stubLogger = {
  log: (msg: string, ctx?: string) => console.log(`[LOG ${ctx ?? '-'}] ${msg}`),
  warn: (msg: string, ctx?: string) => console.warn(`[WRN ${ctx ?? '-'}] ${msg}`),
  error: (msg: string, ctx?: string) => console.error(`[ERR ${ctx ?? '-'}] ${msg}`),
} as unknown as Logger;

const grace = Number(process.env.WEDGE_GRACE_MS) || 60_000;
const interval = Number(process.env.WEDGE_PING_INTERVAL_MS) || 10_000;
const misses = Number(process.env.WEDGE_MAX_MISSES) || 3;
const budget = (misses * interval) / 1000;

console.log(
  `pid=${process.pid} — installing killswitch (grace=${grace / 1000}s, ` +
    `ping=${interval / 1000}s, misses=${misses}, budget=${budget}s)`,
);
console.log(`Mode: ${FAST ? 'FAST (~10s)' : 'DEFAULT (~2min)'}`);
console.log(`Will wedge at t=${WEDGE_AT_MS / 1000}s. Expecting SIGKILL shortly after.`);

startWedgeKillswitch(stubLogger);

setTimeout(() => {
  console.log(
    `=== blocking main loop forever — killswitch should fire in ~${budget}s ===`,
  );
  // Tight CPU loop — no yield, no I/O, no timer dispatch.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let x = 0;
  while (true) x = (x + 1) % 1000;
}, WEDGE_AT_MS);

// Safety net: if the killswitch is broken, kill the test ourselves.
setTimeout(() => {
  console.error(
    `=== killswitch DID NOT fire within ${SAFETY_NET_MS / 1000}s — test FAILED ===`,
  );
  process.exit(2);
}, SAFETY_NET_MS).unref();
