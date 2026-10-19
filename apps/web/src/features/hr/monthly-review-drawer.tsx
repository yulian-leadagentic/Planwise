import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, RotateCcw, Home, Building2, Hammer } from 'lucide-react';

import { Modal } from '@/components/shared/modal';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import {
  hrApi,
  type DailyBreakdownRow,
  type MonthlyUserDetail,
} from './api/hr.api';
import { StatusPill } from './review-page';

/**
 * HR Phase C4 (2026-10-16) — review drawer for one employee's month.
 *
 * Shows:
 *   • header: name + month + status pill + approve/reopen buttons
 *     (behind hr:approve)
 *   • top stat row: תקן / בפועל / משוקלל / סטייה
 *   • day-by-day table: date · day-of-week · dayType · dayStandard ·
 *     actualHours · absenceCredit · location · B·AUTO deduction
 *
 * Returns a DRAFT compute when the user has no row yet so the drawer
 * renders even before חישוב מחדש is clicked.
 */
export interface MonthlyReviewDrawerProps {
  userId: number;
  year: number;
  month: number;
  onClose: () => void;
  canApprove: boolean;
}

const HE_DOW = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

const DAY_TYPE_LABELS: Record<string, string> = {
  REGULAR: 'רגיל',
  HOLIDAY: 'חג',
  HOLIDAY_EVE: 'ערב חג',
  CHOL_HAMOED: 'חוה״מ',
  REST: 'מנוחה',
};

const DAY_TYPE_BG: Record<string, string> = {
  REGULAR:
    'bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
  HOLIDAY:
    'bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-300',
  HOLIDAY_EVE:
    'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-300',
  CHOL_HAMOED:
    'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-300',
  REST:
    'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
};

export function MonthlyReviewDrawer({
  userId,
  year,
  month,
  onClose,
  canApprove,
}: MonthlyReviewDrawerProps) {
  const qc = useQueryClient();
  const detailKey = ['hr', 'monthly', userId, year, month] as const;
  const listKey = ['hr', 'monthly', year, month];

  const { data, isLoading } = useQuery<MonthlyUserDetail>({
    queryKey: detailKey,
    queryFn: () => hrApi.getMonthlyForUser(userId, year, month),
  });

  const approve = useMutation({
    mutationFn: () => hrApi.approveMonthly(userId, year, month),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: detailKey });
      qc.invalidateQueries({ queryKey: listKey });
      notify.success('אושר · Approved');
    },
    onError: (e: any) => {
      const code = e?.response?.data?.code;
      if (code === 'MONTHLY_NOT_YET_COMPUTED') {
        notify.warning('יש לחשב מחדש לפני אישור');
      } else {
        notify.error('Approve failed');
      }
    },
  });

  const reopen = useMutation({
    mutationFn: () => hrApi.reopenMonthly(userId, year, month),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: detailKey });
      qc.invalidateQueries({ queryKey: listKey });
      notify.success('בוטל אישור · Reopened');
    },
    onError: () => notify.error('Reopen failed'),
  });

  const row = data?.row;
  const breakdown = data?.dailyBreakdown ?? [];
  const monthName = useMemo(
    () =>
      new Date(year, month - 1, 1).toLocaleDateString('he-IL', {
        year: 'numeric',
        month: 'long',
      }),
    [year, month],
  );
  const employeeName = row?.user
    ? `${row.user.firstName} ${row.user.lastName}`.trim()
    : `User ${userId}`;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${employeeName} · ${monthName}`}
      widthClass="w-[880px] max-w-[94vw]"
    >
      {isLoading || !row ? (
        <div className="py-10 text-center text-sm text-slate-400 dark:text-slate-500">
          Loading…
        </div>
      ) : (
        <div className="space-y-4">
          {/* Status + approve/reopen row */}
          <div className="flex items-center justify-between rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3">
            <div className="flex items-center gap-2">
              <StatusPill status={row.status} />
              {row.approvedBy && (
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  by {row.approvedBy.firstName} {row.approvedBy.lastName}
                </span>
              )}
            </div>
            {row.status === 'DRAFT' ? (
              <span className="text-[11px] text-sky-600 dark:text-sky-300">
                חישוב מהיר · click חישוב מחדש to persist
              </span>
            ) : (
              <div className="flex items-center gap-2">
                {row.status === 'OPEN' && (
                  // G1b: Approve button was emerald/green — now primary
                  // blue (confirm CTAs go blue per planwise-design).
                  <button
                    type="button"
                    disabled={!canApprove || approve.isPending}
                    onClick={() => approve.mutate()}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold border-none transition-colors',
                      canApprove
                        ? 'bg-blue-600 hover:bg-blue-700 text-white'
                        : 'cursor-not-allowed bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500',
                    )}
                    title={canApprove ? 'Approve this employee' : 'Requires hr:approve'}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                    אשר
                  </button>
                )}
                {row.status === 'APPROVED' && (
                  <button
                    type="button"
                    disabled={!canApprove || reopen.isPending}
                    onClick={() => reopen.mutate()}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-[5px] border px-3 py-1.5 text-[13px] font-semibold transition-colors',
                      canApprove
                        ? 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800'
                        : 'cursor-not-allowed border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-400 dark:text-slate-500',
                    )}
                    title={canApprove ? 'Reopen this row' : 'Requires hr:approve'}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    בטל אישור
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Stat tiles */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="תקן" value={`${row.monthlyStandard.toFixed(1)}h`} />
            <StatTile label="בפועל" value={`${row.actualHours.toFixed(1)}h`} />
            <StatTile
              label="משוקלל"
              value={`${row.weightedHours.toFixed(1)}h`}
              emphasize
            />
            <StatTile
              label="סטייה"
              value={`${row.deviation >= 0 ? '+' : ''}${row.deviation.toFixed(1)}h`}
              valueTone={row.deviation < 0 ? 'red' : row.deviation > 0 ? 'green' : 'neutral'}
            />
          </div>

          {/* Day-by-day table */}
          <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
            <table className="min-w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 dark:border-slate-800">
                  <ThCell>תאריך</ThCell>
                  <ThCell>יום</ThCell>
                  <ThCell>סוג</ThCell>
                  <ThCell align="right">תקן</ThCell>
                  <ThCell align="right">בפועל</ThCell>
                  <ThCell align="right">זיכוי</ThCell>
                  <ThCell align="right">AUTO</ThCell>
                  <ThCell>Loc</ThCell>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((d) => (
                  <DayRow key={d.date} day={d} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ThCell({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={cn(
        'px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-slate-400 dark:text-slate-500',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}

function DayRow({ day }: { day: DailyBreakdownRow }) {
  // The engine's `date` is an ISO string over the wire; normalize via
  // Date to pull day-of-week + display.
  const d = new Date(day.date);
  const dow = HE_DOW[d.getDay()];
  const isWeekend = d.getDay() === 5 || d.getDay() === 6;

  return (
    <tr
      className={cn(
        'border-b border-slate-100 dark:border-slate-800 last:border-b-0',
        isWeekend && 'bg-slate-50/50 dark:bg-slate-800/20',
      )}
    >
      <TdCell>
        <span className="font-mono text-[11px] tabular-nums text-slate-700 dark:text-slate-200">
          {d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })}
        </span>
      </TdCell>
      <TdCell>
        <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
          {dow}
        </span>
      </TdCell>
      <TdCell>
        <span
          className={cn(
            'inline-flex items-center rounded-[5px] px-1.5 py-0.5 text-[11px] font-semibold',
            DAY_TYPE_BG[day.dayType] ?? DAY_TYPE_BG.REGULAR,
          )}
        >
          {DAY_TYPE_LABELS[day.dayType] ?? day.dayType}
        </span>
      </TdCell>
      <TdCell align="right">
        <span className="font-mono text-[11px] tabular-nums text-slate-700 dark:text-slate-200">
          {day.dayStandard.toFixed(1)}
        </span>
      </TdCell>
      <TdCell align="right">
        <span
          className={cn(
            'font-mono text-[11px] tabular-nums',
            day.actualHours > 0
              ? 'text-slate-900 dark:text-slate-100 font-semibold'
              : 'text-slate-400 dark:text-slate-500',
          )}
        >
          {day.actualHours > 0 ? day.actualHours.toFixed(1) : '—'}
        </span>
      </TdCell>
      <TdCell align="right">
        <span
          className={cn(
            'font-mono text-[11px] tabular-nums',
            day.absenceCredit > 0
              ? 'text-sky-600 dark:text-sky-300'
              : 'text-slate-400 dark:text-slate-500',
          )}
        >
          {day.absenceCredit > 0 ? day.absenceCredit.toFixed(1) : '—'}
        </span>
      </TdCell>
      <TdCell align="right">
        <span
          className={cn(
            'font-mono text-[11px] tabular-nums',
            day.autoDeduction > 0
              ? 'text-orange-600 dark:text-orange-300'
              : 'text-slate-400 dark:text-slate-500',
          )}
        >
          {day.autoDeduction > 0 ? `−${day.autoDeduction.toFixed(1)}` : '—'}
        </span>
      </TdCell>
      <TdCell>
        <LocationIcon loc={day.locationBucket} />
      </TdCell>
    </tr>
  );
}

function TdCell({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: 'right';
}) {
  return (
    <td
      className={cn(
        'px-3 py-2',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </td>
  );
}

function LocationIcon({ loc }: { loc: DailyBreakdownRow['locationBucket'] }) {
  if (!loc)
    return <span className="text-slate-400 dark:text-slate-500">—</span>;
  const Icon =
    loc === 'home' ? Home : loc === 'site' ? Hammer : Building2;
  const label = loc === 'home' ? 'בית' : loc === 'site' ? 'אתר' : 'משרד';
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-slate-600 dark:text-slate-300">
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

function StatTile({
  label,
  value,
  emphasize,
  valueTone,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
  valueTone?: 'red' | 'green' | 'neutral';
}) {
  return (
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-slate-400 dark:text-slate-500">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 font-mono text-xl tabular-nums',
          emphasize
            ? 'text-slate-900 dark:text-slate-100 font-bold'
            : valueTone === 'red'
              ? 'text-red-600 dark:text-red-400 font-bold'
              : valueTone === 'green'
                ? 'text-emerald-600 dark:text-emerald-400 font-bold'
                : 'text-slate-700 dark:text-slate-200',
        )}
      >
        {value}
      </div>
    </div>
  );
}
