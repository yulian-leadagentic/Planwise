import { useState } from 'react';
import { Pencil, X } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import { useConfirm } from '@/components/shared/confirm-dialog';
import type { SeniorityHistoryRow } from './types';

/**
 * Far-future sentinel for "open-ended" end dates. The user wants the
 * End field to always be filled (never blank) and to default to this
 * value. On the wire we still send NULL to the server for the
 * "currently active" semantics, but the input box shows the sentinel
 * so the user sees an explicit "this row runs forever" value.
 */
const OPEN_ENDED_SENTINEL = '9999-12-31';

/** Convert a YYYY-MM-DD string from the form into the wire payload.
 *  Empty or sentinel → null (= "open ended"). Anything else → as-is. */
function normalizeEnd(s: string): string | null {
  if (!s) return null;
  if (s === OPEN_ENDED_SENTINEL) return null;
  return s;
}

export function SeniorityHistorySection({
  userId,
  seniorityLevels,
}: {
  userId: number;
  seniorityLevels: any[];
}) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  // Cost (hourly rate) visibility gate. NO admin short-circuit —
  // finance:read must be explicitly granted to see rates, even for
  // admins. Matches the backend gate on /projects/:id/labor-cost.
  const showCost = can('finance', 'read');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLevelId, setNewLevelId] = useState<string>('');
  const [newStartDate, setNewStartDate] = useState<string>(new Date().toISOString().slice(0, 10));
  // Default End = far-future sentinel so the field is never blank
  // (matches the SAP / valid_to convention we use elsewhere). On
  // submit it's normalized back to NULL for the "current" semantics.
  const [newEndDate, setNewEndDate] = useState<string>(OPEN_ENDED_SENTINEL);
  // Inline-edit one row at a time. null = no row in edit mode.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLevelId, setEditLevelId] = useState<string>('');
  const [editStartDate, setEditStartDate] = useState<string>('');
  const [editEndDate, setEditEndDate] = useState<string>('');

  const { data: history = [], isLoading } = useQuery<SeniorityHistoryRow[]>({
    queryKey: ['users', userId, 'seniorities'],
    queryFn: () =>
      client.get(`/users/${userId}/seniorities`).then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['users', userId, 'seniorities'] });
    queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const addEntry = useMutation({
    mutationFn: (payload: any) =>
      client.post(`/users/${userId}/seniorities`, payload).then((r) => r.data),
    onSuccess: () => {
      refresh();
      notify.success('Seniority entry added', { code: 'USER-SENIORITY-ADD-200' });
      setShowAddForm(false);
      setNewLevelId('');
      // Reset End to the far-future sentinel, not blank, so the next
      // add starts with the default "open-ended" intent visible.
      setNewEndDate(OPEN_ENDED_SENTINEL);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add seniority entry'),
  });

  const updateEntry = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: any }) =>
      client.patch(`/users/${userId}/seniorities/${id}`, payload).then((r) => r.data),
    onSuccess: () => {
      refresh();
      notify.success('Seniority entry updated', { code: 'USER-SENIORITY-UPD-200' });
      setEditingId(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update seniority entry'),
  });

  const removeEntry = useMutation({
    mutationFn: (id: number) =>
      client.delete(`/users/${userId}/seniorities/${id}`).then((r) => r.data),
    onSuccess: () => {
      refresh();
      notify.success('Seniority entry removed', { code: 'USER-SENIORITY-DEL-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove seniority entry'),
  });

  const handleAdd = () => {
    if (!newLevelId) {
      notify.warning('Pick a seniority level', { code: 'USER-SENIORITY-ADD-400' });
      return;
    }
    if (!newStartDate) {
      notify.warning('Start date is required', { code: 'USER-SENIORITY-ADD-400' });
      return;
    }
    addEntry.mutate({
      seniorityLevelId: Number(newLevelId),
      startDate: newStartDate,
      endDate: normalizeEnd(newEndDate),
    });
  };

  const startEdit = (row: SeniorityHistoryRow) => {
    setEditingId(row.id);
    setEditLevelId(String(row.seniorityLevelId));
    setEditStartDate(row.startDate.slice(0, 10));
    // Null endDate (= "current") renders as the far-future sentinel so
    // the input field is never blank.
    setEditEndDate(row.endDate ? row.endDate.slice(0, 10) : OPEN_ENDED_SENTINEL);
  };

  const handleSaveEdit = (id: number) => {
    updateEntry.mutate({
      id,
      payload: {
        seniorityLevelId: Number(editLevelId),
        startDate: editStartDate,
        endDate: normalizeEnd(editEndDate),
      },
    });
  };

  // Show null endDate as the sentinel string (matches the input
  // default) so "current" rows read consistently across edit + view.
  const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10) : OPEN_ENDED_SENTINEL);

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 p-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <label
            className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 block"
            title="Each row is a [startDate, endDate] interval. The project cost calc looks up which row covered each time entry's date and bills at that level's hourly cost."
          >
            Seniority History
          </label>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Date-effective seniority. Open-ended adds auto-close the previous current row.
          </p>
        </div>
        {!showAddForm && (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="text-[11px] font-semibold text-blue-600 hover:text-blue-700 underline"
          >
            + Add new entry
          </button>
        )}
      </div>

      {/* Add form */}
      {showAddForm && (
        <div className="mb-3 rounded-md border border-blue-200 bg-white dark:bg-slate-900 p-3 space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Level</label>
              <select
                value={newLevelId}
                onChange={(e) => setNewLevelId(e.target.value)}
                className="w-full mt-1 px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 text-[12px] focus:border-blue-500 focus:outline-none"
              >
                <option value="">— Pick —</option>
                {seniorityLevels.map((s: any) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Start</label>
              <input
                type="date"
                value={newStartDate}
                onChange={(e) => setNewStartDate(e.target.value)}
                className="w-full mt-1 px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 text-[12px] focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label
                className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider"
                title="Defaults to 9999-12-31 (open-ended / 'current'). Set a real end date to record a closed historical period."
              >
                End <span className="text-slate-400 dark:text-slate-500 normal-case">(9999-12-31 = current)</span>
              </label>
              <input
                type="date"
                value={newEndDate}
                onChange={(e) => setNewEndDate(e.target.value)}
                className="w-full mt-1 px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 text-[12px] focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => { setShowAddForm(false); setNewLevelId(''); setNewEndDate(''); }}
              className="px-2.5 py-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-800 dark:hover:text-slate-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAdd}
              disabled={addEntry.isPending}
              className="px-2.5 py-1 text-[11px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50"
            >
              {addEntry.isPending ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      )}

      {/* History list */}
      {isLoading ? (
        <p className="text-[12px] text-slate-400 dark:text-slate-500 italic">Loading…</p>
      ) : history.length === 0 ? (
        <p className="text-[12px] text-slate-400 dark:text-slate-500 italic">
          No seniority history. Add the first entry to start tracking cost.
        </p>
      ) : (
        <div className="space-y-1.5">
          {history.map((row) => {
            const isOpen = row.endDate === null;
            const isEditing = editingId === row.id;
            const hourlyCost = row.seniorityLevel.defaultHourlyCost;
            const currency = row.seniorityLevel.currency;
            if (isEditing) {
              return (
                <div key={row.id} className="rounded-md border border-amber-300 bg-amber-50/40 p-2 space-y-2">
                  <div className="grid grid-cols-3 gap-2">
                    <select
                      value={editLevelId}
                      onChange={(e) => setEditLevelId(e.target.value)}
                      className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-[12px]"
                    >
                      {seniorityLevels.map((s: any) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                    <input
                      type="date"
                      value={editStartDate}
                      onChange={(e) => setEditStartDate(e.target.value)}
                      className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-[12px]"
                    />
                    <input
                      type="date"
                      value={editEndDate}
                      onChange={(e) => setEditEndDate(e.target.value)}
                      placeholder="current"
                      className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-[12px]"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-800 dark:hover:text-slate-100"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSaveEdit(row.id)}
                      disabled={updateEntry.isPending}
                      className="px-2 py-0.5 text-[11px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                </div>
              );
            }
            return (
              <div
                key={row.id}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-3 py-2 text-[12px]',
                  isOpen ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900',
                )}
              >
                <span className="font-semibold text-slate-800 dark:text-slate-100">{row.seniorityLevel.name}</span>
                {isOpen && (
                  <span className="rounded-full bg-emerald-100 text-emerald-700 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                    Current
                  </span>
                )}
                <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                  {fmtDate(row.startDate)} → {fmtDate(row.endDate)}
                </span>
                {/* Hourly cost shown only to users with finance:read.
                    Mirrors the backend gate on the cost endpoints —
                    non-finance users see the seniority + dates so they
                    can validate the history, just not the money. */}
                {showCost && hourlyCost != null && (
                  <span className="text-slate-400 dark:text-slate-500">· {hourlyCost}{currency ? ` ${currency}` : ''}/h</span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => startEdit(row)}
                    className="text-slate-400 dark:text-slate-500 hover:text-blue-600 p-1 rounded"
                    title="Edit"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (await confirm(`Remove this seniority entry?`)) removeEntry.mutate(row.id);
                    }}
                    className="text-slate-400 dark:text-slate-500 hover:text-red-600 p-1 rounded"
                    title="Remove"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
