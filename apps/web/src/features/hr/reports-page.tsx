import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  AlertTriangle,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Users,
} from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { PeopleMultiSelect, type Person } from '@/components/shared/people-multi-select';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/hooks/use-permissions';

import {
  hrApi,
  type HrEmployeeListRow,
  type ReportPayload,
  type ReportPayloadEmployee,
  type ReportScope,
  type ReportBlockersError,
} from './api/hr.api';

/**
 * HR Phase D2 (2026-10-18) — `/hr/reports` consolidated accounting
 * report page per spec §5.
 *
 * Three scope modes drive the picker:
 *   • "כל העובדים הפעילים" — fire-and-forget
 *   • "לפי יחידת ארגון"   — pick one OrgUnit, server resolves subtree
 *   • "בחירה ידנית"       — multi-select employee picker
 *
 * Preview is a JSON round-trip against /hr/reports/preview and renders
 * the SAME day-by-day table the XLSX / PDF writer sees. If any
 * selected employee doesn't have an APPROVED MonthlyAttendance row,
 * the API returns 400 with a blocker list — the FE renders an amber
 * banner + a link to /hr/review.
 *
 * Design: slate palette, DM Sans + JetBrains Mono, text-[13px]/[11px]
 * uppercase 0.05em labels, no shadows on cards, rounded-[14px] /
 * rounded-[5px] / rounded-lg. Full dark + light branch.
 */

const HE_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

type ScopeKind = 'all-active' | 'org-unit' | 'manual';

interface OrgUnit {
  id: number;
  name: string;
}

/** Blob + anchor-click download helper. Mirrors the pattern used by
 *  the legacy timesheet report (/features/reports/timesheet-report-page). */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function HrReportsPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [scopeKind, setScopeKind] = useState<ScopeKind>('all-active');
  const [orgUnitId, setOrgUnitId] = useState<number | null>(null);
  const [manualUserIds, setManualUserIds] = useState<number[]>([]);
  const [previewPayload, setPreviewPayload] = useState<ReportPayload | null>(
    null,
  );
  const [blockers, setBlockers] = useState<ReportBlockersError | null>(null);
  const [previewEmpId, setPreviewEmpId] = useState<number | null>(null);

  const { can } = usePermissions();
  const canExport = can('hr', 'export');

  // ─── Data: org units + employees ────────────────────────────────
  const { data: orgUnits = [] } = useQuery<OrgUnit[]>({
    queryKey: ['org-units'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client.get('/org-units').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d)
          ? d.map((u: any) => ({ id: u.id, name: u.name }))
          : [];
      }),
  });

  const { data: employees = [] } = useQuery<HrEmployeeListRow[]>({
    queryKey: ['hr', 'employees'],
    queryFn: () => hrApi.listEmployees(),
    staleTime: 60 * 1000,
    // Only needed for the Manual picker — but we also need "active"
    // flag for the display subtitle. The list endpoint is cheap and
    // already warm cache from /hr/employees.
    enabled: scopeKind === 'manual',
  });

  const people: Person[] = useMemo(
    () =>
      employees
        .filter((e) => e.isActive)
        .map((e) => ({
          userId: e.id,
          displayName:
            [e.lastName, e.firstName].filter(Boolean).join(' ') ||
            `עובד #${e.id}`,
          subtitle: e.accountingEmployeeNumber ?? null,
        })),
    [employees],
  );

  // ─── Build the ReportScope payload from UI state ─────────────────
  const scope: ReportScope | null = useMemo(() => {
    if (scopeKind === 'all-active') return { kind: 'all-active' };
    if (scopeKind === 'org-unit') {
      if (orgUnitId == null) return null;
      return { kind: 'org-unit', orgUnitId };
    }
    if (manualUserIds.length === 0) return null;
    return { kind: 'manual', userIds: manualUserIds };
  }, [scopeKind, orgUnitId, manualUserIds]);

  const scopeIsReady = scope !== null;

  // ─── Preview mutation ────────────────────────────────────────────
  const preview = useMutation({
    mutationFn: () => hrApi.previewReport(year, month, scope!),
    onMutate: () => {
      setBlockers(null);
      setPreviewPayload(null);
    },
    onSuccess: (data) => {
      setPreviewPayload(data);
      // Auto-select the first employee's sheet
      setPreviewEmpId(data.employees[0]?.user.id ?? null);
    },
    onError: (err: unknown) => {
      const axiosErr = err as AxiosError<any>;
      const body = axiosErr?.response?.data;
      // The {data: ...} envelope wraps the body in some response flows.
      const inner = body?.data ?? body;
      if (inner?.error === 'MONTHLY_NOT_APPROVED') {
        setBlockers(inner as ReportBlockersError);
      } else {
        notify.apiError(err, 'Failed to build preview');
      }
    },
  });

  // ─── Export mutations ────────────────────────────────────────────
  const stamp = `${year}-${String(month).padStart(2, '0')}`;

  const exportXlsx = useMutation({
    mutationFn: () => hrApi.exportXlsx(year, month, scope!),
    onSuccess: (blob) => downloadBlob(blob, `hr-report-${stamp}.xlsx`),
    onError: (err: unknown) => notify.apiError(err, 'XLSX export failed'),
  });

  const exportPdf = useMutation({
    mutationFn: () => hrApi.exportPdf(year, month, scope!),
    onSuccess: (blob) => downloadBlob(blob, `hr-report-${stamp}.pdf`),
    onError: (err: unknown) => notify.apiError(err, 'PDF export failed'),
  });

  const activeEmp: ReportPayloadEmployee | null = useMemo(() => {
    if (!previewPayload || previewEmpId == null) return null;
    return (
      previewPayload.employees.find((e) => e.user.id === previewEmpId) ?? null
    );
  }, [previewPayload, previewEmpId]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports · דוחות"
        description="דוח מרוכז להנהלת חשבונות · consolidated accounting export"
      />

      {!canExport && (
        <div className="rounded-[14px] border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 p-4 text-[13px] text-amber-800 dark:text-amber-200">
          Requires <span className="font-mono">hr:export</span>. HR Manager and
          HR Clerk hold this grant by default.
        </div>
      )}

      {/* ─── Scope + month toolbar ──────────────────────────────── */}
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <div className="mb-1 text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">
              חודש · Month
            </div>
            <div className="inline-flex items-center gap-1 rounded-[5px] border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1">
              <select
                value={month}
                onChange={(e) => setMonth(Number(e.target.value))}
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
                onChange={(e) => setYear(Number(e.target.value))}
                className="rounded-[5px] border-none bg-transparent px-1 py-0.5 text-[13px] text-slate-900 dark:text-slate-100 focus:outline-none"
                aria-label="Year"
              >
                {Array.from({ length: 3 }, (_, i) => now.getFullYear() - 1 + i).map(
                  (y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ),
                )}
              </select>
            </div>
          </div>

          <div className="flex-1 min-w-[300px]">
            <div className="mb-1 text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">
              היקף · Scope
            </div>
            <div className="inline-flex rounded-[5px] border border-slate-300 dark:border-slate-600 overflow-hidden">
              {([
                { k: 'all-active', label: 'כל העובדים הפעילים' },
                { k: 'org-unit', label: 'לפי יחידת ארגון' },
                { k: 'manual', label: 'בחירה ידנית' },
              ] as const).map((opt) => (
                <button
                  key={opt.k}
                  type="button"
                  onClick={() => {
                    setScopeKind(opt.k);
                    setPreviewPayload(null);
                    setBlockers(null);
                  }}
                  className={cn(
                    'px-3 py-1.5 text-[13px] transition-colors border-l border-slate-300 dark:border-slate-600 first:border-l-0',
                    scopeKind === opt.k
                      ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-semibold'
                      : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Scope-specific sub-picker */}
        {scopeKind === 'org-unit' && (
          <div>
            <div className="mb-1 text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">
              יחידת ארגון · Org unit
            </div>
            <select
              value={orgUnitId ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                setOrgUnitId(v === '' ? null : Number(v));
                setPreviewPayload(null);
                setBlockers(null);
              }}
              className="rounded-[5px] border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1.5 text-[13px] text-slate-900 dark:text-slate-100 focus:outline-none"
            >
              <option value="">— בחר יחידה —</option>
              {orgUnits.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {scopeKind === 'manual' && (
          <div>
            <div className="mb-1 text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">
              עובדים · Employees
            </div>
            <PeopleMultiSelect
              people={people}
              value={manualUserIds}
              onChange={(ids) => {
                setManualUserIds(ids);
                setPreviewPayload(null);
                setBlockers(null);
              }}
              placeholder="בחר עובדים"
              triggerClassName="w-full"
            />
          </div>
        )}

        {/* Action row */}
        <div className="flex items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <button
            type="button"
            disabled={!canExport || !scopeIsReady || preview.isPending}
            onClick={() => preview.mutate()}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-[13px] font-semibold transition-colors',
              canExport && scopeIsReady
                ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:opacity-90'
                : 'cursor-not-allowed bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500',
            )}
          >
            <Eye className="h-3.5 w-3.5" />
            {preview.isPending ? 'טוען...' : 'תצוגה מקדימה'}
          </button>

          <div className="flex-1" />

          <button
            type="button"
            disabled={!canExport || !scopeIsReady || exportXlsx.isPending}
            onClick={() => exportXlsx.mutate()}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[5px] border px-3 py-1.5 text-[13px] font-semibold transition-colors',
              canExport && scopeIsReady
                ? 'border-emerald-200 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40'
                : 'cursor-not-allowed border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-400 dark:text-slate-500',
            )}
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            {exportXlsx.isPending ? 'מייצא...' : 'ייצא XLSX'}
          </button>
          <button
            type="button"
            disabled={!canExport || !scopeIsReady || exportPdf.isPending}
            onClick={() => exportPdf.mutate()}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[5px] border px-3 py-1.5 text-[13px] font-semibold transition-colors',
              canExport && scopeIsReady
                ? 'border-rose-200 dark:border-rose-800/60 bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/40'
                : 'cursor-not-allowed border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-400 dark:text-slate-500',
            )}
          >
            <FileText className="h-3.5 w-3.5" />
            {exportPdf.isPending ? 'מייצא...' : 'ייצא PDF'}
          </button>
        </div>
      </div>

      {/* ─── Blocker banner ─────────────────────────────────────── */}
      {blockers && <BlockerBanner blockers={blockers} />}

      {/* ─── Preview panel ──────────────────────────────────────── */}
      {!previewPayload && !blockers && !preview.isPending && (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-10">
          <div className="flex flex-col items-center justify-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-[14px] bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500">
              <Download className="h-6 w-6" aria-hidden="true" />
            </div>
            <div className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">
              בחר חודש ועובדים, לחץ "תצוגה מקדימה"
            </div>
            <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 uppercase font-semibold tracking-[0.05em]">
              Choose month + scope, click Preview to inspect before export
            </div>
          </div>
        </div>
      )}

      {preview.isPending && (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-10">
          <div className="h-6 w-56 bg-slate-100 dark:bg-slate-800 rounded animate-pulse" />
          <div className="mt-3 h-4 w-80 bg-slate-100 dark:bg-slate-800 rounded animate-pulse" />
          <div className="mt-6 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-5 w-full bg-slate-100 dark:bg-slate-800 rounded animate-pulse"
              />
            ))}
          </div>
        </div>
      )}

      {previewPayload && (
        <PreviewPanel
          payload={previewPayload}
          activeEmp={activeEmp}
          onSelectEmp={setPreviewEmpId}
        />
      )}
    </div>
  );
}

// ─── Blocker banner ────────────────────────────────────────────────

function BlockerBanner({ blockers }: { blockers: ReportBlockersError }) {
  return (
    <div className="rounded-[14px] border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 p-4">
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-[5px] bg-amber-100 dark:bg-amber-900/40 p-1.5">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-300" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-amber-800 dark:text-amber-200">
            {blockers.blockers.length} עובדים טרם אושרו לחודש זה
          </div>
          <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-300 uppercase font-semibold tracking-[0.05em]">
            Approve from <a href="/hr/review" className="underline">/hr/review</a> before export
          </div>
          <ul className="mt-3 space-y-1">
            {blockers.blockers.slice(0, 10).map((b) => (
              <li
                key={b.userId}
                className="flex items-center gap-2 text-[13px] text-amber-900 dark:text-amber-100"
              >
                <span className="truncate">
                  {b.lastName} {b.firstName}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center rounded-[5px] px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.05em]',
                    b.status === 'MISSING'
                      ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                      : b.status === 'LOCKED'
                        ? 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200'
                        : 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-200',
                  )}
                >
                  {b.status}
                </span>
              </li>
            ))}
            {blockers.blockers.length > 10 && (
              <li className="text-[11px] text-amber-700 dark:text-amber-300">
                + {blockers.blockers.length - 10} more
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ─── Preview panel ─────────────────────────────────────────────────

function PreviewPanel({
  payload,
  activeEmp,
  onSelectEmp,
}: {
  payload: ReportPayload;
  activeEmp: ReportPayloadEmployee | null;
  onSelectEmp: (id: number) => void;
}) {
  return (
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      {/* Top strip: employee picker */}
      <div className="flex items-center gap-3 border-b border-slate-100 dark:border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
          <span className="text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">
            {payload.employees.length} עובדים · {payload.year}-
            {String(payload.month).padStart(2, '0')}
          </span>
        </div>
        <div className="flex-1" />
        <select
          value={activeEmp?.user.id ?? ''}
          onChange={(e) => onSelectEmp(Number(e.target.value))}
          className="rounded-[5px] border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1 text-[13px] text-slate-900 dark:text-slate-100 focus:outline-none min-w-[220px]"
          aria-label="Employee sheet"
        >
          {payload.employees.map((e) => (
            <option key={e.user.id} value={e.user.id}>
              {e.user.lastName} {e.user.firstName}
              {e.user.accountingEmployeeNumber
                ? ` (${e.user.accountingEmployeeNumber})`
                : ''}
            </option>
          ))}
        </select>
      </div>

      {activeEmp && <EmployeeSheet emp={activeEmp} />}
    </div>
  );
}

function EmployeeSheet({ emp }: { emp: ReportPayloadEmployee }) {
  const kv: Array<[string, string, boolean]> = [
    ['תקן חודשי', `${emp.header.monthlyStandard.toFixed(2)}h`, false],
    ['בפועל', `${emp.header.actualHours.toFixed(2)}h`, false],
    ['משוקלל', `${emp.header.weightedHours.toFixed(2)}h`, false],
    [
      'סטייה',
      `${emp.header.deviation >= 0 ? '+' : ''}${emp.header.deviation.toFixed(2)}h`,
      emp.header.deviation < 0,
    ],
    ['סך ימי מחלה', String(emp.header.sickDays), false],
    ['סך ימי חופש', String(emp.header.vacationDays), false],
  ];

  return (
    <div className="p-4 space-y-4">
      {/* KV header */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-4">
        <div className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">
          {emp.user.lastName} {emp.user.firstName}
        </div>
        {emp.user.accountingEmployeeNumber && (
          <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            {emp.user.accountingEmployeeNumber}
          </div>
        )}
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {kv.map(([label, value, highlight]) => (
            <div key={label} className="min-w-0">
              <div className="text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">
                {label}
              </div>
              <div
                className={cn(
                  'font-mono tabular-nums text-[13px] font-semibold mt-0.5',
                  highlight
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-slate-900 dark:text-slate-100',
                )}
              >
                {value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Day-by-day table */}
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="w-full text-right" dir="rtl">
          <thead className="bg-slate-50 dark:bg-slate-800/50">
            <tr>
              {[
                'תאריך',
                'יום',
                'התחלה',
                'סיום',
                'סך שעות',
                'סוג יום',
              ].map((h) => (
                <th
                  key={h}
                  className="px-3 py-2 text-[11px] uppercase font-semibold text-slate-500 dark:text-slate-400 tracking-[0.05em]"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {emp.days.map((d) => {
              const hasActivity =
                d.totalHours > 0 || d.startTime != null || d.endTime != null;
              return (
                <tr
                  key={d.date}
                  className={cn(
                    'border-t border-slate-100 dark:border-slate-800',
                    hasActivity
                      ? ''
                      : 'bg-slate-50/50 dark:bg-slate-900/40 text-slate-400 dark:text-slate-500',
                  )}
                >
                  <td className="px-3 py-1.5 font-mono text-[11px] tabular-nums text-slate-700 dark:text-slate-200">
                    {d.date}
                  </td>
                  <td className="px-3 py-1.5 text-[13px] text-slate-700 dark:text-slate-200">
                    {d.dayOfWeek}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[11px] tabular-nums">
                    {d.startTime ?? '—'}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[11px] tabular-nums">
                    {d.endTime ?? '—'}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-1.5 font-mono text-[13px] tabular-nums font-semibold',
                      d.totalHours === 0
                        ? ''
                        : 'text-slate-900 dark:text-slate-100',
                    )}
                  >
                    {d.totalHours.toFixed(2)}
                  </td>
                  <td className="px-3 py-1.5 text-[13px]">{d.dayType}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
