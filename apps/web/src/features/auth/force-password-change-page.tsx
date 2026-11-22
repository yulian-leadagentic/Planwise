import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';

import { authApi } from '@/api/auth.api';
import { useLogout } from '@/hooks/use-auth';
import { useAuthStore } from '@/stores/auth.store';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';

/**
 * Permissions round 3 (2026-11-22) — forced "Set a new password" screen.
 *
 * Shown by PrivateRoute INSTEAD of the app while the signed-in user has
 * `mustChangePassword` (login response, /auth/me, or any 403
 * PASSWORD_CHANGE_REQUIRED): an Admin / HR created the account or reset
 * the password, or it came from a data import, so someone else knows the
 * current password. The API refuses every other route until this
 * succeeds. Reuses PATCH /auth/me/password; on success the flag clears
 * and the user continues to the page he was going to.
 */

const MIN_LENGTH = 8;

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Enter the password you signed in with'),
    newPassword: z.string().min(MIN_LENGTH, `At least ${MIN_LENGTH} characters`),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "The passwords don't match",
    path: ['confirmPassword'],
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    message: 'Choose a password different from the current one',
    path: ['newPassword'],
  });

type FormValues = z.infer<typeof schema>;

const inputCls =
  'mt-1.5 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2.5 text-sm text-slate-700 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus-visible:border-blue-500';

export function ForcePasswordChangePage() {
  const user = useAuthStore((s) => s.user);
  const setMustChangePassword = useAuthStore((s) => s.setMustChangePassword);
  const queryClient = useQueryClient();
  const logout = useLogout();
  const [show, setShow] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const change = useMutation({
    mutationFn: (v: FormValues) =>
      authApi.updatePassword({ currentPassword: v.currentPassword, newPassword: v.newPassword }),
    onSuccess: () => {
      setMustChangePassword(false);
      // Refetch /auth/me and anything that was refused while the flag was set.
      queryClient.invalidateQueries();
      notify.success('Password updated', {
        description: 'You can now use Planwise with your new password.',
        code: 'AUTH-UPDATE-200',
      });
    },
    onError: (err: unknown) => notify.apiError(err, "Couldn't change your password"),
  });

  const field = (
    name: keyof FormValues,
    label: string,
    autoComplete: string,
    placeholder: string,
  ) => (
    <div>
      <label htmlFor={name} className="block text-[13px] font-semibold text-slate-700 dark:text-slate-200">
        {label}
      </label>
      <input
        {...register(name)}
        id={name}
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        placeholder={placeholder}
        className={cn(inputCls, errors[name] && 'border-red-500')}
      />
      {errors[name] && <p className="mt-1 text-xs text-red-500 dark:text-red-400">{errors[name]?.message}</p>}
    </div>
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-white">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Set a new password</h1>
          <p className="mt-1 text-[13px] text-slate-500 dark:text-slate-400">
            {user?.firstName ? `${user.firstName}, your` : 'Your'} password was set by someone else. Choose your own
            to continue.
          </p>
        </div>

        <form
          onSubmit={handleSubmit((v) => change.mutate(v))}
          className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6"
        >
          <div className="space-y-4">
            {field('currentPassword', 'Current password', 'current-password', 'The password you signed in with')}
            {field('newPassword', 'New password', 'new-password', `At least ${MIN_LENGTH} characters`)}
            {field('confirmPassword', 'Confirm new password', 'new-password', 'Repeat the new password')}
          </div>

          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {show ? 'Hide passwords' : 'Show passwords'}
          </button>

          <button
            type="submit"
            disabled={change.isPending}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {change.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Save and continue
          </button>

          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              className="text-[13px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-50"
            >
              Sign out
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
