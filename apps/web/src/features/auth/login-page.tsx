import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useLogin } from '@/hooks/use-auth';
import { useAuthStore } from '@/stores/auth.store';
import { authApi } from '@/api/auth.api';
import { API_BASE } from '@/lib/runtime-config';
import { cn } from '@/lib/utils';

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

type LoginForm = z.infer<typeof loginSchema>;

export function LoginPage() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const login = useLogin();
  const [showPassword, setShowPassword] = useState(false);

  // Providers list is public + tiny — hit it every page load so a
  // freshly-enabled provider shows up without a browser refresh.
  const { data: providers = [] } = useQuery({
    queryKey: ['auth', 'oidc', 'providers'],
    queryFn: () => authApi.getOidcProviders(),
    staleTime: 60_000,
    // On the login page we don't care if this fails — we simply
    // don't render the SSO buttons.
    retry: 0,
  });

  const microsoftEnabled = providers.some((p) => p.provider === 'microsoft' && p.enabled);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
  });

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  const onSubmit = (data: LoginForm) => {
    login.mutate(data);
  };

  // The password mutation surfaces the API's UnauthorizedException
  // message verbatim when it's the SSO-only nudge — so we detect it
  // here and render an inline hint that also links out to the SSO
  // button.
  const loginErrorMsg: string | null = (() => {
    const err = login.error as { response?: { data?: { message?: string } }; message?: string } | null;
    const msg = err?.response?.data?.message ?? err?.message ?? null;
    return typeof msg === 'string' ? msg : null;
  })();
  const isSsoOnlyError = !!loginErrorMsg && /sign on|single sign-on|sso/i.test(loginErrorMsg);

  const microsoftLoginUrl = `${(API_BASE || window.location.origin).replace(/\/$/, '')}/api/v1/auth/oidc/microsoft/login`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950 px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-lg font-bold text-white">
            A
          </div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">Welcome to AMEC</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Sign in to your account</p>
        </div>

        {/* SSO buttons — rendered ABOVE the password form when any
            provider is enabled, matching the pattern users see on
            most enterprise apps. */}
        {microsoftEnabled && (
          <div className="mb-4 rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
            <a
              href={microsoftLoginUrl}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-4 py-2.5 text-[13px] font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-500 hover:bg-blue-50/40 dark:hover:bg-blue-950/20 transition-colors"
            >
              <MicrosoftLogo />
              Sign in with Microsoft
            </a>
            <div className="mt-3 flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">or</span>
              <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
            </div>
          </div>
        )}

        {/* Form */}
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6"
        >
          <div className="space-y-4">
            {/* Email */}
            <div>
              <label htmlFor="email" className="block text-[13px] font-semibold text-slate-700 dark:text-slate-200">
                Email
              </label>
              <input
                {...register('email')}
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                className={cn(
                  'mt-1.5 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2.5 text-sm text-slate-700 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus-visible:border-blue-500',
                  errors.email && 'border-red-500',
                )}
              />
              {errors.email && (
                <p className="mt-1 text-xs text-red-500 dark:text-red-400">{errors.email.message}</p>
              )}
            </div>

            {/* Password */}
            <div>
              <label htmlFor="password" className="block text-[13px] font-semibold text-slate-700 dark:text-slate-200">
                Password
              </label>
              <div className="relative mt-1.5">
                <input
                  {...register('password')}
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  className={cn(
                    'w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2.5 pr-10 text-sm text-slate-700 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus-visible:border-blue-500',
                    errors.password && 'border-red-500',
                  )}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.password && (
                <p className="mt-1 text-xs text-red-500 dark:text-red-400">{errors.password.message}</p>
              )}
            </div>
          </div>

          {/* Inline "use SSO" hint after a rejected password attempt.
              Rendered ABOVE the button so the eye lands here before
              re-clicking Sign In. */}
          {isSsoOnlyError && (
            <div className="mt-4 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 p-3 text-[13px] text-blue-700 dark:text-blue-300">
              <div className="font-semibold">Your organization requires single sign-on.</div>
              <div className="mt-1">
                {microsoftEnabled ? (
                  <>
                    Please use the{' '}
                    <a href={microsoftLoginUrl} className="underline font-semibold">
                      Sign in with Microsoft
                    </a>{' '}
                    button above.
                  </>
                ) : (
                  <>Contact your administrator — SSO is required but no provider is currently enabled.</>
                )}
              </div>
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={login.isPending}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {login.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Sign In
          </button>

          {/* Forgot password link */}
          <div className="mt-4 text-center">
            <Link
              to="/forgot-password"
              className="text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              Forgot your password?
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}

// Microsoft 4-square logo — no external asset (CSP would block it
// anyway). Same 4 brand colors used on the admin card.
function MicrosoftLogo() {
  return (
    <span className="inline-grid grid-cols-2 gap-[2px] w-4 h-4">
      <span className="bg-[#F25022]" />
      <span className="bg-[#7FBA00]" />
      <span className="bg-[#00A4EF]" />
      <span className="bg-[#FFB900]" />
    </span>
  );
}
