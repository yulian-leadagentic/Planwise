import { useState, useEffect } from 'react';
import { X, Building2 } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';

const inputClass = 'w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none';

interface RoleType { id: number; code: string; name: string }

export function CreateOrganizationModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    companyName: '',
    taxId: '',
    email: '',
    phone: '',
    website: '',
    address: '',
    notes: '',
    initialRoleTypeIds: [] as number[],
  });

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  const { data: roleTypes = [] } = useQuery<RoleType[]>({
    queryKey: ['partner-role-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/partner-types/role-types').then((r) => r.data?.data ?? r.data ?? []),
  });

  // Roles relevant for organizations
  const orgRoleCodes = new Set(['customer', 'supplier', 'subcontractor']);
  const applicableRoles = roleTypes.filter((rt) => orgRoleCodes.has(rt.code) || !rt.code.startsWith('employee'));

  const create = useMutation({
    mutationFn: () =>
      client.post('/business-partners', {
        partnerType: 'organization',
        companyName: form.companyName.trim(),
        taxId: form.taxId.trim() || undefined,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        website: form.website.trim() || undefined,
        address: form.address.trim() || undefined,
        notes: form.notes.trim() || undefined,
        initialRoleTypeIds: form.initialRoleTypeIds.length > 0 ? form.initialRoleTypeIds : undefined,
      }).then((r) => r.data?.data ?? r.data),
    onSuccess: (created: any) => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      notify.success('Organization created', { code: 'ORG-CREATE-200' });
      onCreated(created.id);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create organization'),
  });

  const toggleRole = (id: number) => {
    setForm((f) => ({
      ...f,
      initialRoleTypeIds: f.initialRoleTypeIds.includes(id)
        ? f.initialRoleTypeIds.filter((x) => x !== id)
        : [...f.initialRoleTypeIds, id],
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.companyName.trim()) {
      notify.warning('Organization name is required', { code: 'ORG-CREATE-400' });
      return;
    }
    create.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[480px] max-w-[92vw] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Building2 className="h-4 w-4 text-violet-600" />
            Add Organization
          </h2>
          <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <p className="text-[12px] text-slate-500">
            Companies, customers, suppliers, municipalities, partner firms — anything that has its own legal identity.
          </p>

          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Organization Name *</label>
            <input value={form.companyName} onChange={(e) => setForm(f => ({ ...f, companyName: e.target.value }))} className={inputClass} autoFocus />
          </div>

          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Tax ID</label>
            <input value={form.taxId} onChange={(e) => setForm(f => ({ ...f, taxId: e.target.value }))} className={inputClass} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Email</label>
              <input type="email" value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Phone</label>
              <input value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} className={inputClass} />
            </div>
          </div>

          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Website</label>
            <input value={form.website} onChange={(e) => setForm(f => ({ ...f, website: e.target.value }))} className={inputClass} />
          </div>

          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Address</label>
            <input value={form.address} onChange={(e) => setForm(f => ({ ...f, address: e.target.value }))} className={inputClass} />
          </div>

          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Roles</label>
            <div className="flex flex-wrap gap-2">
              {applicableRoles.map((rt) => {
                const selected = form.initialRoleTypeIds.includes(rt.id);
                return (
                  <button
                    key={rt.id}
                    type="button"
                    onClick={() => toggleRole(rt.id)}
                    className={cn(
                      'rounded-full px-3 py-1 text-[12px] font-medium border transition-colors',
                      selected ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600 hover:border-slate-300',
                    )}
                  >
                    {rt.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Notes</label>
            <textarea value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} rows={3} className={cn(inputClass, 'resize-none')} />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
            <button type="submit" disabled={create.isPending} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
              {create.isPending ? 'Creating...' : 'Create Organization'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
