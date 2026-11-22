import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { useMe } from '@/hooks/use-auth';
import { ForcePasswordChangePage } from '@/features/auth/force-password-change-page';
import type { ReactNode } from 'react';

interface PrivateRouteProps {
  children: ReactNode;
}

export function PrivateRoute({ children }: PrivateRouteProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  // Permissions round 3 (2026-11-22) — set by the login response,
  // /auth/me, or any 403 PASSWORD_CHANGE_REQUIRED (api/client.ts).
  const mustChangePassword = useAuthStore((s) => s.user?.mustChangePassword === true);
  const location = useLocation();
  const { isLoading } = useMe();

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" />
      </div>
    );
  }

  // Before anything else: the API refuses every other route until the
  // user replaces the password someone else chose. The app shell (and
  // its queries / socket) isn't mounted meanwhile; after success the
  // flag clears and the requested page renders.
  if (mustChangePassword) {
    return <ForcePasswordChangePage />;
  }

  return <>{children}</>;
}
