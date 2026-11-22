import { ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Permissions round 3 (2026-11-22) — forced password change on first
 * sign-in.
 *
 * `users.must_change_password` is set when someone else chose the
 * user's password (Admin/HR create, an Admin resetting it, the users
 * importer). While it is set, every JWT-authenticated route answers
 *
 *   403 { success: false, error: { code: 'PASSWORD_CHANGE_REQUIRED', … } }
 *
 * except the few the user needs to get out of that state, which carry
 * `@AllowWhilePasswordChangeRequired()`: GET /auth/me, PATCH
 * /auth/me/password and POST /auth/logout. (POST /auth/refresh uses the
 * refresh strategy, not this guard, so it keeps working too.)
 *
 * Enforced here — the guard every protected controller already uses,
 * and the first one to run (`@UseGuards(JwtAuthGuard, RolesGuard)`) —
 * so it covers all routes without touching them. The WebSocket
 * handshake applies the same rule (ws-auth.service.ts).
 */
export const PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED';

export const ALLOW_WHILE_PASSWORD_CHANGE_REQUIRED = 'allowWhilePasswordChangeRequired';

/** Marks a route the user may call while he still has to change his password. */
export const AllowWhilePasswordChangeRequired = () =>
  SetMetadata(ALLOW_WHILE_PASSWORD_CHANGE_REQUIRED, true);

export function passwordChangeRequiredException(): ForbiddenException {
  return new ForbiddenException({
    code: PASSWORD_CHANGE_REQUIRED,
    message: 'You need to set a new password before you can continue.',
  });
}

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = unknown>(
    err: unknown,
    user: unknown,
    info: unknown,
    context: ExecutionContext,
    status?: unknown,
  ): TUser {
    const result = super.handleRequest<TUser>(err, user, info, context, status);
    const flagged = (result as { mustChangePassword?: unknown } | null | undefined)?.mustChangePassword === true;
    if (flagged && !isAllowedWhilePasswordChangeRequired(context)) {
      throw passwordChangeRequiredException();
    }
    return result;
  }
}

function isAllowedWhilePasswordChangeRequired(context: ExecutionContext): boolean {
  const handler = context.getHandler?.();
  const cls = context.getClass?.();
  return (
    (handler != null && Reflect.getMetadata(ALLOW_WHILE_PASSWORD_CHANGE_REQUIRED, handler) === true) ||
    (cls != null && Reflect.getMetadata(ALLOW_WHILE_PASSWORD_CHANGE_REQUIRED, cls) === true)
  );
}
