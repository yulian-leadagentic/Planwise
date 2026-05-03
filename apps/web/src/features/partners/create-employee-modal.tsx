import { useState, useEffect } from 'react';
import { X, Briefcase } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';

const inputClass = 'w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none';

interface Role { id: number; name: string }
interface Organization { id: number; displayName: string }
interface Department { id: number; name: string }
interface Profession { id: number; name: string }

export function CreateEmployeeModal({
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
    email: '',
    password: '',
    phone: '',
    roleId: '' as string,
    employerOrgId: '' as string,
    position: '',
    department: '',
    address: '',
    salaryHourly: '' as string,
    dailyStandardHours: '' as string,
    employmentDate: '' as string,
    employmentEndDate: '' as string,
    employeeCategory: '' as string,
  });

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  const { data: roles = [] } = useQuery<Role[]>({
    queryKey: ['roles'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/roles').then((r) => { const d = r.data?.data ?? r.data; return Array.isArray(d) ? d : []; }),
  });

  const { data: orgs = [] } = useQuery<Organization[]>({
    queryKey: ['organizations-for-employee'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/business-partners?partnerType=organization&perPage=200').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });

  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ['admin', 'departments'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/config/departments').then((r) => { const d = r.data?.data ?? r.data; return Array.isArray(d) ? d : []; }),
  });

  const { data: professions = [] } = useQuery<Profession[]>({
    queryKey: ['admin', 'professions'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/config/professions').then((r) => { const d = r.data?.data ?? r.data; return Array.isArray(d) ? d : []; }),
  });

  const create = useMutation({
    mutationFn: () =>
      client.post('/users', {
        email: form.email.trim(),
        password: form.password,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        phone: form.phone.trim() || undefined,
        roleId: Number(form.roleId),
        userType: 'employee',
        position: form.position.trim() || undefined,
        department: form.department.trim() || undefined,
        address: form.address.trim() || undefined,
        salaryHourly: form.salaryHourly ? Number(form.salaryHourly) : undefined,
        dailyStandardHours: form.dailyStandardHours ? Number(form.dailyStandardHours) : undefined,
        employmentDate: form.employmentDate || undefined,
        employmentEndDate: form.employmentEndDate || undefined,
        employeeCategory: form.employeeCategory.trim() || undefined,
        employerOrgId: form.employerOrgId ? Number(form.employerOrgId) : undefined,
      }).then((r) => r.data?.data ?? r.data),
    onSuccess: (created: any) => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
      notify.success('Employee created with login account', { code: 'EMPLOYEE-CREATE-200' });
      // The created object is a User. We want to focus the BP drawer.
      onCreated(created.businessPartnerId);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create employee'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.firstName.trim() || !form.lastName.trim() || !form.email.trim() || !form.password || !form.roleId) {
      notify.warning('First name, last name, email, password, and app role are required', { code: 'EMPLOYEE-CREATE-400' });
      return;
    }
    if (form.password.length < 6) {
      notify.warning('Password must be at least 6 characters', { code: 'EMPLOYEE-CREATE-400' });
      return;
    }
    create.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[640px] max-w-[92vw] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white z-10">
          <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Briefcase className="h-4 w-4 text-blue-600" />
            Add Employee
          </h2>
          <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-5">
          <p className="text-[12px] text-slate-500">
            Internal staff with a login account, app permissions, and HR record. Creates a User + Business Partner with the <strong>employee</strong> role automatically.
          </p>

          {/* Identity */}
          <Section title="Identity">
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
          </Section>

          {/* Login + Permissions */}
          <Section title="Login & Permissions">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Email *</label>
                <input type="email" value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))} className={inputClass} />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Password *</label>
                <input type="password" value={form.password} onChange={(e) => setForm(f => ({ ...f, password: e.target.value }))} className={inputClass} />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">App Role *</label>
                <select value={form.roleId} onChange={(e) => setForm(f => ({ ...f, roleId: e.target.value }))} className={inputClass}>
                  <option value="">Select role</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            </div>
          </Section>

          {/* Org placement */}
          <Section title="Organization">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Employer (organization)</label>
                <select value={form.employerOrgId} onChange={(e) => setForm(f => ({ ...f, employerOrgId: e.target.value }))} className={inputClass}>
                  <option value="">— Internal / no external organization —</option>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
                </select>
                <p className="text-[11px] text-slate-400 mt-1">
                  Pick if this employee works for an external organization. Creates an <code>employee_of</code> relationship automatically.
                </p>
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Profession</label>
                <select value={form.position} onChange={(e) => setForm(f => ({ ...f, position: e.target.value }))} className={inputClass}>
                  <option value="">Select</option>
                  {professions.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Department</label>
                <select value={form.department} onChange={(e) => setForm(f => ({ ...f, department: e.target.value }))} className={inputClass}>
                  <option value="">Select</option>
                  {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                </select>
              </div>
            </div>
          </Section>

          {/* Contact */}
          <Section title="Contact">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Phone</label>
                <input value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} className={inputClass} />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Address</label>
                <input value={form.address} onChange={(e) => setForm(f => ({ ...f, address: e.target.value }))} className={inputClass} />
              </div>
            </div>
          </Section>

          {/* HR — sensitive */}
          <Section title="Employment & HR" hint="Sensitive — only admins with HR permissions should fill these.">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Hourly Rate</label>
                <input type="number" step="0.01" value={form.salaryHourly} onChange={(e) => setForm(f => ({ ...f, salaryHourly: e.target.value }))} className={inputClass} />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Daily Standard Hours</label>
                <input type="number" step="0.5" value={form.dailyStandardHours} onChange={(e) => setForm(f => ({ ...f, dailyStandardHours: e.target.value }))} className={inputClass} />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Employment Start</label>
                <input type="date" value={form.employmentDate} onChange={(e) => setForm(f => ({ ...f, employmentDate: e.target.value }))} className={inputClass} />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Employment End</label>
                <input type="date" value={form.employmentEndDate} onChange={(e) => setForm(f => ({ ...f, employmentEndDate: e.target.value }))} className={inputClass} />
              </div>
              <div className="col-span-2">
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Employee Category</label>
                <input value={form.employeeCategory} onChange={(e) => setForm(f => ({ ...f, employeeCategory: e.target.value }))} placeholder='e.g. "Full-time", "Hourly"' className={inputClass} />
              </div>
            </div>
          </Section>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 sticky bottom-0 bg-white">
            <button type="button" onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
            <button type="submit" disabled={create.isPending} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
              {create.isPending ? 'Creating...' : 'Create Employee'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">{title}</h3>
      {hint && <p className="text-[11px] text-amber-600 mb-2 italic">{hint}</p>}
      {children}
    </div>
  );
}
