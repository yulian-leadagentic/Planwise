import { Navigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import type { ReactNode } from 'react';

interface RoleRouteProps {
  children: ReactNode;
  roles?: string[];
}

export function RoleRoute({ children }: RoleRouteProps) {
  const user = useAuthStore((s) => s.user);

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
