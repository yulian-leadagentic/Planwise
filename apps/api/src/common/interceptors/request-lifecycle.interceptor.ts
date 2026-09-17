/**
 * Request lifecycle logger.
 *
 * Why this exists (QA3 Wave-1 Commit 1):
 * pino-http auto-logs "request completed" once per request, but only at the
 * end. When the container wedges mid-request the completion line for the
 * killer request is never written — so the post-mortem shows "everything was
 * fine, then silence." That leaves us guessing which endpoint / which
 * projectId was in flight when the wall hit.
 *
 * This interceptor emits TWO grep-friendly lines per request under the
 * `RequestLifecycle` context:
 *   • `req.start reqId=… method=… url=… projectId=… userId=…`
 *   • `req.end   reqId=… method=… url=… projectId=… userId=… durationMs=… status=…`
 *
 * The pair is intentionally paired-symmetric so a search for "req.start" that
 * has no matching "req.end" pinpoints the last un-ended request before a
 * SIGKILL — which is the whole point on staging while we chase the wedge.
 *
 * projectId is extracted from the URL. Every hot-path load-a-project endpoint
 * carries the id in the path (/api/v1/projects/:id/... and its nested
 * sub-resources /planning-data, /assignee-candidates, /progress). Body-carried
 * projectIds (POST /tasks etc.) are deliberately not extracted here — the
 * body isn't safe to peek at inside a global interceptor without upsetting
 * the ValidationPipe's transform contract.
 *
 * The pino line is left in place — this is additive, not a replacement. It
 * duplicates only the "end" fact, and adds the "start" fact + a compact,
 * projectId-tagged shape that survives grep piping. The volume delta is
 * modest (staging peak ~50 req/s = ~100 extra lines/s, well within ingest).
 */
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

// Matches `/projects/<numeric-id>` anywhere in the URL. Numeric only — Nest
// routes use numeric ids for the project resource, so this correctly ignores
// `/projects/attached-contacts` (non-numeric) and similar collection routes
// without a specific project scope.
const PROJECT_ID_RE = /\/projects\/(\d+)/;

function extractProjectId(url: string | undefined): string {
  if (!url) return '-';
  const m = PROJECT_ID_RE.exec(url);
  return m ? m[1] : '-';
}

@Injectable()
export class RequestLifecycleInterceptor implements NestInterceptor {
  constructor(private readonly logger: Logger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const start = Date.now();
    const method: string = req?.method ?? '?';
    const url: string = req?.originalUrl ?? req?.url ?? '?';
    // pino-http populates req.id via genReqId (x-request-id header or UUID);
    // we reuse the same id here so grepping by reqId pairs both loggers'
    // output for the same request.
    const reqId: string = req?.id ?? '-';
    const projectId = extractProjectId(url);
    const userId = (req as any)?.user?.id ?? '-';

    this.logger.log(
      `req.start reqId=${reqId} method=${method} url=${url} projectId=${projectId} userId=${userId}`,
      'RequestLifecycle',
    );

    return next.handle().pipe(
      tap({
        next: () => {
          // Success path — status set by the handler (or defaulted).
          const durationMs = Date.now() - start;
          const status = res?.statusCode ?? '-';
          this.logger.log(
            `req.end   reqId=${reqId} method=${method} url=${url} projectId=${projectId} userId=${userId} durationMs=${durationMs} status=${status}`,
            'RequestLifecycle',
          );
        },
        error: (err) => {
          // Error path — HttpExceptionFilter will set the actual response
          // status after this interceptor's tap fires, so read the intended
          // status off the exception if it exposes one; else fall back to
          // 500 (that's what pino-http will end up recording too).
          const durationMs = Date.now() - start;
          const status =
            (err as any)?.status ?? (err as any)?.getStatus?.() ?? 500;
          this.logger.log(
            `req.end   reqId=${reqId} method=${method} url=${url} projectId=${projectId} userId=${userId} durationMs=${durationMs} status=${status} errored=1`,
            'RequestLifecycle',
          );
        },
      }),
    );
  }
}
