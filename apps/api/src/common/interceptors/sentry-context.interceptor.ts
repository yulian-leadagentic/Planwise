import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import type { Observable } from 'rxjs';

/**
 * Attach user + route tags to Sentry's per-request isolation scope so every
 * event captured by the filter or by explicit `Sentry.captureException` in a
 * service says WHO triggered it and WHERE.
 *
 * Uses `Sentry.getIsolationScope()` — in @sentry/node v8+ the HTTP integration
 * gives each request its own isolation scope via AsyncLocalStorage, so tags
 * set here follow the request through async hops and land on any exception
 * fired later. `withScope` would be wrong here: it only lives for the
 * callback body, so the tags would be gone by the time the exception filter
 * runs.
 *
 * Id-only user context by default. Email is PII (see privacy section of
 * docs/bm2/observability-sentry-spec.md — contact data must never reach
 * Sentry). If Yulian later wants email in events, this is the one place to
 * opt in.
 *
 * No-op when Sentry didn't init (DSN unset): the SDK's no-op scope silently
 * accepts setUser/setTag.
 */
@Injectable()
export class SentryContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      user?: { id?: number | string };
      route?: { path?: string };
      method?: string;
    }>();

    const scope = Sentry.getIsolationScope();
    const userId = req?.user?.id;
    if (userId !== undefined) {
      scope.setUser({ id: String(userId) });
    }
    if (req?.route?.path) {
      scope.setTag('route', req.route.path);
    }
    if (req?.method) {
      scope.setTag('method', req.method);
    }

    return next.handle();
  }
}
