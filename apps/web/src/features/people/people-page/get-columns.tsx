import { Pencil, KeyRound } from 'lucide-react';
import { UserAvatar } from '@/components/shared/user-avatar';
import { cn } from '@/lib/utils';
import type { UserListItem } from '@/types';
import type { ColumnDef } from '@tanstack/react-table';

export function getColumns(
  isPartners: boolean,
  roles: any[],
  canEdit: boolean,
  onChangeRole: (userId: number, roleId: number) => void,
  onEdit: (user: UserListItem) => void,
  onResetPassword: (user: UserListItem) => void,
  savingUserId: number | null,
): ColumnDef<UserListItem, unknown>[] {
  const cols: ColumnDef<UserListItem, unknown>[] = [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => (
        <div className="flex items-center gap-3 group/row">
          <UserAvatar firstName={row.original.firstName} lastName={row.original.lastName} avatarUrl={row.original.avatarUrl} size="sm" />
          <div className="flex-1">
            <p className="font-medium">{row.original.firstName} {row.original.lastName}</p>
          </div>
          {/* Inline edit button — guaranteed-visible affordance directly
              next to the name so the user always has a way into the edit
              modal even if column layout, breakpoints, or HMR state mess
              with the trailing Actions column. Hover-revealed so the
              column visually stays as a "name" cell at rest. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEdit(row.original); }}
            className="opacity-60 hover:opacity-100 p-1.5 rounded-md text-blue-600 hover:bg-blue-50 transition-opacity"
            title="Edit user details"
            aria-label={`Edit ${row.original.firstName} ${row.original.lastName}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
      ),
    },
    {
      accessorKey: 'code',
      header: 'Code',
      cell: ({ row }) => (
        <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
          {(row.original as any).code ?? '—'}
        </span>
      ),
    },
    {
      accessorKey: 'email',
      header: 'Email',
      cell: ({ row }) => <span className="text-sm text-slate-600 dark:text-slate-300">{row.original.email ?? '-'}</span>,
    },
    {
      accessorKey: 'position',
      header: 'Job Title',
      cell: ({ row }) => row.original.position ?? '-',
    },
    {
      accessorKey: 'department',
      header: 'Department',
      cell: ({ row }) => row.original.department ?? '-',
    },
    {
      // M5 — Seniority Level column. Renders the LEVEL NAME only (e.g.
      // "Senior") not the id, even though the API ships {id, code, name,
      // defaultHourlyCost, currency} — admins consume cost via the Cost
      // tab; this column is for quick scan only.
      id: 'seniorityLevel',
      header: 'Seniority',
      cell: ({ row }) => {
        const sl = (row.original as any).seniorityLevel as { name?: string } | null | undefined;
        if (!sl?.name) return <span className="text-slate-300 dark:text-slate-600">—</span>;
        return <span className="text-sm text-slate-700 dark:text-slate-200">{sl.name}</span>;
      },
    },
  ];

  if (isPartners) {
    cols.push({
      accessorKey: 'companyName',
      header: 'Company',
      cell: ({ row }) => row.original.companyName ?? '-',
    });
  }

  cols.push(
    {
      accessorKey: 'roleName',
      header: 'Authorization Role',
      cell: ({ row }) => {
        const user = row.original;
        const currentRoleId = (user as any).roleId;
        if (!canEdit) {
          return <span className="text-sm">{user.roleName ?? '—'}</span>;
        }
        const isSaving = savingUserId === user.id;
        return (
          <select
            aria-label={`Role for ${user.firstName} ${user.lastName}`}
            value={currentRoleId ?? ''}
            disabled={isSaving}
            onChange={(e) => {
              const newRoleId = Number(e.target.value);
              if (newRoleId && newRoleId !== currentRoleId) onChangeRole(user.id, newRoleId);
            }}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none',
              isSaving && 'opacity-50 cursor-wait',
            )}
          >
            {roles.map((r: any) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        );
      },
    },
    {
      accessorKey: 'isActive',
      header: 'Status',
      cell: ({ row }) => (
        <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', row.original.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-slate-400')}>
          {row.original.isActive ? 'Active' : 'Inactive'}
        </span>
      ),
    },
  );

  // Actions column is ALWAYS rendered now. Previously this was gated on
  // a permission check that always evaluated to false for non-admin
  // roles, hiding the edit + reset-password icons across the board.
  // The header label "Actions" makes the column visible at a glance so
  // users on a wide-enough viewport know the row is editable; on narrow
  // viewports the DataTable wrapper handles horizontal scrolling.
  // (T-fix, 2026-06-29.)
  {
    void canEdit; // gate retained as no-op for future use
    cols.push({
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => onEdit(row.original)}
            className="p-1.5 rounded hover:bg-blue-50 text-blue-600 hover:text-blue-700"
            title="Edit user details"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onResetPassword(row.original)}
            className="p-1.5 rounded hover:bg-amber-50 text-slate-400 dark:text-slate-500 hover:text-amber-600"
            title="Reset password"
          >
            <KeyRound className="h-3.5 w-3.5" />
          </button>
        </div>
      ),
    });
  }

  return cols;
}
