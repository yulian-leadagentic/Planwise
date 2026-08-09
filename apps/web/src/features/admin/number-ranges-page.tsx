import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Pencil, Plus, Save, Trash2, X, Hash } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';

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
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  // scrollRef removed — DataTable owns its own sticky h-scroll.
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

  // Columns for the shared DataTable. sorting off — the underlying
  // list is server-ordered.
  const columns = useMemo<ColumnDef<NumberRangeRow, unknown>[]>(() => [
    { accessorKey: 'code', header: 'Code', enableSorting: false,
      cell: ({ row }) => <span className="font-mono text-xs font-semibold">{row.original.code}</span> },
    { accessorKey: 'name', header: 'Name', enableSorting: false,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.name || <span className="italic text-slate-400 dark:text-slate-500">—</span>}
        </span>
      ) },
    { id: 'mode', header: 'Mode', enableSorting: false, size: 96,
      cell: ({ row }) => <ModeBadge mode={row.original.mode} /> },
    { id: 'format', header: 'Format / next', enableSorting: false,
      cell: ({ row }) => {
        const r = row.original;
        if (r.mode === 'auto') {
          return (
            <div className="flex items-center gap-2 font-mono text-xs">
              <span className="text-blue-700">{r.prefix || ''}</span>
              <span className="text-muted-foreground">{'0'.repeat(r.padWidth)}</span>
              <span className="text-slate-400 dark:text-slate-500 mx-1">→</span>
              <span className="font-semibold text-slate-800 dark:text-slate-100">{r.preview}</span>
            </div>
          );
        }
        if (r.mode === 'external' && r.externalPattern) {
          return (
            <span className="font-mono text-xs text-slate-500 dark:text-slate-400" title="External codes must match this regex">
              regex: {r.externalPattern}
            </span>
          );
        }
        return <span className="text-[11px] italic text-slate-400 dark:text-slate-500">User-entered at create time</span>;
      } },
    { id: 'bounds', header: 'Bounds', enableSorting: false, size: 128,
      cell: ({ row }) => {
        const r = row.original;
        return (
          <span className="text-xs text-muted-foreground">
            {r.mode === 'auto' ? <>{r.fromNumber} – {r.toNumber}</> : '—'}
          </span>
        );
      } },
    { id: 'status', header: 'Status', enableSorting: false, size: 96,
      cell: ({ row }) => <StatusBadge status={row.original.isActive ? 'active' : 'inactive'} /> },
    { id: 'actions', header: 'Actions', enableSorting: false, size: 128,
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => startEdit(row.original)}
            aria-label={`Edit range ${row.original.code}`}
            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
            title="Edit (code is immutable)"
          >
            <Pencil className="h-3 w-3" aria-hidden="true" /> Edit
          </button>
          <button
            onClick={async () => {
              if (await confirm(`Delete range "${row.original.code}"? Any entity kind referencing it will become unassigned.`)) {
                deleteMutation.mutate(row.original.id);
              }
            }}
            aria-label={`Delete range ${row.original.code}`}
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

      {/* Edit form hoisted above the table (DataTable can't do
          per-row overrides via colSpan). Same fields, same
          save/cancel — the row it applies to just disappears from
          the table while the form is shown above. */}
      {editingId != null && (
        <RangeFormCard
          mode="edit"
          form={form}
          setForm={setForm}
          onSave={saveEdit}
          onCancel={() => setEditingId(null)}
          saving={updateMutation.isPending}
        />
      )}

      {isLoading ? (
        <TableSkeleton rows={5} cols={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Hash}
          title="No number ranges configured"
          description="Add a range to auto-generate codes for projects, tasks, or partners."
        />
      ) : (
        <DataTable columns={columns} data={rows} pageSize={1000} />
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
         aria-label="Save">
          <Save className="h-3 w-3"  aria-hidden="true" /> {mode === 'create' ? 'Create' : 'Save'}
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
