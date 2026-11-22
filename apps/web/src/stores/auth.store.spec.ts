import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore, type AuthUser } from './auth.store';

const USER = { id: 7, email: 'dana@amec.co.il', firstName: 'Dana', lastName: 'Levi' } as unknown as AuthUser;

describe('auth store — forced password change flag (permissions round 3)', () => {
  beforeEach(() => useAuthStore.getState().clearAuth());

  it('keeps mustChangePassword from the login response', () => {
    useAuthStore.getState().setAuth('t', { ...USER, mustChangePassword: true });
    expect(useAuthStore.getState().user?.mustChangePassword).toBe(true);
  });

  it('setMustChangePassword flips the flag on the cached user', () => {
    useAuthStore.getState().setAuth('t', USER);
    useAuthStore.getState().setMustChangePassword(true);
    expect(useAuthStore.getState().user).toMatchObject({ id: 7, mustChangePassword: true });
    useAuthStore.getState().setMustChangePassword(false);
    expect(useAuthStore.getState().user?.mustChangePassword).toBe(false);
  });

  it('is a no-op when signed out', () => {
    useAuthStore.getState().setMustChangePassword(true);
    expect(useAuthStore.getState().user).toBeNull();
  });
});
