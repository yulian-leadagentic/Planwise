import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { canSeeFinance, redactFinanceFields } from '../finance/finance-access';

/**
 * Permissions round 2 (2026-11-20) — central read-side money redaction.
 *
 * For a caller without `finance:read` (or no user at all) every JSON
 * response is passed through `redactFinanceFields`, which removes the
 * unambiguous money keys listed in `common/finance/finance-access.ts`
 * at any depth. Callers WITH `finance:read` get the payload untouched
 * (no walk, no cost).
 *
 * Registered globally in main.ts, OUTSIDE ResponseInterceptor, so its
 * `map` runs on the final `{ success, data, meta }` payload. Guards run
 * before any interceptor, so `req.user` is already set. Handlers that
 * write to `@Res()` themselves (file exports) never reach this map —
 * they strip their own money columns.
 */
@Injectable()
export class FinanceRedactionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    return next.handle().pipe(
      map((data) => (canSeeFinance(req?.user) ? data : redactFinanceFields(data))),
    );
  }
}
