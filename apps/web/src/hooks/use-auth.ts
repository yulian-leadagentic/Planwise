import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { notify } from '@/lib/notify';
import { authApi } from '@/api/auth.api';
import type { LoginPayload, ForgotPasswordPayload, VerifyOtpPayload, ResetPasswordPayload } from '@/api/auth.api';
import { useAuthStore } from '@/stores/auth.store';

export function useLogin() {
  const setAuth = useAuthStore((s) => s.setAuth);
  const navigate = useNavigate();

  return useMutation({
    mutationFn: (payload: LoginPayload) => authApi.login(payload),
    onSuccess: (data) => {
      setAuth(data.accessToken, data.user);
      navigate('/');
      // A forced password change (permissions round 3) shows its own
      // screen first; skip the greeting until the user is really in.
      if (!data.user.mustChangePassword) {
        notify.success('Welcome back!', { code: 'AUTH-CREATE-200' });
      }
    },
    onError: (err: any) => {
      notify.apiError(err, 'Invalid email or password');
    },
  });
}

export function useLogout() {
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: () => authApi.logout(),
    onSettled: () => {
      clearAuth();
      queryClient.clear();
      navigate('/login');
    },
  });
}

export function useMe() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setUser = useAuthStore((s) => s.setUser);

  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const user = await authApi.getMe();
      setUser(user);
      return user;
    },
    enabled: isAuthenticated,
    staleTime: 10 * 60 * 1000,
  });
}

export function useUpdateMe() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: Parameters<typeof authApi.updateMe>[0]) => authApi.updateMe(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me'] });
      notify.success('Profile updated', { code: 'AUTH-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to update profile');
    },
  });
}

export function useUpdatePassword() {
  return useMutation({
    mutationFn: (payload: Parameters<typeof authApi.updatePassword>[0]) => authApi.updatePassword(payload),
    onSuccess: () => {
      notify.success('Password updated', { code: 'AUTH-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to update password');
    },
  });
}

export function useUploadAvatar() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (file: File) => authApi.uploadAvatar(file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me'] });
      notify.success('Avatar updated', { code: 'AUTH-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to upload avatar');
    },
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (payload: ForgotPasswordPayload) => authApi.forgotPassword(payload),
    onSuccess: () => {
      // Same wording whether or not the address has an account — the API
      // never says which (permissions round 3).
      notify.info('Check your email', {
        description: 'If an account exists for that address, we sent it a 6-digit code. It expires in 10 minutes.',
        code: 'AUTH-CREATE-200',
      });
    },
    onError: (err: any) => {
      notify.apiError(err, "Couldn't send the code");
    },
  });
}

export function useVerifyOtp() {
  return useMutation({
    mutationFn: (payload: VerifyOtpPayload) => authApi.verifyOtp(payload),
    onError: (err: any) => {
      notify.apiError(err, 'Invalid or expired code');
    },
  });
}

export function useResetPassword() {
  const navigate = useNavigate();

  return useMutation({
    mutationFn: (payload: ResetPasswordPayload) => authApi.resetPassword(payload),
    onSuccess: () => {
      notify.success('Password reset successfully', { code: 'AUTH-UPDATE-200' });
      navigate('/login');
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to reset password');
    },
  });
}
