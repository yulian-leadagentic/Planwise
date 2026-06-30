/**
 * Project Labor Cost tab (M5).
 *
 * Sums logged time × the user's seniority-level hourly cost. Shows:
 *   - Per-currency total cards (no FX conversion — separate buckets)
 *   - Per-user breakdown table sorted by cost desc
 *   - Unrateable callout for users whose seniority isn't set / has no
 *     hourly cost — so admins see the data gap rather than silent zeros
 *
 * Backend: GET /projects/:id/labor-cost (ProjectsService.getLaborCost).
 */

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Users, Clock, DollarSign } from 'lucide-react';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';

interface ByUserRow {
  user: {
    id: number;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
    position: string | null;
  };
  seniorityLevel: { id: number; name: string } | null;
  hours: number;
  hourlyCost: number;
  currency: string;
  cost: number;
}

interface UnrateableRow {
  user: {
    id: number;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
    position: string | null;
  };
  hours: number;
  reason: string;
}

interface LaborCostResponse {
  projectId: number;
  totals: {
    byCurrency: Array<{
      currency: string;
      totalHours: number;
      totalCost: number;
      userCount: number;
    }>;
    totalLoggedHours: number;
    unrateableHours: number;
    unrateableUserCount: number;
  };
  byUser: ByUserRow[];
  unrateable: UnrateableRow[];
}

/**
 * Currency symbols for the handful of currencies we expect; everything
 * else falls back to the 3-letter code. Keep narrow — adding a long
 * lookup here invites stale data when the currencies catalog grows.
 */
const CURRENCY_SYMBOL: Record<string, string> = {
  ILS: '₪',
  USD: '$',
  EUR: '€',
  GBP: '£',
};

function fmtMoney(amount: number, currency: string): string {
  const sym = CURRENCY_SYMBOL[currency];
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'decimal',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
  return sym ? `${sym}${formatted}` : `${formatted} ${currency}`;
}

function fmtHours(hours: number): string {
  return `${hours.toLocaleString('en-US', { maximumFractionDigits: 1 })}h`;
}

function initials(firstName: string, lastName: string): string {
  return `${(firstName?.[0] ?? '').toUpperCase()}${(lastName?.[0] ?? '').toUpperCase()}`;
}

export function LaborCostTab({ projectId }: { projectId: number }) {
  const scrollRef = useStickyHScroll();
  const { data, isLoading, error } = useQuery<LaborCostResponse>({
    queryKey: ['projects', projectId, 'labor-cost'],
    queryFn: () =>
      client.get(`/projects/${projectId}/labor-cost`).then((r) => r.data?.data ?? r.data),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
  });

  if (isLoading) {
    return <div className="py-12 text-center text-sm text-slate-400">Loading labor cost…</div>;
  }
  if (error || !data) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Could not load labor cost.
      </div>
    );
  }

  const { totals, byUser, unrateable } = data;
  const hasAnyRated = totals.byCurrency.length > 0;
  const hasUnrateable = unrateable.length > 0;
  const hasNothingLogged = totals.totalLoggedHours === 0;

  return (
    <div className="space-y-5">
      {/* Top stats row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Total logged hours */}
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            <Clock className="h-3.5 w-3.5" /> Total logged
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
            {fmtHours(totals.totalLoggedHours)}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {byUser.length + unrateable.length} contributor{(byUser.length + unrateable.length) === 1 ? '' : 's'}
          </p>
        </div>

        {/* Per-currency totals. One card if all costs are in a single
            currency; if multiple, the first card holds the rest in a
            stacked list. Keeps the row to 3 cards at most. */}
        {totals.byCurrency.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 md:col-span-2">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <DollarSign className="h-3.5 w-3.5" /> Resolved cost
            </div>
            <p className="mt-2 text-sm text-slate-500 italic">
              No costs resolved yet — see the "Missing rates" section below.
            </p>
          </div>
        ) : (
          totals.byCurrency.map((c, i) => (
            <div
              key={c.currency}
              className={cn(
                'rounded-lg border p-4',
                i === 0
                  ? 'border-emerald-200 bg-emerald-50'
                  : 'border-slate-200 bg-white',
              )}
            >
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <DollarSign className="h-3.5 w-3.5" /> Resolved cost
                {totals.byCurrency.length > 1 && (
                  <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] tracking-normal text-slate-600">
                    {c.currency}
                  </span>
                )}
              </div>
              <p
                className={cn(
                  'mt-2 text-2xl font-bold tabular-nums',
                  i === 0 ? 'text-emerald-700' : 'text-slate-900',
                )}
              >
                {fmtMoney(c.totalCost, c.currency)}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {fmtHours(c.totalHours)} · {c.userCount} user{c.userCount === 1 ? '' : 's'}
              </p>
            </div>
          ))
        )}
      </div>

      {/* Unrateable callout. Yellow so it pulls attention — the user
          actively needs to act on it (assign seniority or fill in the
          hourly cost on the existing seniority). We list every affected
          user so the path to fixing it is one click away. */}
      {hasUnrateable && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-amber-900">
                Missing rates — {totals.unrateableUserCount} user{totals.unrateableUserCount === 1 ? '' : 's'} ({fmtHours(totals.unrateableHours)}) excluded from cost
              </h3>
              <p className="mt-0.5 text-[12px] text-amber-800/80">
                Set a seniority level on these users (and a default hourly
                cost on that level) to include their logged time.
              </p>
              <ul className="mt-2 space-y-1">
                {unrateable.map((row) => (
                  <li
                    key={row.user.id}
                    className="flex items-center gap-2 text-[12px] text-amber-900"
                  >
                    <Users className="h-3 w-3 text-amber-600" />
                    <span className="font-medium">
                      {row.user.firstName} {row.user.lastName}
                    </span>
                    <span className="text-amber-700">· {fmtHours(row.hours)}</span>
                    <span className="text-amber-700 italic">— {row.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Per-user breakdown table */}
      <div ref={scrollRef} className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
        <div className="border-b border-slate-200 px-4 py-2.5">
          <h3 className="text-[13px] font-semibold text-slate-700">By contributor</h3>
          <p className="text-[11px] text-slate-500">
            Sorted by cost (largest first). Hourly cost comes from each user's seniority level.
          </p>
        </div>
        {hasAnyRated ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-4 py-2 text-left font-semibold">Person</th>
                <th className="px-4 py-2 text-left font-semibold">Seniority</th>
                <th className="px-4 py-2 text-right font-semibold">Hours</th>
                <th className="px-4 py-2 text-right font-semibold">Hourly cost</th>
                <th className="px-4 py-2 text-right font-semibold">Total cost</th>
              </tr>
            </thead>
            <tbody>
              {byUser.map((row) => (
                <tr key={row.user.id} className="border-t border-slate-100">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-100 text-[10px] font-semibold text-blue-700 shrink-0">
                        {initials(row.user.firstName, row.user.lastName)}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-slate-900 truncate">
                          {row.user.firstName} {row.user.lastName}
                        </p>
                        {row.user.position && (
                          <p className="text-[10px] text-slate-500 truncate">{row.user.position}</p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-[12px] text-slate-600">
                    {row.seniorityLevel?.name ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right text-[12px] tabular-nums text-slate-700">
                    {fmtHours(row.hours)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-[12px] tabular-nums text-slate-700">
                    {fmtMoney(row.hourlyCost, row.currency)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-[13px] tabular-nums font-semibold text-slate-900">
                    {fmtMoney(row.cost, row.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-4 py-6 text-center text-sm text-slate-400">
            {hasNothingLogged
              ? 'No time has been logged on this project yet.'
              : 'No contributors with a resolved hourly cost yet.'}
          </p>
        )}
      </div>
    </div>
  );
}
