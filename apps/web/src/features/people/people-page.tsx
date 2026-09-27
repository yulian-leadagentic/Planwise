import { useState, useMemo } from 'react';
import { Plus, Users, X } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/shared/page-header';
import { FilterBar } from '@/components/shared/filter-bar';
import { DataTable } from '@/components/shared/data-table';
import { UserAvatar } from '@/components/shared/user-avatar';
import { EmptyState } from '@/components/shared/empty-state';
import { Tabs, tabPanelId, tabTriggerId } from '@/components/shared/tabs';
import { TextField, SelectField } from '@/components/shared/field';
import { useUsers } from '@/hooks/use-users';
import { useFilterStore } from '@/stores/filter.store';
import { useDebounce } from '@/hooks/use-debounce';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import type { UserListItem } from '@/types';
import { getColumns } from './people-page/get-columns';
import { emptyPerson } from './people-page/constants';
import { EditPersonModal } from './people-page/edit-person-modal';
import { ResetPasswordModal } from './people-page/reset-password-modal';
import { UserRateModal } from './people-page/user-rate-modal';
import { useConfirm } from '@/components/shared/confirm-dialog';

/**
 * People UX M5 — validation rules for create-employee/external-user.
 *
 * Kept module-scope so the same rules cover employer picker page + form
 * without prop-drilling. Password rule tightened to ≥6 chars per the
 * work order; email must at minimum parse as user@host.tld.
 */
type CreatePersonErrors = Partial<Record<
  'firstName' | 'lastName' | 'email' | 'password' | 'roleId' | 'code',
  string
>>;
function validateCreatePerson(form: {
  firstName: string; lastName: string; email: string; password: string; roleId: string; code: string;
}, opts: { needsCode: boolean; codeMode: 'auto' | 'manual' | 'external' | null; rangeCode?: string }): CreatePersonErrors {
  const errs: CreatePersonErrors = {};
  if (!form.firstName.trim()) errs.firstName = 'First name is required.';
  if (!form.lastName.trim()) errs.lastName = 'Last name is required.';
  if (!form.email.trim()) errs.email = 'Email is required.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errs.email = 'Enter a valid email address.';
  if (!form.password) errs.password = 'Password is required.';
  else if (form.password.length < 6) errs.password = 'Password must be at least 6 characters.';
  if (!form.roleId) errs.roleId = 'Access Role is required.';
  if (opts.needsCode && !form.code.trim()) {
    errs.code = `Employee Code is required (range "${opts.rangeCode ?? ''}" is ${opts.codeMode} mode).`;
  }
  return errs;
}

export function PeoplePage() {
  const queryClient = useQueryClient();
  const { peopleTab, peopleSearch, peopleStatus, setPeopleFilters } = useFilterStore();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ ...emptyPerson });
  // People UX M5 — inline errors keyed by form field. Cleared on the
  // next change to that field so the message doesn't linger past the
  // user's fix.
  const [createErrors, setCreateErrors] = useState<CreatePersonErrors>({});
  const patchCreate = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setCreateErrors((prev) => (k in prev ? { ...prev, [k]: undefined } : prev));
  };
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
    // People UX M5 — inline per-field validation. Blocks submit and
    // renders red text under each offending Field. No generic toast.
    const errs = validateCreatePerson(form, {
      needsCode: !!(employeeRange && employeeRange.mode !== 'auto'),
      codeMode: employeeRange?.mode ?? null,
      rangeCode: employeeRange?.code,
    });
    setCreateErrors(errs);
    if (Object.keys(errs).length > 0) return;
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
  const confirm = useConfirm();
  const [savingUserId, setSavingUserId] = useState<number | null>(null);
  const [editingUser, setEditingUser] = useState<UserListItem | null>(null);
  const [resettingUser, setResettingUser] = useState<UserListItem | null>(null);
  // QA3 item 1 — cost-rate override modal targets one user at a time.
  const [overrideUser, setOverrideUser] = useState<UserListItem | null>(null);

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

  // QA3 round-2 item 4 (EMP-INLINE) — extend the inline-edit pattern
  // from the Role cell to Department / Seniority / Active. Each fires a
  // single-field PATCH /users/:id (partial update supported by
  // UpdateUserDto) and reuses `savingUserId` for the "row locked" hint.
  const updateDepartment = useMutation({
    mutationFn: ({ userId, department }: { userId: number; department: string | null }) =>
      client.patch(`/users/${userId}`, { department }).then((r) => r.data),
    onMutate: ({ userId }) => setSavingUserId(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      notify.success('Department updated', { code: 'USER-DEPARTMENT-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update department'),
    onSettled: () => setSavingUserId(null),
  });

  const updateSeniority = useMutation({
    mutationFn: ({ userId, seniorityLevelId }: { userId: number; seniorityLevelId: number | null }) =>
      client.patch(`/users/${userId}`, { seniorityLevelId }).then((r) => r.data),
    onMutate: ({ userId }) => setSavingUserId(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      // Seniority feeds cost — nudge project surfaces that show actuals.
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      notify.success('Seniority updated', { code: 'USER-SENIORITY-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update seniority'),
    onSettled: () => setSavingUserId(null),
  });

  const updateActive = useMutation({
    mutationFn: ({ userId, isActive }: { userId: number; isActive: boolean }) =>
      client.patch(`/users/${userId}`, { isActive }).then((r) => r.data),
    onMutate: ({ userId }) => setSavingUserId(userId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      notify.success(variables.isActive ? 'User activated' : 'User deactivated', {
        code: variables.isActive ? 'USER-ACTIVATE-200' : 'USER-DEACTIVATE-200',
      });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update active status'),
    onSettled: () => setSavingUserId(null),
  });

  const isPartners = peopleTab === 'partners';
  // The edit/reset-password buttons used to be gated on a non-existent
  // "partners" module permission, which made them invisible to every
  // role. Even after correcting to "people", non-admin roles still
  // couldn't see them. Since the "Add Person" button at the top of this
  // very page has NO permission gate at all, gating the row actions is
  // inconsistent — the backend is the authority anyway and will reject
  // an unauthorized PATCH. So we always show the row actions and let
  // the server decide. (T-fix, 2026-06-29.)
  void isAdmin; void can; // permissions hook retained for future use
  const canEditPeople = true;
  // QA3 round-3 item 7b — finance gate for the effective ₪/h column.
  // Non-finance users don't see the rate at all (column hidden).
  const showEffectiveRate = can('finance', 'read');
  // People UX U2 — confirm any Access Role change that either raises the
  // target to an admin-level role or lowers it from one. The heuristic
  // "role name contains 'Admin'" covers the seeded Admin / HR Admin
  // roles today; other roles bypass the confirm to keep the inline
  // change fast. If we ever add a `level` or `isAdmin` flag to the
  // roles table this predicate is where to swap it in.
  const isAdminLevelRole = (roleName: string | undefined | null): boolean => {
    if (!roleName) return false;
    return /admin/i.test(String(roleName));
  };

  // Hoisted above the columns memo so the deactivate/role-change
  // confirms can resolve the person by id from the current page.
  const userType = peopleTab === 'employees' ? 'employee' : 'partner';
  const isActiveParam: boolean | 'all' | undefined =
    peopleStatus === 'active' ? true
    : peopleStatus === 'inactive' ? false
    : 'all';
  const { data, isLoading } = useUsers({
    userType,
    search: debouncedSearch || undefined,
    isActive: isActiveParam,
  });
  const users = data?.data ?? [];

  const columns = useMemo(
    () => getColumns(
      isPartners,
      roles,
      canEditPeople,
      // People UX U2 — confirm when moving to (or away from) an
      // admin-level role. Cancel leaves the select on its previous value
      // because we only fire the mutation on OK.
      async (userId, roleId) => {
        const user = users.find((u: any) => u.id === userId) as any;
        const nextRole = roles.find((r: any) => r.id === roleId);
        const currentRoleName = user?.roleName ?? null;
        const nextRoleName = nextRole?.name ?? null;
        const raising = isAdminLevelRole(nextRoleName);
        const lowering = isAdminLevelRole(currentRoleName) && !raising;
        if (raising || lowering) {
          const who = user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() : 'this user';
          const ok = await confirm(
            raising
              ? `Grant ${nextRoleName} access to ${who}? They will gain elevated permissions across the workspace.`
              : `Change ${who} from ${currentRoleName} to ${nextRoleName}? They will lose elevated access.`,
            {
              title: raising ? 'Grant admin-level access?' : 'Lower access level?',
              variant: 'danger',
              confirmLabel: raising ? 'Grant access' : 'Change role',
            },
          );
          if (!ok) return;
        }
        updateRole.mutate({ userId, roleId });
      },
      (user) => setEditingUser(user),
      (user) => setResettingUser(user),
      savingUserId,
      // Employees only — external partners don't carry cost overrides today.
      isPartners ? undefined : (user) => setOverrideUser(user),
      // QA3 round-2 item 4 — inline cells for Department / Seniority / Active.
      // Only wire them on the Employees tab; external partners have no
      // seniority or department concept today.
      isPartners ? [] : departments,
      isPartners ? [] : seniorityLevels,
      isPartners
        ? undefined
        : (userId: number, department: string | null) => updateDepartment.mutate({ userId, department }),
      isPartners
        ? undefined
        : (userId: number, seniorityLevelId: number | null) => updateSeniority.mutate({ userId, seniorityLevelId }),
      // People UX U2 — deactivate is destructive (blocks login), so it
      // pops a red danger confirm naming the person. Reactivate has no
      // destructive effect and stays a one-click toggle.
      isPartners
        ? undefined
        : async (userId: number, isActive: boolean) => {
            if (!isActive) {
              const user = users.find((u: any) => u.id === userId) as any;
              const who = user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() : 'this user';
              const ok = await confirm(
                `${who} will no longer be able to log in. Their history stays intact and they can be reactivated any time.`,
                {
                  title: `Deactivate ${who}?`,
                  variant: 'danger',
                  confirmLabel: 'Deactivate',
                },
              );
              if (!ok) return;
            }
            updateActive.mutate({ userId, isActive });
          },
      // QA3 round-3 item 7b — finance-gated ₪/h column.
      showEffectiveRate,
    ),
    [isPartners, roles, canEditPeople, savingUserId, departments, seniorityLevels, showEffectiveRate, users, confirm],
  );

  // Status filter: this is the ONLY page in the app that legitimately
  // needs to see deactivated users (so admins can reactivate them).
  // 'active' (default) → backend default kicks in (only active).
  // 'inactive' → only inactive. 'all' → both, via the `all` sentinel.
  // (userType / isActiveParam / useUsers hoisted above the columns memo
  // for the U2 confirm callbacks to resolve the person by id.)

  // People UX M5 (E-27) — tab items are consumed by the shared Tabs
  // component below, which renders role=tab / aria-selected / arrow-key
  // navigation, and mirrors the active tab to `?tab=` in the URL.
  const tabItems = [
    { value: 'employees' as const, label: 'Employees' },
    { value: 'partners' as const, label: 'External Users' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Employees"
        description="Employees with login accounts — manage details, roles and access"
        actions={
          <button onClick={() => setShowCreate(true)} className="flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-[13px] font-semibold text-white">
            <Plus className="h-4 w-4" />
            Add Person
          </button>
        }
      />

      {/* Tabs — People UX M5 (E-27). Renders role=tablist/tab, aria-selected,
          arrow-key navigation, and keeps the active tab in `?tab=`. */}
      <Tabs
        idBase="people"
        ariaLabel="People views"
        value={peopleTab}
        onChange={(v) => setPeopleFilters({ peopleTab: v })}
        items={tabItems}
      />

      <FilterBar
        search={peopleSearch}
        onSearchChange={(v) => setPeopleFilters({ peopleSearch: v })}
        searchPlaceholder={isPartners ? 'Search external users...' : 'Search employees...'}
      />

      {/* Status filter — defaults to Active. The whole rest of the app
       *  relies on the backend's active-only default; this page is the
       *  one exception (admins need to find deactivated users to
       *  reactivate or delete them). */}
      <div className="flex items-center gap-1.5" role="group" aria-label="Filter by status">
        {(['active', 'inactive', 'all'] as const).map((status) => {
          const pressed = peopleStatus === status;
          return (
            <button
              key={status}
              type="button"
              aria-pressed={pressed}
              onClick={() => setPeopleFilters({ peopleStatus: status })}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                pressed
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-border bg-background text-muted-foreground hover:bg-muted/50',
              )}
            >
              {status === 'active' ? 'Active' : status === 'inactive' ? 'Inactive' : 'All'}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={tabPanelId('people', peopleTab)}
        aria-labelledby={tabTriggerId('people', peopleTab)}
      >
      {!isLoading && users.length === 0 ? (
        <EmptyState
          icon={Users}
          title={isPartners ? 'No external users found' : 'No employees found'}
          description={`Add your first ${isPartners ? 'external user' : 'employee'} to get started`}
        />
      ) : (
        <DataTable
          columns={columns}
          data={users}
          isLoading={isLoading}
          enableColumnFilters

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
                      : 'bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-slate-400',
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
      </div>

      {/* Create Person Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={() => setShowCreate(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[480px] max-w-[92vw] max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Add {isPartners ? 'External User' : 'Employee'}</h2>
              <button onClick={() => setShowCreate(false)} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200">
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
                  {/* Not <label> — the following control is a <button> that
                      opens the picker modal, not a form input. Labels
                      without htmlFor trip axe's label rule. */}
                  <div className="text-[12px] font-semibold text-slate-700 dark:text-slate-200 mb-1 block">
                    Employer Organization <span className="text-slate-400 dark:text-slate-500 font-normal">(customer / supplier they work at)</span>
                  </div>
                  {form.employerOrgId === '' ? (
                    <button
                      type="button"
                      onClick={() => { setEmployerPickerSearch(''); setEmployerPickerOpen(true); }}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-left text-slate-500 dark:text-slate-400 hover:border-blue-400 focus:border-blue-500 focus:outline-none"
                    >
                      — Pick an organization — <span className="text-blue-600 underline ml-1">browse list</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => { setEmployerPickerSearch(''); setEmployerPickerOpen(true); }}
                        className="flex-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-left text-slate-700 dark:text-slate-200 hover:border-blue-400"
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
                        className="px-2 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100"
                        title="Clear"
                      >
                        Clear
                      </button>
                    </div>
                  )}
                  <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                    Links this contact to their employer organization — defines what context they work in.
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
              <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 p-3">
                {/* Non-<label> heading — the following control is a picker
                    button, not a form input; keeps axe happy. */}
                <div className="text-[12px] font-semibold text-slate-700 dark:text-slate-200 mb-1 block">
                  Link to existing person record <span className="text-slate-400 dark:text-slate-500 font-normal">(optional — avoids duplicates)</span>
                </div>
                {form.businessPartnerId === '' ? (
                  <button
                    type="button"
                    onClick={() => { setPartnerPickerSearch(''); setPartnerPickerOpen(true); }}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-left text-slate-500 dark:text-slate-400 hover:border-blue-400 focus:border-blue-500 focus:outline-none"
                  >
                    — Create a new contact record — <span className="text-blue-600 underline ml-1">pick from list</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { setPartnerPickerSearch(''); setPartnerPickerOpen(true); }}
                      className="flex-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-left text-slate-700 dark:text-slate-200 hover:border-blue-400"
                    >
                      {(() => {
                        const bp = linkableBps.find((b: any) => b.id === form.businessPartnerId);
                        if (!bp) return `Contact #${form.businessPartnerId}`;
                        const tail = bp.email ? ` · ${bp.email}` : bp.companyName ? ` · ${bp.companyName}` : '';
                        return `${bp.displayName}${tail}`;
                      })()}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleLinkExistingBp('')}
                      className="px-2 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100"
                      title="Clear link"
                    >
                      Clear
                    </button>
                  </div>
                )}
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  Pick someone already in <strong>Contacts</strong> to give them
                  app access without duplicating the contact record.
                </p>
              </div>

              {/* M1.1 — Code field driven by EMPLOYEE entity-kind assignment.
                  auto  : read-only preview of the next code (system allocates on save).
                  manual / external : input the admin fills in.
                  no range bound: hidden — admins wire one up in /admin/object-numbering. */}
              {employeeRange && (
                <TextField
                  label={
                    <>
                      Employee Code
                      <span className="ml-2 text-[10px] font-normal text-slate-400 dark:text-slate-500">
                        {employeeRange.mode === 'auto'
                          ? `auto from range ${employeeRange.code}`
                          : employeeRange.mode === 'manual'
                            ? `you type it — range ${employeeRange.code}`
                            : `external — range ${employeeRange.code}${employeeRange.externalPattern ? ` (pattern: ${employeeRange.externalPattern})` : ''}`}
                      </span>
                    </>
                  }
                  name="code"
                  required={employeeRange.mode !== 'auto'}
                  value={employeeRange.mode === 'auto' ? (employeeRange.preview ?? '') : form.code}
                  onChange={(e) => patchCreate('code', e.target.value)}
                  disabled={employeeRange.mode === 'auto'}
                  placeholder={
                    employeeRange.mode === 'auto'
                      ? '(allocated on save)'
                      : (employeeRange.prefix ? `e.g. ${employeeRange.prefix}…` : 'Enter the code')
                  }
                  error={createErrors.code}
                  inputClassName="font-mono"
                />
              )}

              <div className="grid grid-cols-2 gap-4">
                <TextField
                  label="First Name"
                  name="firstName"
                  required
                  value={form.firstName}
                  error={createErrors.firstName}
                  onChange={(e) => patchCreate('firstName', e.target.value)}
                />
                <TextField
                  label="Last Name"
                  name="lastName"
                  required
                  value={form.lastName}
                  error={createErrors.lastName}
                  onChange={(e) => patchCreate('lastName', e.target.value)}
                />
              </div>
              {/* Hebrew name (T3.3, 2026-06-28). Optional — when filled
                  the bilingual search hits these too. RTL on the inputs
                  so the cursor sits where Hebrew typists expect. */}
              <div className="grid grid-cols-2 gap-4">
                <TextField
                  label="שם פרטי (Hebrew first name)"
                  name="firstNameHe"
                  dir="rtl"
                  value={form.firstNameHe ?? ''}
                  onChange={(e) => patchCreate('firstNameHe', e.target.value)}
                />
                <TextField
                  label="שם משפחה (Hebrew last name)"
                  name="lastNameHe"
                  dir="rtl"
                  value={form.lastNameHe ?? ''}
                  onChange={(e) => patchCreate('lastNameHe', e.target.value)}
                />
              </div>
              <TextField
                label={
                  <>
                    Email
                    <span className="ml-2 text-[10px] font-normal text-slate-400 dark:text-slate-500">
                      (unique — login &amp; identifier)
                    </span>
                  </>
                }
                name="email"
                type="email"
                required
                value={form.email}
                error={createErrors.email}
                hint={(() => {
                  // People UX M5 (D1) — on the Employees tab, warn (do NOT
                  // block) when the entered email is not on the AMEC domain.
                  if (isPartners) return undefined;
                  const email = form.email.trim();
                  if (!email || createErrors.email) return undefined;
                  const domain = email.split('@')[1]?.toLowerCase() ?? '';
                  if (!domain || domain === 'amec.co.il') return undefined;
                  return `Email domain "${domain}" is not on the AMEC domain — this employee may not authenticate via SSO.`;
                })()}
                hintTone="warning"
                onChange={(e) => patchCreate('email', e.target.value)}
              />
              <TextField
                label="Password"
                name="password"
                type="password"
                required
                autoComplete="new-password"
                value={form.password}
                error={createErrors.password}
                hint={createErrors.password ? undefined : 'Minimum 6 characters.'}
                onChange={(e) => patchCreate('password', e.target.value)}
              />
              <div className="grid grid-cols-2 gap-4">
                <SelectField
                  label="Access Role"
                  name="roleId"
                  required
                  value={form.roleId}
                  error={createErrors.roleId}
                  onChange={(e) => patchCreate('roleId', e.target.value)}
                >
                  <option value="">Select role</option>
                  {roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </SelectField>
                <TextField
                  label="Telephone"
                  name="phone"
                  value={form.phone}
                  onChange={(e) => patchCreate('phone', e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <SelectField
                  label="Job Title"
                  name="position"
                  value={form.position}
                  onChange={(e) => patchCreate('position', e.target.value)}
                >
                  <option value="">Select job title</option>
                  {professions.map((p: any) => <option key={p.id} value={p.name}>{p.name}</option>)}
                </SelectField>
                <SelectField
                  label="Department"
                  name="department"
                  value={form.department}
                  onChange={(e) => patchCreate('department', e.target.value)}
                >
                  <option value="">Select department</option>
                  {departments.map((d: any) => <option key={d.id} value={d.name}>{d.name}</option>)}
                </SelectField>
              </div>
              {/* M5a — Seniority Level (drives default hourly cost).
                  Cost preview + price tags on each option are gated
                  by finance:read so non-finance users see only the
                  level name. */}
              <SelectField
                label={
                  <>
                    Seniority Level
                    {/* Finance gate — no admin short-circuit; admins must
                        hold the explicit Finance grant in /admin/roles. */}
                    {can('finance', 'read') && (() => {
                      const sel = seniorityLevels.find((s: any) => String(s.id) === String(form.seniorityLevelId));
                      return sel && sel.defaultHourlyCost != null ? (
                        <span className="ml-2 text-[11px] font-normal text-slate-500 dark:text-slate-400">
                          → {sel.defaultHourlyCost}{sel.currency ? ` ${sel.currency}` : ''}/h
                        </span>
                      ) : null;
                    })()}
                  </>
                }
                name="seniorityLevelId"
                value={form.seniorityLevelId}
                onChange={(e) => setForm((f) => ({ ...f, seniorityLevelId: e.target.value === '' ? '' : Number(e.target.value) }))}
              >
                <option value="">— Pick a seniority level —</option>
                {seniorityLevels.map((s: any) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {can('finance', 'read') && s.defaultHourlyCost != null
                      ? ` — ${s.defaultHourlyCost}${s.currency ? ` ${s.currency}` : ''}/h`
                      : ''}
                  </option>
                ))}
              </SelectField>
              {seniorityLevels.length === 0 && (
                <p className="text-[11px] text-amber-700 mt-1">
                  No seniority levels defined yet. Add some in <a className="text-blue-600 hover:underline" href="/admin/seniority-levels" target="_blank" rel="noreferrer">/admin/seniority-levels</a>.
                </p>
              )}

              {/* M4a.4 — Employment fields */}
              <div className="grid grid-cols-3 gap-4">
                <TextField
                  label="Start date"
                  name="employmentDate"
                  type="date"
                  value={form.employmentDate}
                  onChange={(e) => patchCreate('employmentDate', e.target.value)}
                />
                <TextField
                  label="End date"
                  name="employmentEndDate"
                  type="date"
                  value={form.employmentEndDate}
                  onChange={(e) => patchCreate('employmentEndDate', e.target.value)}
                />
                <TextField
                  label="Daily standard hours"
                  name="dailyStandardHours"
                  type="number"
                  step="0.25"
                  min={0}
                  max={24}
                  value={form.dailyStandardHours}
                  onChange={(e) => patchCreate('dailyStandardHours', e.target.value)}
                  placeholder="e.g. 8"
                />
              </div>
              {peopleTab === 'partners' && (
                <TextField
                  label="Organization Name"
                  name="companyName"
                  value={form.companyName}
                  onChange={(e) => patchCreate('companyName', e.target.value)}
                />
              )}
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                <button type="button" onClick={() => setShowCreate(false)} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
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
            className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[520px] max-w-[92vw] max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Select a contact</h2>
              <button
                type="button"
                onClick={() => setPartnerPickerOpen(false)}
                className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 border-b border-slate-100 dark:border-slate-800">
              <input
                autoFocus
                value={partnerPickerSearch}
                onChange={(e) => setPartnerPickerSearch(e.target.value)}
                placeholder="Search by name, email, or company..."
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
              />
              <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
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
                    <p className="px-5 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                      {linkableBps.length === 0
                        ? 'No linkable contacts — every person already has a login.'
                        : 'No matches for that search.'}
                    </p>
                  );
                }
                return (
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                    {filtered.map((bp: any) => (
                      <li key={bp.id}>
                        <button
                          type="button"
                          onClick={() => {
                            handleLinkExistingBp(String(bp.id));
                            setPartnerPickerOpen(false);
                          }}
                          className="w-full text-left px-5 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                        >
                          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{bp.displayName}</p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
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
            className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[520px] max-w-[92vw] max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Select an organization</h2>
              <button
                type="button"
                onClick={() => setEmployerPickerOpen(false)}
                className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 border-b border-slate-100 dark:border-slate-800">
              <input
                autoFocus
                value={employerPickerSearch}
                onChange={(e) => setEmployerPickerSearch(e.target.value)}
                placeholder="Search by name, tax ID, or email..."
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
              />
              <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
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
                    <p className="px-5 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                      {employerOrgs.length === 0
                        ? 'No organizations yet — add one from Organizations first.'
                        : 'No matches for that search.'}
                    </p>
                  );
                }
                return (
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                    {filtered.map((org: any) => (
                      <li key={org.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setForm((f) => ({ ...f, employerOrgId: org.id }));
                            setEmployerPickerOpen(false);
                          }}
                          className="w-full text-left px-5 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                        >
                          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{org.displayName}</p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
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

      {overrideUser && (
        <UserRateModal
          user={overrideUser}
          onClose={() => setOverrideUser(null)}
        />
      )}
    </div>
  );
}
