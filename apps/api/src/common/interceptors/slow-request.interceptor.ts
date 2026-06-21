/**
 * Slow-request instrumentation.
 *
 * Two complementary signals:
 *   1. "still in flight" — a setTimeout that fires while the request is
 *      still running. If an endpoint hangs (slow query, deadlock, sync CPU
 *      work), we log a WARN at SLOW_REQUEST_MS instead of having to wait
 *      for the request to either complete or get killed by the 30s
 *      TimeoutInterceptor / 45s socket timeout.
 *   2. "completed" — if a request DID eventually finish but took longer
 *      than the threshold, log a WARN with the final duration. Useful for
 *      finding endpoints that are "slow but not broken" before they wedge.
 *
 * Caveat: the setTimeout in (1) runs on the main thread. If the loop is
 * hard-wedged, it won't fire — but those wedges are caught by the
 * wedge-killswitch worker thread. This interceptor catches the softer
 * "slow query holds the request for 5s" case that often precedes a hard
 * wedge.
 *
 * The in-flight counter is exported so the vitals logger can include it
 * in its 30s tick — when the loop wedges, the last vitals line tells us
 * "N requests were in flight when things stopped."
 */
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';

const SLOW_REQUEST_MS = 2000;

// Module-level counter — shared across the singleton interceptor instance.
let inFlight = 0;
let lastSlowRoute: string | null = null;

export function getInFlightRequestCount(): number {
  return inFlight;
}

export function getLastSlowRoute(): string | null {
  return lastSlowRoute;
}

@Injectable()
export class SlowRequestInterceptor implements NestInterceptor {
  constructor(private readonly logger: Logger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const start = Date.now();
    const method: string = req?.method ?? '?';
    const url: string = req?.originalUrl ?? req?.url ?? '?';
    const route = `${method} ${url}`;
    inFlight += 1;

    // (1) Fires if the request is still running at SLOW_REQUEST_MS. Tells
    // us WHAT was hung even if the request never returns.
    const slowTimer = setTimeout(() => {
      const userId = (req as any)?.user?.id;
      lastSlowRoute = route;
      this.logger.warn(
        `request STILL IN FLIGHT after ${SLOW_REQUEST_MS}ms: ${route} userId=${userId ?? '-'} inFlight=${inFlight}`,
        'SlowRequest',
      );
    }, SLOW_REQUEST_MS);

    return next.handle().pipe(
      finalize(() => {
        clearTimeout(slowTimer);
        inFlight = Math.max(0, inFlight - 1);
        const ms = Date.now() - start;
        if (ms > SLOW_REQUEST_MS) {
          const userId = (req as any)?.user?.id;
          this.logger.warn(
            `slow request completed: ${route} userId=${userId ?? '-'} durationMs=${ms}`,
            'SlowRequest',
          );
        }
      }),
    );
  }
}
