import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pencil, Plus, Save, Trash2, X, GraduationCap } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';
import client from '@/api/client';
import { notify } from '@/lib/notify';

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
  const queryClient = useQueryClient();
  const scrollRef = useStickyHScroll();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);

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

      {isLoading ? (
        <TableSkeleton rows={3} cols={4} />
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
          <GraduationCap className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">No seniority levels defined</p>
          <p className="text-xs text-muted-foreground">Add your first level to start (e.g. Junior, Mid, Senior).</p>
        </div>
      ) : (
        <div ref={scrollRef} className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium w-32">Code</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th
                  className="px-4 py-3 font-medium w-40"
                  title="Default hourly cost used by project labor calculations. Currency from the catalog."
                >
                  Hourly Cost
                </th>
                <th
                  className="px-4 py-3 font-medium w-20"
                  title="Display order for the list — lower number shows first (Junior=10, Mid=20, Senior=30, …)."
                >
                  Order
                </th>
                <th className="px-4 py-3 font-medium w-24">Status</th>
                <th className="px-4 py-3 font-medium w-32 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isEditing = editingId === row.id;
                if (isEditing) {
                  return (
                    <tr key={row.id} className="border-b border-border bg-muted/20">
                      <td colSpan={6} className="p-4">
                        <FormCard
                          mode="edit"
                          form={form}
                          setForm={setForm}
                          onSave={() => updateMutation.mutate({ id: row.id, ...form })}
                          onCancel={() => setEditingId(null)}
                          saving={updateMutation.isPending}
                          currencies={currencies}
                        />
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={row.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3 font-mono text-xs">{row.code}</td>
                    <td className="px-4 py-3 font-medium">{row.name}</td>
                    <td className="px-4 py-3">
                      {row.defaultHourlyCost != null ? (
                        <span className="font-mono text-sm text-slate-800">
                          {row.defaultHourlyCost}
                          {row.currency ? <span className="ml-1 text-[11px] text-slate-400">{row.currency}</span> : null}
                          <span className="ml-1 text-[11px] text-slate-400">/h</span>
                        </span>
                      ) : (
                        <span className="text-xs italic text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{row.sortOrder}</td>
                    <td className="px-4 py-3">
                      {row.isActive ? (
                        <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">Active</span>
                      ) : (
                        <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">Inactive</span>
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
                          onClick={() => {
                            if (confirm(`Delete seniority level "${row.name}"?`)) {
                              deleteMutation.mutate(row.id);
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
        >
          <Save className="h-3 w-3" /> {mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>
    </div>
  );
}
