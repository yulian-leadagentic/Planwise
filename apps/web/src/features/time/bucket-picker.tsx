import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { hrApi, type PickableBucket } from '@/features/hr/api/hr.api';

/**
 * HR Phase B4 + §9.1 (2026-10-16) — optional bucket picker shared by
 * the time-reporting surfaces (weekly timesheet, log-time dialog, task-
 * drawer form, kanban quick-log).
 *
 * Data source: `GET /hr/me/pickable-buckets` — the caller-scoped
 * endpoint any authenticated user can call. The server returns:
 *   • A + C buckets (active) → everyone can report meetings / culture
 *     / breadth / training (A) and pregnancy / fertility / childcare
 *     (C). Showing these to all employees is the whole point of
 *     "שעות שאינן על פרויקט" (spec §9.1 Option A).
 *   • B buckets only when the caller has an active REPORTED
 *     eligibility covering today. A non-eligible user sees no B
 *     options at all; a B·AUTO eligibility stays server-side.
 *
 * The admin catalog at `GET /hr/buckets` stays `hr:read` — that's
 * what the employee drawer + HR settings panel use. This picker never
 * calls it.
 *
 * This is UX only. The real gate is server-side on `TimeEntry`
 * create/update (`TIME_ENTRY_BUCKET_INACTIVE`,
 * `TIME_ENTRY_BUCKET_B_NO_ELIGIBILITY`,
 * `TIME_ENTRY_BUCKET_B_AUTO_NOT_REPORTABLE`), so a stale cached list
 * can never let a user slip past.
 */
export interface BucketPickerProps {
  value: number | null;
  onChange: (next: number | null) => void;
  /** Compact size shrinks font + padding to fit kanban-card density. */
  compact?: boolean;
  /** When true, forces the picker open on initial render — used when
   *  an edit flow pre-fills a bucket. */
  defaultOpen?: boolean;
}

export function BucketPicker({ value, onChange, compact, defaultOpen }: BucketPickerProps) {
  const { data: buckets = [] } = useQuery<PickableBucket[]>({
    queryKey: ['hr', 'me', 'pickable-buckets'],
    queryFn: () => hrApi.listMyPickableBuckets(),
    staleTime: 10 * 60 * 1000,
    // Fail silently — the picker's absence is better than a loud 403
    // for users who happen not to be employees. The caller-scoped
    // endpoint should return [] for most "non-HR" users, but a 401
    // from an expired session would surface here too; still safe to
    // swallow because the picker is optional.
    retry: false,
    gcTime: 10 * 60 * 1000,
  });

  const groups = useMemo(() => {
    const a = buckets.filter((b) => b.behavior === 'A');
    const b = buckets.filter((b) => b.behavior === 'B');
    const c = buckets.filter((b) => b.behavior === 'C');
    return { a, b, c };
  }, [buckets]);

  const [open, setOpen] = useState<boolean>(!!defaultOpen || value != null);
  const picked = useMemo(
    () => (value != null ? buckets.find((b) => b.id === value) ?? null : null),
    [value, buckets],
  );

  if (buckets.length === 0) {
    // No buckets visible — don't take up space.
    return null;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={cn(
          'inline-flex items-center gap-1 text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400',
          compact ? 'text-[10px]' : 'text-[11px] font-medium',
        )}
      >
        <Sparkles className={cn(compact ? 'h-2.5 w-2.5' : 'h-3 w-3')} />
        <span>+ קטגוריה מיוחדת</span>
      </button>
    );
  }

  return (
    <div className={cn('rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/40', compact ? 'p-1.5' : 'p-2')}>
      <div className="flex items-center justify-between mb-1">
        <label
          className={cn(
            'uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400',
            compact ? 'text-[9px]' : 'text-[11px]',
          )}
        >
          קטגוריה מיוחדת · Bucket
        </label>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onChange(null);
            setOpen(false);
          }}
          aria-label="Remove bucket"
          className="rounded p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        >
          <X className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
        </button>
      </div>
      <select
        value={value != null ? String(value) : ''}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === '' ? null : Number(v));
        }}
        className={cn(
          'w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:border-blue-500 focus:outline-none',
          compact ? 'px-1.5 py-1 text-[11px]' : 'px-2 py-1.5 text-[12px]',
        )}
      >
        <option value="">— אין · None —</option>
        {groups.a.length > 0 && (
          <optgroup label="A — ישיבות / תרבות / רוחב / השתלמות">
            {groups.a.map((b) => (
              <option key={b.id} value={b.id}>
                {b.nameHe} ({b.code})
              </option>
            ))}
          </optgroup>
        )}
        {groups.b.length > 0 && (
          // B appears only when the server deemed the caller eligible
          // in REPORTED mode. Group header explains why it's here so
          // the user doesn't wonder.
          <optgroup label="B — מדווחת · זכאות אישית">
            {groups.b.map((b) => (
              <option key={b.id} value={b.id}>
                {b.nameHe} ({b.code})
              </option>
            ))}
          </optgroup>
        )}
        {groups.c.length > 0 && (
          <optgroup label="C — הריון / פוריות / טיפול בילד">
            {groups.c.map((b) => (
              <option key={b.id} value={b.id}>
                {b.nameHe} ({b.code})
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {picked && (
        <p className={cn('mt-1 text-slate-400 dark:text-slate-500', compact ? 'text-[9px]' : 'text-[10px]')}>
          {picked.behavior === 'A'
            ? 'A · ניהול'
            : picked.behavior === 'B'
              ? 'B · זכאות'
              : 'C · שנתי'}{' '}
          · {picked.unit === 'DAY' ? 'days' : 'hours'}
        </p>
      )}
    </div>
  );
}
