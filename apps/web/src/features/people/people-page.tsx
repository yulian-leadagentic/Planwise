import { useState, useMemo, useEffect } from 'react';
import { Plus, Users, X, Pencil, KeyRound } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/shared/page-header';
import { FilterBar } from '@/components/shared/filter-bar';
import { DataTable } from '@/components/shared/data-table';
import { UserAvatar } from '@/components/shared/user-avatar';
import { EmptyState } from '@/components/shared/empty-state';
import { useUsers } from '@/hooks/use-users';
import { useFilterStore } from '@/stores/filter.store';
import { useDebounce } from '@/hooks/use-debounce';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import type { UserListItem } from '@/types';
import type { ColumnDef } from '@tanstack/react-table';

function getColumns(
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
        <div className="flex items-center gap-3">
          <UserAvatar firstName={row.original.firstName} lastName={row.original.lastName} avatarUrl={row.original.avatarUrl} size="sm" />
          <div>
            <p className="font-medium">{row.original.firstName} {row.original.lastName}</p>
          </div>
        </div>
      ),
    },
    {
      accessorKey: 'code',
      header: 'Code',
      cell: ({ row }) => (
        <span className="text-xs font-mono text-slate-500">
          {(row.original as any).code ?? '—'}
        </span>
      ),
    },
    {
      accessorKey: 'email',
      header: 'Email',
      cell: ({ row }) => <span className="text-sm text-slate-600">{row.original.email ?? '-'}</span>,
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
              'rounded-md border border-slate-200 bg-white px-2 py-1 text-sm focus:border-blue-400 focus:outline-none',
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
        <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', row.original.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500')}>
          {row.original.isActive ? 'Active' : 'Inactive'}
        </span>
      ),
    },
  );

  if (canEdit) {
    cols.push({
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => onEdit(row.original)}
            className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700"
            title="Edit user details"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onResetPassword(row.original)}
            className="p-1.5 rounded hover:bg-amber-50 text-slate-400 hover:text-amber-600"
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

// `businessPartnerId === ''` means "create a fresh BP" (default); a number
// means link this login to that existing person BP and skip BP creation.
const emptyPerson = {
  // M1.1 — business code. For auto-mode ranges the server allocates;
  // leave blank. For manual/external, the admin enters here.
  code: '',
  email: '',
  password: '',
  firstName: '',
  lastName: '',
  phone: '',
  roleId: '',
  userType: 'employee' as string,
  position: '',
  department: '',
  companyName: '',
  // M4a.4 — employment fields.
  employmentDate: '',
  employmentEndDate: '',
  dailyStandardHours: '',
  // M5a — seniority drives default hourly cost (via SeniorityLevel catalog).
  seniorityLevelId: '' as number | '',
  businessPartnerId: '' as number | '',
  // External Employees only — id of the organization (customer / supplier
  // / etc.) this person works at. Server-side this triggers an
  // employee_of relationship between the new person BP and the org.
  employerOrgId: '' as number | '',
};

export function PeoplePage() {
  const queryClient = useQueryClient();
  const { peopleTab, peopleSearch, setPeopleFilters } = useFilterStore();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ ...emptyPerson });
  // Picker for "Link to existing partner" — opens a searchable list of
  // person BPs without a User account (dedupe path for the create flow).
  const [partnerPickerOpen, setPartnerPickerOpen] = useState(false);
  const [partnerPickerSearch, setPartnerPickerSearch] = useState('');
  // External Employees only — picker that selects the EMPLOYER organization
  // (customer / supplier / etc.) the new person works at. Separate from
  // the person dedupe picker above — the user kept asking "where do I
  // pick the customer this contact is from", and a person picker is the
  // wrong answer.
  const [employerPickerOpen, setEmployerPickerOpen] = useState(false);
  const [employerPickerSearch, setEmployerPickerSearch] = useState('');

  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/roles').then((r) => { const d = r.data.data ?? r.data; return Array.isArray(d) ? d : []; }),
  });

  const { data: departments = [] } = useQuery({
    queryKey: ['admin', 'departments'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/config/departments').then((r) => { const d = r.data?.data ?? r.data; return Array.isArray(d) ? d : []; }),
  });

  const { data: professions = [] } = useQuery({
    queryKey: ['admin', 'professions'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/config/professions').then((r) => { const d = r.data?.data ?? r.data; return Array.isArray(d) ? d : []; }),
  });

  // M5a — seniority catalog for the Employee form's level dropdown.
  const { data: seniorityLevels = [] } = useQuery<any[]>({
    queryKey: ['admin', 'seniority-levels'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/config/seniority-levels').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  // M1.1 — EMPLOYEE entity-kind assignment. Drives the Code field on the
  // create form: auto -> read-only preview, manual/external -> required
  // text input, no assignment -> field hidden (admin can backfill later).
  const { data: entityKinds = [] } = useQuery<any[]>({
    queryKey: ['admin', 'entity-kinds'],
    staleTime: 30 * 1000,
    queryFn: () =>
      client.get('/admin/entity-kinds').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });
  const employeeKind = entityKinds.find((k: any) => k.code === 'EMPLOYEE');
  const employeeRange = employeeKind?.numberRange ?? null;

  // All person-type BPs that don't yet have a User account — these are the
  // candidates the create form can link a fresh login to. Loaded only when
  // the modal is open. Cached for the session.
  const { data: linkableBps = [] } = useQuery<any[]>({
    queryKey: ['business-partners', 'persons-without-user'],
    enabled: showCreate,
    staleTime: 60 * 1000,
    queryFn: () =>
      client
        .get('/business-partners', { params: { partnerType: 'person', perPage: 500 } })
        .then((r) => {
          const raw = r.data?.data ?? r.data;
          const list = Array.isArray(raw) ? raw : (raw?.data ?? []);
          // Hide BPs that already have a login user attached.
          return list.filter((bp: any) => !bp.user);
        }),
  });

  // All organization-type BPs — populates the "Employer organization"
  // picker on the External Employees tab. The picker passes the chosen
  // org id through to /users as employerOrgId; the backend then creates
  // the employee_of relationship automatically.
  const { data: employerOrgs = [] } = useQuery<any[]>({
    queryKey: ['business-partners', 'organizations'],
    enabled: showCreate,
    staleTime: 60 * 1000,
    queryFn: () =>
      client
        .get('/business-partners', { params: { partnerType: 'organization', perPage: 500 } })
        .then((r) => {
          const raw = r.data?.data ?? r.data;
          return Array.isArray(raw) ? raw : (raw?.data ?? []);
        }),
  });

  const createUser = useMutation({
    mutationFn: (data: any) => client.post('/users', data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      notify.success('Person created', { code: 'USER-CREATE-200' });
      setShowCreate(false);
      setForm({ ...emptyPerson });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create person'),
  });

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.email || !form.firstName || !form.lastName || !form.password || !form.roleId) {
      notify.warning('Please fill all required fields', { code: 'USER-CREATE-400' });
      return;
    }
    // M1.1 — Code is required when the EMPLOYEE range is manual/external;
    // server allocates on auto. Block submit if missing.
    if (employeeRange && employeeRange.mode !== 'auto' && !form.code.trim()) {
      notify.warning(`Enter an Employee Code (range "${employeeRange.code}" is ${employeeRange.mode} mode)`, {
        code: 'USER-CREATE-400',
      });
      return;
    }
    const payload: any = {
      ...form,
      roleId: Number(form.roleId),
      userType: peopleTab === 'partners' ? 'partner' : 'employee',
    };
    // M1.1 — Don't send `code` for auto-mode ranges; the server allocates.
    // The DTO rejects a supplied code in auto mode.
    if (!employeeRange || employeeRange.mode === 'auto' || !form.code.trim()) {
      delete payload.code;
    }
    // M5a — coerce empty string to undefined so the int validator passes.
    if (form.seniorityLevelId === '' || form.seniorityLevelId == null) {
      delete payload.seniorityLevelId;
    } else {
      payload.seniorityLevelId = Number(form.seniorityLevelId);
    }
    // Only send businessPartnerId when the user explicitly picked one.
    // Empty string would otherwise be sent as the literal "" — server-side
    // validation would reject it as a non-int.
    if (form.businessPartnerId === '' || form.businessPartnerId == null) {
      delete payload.businessPartnerId;
    } else {
      payload.businessPartnerId = Number(form.businessPartnerId);
    }
    // employerOrgId is only meaningful for External Employees (partners
    // tab). For the regular Employees tab we don't surface the field at
    // all, but defensively coerce empty -> undefined so it's never sent
    // as "" (validator rejects non-int).
    if (form.employerOrgId === '' || form.employerOrgId == null) {
      delete payload.employerOrgId;
    } else {
      payload.employerOrgId = Number(form.employerOrgId);
    }
    createUser.mutate(payload);
  };

  /** Prefill identity fields from the picked BP so the user doesn't retype them. */
  const handleLinkExistingBp = (idStr: string) => {
    if (!idStr) {
      setForm((f) => ({ ...f, businessPartnerId: '' }));
      return;
    }
    const id = Number(idStr);
    const bp = linkableBps.find((b: any) => b.id === id);
    if (!bp) return;
    setForm((f) => ({
      ...f,
      businessPartnerId: id,
      firstName: bp.firstName ?? f.firstName,
      lastName: bp.lastName ?? f.lastName,
      email: bp.email ?? f.email,
      phone: bp.phone ?? bp.mobile ?? f.phone,
      companyName: bp.companyName ?? f.companyName,
    }));
  };
  const debouncedSearch = useDebounce(peopleSearch, 300);
  const { can, isAdmin } = usePermissions();
  const [savingUserId, setSavingUserId] = useState<number | null>(null);
  const [editingUser, setEditingUser] = useState<UserListItem | null>(null);
  const [resettingUser, setResettingUser] = useState<UserListItem | null>(null);

  const updateRole = useMutation({
    mutationFn: ({ userId, roleId }: { userId: number; roleId: number }) =>
      client.patch(`/users/${userId}`, { roleId }).then((r) => r.data),
    onMutate: ({ userId }) => setSavingUserId(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
      notify.success('Role updated', { code: 'USER-ROLE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update role'),
    onSettled: () => setSavingUserId(null),
  });

  const isPartners = peopleTab === 'partners';
  const canEditPeople = isAdmin || can('partners', 'write');
  const columns = useMemo(
    () => getColumns(
      isPartners,
      roles,
      canEditPeople,
      (userId, roleId) => updateRole.mutate({ userId, roleId }),
      (user) => setEditingUser(user),
      (user) => setResettingUser(user),
      savingUserId,
    ),
    [isPartners, roles, canEditPeople, savingUserId],
  );

  const userType = peopleTab === 'employees' ? 'employee' : 'partner';
  const { data, isLoading } = useUsers({
    userType,
    search: debouncedSearch || undefined,
  });

  const users = data?.data ?? [];

  const tabs = [
    { key: 'employees' as const, label: 'Employees' },
    { key: 'partners' as const, label: 'External Employees' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Employees"
        description="Internal staff with login accounts — manage details, roles and access"
        actions={
          <button onClick={() => setShowCreate(true)} className="flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-[13px] font-semibold text-white">
            <Plus className="h-4 w-4" />
            Add Person
          </button>
        }
      />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setPeopleFilters({ peopleTab: tab.key })}
            className={cn(
              'border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              peopleTab === tab.key
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <FilterBar
        search={peopleSearch}
        onSearchChange={(v) => setPeopleFilters({ peopleSearch: v })}
        searchPlaceholder={isPartners ? 'Search external employees...' : 'Search employees...'}
      />

      {!isLoading && users.length === 0 ? (
        <EmptyState
          icon={Users}
          title={isPartners ? 'No external employees found' : 'No employees found'}
          description={`Add your first ${isPartners ? 'external employee' : 'employee'} to get started`}
        />
      ) : (
        <DataTable
          columns={columns}
          data={users}
          isLoading={isLoading}
          renderCard={(user) => (
            <div className="rounded-lg border border-border bg-background p-4 hover:bg-muted/50">
              <div className="flex items-center gap-3">
                <UserAvatar
                  firstName={user.firstName}
                  lastName={user.lastName}
                  avatarUrl={user.avatarUrl}
                  size="md"
                />
                <div className="flex-1 min-w-0">
                  <p className="font-medium">
                    {user.firstName} {user.lastName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {user.position ?? user.companyName ?? user.roleName}
                  </p>
                </div>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs font-medium',
                    user.isActive
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 text-gray-500',
                  )}
                >
                  {user.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
            </div>
          )}
          emptyMessage="No users found"
        />
      )}

      {/* Create Person Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[480px] max-w-[92vw] max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="text-base font-bold text-slate-900">Add {isPartners ? 'External Employee' : 'Employee'}</h2>
              <button onClick={() => setShowCreate(false)} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600">
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleCreateSubmit} className="p-5 space-y-4">
              {/* External Employees only: Employer Organization picker.
                  The form intent on this tab is "this person works at
                  one of our customer/supplier orgs" so the org IS the
                  primary context — not a dedupe path. On submit the
                  backend creates the employee_of relationship between
                  the new person BP and the chosen org automatically
                  (see UsersService.create #3). */}
              {isPartners && (
                <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3">
                  <label className="text-[12px] font-semibold text-slate-700 mb-1 block">
                    Employer Organization <span className="text-slate-400 font-normal">(customer / supplier they work at)</span>
                  </label>
                  {form.employerOrgId === '' ? (
                    <button
                      type="button"
                      onClick={() => { setEmployerPickerSearch(''); setEmployerPickerOpen(true); }}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-left text-slate-500 hover:border-blue-400 focus:border-blue-500 focus:outline-none"
                    >
                      — Pick an organization — <span className="text-blue-600 underline ml-1">browse list</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => { setEmployerPickerSearch(''); setEmployerPickerOpen(true); }}
                        className="flex-1 px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-left text-slate-700 hover:border-blue-400"
                      >
                        {(() => {
                          const org = employerOrgs.find((o: any) => o.id === form.employerOrgId);
                          if (!org) return `Organization #${form.employerOrgId}`;
                          const tail = org.mainRoleType?.name ? ` · ${org.mainRoleType.name}` : '';
                          return `${org.displayName}${tail}`;
                        })()}
                      </button>
                      <button
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, employerOrgId: '' }))}
                        className="px-2 py-2 rounded-lg border border-slate-200 bg-white text-xs text-slate-500 hover:text-slate-700"
                        title="Clear"
                      >
                        Clear
                      </button>
                    </div>
                  )}
                  <p className="mt-1 text-[11px] text-slate-500">
                    Wires up an <code>employee_of</code> relationship — defines what context this contact works in.
                  </p>
                </div>
              )}

              {/* Optional: link this login to an existing person BP. When a
                  partner is picked, the identity fields below are prefilled
                  so the user doesn't retype anything. Defaults to "Create
                  new" — same behaviour as before. Only person BPs that
                  don't already have a user account are shown.
                  This is a DEDUPE path — separate from the Employer org
                  picker above (which is about org context, not identity). */}
              <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
                <label className="text-[12px] font-semibold text-slate-700 mb-1 block">Link to existing person record <span className="text-slate-400 font-normal">(optional — avoids duplicates)</span></label>
                {form.businessPartnerId === '' ? (
                  <button
                    type="button"
                    onClick={() => { setPartnerPickerSearch(''); setPartnerPickerOpen(true); }}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-left text-slate-500 hover:border-blue-400 focus:border-blue-500 focus:outline-none"
                  >
                    — Create a new partner record — <span className="text-blue-600 underline ml-1">pick from list</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { setPartnerPickerSearch(''); setPartnerPickerOpen(true); }}
                      className="flex-1 px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-left text-slate-700 hover:border-blue-400"
                    >
                      {(() => {
                        const bp = linkableBps.find((b: any) => b.id === form.businessPartnerId);
                        if (!bp) return `Partner #${form.businessPartnerId}`;
                        const tail = bp.email ? ` · ${bp.email}` : bp.companyName ? ` · ${bp.companyName}` : '';
                        return `${bp.displayName}${tail}`;
                      })()}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleLinkExistingBp('')}
                      className="px-2 py-2 rounded-lg border border-slate-200 bg-white text-xs text-slate-500 hover:text-slate-700"
                      title="Clear link"
                    >
                      Clear
                    </button>
                  </div>
                )}
                <p className="mt-1 text-[11px] text-slate-500">
                  Pick someone already in <strong>Partners → Contacts</strong> to give them
                  app access without duplicating the contact record.
                </p>
              </div>

              {/* M1.1 — Code field driven by EMPLOYEE entity-kind assignment.
                  auto  : read-only preview of the next code (system allocates on save).
                  manual / external : input the admin fills in.
                  no range bound: hidden — admins wire one up in /admin/object-numbering. */}
              {employeeRange && (
                <div>
                  <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block" title={`From range ${employeeRange.code} (${employeeRange.mode} mode)`}>
                    Employee Code
                    {employeeRange.mode !== 'auto' && <span className="text-red-500"> *</span>}
                    <span className="ml-2 text-[10px] font-normal text-slate-400">
                      {employeeRange.mode === 'auto'
                        ? `auto from range ${employeeRange.code}`
                        : employeeRange.mode === 'manual'
                          ? `you type it — range ${employeeRange.code}`
                          : `external — range ${employeeRange.code}${employeeRange.externalPattern ? ` (pattern: ${employeeRange.externalPattern})` : ''}`}
                    </span>
                  </label>
                  {employeeRange.mode === 'auto' ? (
                    <input
                      value={employeeRange.preview ?? ''}
                      disabled
                      placeholder="(allocated on save)"
                      className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm font-mono text-slate-500 cursor-not-allowed"
                    />
                  ) : (
                    <input
                      value={form.code}
                      onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                      placeholder={employeeRange.prefix ? `e.g. ${employeeRange.prefix}…` : 'Enter the code'}
                      className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm font-mono text-slate-700 focus:border-blue-500 focus:outline-none"
                    />
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">First Name *</label>
                  <input value={form.firstName} onChange={(e) => setForm(f => ({ ...f, firstName: e.target.value }))} className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                  <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Last Name *</label>
                  <input value={form.lastName} onChange={(e) => setForm(f => ({ ...f, lastName: e.target.value }))} className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
                </div>
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block" title="Email is the unique identifier for every person — used for login and as the dedupe key.">
                  Email <span className="text-red-500">*</span>
                  <span className="ml-2 text-[10px] font-normal text-slate-400">(unique — login & identifier)</span>
                </label>
                <input type="email" value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))} className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Password *</label>
                <input type="password" value={form.password} onChange={(e) => setForm(f => ({ ...f, password: e.target.value }))} className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block" title="Determines what the user can see and edit — separate from job title.">
                    Authorization Role <span className="text-red-500">*</span>
                  </label>
                  <select value={form.roleId} onChange={(e) => setForm(f => ({ ...f, roleId: e.target.value }))} className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none">
                    <option value="">Select role</option>
                    {roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Telephone</label>
                  <input value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block" title="What this person does by trade. Manage the list in /templates/types → Job Titles.">
                    Job Title
                  </label>
                  <select value={form.position} onChange={(e) => setForm(f => ({ ...f, position: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none">
                    <option value="">Select job title</option>
                    {professions.map((p: any) => <option key={p.id} value={p.name}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Department</label>
                  <select value={form.department} onChange={(e) => setForm(f => ({ ...f, department: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none">
                    <option value="">Select department</option>
                    {departments.map((d: any) => <option key={d.id} value={d.name}>{d.name}</option>)}
                  </select>
                </div>
              </div>
              {/* M5a — Seniority Level (drives default hourly cost). */}
              <div>
                <label
                  className="text-[13px] font-semibold text-slate-700 mb-1.5 block"
                  title="Determines the employee's default hourly cost for project labor calculations. Manage the catalog at /admin/seniority-levels."
                >
                  Seniority Level
                  {(() => {
                    const sel = seniorityLevels.find((s: any) => String(s.id) === String(form.seniorityLevelId));
                    return sel && sel.defaultHourlyCost != null ? (
                      <span className="ml-2 text-[11px] font-normal text-slate-500">
                        → {sel.defaultHourlyCost}{sel.currency ? ` ${sel.currency}` : ''}/h
                      </span>
                    ) : null;
                  })()}
                </label>
                <select
                  value={form.seniorityLevelId}
                  onChange={(e) => setForm((f) => ({ ...f, seniorityLevelId: e.target.value === '' ? '' : Number(e.target.value) }))}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
                >
                  <option value="">— Pick a seniority level —</option>
                  {seniorityLevels.map((s: any) => (
                    <option key={s.id} value={s.id}>
                      {s.name}{s.defaultHourlyCost != null ? ` — ${s.defaultHourlyCost}${s.currency ? ` ${s.currency}` : ''}/h` : ''}
                    </option>
                  ))}
                </select>
                {seniorityLevels.length === 0 && (
                  <p className="text-[11px] text-amber-700 mt-1">
                    No seniority levels defined yet. Add some in <a className="text-blue-600 hover:underline" href="/admin/seniority-levels" target="_blank" rel="noreferrer">/admin/seniority-levels</a>.
                  </p>
                )}
              </div>

              {/* M4a.4 — Employment fields */}
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Start date</label>
                  <input
                    type="date"
                    value={form.employmentDate}
                    onChange={(e) => setForm((f) => ({ ...f, employmentDate: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">End date</label>
                  <input
                    type="date"
                    value={form.employmentEndDate}
                    onChange={(e) => setForm((f) => ({ ...f, employmentEndDate: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block" title="Standard daily hours used for cost & utilisation calculations.">
                    Daily standard hours
                  </label>
                  <input
                    type="number"
                    step="0.25"
                    min="0"
                    max="24"
                    value={form.dailyStandardHours}
                    onChange={(e) => setForm((f) => ({ ...f, dailyStandardHours: e.target.value }))}
                    placeholder="e.g. 8"
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>
              {peopleTab === 'partners' && (
                <div>
                  <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Company Name</label>
                  <input value={form.companyName} onChange={(e) => setForm(f => ({ ...f, companyName: e.target.value }))} className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button type="button" onClick={() => setShowCreate(false)} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
                <button type="submit" disabled={createUser.isPending} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
                  {createUser.isPending ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Partner picker — opens from the "Link to existing partner" button
          in the create modal. Stacked above the create modal (z-60) so
          clicks here don't dismiss the form behind it. */}
      {partnerPickerOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/35 backdrop-blur-sm"
          onClick={() => setPartnerPickerOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-[520px] max-w-[92vw] max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="text-base font-bold text-slate-900">Select a partner</h2>
              <button
                type="button"
                onClick={() => setPartnerPickerOpen(false)}
                className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 border-b border-slate-100">
              <input
                autoFocus
                value={partnerPickerSearch}
                onChange={(e) => setPartnerPickerSearch(e.target.value)}
                placeholder="Search by name, email, or company..."
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
              />
              <p className="mt-1.5 text-[11px] text-slate-500">
                Only contacts without an existing login are shown.
              </p>
            </div>
            <div className="flex-1 overflow-y-auto">
              {(() => {
                const q = partnerPickerSearch.trim().toLowerCase();
                const filtered = q
                  ? linkableBps.filter((bp: any) => {
                      const haystack = `${bp.displayName ?? ''} ${bp.email ?? ''} ${bp.companyName ?? ''}`.toLowerCase();
                      return haystack.includes(q);
                    })
                  : linkableBps;
                if (filtered.length === 0) {
                  return (
                    <p className="px-5 py-6 text-center text-sm text-slate-500">
                      {linkableBps.length === 0
                        ? 'No linkable partners — every person already has a login.'
                        : 'No matches for that search.'}
                    </p>
                  );
                }
                return (
                  <ul className="divide-y divide-slate-100">
                    {filtered.map((bp: any) => (
                      <li key={bp.id}>
                        <button
                          type="button"
                          onClick={() => {
                            handleLinkExistingBp(String(bp.id));
                            setPartnerPickerOpen(false);
                          }}
                          className="w-full text-left px-5 py-3 hover:bg-slate-50"
                        >
                          <p className="text-sm font-medium text-slate-900">{bp.displayName}</p>
                          <p className="text-xs text-slate-500">
                            {bp.email ?? '—'}
                            {bp.companyName ? ` · ${bp.companyName}` : ''}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Employer organization picker — opens from "Employer Organization"
          on the External Employees form. Lists ALL organization-type BPs
          (customers, suppliers, subcontractors, etc.) so admins can pick
          which org the new contact works at. Searchable; same stacking
          rules as the person picker above (z-60 over the create modal). */}
      {employerPickerOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/35 backdrop-blur-sm"
          onClick={() => setEmployerPickerOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-[520px] max-w-[92vw] max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="text-base font-bold text-slate-900">Select an organization</h2>
              <button
                type="button"
                onClick={() => setEmployerPickerOpen(false)}
                className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 border-b border-slate-100">
              <input
                autoFocus
                value={employerPickerSearch}
                onChange={(e) => setEmployerPickerSearch(e.target.value)}
                placeholder="Search by name, tax ID, or email..."
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
              />
              <p className="mt-1.5 text-[11px] text-slate-500">
                Customers, suppliers, subcontractors — every organization in the system.
              </p>
            </div>
            <div className="flex-1 overflow-y-auto">
              {(() => {
                const q = employerPickerSearch.trim().toLowerCase();
                const filtered = q
                  ? employerOrgs.filter((o: any) => {
                      const haystack = `${o.displayName ?? ''} ${o.taxId ?? ''} ${o.email ?? ''} ${o.companyName ?? ''}`.toLowerCase();
                      return haystack.includes(q);
                    })
                  : employerOrgs;
                if (filtered.length === 0) {
                  return (
                    <p className="px-5 py-6 text-center text-sm text-slate-500">
                      {employerOrgs.length === 0
                        ? 'No organizations yet — add one from Partners → Organizations first.'
                        : 'No matches for that search.'}
                    </p>
                  );
                }
                return (
                  <ul className="divide-y divide-slate-100">
                    {filtered.map((org: any) => (
                      <li key={org.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setForm((f) => ({ ...f, employerOrgId: org.id }));
                            setEmployerPickerOpen(false);
                          }}
                          className="w-full text-left px-5 py-3 hover:bg-slate-50"
                        >
                          <p className="text-sm font-medium text-slate-900">{org.displayName}</p>
                          <p className="text-xs text-slate-500">
                            {org.mainRoleType?.name ?? 'No main role'}
                            {org.taxId ? ` · Tax ID: ${org.taxId}` : ''}
                            {org.email ? ` · ${org.email}` : ''}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {editingUser && (
        <EditPersonModal
          user={editingUser}
          roles={roles}
          departments={departments}
          professions={professions}
          seniorityLevels={seniorityLevels}
          onClose={() => setEditingUser(null)}
        />
      )}

      {resettingUser && (
        <ResetPasswordModal
          user={resettingUser}
          onClose={() => setResettingUser(null)}
        />
      )}
    </div>
  );
}

const inputClass = 'w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none';

function EditPersonModal({
  user,
  roles,
  departments,
  professions,
  seniorityLevels,
  onClose,
}: {
  user: UserListItem;
  roles: any[];
  departments: any[];
  professions: any[];
  seniorityLevels: any[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const isPartner = user.userType === 'partner';
  // M4a.4 — toDateInput slices ISO to YYYY-MM-DD so <input type=date> accepts it.
  const toDateInput = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : '');
  const [form, setForm] = useState({
    email: user.email ?? '',
    firstName: user.firstName ?? '',
    lastName: user.lastName ?? '',
    phone: (user as any).phone ?? '',
    roleId: String((user as any).roleId ?? ''),
    position: user.position ?? '',
    department: user.department ?? '',
    companyName: user.companyName ?? '',
    // Employment fields — applicable to employees primarily. Surfaced on
    // partners too because the same person may later become an employee
    // (the model is a single User record; the userType flag just
    // categorises them on this list).
    employmentDate: toDateInput((user as any).employmentDate),
    employmentEndDate: toDateInput((user as any).employmentEndDate),
    dailyStandardHours:
      (user as any).dailyStandardHours != null ? String((user as any).dailyStandardHours) : '',
    seniorityLevelId: ((user as any).seniorityLevelId ?? '') as number | '',
    isActive: user.isActive,
  });

  // Lock background scroll while open
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  const update = useMutation({
    mutationFn: (payload: any) => client.patch(`/users/${user.id}`, payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
      notify.success('Person updated', { code: 'USER-UPDATE-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update person'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.email || !form.firstName || !form.lastName || !form.roleId) {
      notify.warning('Please fill all required fields', { code: 'USER-UPDATE-400' });
      return;
    }
    update.mutate({
      email: form.email,
      firstName: form.firstName,
      lastName: form.lastName,
      phone: form.phone || undefined,
      roleId: Number(form.roleId),
      position: form.position || undefined,
      department: form.department || undefined,
      companyName: form.companyName || undefined,
      employmentDate: form.employmentDate || undefined,
      employmentEndDate: form.employmentEndDate || undefined,
      dailyStandardHours: form.dailyStandardHours ? Number(form.dailyStandardHours) : undefined,
      seniorityLevelId:
        form.seniorityLevelId === '' || form.seniorityLevelId == null
          ? null
          : Number(form.seniorityLevelId),
      isActive: form.isActive,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[480px] max-w-[92vw] max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="text-base font-bold text-slate-900">Edit {isPartner ? 'Partner' : 'Employee'}</h2>
          <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">First Name *</label>
              <input value={form.firstName} onChange={(e) => setForm(f => ({ ...f, firstName: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Last Name *</label>
              <input value={form.lastName} onChange={(e) => setForm(f => ({ ...f, lastName: e.target.value }))} className={inputClass} />
            </div>
          </div>
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block" title="Email is the unique identifier for every person — used for login and as the dedupe key on imports.">
              Email <span className="text-red-500">*</span>
              <span className="ml-2 text-[10px] font-normal text-slate-400">(unique — login & identifier)</span>
            </label>
            <input type="email" value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))} className={inputClass} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block" title="Determines what the user can see and edit — separate from job title / profession.">
                Authorization Role <span className="text-red-500">*</span>
              </label>
              <select value={form.roleId} onChange={(e) => setForm(f => ({ ...f, roleId: e.target.value }))} className={inputClass}>
                <option value="">Select role</option>
                {roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Telephone</label>
              <input value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} className={inputClass} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block" title="What this person does by trade. Manage the list in /templates/types → Job Titles.">
                Job Title
              </label>
              <select value={form.position} onChange={(e) => setForm(f => ({ ...f, position: e.target.value }))} className={inputClass}>
                <option value="">Select job title</option>
                {professions.map((p: any) => <option key={p.id} value={p.name}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Department</label>
              <select value={form.department} onChange={(e) => setForm(f => ({ ...f, department: e.target.value }))} className={inputClass}>
                <option value="">Select department</option>
                {departments.map((d: any) => <option key={d.id} value={d.name}>{d.name}</option>)}
              </select>
            </div>
          </div>
          {/* M5a — Seniority Level */}
          <div>
            <label
              className="text-[13px] font-semibold text-slate-700 mb-1.5 block"
              title="Determines the employee's default hourly cost for project labor calculations. Manage the catalog at /admin/seniority-levels."
            >
              Seniority Level
              {(() => {
                const sel = seniorityLevels.find((s: any) => String(s.id) === String(form.seniorityLevelId));
                return sel && sel.defaultHourlyCost != null ? (
                  <span className="ml-2 text-[11px] font-normal text-slate-500">
                    → {sel.defaultHourlyCost}{sel.currency ? ` ${sel.currency}` : ''}/h
                  </span>
                ) : null;
              })()}
            </label>
            <select
              value={form.seniorityLevelId}
              onChange={(e) => setForm((f) => ({ ...f, seniorityLevelId: e.target.value === '' ? '' : Number(e.target.value) }))}
              className={inputClass}
            >
              <option value="">— Pick a seniority level —</option>
              {seniorityLevels.map((s: any) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.defaultHourlyCost != null ? ` — ${s.defaultHourlyCost}${s.currency ? ` ${s.currency}` : ''}/h` : ''}
                </option>
              ))}
            </select>
          </div>
          {/* M4a.4 — Employment fields */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Start date</label>
              <input
                type="date"
                value={form.employmentDate}
                onChange={(e) => setForm((f) => ({ ...f, employmentDate: e.target.value }))}
                className={inputClass}
              />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">End date</label>
              <input
                type="date"
                value={form.employmentEndDate}
                onChange={(e) => setForm((f) => ({ ...f, employmentEndDate: e.target.value }))}
                className={inputClass}
              />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block" title="Standard daily hours used for cost & utilisation calculations.">
                Daily standard hours
              </label>
              <input
                type="number"
                step="0.25"
                min="0"
                max="24"
                value={form.dailyStandardHours}
                onChange={(e) => setForm((f) => ({ ...f, dailyStandardHours: e.target.value }))}
                placeholder="e.g. 8"
                className={inputClass}
              />
            </div>
          </div>
          {isPartner && (
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Company Name</label>
              <input value={form.companyName} onChange={(e) => setForm(f => ({ ...f, companyName: e.target.value }))} className={inputClass} />
            </div>
          )}
          <label className="flex items-center gap-2 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm(f => ({ ...f, isActive: e.target.checked }))}
              className="h-4 w-4 rounded border-slate-300 text-blue-600"
            />
            <span className="text-sm text-slate-700">Active</span>
          </label>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
            <button type="submit" disabled={update.isPending} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
              {update.isPending ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ResetPasswordModal({
  user,
  onClose,
}: {
  user: UserListItem;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  const reset = useMutation({
    mutationFn: () => client.patch(`/users/${user.id}`, { password }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      notify.success(`Password reset for ${user.firstName} ${user.lastName}`, { code: 'USER-PWD-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to reset password'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) {
      notify.warning('Password must be at least 6 characters', { code: 'USER-PWD-400' });
      return;
    }
    if (password !== confirm) {
      notify.warning('Passwords do not match', { code: 'USER-PWD-400' });
      return;
    }
    reset.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[420px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="text-base font-bold text-slate-900">Reset Password</h2>
          <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <p className="text-[13px] text-slate-600">
            Set a new password for <span className="font-semibold text-slate-900">{user.firstName} {user.lastName}</span>.
            They'll need to use this password on their next login.
          </p>
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">New Password *</label>
            <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} className={inputClass} />
          </div>
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Confirm Password *</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={6} className={inputClass} />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
            <button type="submit" disabled={reset.isPending} className="bg-amber-600 hover:bg-amber-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
              {reset.isPending ? 'Resetting...' : 'Reset Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
