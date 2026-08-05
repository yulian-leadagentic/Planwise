import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import type { UserListItem } from '@/types';
import { inputClass } from './constants';

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

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[420px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Reset Password</h2>
          <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <p className="text-[13px] text-slate-600 dark:text-slate-300">
            Set a new password for <span className="font-semibold text-slate-900 dark:text-slate-100">{user.firstName} {user.lastName}</span>.
            They'll need to use this password on their next login.
          </p>
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">New Password *</label>
            <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} className={inputClass} />
          </div>
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Confirm Password *</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={6} className={inputClass} />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button type="button" onClick={onClose} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
            <button type="submit" disabled={reset.isPending} className="bg-amber-600 hover:bg-amber-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
              {reset.isPending ? 'Resetting...' : 'Reset Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
