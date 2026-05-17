/**
 * Employee Timesheets report — row-level view that mirrors the customer's
 * legacy report so users moving from the old system see familiar layout
 * and numbers.
 *
 * Backend: GET /reports/timesheet/detailed (one row per TimeEntry +
 * per-currency totals).
 *
 * Filters: Employee, Project, From, To, Group By.
 * Grouping is fully client-side (small report; one screenful per filter).
 * Cost uses the M5 resolver — user's SeniorityLevel.defaultHourlyCost.
 * Export: CSV today; PDF/XLSX queued as a follow-up.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { UserSelect } from '@/components/shared/user-select';
import { ProjectSelect } from '@/components/shared/project-select';
import client from '@/api/client';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────────────

interface Row {
  id: number;
  date: string;
  startTime: string | null;
  endTime: string | null;
  hours: number;
  user: { id: number; firstName: string; lastName: string; displayName: string };
  project: { id: number; name: string; number: string | null; displayName: string } | null;
  zone: { id: number; name: string; breadcrumb: string[] } | null;
  deliverable: { id: number; name: string } | null;
  assignmentName: string | null;
  description: string | null;
  cost: number | null;
  currency: string | null;
  seniorityLevelName: string | null;
}

interface Response {
  rows: Row[];
  totals: {
    totalHours: number;
    rowCount: number;
    byCurrency: Array<{ currency: string; totalHours: number; totalCost: number }>;
  };
}

type GroupBy = 'none' | 'day' | 'week' | 'month' | 'employee' | 'project' | 'zone';

const GROUP_OPTIONS: Array<{ value: GroupBy; label: string }> = [
  { value: 'none', label: 'No Group' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'employee', label: 'Employee' },
  { value: 'project', label: 'Project' },
  { value: 'zone', label: 'Zone' },
];

// ─── Helpers ────────────────────────────────────────────────────────────

const CURRENCY_SYMBOL: Record<string, string> = {
  ILS: '₪',
  USD: '$',
  EUR: '€',
  GBP: '£',
};

function fmtMoney(amount: number, currency: string | null): string {
  if (currency == null) return amount.toLocaleString();
  const sym = CURRENCY_SYMBOL[currency];
  const formatted = amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return sym ? `${sym}${formatted}` : `${formatted} ${currency}`;
}

function fmtDate(iso: string): string {
  // Customer's legacy report uses DD/MM/YYYY. Keep the convention so
  // users moving over recognize the format.
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * ISO week start (Monday). Returned as YYYY-MM-DD so it sorts naturally.
 * Used by the Week grouping option.
 */
function weekKey(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  const day = d.getDay() === 0 ? 7 : d.getDay(); // Mon=1..Sun=7
  d.setDate(d.getDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

function monthKey(iso: string): string {
  return iso.slice(0, 7); // YYYY-MM
}

function monthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

/** Resolve a row's group key + label based on the chosen Group By mode. */
function groupKeyFor(row: Row, mode: GroupBy): { key: string; label: string } {
  switch (mode) {
    case 'day':
      return { key: row.date, label: fmtDate(row.date) };
    case 'week': {
      const k = weekKey(row.date);
      return { key: k, label: `Week of ${fmtDate(k)}` };
    }
    case 'month': {
      const k = monthKey(row.date);
      return { key: k, label: monthLabel(k) };
    }
    case 'employee':
      return { key: String(row.user.id), label: row.user.displayName || '(no name)' };
    case 'project':
      return {
        key: row.project ? String(row.project.id) : 'none',
        label: row.project?.displayName ?? '(no project)',
      };
    case 'zone':
      return {
        key: row.zone ? String(row.zone.id) : 'none',
        label: row.zone?.breadcrumb.join(' › ') || row.zone?.name || '(no zone)',
      };
    default:
      return { key: 'all', label: '' };
  }
}

/**
 * CSV escape — quote fields that contain commas, quotes, or newlines;
 * double any embedded quote per RFC4180.
 */
function csvCell(v: string | number | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(filename: string, rows: Row[]) {
  const header = [
    'Date', 'From', 'To', 'Hours', 'Employee', 'Project', 'Zone',
    'Subprojects', 'Assignment Name', 'Description', 'Cost', 'Currency',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.date,
      r.startTime ?? '',
      r.endTime ?? '',
      r.hours.toFixed(2),
      r.user.displayName,
      r.project?.displayName ?? '',
      r.zone?.breadcrumb.join(' > ') ?? r.zone?.name ?? '',
      r.deliverable?.name ?? '',
      r.assignmentName ?? '',
      r.description ?? '',
      r.cost != null ? r.cost.toFixed(2) : '',
      r.currency ?? '',
    ].map(csvCell).join(','));
  }
  // Prefix with UTF-8 BOM so Excel opens Hebrew characters correctly.
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Page ───────────────────────────────────────────────────────────────

export function TimesheetReportPage() {
  // Default range = current month, matching the legacy report's default.
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
  const lastOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];

  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(lastOfMonth);
  const [userId, setUserId] = useState<number | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('none');

  const { data, isLoading } = useQuery<Response>({
    queryKey: ['reports', 'timesheet-detailed', from, to, userId, projectId],
    queryFn: () =>
      client
        .get('/reports/timesheet/detailed', {
          params: {
            from,
            to,
            ...(userId ? { userId } : {}),
            ...(projectId ? { projectId } : {}),
          },
        })
        .then((r) => r.data?.data ?? r.data),
  });

  const rows = data?.rows ?? [];
  const totals = data?.totals;

  // Client-side grouping. Walks the (already-sorted) row list once and
  // emits a list of [groupHeader, ...rows, subtotal] triples. For the
  // 'none' mode we render the flat list — same code path, single group.
  const grouped = useMemo(() => {
    if (groupBy === 'none') {
      return [{ key: 'all', label: '', rows, hours: rows.reduce((s, r) => s + r.hours, 0), costByCurrency: subtotalsForRows(rows) }];
    }
    const map = new Map<string, { label: string; rows: Row[] }>();
    for (const r of rows) {
      const { key, label } = groupKeyFor(r, groupBy);
      let g = map.get(key);
      if (!g) {
        g = { label, rows: [] };
        map.set(key, g);
      }
      g.rows.push(r);
    }
    return Array.from(map.entries()).map(([key, g]) => ({
      key,
      label: g.label,
      rows: g.rows,
      hours: g.rows.reduce((s, r) => s + r.hours, 0),
      costByCurrency: subtotalsForRows(g.rows),
    }));
  }, [rows, groupBy]);

  const handleExport = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`timesheet-${from}-to-${to}-${stamp}.csv`, rows);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Employee Timesheets"
        description="Row-level time entries with cost — filterable by employee, project, and date range"
        actions={
          <button
            onClick={handleExport}
            disabled={rows.length === 0}
            className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            <Download className="h-4 w-4" /> Export CSV
          </button>
        }
      />

      {/* Filters row */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
            Employee
          </label>
          <UserSelect value={userId} onChange={setUserId} placeholder="All employees" />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
            Project
          </label>
          <ProjectSelect value={projectId} onChange={setProjectId} placeholder="All projects" />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
            From
          </label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
            To
          </label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
            Group by
          </label>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {GROUP_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Summary bar — mirrors the legacy report header. Per-currency
          totals so a mixed-currency org sees both sums separately. */}
      {totals && (
        <div className="rounded-md bg-blue-500 text-white px-4 py-2.5 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <span className="font-semibold">
            Total Hours: <span className="tabular-nums">{totals.totalHours.toFixed(2)}</span>
          </span>
          {totals.byCurrency.length === 0 ? (
            <span className="text-blue-100 italic">No resolved cost (set Seniority hourly costs to populate)</span>
          ) : (
            totals.byCurrency.map((c) => (
              <span key={c.currency} className="font-semibold">
                Total Cost{totals.byCurrency.length > 1 ? ` (${c.currency})` : ''}:{' '}
                <span className="tabular-nums">{fmtMoney(c.totalCost, c.currency)}</span>
              </span>
            ))
          )}
          <span className="ml-auto text-[12px] text-blue-100">{totals.rowCount} entr{totals.rowCount === 1 ? 'y' : 'ies'}</span>
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <TableSkeleton rows={10} cols={11} />
      ) : rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No time entries match these filters.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2 text-left font-semibold">Date</th>
                <th className="px-3 py-2 text-left font-semibold">From</th>
                <th className="px-3 py-2 text-left font-semibold">To</th>
                <th className="px-3 py-2 text-right font-semibold">Hours</th>
                <th className="px-3 py-2 text-left font-semibold">Employee</th>
                <th className="px-3 py-2 text-left font-semibold">Project</th>
                <th className="px-3 py-2 text-left font-semibold">Zones</th>
                <th className="px-3 py-2 text-left font-semibold">Subprojects</th>
                <th className="px-3 py-2 text-left font-semibold">Assignment Name</th>
                <th className="px-3 py-2 text-left font-semibold">Description</th>
                <th className="px-3 py-2 text-right font-semibold">Cost</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((g) => (
                <GroupBlock key={g.key} group={g} showHeader={groupBy !== 'none'} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Group block + helpers ──────────────────────────────────────────────

interface Group {
  key?: string;
  label: string;
  rows: Row[];
  hours: number;
  costByCurrency: Array<{ currency: string; totalCost: number }>;
}

function subtotalsForRows(rows: Row[]): Array<{ currency: string; totalCost: number }> {
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.cost == null || r.currency == null) continue;
    map.set(r.currency, (map.get(r.currency) ?? 0) + r.cost);
  }
  return Array.from(map.entries()).map(([currency, totalCost]) => ({ currency, totalCost }));
}

function GroupBlock({ group, showHeader }: { group: Group; showHeader: boolean }) {
  return (
    <>
      {showHeader && (
        <tr className="bg-slate-100/80">
          <td
            colSpan={11}
            className="px-3 py-1.5 text-[12px] font-bold text-slate-700 border-t border-slate-200"
          >
            {group.label}
            <span className="ml-3 font-normal text-slate-500">
              {group.rows.length} entr{group.rows.length === 1 ? 'y' : 'ies'} ·{' '}
              {group.hours.toFixed(2)}h
              {group.costByCurrency.map((c) => (
                <span key={c.currency} className="ml-2">
                  · {fmtMoney(c.totalCost, c.currency)}
                </span>
              ))}
            </span>
          </td>
        </tr>
      )}
      {group.rows.map((r) => (
        <RowLine key={r.id} row={r} />
      ))}
    </>
  );
}

function RowLine({ row }: { row: Row }) {
  return (
    <tr className="border-t border-slate-100 hover:bg-blue-50/30">
      <td className="px-3 py-2 text-[12px] tabular-nums text-slate-600">{fmtDate(row.date)}</td>
      <td className="px-3 py-2 text-[12px] tabular-nums text-slate-600">{row.startTime ?? '—'}</td>
      <td className="px-3 py-2 text-[12px] tabular-nums text-slate-600">{row.endTime ?? '—'}</td>
      <td className="px-3 py-2 text-[12px] tabular-nums text-right font-semibold text-slate-700">
        {row.hours.toFixed(2)}
      </td>
      <td className="px-3 py-2 text-[13px] font-medium text-slate-900">{row.user.displayName}</td>
      <td className="px-3 py-2 text-[12px] text-slate-600 max-w-[200px] truncate" title={row.project?.displayName ?? ''}>
        {row.project?.displayName ?? '—'}
      </td>
      <td className="px-3 py-2 text-[12px] text-slate-600 max-w-[200px]" title={row.zone?.breadcrumb.join(' › ')}>
        {row.zone ? (row.zone.breadcrumb.length > 0 ? row.zone.breadcrumb.join(' › ') : row.zone.name) : <span className="italic text-slate-400">Project Root</span>}
      </td>
      <td className="px-3 py-2 text-[12px] text-slate-600 max-w-[200px] truncate" title={row.deliverable?.name ?? ''}>
        {row.deliverable?.name ?? '—'}
      </td>
      <td className="px-3 py-2 text-[12px] text-slate-600 max-w-[200px] truncate" title={row.assignmentName ?? ''}>
        {row.assignmentName ?? '—'}
      </td>
      <td className="px-3 py-2 text-[12px] text-slate-500 max-w-[200px] truncate" title={row.description ?? ''}>
        {row.description ?? <span className="text-slate-300">—</span>}
      </td>
      <td className={cn('px-3 py-2 text-[12px] tabular-nums text-right font-semibold', row.cost == null ? 'text-slate-300' : 'text-slate-800')}>
        {row.cost != null ? fmtMoney(row.cost, row.currency) : '—'}
      </td>
    </tr>
  );
}
