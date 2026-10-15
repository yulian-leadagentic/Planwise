import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { Modal } from '@/components/shared/modal';
import { TextField, SelectField } from '@/components/shared/field';
import { usePermissions } from '@/hooks/use-permissions';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/shared/confirm-dialog';
import {
  hrApi,
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
      widthClass="w-[640px] max-w-[94vw]"
    >
      <EmploymentFieldsSection employee={employee} canWrite={canWrite} qc={qc} />
      <div className="my-6 h-px bg-slate-100 dark:bg-slate-800" />
      <EligibilitiesSection employee={employee} canWrite={canWrite} qc={qc} />
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
