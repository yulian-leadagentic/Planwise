import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Clock, Pencil, Plus, Save, Trash2, X, GraduationCap } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';

// QA3 item 1 (2026-09-24) — rate history is displayed and edited via a
// modal. The row's Hourly Cost cell shows the currently-effective rate
// (open-ended row on `seniority_rates`, or `defaultHourlyCost` fallback);
// clicking "Change rate" opens the modal that closes the current row
// and opens a new one at the chosen effective-from date.
type SeniorityRateRow = {
  id: number;
  seniorityLevelId: number;
  hourlyCost: string | number;
  currency: string | null;
  startDate: string;
  endDate: string | null;
};

// Seniority Levels — user-managed ladder (Junior, Mid, Senior, …). Each org
// defines their own. Used by EmployeeRole + RoleCostRate (M5).

type SeniorityRow = {
  id: number;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  defaultHourlyCost: string | number | null;
  currency: string | null;
};

type FormState = {
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  defaultHourlyCost: string;
  currency: string;
};

const emptyForm: FormState = {
  code: '',
  name: '',
  sortOrder: 0,
  isActive: true,
  defaultHourlyCost: '',
  currency: '',
};

export function SeniorityLevelsPage() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  // scrollRef was for the hand-rolled table; DataTable owns its own.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  // QA3 item 1 — rate-history modal targets one level at a time.
  const [rateModalFor, setRateModalFor] = useState<SeniorityRow | null>(null);

  const { data, isLoading } = useQuery<SeniorityRow[]>({
    queryKey: ['admin', 'seniority-levels'],
    queryFn: () =>
      client.get('/admin/config/seniority-levels').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  // Currency catalog for the cost-field unit picker.
  const { data: currencies = [] } = useQuery<Array<{ code: string; name: string; symbol: string | null }>>({
    queryKey: ['admin', 'currencies'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/config/currencies').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const createMutation = useMutation({
    mutationFn: (payload: FormState) =>
      client
        .post('/admin/config/seniority-levels', {
          code: payload.code,
          name: payload.name,
          sortOrder: payload.sortOrder,
          defaultHourlyCost: payload.defaultHourlyCost === '' ? null : payload.defaultHourlyCost,
          currency: payload.currency || null,
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'seniority-levels'] });
      notify.success('Seniority level created', { code: 'SENIORITY-CREATE-201' });
      setShowCreate(false);
      setForm(emptyForm);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create seniority level'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...payload }: FormState & { id: number }) =>
      client
        .patch(`/admin/config/seniority-levels/${id}`, {
          code: payload.code,
          name: payload.name,
          sortOrder: payload.sortOrder,
          isActive: payload.isActive,
          defaultHourlyCost: payload.defaultHourlyCost === '' ? null : payload.defaultHourlyCost,
          currency: payload.currency || null,
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'seniority-levels'] });
      notify.success('Seniority level updated', { code: 'SENIORITY-UPDATE-200' });
      setEditingId(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update seniority level'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      client.delete(`/admin/config/seniority-levels/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'seniority-levels'] });
      notify.success('Seniority level deleted', { code: 'SENIORITY-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete seniority level'),
  });

  const startEdit = (row: SeniorityRow) => {
    setEditingId(row.id);
    setShowCreate(false);
    setForm({
      code: row.code,
      name: row.name,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      defaultHourlyCost: row.defaultHourlyCost != null ? String(row.defaultHourlyCost) : '',
      currency: row.currency ?? '',
    });
  };

  const rows = data ?? [];

  // Column defs for the shared DataTable — sorting disabled to
  // preserve the server-ordered no-sort behavior of the prior page.
  const columns = useMemo<ColumnDef<SeniorityRow, unknown>[]>(() => [
    { accessorKey: 'code', header: 'Code', enableSorting: false, size: 128,
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.code}</span> },
    { accessorKey: 'name', header: 'Name', enableSorting: false,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
    { id: 'cost', header: 'Hourly Cost', enableSorting: false, size: 160,
      cell: ({ row }) => (
        row.original.defaultHourlyCost != null ? (
          <span className="font-mono text-sm text-slate-800 dark:text-slate-100">
            {row.original.defaultHourlyCost}
            {row.original.currency ? <span className="ml-1 text-[11px] text-slate-400 dark:text-slate-500">{row.original.currency}</span> : null}
            <span className="ml-1 text-[11px] text-slate-400 dark:text-slate-500">/h</span>
          </span>
        ) : (
          <span className="text-xs italic text-slate-400 dark:text-slate-500">—</span>
        )
      ) },
    { accessorKey: 'sortOrder', header: 'Order', enableSorting: false, size: 80,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.sortOrder}</span> },
    { id: 'status', header: 'Status', enableSorting: false, size: 96,
      cell: ({ row }) => <StatusBadge status={row.original.isActive ? 'active' : 'inactive'} /> },
    { id: 'actions', header: 'Actions', enableSorting: false, size: 200,
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => setRateModalFor(row.original)}
            aria-label={`Change rate for ${row.original.name}`}
            className="inline-flex items-center gap-1 text-xs text-emerald-600 hover:underline"
            title="View rate history and change the rate with a forward-effective date"
          >
            <Clock className="h-3 w-3" aria-hidden="true" /> Change rate
          </button>
          <button
            onClick={() => startEdit(row.original)}
            aria-label={`Edit level ${row.original.name}`}
            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
          >
            <Pencil className="h-3 w-3" aria-hidden="true" /> Edit
          </button>
          <button
            onClick={async () => {
              if (await confirm(`Delete seniority level "${row.original.name}"?`)) {
                deleteMutation.mutate(row.original.id);
              }
            }}
            aria-label={`Delete level ${row.original.name}`}
            className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline"
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" /> Delete
          </button>
        </div>
      ),
    },
  ], []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Seniority Levels"
        description="Define the seniority ladder used by employee roles and cost rates. Each level is a row; order them from junior to senior using the sort order."
        actions={
          !showCreate && editingId == null ? (
            <button
              onClick={() => {
                setShowCreate(true);
                setForm({ ...emptyForm, sortOrder: (rows.length + 1) * 10 });
              }}
              className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" /> Add level
            </button>
          ) : null
        }
      />

      {/* Create + edit forms hoisted above the table — DataTable
          doesn't do per-row overrides via colSpan, so the inline
          edit that used to REPLACE the row now sits here. Same
          fields, same save/cancel, just a different position. */}
      {showCreate && (
        <FormCard
          mode="create"
          form={form}
          setForm={setForm}
          onSave={() => createMutation.mutate(form)}
          onCancel={() => setShowCreate(false)}
          saving={createMutation.isPending}
          currencies={currencies}
        />
      )}
      {editingId != null && (
        <FormCard
          mode="edit"
          form={form}
          setForm={setForm}
          onSave={() => updateMutation.mutate({ id: editingId, ...form })}
          onCancel={() => setEditingId(null)}
          saving={updateMutation.isPending}
          currencies={currencies}
        />
      )}

      {isLoading ? (
        <TableSkeleton rows={3} cols={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={GraduationCap}
          title="No seniority levels defined"
          description="Add your first level to start (e.g. Junior, Mid, Senior)."
        />
      ) : (
        <DataTable columns={columns} data={rows} pageSize={1000} />
      )}

      {rateModalFor && (
        <RateHistoryModal
          level={rateModalFor}
          currencies={currencies}
          onClose={() => setRateModalFor(null)}
        />
      )}
    </div>
  );
}

// QA3 item 1 — rate history + "Change rate" modal per seniority level.
// Lists every effective-dated rate row (open-ended at top), and lets the
// admin set a new rate with a forward-effective date. Submit closes the
// current open-ended row at (effectiveFrom - 1 day) and opens a new one.
// Existing time entries pre-effective-from keep their prior rate; the
// cost engine re-derives at read time (see cost-rate-resolver.ts).
function RateHistoryModal({
  level,
  currencies,
  onClose,
}: {
  level: SeniorityRow;
  currencies: Array<{ code: string; name: string; symbol: string | null }>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [hourlyCost, setHourlyCost] = useState('');
  const [currency, setCurrency] = useState(level.currency ?? '');
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));

  const { data: rates = [], isLoading } = useQuery<SeniorityRateRow[]>({
    queryKey: ['admin', 'seniority-rates', level.id],
    queryFn: () =>
      client.get(`/admin/config/seniority-levels/${level.id}/rates`).then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const changeMutation = useMutation({
    mutationFn: () =>
      client
        .post(`/admin/config/seniority-levels/${level.id}/rates/change`, {
          hourlyCost,
          currency: currency || null,
          effectiveFrom,
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'seniority-rates', level.id] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'seniority-levels'] });
      notify.success('Rate change saved — forward-effective from ' + effectiveFrom, {
        code: 'SENIORITY-RATE-CHANGE-201',
      });
      setHourlyCost('');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to change rate'),
  });

  const canSubmit =
    hourlyCost.trim().length > 0 &&
    !Number.isNaN(Number(hourlyCost)) &&
    /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) &&
    !changeMutation.isPending;

  const fmt = (iso: string | null) => (iso ? iso.slice(0, 10) : '— now');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 px-5 py-4">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
            Rate history — {level.name}
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
          <div>
            <h4 className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Change rate — forward effective
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">New rate</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={hourlyCost}
                  onChange={(e) => setHourlyCost(e.target.value)}
                  placeholder="e.g. 500"
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
                  <option value="">— Pick —</option>
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
            <div className="mt-3 flex justify-end">
              <button
                onClick={() => changeMutation.mutate()}
                disabled={!canSubmit}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <Save className="h-3 w-3" aria-hidden="true" />
                {changeMutation.isPending ? 'Saving…' : 'Change rate'}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
              Closes the current row at the day before, opens a new row starting {effectiveFrom || '…'}.
              Entries before that date keep the prior rate.
            </p>
          </div>

          <div>
            <h4 className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              History
            </h4>
            {isLoading ? (
              <p className="text-xs text-slate-400">Loading…</p>
            ) : rates.length === 0 ? (
              <p className="text-xs text-slate-400 italic">
                No rate history yet — the level uses its default hourly cost until you set one.
              </p>
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

function FormCard({
  mode,
  form,
  setForm,
  onSave,
  onCancel,
  saving,
  currencies,
}: {
  mode: 'create' | 'edit';
  form: FormState;
  setForm: (f: FormState) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  currencies: Array<{ code: string; name: string; symbol: string | null }>;
}) {
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm({ ...form, [key]: value });

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Code <span className="text-red-600">*</span>
          </label>
          <input
            value={form.code}
            onChange={(e) => update('code', e.target.value.toLowerCase().replace(/\s+/g, '_'))}
            placeholder="senior"
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm font-mono"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Name <span className="text-red-600">*</span>
          </label>
          <input
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder="Senior"
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label
            className="mb-1 block text-xs font-medium text-muted-foreground"
            title="Display order in lists (low → high). Use 10 / 20 / 30 / … so you can insert new levels between existing ones (e.g. add Mid-Senior=25 between Mid=20 and Senior=30) without reshuffling the rest."
          >
            Sort order
          </label>
          <input
            type="number"
            value={form.sortOrder}
            onChange={(e) => update('sortOrder', Number(e.target.value))}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label
            className="mb-1 block text-xs font-medium text-muted-foreground"
            title="Default hourly cost for employees at this seniority level. Used by project labor-cost calculations: cost = logged hours × rate. Leave blank if this level has no fixed cost."
          >
            Hourly Cost
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={form.defaultHourlyCost}
            onChange={(e) => update('defaultHourlyCost', e.target.value)}
            placeholder="e.g. 80.00"
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm font-mono"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Currency</label>
          <select
            value={form.currency}
            onChange={(e) => update('currency', e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          >
            <option value="">— Pick currency —</option>
            {currencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}{c.symbol ? ` (${c.symbol})` : ''} — {c.name}
              </option>
            ))}
          </select>
        </div>
        {mode === 'edit' && (
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Active</label>
            <label className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => update('isActive', e.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-sm">Available for new assignments</span>
            </label>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
        >
          <X className="h-3 w-3" /> Cancel
        </button>
        <button
          onClick={onSave}
          disabled={saving || !form.code.trim() || !form.name.trim()}
          className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
         aria-label="Save">
          <Save className="h-3 w-3"  aria-hidden="true" /> {mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>
    </div>
  );
}
