import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Clock, Pencil, Plus, Save, Trash2, X, GraduationCap } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { TextField, Field } from '@/components/shared/field';
import { Modal } from '@/components/shared/modal';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { usePermissions } from '@/hooks/use-permissions';

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
  // People UX M2b — the API's shared resolver output at level scope
  // (open-ended `seniority_rates` row → level default). Rendered in the
  // "Hourly Cost" column so admins see the number cost calculations
  // actually pull, not the stale default.
  effectiveHourlyCost?: string | number | null;
  effectiveRateSource?: 'level_rate_history' | 'level_default' | null;
  effectiveCurrency?: string | null;
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
  // People UX M2b — finance gate. The rate column + rate modal are the
  // same shape as the ones on People (finance:read there via
  // `showEffectiveRate`) so we mirror that check here.
  const { can } = usePermissions();
  const showRates = can('finance', 'read');
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
      notify.success('Labor category created', { code: 'SENIORITY-CREATE-201' });
      setShowCreate(false);
      setForm(emptyForm);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create labor category'),
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
      notify.success('Labor category updated', { code: 'SENIORITY-UPDATE-200' });
      setEditingId(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update labor category'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      client.delete(`/admin/config/seniority-levels/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'seniority-levels'] });
      notify.success('Labor category deleted', { code: 'SENIORITY-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete labor category'),
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
  //
  // People UX M2b (E-03 / E-23):
  //   • The Hourly Cost column now reads `effectiveHourlyCost` (the
  //     API-side layered read: open rate history row → level default),
  //     so the number the admin sees matches what the cost engine
  //     resolves. The old value read straight off `defaultHourlyCost`,
  //     which lied whenever an admin had changed the rate via the
  //     "Change rate" modal (that never touches the default column).
  //   • The rate column + "Change rate" action are gated on
  //     `finance:read`; non-finance admins see the level list without
  //     the money.
  const columns = useMemo<ColumnDef<SeniorityRow, unknown>[]>(() => {
    const base: ColumnDef<SeniorityRow, unknown>[] = [
      { accessorKey: 'code', header: 'Code', enableSorting: false, size: 128,
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.code}</span> },
      { accessorKey: 'name', header: 'Name', enableSorting: false,
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
    ];
    if (showRates) {
      base.push({ id: 'cost', header: 'Hourly Cost', enableSorting: false, size: 180,
        cell: ({ row }) => {
          const eff = row.original.effectiveHourlyCost;
          if (eff == null) {
            return <span className="text-xs italic text-slate-400 dark:text-slate-500">—</span>;
          }
          const isDefault = row.original.effectiveRateSource === 'level_default';
          return (
            <span className="font-mono text-sm text-slate-800 dark:text-slate-100">
              ₪{eff}
              <span className="ml-1 text-[11px] text-slate-400 dark:text-slate-500">/h</span>
              {isDefault && (
                <span
                  className="ml-1.5 inline-block rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:text-slate-400"
                  title="No rate history yet — showing the labor category default until a rate is set."
                >
                  default
                </span>
              )}
            </span>
          );
        } });
    }
    base.push(
      { accessorKey: 'sortOrder', header: 'Order', enableSorting: false, size: 80,
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.sortOrder}</span> },
      { id: 'status', header: 'Status', enableSorting: false, size: 96,
        cell: ({ row }) => <StatusBadge status={row.original.isActive ? 'active' : 'inactive'} /> },
      { id: 'actions', header: 'Actions', enableSorting: false, enableColumnFilter: false, size: 200,
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-2">
            {showRates && (
              <button
                onClick={() => setRateModalFor(row.original)}
                aria-label={`Change rate for ${row.original.name}`}
                className="inline-flex items-center gap-1 text-xs text-emerald-600 hover:underline"
                title="View rate history and change the rate with a forward-effective date"
              >
                <Clock className="h-3 w-3" aria-hidden="true" /> Change rate
              </button>
            )}
            <button
              onClick={() => startEdit(row.original)}
              aria-label={`Edit labor category ${row.original.name}`}
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
            >
              <Pencil className="h-3 w-3" aria-hidden="true" /> Edit
            </button>
            <button
              onClick={async () => {
                // People UX U2 — deleting a catalog category is destructive
                // (employees may still reference it via UserSeniority
                // history). Danger variant + verb button.
                const ok = await confirm(
                  `Employees still holding this labor category will fall back to none; historical entries stay attached.`,
                  {
                    title: `Delete labor category "${row.original.name}"?`,
                    variant: 'danger',
                    confirmLabel: 'Delete',
                  },
                );
                if (ok) deleteMutation.mutate(row.original.id);
              }}
              aria-label={`Delete labor category ${row.original.name}`}
              className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" /> Delete
            </button>
          </div>
        ),
      },
    );
    return base;
  }, [showRates, confirm, deleteMutation]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Labor Categories"
        description="Define the labor-category ladder used by employee roles and cost rates. Each category is a row; order them from junior to senior using the sort order."
        actions={
          !showCreate && editingId == null ? (
            <button
              onClick={() => {
                setShowCreate(true);
                setForm({ ...emptyForm, sortOrder: (rows.length + 1) * 10 });
              }}
              className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" /> Add category
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
          editingRow={null}
          showRates={showRates}
          onOpenRateModal={null}
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
          editingRow={rows.find((r) => r.id === editingId) ?? null}
          showRates={showRates}
          onOpenRateModal={
            showRates
              ? () => {
                  const target = rows.find((r) => r.id === editingId);
                  if (target) setRateModalFor(target);
                }
              : null
          }
        />
      )}

      {isLoading ? (
        <TableSkeleton rows={3} cols={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={GraduationCap}
          title="No labor categories defined yet"
          description="Add your first category to start (e.g. Junior, Mid, Senior)."
        />
      ) : (
        <DataTable columns={columns} data={rows} pageSize={1000} enableColumnFilters />
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

  const isDirty = hourlyCost.trim().length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Rate history — ${level.name}`}
      widthClass="w-full max-w-lg"
      isDirty={isDirty}
    >
      <div className="space-y-4">
        <div>
          <h4 className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            Change rate — forward effective
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <TextField
              label="New rate"
              name="seniority-rate-new"
              type="number"
              step="0.01"
              min={0}
              value={hourlyCost}
              onChange={(e) => setHourlyCost(e.target.value)}
              placeholder="e.g. 500"
              inputClassName="font-mono"
            />
            <TextField
              label="Effective from"
              name="seniority-rate-effective-from"
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => changeMutation.mutate()}
              disabled={!canSubmit}
              className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Save className="h-3 w-3" aria-hidden="true" />
              {changeMutation.isPending ? 'Saving…' : 'Change rate'}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
            Closes the current row at the day before, opens a new row starting {effectiveFrom || '…'}.
            Entries before that date keep the prior rate for this labor category.
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
              No rate history yet — the labor category uses its default hourly cost until you set one.
            </p>
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

function FormCard({
  mode,
  form,
  setForm,
  onSave,
  onCancel,
  saving,
  currencies: _currencies,
  editingRow,
  showRates,
  onOpenRateModal,
}: {
  mode: 'create' | 'edit';
  form: FormState;
  setForm: (f: FormState) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  currencies: Array<{ code: string; name: string; symbol: string | null }>;
  /** Row backing the current edit — used to render the read-only
   *  effective-rate display + "Change rate" jump. Null on create. */
  editingRow: SeniorityRow | null;
  /** Finance-gated: rate display + "Change rate" jump only when true. */
  showRates: boolean;
  /** Opens the rate-history modal for the row being edited. Null when
   *  either finance is not granted or we're on the create path. */
  onOpenRateModal: (() => void) | null;
}) {
  void _currencies; // reserved for a future per-level currency picker
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm({ ...form, [key]: value });

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <TextField
          label="Code"
          name={`seniority-code-${mode}`}
          required
          value={form.code}
          onChange={(e) => update('code', e.target.value.toLowerCase().replace(/\s+/g, '_'))}
          placeholder="senior"
          inputClassName="font-mono"
        />
        <TextField
          className="sm:col-span-2"
          label="Name"
          name={`seniority-name-${mode}`}
          required
          value={form.name}
          onChange={(e) => update('name', e.target.value)}
          placeholder="Senior"
        />
        <TextField
          label="Sort order"
          name={`seniority-sortOrder-${mode}`}
          type="number"
          value={form.sortOrder}
          onChange={(e) => update('sortOrder', Number(e.target.value))}
          hint="Use 10 / 20 / 30 so new categories fit between existing ones."
        />
        {/* People UX M2b (E-23) — Hourly Cost is no longer an editable
            field on the form. Rate changes must go through the
            "Change rate" modal (forward-effective rows on
            `seniority_rates`). Here we render the current effective
            rate READ-ONLY (or the default on the create path, which
            has no row yet) so the admin sees what the cost engine
            would return. Finance-gated to match the column above.
            The DB column stays intact; the create-form still lets the
            admin seed a `defaultHourlyCost` on first-time setup only
            (the "Default rate" text field below). */}
        {mode === 'edit' && editingRow && showRates && (
          <Field label="Default rate" className="sm:col-span-1"
            labelSuffix={
              onOpenRateModal && (
                <button
                  type="button"
                  onClick={onOpenRateModal}
                  className="inline-flex items-center gap-1 text-[12px] font-semibold text-emerald-600 hover:underline"
                >
                  <Clock className="h-3 w-3" aria-hidden="true" /> Change rate
                </button>
              )
            }
          >
            {() => (
              <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 px-3 py-2 text-sm text-slate-700 dark:text-slate-200 font-mono">
                {editingRow.effectiveHourlyCost != null ? (
                  <>
                    ₪{editingRow.effectiveHourlyCost}
                    <span className="ml-1 text-[11px] text-slate-400 dark:text-slate-500">/h</span>
                    {editingRow.effectiveRateSource === 'level_default' && (
                      <span className="ml-1.5 inline-block rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                        default
                      </span>
                    )}
                  </>
                ) : (
                  <span className="italic text-slate-400 dark:text-slate-500 font-sans">
                    No rate set yet — use "Change rate" to add one.
                  </span>
                )}
              </div>
            )}
          </Field>
        )}
        {/* On create, we still let the admin seed the level's
            `defaultHourlyCost` — that's the legacy rollout fallback
            layer of the resolver. All subsequent changes must go via
            the rate-history modal. Finance-gated. */}
        {mode === 'create' && showRates && (
          <TextField
            label="Default rate"
            name={`seniority-cost-${mode}`}
            type="number"
            step="0.01"
            min={0}
            value={form.defaultHourlyCost}
            onChange={(e) => update('defaultHourlyCost', e.target.value)}
            placeholder="e.g. 80.00"
            inputClassName="font-mono"
            hint='After the labor category is created, update this via "Change rate" so rates carry a forward-effective date.'
          />
        )}
        {/* QA3 round-3 item 5 — Currency picker removed; system is
            ₪-only. DB column stays nullable; the form submits with the
            currency state (defaults to '' → null on the wire), which
            keeps write compatibility. */}
        {mode === 'edit' && (
          <div className="sm:col-span-2 flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">Active</span>
            <label className="flex items-center gap-2">
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
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
        >
          <X className="h-3 w-3" aria-hidden="true" /> Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !form.code.trim() || !form.name.trim()}
          className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <Save className="h-3 w-3" aria-hidden="true" /> {mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>
    </div>
  );
}
