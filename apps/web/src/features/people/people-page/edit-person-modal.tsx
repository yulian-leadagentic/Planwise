import { useState, useMemo, useRef } from 'react';
import { Coins } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePermissions } from '@/hooks/use-permissions';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import type { UserListItem } from '@/types';
import { SeniorityHistorySection } from './seniority-history-section';
import { UserRateModal } from './user-rate-modal';
import { Modal } from '@/components/shared/modal';
import { TextField, SelectField } from '@/components/shared/field';

/**
 * People UX M5 — validation rules for the edit form.
 *
 *   • firstName / lastName: required, non-empty when trimmed.
 *   • email: required + basic RFC-ish shape check (no toast, inline).
 *   • roleId: required.
 *
 * Returns a partial map keyed by form field so <Field error> wiring stays
 * flat. Password is not editable here (dedicated Reset flow).
 */
function validateEdit(
  form: { firstName: string; lastName: string; email: string; roleId: string },
): Partial<Record<'firstName' | 'lastName' | 'email' | 'roleId', string>> {
  const errs: Partial<Record<'firstName' | 'lastName' | 'email' | 'roleId', string>> = {};
  if (!form.firstName.trim()) errs.firstName = 'First name is required.';
  if (!form.lastName.trim()) errs.lastName = 'Last name is required.';
  if (!form.email.trim()) errs.email = 'Email is required.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errs.email = 'Enter a valid email address.';
  if (!form.roleId) errs.roleId = 'Access Role is required.';
  return errs;
}

export function EditPersonModal({
  user,
  roles,
  orgUnits,
  professions,
  seniorityLevels,
  onClose,
}: {
  user: UserListItem;
  roles: any[];
  // Phase 4 · Stage 2 follow-up (2026-09-28) — the Department picker now
  // sources from the OrgUnit tree, not `/admin/config/departments`, and
  // writes `orgUnitId`. Legacy `User.department` (free text) still
  // renders as a disabled hint when the row hasn't been backfilled.
  orgUnits: Array<{ id: number; name: string }>;
  professions: any[];
  seniorityLevels: any[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const isPartner = user.userType === 'partner';
  // QA3 round-3 item 3a — cost-rate override entry point.
  const showCostOverride = !isPartner && can('finance', 'read');
  const [showOverrideModal, setShowOverrideModal] = useState(false);
  // M4a.4 — toDateInput slices ISO to YYYY-MM-DD so <input type=date> accepts it.
  const toDateInput = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : '');
  const initialForm = useMemo(() => ({
    email: user.email ?? '',
    firstName: user.firstName ?? '',
    lastName: user.lastName ?? '',
    firstNameHe: (user as any).firstNameHe ?? '',
    lastNameHe: (user as any).lastNameHe ?? '',
    phone: (user as any).phone ?? '',
    roleId: String((user as any).roleId ?? ''),
    position: user.position ?? '',
    // Retire-User.department Step 3/3 (2026-09-28) — Department is
    // sourced solely from `orgUnitId` now; the legacy free-text
    // fallback is retired with the column.
    orgUnitId: (((user as any).orgUnitId ?? (user as any).orgUnit?.id) ?? '') as number | '',
    companyName: user.companyName ?? '',
    employmentDate: toDateInput((user as any).employmentDate),
    employmentEndDate: toDateInput((user as any).employmentEndDate) || '9999-12-31',
    dailyStandardHours:
      (user as any).dailyStandardHours != null ? String((user as any).dailyStandardHours) : '',
    seniorityLevelId: ((user as any).seniorityLevelId ?? '') as number | '',
    isActive: user.isActive,
  }), [user]);
  const [form, setForm] = useState(initialForm);
  // People UX M5 — inline errors keyed by field.
  const [errors, setErrors] = useState<Partial<Record<'firstName' | 'lastName' | 'email' | 'roleId', string>>>({});
  const patch = (k: keyof typeof form, v: any) =>
    setForm((f) => {
      if (k in errors) setErrors((prev) => ({ ...prev, [k]: undefined }));
      return { ...f, [k]: v };
    });
  // People UX M1 — dirty flag for the shared Modal's discard-changes
  // guard. Any field diverging from the initial values counts.
  const isDirty = useMemo(() => {
    return (Object.keys(initialForm) as Array<keyof typeof initialForm>).some(
      (k) => (form as any)[k] !== (initialForm as any)[k],
    );
  }, [form, initialForm]);
  // Focus the first editable field on open — the shared Modal's own
  // "first focusable" would land on the close-X button.
  const firstFieldRef = useRef<HTMLInputElement>(null);

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
    const errs = validateEdit(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    update.mutate({
      email: form.email,
      firstName: form.firstName,
      lastName: form.lastName,
      firstNameHe: form.firstNameHe || undefined,
      lastNameHe: form.lastNameHe || undefined,
      phone: form.phone || undefined,
      roleId: Number(form.roleId),
      position: form.position || undefined,
      // Phase 4 · Stage 2 follow-up — write `orgUnitId` (OrgUnit is the
      // single source of truth); the legacy `department` field is not
      // sent so we don't accidentally overwrite it. Empty selection
      // sends null to clear the link.
      orgUnitId: form.orgUnitId === '' ? null : Number(form.orgUnitId),
      companyName: form.companyName || undefined,
      employmentDate: form.employmentDate || undefined,
      employmentEndDate: form.employmentEndDate || undefined,
      dailyStandardHours: form.dailyStandardHours ? Number(form.dailyStandardHours) : undefined,
      isActive: form.isActive,
    });
  };

  // D1 warning — for non-partner (Employees) tab, warn if the email is
  // not on the AMEC domain. This is a warning, not a hard error.
  const amecDomainWarning = useMemo(() => {
    if (isPartner) return null;
    const email = form.email.trim();
    if (!email || errors.email) return null;
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    if (!domain) return null;
    if (domain !== 'amec.co.il') {
      return `Email domain "${domain}" is not on the AMEC domain — this employee may not authenticate via SSO.`;
    }
    return null;
  }, [form.email, isPartner, errors.email]);

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={`Edit ${isPartner ? 'External User' : 'Employee'}`}
        closeLabel={`Close edit dialog for ${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()}
        widthClass="w-[480px] max-w-[92vw]"
        isDirty={isDirty}
        initialFocusRef={firstFieldRef}
        footer={
          <>
            <button
              type="button"
              onClick={onClose}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="edit-person-form"
              disabled={update.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50"
            >
              {update.isPending ? 'Saving...' : 'Save Changes'}
            </button>
          </>
        }
      >
        {/* People UX U1 (E-01) — the override modal is rendered OUTSIDE
            this <form> (as a sibling of the outer Modal below) so its
            buttons can never submit the employee form. Every button in
            UserRateModal is type="button" for the same reason. */}
        <form id="edit-person-form" onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="grid grid-cols-2 gap-4">
            <TextField
              ref={firstFieldRef}
              label="First Name"
              name="firstName"
              required
              value={form.firstName}
              error={errors.firstName}
              onChange={(e) => patch('firstName', e.target.value)}
            />
            <TextField
              label="Last Name"
              name="lastName"
              required
              value={form.lastName}
              error={errors.lastName}
              onChange={(e) => patch('lastName', e.target.value)}
            />
          </div>
          {/* Hebrew name (T3.3, 2026-06-28). */}
          <div className="grid grid-cols-2 gap-4">
            <TextField
              label="שם פרטי (Hebrew first name)"
              name="firstNameHe"
              dir="rtl"
              value={form.firstNameHe}
              onChange={(e) => patch('firstNameHe', e.target.value)}
            />
            <TextField
              label="שם משפחה (Hebrew last name)"
              name="lastNameHe"
              dir="rtl"
              value={form.lastNameHe}
              onChange={(e) => patch('lastNameHe', e.target.value)}
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
            error={errors.email}
            hint={amecDomainWarning ?? undefined}
            hintTone="warning"
            onChange={(e) => patch('email', e.target.value)}
          />
          <div className="grid grid-cols-2 gap-4">
            <SelectField
              label="Access Role"
              name="roleId"
              required
              value={form.roleId}
              error={errors.roleId}
              onChange={(e) => patch('roleId', e.target.value)}
            >
              <option value="">Select role</option>
              {roles.map((r: any) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </SelectField>
            <TextField
              label="Telephone"
              name="phone"
              value={form.phone}
              onChange={(e) => patch('phone', e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            {/* JT-3 (QA4 · 2026-09-29): renamed "Job Title" → "Position"
                and re-sourced the dropdown from the `positions` catalog
                (Yulian-approved: CEO / VP / HR manager / Finance). The
                write still round-trips through `User.position` as a
                string; the backend's `syncPositionToBpPositionId` hook
                mirrors the name onto the linked BP's `positionId` FK so
                the drawer sees it too. A previously-set free-text
                value is preserved as a "(legacy)" option until the
                user picks a catalog row. */}
            <PositionSelectField
              value={form.position}
              onChange={(v) => patch('position', v)}
            />
            <SelectField
              label="Department"
              name="orgUnitId"
              value={form.orgUnitId}
              onChange={(e) => patch('orgUnitId', e.target.value === '' ? '' : Number(e.target.value))}
            >
              {/* Retire-User.department Step 3/3 (2026-09-28) — the
                  "legacy free-text" hint option was removed with the
                  column drop. Options are the OrgUnit tree only. */}
              <option value="">Select department</option>
              {orgUnits.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </SelectField>
          </div>
          {/* Seniority History — replaces the single-level dropdown. */}
          <SeniorityHistorySection
            userId={user.id}
            seniorityLevels={seniorityLevels}
          />
          {/* QA3 round-3 item 3a — Cost rate override entry point. */}
          {showCostOverride && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 p-3 flex items-center justify-between">
              <div>
                <div
                  className="text-[13px] font-semibold text-slate-700 dark:text-slate-200"
                  title="Set a per-employee override rate. Overrides the level rate globally across projects. Supports bounded [start, end] windows."
                >
                  Cost rate override
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Optional per-employee rate that wins over the labor category rate.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowOverrideModal(true)}
                className="inline-flex items-center gap-1 rounded-md bg-blue-600 hover:bg-blue-700 px-3 py-1.5 text-[12px] font-semibold text-white"
                aria-label={`Manage cost rate override for ${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()}
              >
                <Coins className="h-3 w-3" aria-hidden="true" />
                Manage override
              </button>
            </div>
          )}
          {/* M4a.4 — Employment fields */}
          <div className="grid grid-cols-3 gap-4">
            <TextField
              label="Start date"
              name="employmentDate"
              type="date"
              value={form.employmentDate}
              onChange={(e) => patch('employmentDate', e.target.value)}
            />
            <TextField
              label="End date"
              name="employmentEndDate"
              type="date"
              value={form.employmentEndDate}
              onChange={(e) => patch('employmentEndDate', e.target.value)}
            />
            <TextField
              label="Daily standard hours"
              name="dailyStandardHours"
              type="number"
              step="0.25"
              min={0}
              max={24}
              value={form.dailyStandardHours}
              onChange={(e) => patch('dailyStandardHours', e.target.value)}
              placeholder="e.g. 8"
            />
          </div>
          {isPartner && (
            <TextField
              label="Organization Name"
              name="companyName"
              value={form.companyName}
              onChange={(e) => patch('companyName', e.target.value)}
            />
          )}
          <label className="flex items-center gap-2 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => patch('isActive', e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600"
            />
            <span className="text-sm text-slate-700 dark:text-slate-200">Active</span>
          </label>
        </form>
      </Modal>
      {/* People UX U1 (E-01) — rendered as a sibling of the outer Modal,
          not inside it. Modal renders a portal-like top-level div and
          UserRateModal follows as a sibling so the nested modal's
          submit-typed buttons (there are none anyway) can't reach the
          employee form. */}
      {showOverrideModal && (
        <UserRateModal user={user} onClose={() => setShowOverrideModal(false)} />
      )}
    </>
  );
}

/**
 * JT-3 (QA4 · 2026-09-29) — descriptive-Position select for the People
 * edit modal. Sources from `/admin/config/positions` (JT-1 catalog);
 * value is the Position's NAME so the parent form keeps writing
 * `user.position` (string) as it always has. The backend hook
 * `syncPositionToBpPositionId` mirrors the name onto BusinessPartner.
 *
 * A previously-set free-text position that isn't in the catalog is
 * preserved as a "(legacy)" option, matching the historical Job Title
 * behaviour, so opening the modal never silently changes what a user
 * had.
 */
function PositionSelectField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const { data: positions = [] } = useQuery<Array<{ id: number; code: string; name: string; nameHe: string | null }>>({
    queryKey: ['admin', 'config', 'positions'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/config/positions').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });
  const isLegacy = !!value && !positions.some((p) => p.name === value);
  return (
    <SelectField
      label="Position"
      name="position"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Select position</option>
      {positions.map((p) => (
        <option key={p.id} value={p.name}>
          {p.name}{p.nameHe ? ` · ${p.nameHe}` : ''}
        </option>
      ))}
      {isLegacy && (
        <option value={value}>{value} (legacy)</option>
      )}
    </SelectField>
  );
}
