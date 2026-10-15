import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Pencil, Plus, Trash2 } from 'lucide-react';
import { Modal } from '@/components/shared/modal';
import { SelectField, TextField } from '@/components/shared/field';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { usePermissions } from '@/hooks/use-permissions';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import {
  hrApi,
  type CreateHrCalendarDayPayload,
  type HrCalendarDay,
  type CalendarDayAppliesTo,
} from '../api/hr.api';

/**
 * HR Phase B4 (2026-10-15) — Calendar exceptions for /hr/settings.
 * REGULAR days are hidden from the type picker: the time/attendance
 * engine defaults missing dates to REGULAR implicitly (never
 * materialised in `calendar_days`).
 */
const TYPE_LABEL: Record<HrCalendarDay['type'], { he: string; en: string; cls: string }> = {
  HOLIDAY:     { he: 'חג',         en: 'Holiday',     cls: 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300' },
  HOLIDAY_EVE: { he: 'ערב חג',     en: 'Holiday eve', cls: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-300' },
  CHOL_HAMOED: { he: 'חול המועד',  en: 'Chol hamoed', cls: 'bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-300' },
  REST:        { he: 'מנוחה',      en: 'Rest',        cls: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300' },
};

const APPLIES_LABEL: Record<CalendarDayAppliesTo, string> = {
  all: 'All',
  employees_only: 'Employees only',
  partners_only: 'Partners only',
};

const currentYear = new Date().getFullYear();
const YEARS = Array.from({ length: 7 }, (_, i) => currentYear - 2 + i);

export function CalendarSection() {
  const { can } = usePermissions();
  const canWrite = can('hr', 'write');
  const qc = useQueryClient();
  const confirm = useConfirm();

  const [year, setYear] = useState<number>(currentYear);
  const [editing, setEditing] = useState<HrCalendarDay | null>(null);
  const [showNew, setShowNew] = useState(false);

  const { data: rows = [], isLoading } = useQuery<HrCalendarDay[]>({
    queryKey: ['hr', 'calendar-days', year],
    queryFn: () => hrApi.listCalendarDays(year),
    staleTime: 30 * 1000,
  });

  const remove = useMutation({
    mutationFn: (id: number) => hrApi.deleteCalendarDay(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr', 'calendar-days', year] });
      notify.success('Calendar day deleted');
    },
    onError: (e: any) => notify.apiError(e, 'Failed to delete'),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            שנה · Year
          </label>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[13px] font-mono text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
          >
            {YEARS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 px-3.5 py-2 text-[13px] font-semibold text-white"
          >
            <Plus className="h-3.5 w-3.5" /> New day
          </button>
        )}
      </div>

      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-[#FAFBFC] dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-700">
              <th className="px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]">Date</th>
              <th className="px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]">Day</th>
              <th className="px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]">Type</th>
              <th className="px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]">Name</th>
              <th className="px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]">Applies to</th>
              <th className="px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]">Notes</th>
              <th className="px-3 py-1.5 w-[90px]"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-[13px] text-slate-400 dark:text-slate-500">Loading…</td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-[13px] text-slate-400 dark:text-slate-500">
                  <CalendarDays className="mx-auto mb-2 h-6 w-6 text-slate-300 dark:text-slate-600" />
                  No calendar exceptions for {year}.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <CalendarRow
                  key={row.id}
                  row={row}
                  canWrite={canWrite}
                  onEdit={() => setEditing(row)}
                  onDelete={async () => {
                    const ok = await confirm(`Delete "${row.name}" (${row.date.slice(0, 10)})?`, {
                      title: 'Delete calendar day?',
                      variant: 'danger',
                      confirmLabel: 'Delete',
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
        <CalendarModal
          year={year}
          mode="create"
          onClose={() => setShowNew(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['hr', 'calendar-days', year] });
            setShowNew(false);
          }}
        />
      )}
      {editing && (
        <CalendarModal
          year={year}
          mode="edit"
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['hr', 'calendar-days', year] });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function CalendarRow({
  row,
  canWrite,
  onEdit,
  onDelete,
}: {
  row: HrCalendarDay;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const dateObj = useMemo(() => new Date(row.date), [row.date]);
  const dow = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
  const type = TYPE_LABEL[row.type];
  return (
    <tr className="group border-b border-slate-50 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40 text-[13px]">
      <td className="px-3 py-2 font-mono text-xs text-slate-700 dark:text-slate-200 tabular-nums">
        {row.date.slice(0, 10)}
      </td>
      <td className="px-3 py-2 text-slate-500 dark:text-slate-400 text-xs">{dow}</td>
      <td className="px-3 py-2">
        <span className={cn('inline-flex items-center rounded-[5px] px-2 py-0.5 text-[11px] font-bold tracking-wide', type.cls)}>
          {type.he} · {type.en}
        </span>
      </td>
      <td className="px-3 py-2 text-slate-700 dark:text-slate-200">
        <span dir="rtl">{row.name}</span>
      </td>
      <td className="px-3 py-2">
        <span className="inline-flex items-center rounded-[5px] bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {APPLIES_LABEL[row.appliesTo]}
        </span>
      </td>
      <td className="px-3 py-2 text-[12px] text-slate-500 dark:text-slate-400 max-w-[220px] truncate" title={row.notes ?? undefined}>
        {row.notes ?? <span className="text-slate-300 dark:text-slate-600">—</span>}
      </td>
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
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete"
              className="w-[30px] h-[30px] rounded-[7px] bg-transparent hover:bg-red-50 dark:hover:bg-red-900/30 text-slate-300 dark:text-slate-500 hover:text-red-600 dark:hover:text-red-400 inline-flex items-center justify-center"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

interface CalendarModalProps {
  year: number;
  mode: 'create' | 'edit';
  existing?: HrCalendarDay;
  onClose: () => void;
  onSaved: () => void;
}

function CalendarModal({ year, mode, existing, onClose, onSaved }: CalendarModalProps) {
  const [form, setForm] = useState<CreateHrCalendarDayPayload>(() => ({
    date: existing?.date.slice(0, 10) ?? `${year}-01-01`,
    type: existing?.type ?? 'HOLIDAY',
    name: existing?.name ?? '',
    appliesTo: existing?.appliesTo ?? 'all',
    halfDayUntil: existing?.halfDayUntil ?? '',
    notes: existing?.notes ?? '',
    isRecurring: existing?.isRecurring ?? false,
  }));
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      if (mode === 'create') return hrApi.createCalendarDay(cleanPayload(form));
      return hrApi.updateCalendarDay(existing!.id, cleanPayload(form));
    },
    onSuccess: () => {
      notify.success(mode === 'create' ? 'Calendar day added' : 'Calendar day updated');
      onSaved();
    },
    onError: (e: any) => setError(e?.response?.data?.message ?? e?.message ?? 'Failed to save'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.date || !form.name.trim()) {
      setError('Date and name are required.');
      return;
    }
    save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'create' ? 'Add calendar exception' : 'Edit calendar exception'}
      widthClass="w-[520px] max-w-[94vw]"
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
            form="hr-calendar-form"
            disabled={save.isPending}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
          </button>
        </>
      }
    >
      <form id="hr-calendar-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <TextField
            label="Date · תאריך"
            name="date"
            type="date"
            required
            value={form.date}
            onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
          />
          <SelectField
            label="Type · סוג"
            name="type"
            required
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as HrCalendarDay['type'] }))}
          >
            <option value="HOLIDAY">Holiday · חג</option>
            <option value="HOLIDAY_EVE">Holiday eve · ערב חג</option>
            <option value="CHOL_HAMOED">Chol-hamoed · חול המועד</option>
            <option value="REST">Rest · מנוחה</option>
          </SelectField>
        </div>

        <TextField
          label="Name · שם"
          name="name"
          required
          value={form.name}
          placeholder="e.g. ראש השנה · Rosh Hashanah"
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />

        <div className="grid grid-cols-2 gap-4">
          <SelectField
            label="Applies to · חל על"
            name="appliesTo"
            value={form.appliesTo ?? 'all'}
            onChange={(e) =>
              setForm((f) => ({ ...f, appliesTo: e.target.value as CalendarDayAppliesTo }))
            }
          >
            <option value="all">All</option>
            <option value="employees_only">Employees only</option>
            <option value="partners_only">Partners only</option>
          </SelectField>
          <TextField
            label="Half-day until · חצי יום עד (HH:MM)"
            name="halfDayUntil"
            placeholder="e.g. 13:00"
            value={form.halfDayUntil ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, halfDayUntil: e.target.value || null }))}
            inputClassName="font-mono"
          />
        </div>

        <TextField
          label="Notes · הערות"
          name="notes"
          value={form.notes ?? ''}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value || null }))}
        />

        <label className="inline-flex items-center gap-2 text-[13px] text-slate-700 dark:text-slate-200 cursor-pointer">
          <input
            type="checkbox"
            checked={form.isRecurring ?? false}
            onChange={(e) => setForm((f) => ({ ...f, isRecurring: e.target.checked }))}
            className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600"
          />
          Recurring annually · חוזר מדי שנה
        </label>

        {error && (
          <p className="text-[12px] font-medium text-red-600 dark:text-red-400">{error}</p>
        )}
      </form>
    </Modal>
  );
}

/** Drop empty-string optional fields so the DTO's optional validation
 *  doesn't choke on them, and null out explicit "clear" cases. */
function cleanPayload(f: CreateHrCalendarDayPayload): CreateHrCalendarDayPayload {
  const out: CreateHrCalendarDayPayload = {
    date: f.date,
    type: f.type,
    name: f.name.trim(),
    appliesTo: f.appliesTo ?? 'all',
    isRecurring: f.isRecurring ?? false,
  };
  if (f.halfDayUntil && f.halfDayUntil.trim()) out.halfDayUntil = f.halfDayUntil.trim();
  else if (f.halfDayUntil === null) out.halfDayUntil = null;
  if (f.notes && f.notes.trim()) out.notes = f.notes.trim();
  else if (f.notes === null) out.notes = null;
  return out;
}
