import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Pencil, Plus, Save, Trash2, X, DollarSign } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';

type CurrencyRow = {
  code: string;
  name: string;
  symbol: string | null;
  decimals: number;
  isActive: boolean;
  sortOrder: number;
};

type FormState = {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
  isActive: boolean;
  sortOrder: number;
};

const emptyForm: FormState = {
  code: '',
  name: '',
  symbol: '',
  decimals: 2,
  isActive: true,
  sortOrder: 0,
};

export function CurrenciesPage() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);

  const { data, isLoading } = useQuery<CurrencyRow[]>({
    queryKey: ['admin', 'currencies'],
    queryFn: () =>
      client.get('/admin/config/currencies').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const createMutation = useMutation({
    mutationFn: (payload: FormState) =>
      client
        .post('/admin/config/currencies', {
          code: payload.code,
          name: payload.name,
          symbol: payload.symbol || null,
          decimals: payload.decimals,
          sortOrder: payload.sortOrder,
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'currencies'] });
      notify.success('Currency created', { code: 'CURRENCY-CREATE-201' });
      setShowCreate(false);
      setForm(emptyForm);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create currency'),
  });

  const updateMutation = useMutation({
    mutationFn: (payload: FormState) =>
      client
        .patch(`/admin/config/currencies/${payload.code}`, {
          name: payload.name,
          symbol: payload.symbol || null,
          decimals: payload.decimals,
          isActive: payload.isActive,
          sortOrder: payload.sortOrder,
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'currencies'] });
      notify.success('Currency updated', { code: 'CURRENCY-UPDATE-200' });
      setEditingCode(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update currency'),
  });

  const deleteMutation = useMutation({
    mutationFn: (code: string) =>
      client.delete(`/admin/config/currencies/${code}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'currencies'] });
      notify.success('Currency deleted', { code: 'CURRENCY-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete currency'),
  });

  const startEdit = (row: CurrencyRow) => {
    setEditingCode(row.code);
    setShowCreate(false);
    setForm({
      code: row.code,
      name: row.name,
      symbol: row.symbol ?? '',
      decimals: row.decimals,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    });
  };

  const rows = data ?? [];

  // DataTable column definitions. Kept sort-off (enableSorting: false)
  // to preserve the original page's no-sort behavior — the underlying
  // data is already ordered by sortOrder on the server.
  const columns = useMemo<ColumnDef<CurrencyRow, unknown>[]>(() => [
    { accessorKey: 'code', header: 'Code', enableSorting: false, size: 96,
      cell: ({ row }) => <span className="font-mono font-medium">{row.original.code}</span> },
    { accessorKey: 'name', header: 'Name', enableSorting: false,
      cell: ({ row }) => row.original.name },
    { accessorKey: 'symbol', header: 'Symbol', enableSorting: false, size: 80,
      cell: ({ row }) => <span className="font-mono">{row.original.symbol ?? '—'}</span> },
    { accessorKey: 'decimals', header: 'Decimals', enableSorting: false, size: 96,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.decimals}</span> },
    { accessorKey: 'sortOrder', header: 'Order', enableSorting: false, size: 96,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.sortOrder}</span> },
    { id: 'status', header: 'Status', enableSorting: false, size: 96,
      // StatusBadge maps `active` → green pill; `inactive` isn't in
      // STATUS_COLORS so it falls back to grey — matches the prior
      // "Inactive" pill without hand-rolling the styles here.
      cell: ({ row }) => <StatusBadge status={row.original.isActive ? 'active' : 'inactive'} /> },
    { id: 'actions', header: 'Actions', enableSorting: false, size: 128,
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => startEdit(row.original)}
            aria-label={`Edit currency ${row.original.code}`}
            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
          >
            <Pencil className="h-3 w-3" aria-hidden="true" /> Edit
          </button>
          <button
            onClick={async () => {
              if (await confirm(`Delete currency ${row.original.code}?`)) {
                deleteMutation.mutate(row.original.code);
              }
            }}
            aria-label={`Delete currency ${row.original.code}`}
            className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline"
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" /> Delete
          </button>
        </div>
      ),
    },
  // deleteMutation identity is stable enough for our use — column
  // action closures re-close automatically when the memo invalidates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Currencies"
        description="ISO-4217 currencies available for cost rates and monetary fields. Cross-currency conversion is not yet enabled — reports show per-currency subtotals."
        actions={
          !showCreate && editingCode == null ? (
            <button
              onClick={() => {
                setShowCreate(true);
                setForm(emptyForm);
              }}
              className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> Add currency
            </button>
          ) : null
        }
      />

      {/* Create / edit form. Previously the edit form replaced the
          row inline via colSpan — DataTable doesn't support per-row
          overrides, so hoisted here. Same fields + save/cancel; the
          only visual delta is that the form sits above the table
          instead of inside it. */}
      {showCreate && (
        <FormCard
          mode="create"
          form={form}
          setForm={setForm}
          onSave={() => createMutation.mutate(form)}
          onCancel={() => setShowCreate(false)}
          saving={createMutation.isPending}
        />
      )}
      {editingCode != null && (
        <FormCard
          mode="edit"
          form={form}
          setForm={setForm}
          onSave={() => updateMutation.mutate(form)}
          onCancel={() => setEditingCode(null)}
          saving={updateMutation.isPending}
        />
      )}

      {isLoading ? (
        <TableSkeleton rows={3} cols={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={DollarSign}
          title="No currencies configured"
          description="Add a currency to make it available for cost rates and monetary fields."
        />
      ) : (
        // pageSize is high so config-length tables (a few dozen rows
        // at most) show in one page — preserves the no-pagination
        // behavior of the original hand-rolled table.
        <DataTable columns={columns} data={rows} pageSize={1000} />
      )}
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
}: {
  mode: 'create' | 'edit';
  form: FormState;
  setForm: (f: FormState) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm({ ...form, [key]: value });

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            ISO code <span className="text-red-600">*</span>
          </label>
          <input
            value={form.code}
            onChange={(e) => update('code', e.target.value.toUpperCase().slice(0, 3))}
            placeholder="USD"
            disabled={mode === 'edit'}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm font-mono uppercase disabled:opacity-50"
          />
        </div>
        <div className="lg:col-span-2">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Name <span className="text-red-600">*</span>
          </label>
          <input
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder="US Dollar"
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Symbol</label>
          <input
            value={form.symbol}
            onChange={(e) => update('symbol', e.target.value)}
            placeholder="$"
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Decimals</label>
          <input
            type="number"
            min={0}
            max={6}
            value={form.decimals}
            onChange={(e) => update('decimals', Number(e.target.value))}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Order</label>
          <input
            type="number"
            value={form.sortOrder}
            onChange={(e) => update('sortOrder', Number(e.target.value))}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
        {mode === 'edit' && (
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Active</label>
            <label className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => update('isActive', e.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-sm">Available for new entries</span>
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
