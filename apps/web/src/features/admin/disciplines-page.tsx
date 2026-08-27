import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Pencil, Plus, Save, Trash2, X, Compass } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';

// BM2 QA-2 Commit 4 (2026-08-27) — user-managed Discipline catalog.
// Mirrors the SeniorityLevelsPage structure (full CRUD, form-card above
// a DataTable) since Discipline has the same shape: user-defined rows
// with code / name / sort order / active flag.
//
// Design note: this page uses the QA-2 spec's explicit slate palette
// (`dark:border-slate-700 dark:bg-slate-900 focus:border-blue-500`)
// rather than the generic `border-input bg-background` tokens seen on
// the older seniority-levels page. Matches the create-partner-modal
// input class + the QA-2 rules for every UI change.

type DisciplineRow = {
  id: number;
  code: string;
  name: string;
  nameHe: string | null;
  sortOrder: number;
  isActive: boolean;
};

type FormState = {
  code: string;
  name: string;
  nameHe: string;
  sortOrder: number;
  isActive: boolean;
};

const emptyForm: FormState = {
  code: '',
  name: '',
  nameHe: '',
  sortOrder: 0,
  isActive: true,
};

// Same input class the create-partner-modal uses so the two surfaces
// look native to each other.
const inputClass =
  'w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none';

export function DisciplinesPage() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);

  const { data, isLoading } = useQuery<DisciplineRow[]>({
    queryKey: ['admin', 'disciplines'],
    queryFn: () =>
      client.get('/admin/config/disciplines').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const createMutation = useMutation({
    mutationFn: (payload: FormState) =>
      client
        .post('/admin/config/disciplines', {
          code: payload.code,
          name: payload.name,
          nameHe: payload.nameHe.trim() || null,
          sortOrder: payload.sortOrder,
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'disciplines'] });
      notify.success('Discipline created', { code: 'DISCIPLINE-CREATE-201' });
      setShowCreate(false);
      setForm(emptyForm);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create discipline'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...payload }: FormState & { id: number }) =>
      client
        .patch(`/admin/config/disciplines/${id}`, {
          code: payload.code,
          name: payload.name,
          nameHe: payload.nameHe.trim() || null,
          sortOrder: payload.sortOrder,
          isActive: payload.isActive,
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'disciplines'] });
      notify.success('Discipline updated', { code: 'DISCIPLINE-UPDATE-200' });
      setEditingId(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update discipline'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      client.delete(`/admin/config/disciplines/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'disciplines'] });
      notify.success('Discipline deleted', { code: 'DISCIPLINE-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete discipline'),
  });

  const startEdit = (row: DisciplineRow) => {
    setEditingId(row.id);
    setShowCreate(false);
    setForm({
      code: row.code,
      name: row.name,
      nameHe: row.nameHe ?? '',
      sortOrder: row.sortOrder,
      isActive: row.isActive,
    });
  };

  const rows = data ?? [];

  const columns = useMemo<ColumnDef<DisciplineRow, unknown>[]>(
    () => [
      {
        accessorKey: 'code',
        header: 'Code',
        enableSorting: false,
        size: 128,
        cell: ({ row }) => (
          <span className="font-mono text-xs text-slate-600 dark:text-slate-400">
            {row.original.code}
          </span>
        ),
      },
      {
        accessorKey: 'name',
        header: 'Name',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-medium text-slate-800 dark:text-slate-100">
            {row.original.name}
          </span>
        ),
      },
      {
        accessorKey: 'nameHe',
        header: 'שם',
        enableSorting: false,
        size: 160,
        cell: ({ row }) =>
          row.original.nameHe ? (
            <span dir="rtl" className="text-slate-700 dark:text-slate-300">
              {row.original.nameHe}
            </span>
          ) : (
            <span className="text-xs italic text-slate-400 dark:text-slate-500">—</span>
          ),
      },
      {
        accessorKey: 'sortOrder',
        header: 'Order',
        enableSorting: false,
        size: 80,
        cell: ({ row }) => (
          <span className="text-slate-500 dark:text-slate-400">{row.original.sortOrder}</span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        size: 96,
        cell: ({ row }) => (
          <StatusBadge status={row.original.isActive ? 'active' : 'inactive'} />
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        enableSorting: false,
        size: 128,
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => startEdit(row.original)}
              aria-label={`Edit discipline ${row.original.name}`}
              className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              <Pencil className="h-3 w-3" aria-hidden="true" /> Edit
            </button>
            <button
              onClick={async () => {
                if (
                  await confirm(
                    `Delete discipline "${row.original.name}"? Existing contacts referencing it will be set to no discipline.`,
                  )
                ) {
                  deleteMutation.mutate(row.original.id);
                }
              }}
              aria-label={`Delete discipline ${row.original.name}`}
              className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400 hover:underline"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" /> Delete
            </button>
          </div>
        ),
      },
    ],
    // Deliberate empty deps — the callbacks close over stable references
    // (mutation objects, confirm) whose identities are React-stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Disciplines"
        description="Manage the branch-of-engineering catalog used to classify contacts (Architecture / Structural / MEP / …). Discipline is display + search only — it does not gate project-role assignment eligibility."
        actions={
          !showCreate && editingId == null ? (
            <button
              onClick={() => {
                setShowCreate(true);
                setForm({ ...emptyForm, sortOrder: (rows.length + 1) * 10 });
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 px-3 py-1.5 text-[13px] font-semibold text-white"
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> Add discipline
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
      {editingId != null && (
        <FormCard
          mode="edit"
          form={form}
          setForm={setForm}
          onSave={() => updateMutation.mutate({ id: editingId, ...form })}
          onCancel={() => setEditingId(null)}
          saving={updateMutation.isPending}
        />
      )}

      {isLoading ? (
        <TableSkeleton rows={3} cols={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Compass}
          title="No disciplines defined"
          description="Add your first discipline (e.g. Architecture, Structural, MEP) to start classifying contacts."
        />
      ) : (
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
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className="mb-1 block text-[13px] font-semibold text-slate-700 dark:text-slate-200">
            Code <span className="text-red-600 dark:text-red-400">*</span>
          </label>
          <input
            value={form.code}
            onChange={(e) => update('code', e.target.value.toLowerCase().replace(/\s+/g, '_'))}
            placeholder="architecture"
            className={`${inputClass} font-mono`}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-[13px] font-semibold text-slate-700 dark:text-slate-200">
            Name <span className="text-red-600 dark:text-red-400">*</span>
          </label>
          <input
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder="Architecture"
            className={inputClass}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-[13px] font-semibold text-slate-700 dark:text-slate-200">
            שם <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>
          </label>
          <input
            dir="rtl"
            value={form.nameHe}
            onChange={(e) => update('nameHe', e.target.value)}
            placeholder="אדריכלות"
            className={inputClass}
          />
        </div>
        <div>
          <label
            className="mb-1 block text-[13px] font-semibold text-slate-700 dark:text-slate-200"
            title="Display order in lists (low → high). Use 10 / 20 / 30 / … so you can insert new disciplines between existing ones without reshuffling the rest."
          >
            Sort order
          </label>
          <input
            type="number"
            value={form.sortOrder}
            onChange={(e) => update('sortOrder', Number(e.target.value))}
            className={inputClass}
          />
        </div>
        {mode === 'edit' && (
          <div className="sm:col-span-3">
            <label className="mb-1 block text-[13px] font-semibold text-slate-700 dark:text-slate-200">
              Active
            </label>
            <label className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => update('isActive', e.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-sm text-slate-700 dark:text-slate-200">
                Available on the contact picker
              </span>
            </label>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-slate-100 dark:border-slate-800 pt-3">
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3 py-1.5"
        >
          <X className="h-3 w-3" aria-hidden="true" /> Cancel
        </button>
        <button
          onClick={onSave}
          disabled={saving || !form.code.trim() || !form.name.trim()}
          className="inline-flex items-center gap-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3 py-1.5 disabled:opacity-50"
          aria-label="Save"
        >
          <Save className="h-3 w-3" aria-hidden="true" /> {mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>
    </div>
  );
}
