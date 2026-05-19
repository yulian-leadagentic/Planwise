/* Build tag: 2026-05-18 — force Railway web service rebuild so the
 * staging bundle picks up the M5 + Timesheet Report changes. The
 * preceding empty-commit retrigger was correctly built but Railway's
 * artifact cache served the prior bundle, so the new code wasn't
 * actually shipped. Touching this file invalidates that cache. */
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

import { useMemo, useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ChevronDown, FileSpreadsheet, FileText, Printer } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { UserSelect } from '@/components/shared/user-select';
import { ProjectSelect } from '@/components/shared/project-select';
import client from '@/api/client';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';

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
  service: { id: number; name: string } | null;
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

type GroupBy =
  | 'none' | 'day' | 'week' | 'month'
  | 'employee' | 'project' | 'zone'
  | 'service' | 'deliverable';

const GROUP_OPTIONS: Array<{ value: GroupBy; label: string }> = [
  { value: 'none', label: 'No Group' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'employee', label: 'Employee' },
  { value: 'project', label: 'Project' },
  { value: 'zone', label: 'Zone' },
  // Work-discipline axes added per user request — Service is the
  // broader category (phase), Deliverable is the specific template.
  { value: 'service', label: 'Service' },
  { value: 'deliverable', label: 'Deliverable' },
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
    case 'service':
      // Bucket all entries on tasks with no Service set under a single
      // "(no service)" group so they're countable instead of silently
      // missing from the breakdown.
      return {
        key: row.service ? String(row.service.id) : 'none',
        label: row.service?.name ?? '(no service)',
      };
    case 'deliverable':
      return {
        key: row.deliverable ? String(row.deliverable.id) : 'none',
        label: row.deliverable?.name ?? '(no deliverable)',
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
    'Service', 'Deliverable', 'Assignment Name', 'Description', 'Cost', 'Currency',
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
      r.service?.name ?? '',
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

  // Finance permission — controls visibility of the Cost column +
  // per-currency totals in the summary bar. Backend already strips
  // cost fields server-side for non-finance users; this just hides
  // the now-empty column / total slots so the UI stays clean.
  const { can, isAdmin } = usePermissions();
  const showFinance = isAdmin || can('finance', 'read');

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

  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const handleExportCsv = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`timesheet-${from}-to-${to}-${stamp}.csv`, rows);
    setExportMenuOpen(false);
  };

  /**
   * XLSX export — hits the backend /reports/export?format=excel endpoint.
   * Server-side ExcelJS renders a workbook with proper column widths,
   * header styling, currency-formatted cells, and a totals footer that
   * stays correct when the user pivots on the data inside Excel.
   */
  const handleExportExcel = async () => {
    try {
      const params = new URLSearchParams({
        type: 'timesheet-detailed',
        format: 'excel',
        from, to,
        ...(userId ? { userId: String(userId) } : {}),
        ...(projectId ? { projectId: String(projectId) } : {}),
      });
      const resp = await client.get(`/reports/export?${params.toString()}`, {
        responseType: 'blob',
      });
      const blob = new Blob([resp.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download = `timesheet-${from}-to-${to}-${stamp}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportMenuOpen(false);
    } catch (err: any) {
      notify.apiError(err, 'Failed to export Excel');
    }
  };

  /**
   * "Print to PDF" — opens the browser print dialog. The user picks
   * "Save as PDF" as the destination. A dedicated `@media print`
   * stylesheet (in this component) hides the chrome and renders the
   * table edge-to-edge. This route handles Hebrew / RTL natively via
   * the browser, no font bundling needed on the server.
   */
  const handlePrintPdf = () => {
    setExportMenuOpen(false);
    // Defer so the menu closes before the print dialog (otherwise
    // the open menu paints into the PDF).
    setTimeout(() => window.print(), 50);
  };

  return (
    <div className="space-y-5 timesheet-report-root">
      {/* Print stylesheet — applied only during window.print(). Hides
          page chrome (sidebar, header, filters, export button), forces
          landscape A4 with minimal margins, shrinks the font, and lets
          long cells wrap (the on-screen `truncate` + `max-w-*` classes
          would otherwise chop content in the PDF). table-layout: fixed
          divides width evenly so a single long Description doesn't
          starve the other columns. Scoped via .timesheet-report-root
          so it never bleeds into other screens. */}
      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 8mm; }
          body * { visibility: hidden; }
          .timesheet-report-root, .timesheet-report-root * { visibility: visible; }
          .timesheet-report-root { position: absolute; left: 0; top: 0; width: 100%; }
          .no-print { display: none !important; }

          /* Compact the table for print — 13 columns in landscape A4
             needs every pixel. */
          .timesheet-report-root table {
            font-size: 8px;
            width: 100%;
            table-layout: fixed;
            border-collapse: collapse;
          }
          .timesheet-report-root th,
          .timesheet-report-root td {
            padding: 3px 4px !important;
            border: 0.5px solid #e2e8f0;
            white-space: normal !important;     /* override on-screen nowrap */
            overflow: visible !important;       /* override truncate */
            text-overflow: clip !important;
            max-width: none !important;         /* drop the 200px caps */
            word-break: break-word;
            vertical-align: top;
          }
          /* Per-column widths — sum to ~100%. Narrow for date/time
             columns, wider for project/zone/assignment/description
             where the text matters most. */
          .timesheet-report-root th:nth-child(1),
          .timesheet-report-root td:nth-child(1)  { width: 6.5%; }   /* Date */
          .timesheet-report-root th:nth-child(2),
          .timesheet-report-root td:nth-child(2)  { width: 4.5%; }   /* From */
          .timesheet-report-root th:nth-child(3),
          .timesheet-report-root td:nth-child(3)  { width: 4.5%; }   /* To */
          .timesheet-report-root th:nth-child(4),
          .timesheet-report-root td:nth-child(4)  { width: 4.5%; }   /* Hours */
          .timesheet-report-root th:nth-child(5),
          .timesheet-report-root td:nth-child(5)  { width: 9%; }     /* Employee */
          .timesheet-report-root th:nth-child(6),
          .timesheet-report-root td:nth-child(6)  { width: 13%; }    /* Project */
          .timesheet-report-root th:nth-child(7),
          .timesheet-report-root td:nth-child(7)  { width: 12%; }    /* Zones */
          .timesheet-report-root th:nth-child(8),
          .timesheet-report-root td:nth-child(8)  { width: 9%; }     /* Service */
          .timesheet-report-root th:nth-child(9),
          .timesheet-report-root td:nth-child(9)  { width: 10%; }    /* Deliverable */
          .timesheet-report-root th:nth-child(10),
          .timesheet-report-root td:nth-child(10) { width: 11%; }    /* Assignment */
          .timesheet-report-root th:nth-child(11),
          .timesheet-report-root td:nth-child(11) { width: 10%; }    /* Description */
          .timesheet-report-root th:nth-child(12),
          .timesheet-report-root td:nth-child(12) { width: 6%; }     /* Cost */

          /* Keep header on every page, prevent rows from breaking */
          .timesheet-report-root thead { display: table-header-group; }
          .timesheet-report-root tfoot { display: table-footer-group; }
          .timesheet-report-root tr    { page-break-inside: avoid; }
          .timesheet-report-root th    { background-color: #3b82f6 !important; color: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          /* Summary bar — print as light grey so it's visible without
             ink-saturating the page. Drops the on-screen blue. */
          .timesheet-report-root .summary-bar {
            background-color: #f1f5f9 !important;
            color: #0f172a !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            border: 1px solid #cbd5e1;
            padding: 6px 10px !important;
            margin-bottom: 6px;
            font-size: 10px;
          }
        }
      `}</style>
      <PageHeader
        title="Timesheet Report"
        description="Row-level time entries with cost — filterable by employee, project, and date range"
        actions={
          <div className="relative" ref={exportMenuRef}>
            <button
              type="button"
              onClick={() => setExportMenuOpen((o) => !o)}
              disabled={rows.length === 0}
              className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              <Download className="h-4 w-4" /> Export
              <ChevronDown className="h-3 w-3" />
            </button>
            {exportMenuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-md border border-border bg-popover shadow-lg">
                <button
                  type="button"
                  onClick={handleExportCsv}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left"
                >
                  <FileText className="h-4 w-4 text-slate-500" /> CSV
                </button>
                <button
                  type="button"
                  onClick={handleExportExcel}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left"
                >
                  <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Excel (.xlsx)
                </button>
                <button
                  type="button"
                  onClick={handlePrintPdf}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left"
                >
                  <Printer className="h-4 w-4 text-red-600" /> Print / PDF
                </button>
              </div>
            )}
          </div>
        }
      />

      {/* Filters row — hidden when printing so the PDF shows just
          the summary bar + table (filters are not data, they're
          controls). */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3 no-print">
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
          totals so a mixed-currency org sees both sums separately. The
          summary-bar class is targeted by the @media print rules above
          to re-tone the blue background to grey for ink-friendly
          printing. */}
      {totals && (
        <div className="summary-bar rounded-md bg-blue-500 text-white px-4 py-2.5 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <span className="font-semibold">
            Total Hours: <span className="tabular-nums">{totals.totalHours.toFixed(2)}</span>
          </span>
          {/* Per-currency cost totals — hidden for non-finance users
              (backend also strips them server-side, so the array would
              be empty anyway; this drops the "No resolved cost" italic
              hint that'd otherwise just confuse non-finance viewers). */}
          {showFinance && (
            totals.byCurrency.length === 0 ? (
              <span className="text-blue-100 italic">No resolved cost (set Seniority hourly costs to populate)</span>
            ) : (
              totals.byCurrency.map((c) => (
                <span key={c.currency} className="font-semibold">
                  Total Cost{totals.byCurrency.length > 1 ? ` (${c.currency})` : ''}:{' '}
                  <span className="tabular-nums">{fmtMoney(c.totalCost, c.currency)}</span>
                </span>
              ))
            )
          )}
          <span className="ml-auto text-[12px] text-blue-100">{totals.rowCount} entr{totals.rowCount === 1 ? 'y' : 'ies'}</span>
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <TableSkeleton rows={10} cols={12} />
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
                <th className="px-3 py-2 text-left font-semibold">Service</th>
                <th className="px-3 py-2 text-left font-semibold">Deliverable</th>
                <th className="px-3 py-2 text-left font-semibold">Assignment Name</th>
                <th className="px-3 py-2 text-left font-semibold">Description</th>
                {/* Cost column hidden for non-finance users. Row cells
                    below are conditionally rendered to stay aligned. */}
                {showFinance && <th className="px-3 py-2 text-right font-semibold">Cost</th>}
              </tr>
            </thead>
            <tbody>
              {grouped.map((g) => (
                <GroupBlock key={g.key} group={g} showHeader={groupBy !== 'none'} showFinance={showFinance} />
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

function GroupBlock({ group, showHeader, showFinance }: { group: Group; showHeader: boolean; showFinance: boolean }) {
  return (
    <>
      {showHeader && (
        <tr className="bg-slate-100/80">
          <td
            colSpan={showFinance ? 12 : 11}
            className="px-3 py-1.5 text-[12px] font-bold text-slate-700 border-t border-slate-200"
          >
            {group.label}
            <span className="ml-3 font-normal text-slate-500">
              {group.rows.length} entr{group.rows.length === 1 ? 'y' : 'ies'} ·{' '}
              {group.hours.toFixed(2)}h
              {showFinance && group.costByCurrency.map((c) => (
                <span key={c.currency} className="ml-2">
                  · {fmtMoney(c.totalCost, c.currency)}
                </span>
              ))}
            </span>
          </td>
        </tr>
      )}
      {group.rows.map((r) => (
        <RowLine key={r.id} row={r} showFinance={showFinance} />
      ))}
    </>
  );
}

function RowLine({ row, showFinance }: { row: Row; showFinance: boolean }) {
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
      <td className="px-3 py-2 text-[12px] text-slate-600 max-w-[180px] truncate" title={row.service?.name ?? ''}>
        {row.service?.name ?? '—'}
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
      {/* Cost cell — hidden for non-finance users. Backend also
          strips the value (so row.cost is null), but dropping the
          <td> entirely keeps the row aligned with the gated header. */}
      {showFinance && (
        <td className={cn('px-3 py-2 text-[12px] tabular-nums text-right font-semibold', row.cost == null ? 'text-slate-300' : 'text-slate-800')}>
          {row.cost != null ? fmtMoney(row.cost, row.currency) : '—'}
        </td>
      )}
    </tr>
  );
}
