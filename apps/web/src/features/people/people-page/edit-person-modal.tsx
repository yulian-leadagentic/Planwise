import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import type { UserListItem } from '@/types';
import { inputClass } from './constants';
import { SeniorityHistorySection } from './seniority-history-section';

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
  const isPartner = user.userType === 'partner';
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[480px] max-w-[92vw] max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Edit {isPartner ? 'Partner' : 'Employee'}</h2>
          <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">First Name *</label>
              <input value={form.firstName} onChange={(e) => setForm(f => ({ ...f, firstName: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Last Name *</label>
              <input value={form.lastName} onChange={(e) => setForm(f => ({ ...f, lastName: e.target.value }))} className={inputClass} />
            </div>
          </div>
          {/* Hebrew name (T3.3, 2026-06-28). */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">שם פרטי (Hebrew first name)</label>
              <input dir="rtl" value={form.firstNameHe} onChange={(e) => setForm(f => ({ ...f, firstNameHe: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">שם משפחה (Hebrew last name)</label>
              <input dir="rtl" value={form.lastNameHe} onChange={(e) => setForm(f => ({ ...f, lastNameHe: e.target.value }))} className={inputClass} />
            </div>
          </div>
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block" title="Email is the unique identifier for every person — used for login and as the dedupe key on imports.">
              Email <span className="text-red-500">*</span>
              <span className="ml-2 text-[10px] font-normal text-slate-400 dark:text-slate-500">(unique — login & identifier)</span>
            </label>
            <input type="email" value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))} className={inputClass} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block" title="Determines what the user can see and edit — separate from job title / profession.">
                Authorization Role <span className="text-red-500">*</span>
              </label>
              <select value={form.roleId} onChange={(e) => setForm(f => ({ ...f, roleId: e.target.value }))} className={inputClass}>
                <option value="">Select role</option>
                {roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Telephone</label>
              <input value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} className={inputClass} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block" title="What this person does by trade. Manage the list in /templates/types → Job Titles.">
                Job Title
              </label>
              <select value={form.position} onChange={(e) => setForm(f => ({ ...f, position: e.target.value }))} className={inputClass}>
                <option value="">Select job title</option>
                {professions.map((p: any) => <option key={p.id} value={p.name}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Department</label>
              <select value={form.department} onChange={(e) => setForm(f => ({ ...f, department: e.target.value }))} className={inputClass}>
                <option value="">Select department</option>
                {departments.map((d: any) => <option key={d.id} value={d.name}>{d.name}</option>)}
              </select>
            </div>
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
          {/* M4a.4 — Employment fields */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Start date</label>
              <input
                type="date"
                value={form.employmentDate}
                onChange={(e) => setForm((f) => ({ ...f, employmentDate: e.target.value }))}
                className={inputClass}
              />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">End date</label>
              <input
                type="date"
                value={form.employmentEndDate}
                onChange={(e) => setForm((f) => ({ ...f, employmentEndDate: e.target.value }))}
                className={inputClass}
              />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block" title="Standard daily hours used for cost & utilisation calculations.">
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
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Company Name</label>
              <input value={form.companyName} onChange={(e) => setForm(f => ({ ...f, companyName: e.target.value }))} className={inputClass} />
            </div>
          )}
          <label className="flex items-center gap-2 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm(f => ({ ...f, isActive: e.target.checked }))}
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
    </div>
  );
}
