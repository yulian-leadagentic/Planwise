import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarRange } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { cn } from '@/lib/utils';
import {
  hrApi,
  type CBucketUsage,
  type MyMonthlySummary,
} from '@/features/hr/api/hr.api';

/**
 * HR Phase C4 (2026-10-16) — `/time/monthly-summary` self-service tab.
 *
 * No `hr:*` permission. Server scopes to caller.id; a query param
 * can't broaden the scope. Shows:
 *   • stat tiles: תקן / בפועל / משוקלל / סטייה
 *   • absence summary (list + totals)
 *   • C-bucket YTD usage bars (orange ≥80%, red ≥100%)
 *
 * Design: slate palette · DM Sans / JetBrains Mono · rounded-[14px]
 * cards without shadows · 8%-opacity badge backgrounds. Full dark +
 * light branch.
 */

const HE_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

export function MonthlySummaryPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const { data, isLoading } = useQuery<MyMonthlySummary>({
    queryKey: ['time', 'my-monthly-summary', year, month],
    queryFn: () => hrApi.getMyMonthlySummary(year, month),
  });

  const absenceTotals = useMemo(() => {
    const totals = { sick: 0, vacation: 0, other: 0 };
    for (const a of data?.monthlyAbsences ?? []) {
      const code = a.absenceType.code;
      if (code === 'sick') totals.sick += a.amount;
      else if (
        code === 'vacation' ||
        code === 'holiday_eve_leave' ||
        code === 'chol_hamoed_leave'
      )
        totals.vacation += a.amount;
      else totals.other += a.amount;
    }
    return totals;
  }, [data?.monthlyAbsences]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="סיכום חודשי · Monthly Summary"
        description="נתוני הזמן שלי לחודש הנוכחי · My monthly time snapshot"
        actions={
          <MonthPicker
            year={year}
            month={month}
            onChange={(y, m) => {
              setYear(y);
              setMonth(m);
            }}
          />
        }
      />

      {isLoading || !data ? (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-10 text-center text-sm text-slate-400 dark:text-slate-500">
          Loading…
        </div>
      ) : (
        <>
          {/* Stat tiles */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="תקן" value={`${data.row.monthlyStandard.toFixed(1)}h`} />
            <StatTile label="בפועל" value={`${data.row.actualHours.toFixed(1)}h`} />
            <StatTile
              label="משוקלל"
              value={`${data.row.weightedHours.toFixed(1)}h`}
              emphasize
            />
            <StatTile
              label="סטייה"
              value={`${data.row.deviation >= 0 ? '+' : ''}${data.row.deviation.toFixed(1)}h`}
              valueTone={
                data.row.deviation < 0 ? 'red' : data.row.deviation > 0 ? 'green' : 'neutral'
              }
            />
          </div>

          {/* Absence summary */}
          <section className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
            <div className="border-b border-slate-100 dark:border-slate-800 px-5 py-3">
              <h2 className="text-[13px] font-bold text-slate-900 dark:text-slate-100">
                היעדרויות החודש · This month's absences
              </h2>
            </div>
            <div className="p-5">
              {data.monthlyAbsences.length === 0 ? (
                <p className="text-[13px] text-slate-500 dark:text-slate-400">
                  אין היעדרויות החודש · No absences this month.
                </p>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <AbsenceTotal label="ימי מחלה" value={absenceTotals.sick} tone="rose" />
                    <AbsenceTotal label="ימי חופש" value={absenceTotals.vacation} tone="sky" />
                    <AbsenceTotal label="אחר" value={absenceTotals.other} tone="slate" />
                  </div>
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                    {data.monthlyAbsences.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center justify-between gap-3 py-2 text-[13px]"
                      >
                        <div className="min-w-0">
                          <span className="font-semibold text-slate-900 dark:text-slate-100">
                            {a.absenceType.nameHe}
                          </span>
                          <span className="ml-2 text-[11px] text-slate-500 dark:text-slate-400">
                            {a.dateFrom}
                            {a.dateTo !== a.dateFrom ? ` → ${a.dateTo}` : ''}
                          </span>
                        </div>
                        <span className="font-mono text-[11px] tabular-nums text-slate-700 dark:text-slate-200">
                          {a.amount}
                          {a.absenceType.unit === 'DAY' ? 'd' : 'h'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>

          {/* C-bucket YTD usage */}
          <section className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
            <div className="border-b border-slate-100 dark:border-slate-800 px-5 py-3">
              <h2 className="text-[13px] font-bold text-slate-900 dark:text-slate-100">
                ניצול קופות שנתי · C-bucket YTD usage
              </h2>
              <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                שעות שנצברו השנה מול המקסימום · hours accrued this year vs the
                annual max
              </p>
            </div>
            <div className="p-5">
              {data.cBucketUsage.length === 0 ? (
                <p className="text-[13px] text-slate-500 dark:text-slate-400">
                  לא נוצלו קופות השנה · No C-bucket usage this year.
                </p>
              ) : (
                <ul className="space-y-3">
                  {data.cBucketUsage.map((b) => (
                    <CBucketRow key={b.bucketId ?? b.code ?? Math.random()} b={b} />
                  ))}
                </ul>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function CBucketRow({ b }: { b: CBucketUsage }) {
  const max = b.maxPerYear ?? 0;
  const pct = max > 0 ? (b.used / max) * 100 : 0;
  const tone = pct >= 100 ? 'red' : pct >= 80 ? 'amber' : 'emerald';
  const barColor =
    tone === 'red'
      ? 'bg-red-500 dark:bg-red-400'
      : tone === 'amber'
        ? 'bg-amber-500 dark:bg-amber-400'
        : 'bg-emerald-500 dark:bg-emerald-400';

  return (
    <li className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span className="font-semibold text-slate-900 dark:text-slate-100">
          {b.nameHe ?? b.code ?? '—'}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-slate-700 dark:text-slate-200">
          {b.used}
          {b.unit === 'DAY' ? 'd' : 'h'} / {max}
          {b.unit === 'DAY' ? 'd' : 'h'}
          {pct > 0 && <span className="ml-1 text-slate-400">({pct.toFixed(0)}%)</span>}
        </span>
      </div>
      <div className="h-2 w-full rounded-[5px] bg-slate-100 dark:bg-slate-800 overflow-hidden">
        <div
          className={cn('h-full rounded-[5px] transition-all', barColor)}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </li>
  );
}

function AbsenceTotal({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'rose' | 'sky' | 'slate';
}) {
  const className =
    tone === 'rose'
      ? 'bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-300'
      : tone === 'sky'
        ? 'bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-300'
        : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300';
  return (
    <div
      className={cn(
        'rounded-[14px] px-4 py-3',
        className,
      )}
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.05em] opacity-80">
        {label}
      </div>
      <div className="mt-1 font-mono text-xl tabular-nums font-bold">
        {value || 0}
      </div>
    </div>
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

function MonthPicker({
  year,
  month,
  onChange,
}: {
  year: number;
  month: number;
  onChange: (y: number, m: number) => void;
}) {
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 6 }, (_, i) => thisYear - 2 + i);
  return (
    <div className="inline-flex items-center gap-1 rounded-[5px] border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1">
      <CalendarRange className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
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
