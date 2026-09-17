/**
 * Process-level sync stderr handlers for the wedge post-mortem.
 *
 * Why this is separate from the other watchdogs:
 * pino is async (worker-thread transport). When the main loop wedges or the
 * container is being torn down, the last few pino lines can be lost — the
 * queue never drains. `process.stderr.write` is synchronous and bypasses
 * pino entirely, so a line printed from a signal handler is guaranteed to
 * hit the stream before the process is gone.
 *
 * We only care about the presence of a signal here — no formatting, no
 * pino-style JSON — just enough to answer "what killed us?" on the next
 * wedge. If the log shows `received SIGTERM` we know Railway/orchestrator
 * sent it (deploy, restart, plan-level cull). If we see no signal line and
 * no wedge-killswitch line but the process is gone anyway, the kill was
 * external and uncatchable (OOM at the kernel level, SIGKILL from outside).
 * That distinction is what turned the last two wedges into guesswork.
 *
 * Installed FIRST in bootstrap so a signal that arrives during app-module
 * evaluation still gets logged before Nest tears down (or fails to).
 */
const write = (line: string): void => {
  try {
    process.stderr.write(line);
  } catch {
    // Never let observability itself crash startup or shutdown.
  }
};

const iso = (): string => new Date().toISOString();

export function installStartupSignals(): void {
  process.on('SIGTERM', () =>
    write(`[startup-signals] received SIGTERM @${iso()}\n`),
  );
  process.on('SIGINT', () =>
    write(`[startup-signals] received SIGINT @${iso()}\n`),
  );
  // SIGHUP: some orchestrators send it on log rotation or config-reload
  // signals — still worth capturing so we can rule it in or out.
  process.on('SIGHUP', () =>
    write(`[startup-signals] received SIGHUP @${iso()}\n`),
  );
  process.on('beforeExit', (code) =>
    write(`[startup-signals] beforeExit code=${code} @${iso()}\n`),
  );
  process.on('exit', (code) =>
    write(`[startup-signals] exit code=${code} @${iso()}\n`),
  );

  write(`[startup-signals] handlers armed @${iso()}\n`);
}
