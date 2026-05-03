import { useState, useEffect, useMemo } from 'react';
import { X, User as UserIcon, AlertCircle } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';

const inputClass = 'w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none';

interface RoleType { id: number; code: string; name: string }
interface RelationshipType { id: number; code: string; name: string }
interface Organization { id: number; displayName: string; companyName: string | null }

export function CreateContactModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    employerOrgId: '' as string,
    email: '',
    phone: '',
    mobile: '',
    notes: '',
    roleCode: 'external_contact' as string,
    roleInContext: '',
  });

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  const { data: orgs = [] } = useQuery<Organization[]>({
    queryKey: ['organizations-for-contact'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/business-partners?partnerType=organization&perPage=200').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });

  const { data: roleTypes = [] } = useQuery<RoleType[]>({
    queryKey: ['partner-role-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/partner-types/role-types').then((r) => r.data?.data ?? r.data ?? []),
  });

  const { data: relTypes = [] } = useQuery<RelationshipType[]>({
    queryKey: ['partner-relationship-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/partner-types/relationship-types').then((r) => r.data?.data ?? r.data ?? []),
  });

  // Contact roles = anything except 'employee' (employees use Add Employee flow)
  const contactRoles = useMemo(
    () => roleTypes.filter((rt) => rt.code !== 'employee'),
    [roleTypes],
  );

  const create = useMutation({
    mutationFn: async () => {
      const roleType = roleTypes.find((rt) => rt.code === form.roleCode);

      // 1) Create the person BP with the chosen role
      const created: any = await client.post('/business-partners', {
        partnerType: 'person',
        firstName: form.firstName.trim() || undefined,
        lastName: form.lastName.trim() || undefined,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        mobile: form.mobile.trim() || undefined,
        notes: form.notes.trim() || undefined,
        initialRoleTypeIds: roleType ? [roleType.id] : undefined,
      }).then((r) => r.data?.data ?? r.data);

      // 2) Wire the employee_of relationship to the chosen organization
      if (form.employerOrgId) {
        const employeeOf = relTypes.find((rt) => rt.code === 'employee_of');
        if (employeeOf) {
          await client.post('/business-partner-relationships', {
            sourcePartnerId: created.id,
            targetType: 'organization',
            targetId: Number(form.employerOrgId),
            relationshipTypeId: employeeOf.id,
            roleInContext: form.roleInContext.trim() || undefined,
            isPrimary: true,
          }).catch(() => undefined); // best-effort
        }
      }

      return created;
    },
    onSuccess: (created: any) => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      notify.success('Contact created', { code: 'CONTACT-CREATE-200' });
      onCreated(created.id);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create contact'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.firstName.trim() && !form.lastName.trim()) {
      notify.warning('Enter at least a first or last name', { code: 'CONTACT-CREATE-400' });
      return;
    }
    create.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[520px] max-w-[92vw] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <UserIcon className="h-4 w-4 text-blue-600" />
            Add Contact
          </h2>
          <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <p className="text-[12px] text-slate-500">
            An external person — typically someone working at one of your organizations (a customer's project lead, a supplier rep, an external consultant).
          </p>

          {orgs.length === 0 && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-[12px] text-amber-700 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>No organizations exist yet. Add one in the Organizations tab first, then come back here.</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">First Name *</label>
              <input value={form.firstName} onChange={(e) => setForm(f => ({ ...f, firstName: e.target.value }))} className={inputClass} autoFocus />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Last Name *</label>
              <input value={form.lastName} onChange={(e) => setForm(f => ({ ...f, lastName: e.target.value }))} className={inputClass} />
            </div>
          </div>

          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Employer (organization)</label>
            <select value={form.employerOrgId} onChange={(e) => setForm(f => ({ ...f, employerOrgId: e.target.value }))} className={inputClass}>
              <option value="">— None / unaffiliated —</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.displayName}</option>
              ))}
            </select>
          </div>

          {form.employerOrgId && (
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Role at the organization (optional)</label>
              <input
                value={form.roleInContext}
                onChange={(e) => setForm(f => ({ ...f, roleInContext: e.target.value }))}
                placeholder='e.g. "Operations Manager"'
                className={inputClass}
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Stored as the role-in-context on the employee_of relationship.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Email</label>
              <input type="email" value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Phone</label>
              <input value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Mobile</label>
              <input value={form.mobile} onChange={(e) => setForm(f => ({ ...f, mobile: e.target.value }))} className={inputClass} />
            </div>
          </div>

          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Type of contact</label>
            <select value={form.roleCode} onChange={(e) => setForm(f => ({ ...f, roleCode: e.target.value }))} className={inputClass}>
              {contactRoles.map((rt) => <option key={rt.id} value={rt.code}>{rt.name}</option>)}
            </select>
          </div>

          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Notes</label>
            <textarea value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} rows={3} className={cn(inputClass, 'resize-none')} />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
            <button type="submit" disabled={create.isPending} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
              {create.isPending ? 'Creating...' : 'Create Contact'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
