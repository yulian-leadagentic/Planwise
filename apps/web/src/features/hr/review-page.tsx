import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Calculator, CheckCheck, X } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';

import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/hooks/use-permissions';
import {
  hrApi,
  type MonthlyAttendanceRow,
  type MonthlyStatus,
} from './api/hr.api';
import { MonthlyReviewDrawer } from './monthly-review-drawer';

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

  const { data: rows = [], isLoading } = useQuery<MonthlyAttendanceRow[]>({
    queryKey: monthKey,
    queryFn: () => hrApi.listMonthly(year, month),
    staleTime: 30 * 1000,
  });

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
      const toApprove = rows.filter((r) => r.status === 'OPEN');
      const results = await Promise.allSettled(
        toApprove.map((r) => hrApi.approveMonthly(r.userId, year, month)),
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

  const columns = useMemo<ColumnDef<MonthlyAttendanceRow, unknown>[]>(
    () => [
      {
        id: 'name',
        header: 'שם · Name',
        accessorFn: (r) =>
          `${r.user?.lastName ?? ''} ${r.user?.firstName ?? ''}`.trim(),
        cell: ({ row }) => {
          const u = row.original.user;
          if (!u) return <span className="text-slate-400 dark:text-slate-500">—</span>;
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
        accessorFn: (r) => r.user?.accountingEmployeeNumber ?? '',
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-slate-700 dark:text-slate-200">
            {row.original.user?.accountingEmployeeNumber || (
              <span className="font-sans text-slate-400 dark:text-slate-500">—</span>
            )}
          </span>
        ),
      },
      {
        id: 'monthlyStandard',
        header: 'תקן חודשי',
        accessorFn: (r) => r.monthlyStandard,
        cell: ({ row }) => (
          <span className="font-mono text-[13px] tabular-nums text-slate-700 dark:text-slate-200">
            {row.original.monthlyStandard.toFixed(1)}h
          </span>
        ),
      },
      {
        id: 'actualHours',
        header: 'בפועל',
        accessorFn: (r) => r.actualHours,
        cell: ({ row }) => (
          <span className="font-mono text-[13px] tabular-nums text-slate-700 dark:text-slate-200">
            {row.original.actualHours.toFixed(1)}h
          </span>
        ),
      },
      {
        id: 'weightedHours',
        header: 'משוקלל',
        accessorFn: (r) => r.weightedHours,
        cell: ({ row }) => (
          <span className="font-mono text-[13px] tabular-nums text-slate-900 dark:text-slate-100 font-semibold">
            {row.original.weightedHours.toFixed(1)}h
          </span>
        ),
      },
      {
        id: 'deviation',
        header: 'סטייה',
        accessorFn: (r) => r.deviation,
        cell: ({ row }) => {
          const d = row.original.deviation;
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
        accessorFn: (r) => r.sickDays,
        cell: ({ row }) => {
          const v = row.original.sickDays;
          if (v === 0)
            return <span className="font-mono text-[13px] text-slate-400 dark:text-slate-500">—</span>;
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
        accessorFn: (r) => r.vacationDays,
        cell: ({ row }) => {
          const v = row.original.vacationDays;
          if (v === 0)
            return <span className="font-mono text-[13px] text-slate-400 dark:text-slate-500">—</span>;
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
        accessorFn: (r) => r.status,
        meta: {
          filterOptions: [
            { value: 'OPEN', label: 'Open' },
            { value: 'APPROVED', label: 'Approved' },
            { value: 'LOCKED', label: 'Locked' },
          ],
        },
        cell: ({ row }) => <StatusPill status={row.original.status} />,
      },
    ],
    [],
  );

  const openCount = rows.filter((r) => r.status === 'OPEN').length;

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
              title={canWrite ? 'Recompute all employees' : 'Requires hr:write'}
            >
              <Calculator className="h-3.5 w-3.5" />
              {recompute.isPending ? 'מחשב...' : 'חישוב מחדש'}
            </button>
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
                'inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-[13px] font-semibold transition-colors',
                canApprove && openCount > 0
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
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

      {!isLoading && rows.length === 0 ? (
        <EmptyState
          icon={CalendarCheck}
          title="No rows for this month"
          description='Click "חישוב מחדש" to populate the review table from TimeEntry / AbsenceRecord data.'
        />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={isLoading}
          enableColumnFilters
          onRowClick={(row) => setDrawerUserId(row.userId)}
          emptyMessage="No rows yet — click חישוב מחדש"
          renderCard={(r) => (
            <button
              type="button"
              onClick={() => setDrawerUserId(r.userId)}
              className="w-full rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-slate-900 dark:text-slate-100">
                    {r.user?.firstName} {r.user?.lastName}
                  </div>
                  <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                    {r.user?.accountingEmployeeNumber ?? '—'} · משוקלל{' '}
                    <span className="font-mono tabular-nums">
                      {r.weightedHours.toFixed(1)}h
                    </span>
                  </div>
                </div>
                <StatusPill status={r.status} />
              </div>
            </button>
          )}
        />
      )}

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
