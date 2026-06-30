import { useState, useEffect } from 'react';
import { X, User as UserIcon, AlertCircle, Linkedin, Facebook, Twitter, Instagram } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';

const inputClass = 'w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none';

interface RelationshipType { id: number; code: string; name: string }
interface Organization { id: number; displayName: string; companyName: string | null }
interface RoleType { id: number; code: string; name: string; appliesToKind?: string }

export function CreateContactModal({
  onClose,
  onCreated,
  /**
   * If provided, the Employer dropdown is pre-selected to this org id.
   * Used by callers like the project Team picker which want to open
   * "create a new contact for THIS customer".
   */
  preselectEmployerOrgId,
  /**
   * If true and an employer is preselected, the dropdown is *locked* to
   * that org and the user can't change it. Used by the project Team
   * customer-contact picker — at that step we're explicitly creating a
   * contact for the project's customer, so changing the employer would
   * defeat the purpose.
   */
  lockEmployer,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
  preselectEmployerOrgId?: number;
  lockEmployer?: boolean;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    firstNameHe: '',
    lastNameHe: '',
    employerOrgId: preselectEmployerOrgId ? String(preselectEmployerOrgId) : '' as string,
    email: '',
    phone: '',
    mobile: '',
    website: '',
    linkedinUrl: '',
    facebookUrl: '',
    twitterUrl: '',
    instagramUrl: '',
    notes: '',
    roleInContext: '',
    // Main Role — optional primary categorization. Empty string = "not
    // set"; saved as null on the server. Drawer surfaces a soft prompt
    // later if left blank here.
    mainRoleTypeId: '' as string,
    // Job Title (Profession) — the standardized title from the
    // /admin/config/professions catalog. Previously this was only
    // settable AFTER creation via the partner drawer's Details tab,
    // forcing a two-step flow. Set the primary profession now; users
    // can add more via the drawer later.
    primaryProfessionId: '' as string,
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

  const { data: relTypes = [] } = useQuery<RelationshipType[]>({
    queryKey: ['partner-relationship-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/partner-types/relationship-types').then((r) => r.data?.data ?? r.data ?? []),
  });

  // Profession catalog for the Job Title dropdown. Catalog is admin-
  // managed via /admin/config/professions; this dropdown shows the
  // primary choice. The list intentionally falls open with [] when the
  // catalog endpoint isn't reachable so the rest of the form still
  // works.
  const { data: professions = [] } = useQuery<Array<{ id: number; name: string }>>({
    queryKey: ['professions'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/config/professions').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  // Role-types catalog for the Main Role dropdown. Filter to roles
  // applicable to persons (or 'any') and hide 'employee' — employees
  // are created from the Employees admin, not here.
  const { data: roleTypesAll = [] } = useQuery<RoleType[]>({
    queryKey: ['partner-role-types'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/admin/partner-types/role-types').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
  });
  const personRoleTypes = roleTypesAll.filter((rt) => {
    if (rt.code === 'employee') return false;
    const kind = rt.appliesToKind ?? 'any';
    return kind === 'any' || kind === 'person';
  });

  const create = useMutation({
    mutationFn: async () => {
      // 1) Create the person BP. Main Role is optional; project
      //    relationships and the worker_of edge below define the
      //    contact's per-context responsibilities.
      const created: any = await client.post('/business-partners', {
        partnerType: 'person',
        firstName: form.firstName.trim() || undefined,
        lastName: form.lastName.trim() || undefined,
        firstNameHe: form.firstNameHe.trim() || undefined,
        lastNameHe: form.lastNameHe.trim() || undefined,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        mobile: form.mobile.trim() || undefined,
        website: form.website.trim() || undefined,
        linkedinUrl: form.linkedinUrl.trim() || undefined,
        facebookUrl: form.facebookUrl.trim() || undefined,
        twitterUrl: form.twitterUrl.trim() || undefined,
        instagramUrl: form.instagramUrl.trim() || undefined,
        notes: form.notes.trim() || undefined,
        mainRoleTypeId: form.mainRoleTypeId ? Number(form.mainRoleTypeId) : undefined,
      }).then((r) => r.data?.data ?? r.data);

      // 2a) Set the primary Job Title (profession) if the user picked
      //     one. Single PUT replaces the full list; we're creating the
      //     contact, so the "full list" is just this one item.
      if (form.primaryProfessionId) {
        await client
          .put(`/business-partners/${created.id}/professions`, {
            professionIds: [Number(form.primaryProfessionId)],
            primaryProfessionId: Number(form.primaryProfessionId),
          })
          .catch(() => undefined);
      }

      // 2b) Wire the worker_of relationship to the chosen organization,
      //    so the contact is correctly classified throughout the system.
      if (form.employerOrgId) {
        const workerOf = relTypes.find((rt) => rt.code === 'worker_of');
        if (workerOf) {
          await client.post('/business-partner-relationships', {
            sourcePartnerId: created.id,
            targetType: 'organization',
            targetId: Number(form.employerOrgId),
            relationshipTypeId: workerOf.id,
            roleInContext: form.roleInContext.trim() || undefined,
            isPrimary: true,
          }).catch(() => undefined);
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
      <div className="bg-white rounded-2xl shadow-2xl w-[560px] max-w-[92vw] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white z-10">
          <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <UserIcon className="h-4 w-4 text-blue-600" />
            Add Contact
          </h2>
          <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-5">
          <p className="text-[12px] text-slate-500">
            A person who works at one of your customer or supplier organizations. The classification (customer-side vs supplier-side) is derived from the employer you pick — you don't tag it manually.
          </p>

          {orgs.length === 0 && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-[12px] text-amber-700 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>No organizations exist yet. Add one in the Organizations tab first, then come back here.</span>
            </div>
          )}

          {/* Identity */}
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
          {/* Hebrew name (T3.3, 2026-06-28) — bilingual search picks
              these up so contacts are findable in either language. */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">שם פרטי</label>
              <input dir="rtl" value={form.firstNameHe} onChange={(e) => setForm(f => ({ ...f, firstNameHe: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">שם משפחה</label>
              <input dir="rtl" value={form.lastNameHe} onChange={(e) => setForm(f => ({ ...f, lastNameHe: e.target.value }))} className={inputClass} />
            </div>
          </div>

          {/* Job Title (Profession) — standardized title from the
              admin-managed catalog. Different from Main Role: Main Role
              is the side-of-business categorization (Customer / Supplier
              / Consultant), Job Title is the actual profession the
              person practices (Architect, Civil Engineer, BIM Manager).
              Both are optional; Job Title can be set later via the
              partner drawer, but having it at creation saves a step. */}
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">
              Job Title <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <select
              value={form.primaryProfessionId}
              onChange={(e) => setForm((f) => ({ ...f, primaryProfessionId: e.target.value }))}
              className={inputClass}
              disabled={professions.length === 0}
            >
              <option value="">
                {professions.length === 0
                  ? 'No job titles configured — add some under /admin first'
                  : '— None / set later —'}
              </option>
              {professions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-400">
              The person's actual profession (e.g. Architect, MEP Engineer). Used by project role pickers to suggest qualified candidates. Add more titles from the partner profile after creation.
            </p>
          </div>

          {/* Main Role — the contact's primary categorization. Optional;
              if left blank the drawer will show a soft prompt later. */}
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">
              Main Role <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <select
              value={form.mainRoleTypeId}
              onChange={(e) => setForm((f) => ({ ...f, mainRoleTypeId: e.target.value }))}
              className={inputClass}
            >
              <option value="">— None / set later —</option>
              {personRoleTypes.map((rt) => (
                <option key={rt.id} value={rt.id}>{rt.name}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-400">
              Primary categorization (Customer, Supplier, Consultant…). Project-level responsibilities are set via relationships.
            </p>
          </div>

          {/* Employer + role-in-context */}
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Employer (organization)</label>
            {lockEmployer && form.employerOrgId ? (
              // When the caller passes lockEmployer, we render the chosen org
              // as static text + a hidden value. The user is in a flow that
              // explicitly says "add a contact for THIS customer/supplier" —
              // letting them switch the employer would defeat the point.
              <div className={`${inputClass} bg-slate-50 text-slate-700 cursor-not-allowed flex items-center justify-between`}>
                <span className="font-medium">
                  {orgs.find((o) => String(o.id) === String(form.employerOrgId))?.displayName
                    ?? `Organization #${form.employerOrgId}`}
                </span>
                <span className="text-[10px] uppercase tracking-wider text-slate-400">Locked</span>
              </div>
            ) : (
              <select value={form.employerOrgId} onChange={(e) => setForm(f => ({ ...f, employerOrgId: e.target.value }))} className={inputClass}>
                <option value="">— None / unaffiliated —</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>{o.displayName}</option>
                ))}
              </select>
            )}
            <p className="text-[11px] text-slate-400 mt-1">
              Creates a <code>worker_of</code> relationship — the contact's "context" is defined here.
            </p>
          </div>
          {form.employerOrgId && (
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Role at the organization (optional)</label>
              <input
                value={form.roleInContext}
                onChange={(e) => setForm(f => ({ ...f, roleInContext: e.target.value }))}
                placeholder='e.g. "Operations Manager", "Buyer"'
                className={inputClass}
              />
            </div>
          )}

          {/* Contact details */}
          <div className="space-y-3">
            <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Contact details</h3>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Email</label>
              <input type="email" value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))} className={inputClass} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Phone</label>
                <input value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} className={inputClass} />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Mobile</label>
                <input value={form.mobile} onChange={(e) => setForm(f => ({ ...f, mobile: e.target.value }))} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Online presence */}
          <div className="space-y-3">
            <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Online presence</h3>
            <SocialField icon={<Linkedin className="h-4 w-4 text-[#0a66c2]" />} label="LinkedIn"  value={form.linkedinUrl}  onChange={(v) => setForm(f => ({ ...f, linkedinUrl: v }))}  placeholder="https://linkedin.com/in/..." />
            <SocialField icon={<Facebook className="h-4 w-4 text-[#1877f2]" />} label="Facebook"  value={form.facebookUrl}  onChange={(v) => setForm(f => ({ ...f, facebookUrl: v }))}  placeholder="https://facebook.com/..." />
            <SocialField icon={<Twitter  className="h-4 w-4 text-[#1da1f2]" />} label="Twitter / X" value={form.twitterUrl}   onChange={(v) => setForm(f => ({ ...f, twitterUrl: v }))}   placeholder="https://x.com/..." />
            <SocialField icon={<Instagram className="h-4 w-4 text-[#e4405f]" />} label="Instagram" value={form.instagramUrl} onChange={(v) => setForm(f => ({ ...f, instagramUrl: v }))} placeholder="https://instagram.com/..." />
            <div>
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Website</label>
              <input value={form.website} onChange={(e) => setForm(f => ({ ...f, website: e.target.value }))} placeholder="https://example.com" className={inputClass} />
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Notes</label>
            <textarea value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} rows={3} className={cn(inputClass, 'resize-none')} />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 sticky bottom-0 bg-white">
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

function SocialField({ icon, label, value, onChange, placeholder }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <label className="text-[13px] font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
        {icon}
        {label}
      </label>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputClass} />
    </div>
  );
}
