import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useForgotPassword, useVerifyOtp, useResetPassword } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';

const emailSchema = z.object({
  email: z.string().email('Invalid email address'),
});

const otpSchema = z.object({
  code: z.string().min(6, 'Code must be 6 digits').max(6),
});

const passwordSchema = z
  .object({
    newPassword: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type Step = 'email' | 'otp' | 'password';

export function ForgotPasswordSteps() {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [resetToken, setResetToken] = useState('');

  const forgotPassword = useForgotPassword();
  const verifyOtp = useVerifyOtp();
  const resetPassword = useResetPassword();

  const emailForm = useForm<z.infer<typeof emailSchema>>({
    resolver: zodResolver(emailSchema),
  });

  const otpForm = useForm<z.infer<typeof otpSchema>>({
    resolver: zodResolver(otpSchema),
  });

  const passwordForm = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
  });

  const handleEmailSubmit = (data: z.infer<typeof emailSchema>) => {
    setEmail(data.email);
    forgotPassword.mutate(
      { email: data.email },
      { onSuccess: () => setStep('otp') },
    );
  };

  const handleOtpSubmit = (data: z.infer<typeof otpSchema>) => {
    verifyOtp.mutate(
      { email, code: data.code },
      {
        onSuccess: (result: any) => {
          setResetToken(result.resetToken);
          setStep('password');
        },
      },
    );
  };

  const handlePasswordSubmit = (data: z.infer<typeof passwordSchema>) => {
    resetPassword.mutate({ resetToken, newPassword: data.newPassword });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold">Reset Password</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {step === 'email' && 'Enter your email to receive a verification code'}
            {step === 'otp' && 'Enter the 6-digit code sent to your email'}
            {step === 'password' && 'Set your new password'}
          </p>
        </div>

        {/* Step indicators */}
        <div className="mb-6 flex items-center justify-center gap-2">
          {(['email', 'otp', 'password'] as Step[]).map((s, i) => (
            <div
              key={s}
              className={cn(
                'h-2 w-8 rounded-full',
                step === s
                  ? 'bg-brand-600'
                  : i < ['email', 'otp', 'password'].indexOf(step)
                    ? 'bg-brand-300'
                    : 'bg-muted',
              )}
            />
          ))}
        </div>

        <div className="rounded-lg border border-border bg-background p-6 shadow-sm">
          {/* Step 1: Email */}
          {step === 'email' && (
            <form onSubmit={emailForm.handleSubmit(handleEmailSubmit)} className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium">
                  Email
                </label>
                <input
                  {...emailForm.register('email')}
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                {emailForm.formState.errors.email && (
                  <p className="mt-1 text-xs text-red-500">
                    {emailForm.formState.errors.email.message}
                  </p>
                )}
              </div>
              <button
                type="submit"
                disabled={forgotPassword.isPending}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {forgotPassword.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Send Code
              </button>
            </form>
          )}

          {/* Step 2: OTP */}
          {step === 'otp' && (
            <form onSubmit={otpForm.handleSubmit(handleOtpSubmit)} className="space-y-4">
              <div>
                <label htmlFor="code" className="block text-sm font-medium">
                  Verification Code
                </label>
                <input
                  {...otpForm.register('code')}
                  id="code"
                  type="text"
                  maxLength={6}
                  placeholder="000000"
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-center text-lg tracking-widest placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                {otpForm.formState.errors.code && (
                  <p className="mt-1 text-xs text-red-500">
                    {otpForm.formState.errors.code.message}
                  </p>
                )}
              </div>
              <button
                type="submit"
                disabled={verifyOtp.isPending}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {verifyOtp.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Verify
              </button>
            </form>
          )}

          {/* Step 3: New Password */}
          {step === 'password' && (
            <form onSubmit={passwordForm.handleSubmit(handlePasswordSubmit)} className="space-y-4">
              <div>
                <label htmlFor="newPassword" className="block text-sm font-medium">
                  New Password
                </label>
                <input
                  {...passwordForm.register('newPassword')}
                  id="newPassword"
                  type="password"
                  placeholder="At least 8 characters"
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                {passwordForm.formState.errors.newPassword && (
                  <p className="mt-1 text-xs text-red-500">
                    {passwordForm.formState.errors.newPassword.message}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium">
                  Confirm Password
                </label>
                <input
                  {...passwordForm.register('confirmPassword')}
                  id="confirmPassword"
                  type="password"
                  placeholder="Repeat your password"
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                {passwordForm.formState.errors.confirmPassword && (
                  <p className="mt-1 text-xs text-red-500">
                    {passwordForm.formState.errors.confirmPassword.message}
                  </p>
                )}
              </div>
              <button
                type="submit"
                disabled={resetPassword.isPending}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {resetPassword.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Reset Password
              </button>
            </form>
          )}
        </div>

        <div className="mt-4 text-center">
          <Link
            to="/login"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to login
          </Link>
        </div>
      </div>
    </div>
  );
}
