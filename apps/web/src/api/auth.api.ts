import client from './client';
import type { ApiResponse, User } from '@/types';
import type { AuthUser } from '@/stores/auth.store';

export interface LoginPayload {
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  /** Carries `mustChangePassword` (permissions round 3). */
  user: AuthUser;
}

export interface ForgotPasswordPayload {
  email: string;
}

export interface VerifyOtpPayload {
  email: string;
  code: string;
}

export interface ResetPasswordPayload {
  resetToken: string;
  newPassword: string;
}

export interface UpdatePasswordPayload {
  currentPassword: string;
  newPassword: string;
}

export const authApi = {
  login: (payload: LoginPayload) =>
    client.post<ApiResponse<LoginResponse>>('/auth/login', payload).then((r) => r.data.data),

  refresh: () =>
    client.post<ApiResponse<{ accessToken: string }>>('/auth/refresh', null, { withCredentials: true }).then((r) => r.data.data),

  logout: () =>
    client.post('/auth/logout').then((r) => r.data),

  forgotPassword: (payload: ForgotPasswordPayload) =>
    client.post<ApiResponse<{ message: string }>>('/auth/forgot-password', payload).then((r) => r.data.data),

  // A correct code returns a one-time reset token (15 minutes) for /auth/reset-password.
  verifyOtp: (payload: VerifyOtpPayload) =>
    client.post<ApiResponse<{ resetToken: string }>>('/auth/verify-otp', payload).then((r) => r.data.data),

  resetPassword: (payload: ResetPasswordPayload) =>
    client.post<ApiResponse<{ message: string }>>('/auth/reset-password', payload).then((r) => r.data.data),

  getMe: () =>
    client.get<ApiResponse<AuthUser>>('/auth/me').then((r) => r.data.data),

  updateMe: (payload: Partial<User>) =>
    client.patch<ApiResponse<User>>('/auth/me', payload).then((r) => r.data.data),

  updatePassword: (payload: UpdatePasswordPayload) =>
    client.patch<ApiResponse<{ message: string }>>('/auth/me/password', payload).then((r) => r.data.data),

  uploadAvatar: (file: File) => {
    const formData = new FormData();
    formData.append('avatar', file);
    return client.post<ApiResponse<{ avatarUrl: string }>>('/auth/me/avatar', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data.data);
  },

  // Public list of enabled SSO providers. The login page reads this
  // to decide which "Sign in with X" button to render. Contains no
  // secrets or tenant ids — safe to fetch unauthenticated.
  getOidcProviders: () =>
    client
      .get<ApiResponse<{ provider: string; enabled: boolean }[]>>('/auth/oidc/providers')
      .then((r) => r.data.data ?? []),
};
