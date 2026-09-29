import { Coins, Pencil, KeyRound } from 'lucide-react';
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
  // QA3 item 1 (2026-09-24) — per-employee cost-rate override. Opens
  // the same modal that lists the user's override history and lets the
  // admin set/change/remove it. Optional so the partners tab (external
  // employees, no cost concept today) can omit the affordance.
  onCostOverride?: (user: UserListItem) => void,
  // QA3 round-2 item 4 (EMP-INLINE, 2026-09-25) — inline-edit callbacks
  // for Department / Seniority / Active. Same shape as onChangeRole:
  // each callback fires a single-field PATCH /users/:id. Optional so
  // the partners tab (which has no seniority/department concept today)
  // renders the columns as plain text.
  //
  // Phase 4 · Stage 2 follow-up (2026-09-28) — `departments` is now a
  // list of ORG UNITS (id: number, name: string); the "Department" cell
  // writes to `orgUnitId` via `onChangeDepartment`. Legacy free-text
  // `User.department` still displays as a fallback when no OrgUnit is
  // linked; picking any real option upgrades the user to an OrgUnit.
  departments: Array<{ id: number | string; name: string }> = [],
  seniorityLevels: Array<{ id: number; name: string; defaultHourlyCost?: any; currency?: string | null }> = [],
  onChangeDepartment?: (userId: number, orgUnitId: number | null) => void,
  onChangeSeniority?: (userId: number, seniorityLevelId: number | null) => void,
  onChangeActive?: (userId: number, isActive: boolean) => void,
  // QA3 round-3 item 7b (2026-09-27) — finance-gated effective ₪/h
  // column. Falsy hides the column entirely (default). Also hidden on
  // the Partners tab regardless.
  showEffectiveRate = false,
): ColumnDef<UserListItem, unknown>[] {
  const cols: ColumnDef<UserListItem, unknown>[] = [
    {
      // QA3 master-handoff fix (2026-09-27) — the row's User model has
      // firstName + lastName (plus Hebrew renditions), not `name`, so
      // `accessorKey: 'name'` returned undefined and every non-empty
      // filter matched nothing ("Nitz" showed 'No users found' even
      // though Nitzan was on the page). accessorFn concatenates the
      // English + Hebrew names so both scripts search naturally.
      id: 'name',
      header: 'Name',
      accessorFn: (row: any) => {
        const parts = [row.firstName, row.lastName, row.firstNameHe, row.lastNameHe]
          .filter((s) => s && String(s).trim().length > 0);
        return parts.join(' ');
      },
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
      // JT-3b-4 (QA4 · 2026-09-29): column now shows Position (the
      // descriptive org title) — see the JT-1 split. `User.position`
      // string is kept in sync with `BusinessPartner.positionId` via
      // the users.service.ts sync hook.
      accessorKey: 'position',
      header: 'Position',
      cell: ({ row }) => row.original.position ?? '-',
    },
    {
      accessorKey: 'department',
      header: 'Department',
      cell: ({ row }) => {
        const user = row.original as any;
        // Phase 4 · Stage 2 follow-up — prefer the OrgUnit relation over
        // the legacy free-text `User.department` string. `orgUnitId` is
        // the write field (via PATCH /users/:id { orgUnitId }); the
        // string only shows as a read-only fallback when the row hasn't
        // yet been backfilled onto an OrgUnit.
        const currentOrgUnitId: number | null = user.orgUnitId ?? user.orgUnit?.id ?? null;
        // Retire-User.department Step 3/3 (2026-09-28) — OrgUnit is
        // the sole source. The legacy free-text `user.department`
        // hint below is retired with the column.
        const orgUnitName: string = user.orgUnit?.name ?? '';
        // Fall back to plain text when the callback isn't wired (e.g.
        // partners tab, or a caller that just wants a read-only view).
        if (!onChangeDepartment || !canEdit) {
          return orgUnitName || '-';
        }
        const isSaving = savingUserId === user.id;
        return (
          <select
            aria-label={`Department for ${user.firstName} ${user.lastName}`}
            value={currentOrgUnitId ?? ''}
            disabled={isSaving}
            onChange={(e) => {
              const raw = e.target.value;
              const next = raw === '' ? null : Number(raw);
              if (next === currentOrgUnitId) return;
              onChangeDepartment(user.id, next);
            }}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none',
              isSaving && 'opacity-50 cursor-wait',
            )}
          >
            <option value="">— None —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
            {/* Retire-User.department Step 3/3 (2026-09-28) — the
                "legacy free-text" hint option was removed with the
                column drop; every row is now on an OrgUnit or "— None —". */}
          </select>
        );
      },
    },
    {
      // M5 — Seniority Level column. Renders the LEVEL NAME only (e.g.
      // "Senior") not the id, even though the API ships {id, code, name,
      // defaultHourlyCost, currency} — admins consume cost via the Cost
      // tab; this column is for quick scan only. QA3 round-2 item 4:
      // wired inline via the same pattern as the Role cell.
      id: 'seniorityLevel',
      header: 'Labor Category',
      // QA3 master-handoff · Part B — seniority-level enum filter fed
      // by the catalog. accessorFn lets TanStack pull the value from
      // the nested seniorityLevel.name so the filter has something to
      // compare against.
      accessorFn: (row: any) => row.seniorityLevel?.name ?? '',
      meta: {
        filterOptions: seniorityLevels.map((s) => ({ value: String(s.name ?? ''), label: String(s.name ?? '') })),
      },
      filterFn: (row, _colId, val) => {
        if (!val) return true;
        const name = (row.original as any).seniorityLevel?.name ?? '';
        return String(name) === String(val);
      },
      cell: ({ row }) => {
        const user = row.original;
        const sl = (user as any).seniorityLevel as { id?: number; name?: string } | null | undefined;
        if (!onChangeSeniority || !canEdit) {
          return sl?.name
            ? <span className="text-sm text-slate-700 dark:text-slate-200">{sl.name}</span>
            : <span className="text-slate-300 dark:text-slate-600">—</span>;
        }
        const currentId = sl?.id ?? '';
        const isSaving = savingUserId === user.id;
        return (
          <select
            aria-label={`Labor Category for ${user.firstName} ${user.lastName}`}
            value={currentId}
            disabled={isSaving}
            onChange={(e) => {
              const raw = e.target.value;
              const next = raw === '' ? null : Number(raw);
              if (next === (sl?.id ?? null)) return;
              onChangeSeniority(user.id, next);
            }}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none',
              isSaving && 'opacity-50 cursor-wait',
            )}
          >
            <option value="">— None —</option>
            {seniorityLevels.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        );
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

  // QA3 round-3 item 7b — effective ₪/h rate, employees only,
  // finance-gated. Value is computed today from user_override →
  // level_rate_history → level_default, and tagged with `rateSource`
  // so we can flag an override so the operator sees WHY the number
  // differs from the level's own rate.
  if (showEffectiveRate && !isPartners) {
    cols.push({
      id: 'effectiveHourlyCost',
      header: 'Rate (₪/h)',
      cell: ({ row }) => {
        const r = (row.original as any).effectiveHourlyCost as number | null | undefined;
        const src = (row.original as any).rateSource as string | null | undefined;
        if (r == null) return <span className="text-slate-300 dark:text-slate-600">—</span>;
        return (
          <span
            className="inline-flex items-center gap-1.5 font-mono text-sm text-slate-800 dark:text-slate-100"
            title={
              src === 'override'
                ? 'Per-employee override — wins over the labor category rate.'
                : src === 'level'
                  ? 'From the labor category rate history.'
                  : 'From the labor category default.'
            }
          >
            ₪{r}/h
            {src === 'override' && (
              <span className="rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
                override
              </span>
            )}
          </span>
        );
      },
    });
  }

  cols.push(
    {
      accessorKey: 'roleName',
      header: 'Access Role',
      // QA3 master-handoff · Part B — enum filter fed by the roles catalog.
      meta: {
        filterOptions: roles.map((r: any) => ({ value: String(r.name ?? ''), label: String(r.name ?? '') })),
      },
      filterFn: (row, _colId, val) => {
        if (!val) return true;
        const name = (row.original as any).roleName ?? '';
        return String(name) === String(val);
      },
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
      // QA3 master-handoff · Part B — Active/Inactive enum filter.
      meta: {
        filterOptions: [
          { value: 'true', label: 'Active' },
          { value: 'false', label: 'Inactive' },
        ],
      },
      filterFn: (row, _colId, val) => {
        if (val === '' || val == null) return true;
        return String(!!(row.original as any).isActive) === String(val);
      },
      cell: ({ row }) => {
        const user = row.original;
        const isActive = !!user.isActive;
        // Fall back to a plain pill when inline toggle isn't wired.
        if (!onChangeActive || !canEdit) {
          return (
            <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-slate-400')}>
              {isActive ? 'Active' : 'Inactive'}
            </span>
          );
        }
        const isSaving = savingUserId === user.id;
        return (
          <button
            type="button"
            role="switch"
            aria-checked={isActive}
            aria-label={`${isActive ? 'Deactivate' : 'Activate'} ${user.firstName} ${user.lastName}`}
            disabled={isSaving}
            onClick={(e) => {
              e.stopPropagation();
              if (isSaving) return;
              onChangeActive(user.id, !isActive);
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium border transition-colors',
              isActive
                ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800 hover:bg-green-200 dark:hover:bg-green-900/50'
                : 'bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-slate-400 border-gray-200 dark:border-slate-700 hover:bg-gray-200 dark:hover:bg-slate-700',
              isSaving && 'opacity-50 cursor-wait',
            )}
            title={isActive ? 'Click to deactivate' : 'Click to activate'}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', isActive ? 'bg-green-500' : 'bg-gray-400')} />
            {isActive ? 'Active' : 'Inactive'}
          </button>
        );
      },
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
      enableColumnFilter: false,
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
          {onCostOverride && (
            <button
              type="button"
              onClick={() => onCostOverride(row.original)}
              className="p-1.5 rounded hover:bg-emerald-50 text-slate-400 dark:text-slate-500 hover:text-emerald-600"
              title="Cost rate override (forward-effective; overrides the level rate globally across projects)"
            >
              <Coins className="h-3.5 w-3.5" />
            </button>
          )}
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
