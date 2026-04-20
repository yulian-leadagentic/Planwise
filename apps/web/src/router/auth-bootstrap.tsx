import { useEffect } from 'react';
import axios from 'axios';
import { useAuthStore } from '@/stores/auth.store';

/**
 * On page load / refresh, silently obtain a fresh access token using the
 * httpOnly refresh cookie. This lets us keep the access token in memory
 * only (safe from XSS) while still giving returning users a seamless
 * experience — no re-login on every page reload.
 *
 * Runs once at app mount. Noop if there's no "was-authenticated" flag.
 */
export function AuthBootstrap({ children }: { children: React.ReactNode }) {
  const isBootstrapping = useAuthStore((s) => s.isBootstrapping);
  const setToken = useAuthStore((s) => s.setToken);
  const setBootstrapComplete = useAuthStore((s) => s.setBootstrapComplete);

  useEffect(() => {
    if (!isBootstrapping) return;
    let cancelled = false;

    axios
      .post('/api/v1/auth/refresh', null, { withCredentials: true })
      .then((res) => {
        if (cancelled) return;
        const token = res.data?.data?.accessToken ?? res.data?.accessToken;
        if (token) setToken(token);
        else setBootstrapComplete();
      })
      .catch(() => {
        if (!cancelled) setBootstrapComplete();
      });

    return () => {
      cancelled = true;
    };
  }, [isBootstrapping, setToken, setBootstrapComplete]);

  if (isBootstrapping) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" />
      </div>
    );
  }

  return <>{children}</>;
}
