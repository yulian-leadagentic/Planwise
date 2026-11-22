import { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Lock, ScrollText, X } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';

import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import { isPermissionDenied, getPermissionMessage } from '@/lib/notify';
import { formatDateTime } from '@/lib/date-utils';
import { cn } from '@/lib/utils';
import { hrApi, type HrAuditRow, type HrEmployeeListRow } from './api/hr.api';

/**
 * Permissions round 3 (2026-11-22) — `/hr/audit`, the HR audit trail.
 *
 * Lists category-`hr` activity rows (absences, documents, eligibilities,
 * employee HR fields, monthly approve / reopen / lock, HR catalog and
 * settings) from GET /hr/audit. Visible to `hr:read` holders only — not
 * to department leads, and not to an Admin without the HR grant (the
 * API has no admin bypass for `hr`; the sub-nav tab and the route guard
 * mirror that).
 *
 * Server-side paging + filters (dates, action group, employee, actor).
 */

const PER_PAGE = 50;

/** Action groups for the filter — prefixes of the `hr.*` action codes. */
const ACTION_GROUPS: Array<{ value: string; label: string }> = [
  { value: '', label: 'כל הפעולות · All' },
  { value: 'hr.monthly', label: 'נוכחות חודשית · Monthly' },
  { value: 'hr.absence.', label: 'היעדרויות · Absences' },
  { value: 'hr.attachment', label: 'מסמכים · Documents' },
  { value: 'hr.eligibility', label: 'זכאויות · Eligibilities' },
  { value: 'hr.employee', label: 'פרטי העסקה · Employee fields' },
  { value: 'hr.bucket', label: 'סלי שעות · Hour buckets' },
  { value: 'hr.absence_type', label: 'סוגי היעדרות · Absence types' },
  { value: 'hr.settings', label: 'הגדרות · Settings' },
];

/** Plain-words label per action code; unknown codes show the raw code. */
const ACTION_LABELS: Record<string, string> = {
  'hr.monthly.approved': 'Month approved',
  'hr.monthly.reopened': 'Month reopened',
  'hr.monthly.locked': 'Month locked',
  'hr.absence.created': 'Absence added',
  'hr.absence.updated': 'Absence changed',
  'hr.absence.deleted': 'Absence deleted',
  'hr.attachment.uploaded': 'Document uploaded',
  'hr.attachment.deleted': 'Document deleted',
  'hr.eligibility.created': 'Eligibility granted',
  'hr.eligibility.updated': 'Eligibility changed',
  'hr.eligibility.deactivated': 'Eligibility ended',
  'hr.employee.updated': 'Employee fields changed',
  'hr.bucket.created': 'Bucket created',
  'hr.bucket.updated': 'Bucket changed',
  'hr.bucket.deactivated': 'Bucket deactivated',
  'hr.absence_type.created': 'Absence type created',
  'hr.absence_type.updated': 'Absence type changed',
  'hr.absence_type.deactivated': 'Absence type deactivated',
  'hr.settings.updated': 'HR settings changed',
};

const SEVERITY_PILL: Record<string, string> = {
  warn: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-300',
  error: 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300',
  critical: 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300',
};

const ENTITY_LABELS: Record<string, string> = {
  monthly_attendance: 'Month',
  absence_record: 'Absence',
  employee_attachment: 'Document',
  bucket_eligibility: 'Eligibility',
  employee: 'Employee',
  special_hour_bucket: 'Bucket',
  absence_type: 'Absence type',
  hr_settings: 'Settings',
};

const fullName = (u: { firstName: string | null; lastName: string | null } | null | undefined) =>
  u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() : '';

const selectCls =
  'rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-[13px] text-slate-700 dark:text-slate-200 focus:border-blue-500 dark:focus:border-blue-400 focus:outline-none';

export function HrAuditPage() {
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [action, setAction] = useState('');
  const [employeeId, setEmployeeId] = useState<number | ''>('');
  const [actorId, setActorId] = useState<number | ''>('');

  // Any filter change goes back to page 1.
  const setFilter = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setPage(1);
  };

  const query = {
    page,
    perPage: PER_PAGE,
    from: from || undefined,
    to: to || undefined,
    action: action || undefined,
    employeeId: employeeId === '' ? undefined : employeeId,
    actorId: actorId === '' ? undefined : actorId,
  };

  const auditQuery = useQuery({
    queryKey: ['hr', 'audit', query],
    queryFn: () => hrApi.listAudit(query),
    placeholderData: keepPreviousData,
    staleTime: 15 * 1000,
  });

  // Roster for the employee / actor pickers (hr:read, same as this page).
  const employeesQuery = useQuery<HrEmployeeListRow[]>({
    queryKey: ['hr', 'employees'],
    queryFn: () => hrApi.listEmployees(),
    staleTime: 60 * 1000,
  });
  const roster = useMemo(
    () =>
      (employeesQuery.data ?? [])
        .slice()
        .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`, 'he')),
    [employeesQuery.data],
  );

  const rows = auditQuery.data?.data ?? [];
  const meta = auditQuery.data?.meta;
  const hasFilters = !!(from || to || action || employeeId !== '' || actorId !== '');

  const columns = useMemo<ColumnDef<HrAuditRow, unknown>[]>(
    () => [
      {
        id: 'time',
        header: 'זמן · Time',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="whitespace-nowrap font-mono text-xs font-medium text-slate-500 dark:text-slate-400">
            {formatDateTime(row.original.createdAt)}
          </span>
        ),
      },
      {
        id: 'actor',
        header: 'בוצע ע״י · By',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">
            {fullName(row.original.actor) || <span className="font-normal text-slate-400 dark:text-slate-500">System</span>}
          </span>
        ),
      },
      {
        id: 'action',
        header: 'פעולה · Action',
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original;
          const sev = SEVERITY_PILL[r.severity];
          return (
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[13px] text-slate-700 dark:text-slate-200">{ACTION_LABELS[r.action] ?? r.action}</span>
                {sev && (
                  <span className={cn('rounded-[5px] px-1.5 py-0.5 text-[11px] font-bold tracking-wide', sev)}>
                    {r.severity}
                  </span>
                )}
              </div>
              <div className="font-mono text-[11px] text-slate-400 dark:text-slate-500">{r.action}</div>
            </div>
          );
        },
      },
      {
        id: 'employee',
        header: 'עובד · Employee',
        enableSorting: false,
        cell: ({ row }) => {
          const e = row.original.employee;
          if (!e) return <span className="text-slate-400 dark:text-slate-500">—</span>;
          return (
            <span className="text-[13px] text-slate-700 dark:text-slate-200">
              {fullName(e) || <span className="font-mono text-xs">#{e.id}</span>}
            </span>
          );
        },
      },
      {
        id: 'entity',
        header: 'ישות · Entity',
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original;
          if (!r.entityType) return <span className="text-slate-400 dark:text-slate-500">—</span>;
          return (
            <div className="min-w-0">
              <div className="text-[13px] text-slate-700 dark:text-slate-200">
                {ENTITY_LABELS[r.entityType] ?? r.entityType}
                {r.entityId != null && (
                  <span className="ml-1 font-mono text-xs text-slate-400 dark:text-slate-500">#{r.entityId}</span>
                )}
              </div>
              {r.entityName && (
                <div dir="auto" className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                  {r.entityName}
                </div>
              )}
            </div>
          );
        },
      },
      {
        id: 'description',
        header: 'תיאור · Description',
        enableSorting: false,
        cell: ({ row }) => (
          <span dir="auto" className="block max-w-md text-[13px] text-slate-700 dark:text-slate-200" title={row.original.description}>
            {row.original.description}
          </span>
        ),
      },
    ],
    [],
  );

  if (auditQuery.isError && isPermissionDenied(auditQuery.error)) {
    return (
      <div className="space-y-5">
        <PageHeader title="יומן ביקורת" description="HR audit trail" />
        <EmptyState icon={Lock} title="No access to the HR audit" description={getPermissionMessage(auditQuery.error)} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="יומן ביקורת"
        description="Who changed what in HR — absences, documents, eligibilities, monthly approvals. Visible to HR only."
      />

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">מתאריך · From</span>
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFilter(setFrom)(e.target.value)}
            className={selectCls}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">עד תאריך · To</span>
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setFilter(setTo)(e.target.value)}
            className={selectCls}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">פעולה · Action</span>
          <select value={action} onChange={(e) => setFilter(setAction)(e.target.value)} className={selectCls}>
            {ACTION_GROUPS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">עובד · Employee</span>
          <select
            value={employeeId}
            onChange={(e) => setFilter(setEmployeeId)(e.target.value ? Number(e.target.value) : '')}
            className={selectCls}
          >
            <option value="">כולם · Everyone</option>
            {roster.map((u) => (
              <option key={u.id} value={u.id}>
                {u.firstName} {u.lastName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">בוצע ע״י · By</span>
          <select
            value={actorId}
            onChange={(e) => setFilter(setActorId)(e.target.value ? Number(e.target.value) : '')}
            className={selectCls}
          >
            <option value="">כולם · Anyone</option>
            {roster.map((u) => (
              <option key={u.id} value={u.id}>
                {u.firstName} {u.lastName}
              </option>
            ))}
          </select>
        </label>
        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              setFrom('');
              setTo('');
              setAction('');
              setEmployeeId('');
              setActorId('');
              setPage(1);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200 transition-all duration-150"
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </button>
        )}
        {meta && (
          <span className="ml-auto text-[11px] font-medium text-slate-400 dark:text-slate-500">
            <span className="font-mono tabular-nums">{meta.total}</span> rows
          </span>
        )}
      </div>

      {!auditQuery.isLoading && rows.length === 0 ? (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
          <EmptyState
            icon={ScrollText}
            title={hasFilters ? 'No HR activity matches these filters' : 'No HR activity yet'}
            description={
              hasFilters
                ? 'Try a wider date range or clear the filters.'
                : 'Absences, documents, eligibilities and monthly approvals will appear here as they happen.'
            }
          />
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={auditQuery.isLoading}
          // Server-side paging (below) decides what's loaded.
          pageSize={1000}
          emptyMessage="No HR activity"
          renderCard={(r) => (
            <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {ACTION_LABELS[r.action] ?? r.action}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    {fullName(r.actor) || 'System'}
                    {r.employee && <> → {fullName(r.employee) || `#${r.employee.id}`}</>}
                  </div>
                </div>
                <span className="whitespace-nowrap font-mono text-[11px] text-slate-400 dark:text-slate-500">
                  {formatDateTime(r.createdAt)}
                </span>
              </div>
              <p dir="auto" className="mt-2 text-[13px] text-slate-700 dark:text-slate-200">
                {r.description}
              </p>
            </div>
          )}
        />
      )}

      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            aria-label="Previous page"
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-[13px] text-slate-500 dark:text-slate-400">
            Page <span className="font-mono tabular-nums">{page}</span> of{' '}
            <span className="font-mono tabular-nums">{meta.totalPages}</span>
          </span>
          <button
            type="button"
            disabled={page >= meta.totalPages}
            onClick={() => setPage((p) => p + 1)}
            aria-label="Next page"
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
