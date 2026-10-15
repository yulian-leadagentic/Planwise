import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import { cn } from '@/lib/utils';
import { hrApi, type HrEmployeeListRow } from './api/hr.api';
import { EmployeeDrawer } from './employee-drawer';

/**
 * HR Phase A4 (2026-10-15) — HR roster. All employees (userType =
 * 'employee', including inactive — payroll still needs them until
 * the final paycheck lands). Click a row → EmployeeDrawer with the
 * HR fields + per-employee bucket eligibilities (B behaviour buckets
 * only in the add dialog, per §3.6).
 */
export function HrEmployeesPage() {
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data: employees = [], isLoading } = useQuery<HrEmployeeListRow[]>({
    queryKey: ['hr', 'employees'],
    queryFn: () => hrApi.listEmployees(),
    staleTime: 60 * 1000,
  });

  const columns = useMemo<ColumnDef<HrEmployeeListRow, unknown>[]>(
    () => [
      {
        id: 'name',
        header: 'שם · Name',
        accessorFn: (row) => `${row.lastName ?? ''} ${row.firstName ?? ''}`.trim(),
        cell: ({ row }) => {
          const e = row.original;
          const hebrew =
            e.firstNameHe || e.lastNameHe
              ? `${e.lastNameHe ?? ''} ${e.firstNameHe ?? ''}`.trim()
              : null;
          return (
            <div className="min-w-0">
              <div
                className={cn(
                  'truncate text-sm font-semibold text-slate-900 dark:text-slate-100',
                  !e.isActive && 'opacity-60',
                )}
              >
                {e.firstName} {e.lastName}
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
        id: 'department',
        header: 'מחלקה · Department',
        accessorFn: (row) => row.orgUnit?.name ?? '',
        cell: ({ row }) => (
          <span className="text-[13px] text-slate-700 dark:text-slate-200">
            {row.original.orgUnit?.name ?? (
              <span className="text-slate-400 dark:text-slate-500">—</span>
            )}
          </span>
        ),
      },
      {
        id: 'dailyStandardHours',
        header: 'תקן יומי · Daily std',
        accessorFn: (row) => row.dailyStandardHours ?? 0,
        enableColumnFilter: false,
        cell: ({ row }) => {
          const v = row.original.dailyStandardHours;
          return (
            <span className="font-mono text-xs tabular-nums text-slate-700 dark:text-slate-200">
              {v != null ? `${v}h` : <span className="text-slate-400 dark:text-slate-500">—</span>}
            </span>
          );
        },
      },
      {
        id: 'employmentType',
        header: 'סוג העסקה · Type',
        accessorFn: (row) => row.employmentType ?? '',
        meta: {
          filterOptions: [
            { value: 'GLOBAL', label: 'Global' },
            { value: 'HOURLY', label: 'Hourly' },
          ],
        },
        cell: ({ row }) => {
          const t = row.original.employmentType;
          if (!t) return <span className="text-slate-400 dark:text-slate-500">—</span>;
          return (
            <span
              className={cn(
                'inline-flex items-center rounded-[5px] px-2 py-0.5 text-[11px] font-bold tracking-wide',
                t === 'GLOBAL'
                  ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300'
                  : 'bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-300',
              )}
            >
              {t === 'GLOBAL' ? 'Global' : 'Hourly'}
            </span>
          );
        },
      },
      {
        id: 'accountingEmployeeNumber',
        header: "מס' הנהח״ש · Payroll #",
        accessorFn: (row) => row.accountingEmployeeNumber ?? '',
        cell: ({ row }) => (
          <span className="font-mono text-xs text-slate-700 dark:text-slate-200">
            {row.original.accountingEmployeeNumber || (
              <span className="font-sans text-slate-400 dark:text-slate-500">—</span>
            )}
          </span>
        ),
      },
      {
        id: 'isActive',
        header: 'סטטוס · Status',
        accessorFn: (row) => (row.isActive ? 'active' : 'inactive'),
        meta: {
          filterOptions: [
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ],
        },
        cell: ({ row }) =>
          row.original.isActive ? (
            <span className="inline-flex items-center rounded-[5px] bg-emerald-50 dark:bg-emerald-900/30 px-2 py-0.5 text-[11px] font-bold tracking-wide text-emerald-600 dark:text-emerald-300">
              Active
            </span>
          ) : (
            <span className="inline-flex items-center rounded-[5px] bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-bold tracking-wide text-slate-500 dark:text-slate-400">
              Inactive
            </span>
          ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Employees"
        description="כל העובדים · All employees (click a row to edit HR fields + bucket eligibilities)"
      />

      {!isLoading && employees.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No employees found"
          description="HR shows every user whose type is 'employee'. Add employees from Admin → Employees."
        />
      ) : (
        <DataTable
          columns={columns}
          data={employees}
          isLoading={isLoading}
          enableColumnFilters
          onRowClick={(row) => setSelectedId(row.id)}
          emptyMessage="No employees found"
          renderCard={(e) => (
            <button
              type="button"
              onClick={() => setSelectedId(e.id)}
              className="w-full rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {e.firstName} {e.lastName}
                  </div>
                  <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                    {e.orgUnit?.name ?? '—'}
                    {e.accountingEmployeeNumber ? ` · ${e.accountingEmployeeNumber}` : ''}
                  </div>
                </div>
                {e.employmentType && (
                  <span
                    className={cn(
                      'shrink-0 rounded-[5px] px-2 py-0.5 text-[11px] font-bold tracking-wide',
                      e.employmentType === 'GLOBAL'
                        ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300'
                        : 'bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-300',
                    )}
                  >
                    {e.employmentType === 'GLOBAL' ? 'Global' : 'Hourly'}
                  </span>
                )}
              </div>
            </button>
          )}
        />
      )}

      {selectedId != null && (
        <EmployeeDrawer userId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}
