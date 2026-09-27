import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import type { UserListItem } from '@/types';
import { Modal } from '@/components/shared/modal';
import { TextField } from '@/components/shared/field';

// People UX M1 (E-05) — the shell (dialog role, aria-modal, focus trap,
// Escape, focus return, dirty guard) comes from the shared Modal.
// This component owns just the form + mutation; a dirty flag drives the
// backdrop/Escape "discard changes?" prompt.
export function ResetPasswordModal({
  user,
  onClose,
}: {
  user: UserListItem;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const reset = useMutation({
    mutationFn: () => client.patch(`/users/${user.id}`, { password }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      notify.success(`Password reset for ${user.firstName} ${user.lastName}`, { code: 'USER-PWD-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to reset password'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) {
      notify.warning('Password must be at least 6 characters', { code: 'USER-PWD-400' });
      return;
    }
    if (password !== confirm) {
      notify.warning('Passwords do not match', { code: 'USER-PWD-400' });
      return;
    }
    reset.mutate();
  };

  const isDirty = password.length > 0 || confirm.length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title="Reset Password"
      widthClass="w-[420px] max-w-[92vw]"
      isDirty={isDirty}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="reset-password-form"
            disabled={reset.isPending}
            className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50"
          >
            {reset.isPending ? 'Resetting...' : 'Reset Password'}
          </button>
        </>
      }
    >
      <form id="reset-password-form" onSubmit={handleSubmit} className="space-y-4">
        <p className="text-[13px] text-slate-600 dark:text-slate-300">
          Set a new password for{' '}
          <span className="font-semibold text-slate-900 dark:text-slate-100">
            {user.firstName} {user.lastName}
          </span>
          . They'll need to use this password on their next login.
        </p>
        <TextField
          label="New Password"
          name="password"
          type="password"
          autoFocus
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <TextField
          label="Confirm Password"
          name="passwordConfirm"
          type="password"
          required
          minLength={6}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </form>
    </Modal>
  );
}
