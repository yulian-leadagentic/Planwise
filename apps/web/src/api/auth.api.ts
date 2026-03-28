import client from './client';
import type { ApiResponse, User } from '@/types';

export interface LoginPayload {
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  user: User;
}

export interface ForgotPasswordPayload {
  email: string;
}

export interface VerifyOtpPayload {
  email: string;
  code: string;
}

export interface ResetPasswordPayload {
  email: string;
  code: string;
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

  verifyOtp: (payload: VerifyOtpPayload) =>
    client.post<ApiResponse<{ valid: boolean }>>('/auth/verify-otp', payload).then((r) => r.data.data),

  resetPassword: (payload: ResetPasswordPayload) =>
    client.post<ApiResponse<{ message: string }>>('/auth/reset-password', payload).then((r) => r.data.data),

  getMe: () =>
    client.get<ApiResponse<User>>('/auth/me').then((r) => r.data.data),

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
};
