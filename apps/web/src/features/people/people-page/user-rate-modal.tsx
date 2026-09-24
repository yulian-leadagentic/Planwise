import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Coins, Save, Trash2, X } from 'lucide-react';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';
import type { UserListItem } from '@/types';

// QA3 item 1 (2026-09-24) — per-employee cost-rate override modal.
// Shows the user's override history and lets the admin:
//   • Set / change the override at a forward-effective date
//     (closes the current open-ended row at day - 1, opens a new one)
//   • Remove the override at a forward-effective date (closes with no
//     new row — user reverts to their level rate from that day on)
// The cost engine derives at read time (see cost-rate-resolver.ts), so
// project totals reflect the change on the next read.

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
  currencies: Array<{ code: string; name: string; symbol: string | null }>;
  onClose: () => void;
}

export function UserRateModal({ user, currencies, onClose }: Props) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [hourlyCost, setHourlyCost] = useState('');
  const [currency, setCurrency] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));

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
          currency: currency || null,
          effectiveFrom,
        })
        .then((r) => r.data),
    onSuccess: () => {
      invalidateAll();
      notify.success('Override saved — forward-effective from ' + effectiveFrom, {
        code: 'USER-RATE-CHANGE-201',
      });
      setHourlyCost('');
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
    !changeMutation.isPending;

  const canRemove =
    currentOverride !== null &&
    /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) &&
    !removeMutation.isPending;

  const fmt = (iso: string | null) => (iso ? iso.slice(0, 10) : '— now');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 px-5 py-4">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Coins className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            Cost rate override — {user.firstName} {user.lastName}
          </h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="rounded-md bg-slate-50 dark:bg-slate-800/60 px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
            {currentOverride ? (
              <>
                <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                  Active override:
                </span>{' '}
                <span className="font-mono">{currentOverride.hourlyCost}</span>{' '}
                {currentOverride.currency ?? ''} — since {fmt(currentOverride.startDate)}. Wins over
                the level rate on entries from that date on.
              </>
            ) : (
              <>
                No override active. This user derives their rate from their seniority level (see the
                Seniority Levels admin page).
              </>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Set / change override — forward effective
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Rate</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={hourlyCost}
                  onChange={(e) => setHourlyCost(e.target.value)}
                  placeholder="e.g. 550"
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm font-mono"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Currency</label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                >
                  <option value="">— Inherit level —</option>
                  {currencies.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}{c.symbol ? ` (${c.symbol})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Effective from</label>
                <input
                  type="date"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                />
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <button
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
                onClick={() => changeMutation.mutate()}
                disabled={!canSubmit}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
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
                      <th className="px-3 py-1.5 text-left font-medium">Currency</th>
                      <th className="px-3 py-1.5 text-left font-medium">From</th>
                      <th className="px-3 py-1.5 text-left font-medium">To</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rates.map((r) => (
                      <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-3 py-1.5 font-mono">{r.hourlyCost}</td>
                        <td className="px-3 py-1.5 text-slate-500">{r.currency ?? '—'}</td>
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
      </div>
    </div>
  );
}
