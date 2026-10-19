import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator, CheckCheck, X } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';

import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/hooks/use-permissions';
import {
  hrApi,
  type HrEmployeeListRow,
  type MonthlyAttendanceRow,
  type MonthlyStatus,
} from './api/hr.api';
import { MonthlyReviewDrawer } from './monthly-review-drawer';

// ─── G6: merged-roster row shape ─────────────────────────────────────
// `/hr/review` lists every active employee. Those with a MonthlyAttendance
// row (i.e. the engine ran) are `kind: 'computed'`; everyone else is
// `kind: 'missing'` and gets a "טרם חושב" chip + em-dashes until the user
// presses "חישוב מחדש".
type MonthlyRosterRow =
  | { kind: 'computed'; row: MonthlyAttendanceRow }
  | {
      kind: 'missing';
      userId: number;
      user: Pick<
        HrEmployeeListRow,
        | 'id'
        | 'firstName'
        | 'lastName'
        | 'firstNameHe'
        | 'lastNameHe'
        | 'accountingEmployeeNumber'
      >;
    };

const isComputed = (
  r: MonthlyRosterRow,
): r is Extract<MonthlyRosterRow, { kind: 'computed' }> =>
  r.kind === 'computed';

/**
 * HR Phase C4 (2026-10-16) — `/hr/review` monthly review page.
 *
 * Rows show the engine's output: standard vs actual vs weighted
 * hours + deviation + sick/vacation tallies + status pill. Click a
 * row → drawer with the day-by-day breakdown + approve / reopen.
 *
 * Permissions:
 *   • Page gated by hr:read (RoutePermissionGuard).
 *   • חישוב מחדש (batch recompute) requires hr:write.
 *   • אשר הכל + אשר (per-row) require hr:approve.
 *   • HR Clerk (read-only on hr:*) sees the table but every write
 *     button is disabled with a tooltip.
 *
 * Design: slate palette · DM Sans / JetBrains Mono · rounded-[14px]
 * cards without shadows · badges 8% opacity bg + text-{color}-600
 * per the planwise design system. Full dark + light branch.
 */

const HE_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

export function HrMonthlyReviewPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [drawerUserId, setDrawerUserId] = useState<number | null>(null);

  const { can } = usePermissions();
  const canWrite = can('hr', 'write');
  const canApprove = can('hr', 'approve');

  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const monthKey = ['hr', 'monthly', year, month] as const;
  const employeesKey = ['hr', 'employees'] as const;

  // G6: fetch BOTH the engine's MonthlyAttendance rows and the active-
  // employee roster, then merge them so the table has a row per active
  // employee even before anyone presses "חישוב מחדש".
  const monthlyQuery = useQuery<MonthlyAttendanceRow[]>({
    queryKey: monthKey,
    queryFn: () => hrApi.listMonthly(year, month),
    staleTime: 30 * 1000,
  });
  const employeesQuery = useQuery<HrEmployeeListRow[]>({
    queryKey: employeesKey,
    queryFn: () => hrApi.listEmployees(),
    staleTime: 60 * 1000,
  });

  const monthlyRows = monthlyQuery.data ?? [];
  const employees = employeesQuery.data ?? [];
  const isLoading = monthlyQuery.isLoading || employeesQuery.isLoading;

  const rows = useMemo<MonthlyRosterRow[]>(() => {
    const byUser = new Map<number, MonthlyAttendanceRow>();
    for (const r of monthlyRows) byUser.set(r.userId, r);

    // Only active employees go into the roster. The listEmployees endpoint
    // already orders by lastName asc, firstName asc — mirror that here so
    // computed + missing rows interleave in a stable, Hebrew-friendly order.
    const activeEmployees = employees
      .filter((e) => e.isActive)
      .slice()
      .sort((a, b) => {
        const ln = (a.lastName ?? '').localeCompare(b.lastName ?? '', 'he');
        if (ln !== 0) return ln;
        return (a.firstName ?? '').localeCompare(b.firstName ?? '', 'he');
      });

    return activeEmployees.map<MonthlyRosterRow>((e) => {
      const row = byUser.get(e.id);
      if (row) return { kind: 'computed', row };
      return {
        kind: 'missing',
        userId: e.id,
        user: {
          id: e.id,
          firstName: e.firstName,
          lastName: e.lastName,
          firstNameHe: e.firstNameHe,
          lastNameHe: e.lastNameHe,
          accountingEmployeeNumber: e.accountingEmployeeNumber,
        },
      };
    });
  }, [monthlyRows, employees]);

  const missingCount = rows.filter((r) => r.kind === 'missing').length;

  const recompute = useMutation({
    mutationFn: () => hrApi.recomputeMonthly({ year, month }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: monthKey });
      const skipped = data.skipped.length;
      const computed = data.computed.length;
      if (skipped > 0) {
        notify.info(
          `חישוב מחדש · ${computed} עודכנו, ${skipped} דולגו (approved / locked)`,
        );
      } else {
        notify.success(`חישוב מחדש · ${computed} עודכנו`);
      }
    },
    onError: () => notify.error('Recompute failed'),
  });

  const approveAll = useMutation({
    mutationFn: async () => {
      // Only computed+OPEN rows can be approved. Missing rows don't exist
      // in the DB yet — recompute first to materialize them.
      const toApprove = rows
        .filter(isComputed)
        .filter((r) => r.row.status === 'OPEN');
      const results = await Promise.allSettled(
        toApprove.map((r) =>
          hrApi.approveMonthly(r.row.userId, year, month),
        ),
      );
      return results;
    },
    onSuccess: (results) => {
      queryClient.invalidateQueries({ queryKey: monthKey });
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const fail = results.filter((r) => r.status === 'rejected').length;
      if (fail > 0) notify.warning(`אושרו ${ok}, נכשלו ${fail}`);
      else notify.success(`אושרו ${ok} עובדים`);
    },
    onError: () => notify.error('Approve all failed'),
  });

  const columns = useMemo<ColumnDef<MonthlyRosterRow, unknown>[]>(
    () => [
      {
        id: 'name',
        header: 'שם · Name',
        accessorFn: (r) => {
          const u = r.kind === 'computed' ? r.row.user : r.user;
          return `${u?.lastName ?? ''} ${u?.firstName ?? ''}`.trim();
        },
        cell: ({ row }) => {
          const u =
            row.original.kind === 'computed'
              ? row.original.row.user
              : row.original.user;
          if (!u)
            return <span className="text-slate-400 dark:text-slate-500">—</span>;
          const hebrew =
            u.firstNameHe || u.lastNameHe
              ? `${u.lastNameHe ?? ''} ${u.firstNameHe ?? ''}`.trim()
              : null;
          return (
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-slate-900 dark:text-slate-100">
                {u.firstName} {u.lastName}
              </div>
              {hebrew && (
                <div
                  dir="rtl"
                  className="truncate text-[11px] font-medium text-slate-500 dark:text-slate-400"
                >
                  {hebrew}
                </div>
              )}
            </div>
          );
        },
      },
      {
        id: 'payrollNumber',
        header: "מס' הנהח״ש",
        accessorFn: (r) => {
          const u = r.kind === 'computed' ? r.row.user : r.user;
          return u?.accountingEmployeeNumber ?? '';
        },
        cell: ({ row }) => {
          const u =
            row.original.kind === 'computed'
              ? row.original.row.user
              : row.original.user;
          return (
            <span className="font-mono text-[11px] text-slate-700 dark:text-slate-200">
              {u?.accountingEmployeeNumber || (
                <span className="font-sans text-slate-400 dark:text-slate-500">—</span>
              )}
            </span>
          );
        },
      },
      {
        id: 'monthlyStandard',
        header: 'תקן חודשי',
        accessorFn: (r) => (r.kind === 'computed' ? r.row.monthlyStandard : NaN),
        cell: ({ row }) => {
          if (row.original.kind !== 'computed') return <EmDash />;
          return (
            <span className="font-mono text-[13px] tabular-nums text-slate-700 dark:text-slate-200">
              {row.original.row.monthlyStandard.toFixed(1)}h
            </span>
          );
        },
      },
      {
        id: 'actualHours',
        header: 'בפועל',
        accessorFn: (r) => (r.kind === 'computed' ? r.row.actualHours : NaN),
        cell: ({ row }) => {
          if (row.original.kind !== 'computed') return <EmDash />;
          return (
            <span className="font-mono text-[13px] tabular-nums text-slate-700 dark:text-slate-200">
              {row.original.row.actualHours.toFixed(1)}h
            </span>
          );
        },
      },
      {
        id: 'weightedHours',
        header: 'משוקלל',
        accessorFn: (r) => (r.kind === 'computed' ? r.row.weightedHours : NaN),
        cell: ({ row }) => {
          if (row.original.kind !== 'computed') return <EmDash />;
          return (
            <span className="font-mono text-[13px] tabular-nums text-slate-900 dark:text-slate-100 font-semibold">
              {row.original.row.weightedHours.toFixed(1)}h
            </span>
          );
        },
      },
      {
        id: 'deviation',
        header: 'סטייה',
        accessorFn: (r) => (r.kind === 'computed' ? r.row.deviation : NaN),
        cell: ({ row }) => {
          if (row.original.kind !== 'computed') return <EmDash />;
          const d = row.original.row.deviation;
          return (
            <span
              className={cn(
                'font-mono text-[13px] tabular-nums font-semibold',
                d < 0
                  ? 'text-red-600 dark:text-red-400'
                  : d > 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-slate-500 dark:text-slate-400',
              )}
            >
              {d >= 0 ? '+' : ''}
              {d.toFixed(1)}h
            </span>
          );
        },
      },
      {
        id: 'sickDays',
        header: 'ימי מחלה',
        accessorFn: (r) => (r.kind === 'computed' ? r.row.sickDays : NaN),
        cell: ({ row }) => {
          if (row.original.kind !== 'computed') return <EmDash />;
          const v = row.original.row.sickDays;
          if (v === 0) return <EmDash />;
          return (
            <span className="font-mono text-[13px] tabular-nums text-rose-600 dark:text-rose-400">
              {v}
            </span>
          );
        },
      },
      {
        id: 'vacationDays',
        header: 'ימי חופש',
        accessorFn: (r) => (r.kind === 'computed' ? r.row.vacationDays : NaN),
        cell: ({ row }) => {
          if (row.original.kind !== 'computed') return <EmDash />;
          const v = row.original.row.vacationDays;
          if (v === 0) return <EmDash />;
          return (
            <span className="font-mono text-[13px] tabular-nums text-sky-600 dark:text-sky-400">
              {v}
            </span>
          );
        },
      },
      {
        id: 'status',
        header: 'סטטוס · Status',
        // G6: missing rows surface as a synthetic 'TRM_CHUSHAV' value so
        // the DataTable's getValue()-based column filter can match them.
        accessorFn: (r) => (r.kind === 'computed' ? r.row.status : 'TRM_CHUSHAV'),
        meta: {
          filterOptions: [
            { value: 'OPEN', label: 'Open' },
            { value: 'APPROVED', label: 'Approved' },
            { value: 'LOCKED', label: 'Locked' },
            { value: 'TRM_CHUSHAV', label: 'טרם חושב' },
          ],
        },
        cell: ({ row }) =>
          row.original.kind === 'computed' ? (
            <StatusPill status={row.original.row.status} />
          ) : (
            <MissingPill />
          ),
      },
    ],
    [],
  );

  const openCount = rows
    .filter(isComputed)
    .filter((r) => r.row.status === 'OPEN').length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="נוכחות חודשית"
        description="חישוב ואישור פר-עובד"
        actions={
          <div className="flex items-center gap-2">
            <MonthPicker
              year={year}
              month={month}
              onChange={(y, m) => {
                setYear(y);
                setMonth(m);
              }}
            />
            <button
              type="button"
              disabled={!canWrite || recompute.isPending}
              onClick={() => recompute.mutate()}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-[5px] border px-3 py-1.5 text-[13px] font-semibold transition-colors',
                canWrite
                  ? 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800'
                  : 'cursor-not-allowed border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-400 dark:text-slate-500',
              )}
              title={
                canWrite
                  ? `Recompute all employees${
                      missingCount > 0 ? ` · ${missingCount} missing` : ''
                    }`
                  : 'Requires hr:write'
              }
            >
              <Calculator className="h-3.5 w-3.5" />
              {recompute.isPending ? 'מחשב...' : 'חישוב מחדש'}
              {missingCount > 0 && !recompute.isPending && (
                <span className="font-sans">
                  (<span className="font-mono tabular-nums">{missingCount}</span>{' '}
                  חסרים)
                </span>
              )}
            </button>
            {/* G1b: Approve-all was emerald/green — now primary blue
                per planwise-design (confirm CTAs go blue, not green). */}
            <button
              type="button"
              disabled={!canApprove || approveAll.isPending || openCount === 0}
              onClick={async () => {
                if (
                  await confirm(`לאשר ${openCount} עובדים?`, {
                    description:
                      'Approves every OPEN row for this month. Reopen flips the row back.',
                    confirmLabel: 'אשר הכל',
                  })
                ) {
                  approveAll.mutate();
                }
              }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold border-none transition-colors',
                canApprove && openCount > 0
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'cursor-not-allowed bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500',
              )}
              title={
                canApprove ? `Approve ${openCount} open rows` : 'Requires hr:approve'
              }
            >
              <CheckCheck className="h-3.5 w-3.5" />
              אשר הכל {openCount > 0 ? `(${openCount})` : ''}
            </button>
          </div>
        }
      />

      {/* G6: merged roster is only empty when there are no active
          employees at all. The DataTable's own emptyMessage covers it. */}
      <DataTable
        columns={columns}
        data={rows}
        isLoading={isLoading}
        enableColumnFilters
        onRowClick={(row) => {
          // Missing rows don't have a MonthlyAttendance record yet —
          // the drawer would 404. Press "חישוב מחדש" first.
          if (row.kind === 'computed') setDrawerUserId(row.row.userId);
        }}
        emptyMessage="אין עובדים פעילים"
        renderCard={(r) => {
          const u = r.kind === 'computed' ? r.row.user : r.user;
          const clickable = r.kind === 'computed';
          return (
            <button
              type="button"
              disabled={!clickable}
              onClick={() => {
                if (r.kind === 'computed') setDrawerUserId(r.row.userId);
              }}
              className={cn(
                'w-full rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-left',
                clickable
                  ? 'hover:bg-slate-50 dark:hover:bg-slate-800'
                  : 'cursor-default',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-slate-900 dark:text-slate-100">
                    {u?.firstName} {u?.lastName}
                  </div>
                  <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                    {u?.accountingEmployeeNumber ?? '—'}
                    {r.kind === 'computed' && (
                      <>
                        {' '}· משוקלל{' '}
                        <span className="font-mono tabular-nums">
                          {r.row.weightedHours.toFixed(1)}h
                        </span>
                      </>
                    )}
                  </div>
                </div>
                {r.kind === 'computed' ? (
                  <StatusPill status={r.row.status} />
                ) : (
                  <MissingPill />
                )}
              </div>
            </button>
          );
        }}
      />

      {drawerUserId != null && (
        <MonthlyReviewDrawer
          userId={drawerUserId}
          year={year}
          month={month}
          onClose={() => setDrawerUserId(null)}
          canApprove={canApprove}
        />
      )}
    </div>
  );
}

// ─── Em-dash cell for uncomputed rows ────────────────────────────────

function EmDash() {
  return (
    <span className="font-mono text-[13px] text-slate-400 dark:text-slate-500">
      —
    </span>
  );
}

// ─── "טרם חושב" pill (G6) ────────────────────────────────────────────
// Rendered for rows where no MonthlyAttendance exists yet. Visually
// matches StatusPill (same geometry), slate palette so it reads as
// "neutral / absent" rather than a real engine state.
export function MissingPill() {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[5px] px-2 py-0.5 text-[11px] font-bold tracking-[0.05em]',
        'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
      )}
    >
      טרם חושב
    </span>
  );
}

// ─── Status pill ─────────────────────────────────────────────────────

export function StatusPill({ status }: { status: MonthlyStatus }) {
  const config: Record<
    MonthlyStatus,
    { label: string; className: string }
  > = {
    OPEN: {
      label: 'OPEN',
      className:
        'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-300',
    },
    APPROVED: {
      label: 'APPROVED',
      className:
        'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-300',
    },
    LOCKED: {
      label: 'LOCKED',
      className:
        'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
    },
    DRAFT: {
      label: 'DRAFT',
      className:
        'bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-300',
    },
  };
  const c = config[status] ?? config.OPEN;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[5px] px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.05em]',
        c.className,
      )}
    >
      {c.label}
    </span>
  );
}

// ─── Month picker ────────────────────────────────────────────────────

function MonthPicker({
  year,
  month,
  onChange,
}: {
  year: number;
  month: number;
  onChange: (y: number, m: number) => void;
}) {
  const now = new Date();
  const thisYear = now.getFullYear();
  const years = Array.from({ length: 6 }, (_, i) => thisYear - 2 + i);
  return (
    <div className="inline-flex items-center gap-1 rounded-[5px] border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1">
      <select
        value={month}
        onChange={(e) => onChange(year, Number(e.target.value))}
        className="rounded-[5px] border-none bg-transparent px-1 py-0.5 text-[13px] text-slate-900 dark:text-slate-100 focus:outline-none"
        aria-label="Month"
      >
        {HE_MONTHS.map((label, idx) => (
          <option key={idx} value={idx + 1}>
            {label}
          </option>
        ))}
      </select>
      <select
        value={year}
        onChange={(e) => onChange(Number(e.target.value), month)}
        className="rounded-[5px] border-none bg-transparent px-1 py-0.5 text-[13px] text-slate-900 dark:text-slate-100 focus:outline-none"
        aria-label="Year"
      >
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </div>
  );
}

// `X` import kept for the drawer component.
void X;
