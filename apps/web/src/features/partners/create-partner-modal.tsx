import { useState, useEffect } from 'react';
import { X, User as UserIcon, Building2 } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';

const inputClass = 'w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none';

export function CreatePartnerModal({
  defaultPartnerType,
  onClose,
  onCreated,
}: {
  defaultPartnerType: 'person' | 'organization';
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const queryClient = useQueryClient();
  const [partnerType, setPartnerType] = useState<'person' | 'organization'>(defaultPartnerType);
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    companyName: '',
    taxId: '',
    email: '',
    phone: '',
    mobile: '',
    website: '',
    address: '',
    notes: '',
    // Main Role — optional single categorization. Replaces the
    // legacy multi-chip initialRoleTypeIds picker.
    mainRoleTypeId: '' as string,
  });

  // Lock background scroll while open
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  const { data: roleTypes = [] } = useQuery<Array<{ id: number; code: string; name: string; appliesToKind?: string }>>({
    queryKey: ['partner-role-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/partner-types/role-types').then((r) => r.data?.data ?? r.data ?? []),
  });
  // Filter the Main Role dropdown by the chosen partnerType so the
  // catalog's appliesToKind constraint is respected. Drop 'employee' —
  // employees are managed from the People page.
  const applicableRoles = roleTypes.filter((rt) => {
    if (rt.code === 'employee') return false;
    const kind = rt.appliesToKind ?? 'any';
    return kind === 'any' || kind === partnerType;
  });

  const create = useMutation({
    mutationFn: () =>
      client.post('/business-partners', {
        partnerType,
        firstName: partnerType === 'person' ? form.firstName.trim() || undefined : undefined,
        lastName: partnerType === 'person' ? form.lastName.trim() || undefined : undefined,
        companyName: form.companyName.trim() || undefined,
        taxId: form.taxId.trim() || undefined,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        mobile: form.mobile.trim() || undefined,
        website: form.website.trim() || undefined,
        address: form.address.trim() || undefined,
        notes: form.notes.trim() || undefined,
        mainRoleTypeId: form.mainRoleTypeId ? Number(form.mainRoleTypeId) : undefined,
      }).then((r) => r.data?.data ?? r.data),
    onSuccess: (created: any) => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      notify.success('Business partner created', { code: 'BP-CREATE-200' });
      onCreated(created.id);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create partner'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (partnerType === 'person' && !form.firstName.trim() && !form.lastName.trim()) {
      notify.warning('Please enter at least a first or last name', { code: 'BP-CREATE-400' });
      return;
    }
    if (partnerType === 'organization' && !form.companyName.trim()) {
      notify.warning('Please enter the organization name', { code: 'BP-CREATE-400' });
      return;
    }
    create.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[520px] max-w-[92vw] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Add Business Partner</h2>
          <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Type selector */}
          <div className="grid grid-cols-2 gap-2">
            {(['person', 'organization'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setPartnerType(t)}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-lg border-2 px-4 py-3 text-sm font-medium transition-colors',
                  partnerType === t
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600',
                )}
              >
                {t === 'person' ? <UserIcon className="h-4 w-4" /> : <Building2 className="h-4 w-4" />}
                {t === 'person' ? 'Person' : 'Organization'}
              </button>
            ))}
          </div>

          {/* Person-specific */}
          {partnerType === 'person' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">First Name *</label>
                <input value={form.firstName} onChange={(e) => setForm(f => ({ ...f, firstName: e.target.value }))} className={inputClass} autoFocus />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Last Name *</label>
                <input value={form.lastName} onChange={(e) => setForm(f => ({ ...f, lastName: e.target.value }))} className={inputClass} />
              </div>
            </div>
          )}

          {/* Organization-specific OR person's employer */}
          <div className="grid grid-cols-2 gap-3">
            <div className={partnerType === 'organization' ? 'col-span-2' : undefined}>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
                {partnerType === 'organization' ? 'Organization Name *' : 'Employer (optional)'}
              </label>
              <input
                value={form.companyName}
                onChange={(e) => setForm(f => ({ ...f, companyName: e.target.value }))}
                className={inputClass}
                autoFocus={partnerType === 'organization'}
              />
            </div>
            {partnerType === 'organization' && (
              <div className="col-span-2">
                <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Tax ID</label>
                <input value={form.taxId} onChange={(e) => setForm(f => ({ ...f, taxId: e.target.value }))} className={inputClass} />
              </div>
            )}
          </div>

          {/* Contact */}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Email</label>
              <input type="email" value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Phone</label>
              <input value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Mobile</label>
              <input value={form.mobile} onChange={(e) => setForm(f => ({ ...f, mobile: e.target.value }))} className={inputClass} />
            </div>
            <div className="col-span-2">
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Website</label>
              <input value={form.website} onChange={(e) => setForm(f => ({ ...f, website: e.target.value }))} className={inputClass} />
            </div>
            <div className="col-span-2">
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Address</label>
              <input value={form.address} onChange={(e) => setForm(f => ({ ...f, address: e.target.value }))} className={inputClass} />
            </div>
          </div>

          {/* Main Role — single primary categorization. Optional. */}
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
              Main Role <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>
            </label>
            <select
              value={form.mainRoleTypeId}
              onChange={(e) => setForm((f) => ({ ...f, mainRoleTypeId: e.target.value }))}
              className={inputClass}
            >
              <option value="">— None / set later —</option>
              {applicableRoles.map((rt) => (
                <option key={rt.id} value={rt.id}>{rt.name}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
              Primary categorization. Project-level responsibilities are set via relationships.
            </p>
          </div>

          {/* Notes */}
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={3}
              className={cn(inputClass, 'resize-none')}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button type="button" onClick={onClose} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
            <button type="submit" disabled={create.isPending} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
              {create.isPending ? 'Creating...' : 'Create Partner'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
