import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Download,
  FileSpreadsheet,
  FileText,
  Lock,
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
  type MonthlyStatus,
  type ReportPayload,
  type ReportPayloadEmployee,
} from './api/hr.api';

/**
 * HR Phase D2 §13 (2026-10-18) — `/hr/reports` consolidated accounting
 * report page.
 *
 * The page is a lazy, on-the-fly viewer:
 *   • Opens empty — nothing fires until the user clicks "הפק דוח".
 *   • Three scope modes build a `userIds?: number[]` for the API:
 *       — "כל העובדים הפעילים" → undefined (server resolves all active)
 *       — "לפי יחידת ארגון"   → ids of active employees in that unit
 *       — "בחירה ידנית"       → ids from PeopleMultiSelect
 *   • `fetchConsolidatedReport` never 500s and never gates on APPROVED;
 *     empty scope / no data returns `{ employees: [] }` → empty state.
 *   • Per-employee status is a badge (OPEN / APPROVED / LOCKED / DRAFT)
 *     on the header card. A small lock button on OPEN/APPROVED/DRAFT
 *     rows calls `POST /hr/monthly/:userId/lock`.
 *   • Export XLSX / PDF are independent of the preview — they fire
 *     the GET export endpoint directly whenever the user has
 *     `hr:export` and the scope is ready.
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

/** Prefer Hebrew name parts when present; fall back to English. */
function displayName(h: {
  firstName: string;
  lastName: string;
  firstNameHe: string | null;
  lastNameHe: string | null;
}) {
  const first = h.firstNameHe?.trim() || h.firstName;
  const last = h.lastNameHe?.trim() || h.lastName;
  return [last, first].filter(Boolean).join(' ') || first || last || '';
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

  // Needed by both Manual (as picker source) and Org-unit (to resolve
  // the chosen unit's members to userIds client-side). Cheap endpoint,
  // 60s stale.
  const { data: employees = [] } = useQuery<HrEmployeeListRow[]>({
    queryKey: ['hr', 'employees'],
    queryFn: () => hrApi.listEmployees(),
    staleTime: 60 * 1000,
    enabled: scopeKind === 'manual' || scopeKind === 'org-unit',
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

  // ─── Resolve the current scope to a `userIds?: number[]` the API
  // takes. `undefined` means "all active" — the server resolves it.
  // Returns `null` when the UI is in a mode that requires a selection
  // the user hasn't made yet.
  const resolvedUserIds: { userIds?: number[] } | null = useMemo(() => {
    if (scopeKind === 'all-active') return { userIds: undefined };
    if (scopeKind === 'org-unit') {
      if (orgUnitId == null) return null;
      const ids = employees
        .filter((e) => e.isActive && e.orgUnit?.id === orgUnitId)
        .map((e) => e.id);
      return { userIds: ids };
    }
    if (manualUserIds.length === 0) return null;
    return { userIds: manualUserIds };
  }, [scopeKind, orgUnitId, manualUserIds, employees]);

  const scopeIsReady = resolvedUserIds !== null;

  // ─── Preview mutation ────────────────────────────────────────────
  const preview = useMutation({
    mutationFn: () =>
      hrApi.fetchConsolidatedReport(year, month, resolvedUserIds!.userIds),
    onMutate: () => {
      setPreviewPayload(null);
    },
    onSuccess: (data) => {
      setPreviewPayload(data);
      setPreviewEmpId(data.employees[0]?.header.userId ?? null);
    },
    onError: (err: unknown) => notify.apiError(err, 'Failed to build preview'),
  });

  // ─── Export mutations ────────────────────────────────────────────
  const stamp = `${year}-${String(month).padStart(2, '0')}`;

  const exportXlsx = useMutation({
    mutationFn: () =>
      hrApi.exportConsolidated(year, month, 'xlsx', resolvedUserIds?.userIds),
    onSuccess: (blob) => downloadBlob(blob, `hr-report-${stamp}.xlsx`),
    onError: (err: unknown) => notify.apiError(err, 'XLSX export failed'),
  });

  const exportPdf = useMutation({
    mutationFn: () =>
      hrApi.exportConsolidated(year, month, 'pdf', resolvedUserIds?.userIds),
    onSuccess: (blob) => downloadBlob(blob, `hr-report-${stamp}.pdf`),
    onError: (err: unknown) => notify.apiError(err, 'PDF export failed'),
  });

  // ─── Lock button mutation ────────────────────────────────────────
  const lockMonthly = useMutation({
    mutationFn: (vars: { userId: number }) =>
      hrApi.lockMonthly(vars.userId, year, month),
    onSuccess: (_row, vars) => {
      // Patch the preview in place so the badge flips to LOCKED and
      // the lock button disappears, without a full refetch.
      setPreviewPayload((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          employees: prev.employees.map((emp) =>
            emp.header.userId === vars.userId
              ? { ...emp, header: { ...emp.header, status: 'LOCKED' } }
              : emp,
          ),
        };
      });
      notify.success('החודש ננעל · Month locked');
    },
    onError: (err: unknown) => notify.apiError(err, 'Lock failed'),
  });

  const activeEmp: ReportPayloadEmployee | null = useMemo(() => {
    if (!previewPayload || previewEmpId == null) return null;
    return (
      previewPayload.employees.find(
        (e) => e.header.userId === previewEmpId,
      ) ?? null
    );
  }, [previewPayload, previewEmpId]);

  // Export buttons: enabled whenever the user has the permission and
  // the scope is ready (so Manual / Org-unit still require a pick).
  const exportEnabled = canExport && scopeIsReady;

  return (
    <div className="space-y-5" dir="rtl">
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
            <FileText className="h-3.5 w-3.5" />
            {preview.isPending ? 'טוען…' : 'הפק דוח'}
          </button>

          <div className="flex-1" />

          <button
            type="button"
            disabled={!exportEnabled || exportXlsx.isPending}
            onClick={() => exportXlsx.mutate()}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[5px] border px-3 py-1.5 text-[13px] font-semibold transition-colors',
              exportEnabled
                ? 'border-emerald-200 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40'
                : 'cursor-not-allowed border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-400 dark:text-slate-500',
            )}
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            {exportXlsx.isPending ? 'מייצא…' : 'ייצא XLSX'}
          </button>
          <button
            type="button"
            disabled={!exportEnabled || exportPdf.isPending}
            onClick={() => exportPdf.mutate()}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[5px] border px-3 py-1.5 text-[13px] font-semibold transition-colors',
              exportEnabled
                ? 'border-rose-200 dark:border-rose-800/60 bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/40'
                : 'cursor-not-allowed border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-400 dark:text-slate-500',
            )}
          >
            <FileText className="h-3.5 w-3.5" />
            {exportPdf.isPending ? 'מייצא…' : 'ייצא PDF'}
          </button>
        </div>
      </div>

      {/* ─── Empty landing / preview ────────────────────────────── */}
      {!previewPayload && !preview.isPending && (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-10">
          <div className="flex flex-col items-center justify-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-[14px] bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500">
              <Download className="h-6 w-6" aria-hidden="true" />
            </div>
            <div className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">
              בחר/י חודש ועובדים ולחץ "הפק דוח"
            </div>
            <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 uppercase font-semibold tracking-[0.05em]">
              Choose month + scope, click Generate to inspect before export
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

      {previewPayload && previewPayload.employees.length === 0 && (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-10">
          <div className="flex flex-col items-center justify-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-[14px] bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500">
              <Users className="h-6 w-6" aria-hidden="true" />
            </div>
            <div className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">
              אין נתונים לחודש שנבחר
            </div>
            <div className="mt-1 text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">
              No data for the selected month
            </div>
          </div>
        </div>
      )}

      {previewPayload && previewPayload.employees.length > 0 && (
        <PreviewPanel
          payload={previewPayload}
          activeEmp={activeEmp}
          onSelectEmp={setPreviewEmpId}
          onLock={(userId) => {
            if (
              window.confirm(
                'לנעול את החודש לעובד זה? פעולה זו אינה הפיכה מהממשק.',
              )
            ) {
              lockMonthly.mutate({ userId });
            }
          }}
          lockPending={lockMonthly.isPending}
          lockPendingUserId={
            lockMonthly.isPending
              ? (lockMonthly.variables as { userId: number } | undefined)
                  ?.userId ?? null
              : null
          }
        />
      )}
    </div>
  );
}

// ─── Status badge ──────────────────────────────────────────────────

const STATUS_PILL: Record<MonthlyStatus, string> = {
  OPEN: 'bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200',
  APPROVED:
    'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  LOCKED:
    'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
  DRAFT:
    'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
};

function StatusBadge({ status }: { status: MonthlyStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center text-[11px] font-bold tracking-wide uppercase rounded-[5px] px-2 py-0.5',
        STATUS_PILL[status],
      )}
    >
      {status}
    </span>
  );
}

// ─── Preview panel ─────────────────────────────────────────────────

function PreviewPanel({
  payload,
  activeEmp,
  onSelectEmp,
  onLock,
  lockPending,
  lockPendingUserId,
}: {
  payload: ReportPayload;
  activeEmp: ReportPayloadEmployee | null;
  onSelectEmp: (id: number) => void;
  onLock: (userId: number) => void;
  lockPending: boolean;
  lockPendingUserId: number | null;
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
          value={activeEmp?.header.userId ?? ''}
          onChange={(e) => onSelectEmp(Number(e.target.value))}
          className="rounded-[5px] border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1 text-[13px] text-slate-900 dark:text-slate-100 focus:outline-none min-w-[220px]"
          aria-label="Employee sheet"
        >
          {payload.employees.map((e) => {
            const name = displayName(e.header);
            return (
              <option key={e.header.userId} value={e.header.userId}>
                {name}
                {e.header.accountingEmployeeNumber
                  ? ` (${e.header.accountingEmployeeNumber})`
                  : ''}
              </option>
            );
          })}
        </select>
      </div>

      {activeEmp && (
        <EmployeeSheet
          emp={activeEmp}
          onLock={onLock}
          lockPending={lockPending && lockPendingUserId === activeEmp.header.userId}
        />
      )}
    </div>
  );
}

function EmployeeSheet({
  emp,
  onLock,
  lockPending,
}: {
  emp: ReportPayloadEmployee;
  onLock: (userId: number) => void;
  lockPending: boolean;
}) {
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
  const name = displayName(emp.header);
  const canLock = emp.header.status !== 'LOCKED';

  return (
    <div className="p-4 space-y-4">
      {/* KV header */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-4 relative">
        {canLock && (
          <button
            type="button"
            disabled={lockPending}
            onClick={() => onLock(emp.header.userId)}
            title="נעל חודש · Lock month"
            className={cn(
              'absolute top-3 left-3 inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide transition-colors',
              lockPending
                ? 'cursor-not-allowed border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-400 dark:text-slate-500'
                : 'border-indigo-200 dark:border-indigo-800/60 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/40',
            )}
          >
            <Lock className="h-3 w-3" />
            {lockPending ? 'נועל…' : 'נעל'}
          </button>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">
            {name}
          </span>
          <StatusBadge status={emp.header.status} />
        </div>
        {emp.header.accountingEmployeeNumber && (
          <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            {emp.header.accountingEmployeeNumber}
          </div>
        )}
        {emp.header.error && (
          <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
            {emp.header.error}
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
                'סה"כ שעות',
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
            {emp.rows.map((d) => {
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
                    {d.weekday}
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
