import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Coins, Save, Trash2 } from 'lucide-react';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { Modal } from '@/components/shared/modal';
import { TextField } from '@/components/shared/field';
import type { UserListItem } from '@/types';

// QA3 round-3 items 3b + 5 — per-employee cost-rate override modal.
//
// People UX M1 (E-05) — the shell (dialog role, aria-modal, Tab trap,
// Escape, focus return) now comes from the shared Modal. This
// component owns just the form + mutations.
//
// U1 note: every internal button already carries type="button" so it
// stays clear of any outer form (edit-person-modal renders us as a
// sibling to its own <form>).

type UserRateRow = {
  id: number;
  userId: number;
  hourlyCost: string | number;
  currency: string | null;
  startDate: string;
  endDate: string | null;
};

interface Props {
  user: UserListItem;
  onClose: () => void;
}

export function UserRateModal({ user, onClose }: Props) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [hourlyCost, setHourlyCost] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  // Empty = "Current" (open-ended). Any date = bounded window.
  const [effectiveTo, setEffectiveTo] = useState('');

  const { data: rates = [], isLoading } = useQuery<UserRateRow[]>({
    queryKey: ['admin', 'user-rates', user.id],
    queryFn: () =>
      client.get(`/admin/config/user-rates/${user.id}`).then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const currentOverride = rates.find((r) => r.endDate === null) ?? null;

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'user-rates', user.id] });
    queryClient.invalidateQueries({ queryKey: ['users'] });
    // Cost surfaces derive at read time; nudge the project queries too.
    queryClient.invalidateQueries({ queryKey: ['projects'] });
  };

  const changeMutation = useMutation({
    mutationFn: () =>
      client
        .post(`/admin/config/user-rates/${user.id}/change`, {
          hourlyCost,
          currency: null,
          effectiveFrom,
          ...(effectiveTo ? { effectiveTo } : {}),
        })
        .then((r) => r.data),
    onSuccess: () => {
      invalidateAll();
      const msg = effectiveTo
        ? `Bounded override saved — ${effectiveFrom} → ${effectiveTo}`
        : `Override saved — forward-effective from ${effectiveFrom}`;
      notify.success(msg, { code: 'USER-RATE-CHANGE-201' });
      setHourlyCost('');
      setEffectiveTo('');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to save override'),
  });

  const removeMutation = useMutation({
    mutationFn: () =>
      client
        .delete(`/admin/config/user-rates/${user.id}/current`, {
          data: { effectiveFrom },
        })
        .then((r) => r.data),
    onSuccess: () => {
      invalidateAll();
      notify.success('Override removed — user reverts to level rate from ' + effectiveFrom, {
        code: 'USER-RATE-REMOVE-200',
      });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove override'),
  });

  const canSubmit =
    hourlyCost.trim().length > 0 &&
    !Number.isNaN(Number(hourlyCost)) &&
    /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) &&
    (effectiveTo === '' ||
      (/^\d{4}-\d{2}-\d{2}$/.test(effectiveTo) && effectiveTo >= effectiveFrom)) &&
    !changeMutation.isPending;

  const canRemove =
    currentOverride !== null &&
    /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) &&
    !removeMutation.isPending;

  const fmt = (iso: string | null) => (iso ? iso.slice(0, 10) : '— now');

  const isDirty = hourlyCost.trim().length > 0 || effectiveTo.trim().length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Coins className="h-4 w-4 text-blue-600" aria-hidden="true" />
          Cost rate override — {user.firstName} {user.lastName}
        </span>
      }
      widthClass="w-full max-w-lg"
      isDirty={isDirty}
    >
      <div className="space-y-4">
        <div className="rounded-md bg-slate-50 dark:bg-slate-800/60 px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
          {currentOverride ? (
            <>
              <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                Active override:
              </span>{' '}
              <span className="font-mono">₪{currentOverride.hourlyCost}</span>/h — since{' '}
              {fmt(currentOverride.startDate)}. Wins over the level rate on entries from that date on.
            </>
          ) : (
            <>
              No override active. This user derives their rate from their labor category (see the
              Labor Categories admin page).
            </>
          )}
        </div>

        <div>
          <h4 className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            Set / change override — forward effective
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <TextField
              label="Rate (₪/h)"
              name="user-rate-hourly"
              type="number"
              step="0.01"
              min={0}
              value={hourlyCost}
              onChange={(e) => setHourlyCost(e.target.value)}
              placeholder="e.g. 550"
              inputClassName="font-mono"
            />
            <TextField
              label="Effective from"
              name="user-rate-effective-from"
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
            <TextField
              label="End (optional)"
              name="user-rate-effective-to"
              type="date"
              value={effectiveTo}
              onChange={(e) => setEffectiveTo(e.target.value)}
              min={effectiveFrom || undefined}
              placeholder="Current"
              hint="Leave empty = current"
            />
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={async () => {
                if (!canRemove) return;
                if (
                  await confirm(
                    `Remove override for ${user.firstName} ${user.lastName} from ${effectiveFrom}?\n\nEntries from that date on will use the level rate again.`,
                  )
                ) {
                  removeMutation.mutate();
                }
              }}
              disabled={!canRemove}
              className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-900 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                currentOverride
                  ? 'Close the current override — user reverts to level rate'
                  : 'No active override to remove'
              }
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              {removeMutation.isPending ? 'Removing…' : 'Remove override'}
            </button>
            <button
              type="button"
              onClick={() => changeMutation.mutate()}
              disabled={!canSubmit}
              className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Save className="h-3 w-3" aria-hidden="true" />
              {changeMutation.isPending ? 'Saving…' : currentOverride ? 'Change override' : 'Set override'}
            </button>
          </div>
        </div>

        <div>
          <h4 className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            History
          </h4>
          {isLoading ? (
            <p className="text-xs text-slate-400">Loading…</p>
          ) : rates.length === 0 ? (
            <p className="text-xs text-slate-400 italic">No override history yet.</p>
          ) : (
            <div className="overflow-hidden rounded-md border border-slate-200 dark:border-slate-700">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 dark:bg-slate-800/60">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Rate</th>
                    <th className="px-3 py-1.5 text-left font-medium">From</th>
                    <th className="px-3 py-1.5 text-left font-medium">To</th>
                  </tr>
                </thead>
                <tbody>
                  {rates.map((r) => (
                    <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-3 py-1.5 font-mono">₪{r.hourlyCost}/h</td>
                      <td className="px-3 py-1.5 text-slate-500">{fmt(r.startDate)}</td>
                      <td className="px-3 py-1.5 text-slate-500">
                        {r.endDate === null ? (
                          <span className="rounded bg-emerald-100 dark:bg-emerald-900/40 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">
                            Current
                          </span>
                        ) : (
                          fmt(r.endDate)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
