import type { ExecutionContext } from '@nestjs/common';
import type { Resolvable, ThrottlerGetTrackerFunction } from '@nestjs/throttler';

/** The app-wide limit (`ThrottlerModule.forRoot` in app.module): 100 requests a minute per IP. */
export const APP_THROTTLE = { ttl: 60_000, limit: 100 } as const;

const userIdOf = (req: Record<string, any> | null | undefined): number | null =>
  req?.user?.id != null ? Number(req.user.id) : null;

/**
 * Review 2 (A7) — a per-user limit on one route. Use both on the handler:
 *
 *   @UseGuards(ThrottlerGuard)
 *   @Throttle(perUserThrottle(3, 60_000))
 *
 * Why both: the app-wide ThrottlerGuard (APP_GUARD) runs BEFORE the
 * controller's JwtAuthGuard, so it sees no `req.user`, and behind the
 * proxy every caller has the same IP. On that pass the route keeps the
 * app-wide limit, counted per IP as before. The route's own
 * ThrottlerGuard runs after JwtAuthGuard and counts `limit` per `ttl`
 * milliseconds for each signed-in user (tracker `user:<id>`).
 */
export function perUserThrottle(
  limit: number,
  ttl: number,
): Record<'default', { limit: Resolvable<number>; ttl: Resolvable<number>; getTracker: ThrottlerGetTrackerFunction }> {
  const signedIn = (ctx: ExecutionContext) => userIdOf(ctx.switchToHttp().getRequest()) != null;
  return {
    default: {
      limit: (ctx) => (signedIn(ctx) ? limit : APP_THROTTLE.limit),
      ttl: (ctx) => (signedIn(ctx) ? ttl : APP_THROTTLE.ttl),
      getTracker: (req) => {
        const id = userIdOf(req);
        return id != null ? `user:${id}` : String(req.ip ?? '');
      },
    },
  };
}
