import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pencil, Plus, Save, Trash2, X, Hash } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { notify } from '@/lib/notify';

// Number Ranges — SAP-NRIV pattern. Each numbered object (Person, Org, Employee, …)
// draws codes from a row here. The service hands out the next number atomically;
// admins control prefix + zero-padding + bounds. currentNumber can only move
// forward to protect already-issued codes.

type NumberRangeRow = {
  id: number;
  objectCode: string;
  rangeName: string;
  prefix: string;
  padWidth: number;
  fromNumber: string;
  toNumber: string;
  currentNumber: string;
  isActive: boolean;
  description: string | null;
  preview: string;
  createdAt: string;
  updatedAt: string;
};

type FormState = {
  objectCode: string;
  rangeName: string;
  prefix: string;
  padWidth: number;
  fromNumber: string;
  toNumber: string;
  currentNumber: string;
  isActive: boolean;
  description: string;
};

const emptyForm: FormState = {
  objectCode: '',
  rangeName: 'default',
  prefix: '',
  padWidth: 8,
  fromNumber: '1',
  toNumber: '99999999',
  currentNumber: '0',
  isActive: true,
  description: '',
};

export function NumberRangesPage() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);

  const { data, isLoading } = useQuery<NumberRangeRow[]>({
    queryKey: ['admin', 'number-ranges'],
    queryFn: () =>
      client.get('/admin/number-ranges').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const createMutation = useMutation({
    mutationFn: (payload: FormState) =>
      client
        .post('/admin/number-ranges', {
          objectCode: payload.objectCode,
          rangeName: payload.rangeName,
          prefix: payload.prefix,
          padWidth: payload.padWidth,
          fromNumber: payload.fromNumber,
          toNumber: payload.toNumber,
          currentNumber: payload.currentNumber,
          isActive: payload.isActive,
          description: payload.description || null,
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'number-ranges'] });
      notify.success('Number range created', { code: 'NRANGE-CREATE-201' });
      setShowCreate(false);
      setForm(emptyForm);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create number range'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...payload }: FormState & { id: number }) =>
      client
        .patch(`/admin/number-ranges/${id}`, {
          prefix: payload.prefix,
          padWidth: payload.padWidth,
          fromNumber: payload.fromNumber,
          toNumber: payload.toNumber,
          currentNumber: payload.currentNumber,
          isActive: payload.isActive,
          description: payload.description || null,
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'number-ranges'] });
      notify.success('Number range updated', { code: 'NRANGE-UPDATE-200' });
      setEditingId(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update number range'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      client.delete(`/admin/number-ranges/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'number-ranges'] });
      notify.success('Number range deleted', { code: 'NRANGE-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete number range'),
  });

  const startEdit = (row: NumberRangeRow) => {
    setEditingId(row.id);
    setShowCreate(false);
    setForm({
      objectCode: row.objectCode,
      rangeName: row.rangeName,
      prefix: row.prefix,
      padWidth: row.padWidth,
      fromNumber: row.fromNumber,
      toNumber: row.toNumber,
      currentNumber: row.currentNumber,
      isActive: row.isActive,
      description: row.description ?? '',
    });
  };

  const saveEdit = () => {
    if (editingId == null) return;
    updateMutation.mutate({ id: editingId, ...form });
  };

  const rows = data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Number Ranges"
        description="Auto-generated code formats for Persons, Organizations, Employees and other numbered objects. Each row defines a prefix, zero-pad width, and an upper bound. The current counter only moves forward."
        actions={
          !showCreate && editingId == null ? (
            <button
              onClick={() => {
                setShowCreate(true);
                setForm(emptyForm);
              }}
              className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" /> New range
            </button>
          ) : null
        }
      />

      {showCreate && (
        <RangeFormCard
          mode="create"
          form={form}
          setForm={setForm}
          onSave={() => createMutation.mutate(form)}
          onCancel={() => setShowCreate(false)}
          saving={createMutation.isPending}
        />
      )}

      {isLoading ? (
        <TableSkeleton rows={5} cols={6} />
      ) : rows.length === 0 ? (
        <EmptyHint />
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Object</th>
                <th className="px-4 py-3 font-medium">Range</th>
                <th className="px-4 py-3 font-medium">Format</th>
                <th className="px-4 py-3 font-medium">Next code</th>
                <th className="px-4 py-3 font-medium">Bounds</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium w-32 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isEditing = editingId === row.id;
                if (isEditing) {
                  return (
                    <tr key={row.id} className="border-b border-border bg-muted/20">
                      <td colSpan={7} className="p-4">
                        <RangeFormCard
                          mode="edit"
                          form={form}
                          setForm={setForm}
                          onSave={saveEdit}
                          onCancel={() => setEditingId(null)}
                          saving={updateMutation.isPending}
                        />
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={row.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3 font-mono text-xs">{row.objectCode}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.rangeName}</td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {row.prefix ? <span className="text-blue-700">{row.prefix}</span> : <span className="text-muted-foreground">—</span>}
                      <span className="text-muted-foreground">{'0'.repeat(row.padWidth)}</span>
                    </td>
                    <td className="px-4 py-3 font-mono font-medium">{row.preview}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {row.fromNumber} – {row.toNumber}
                    </td>
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
                            if (confirm(`Delete range ${row.objectCode} / ${row.rangeName}?`)) {
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

function EmptyHint() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
      <Hash className="h-8 w-8 text-muted-foreground" />
      <p className="text-sm font-medium">No number ranges configured</p>
      <p className="text-xs text-muted-foreground">Create one for each numbered object (PARTY_PERSON, PARTY_ORG, EMPLOYEE, …).</p>
    </div>
  );
}

type FormCardProps = {
  mode: 'create' | 'edit';
  form: FormState;
  setForm: (f: FormState) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
};

function RangeFormCard({ mode, form, setForm, onSave, onCancel, saving }: FormCardProps) {
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm({ ...form, [key]: value });

  const previewExample = `${form.prefix}${'1'.padStart(form.padWidth || 1, '0')}`;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Field label="Object code" required>
          <input
            value={form.objectCode}
            onChange={(e) => update('objectCode', e.target.value.toUpperCase())}
            placeholder="PARTY_PERSON"
            disabled={mode === 'edit'}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm font-mono disabled:opacity-50"
          />
        </Field>
        <Field label="Range name">
          <input
            value={form.rangeName}
            onChange={(e) => update('rangeName', e.target.value)}
            placeholder="default"
            disabled={mode === 'edit'}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm disabled:opacity-50"
          />
        </Field>
        <Field label="Active">
          <label className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => update('isActive', e.target.checked)}
              className="h-4 w-4"
            />
            <span className="text-sm">Allocate from this range</span>
          </label>
        </Field>

        <Field label="Prefix">
          <input
            value={form.prefix}
            onChange={(e) => update('prefix', e.target.value)}
            placeholder="(none)"
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm font-mono"
          />
        </Field>
        <Field label="Pad width">
          <input
            type="number"
            min={1}
            max={20}
            value={form.padWidth}
            onChange={(e) => update('padWidth', Number(e.target.value) || 1)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </Field>
        <Field label="Preview">
          <div className="rounded-md bg-muted px-2 py-1.5 font-mono text-sm">{previewExample}</div>
        </Field>

        <Field label="From">
          <input
            value={form.fromNumber}
            onChange={(e) => update('fromNumber', e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm font-mono"
          />
        </Field>
        <Field label="To">
          <input
            value={form.toNumber}
            onChange={(e) => update('toNumber', e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm font-mono"
          />
        </Field>
        <Field label="Current">
          <input
            value={form.currentNumber}
            onChange={(e) => update('currentNumber', e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm font-mono"
          />
          {mode === 'edit' && (
            <p className="mt-1 text-xs text-muted-foreground">Cannot move backward.</p>
          )}
        </Field>
      </div>

      <Field label="Description">
        <input
          value={form.description}
          onChange={(e) => update('description', e.target.value)}
          placeholder="What is this range used for?"
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        />
      </Field>

      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
        >
          <X className="h-3 w-3" /> Cancel
        </button>
        <button
          onClick={onSave}
          disabled={saving || !form.objectCode.trim()}
          className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <Save className="h-3 w-3" /> {mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="text-red-600"> *</span>}
      </label>
      {children}
    </div>
  );
}
