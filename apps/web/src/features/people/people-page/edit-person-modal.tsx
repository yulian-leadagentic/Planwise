import { useState, useEffect, useMemo } from 'react';
import { Coins, X } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePermissions } from '@/hooks/use-permissions';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import type { UserListItem } from '@/types';
import { SeniorityHistorySection } from './seniority-history-section';
import { UserRateModal } from './user-rate-modal';
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
  const { can } = usePermissions();
  const isPartner = user.userType === 'partner';
  // QA3 round-3 item 3a — cost-rate override entry point next to
  // Seniority History. Employees only + finance-gated so admins
  // without the finance grant don't see it.
  const showCostOverride = !isPartner && can('finance', 'read');
  const [showOverrideModal, setShowOverrideModal] = useState(false);
  // M4a.4 — toDateInput slices ISO to YYYY-MM-DD so <input type=date> accepts it.
  const toDateInput = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : '');
  const [form, setForm] = useState({
    email: user.email ?? '',
    firstName: user.firstName ?? '',
    lastName: user.lastName ?? '',
    firstNameHe: (user as any).firstNameHe ?? '',
    lastNameHe: (user as any).lastNameHe ?? '',
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
    // On edit, fall back to the open-ended sentinel when the stored
    // end date is null so the field reads "currently employed" and
    // matches the create-form default.
    employmentEndDate: toDateInput((user as any).employmentEndDate) || '9999-12-31',
    dailyStandardHours:
      (user as any).dailyStandardHours != null ? String((user as any).dailyStandardHours) : '',
    seniorityLevelId: ((user as any).seniorityLevelId ?? '') as number | '',
    isActive: user.isActive,
  });
  // People UX M5 — inline errors keyed by field. Fired on submit + cleared
  // on the next change to that field so the user sees the fix take effect.
  const [errors, setErrors] = useState<Partial<Record<'firstName' | 'lastName' | 'email' | 'roleId', string>>>({});
  // Clear a specific field's error on change — the message shouldn't linger
  // after the user has typed a fix.
  const patch = (k: keyof typeof form, v: any) =>
    setForm((f) => {
      if (k in errors) setErrors((prev) => ({ ...prev, [k]: undefined }));
      return { ...f, [k]: v };
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
      department: form.department || undefined,
      companyName: form.companyName || undefined,
      employmentDate: form.employmentDate || undefined,
      employmentEndDate: form.employmentEndDate || undefined,
      dailyStandardHours: form.dailyStandardHours ? Number(form.dailyStandardHours) : undefined,
      // seniorityLevelId intentionally NOT spread here. The current
      // level is derived from the seniority-history rows and synced
      // server-side by UserSenioritiesService whenever an entry is
      // added/edited/removed via SeniorityHistorySection below.
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[480px] max-w-[92vw] max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Edit {isPartner ? 'External User' : 'Employee'}</h2>
          <button
            type="button"
            onClick={onClose}
            className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200"
            aria-label={`Close edit dialog for ${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4" noValidate>
          <div className="grid grid-cols-2 gap-4">
            <TextField
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
            <SelectField
              label="Job Title"
              name="position"
              value={form.position}
              onChange={(e) => patch('position', e.target.value)}
            >
              <option value="">Select job title</option>
              {professions.map((p: any) => (
                <option key={p.id} value={p.name}>{p.name}</option>
              ))}
            </SelectField>
            <SelectField
              label="Department"
              name="department"
              value={form.department}
              onChange={(e) => patch('department', e.target.value)}
            >
              <option value="">Select department</option>
              {departments.map((d: any) => (
                <option key={d.id} value={d.name}>{d.name}</option>
              ))}
            </SelectField>
          </div>
          {/* Seniority History — replaces the single-level dropdown.
              The legacy users.seniority_level_id column is auto-synced
              by the service after each add/edit/remove (always = the
              current open-ended row), so existing reads keep working.
              Project cost calculations now resolve the level effective
              on each TimeEntry's date — see UserSenioritiesService. */}
          <SeniorityHistorySection
            userId={user.id}
            seniorityLevels={seniorityLevels}
          />
          {/* QA3 round-3 item 3a — Cost rate override entry point.
              Same modal as the 💰 row action; surfaced here because
              admins look for it inside the edit dialog. Finance-gated,
              employees only. */}
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
                  Optional per-employee rate that wins over the seniority level rate.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowOverrideModal(true)}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 px-3 py-1.5 text-[12px] font-semibold text-white"
                aria-label={`Manage cost rate override for ${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()}
              >
                <Coins className="h-3 w-3" aria-hidden="true" />
                Manage override
              </button>
            </div>
          )}
          {/* People UX U1 (E-01) — the override modal is rendered OUTSIDE
              the <form> below so its buttons can't accidentally submit
              the employee form. Kept the trigger button in place so the
              UX reads the same. */}
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
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button type="button" onClick={onClose} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
            <button type="submit" disabled={update.isPending} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
              {update.isPending ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
      {/* People UX U1 (E-01) — rendered as a sibling of the form's
          container, not inside the <form>. Any submit-typed button
          inside UserRateModal now belongs to its own scope only. */}
      {showOverrideModal && (
        <UserRateModal user={user} onClose={() => setShowOverrideModal(false)} />
      )}
    </div>
  );
}
