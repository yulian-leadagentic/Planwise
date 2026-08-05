import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pencil, Plus, Save, Trash2, X, Hash } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { notify } from '@/lib/notify';

// M1.1 — Pure sequence library. Each row is a named sequence with a
// stable `code`. EntityKind rows reference these codes to decide which
// range an object uses (see /admin/object-numbering). Modes:
//   auto     — system allocates next number on create.
//   manual   — user types the code at create time; uniqueness only.
//   external — same as manual but with an optional regex validator.

type Mode = 'auto' | 'manual' | 'external';

type NumberRangeRow = {
  id: number;
  code: string;
  name: string | null;
  mode: Mode;
  prefix: string;
  padWidth: number;
  fromNumber: string;
  toNumber: string;
  currentNumber: string;
  externalPattern: string | null;
  isActive: boolean;
  description: string | null;
  /** null when mode != 'auto' (manual/external have no pre-computed next). */
  preview: string | null;
  createdAt: string;
  updatedAt: string;
};

type FormState = {
  code: string;
  name: string;
  mode: Mode;
  prefix: string;
  padWidth: number;
  fromNumber: string;
  toNumber: string;
  currentNumber: string;
  externalPattern: string;
  isActive: boolean;
  description: string;
};

const emptyForm: FormState = {
  code: '',
  name: '',
  mode: 'auto',
  prefix: '',
  padWidth: 8,
  fromNumber: '1',
  toNumber: '99999999',
  currentNumber: '0',
  externalPattern: '',
  isActive: true,
  description: '',
};

export function NumberRangesPage() {
  const queryClient = useQueryClient();
  const scrollRef = useStickyHScroll();
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
          code: payload.code,
          name: payload.name || null,
          mode: payload.mode,
          prefix: payload.prefix,
          padWidth: payload.padWidth,
          fromNumber: payload.fromNumber,
          toNumber: payload.toNumber,
          currentNumber: payload.currentNumber,
          externalPattern: payload.externalPattern || null,
          isActive: payload.isActive,
          description: payload.description || null,
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'number-ranges'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'entity-kinds'] });
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
          // code is intentionally NOT sent — immutable on update.
          name: payload.name || null,
          mode: payload.mode,
          prefix: payload.prefix,
          padWidth: payload.padWidth,
          fromNumber: payload.fromNumber,
          toNumber: payload.toNumber,
          currentNumber: payload.currentNumber,
          externalPattern: payload.externalPattern || null,
          isActive: payload.isActive,
          description: payload.description || null,
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'number-ranges'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'entity-kinds'] });
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
      queryClient.invalidateQueries({ queryKey: ['admin', 'entity-kinds'] });
      notify.success('Number range deleted', { code: 'NRANGE-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete number range'),
  });

  const startEdit = (row: NumberRangeRow) => {
    setEditingId(row.id);
    setShowCreate(false);
    setForm({
      code: row.code,
      name: row.name ?? '',
      mode: row.mode,
      prefix: row.prefix,
      padWidth: row.padWidth,
      fromNumber: row.fromNumber,
      toNumber: row.toNumber,
      currentNumber: row.currentNumber,
      externalPattern: row.externalPattern ?? '',
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
        description="Sequence library used by every numbered object in the system. Each range has a stable code; entity kinds (Persons, Organizations, Employees, …) reference it on the Object Numbering page. Mode controls assignment: Auto allocates the next number; Manual / External let the user enter the code."
        actions={
          !showCreate && editingId == null ? (
            <button
              onClick={() => { setShowCreate(true); setForm(emptyForm); }}
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
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
          <Hash className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">No number ranges configured</p>
        </div>
      ) : (
        <div ref={scrollRef} className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium w-24">Mode</th>
                <th className="px-4 py-3 font-medium">Format / next</th>
                <th className="px-4 py-3 font-medium w-32">Bounds</th>
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
                    <td className="px-4 py-3 font-mono text-xs font-semibold">{row.code}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.name || <span className="italic text-slate-400 dark:text-slate-500">—</span>}</td>
                    <td className="px-4 py-3">
                      <ModeBadge mode={row.mode} />
                    </td>
                    <td className="px-4 py-3">
                      {row.mode === 'auto' ? (
                        <div className="flex items-center gap-2 font-mono text-xs">
                          <span className="text-blue-700">{row.prefix || ''}</span>
                          <span className="text-muted-foreground">{'0'.repeat(row.padWidth)}</span>
                          <span className="text-slate-400 dark:text-slate-500 mx-1">→</span>
                          <span className="font-semibold text-slate-800 dark:text-slate-100">{row.preview}</span>
                        </div>
                      ) : row.mode === 'external' && row.externalPattern ? (
                        <span className="font-mono text-xs text-slate-500 dark:text-slate-400" title="External codes must match this regex">
                          regex: {row.externalPattern}
                        </span>
                      ) : (
                        <span className="text-[11px] italic text-slate-400 dark:text-slate-500">User-entered at create time</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {row.mode === 'auto' ? <>{row.fromNumber} – {row.toNumber}</> : '—'}
                    </td>
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
                          title="Edit (code is immutable)"
                        >
                          <Pencil className="h-3 w-3" /> Edit
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Delete range "${row.code}"? Any entity kind referencing it will become unassigned.`)) {
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

function ModeBadge({ mode }: { mode: Mode }) {
  const cls =
    mode === 'auto'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : mode === 'manual'
        ? 'bg-blue-50 text-blue-700 border-blue-200'
        : 'bg-amber-50 text-amber-700 border-amber-200';
  return (
    <span
      className={cn('inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize', cls)}
      title={
        mode === 'auto'
          ? 'System allocates the next number on entity create.'
          : mode === 'manual'
            ? 'User types the code at create time. Uniqueness enforced.'
            : 'Code comes from an external system. Optional regex validation.'
      }
    >
      {mode}
    </span>
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

  const previewExample =
    form.mode === 'auto'
      ? `${form.prefix}${'1'.padStart(form.padWidth || 1, '0')}`
      : form.mode === 'external'
        ? form.externalPattern || '(no pattern)'
        : '(user types it)';

  const isAuto = form.mode === 'auto';
  const isExternal = form.mode === 'external';

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Field label="Code" required>
          <input
            value={form.code}
            onChange={(e) => update('code', e.target.value.toUpperCase())}
            placeholder="EMPLOYEE"
            disabled={mode === 'edit'}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm font-mono disabled:opacity-50"
          />
        </Field>
        <Field label="Name">
          <input
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder="Employees"
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
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
            <span className="text-sm">Allocate / accept codes from this range</span>
          </label>
        </Field>
      </div>

      <Field label="Mode">
        <div className="flex flex-wrap gap-2">
          {(['auto', 'manual', 'external'] as const).map((m) => {
            const on = form.mode === m;
            const desc =
              m === 'auto'
                ? 'System allocates next number'
                : m === 'manual'
                  ? 'User types the code'
                  : 'Code from external system';
            return (
              <button
                key={m}
                type="button"
                onClick={() => update('mode', m)}
                title={desc}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors',
                  on
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600',
                )}
              >
                {m}
              </button>
            );
          })}
        </div>
      </Field>

      {(isAuto || form.mode === 'manual') && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
          <Field label={isAuto ? 'Next code preview' : 'Example shape'}>
            <div className="rounded-md bg-muted px-2 py-1.5 font-mono text-sm">{previewExample}</div>
          </Field>
        </div>
      )}

      {isAuto && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
      )}

      {isExternal && (
        <Field label="External pattern (regex, optional)">
          <input
            value={form.externalPattern}
            onChange={(e) => update('externalPattern', e.target.value)}
            placeholder={'e.g. ^SAP-\\d{6}$'}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm font-mono"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Codes entered at create time must match this regex. Leave empty to accept any string (uniqueness still enforced).
          </p>
        </Field>
      )}

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
          disabled={saving || !form.code.trim()}
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
