/**
 * Manual verification of the wedge killswitch.
 *
 * Run:   npx ts-node scripts/test-wedge-killswitch.ts
 *
 * Expected timeline:
 *   t=0s    script starts, logs "starting killswitch"
 *   t=60s   killswitch worker boots ("Wedge-killswitch enabled")
 *   t=90s   main loop blocked with a tight while(true)
 *   t=120s  worker logs "main loop unresponsive ~30s (3/3)" then SIGKILL
 *           — script exits with non-zero, OS-level (not a JS error)
 *
 * If the script keeps running past t=130s the killswitch is broken.
 * If it dies BEFORE t=120s, MAX_CONSECUTIVE_MISSES / PING_INTERVAL_MS are
 * too aggressive — back them off in wedge-killswitch.ts.
 */
import type { Logger } from 'nestjs-pino';
import { startWedgeKillswitch } from '../src/common/wedge-killswitch';

const stubLogger = {
  log: (msg: string, ctx?: string) => console.log(`[LOG ${ctx ?? '-'}] ${msg}`),
  warn: (msg: string, ctx?: string) => console.warn(`[WRN ${ctx ?? '-'}] ${msg}`),
  error: (msg: string, ctx?: string) => console.error(`[ERR ${ctx ?? '-'}] ${msg}`),
} as unknown as Logger;

console.log(`pid=${process.pid} — installing killswitch (60s grace, 30s budget)`);
startWedgeKillswitch(stubLogger);

setTimeout(() => {
  console.log('=== blocking main loop forever — killswitch should fire in ~30s ===');
  // Tight CPU loop — no yield, no I/O, no timer dispatch.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let x = 0;
  while (true) x = (x + 1) % 1000;
}, 90_000);

// Safety net: if the killswitch is broken, kill the test ourselves at 3 min.
setTimeout(() => {
  console.error('=== killswitch DID NOT fire within 3 min — test FAILED ===');
  process.exit(2);
}, 180_000).unref();
