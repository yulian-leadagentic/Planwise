import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FileText,
  Paperclip,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import { Modal } from '@/components/shared/modal';
import { TextField, SelectField, TextAreaField } from '@/components/shared/field';
import { usePermissions } from '@/hooks/use-permissions';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/shared/confirm-dialog';
import {
  hrApi,
  type AbsenceRecord,
  type AbsenceType,
  type CreateAbsencePayload,
  type EmployeeAttachment,
  type HrEligibility,
  type HrEmployeeDetail,
  type SpecialHourBucketLite,
} from './api/hr.api';

/**
 * HR Phase A4 (2026-10-15) — employee drawer. Hosts two surfaces:
 *   1. HR employment fields (employmentType, accountingEmployeeNumber,
 *      dailyStandardHours, employmentDate, employmentEndDate) — editable
 *      only when the role carries `hr:write`.
 *   2. "זכאויות B" list — current + inactive bucket eligibilities,
 *      with an inline "+ Add eligibility" dialog restricted to active
 *      B-behaviour buckets (per §3.6).
 *
 * SpecialHourBucket catalog is fetched client-side (one small list) and
 * cached; the drawer only grants rows HR already set up server-side.
 */
export interface EmployeeDrawerProps {
  userId: number;
  onClose: () => void;
}

export function EmployeeDrawer({ userId, onClose }: EmployeeDrawerProps) {
  const qc = useQueryClient();
  const { can } = usePermissions();
  // HR data is behind hr:write — Clerks (hr:read only) see a read-only
  // drawer. The guard on the API side is the authority; this just hides
  // destructive controls so a Clerk can browse without seeing dead UI.
  const canWrite = can('hr', 'write');

  const { data: employee } = useQuery<HrEmployeeDetail>({
    queryKey: ['hr', 'employees', userId],
    queryFn: () => hrApi.getEmployee(userId),
  });

  if (!employee) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Loading…"
        widthClass="w-[640px] max-w-[94vw]"
      >
        <div className="py-10 text-center text-sm text-slate-400 dark:text-slate-500">
          Loading employee…
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <span>{employee.firstName} {employee.lastName}</span>
          {!employee.isActive && (
            <span className="rounded-[5px] bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Inactive
            </span>
          )}
        </div>
      }
      description={employee.email}
      widthClass="w-[760px] max-w-[94vw]"
    >
      <EmploymentFieldsSection employee={employee} canWrite={canWrite} qc={qc} />
      <div className="my-6 h-px bg-slate-100 dark:bg-slate-800" />
      <EligibilitiesSection employee={employee} canWrite={canWrite} qc={qc} />
      <div className="my-6 h-px bg-slate-100 dark:bg-slate-800" />
      <AbsencesSection employee={employee} canWrite={canWrite} qc={qc} />
      <div className="my-6 h-px bg-slate-100 dark:bg-slate-800" />
      <DocumentsSection employee={employee} canWrite={canWrite} qc={qc} />
    </Modal>
  );
}

// ─── Employment fields section ────────────────────────────────────────

interface EmploymentFieldsSectionProps {
  employee: HrEmployeeDetail;
  canWrite: boolean;
  qc: ReturnType<typeof useQueryClient>;
}

function EmploymentFieldsSection({ employee, canWrite, qc }: EmploymentFieldsSectionProps) {
  const [form, setForm] = useState({
    employmentType: employee.employmentType ?? '',
    accountingEmployeeNumber: employee.accountingEmployeeNumber ?? '',
    dailyStandardHours:
      employee.dailyStandardHours != null ? String(employee.dailyStandardHours) : '',
    employmentDate: employee.employmentDate ? employee.employmentDate.slice(0, 10) : '',
    employmentEndDate: employee.employmentEndDate
      ? employee.employmentEndDate.slice(0, 10)
      : '',
  });

  // Keep local form in sync when the drawer is re-rendered after a save
  // or when the parent refetches.
  useEffect(() => {
    setForm({
      employmentType: employee.employmentType ?? '',
      accountingEmployeeNumber: employee.accountingEmployeeNumber ?? '',
      dailyStandardHours:
        employee.dailyStandardHours != null ? String(employee.dailyStandardHours) : '',
      employmentDate: employee.employmentDate ? employee.employmentDate.slice(0, 10) : '',
      employmentEndDate: employee.employmentEndDate
        ? employee.employmentEndDate.slice(0, 10)
        : '',
    });
  }, [employee]);

  const save = useMutation({
    mutationFn: () =>
      hrApi.updateEmployee(employee.id, {
        employmentType: form.employmentType ? (form.employmentType as 'GLOBAL' | 'HOURLY') : null,
        accountingEmployeeNumber: form.accountingEmployeeNumber.trim() || null,
        dailyStandardHours:
          form.dailyStandardHours.trim() === '' ? null : Number(form.dailyStandardHours),
        employmentDate: form.employmentDate || null,
        employmentEndDate: form.employmentEndDate || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr', 'employees'] });
      qc.invalidateQueries({ queryKey: ['hr', 'employees', employee.id] });
      notify.success('Employee updated');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update employee'),
  });

  const dirty =
    (form.employmentType || null) !== (employee.employmentType ?? null) ||
    form.accountingEmployeeNumber !== (employee.accountingEmployeeNumber ?? '') ||
    form.dailyStandardHours !==
      (employee.dailyStandardHours != null ? String(employee.dailyStandardHours) : '') ||
    form.employmentDate !==
      (employee.employmentDate ? employee.employmentDate.slice(0, 10) : '') ||
    form.employmentEndDate !==
      (employee.employmentEndDate ? employee.employmentEndDate.slice(0, 10) : '');

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Employment · פרטי העסקה
        </h3>
        {canWrite && dirty && (
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <SelectField
          label="Employment type · סוג העסקה"
          name="employmentType"
          value={form.employmentType}
          disabled={!canWrite}
          onChange={(e) =>
            setForm((f) => ({ ...f, employmentType: e.target.value as '' | 'GLOBAL' | 'HOURLY' }))
          }
        >
          <option value="">— Select —</option>
          <option value="GLOBAL">Global · גלובלי</option>
          <option value="HOURLY">Hourly · שעתי</option>
        </SelectField>

        <TextField
          label="Payroll # · מס' הנהח״ש"
          name="accountingEmployeeNumber"
          value={form.accountingEmployeeNumber}
          disabled={!canWrite}
          placeholder="e.g. 1024"
          inputClassName="font-mono"
          onChange={(e) =>
            setForm((f) => ({ ...f, accountingEmployeeNumber: e.target.value }))
          }
        />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-4">
        <TextField
          label="Daily std · תקן יומי"
          name="dailyStandardHours"
          type="number"
          step="0.25"
          min={0}
          max={24}
          disabled={!canWrite}
          value={form.dailyStandardHours}
          placeholder="e.g. 8"
          onChange={(e) =>
            setForm((f) => ({ ...f, dailyStandardHours: e.target.value }))
          }
        />
        <TextField
          label="Start date · תחילת העסקה"
          name="employmentDate"
          type="date"
          disabled={!canWrite}
          value={form.employmentDate}
          onChange={(e) =>
            setForm((f) => ({ ...f, employmentDate: e.target.value }))
          }
        />
        <TextField
          label="End date · סיום העסקה"
          name="employmentEndDate"
          type="date"
          disabled={!canWrite}
          value={form.employmentEndDate}
          onChange={(e) =>
            setForm((f) => ({ ...f, employmentEndDate: e.target.value }))
          }
        />
      </div>
    </section>
  );
}

// ─── Eligibilities section ────────────────────────────────────────────

interface EligibilitiesSectionProps {
  employee: HrEmployeeDetail;
  canWrite: boolean;
  qc: ReturnType<typeof useQueryClient>;
}

function EligibilitiesSection({ employee, canWrite, qc }: EligibilitiesSectionProps) {
  const confirm = useConfirm();
  const [showAdd, setShowAdd] = useState(false);

  const sorted = useMemo(
    () =>
      [...employee.bucketEligibilities].sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return b.startDate.localeCompare(a.startDate);
      }),
    [employee.bucketEligibilities],
  );

  const remove = useMutation({
    mutationFn: (eligId: number) => hrApi.deactivateEligibility(employee.id, eligId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr', 'employees', employee.id] });
      notify.success('Eligibility deactivated');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to deactivate'),
  });

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          זכאויות B · Bucket eligibilities
        </h3>
        {canWrite && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 rounded-[7px] border border-dashed border-slate-300 dark:border-slate-600 bg-transparent px-3 py-1.5 text-[13px] font-semibold text-slate-500 dark:text-slate-400 hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:text-blue-600 dark:hover:text-blue-400"
          >
            <Plus className="h-3.5 w-3.5" />
            Add eligibility
          </button>
        )}
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/40 py-6 text-center text-[13px] text-slate-500 dark:text-slate-400">
          No eligibilities yet.
          {canWrite && ' Click "Add eligibility" to grant a bucket.'}
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-[14px] border border-slate-200 dark:border-slate-700">
          {sorted.map((e) => (
            <EligibilityRow
              key={e.id}
              eligibility={e}
              canWrite={canWrite && e.active}
              onDeactivate={async () => {
                const ok = await confirm(
                  `Deactivate "${e.bucket?.nameHe ?? e.bucket?.code}" for this employee? The row stays in history.`,
                  { title: 'Deactivate eligibility?', variant: 'danger', confirmLabel: 'Deactivate' },
                );
                if (ok) remove.mutate(e.id);
              }}
            />
          ))}
        </ul>
      )}

      {showAdd && (
        <AddEligibilityDialog
          employee={employee}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['hr', 'employees', employee.id] });
            setShowAdd(false);
          }}
        />
      )}
    </section>
  );
}

interface EligibilityRowProps {
  eligibility: HrEligibility;
  canWrite: boolean;
  onDeactivate: () => void;
}

function EligibilityRow({ eligibility: e, canWrite, onDeactivate }: EligibilityRowProps) {
  const name = e.bucket?.nameHe ?? e.bucket?.code ?? `Bucket #${e.bucketId}`;
  const code = e.bucket?.code ?? '';
  return (
    <li className={cn('group flex items-center justify-between gap-3 px-3 py-2.5', !e.active && 'opacity-55')}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span dir="rtl" className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {name}
          </span>
          {code && (
            <span className="rounded-[5px] bg-blue-50 dark:bg-blue-900/30 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-blue-600 dark:text-blue-300">
              {code}
            </span>
          )}
          {!e.active && (
            <span className="rounded-[5px] bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Inactive
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="font-mono tabular-nums">
            {e.dailyAmount}
            {e.bucket?.unit === 'DAY' ? ' day/day' : 'h/day'}
          </span>
          <span>·</span>
          <span className="font-mono tabular-nums">
            {e.startDate.slice(0, 10)} → {e.endDate.slice(0, 10)}
          </span>
          {e.creditMode && (
            <>
              <span>·</span>
              <span>credit: {e.creditMode.toLowerCase()}</span>
            </>
          )}
        </div>
      </div>
      {canWrite && (
        <button
          type="button"
          onClick={onDeactivate}
          aria-label="Deactivate eligibility"
          className="opacity-0 group-hover:opacity-100 inline-flex h-[30px] w-[30px] items-center justify-center rounded-[7px] text-slate-300 dark:text-slate-500 hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-600 dark:hover:text-red-400"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </li>
  );
}

// ─── Add eligibility dialog ───────────────────────────────────────────

interface AddEligibilityDialogProps {
  employee: HrEmployeeDetail;
  onClose: () => void;
  onSaved: () => void;
}

function AddEligibilityDialog({ employee, onClose, onSaved }: AddEligibilityDialogProps) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const yearEnd = useMemo(() => `${new Date().getFullYear()}-12-31`, []);

  // SpecialHourBucket catalog — B behaviour + active only, per spec §3.6.
  // Cached for the session; the catalog is small and rarely changes.
  const { data: catalog = [] } = useQuery<SpecialHourBucketLite[]>({
    queryKey: ['hr', 'buckets', 'B', 'active'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => hrApi.listBuckets({ behavior: 'B', activeOnly: true }),
  });

  const [bucketId, setBucketId] = useState<string>('');
  const [dailyAmount, setDailyAmount] = useState<string>('');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(yearEnd);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const picked = useMemo(
    () => catalog.find((b) => String(b.id) === bucketId) ?? null,
    [catalog, bucketId],
  );

  // Prefill dailyAmount from the bucket default when the user picks one.
  useEffect(() => {
    if (picked && picked.dailyAmount != null && dailyAmount === '') {
      setDailyAmount(String(picked.dailyAmount));
    }
  }, [picked, dailyAmount]);

  const create = useMutation({
    mutationFn: () => {
      if (!picked) throw new Error('pick a bucket');
      return hrApi.createEligibility(employee.id, {
        bucketId: picked.id,
        dailyAmount: dailyAmount ? Number(dailyAmount) : undefined,
        startDate,
        endDate,
      });
    },
    onSuccess: (res) => {
      setWarnings(res.warnings ?? []);
      if (!res.warnings || res.warnings.length === 0) {
        notify.success('Eligibility added');
        onSaved();
      } else {
        // Keep the dialog open to let HR see the soft warning; they can
        // click "Done" to close.
        notify.success('Eligibility added (see warnings)');
      }
    },
    onError: (err: any) => {
      setError(err?.response?.data?.message ?? err?.message ?? 'Failed to add');
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!bucketId) {
      setError('Pick a bucket.');
      return;
    }
    if (!startDate || !endDate) {
      setError('Both dates are required.');
      return;
    }
    if (endDate < startDate) {
      setError('End date must be on or after start date.');
      return;
    }
    const amt = dailyAmount ? Number(dailyAmount) : (picked?.dailyAmount ?? null);
    if (amt == null || !(amt > 0)) {
      setError('Daily amount must be greater than zero.');
      return;
    }
    create.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add bucket eligibility"
      description="הוספת זכאות שעות מיוחדות (B)"
      widthClass="w-[480px] max-w-[92vw]"
      footer={
        warnings.length > 0 ? (
          <button
            type="button"
            onClick={onSaved}
            className="rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-700"
          >
            Done
          </button>
        ) : (
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
              form="hr-add-eligibility-form"
              disabled={create.isPending}
              className="rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {create.isPending ? 'Saving…' : 'Grant'}
            </button>
          </>
        )
      }
    >
      <form id="hr-add-eligibility-form" onSubmit={submit} className="space-y-4">
        {catalog.length === 0 ? (
          <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-[12px] text-amber-800 dark:text-amber-200">
            No B-behaviour buckets visible yet. Phase B adds a dedicated
            catalog endpoint; today the picker reads from the eligibilities
            already granted to employees in the roster.
          </div>
        ) : (
          <SelectField
            label="Bucket · קופה"
            name="bucketId"
            required
            value={bucketId}
            onChange={(e) => {
              setBucketId(e.target.value);
              setDailyAmount(''); // re-prefill from the new bucket default
            }}
          >
            <option value="">— Select bucket —</option>
            {catalog.map((b) => (
              <option key={b.id} value={b.id}>
                {b.nameHe} ({b.code})
                {b.dailyAmount != null ? ` · ${b.dailyAmount}h default` : ''}
              </option>
            ))}
          </SelectField>
        )}

        <TextField
          label="Daily amount · שעות ליום"
          name="dailyAmount"
          type="number"
          step="0.01"
          min={0}
          value={dailyAmount}
          placeholder={
            picked?.dailyAmount != null
              ? `Default ${picked.dailyAmount}h`
              : 'e.g. 1'
          }
          onChange={(e) => setDailyAmount(e.target.value)}
          inputClassName="font-mono"
        />

        <div className="grid grid-cols-2 gap-4">
          <TextField
            label="Start date · תחילת תוקף"
            name="startDate"
            type="date"
            required
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
          <TextField
            label="End date · סיום תוקף"
            name="endDate"
            type="date"
            required
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>

        {error && (
          <p className="text-[12px] font-medium text-red-600 dark:text-red-400">{error}</p>
        )}
        {warnings.length > 0 && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
              Warning
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] text-amber-800 dark:text-amber-200">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </Modal>
  );
}

// ─── Absences section (Phase B4) ──────────────────────────────────────

interface AbsencesSectionProps {
  employee: HrEmployeeDetail;
  canWrite: boolean;
  qc: ReturnType<typeof useQueryClient>;
}

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = Array.from({ length: 7 }, (_, i) => CURRENT_YEAR - 2 + i);

function AbsencesSection({ employee, canWrite, qc }: AbsencesSectionProps) {
  const confirm = useConfirm();
  const [year, setYear] = useState<number>(CURRENT_YEAR);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<AbsenceRecord | null>(null);

  const { data: rows = [], isLoading } = useQuery<AbsenceRecord[]>({
    queryKey: ['hr', 'employees', employee.id, 'absences', year],
    queryFn: () => hrApi.listAbsences(employee.id, { year }),
    staleTime: 30 * 1000,
  });

  const remove = useMutation({
    mutationFn: (id: number) => hrApi.deleteAbsence(employee.id, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr', 'employees', employee.id, 'absences', year] });
      notify.success('Absence deleted');
    },
    onError: (e: any) => notify.apiError(e, 'Failed to delete'),
  });

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          היעדרויות · Absences
        </h3>
        <div className="flex items-center gap-2">
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-[12px] font-mono text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
          >
            {YEAR_OPTIONS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          {canWrite && (
            <button
              type="button"
              onClick={() => setShowNew(true)}
              className="inline-flex items-center gap-1.5 rounded-[7px] border border-dashed border-slate-300 dark:border-slate-600 bg-transparent px-3 py-1 text-[13px] font-semibold text-slate-500 dark:text-slate-400 hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:text-blue-600 dark:hover:text-blue-400"
            >
              <Plus className="h-3.5 w-3.5" />
              New absence
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="rounded-[14px] border border-dashed border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/40 py-6 text-center text-[13px] text-slate-400 dark:text-slate-500">
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/40 py-6 text-center text-[13px] text-slate-500 dark:text-slate-400">
          אין היעדרויות ל-{year} · No absences for {year}.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-[14px] border border-slate-200 dark:border-slate-700">
          {rows.map((r) => (
            <AbsenceRow
              key={r.id}
              row={r}
              canWrite={canWrite}
              onEdit={() => setEditing(r)}
              onDelete={async () => {
                const ok = await confirm(
                  `Delete absence "${r.absenceType.nameHe}" on ${r.dateFrom.slice(0, 10)}?`,
                  { title: 'Delete absence?', variant: 'danger', confirmLabel: 'Delete' },
                );
                if (ok) remove.mutate(r.id);
              }}
            />
          ))}
        </ul>
      )}

      {showNew && (
        <AbsenceModal
          employee={employee}
          mode="create"
          onClose={() => setShowNew(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['hr', 'employees', employee.id, 'absences', year] });
            qc.invalidateQueries({ queryKey: ['hr', 'employees', employee.id, 'attachments'] });
            setShowNew(false);
          }}
        />
      )}
      {editing && (
        <AbsenceModal
          employee={employee}
          mode="edit"
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['hr', 'employees', employee.id, 'absences', year] });
            qc.invalidateQueries({ queryKey: ['hr', 'employees', employee.id, 'attachments'] });
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

function AbsenceRow({
  row,
  canWrite,
  onEdit,
  onDelete,
}: {
  row: AbsenceRecord;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const singleDay = row.dateFrom === row.dateTo;
  return (
    <li className="group flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span dir="rtl" className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {row.absenceType.nameHe}
          </span>
          <span className="rounded-[5px] bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {row.absenceType.unit === 'DAY' ? 'days' : 'hours'}
          </span>
          {row.document && (
            <a
              href={row.document.fileUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-[5px] bg-indigo-50 dark:bg-indigo-900/30 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-600 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50"
              title={row.document.fileName}
              onClick={(e) => e.stopPropagation()}
            >
              <Paperclip className="h-2.5 w-2.5" /> Doc
            </a>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="font-mono tabular-nums">
            {singleDay ? row.dateFrom.slice(0, 10) : `${row.dateFrom.slice(0, 10)} → ${row.dateTo.slice(0, 10)}`}
          </span>
          <span>·</span>
          <span className="font-mono tabular-nums">
            {row.amount}
            {row.absenceType.unit === 'DAY' ? 'd' : 'h'}
          </span>
          {row.note && (
            <>
              <span>·</span>
              <span className="truncate max-w-[280px]" title={row.note}>{row.note}</span>
            </>
          )}
        </div>
      </div>
      {canWrite && (
        <div className="opacity-0 group-hover:opacity-100 inline-flex items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            aria-label="Edit absence"
            className="w-[30px] h-[30px] rounded-[7px] bg-transparent hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-300 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 inline-flex items-center justify-center"
          >
            <Plus className="h-3.5 w-3.5 rotate-45" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label="Delete absence"
            className="w-[30px] h-[30px] rounded-[7px] bg-transparent hover:bg-red-50 dark:hover:bg-red-900/30 text-slate-300 dark:text-slate-500 hover:text-red-600 dark:hover:text-red-400 inline-flex items-center justify-center"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}
    </li>
  );
}

// ─── Absence create/edit modal ────────────────────────────────────────

interface AbsenceModalProps {
  employee: HrEmployeeDetail;
  mode: 'create' | 'edit';
  existing?: AbsenceRecord;
  onClose: () => void;
  onSaved: () => void;
}

const BEREAVEMENT_CODE = 'bereavement_1st_degree';

function AbsenceModal({ employee, mode, existing, onClose, onSaved }: AbsenceModalProps) {
  const { data: types = [] } = useQuery<AbsenceType[]>({
    queryKey: ['hr', 'absence-types', 'active'],
    queryFn: () => hrApi.listAbsenceTypes({ activeOnly: true }),
    staleTime: 5 * 60 * 1000,
  });
  const { data: attachments = [] } = useQuery<EmployeeAttachment[]>({
    queryKey: ['hr', 'employees', employee.id, 'attachments'],
    queryFn: () => hrApi.listAttachments(employee.id),
    staleTime: 30 * 1000,
  });

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [absenceTypeId, setAbsenceTypeId] = useState<string>(
    existing ? String(existing.absenceTypeId) : '',
  );
  const [dateFrom, setDateFrom] = useState(existing?.dateFrom.slice(0, 10) ?? today);
  const [dateTo, setDateTo] = useState(existing?.dateTo.slice(0, 10) ?? '');
  const [amount, setAmount] = useState(existing ? String(existing.amount) : '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [documentFileId, setDocumentFileId] = useState<number | null>(
    existing?.documentFileId ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  const picked = useMemo(
    () => types.find((t) => String(t.id) === absenceTypeId) ?? null,
    [types, absenceTypeId],
  );

  const isBereavement = picked?.code === BEREAVEMENT_CODE;

  // Prefill amount: 1 day for DAY unit (unless half-day type), full
  // dailyStandardHours for HOUR unit when the employee carries one.
  useEffect(() => {
    if (!picked || amount !== '' || mode === 'edit') return;
    if (picked.unit === 'DAY') {
      setAmount('1');
    } else if (picked.unit === 'HOUR' && employee.dailyStandardHours != null) {
      setAmount(String(employee.dailyStandardHours));
    }
  }, [picked, amount, mode, employee.dailyStandardHours]);

  const uploadMut = useMutation({
    mutationFn: (file: File) => hrApi.uploadAttachment(employee.id, file),
    onSuccess: (resp) => {
      setDocumentFileId(resp.id);
      notify.success(`Uploaded "${resp.fileName}"`);
    },
    onError: (e: any) => notify.apiError(e, 'Upload failed'),
  });

  const save = useMutation({
    mutationFn: () => {
      const payload: CreateAbsencePayload = {
        absenceTypeId: Number(absenceTypeId),
        dateFrom,
        amount: Number(amount),
        note: note.trim() || undefined,
        documentFileId: documentFileId ?? undefined,
      };
      // Only send dateTo if the user actually set one (or edited the
      // existing row). For bereavement, letting the server auto-expand
      // is the cleanest path.
      if (dateTo && dateTo !== dateFrom) payload.dateTo = dateTo;
      else if (dateTo && dateTo === dateFrom && !isBereavement) payload.dateTo = dateTo;

      if (mode === 'create') return hrApi.createAbsence(employee.id, payload);
      return hrApi.updateAbsence(employee.id, existing!.id, payload);
    },
    onSuccess: () => {
      notify.success(mode === 'create' ? 'Absence logged' : 'Absence updated');
      onSaved();
    },
    onError: (e: any) =>
      setError(e?.response?.data?.message ?? e?.message ?? 'Failed to save'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!absenceTypeId) {
      setError('Pick an absence type.');
      return;
    }
    if (!dateFrom) {
      setError('From date is required.');
      return;
    }
    if (dateTo && dateTo < dateFrom) {
      setError('To date must be on or after From date.');
      return;
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Amount must be greater than zero.');
      return;
    }
    if (picked?.requiresDocument && documentFileId == null) {
      setError(`"${picked.nameHe}" requires an uploaded document.`);
      return;
    }
    save.mutate();
  };

  const fileRef = useRef<HTMLInputElement>(null);

  // Default dateTo for bereavement (visual hint only — the server
  // applies the same rule when the client omits dateTo).
  const bereavementSuggested = useMemo(() => {
    if (!isBereavement || !dateFrom) return null;
    const [y, m, d] = dateFrom.split('-').map(Number);
    const auto = new Date(y, m - 1, d);
    auto.setDate(auto.getDate() + 6);
    return `${auto.getFullYear()}-${String(auto.getMonth() + 1).padStart(2, '0')}-${String(auto.getDate()).padStart(2, '0')}`;
  }, [isBereavement, dateFrom]);

  const currentDoc = documentFileId
    ? attachments.find((a) => a.id === documentFileId)
    : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'create' ? 'New absence' : 'Edit absence'}
      description={mode === 'create' ? 'הוספת היעדרות' : 'עריכת היעדרות'}
      widthClass="w-[560px] max-w-[92vw]"
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
            form="hr-absence-form"
            disabled={save.isPending || uploadMut.isPending}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
          </button>
        </>
      }
    >
      <form id="hr-absence-form" onSubmit={submit} className="space-y-4">
        <SelectField
          label="Type · סוג היעדרות"
          name="absenceTypeId"
          required
          value={absenceTypeId}
          onChange={(e) => {
            setAbsenceTypeId(e.target.value);
            setAmount(''); // let effect re-prefill
          }}
        >
          <option value="">— Select —</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.nameHe} ({t.unit === 'DAY' ? 'days' : 'hours'})
              {t.requiresDocument ? ' · doc required' : ''}
            </option>
          ))}
        </SelectField>

        <div className="grid grid-cols-2 gap-4">
          <TextField
            label="From · מתאריך"
            name="dateFrom"
            type="date"
            required
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            inputClassName="font-mono"
          />
          <TextField
            label={isBereavement ? 'To · עד תאריך (optional)' : 'To · עד תאריך'}
            name="dateTo"
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            inputClassName="font-mono"
            hint={
              isBereavement
                ? `ברירת מחדל: 7 ימים קלנדריים ברצף${
                    bereavementSuggested ? ` (→ ${bereavementSuggested})` : ''
                  }`
                : undefined
            }
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <TextField
            label={`Amount · כמות (${picked?.unit === 'HOUR' ? 'hours' : 'days'})`}
            name="amount"
            type="number"
            step={picked?.unit === 'HOUR' ? '0.25' : '0.5'}
            min={0}
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputClassName="font-mono"
          />
          {picked?.unit === 'DAY' && picked?.halfDay && (
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => setAmount('0.5')}
                className={cn(
                  'flex-1 rounded-lg border px-2.5 py-2 text-[12px] font-semibold',
                  amount === '0.5'
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300'
                    : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400',
                )}
              >
                חצי יום · 0.5
              </button>
              <button
                type="button"
                onClick={() => setAmount('1')}
                className={cn(
                  'flex-1 rounded-lg border px-2.5 py-2 text-[12px] font-semibold',
                  amount === '1'
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300'
                    : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400',
                )}
              >
                יום מלא · 1
              </button>
            </div>
          )}
        </div>

        <TextAreaField
          label="Note · הערה"
          name="note"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        {/* Document — required when the absence type says so. Even when
            optional, HR can attach one so the audit trail carries proof. */}
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/40 p-3">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                מסמך מצורף · Document {picked?.requiresDocument && <span className="text-red-500">*</span>}
              </p>
              {currentDoc ? (
                <a
                  href={currentDoc.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1.5 text-[13px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span className="truncate max-w-[260px]">{currentDoc.fileName}</span>
                </a>
              ) : (
                <p className="mt-0.5 text-[12px] text-slate-500 dark:text-slate-400">
                  {picked?.requiresDocument
                    ? 'חובה להעלות מסמך לסוג זה'
                    : 'לא חובה — אופציונלי'}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {documentFileId != null && (
                <button
                  type="button"
                  onClick={() => setDocumentFileId(null)}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-[12px] font-semibold text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                >
                  Remove
                </button>
              )}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploadMut.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
              >
                <Upload className="h-3 w-3" />
                {uploadMut.isPending ? 'Uploading…' : 'Upload'}
              </button>
              <input
                ref={fileRef}
                type="file"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadMut.mutate(f);
                  // Reset so same filename re-select triggers onChange
                  if (fileRef.current) fileRef.current.value = '';
                }}
              />
            </div>
          </div>
        </div>

        {error && <p className="text-[12px] font-medium text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}

// ─── Documents section (Phase B4) ─────────────────────────────────────

interface DocumentsSectionProps {
  employee: HrEmployeeDetail;
  canWrite: boolean;
  qc: ReturnType<typeof useQueryClient>;
}

function DocumentsSection({ employee, canWrite, qc }: DocumentsSectionProps) {
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: rows = [], isLoading } = useQuery<EmployeeAttachment[]>({
    queryKey: ['hr', 'employees', employee.id, 'attachments'],
    queryFn: () => hrApi.listAttachments(employee.id),
    staleTime: 30 * 1000,
  });

  const upload = useMutation({
    mutationFn: (file: File) => hrApi.uploadAttachment(employee.id, file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr', 'employees', employee.id, 'attachments'] });
      notify.success('Document uploaded');
    },
    onError: (e: any) => notify.apiError(e, 'Upload failed'),
  });

  const remove = useMutation({
    mutationFn: (id: number) => hrApi.deleteAttachment(employee.id, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr', 'employees', employee.id, 'attachments'] });
      notify.success('Document deleted');
    },
    onError: (e: any) => notify.apiError(e, 'Delete failed'),
  });

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          מסמכים · Documents
        </h3>
        {canWrite && (
          <>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={upload.isPending}
              className="inline-flex items-center gap-1.5 rounded-[7px] border border-dashed border-slate-300 dark:border-slate-600 bg-transparent px-3 py-1 text-[13px] font-semibold text-slate-500 dark:text-slate-400 hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" />
              {upload.isPending ? 'Uploading…' : 'Upload'}
            </button>
            <input
              ref={fileRef}
              type="file"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
                if (fileRef.current) fileRef.current.value = '';
              }}
            />
          </>
        )}
      </div>

      {isLoading ? (
        <div className="rounded-[14px] border border-dashed border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/40 py-6 text-center text-[13px] text-slate-400 dark:text-slate-500">
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/40 py-6 text-center text-[13px] text-slate-500 dark:text-slate-400">
          אין מסמכים · No documents yet.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-[14px] border border-slate-200 dark:border-slate-700">
          {rows.map((r) => (
            <li key={r.id} className="group flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <a
                  href={r.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100 hover:text-blue-600 dark:hover:text-blue-400"
                >
                  <FileText className="h-4 w-4 text-slate-400 dark:text-slate-500" />
                  <span className="truncate max-w-[380px]">{r.fileName}</span>
                </a>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  {r.fileSize != null && (
                    <span className="font-mono tabular-nums">
                      {formatBytes(r.fileSize)}
                    </span>
                  )}
                  {r.mimeType && (
                    <>
                      <span>·</span>
                      <span className="font-mono text-slate-400 dark:text-slate-500">
                        {r.mimeType}
                      </span>
                    </>
                  )}
                  {r.uploader && (
                    <>
                      <span>·</span>
                      <span>
                        {r.uploader.firstName} {r.uploader.lastName}
                      </span>
                    </>
                  )}
                  <span>·</span>
                  <span className="font-mono tabular-nums">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
              {canWrite && (
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await confirm(`Delete "${r.fileName}"? Linked absences/eligibilities will clear their document reference.`, {
                      title: 'Delete document?',
                      variant: 'danger',
                      confirmLabel: 'Delete',
                    });
                    if (ok) remove.mutate(r.id);
                  }}
                  aria-label="Delete document"
                  className="opacity-0 group-hover:opacity-100 inline-flex h-[30px] w-[30px] items-center justify-center rounded-[7px] text-slate-300 dark:text-slate-500 hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-600 dark:hover:text-red-400"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
