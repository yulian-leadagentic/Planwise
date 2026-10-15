import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { Modal } from '@/components/shared/modal';
import { SelectField, TextField } from '@/components/shared/field';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { usePermissions } from '@/hooks/use-permissions';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import {
  hrApi,
  type AbsenceUnit,
  type BucketBehavior,
  type BucketCreditMode,
  type CreateBucketPayload,
  type SpecialHourBucket,
} from '../api/hr.api';

const BEHAVIOR_LABEL: Record<BucketBehavior, { label: string; cls: string }> = {
  A: { label: 'A · ניהול',  cls: 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300' },
  B: { label: 'B · יומי',   cls: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300' },
  C: { label: 'C · שנתי',   cls: 'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-300' },
};

export function BucketsSection() {
  const { can } = usePermissions();
  const canWrite = can('hr', 'write');
  const qc = useQueryClient();
  const confirm = useConfirm();

  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<SpecialHourBucket | null>(null);

  const { data: rows = [], isLoading } = useQuery<SpecialHourBucket[]>({
    queryKey: ['hr', 'buckets', 'all'],
    queryFn: () => hrApi.listBuckets(),
    staleTime: 60 * 1000,
  });

  const remove = useMutation({
    mutationFn: (id: number) => hrApi.deleteBucket(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr', 'buckets'] });
      notify.success('Bucket deactivated');
    },
    onError: (e: any) => notify.apiError(e, 'Failed to deactivate'),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-slate-500 dark:text-slate-400">
          קופות שעות מיוחדות — A ניהול, B יומי, C שנתי. שורות מערכת
          נעולות חלקית.
        </p>
        {canWrite && (
          <button
            type="button"
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 px-3.5 py-2 text-[13px] font-semibold text-white"
          >
            <Plus className="h-3.5 w-3.5" /> New bucket
          </button>
        )}
      </div>

      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 overflow-x-auto">
        <table className="w-full min-w-[1080px]">
          <thead>
            <tr className="bg-[#FAFBFC] dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-700">
              <Th>Name</Th>
              <Th>Code</Th>
              <Th>Behavior</Th>
              <Th>Unit</Th>
              <Th className="text-center">Doc</Th>
              <Th className="text-right">Daily</Th>
              <Th className="text-right">Max / year</Th>
              <Th className="text-right">Min std</Th>
              <Th>Credit mode</Th>
              <Th className="text-center">Active</Th>
              <Th className="text-center">Lock</Th>
              <th className="px-3 py-1.5 w-[90px]"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={12} className="px-3 py-10 text-center text-[13px] text-slate-400 dark:text-slate-500">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={12} className="px-3 py-10 text-center text-[13px] text-slate-400 dark:text-slate-500">No buckets.</td></tr>
            ) : (
              rows.map((row) => (
                <BucketRow
                  key={row.id}
                  row={row}
                  canWrite={canWrite}
                  onEdit={() => setEditing(row)}
                  onDelete={async () => {
                    const ok = await confirm(`Deactivate bucket "${row.nameHe}"?`, {
                      title: 'Deactivate bucket?',
                      variant: 'danger',
                      confirmLabel: 'Deactivate',
                    });
                    if (ok) remove.mutate(row.id);
                  }}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {showNew && (
        <BucketModal
          mode="create"
          onClose={() => setShowNew(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['hr', 'buckets'] });
            setShowNew(false);
          }}
        />
      )}
      {editing && (
        <BucketModal
          mode="edit"
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['hr', 'buckets'] });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={cn('px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]', className)}>
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn('px-3 py-2 text-[13px] text-slate-700 dark:text-slate-200', className)}>{children}</td>;
}

function BucketRow({
  row,
  canWrite,
  onEdit,
  onDelete,
}: {
  row: SpecialHourBucket;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const b = BEHAVIOR_LABEL[row.behavior];
  return (
    <tr className={cn('group border-b border-slate-50 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40', !row.active && 'opacity-55')}>
      <Td><span dir="rtl" className="font-semibold">{row.nameHe}</span></Td>
      <Td className="font-mono text-xs text-slate-500 dark:text-slate-400">{row.code}</Td>
      <Td>
        <span className={cn('inline-flex rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide', b.cls)}>
          {b.label}
        </span>
      </Td>
      <Td>
        <span className="inline-flex rounded-[5px] bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {row.unit === 'DAY' ? 'days' : 'hours'}
        </span>
      </Td>
      <Td className="text-center">
        {row.requiresDocument ? (
          <span className="inline-flex rounded-[5px] bg-emerald-50 dark:bg-emerald-900/30 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
            Yes
          </span>
        ) : (
          <span className="text-[11px] text-slate-300 dark:text-slate-600">—</span>
        )}
      </Td>
      <Td className="text-right font-mono tabular-nums text-xs">
        {row.dailyAmount != null ? row.dailyAmount : <span className="font-sans text-slate-300 dark:text-slate-600">—</span>}
      </Td>
      <Td className="text-right font-mono tabular-nums text-xs">
        {row.maxPerYear != null ? row.maxPerYear : <span className="font-sans text-slate-300 dark:text-slate-600">—</span>}
      </Td>
      <Td className="text-right font-mono tabular-nums text-xs">
        {row.minDailyStandard != null ? row.minDailyStandard : <span className="font-sans text-slate-300 dark:text-slate-600">—</span>}
      </Td>
      <Td className="text-xs">
        <span className="font-mono uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {row.defaultCreditMode}
        </span>
      </Td>
      <Td className="text-center">
        {row.active ? (
          <span className="inline-flex rounded-[5px] bg-emerald-50 dark:bg-emerald-900/30 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
            Active
          </span>
        ) : (
          <span className="inline-flex rounded-[5px] bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Inactive
          </span>
        )}
      </Td>
      <Td className="text-center">
        {row.isSystem && (
          <span
            className="inline-flex items-center gap-1 rounded-[5px] bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-300"
            title="System row — code/behavior/unit/doc are locked."
          >
            <Lock className="h-2.5 w-2.5" /> System
          </span>
        )}
      </Td>
      <td className="px-3 py-2 text-right">
        {canWrite && (
          <div className="opacity-0 group-hover:opacity-100 inline-flex items-center gap-1">
            <button
              type="button"
              onClick={onEdit}
              aria-label="Edit"
              className="w-[30px] h-[30px] rounded-[7px] bg-transparent hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-300 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 inline-flex items-center justify-center"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            {!row.isSystem && (
              <button
                type="button"
                onClick={onDelete}
                aria-label="Deactivate"
                className="w-[30px] h-[30px] rounded-[7px] bg-transparent hover:bg-red-50 dark:hover:bg-red-900/30 text-slate-300 dark:text-slate-500 hover:text-red-600 dark:hover:text-red-400 inline-flex items-center justify-center"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

interface ModalProps {
  mode: 'create' | 'edit';
  existing?: SpecialHourBucket;
  onClose: () => void;
  onSaved: () => void;
}

function BucketModal({ mode, existing, onClose, onSaved }: ModalProps) {
  const isSystem = !!existing?.isSystem;
  const [form, setForm] = useState<CreateBucketPayload>({
    code: existing?.code ?? '',
    nameHe: existing?.nameHe ?? '',
    behavior: existing?.behavior ?? 'A',
    unit: existing?.unit ?? 'HOUR',
    requiresDocument: existing?.requiresDocument ?? false,
    dailyAmount: existing?.dailyAmount ?? null,
    maxPerYear: existing?.maxPerYear ?? null,
    minDailyStandard: existing?.minDailyStandard ?? null,
    defaultCreditMode: existing?.defaultCreditMode ?? 'REPORTED',
    active: existing?.active ?? true,
    sortOrder: existing?.sortOrder ?? 0,
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      if (mode === 'edit' && existing) {
        const payload: any = {
          nameHe: form.nameHe,
          dailyAmount: form.dailyAmount,
          maxPerYear: form.maxPerYear,
          minDailyStandard: form.minDailyStandard,
          defaultCreditMode: form.defaultCreditMode,
          active: form.active,
          sortOrder: form.sortOrder,
        };
        if (!isSystem) {
          payload.code = form.code;
          payload.behavior = form.behavior;
          payload.unit = form.unit;
          payload.requiresDocument = form.requiresDocument;
        }
        return hrApi.updateBucket(existing.id, payload);
      }
      return hrApi.createBucket(form);
    },
    onSuccess: () => {
      notify.success(mode === 'create' ? 'Bucket added' : 'Bucket updated');
      onSaved();
    },
    onError: (e: any) =>
      setError(e?.response?.data?.message ?? e?.message ?? 'Failed to save'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.code.trim() || !form.nameHe.trim()) {
      setError('Code and Hebrew name are required.');
      return;
    }
    save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'create' ? 'New special-hour bucket' : 'Edit bucket'}
      description={isSystem ? 'שורת מערכת — חלק מהשדות נעולים' : undefined}
      widthClass="w-[640px] max-w-[94vw]"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="hr-bucket-form"
            disabled={save.isPending}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
          </button>
        </>
      }
    >
      <form id="hr-bucket-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <TextField
            label="Code · קוד"
            name="code"
            required
            disabled={isSystem}
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            inputClassName="font-mono"
          />
          <TextField
            label="Name (Hebrew) · שם בעברית"
            name="nameHe"
            required
            value={form.nameHe}
            onChange={(e) => setForm((f) => ({ ...f, nameHe: e.target.value }))}
          />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <SelectField
            label="Behavior"
            name="behavior"
            disabled={isSystem}
            value={form.behavior}
            onChange={(e) =>
              setForm((f) => ({ ...f, behavior: e.target.value as BucketBehavior }))
            }
          >
            <option value="A">A · ניהול (overhead)</option>
            <option value="B">B · יומי (auto-credit)</option>
            <option value="C">C · שנתי (annual pool)</option>
          </SelectField>
          <SelectField
            label="Unit"
            name="unit"
            disabled={isSystem}
            value={form.unit}
            onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value as AbsenceUnit }))}
          >
            <option value="HOUR">Hours · שעות</option>
            <option value="DAY">Days · ימים</option>
          </SelectField>
          <SelectField
            label="Default credit mode"
            name="defaultCreditMode"
            value={form.defaultCreditMode ?? 'REPORTED'}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                defaultCreditMode: e.target.value as BucketCreditMode,
              }))
            }
          >
            <option value="REPORTED">REPORTED (user logs)</option>
            <option value="AUTO">AUTO (system credits)</option>
          </SelectField>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <TextField
            label="Daily amount"
            name="dailyAmount"
            type="number"
            step="0.25"
            min={0}
            value={form.dailyAmount ?? ''}
            placeholder="—"
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                dailyAmount: e.target.value.trim() === '' ? null : Number(e.target.value),
              }))
            }
            inputClassName="font-mono"
          />
          <TextField
            label="Max / year"
            name="maxPerYear"
            type="number"
            step="0.25"
            min={0}
            value={form.maxPerYear ?? ''}
            placeholder="—"
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                maxPerYear: e.target.value.trim() === '' ? null : Number(e.target.value),
              }))
            }
            inputClassName="font-mono"
          />
          <TextField
            label="Min daily std"
            name="minDailyStandard"
            type="number"
            step="0.25"
            min={0}
            value={form.minDailyStandard ?? ''}
            placeholder="—"
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                minDailyStandard:
                  e.target.value.trim() === '' ? null : Number(e.target.value),
              }))
            }
            inputClassName="font-mono"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label
            className={cn(
              'flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5 text-[13px] font-medium text-slate-700 dark:text-slate-200 cursor-pointer',
              isSystem && 'opacity-50 cursor-not-allowed',
            )}
          >
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600"
              checked={!!form.requiresDocument}
              disabled={isSystem}
              onChange={(e) => setForm((f) => ({ ...f, requiresDocument: e.target.checked }))}
            />
            Requires document · דורש מסמך
          </label>
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5 text-[13px] font-medium text-slate-700 dark:text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600"
              checked={!!form.active}
              onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
            />
            Active · פעיל
          </label>
        </div>

        {error && <p className="text-[12px] font-medium text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}
