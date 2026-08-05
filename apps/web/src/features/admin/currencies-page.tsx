import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pencil, Plus, Save, Trash2, X, DollarSign } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';
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
  const scrollRef = useStickyHScroll();
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
              <Plus className="h-4 w-4" /> Add currency
            </button>
          ) : null
        }
      />

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

      {isLoading ? (
        <TableSkeleton rows={3} cols={5} />
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
          <DollarSign className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">No currencies configured</p>
        </div>
      ) : (
        <div ref={scrollRef} className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium w-24">Code</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium w-20">Symbol</th>
                <th className="px-4 py-3 font-medium w-24">Decimals</th>
                <th className="px-4 py-3 font-medium w-24">Order</th>
                <th className="px-4 py-3 font-medium w-24">Status</th>
                <th className="px-4 py-3 font-medium w-32 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isEditing = editingCode === row.code;
                if (isEditing) {
                  return (
                    <tr key={row.code} className="border-b border-border bg-muted/20">
                      <td colSpan={7} className="p-4">
                        <FormCard
                          mode="edit"
                          form={form}
                          setForm={setForm}
                          onSave={() => updateMutation.mutate(form)}
                          onCancel={() => setEditingCode(null)}
                          saving={updateMutation.isPending}
                        />
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={row.code} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3 font-mono font-medium">{row.code}</td>
                    <td className="px-4 py-3">{row.name}</td>
                    <td className="px-4 py-3 font-mono">{row.symbol ?? '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.decimals}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.sortOrder}</td>
                    <td className="px-4 py-3">
                      {row.isActive ? (
                        <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">Active</span>
                      ) : (
                        <span className="inline-flex rounded-full bg-gray-100 dark:bg-slate-800 px-2 py-0.5 text-xs text-gray-600 dark:text-slate-300">Inactive</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => startEdit(row)}
                          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                        >
                          <Pencil className="h-3 w-3" /> Edit
                        </button>
                        <button
                          onClick={async () => {
                            if (await confirm(`Delete currency ${row.code}?`)) {
                              deleteMutation.mutate(row.code);
                            }
                          }}
                          className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline"
                        >
                          <Trash2 className="h-3 w-3" /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
