import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HelpCircle, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { Modal } from '@/components/shared/modal';
import { SelectField, TextField } from '@/components/shared/field';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { usePermissions } from '@/hooks/use-permissions';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import {
  hrApi,
  type AbsenceType,
  type AbsenceUnit,
  type CreateAbsenceTypePayload,
} from '../api/hr.api';

export function AbsenceTypesSection() {
  const { can } = usePermissions();
  const canWrite = can('hr', 'write');
  const qc = useQueryClient();
  const confirm = useConfirm();

  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<AbsenceType | null>(null);

  const { data: rows = [], isLoading } = useQuery<AbsenceType[]>({
    queryKey: ['hr', 'absence-types'],
    queryFn: () => hrApi.listAbsenceTypes(),
    staleTime: 60 * 1000,
  });

  const remove = useMutation({
    mutationFn: (id: number) => hrApi.deleteAbsenceType(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr', 'absence-types'] });
      notify.success('Absence type deactivated');
    },
    onError: (e: any) => notify.apiError(e, 'Failed to deactivate'),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-slate-500 dark:text-slate-400">
          סוגי היעדרות — חופשה, מחלה, מילואים וכו׳. שורות מערכת נעולות
          חלקית ולא ניתנות למחיקה.
        </p>
        {canWrite && (
          <button
            type="button"
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 px-3.5 py-2 text-[13px] font-semibold text-white"
          >
            <Plus className="h-3.5 w-3.5" /> New type
          </button>
        )}
      </div>

      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-[#FAFBFC] dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-700">
              <Th>Name</Th>
              <Th>Code</Th>
              <Th>Unit</Th>
              <Th className="text-center">Doc</Th>
              <Th className="text-center">Sick</Th>
              <Th className="text-right">Max / year</Th>
              <Th className="text-center">Half</Th>
              <Th className="text-center">Active</Th>
              <Th className="text-center">Lock</Th>
              <th className="px-3 py-1.5 w-[90px]"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={10} className="px-3 py-10 text-center text-[13px] text-slate-400 dark:text-slate-500">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={10} className="px-3 py-10 text-center text-[13px] text-slate-400 dark:text-slate-500">No absence types.</td></tr>
            ) : (
              rows.map((row) => (
                <AbsenceTypeRow
                  key={row.id}
                  row={row}
                  canWrite={canWrite}
                  onEdit={() => setEditing(row)}
                  onDelete={async () => {
                    const ok = await confirm(`Deactivate "${row.nameHe}"? Historical records remain intact.`, {
                      title: 'Deactivate absence type?',
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
        <AbsenceTypeModal
          mode="create"
          onClose={() => setShowNew(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['hr', 'absence-types'] });
            setShowNew(false);
          }}
        />
      )}
      {editing && (
        <AbsenceTypeModal
          mode="edit"
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['hr', 'absence-types'] });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]',
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn('px-3 py-2 text-[13px] text-slate-700 dark:text-slate-200', className)}>{children}</td>;
}

function Flag({ on }: { on: boolean }) {
  return on ? (
    <span className="inline-flex rounded-[5px] bg-emerald-50 dark:bg-emerald-900/30 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
      Yes
    </span>
  ) : (
    <span className="text-[11px] text-slate-300 dark:text-slate-600">—</span>
  );
}

function AbsenceTypeRow({
  row,
  canWrite,
  onEdit,
  onDelete,
}: {
  row: AbsenceType;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <tr className={cn('group border-b border-slate-50 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40', !row.active && 'opacity-55')}>
      <Td>
        <span dir="rtl" className="font-semibold">{row.nameHe}</span>
      </Td>
      <Td className="font-mono text-xs text-slate-500 dark:text-slate-400">{row.code}</Td>
      <Td>
        <span className="inline-flex rounded-[5px] bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {row.unit === 'DAY' ? 'days' : 'hours'}
        </span>
      </Td>
      <Td className="text-center"><Flag on={row.requiresDocument} /></Td>
      <Td className="text-center">
        <span
          className="inline-flex items-center gap-1"
          title="היעדרות מסוג זה מנוכה מיתרת ימי מחלה · Counts toward sick balance."
        >
          <Flag on={row.deductsFromSick} />
          {row.deductsFromSick && (
            <HelpCircle className="h-3 w-3 text-slate-400 dark:text-slate-500" />
          )}
        </span>
      </Td>
      <Td className="text-right font-mono tabular-nums text-xs">
        {row.maxPerYear ?? <span className="font-sans text-slate-300 dark:text-slate-600">—</span>}
      </Td>
      <Td className="text-center"><Flag on={row.halfDay} /></Td>
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
            title="System row — code/unit/doc/sick/half-day are locked."
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
  existing?: AbsenceType;
  onClose: () => void;
  onSaved: () => void;
}

function AbsenceTypeModal({ mode, existing, onClose, onSaved }: ModalProps) {
  const isSystem = !!existing?.isSystem;
  const [form, setForm] = useState<CreateAbsenceTypePayload & { active?: boolean }>({
    code: existing?.code ?? '',
    nameHe: existing?.nameHe ?? '',
    unit: existing?.unit ?? 'DAY',
    requiresDocument: existing?.requiresDocument ?? false,
    deductsFromSick: existing?.deductsFromSick ?? false,
    maxPerYear: existing?.maxPerYear ?? null,
    halfDay: existing?.halfDay ?? false,
    active: existing?.active ?? true,
    sortOrder: existing?.sortOrder ?? 0,
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      // On edit, if the row is system, we strip the locked fields
      // from the payload — server strips them too, but trimming here
      // keeps the audit log clean.
      if (mode === 'edit' && existing) {
        const payload: any = { nameHe: form.nameHe, maxPerYear: form.maxPerYear, active: form.active, sortOrder: form.sortOrder };
        if (!isSystem) {
          payload.code = form.code;
          payload.unit = form.unit;
          payload.requiresDocument = form.requiresDocument;
          payload.deductsFromSick = form.deductsFromSick;
          payload.halfDay = form.halfDay;
        }
        return hrApi.updateAbsenceType(existing.id, payload);
      }
      return hrApi.createAbsenceType(form);
    },
    onSuccess: () => {
      notify.success(mode === 'create' ? 'Absence type added' : 'Absence type updated');
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
      title={mode === 'create' ? 'New absence type' : 'Edit absence type'}
      description={isSystem ? 'שורת מערכת — חלק מהשדות נעולים' : undefined}
      widthClass="w-[560px] max-w-[94vw]"
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
            form="hr-absence-type-form"
            disabled={save.isPending}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
          </button>
        </>
      }
    >
      <form id="hr-absence-type-form" onSubmit={submit} className="space-y-4">
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

        <div className="grid grid-cols-2 gap-4">
          <SelectField
            label="Unit · יחידה"
            name="unit"
            disabled={isSystem}
            value={form.unit}
            onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value as AbsenceUnit }))}
          >
            <option value="DAY">Days · ימים</option>
            <option value="HOUR">Hours · שעות</option>
          </SelectField>
          <TextField
            label="Max / year · מקסימום לשנה"
            name="maxPerYear"
            type="number"
            min={0}
            value={form.maxPerYear ?? ''}
            placeholder="unlimited"
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                maxPerYear: e.target.value.trim() === '' ? null : Number(e.target.value),
              }))
            }
            inputClassName="font-mono"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Toggle
            label="Requires document · דורש מסמך"
            checked={!!form.requiresDocument}
            disabled={isSystem}
            onChange={(v) => setForm((f) => ({ ...f, requiresDocument: v }))}
          />
          <Toggle
            label="Deducts from sick · על חשבון מחלה"
            help="היעדרות מסוג זה מנוכה מיתרת ימי מחלה · Counts toward sick balance."
            checked={!!form.deductsFromSick}
            disabled={isSystem}
            onChange={(v) => setForm((f) => ({ ...f, deductsFromSick: v }))}
          />
          <Toggle
            label="Half-day allowed · חצי יום"
            checked={!!form.halfDay}
            disabled={isSystem}
            onChange={(v) => setForm((f) => ({ ...f, halfDay: v }))}
          />
          <Toggle
            label="Active · פעיל"
            checked={!!form.active}
            onChange={(v) => setForm((f) => ({ ...f, active: v }))}
          />
        </div>

        <TextField
          label="Sort order"
          name="sortOrder"
          type="number"
          value={String(form.sortOrder ?? 0)}
          onChange={(e) => setForm((f) => ({ ...f, sortOrder: Number(e.target.value) || 0 }))}
          inputClassName="font-mono"
        />

        {error && <p className="text-[12px] font-medium text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
  help,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  help?: string;
}) {
  return (
    <label
      className={cn(
        'flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5 text-[13px] font-medium text-slate-700 dark:text-slate-200 cursor-pointer',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
      title={help}
    >
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
      {help && <HelpCircle className="h-3 w-3 text-slate-400 dark:text-slate-500" />}
    </label>
  );
}
