import { useState, useEffect, useMemo } from 'react';
import { X, User as UserIcon, Building2, Pencil, Trash2, Plus, Save, ChevronRight, Briefcase, FolderKanban, Linkedin, Facebook, Twitter, Instagram } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { usePermissions } from '@/hooks/use-permissions';
import { formatDate } from '@/lib/date-utils';

const inputClass = 'w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none';

interface RoleType { id: number; code: string; name: string }
interface RelationshipType { id: number; code: string; name: string; applicableTargetTypes: string | null }

interface PartnerRole {
  id: number;
  isPrimary: boolean;
  roleType: RoleType;
}

interface Relationship {
  id: number;
  targetType: 'project' | 'organization' | 'department' | 'team';
  targetId: number;
  roleInContext: string | null;
  isPrimary: boolean;
  validFrom: string | null;
  validTo: string | null;
  status: string;
  notes: string | null;
  relationshipType: RelationshipType;
}

interface BusinessPartnerFull {
  id: number;
  partnerType: 'person' | 'organization';
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  address: string | null;
  website: string | null;
  linkedinUrl: string | null;
  facebookUrl: string | null;
  twitterUrl: string | null;
  instagramUrl: string | null;
  status: string;
  source: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  roles: PartnerRole[];
  outgoingRelationships: Relationship[];
  user: { id: number; isActive: boolean; lastLoginAt: string | null } | null;
}

export function PartnerDrawer({
  partnerId,
  onClose,
}: {
  partnerId: number;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'details' | 'roles' | 'relationships'>('details');
  const { can, isAdmin } = usePermissions();
  const canWrite = isAdmin || can('partners', 'write');
  const canDelete = isAdmin || can('partners', 'delete');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const { data: bp, isLoading } = useQuery<BusinessPartnerFull>({
    queryKey: ['business-partners', partnerId],
    queryFn: () => client.get(`/business-partners/${partnerId}`).then((r) => r.data?.data ?? r.data),
  });

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-[560px] max-w-[92vw] bg-white border-l border-slate-200 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-slate-200 px-5 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 text-blue-700 shrink-0">
            {bp?.partnerType === 'organization' ? <Building2 className="h-5 w-5" /> : <UserIcon className="h-5 w-5" />}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-slate-900 truncate">{bp?.displayName ?? '...'}</h2>
            <p className="text-[11px] text-slate-400">
              {bp?.partnerType === 'organization' ? 'Organization' : 'Person'}
              {bp?.user && ' · Has login account'}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-slate-100 text-slate-400 hover:text-slate-600 shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200 px-5">
          {([
            { key: 'details',      label: 'Details' },
            { key: 'roles',        label: `Roles${bp ? ` (${bp.roles.length})` : ''}` },
            { key: 'relationships',label: `Relationships${bp ? ` (${bp.outgoingRelationships.length})` : ''}` },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'border-b-2 px-3 py-2 text-xs font-semibold transition-colors',
                tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading || !bp ? (
            <div className="text-sm text-slate-400 text-center py-8">Loading...</div>
          ) : tab === 'details' ? (
            <DetailsTab bp={bp} canWrite={canWrite} canDelete={canDelete} onClose={onClose} />
          ) : tab === 'roles' ? (
            <RolesTab bp={bp} canWrite={canWrite} canDelete={canDelete} />
          ) : (
            <RelationshipsTab bp={bp} canWrite={canWrite} canDelete={canDelete} />
          )}
        </div>
      </div>
    </>
  );
}

// ─── Details ─────────────────────────────────────────────────────────────────

function DetailsTab({ bp, canWrite, canDelete, onClose }: { bp: BusinessPartnerFull; canWrite: boolean; canDelete: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  // Active worker_of relationship (persons only) — defines the contact's employer.
  const employerRel = useMemo(
    () => bp.outgoingRelationships.find(
      (r) => r.relationshipType.code === 'worker_of'
        && r.targetType === 'organization'
        && r.status === 'active',
    ),
    [bp.outgoingRelationships],
  );

  // Fetch organizations for the employer dropdown (persons only, in edit mode).
  const { data: orgs = [] } = useQuery<any[]>({
    queryKey: ['organizations-list'],
    enabled: editing && bp.partnerType === 'person',
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/business-partners?partnerType=organization&perPage=200').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });

  const employerOrg = useMemo(
    () => orgs.find((o) => o.id === employerRel?.targetId)
      ?? (employerRel ? { id: employerRel.targetId, displayName: bp.companyName ?? 'Unknown' } : null),
    [orgs, employerRel, bp.companyName],
  );

  const [form, setForm] = useState({
    firstName: bp.firstName ?? '',
    lastName: bp.lastName ?? '',
    companyName: bp.companyName ?? '',
    taxId: bp.taxId ?? '',
    email: bp.email ?? '',
    phone: bp.phone ?? '',
    mobile: bp.mobile ?? '',
    website: bp.website ?? '',
    linkedinUrl: bp.linkedinUrl ?? '',
    facebookUrl: bp.facebookUrl ?? '',
    twitterUrl: bp.twitterUrl ?? '',
    instagramUrl: bp.instagramUrl ?? '',
    address: bp.address ?? '',
    notes: bp.notes ?? '',
    status: bp.status,
    // Persons-only — id of org chosen from the employer dropdown.
    employerOrgId: employerRel?.targetId ?? null,
  });

  // Re-sync employerOrgId when relationships load.
  useEffect(() => {
    setForm((f) => ({ ...f, employerOrgId: employerRel?.targetId ?? null }));
  }, [employerRel?.targetId]);

  const update = useMutation({
    mutationFn: async () => {
      // 1. Update plain BP fields.
      await client.patch(`/business-partners/${bp.id}`, {
        firstName: bp.partnerType === 'person' ? form.firstName.trim() || null : undefined,
        lastName: bp.partnerType === 'person' ? form.lastName.trim() || null : undefined,
        companyName: bp.partnerType === 'organization' ? form.companyName.trim() || null : undefined,
        taxId: form.taxId.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        mobile: form.mobile.trim() || null,
        website: form.website.trim() || null,
        linkedinUrl: form.linkedinUrl.trim() || null,
        facebookUrl: form.facebookUrl.trim() || null,
        twitterUrl: form.twitterUrl.trim() || null,
        instagramUrl: form.instagramUrl.trim() || null,
        address: form.address.trim() || null,
        notes: form.notes.trim() || null,
        status: form.status,
      });

      // 2. For persons, sync the worker_of relationship to the chosen employer.
      if (bp.partnerType === 'person') {
        const newEmployerId = form.employerOrgId;
        const oldEmployerId = employerRel?.targetId ?? null;
        if (newEmployerId !== oldEmployerId) {
          // End the old worker_of (soft-delete) if it existed.
          if (employerRel) {
            await client.delete(`/business-partner-relationships/${employerRel.id}`).catch(() => undefined);
          }
          // Create the new one if employer is set.
          if (newEmployerId) {
            const relTypes = await client.get('/admin/partner-types/relationship-types')
              .then((r) => r.data?.data ?? r.data ?? []);
            const workerOf = (Array.isArray(relTypes) ? relTypes : []).find((rt: any) => rt.code === 'worker_of');
            if (workerOf) {
              await client.post('/business-partner-relationships', {
                sourcePartnerId: bp.id,
                targetType: 'organization',
                targetId: newEmployerId,
                relationshipTypeId: workerOf.id,
                isPrimary: true,
              }).catch(() => undefined);
            }
          }
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      notify.success('Partner updated', { code: 'BP-UPDATE-200' });
      setEditing(false);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update partner'),
  });

  const remove = useMutation({
    mutationFn: () => client.delete(`/business-partners/${bp.id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      notify.success('Partner removed', { code: 'BP-DELETE-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove partner'),
  });

  const Field = ({ label, value, render }: { label: string; value: string | null | undefined; render?: () => React.ReactNode }) => (
    <div>
      <label className="text-[11px] font-semibold text-slate-400 uppercase">{label}</label>
      <p className="mt-1 text-[13px] text-slate-700">{render ? render() : (value || <span className="italic text-slate-400">—</span>)}</p>
    </div>
  );

  if (!editing) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-end gap-2">
          {canWrite && (
            <button onClick={() => setEditing(true)} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[12px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1">
              <Pencil className="h-3 w-3" /> Edit
            </button>
          )}
          {canDelete && !bp.user && (
            <button
              onClick={() => { if (confirm(`Remove "${bp.displayName}"?`)) remove.mutate(); }}
              className="bg-white border border-red-200 hover:border-red-400 text-red-600 text-[12px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1"
            >
              <Trash2 className="h-3 w-3" /> Remove
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          {bp.partnerType === 'person' && (
            <>
              <Field label="First Name" value={bp.firstName} />
              <Field label="Last Name" value={bp.lastName} />
            </>
          )}
          {bp.partnerType === 'organization' ? (
            <Field label="Company Name" value={bp.companyName} />
          ) : (
            <Field
              label="Employer"
              value={employerRel ? (employerOrg?.displayName ?? bp.companyName ?? `#${employerRel.targetId}`) : null}
              render={() => employerRel
                ? <span className="text-slate-700">{employerOrg?.displayName ?? bp.companyName ?? `#${employerRel.targetId}`}{employerRel.roleInContext ? <span className="text-slate-400"> · {employerRel.roleInContext}</span> : null}</span>
                : <span className="italic text-slate-400">—</span>
              }
            />
          )}
          {bp.partnerType === 'organization' && <Field label="Tax ID" value={bp.taxId} />}
          <Field label="Email" value={bp.email} />
          <Field label="Phone" value={bp.phone} />
          <Field label="Mobile" value={bp.mobile} />
          <Field label="Website" value={bp.website} render={() => bp.website ? (
            <a href={bp.website} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{bp.website}</a>
          ) : <span className="italic text-slate-400">—</span>} />
          <Field label="Address" value={bp.address} />
          <Field label="Status" value={bp.status} render={() => (
            <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', bp.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500')}>
              {bp.status}
            </span>
          )} />
          <Field label="Source" value={bp.source} />
        </div>

        {/* Social / online presence — only show when at least one is set */}
        {(bp.linkedinUrl || bp.facebookUrl || bp.twitterUrl || bp.instagramUrl) && (
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase">Online presence</label>
            <div className="mt-1.5 flex items-center gap-2">
              {bp.linkedinUrl && (
                <a href={bp.linkedinUrl} target="_blank" rel="noopener noreferrer" title={bp.linkedinUrl} className="rounded-md p-1.5 hover:bg-slate-100">
                  <Linkedin className="h-4 w-4 text-[#0a66c2]" />
                </a>
              )}
              {bp.facebookUrl && (
                <a href={bp.facebookUrl} target="_blank" rel="noopener noreferrer" title={bp.facebookUrl} className="rounded-md p-1.5 hover:bg-slate-100">
                  <Facebook className="h-4 w-4 text-[#1877f2]" />
                </a>
              )}
              {bp.twitterUrl && (
                <a href={bp.twitterUrl} target="_blank" rel="noopener noreferrer" title={bp.twitterUrl} className="rounded-md p-1.5 hover:bg-slate-100">
                  <Twitter className="h-4 w-4 text-[#1da1f2]" />
                </a>
              )}
              {bp.instagramUrl && (
                <a href={bp.instagramUrl} target="_blank" rel="noopener noreferrer" title={bp.instagramUrl} className="rounded-md p-1.5 hover:bg-slate-100">
                  <Instagram className="h-4 w-4 text-[#e4405f]" />
                </a>
              )}
            </div>
          </div>
        )}

        {bp.notes && (
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase">Notes</label>
            <p className="mt-1 text-[13px] text-slate-700 whitespace-pre-wrap">{bp.notes}</p>
          </div>
        )}

        <div className="text-[11px] text-slate-400 pt-3 border-t border-slate-100">
          Created {formatDate(bp.createdAt)} · Updated {formatDate(bp.updatedAt)}
        </div>

        {bp.user && (
          <div className="rounded-md bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
            🔐 This partner has a login account (user id={bp.user.id}). Manage credentials from <strong>People → Reset Password</strong>.
          </div>
        )}
      </div>
    );
  }

  // Editing mode
  return (
    <div className="space-y-3">
      {bp.partnerType === 'person' && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">First Name</label>
            <input value={form.firstName} onChange={(e) => setForm(f => ({ ...f, firstName: e.target.value }))} className={inputClass} />
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Last Name</label>
            <input value={form.lastName} onChange={(e) => setForm(f => ({ ...f, lastName: e.target.value }))} className={inputClass} />
          </div>
        </div>
      )}
      {bp.partnerType === 'organization' ? (
        <>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Company Name</label>
            <input value={form.companyName} onChange={(e) => setForm(f => ({ ...f, companyName: e.target.value }))} className={inputClass} />
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Tax ID</label>
            <input value={form.taxId} onChange={(e) => setForm(f => ({ ...f, taxId: e.target.value }))} className={inputClass} />
          </div>
        </>
      ) : (
        <div>
          <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Employer (organization)</label>
          <select
            value={form.employerOrgId ?? ''}
            onChange={(e) => setForm(f => ({ ...f, employerOrgId: e.target.value ? Number(e.target.value) : null }))}
            className={inputClass}
          >
            <option value="">— No employer —</option>
            {employerOrg && !orgs.some((o) => o.id === employerOrg.id) && (
              <option value={employerOrg.id}>{employerOrg.displayName}</option>
            )}
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>{o.displayName}</option>
            ))}
          </select>
          <p className="text-[11px] text-slate-400 mt-1">
            Saving will sync the <code>worker_of</code> relationship to this organization.
          </p>
        </div>
      )}
      <div>
        <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Email</label>
        <input type="email" value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))} className={inputClass} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Phone</label>
          <input value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} className={inputClass} />
        </div>
        <div>
          <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Mobile</label>
          <input value={form.mobile} onChange={(e) => setForm(f => ({ ...f, mobile: e.target.value }))} className={inputClass} />
        </div>
      </div>
      <div>
        <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Website</label>
        <input value={form.website} onChange={(e) => setForm(f => ({ ...f, website: e.target.value }))} placeholder="https://..." className={inputClass} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <SocialEditField icon={<Linkedin className="h-3.5 w-3.5 text-[#0a66c2]" />} label="LinkedIn"   value={form.linkedinUrl}  onChange={(v) => setForm(f => ({ ...f, linkedinUrl: v }))}  />
        <SocialEditField icon={<Facebook className="h-3.5 w-3.5 text-[#1877f2]" />} label="Facebook"   value={form.facebookUrl}  onChange={(v) => setForm(f => ({ ...f, facebookUrl: v }))}  />
        <SocialEditField icon={<Twitter  className="h-3.5 w-3.5 text-[#1da1f2]" />} label="Twitter / X" value={form.twitterUrl}   onChange={(v) => setForm(f => ({ ...f, twitterUrl: v }))}   />
        <SocialEditField icon={<Instagram className="h-3.5 w-3.5 text-[#e4405f]" />} label="Instagram"  value={form.instagramUrl} onChange={(v) => setForm(f => ({ ...f, instagramUrl: v }))} />
      </div>
      <div>
        <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Address</label>
        <input value={form.address} onChange={(e) => setForm(f => ({ ...f, address: e.target.value }))} className={inputClass} />
      </div>
      <div>
        <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Status</label>
        <select value={form.status} onChange={(e) => setForm(f => ({ ...f, status: e.target.value }))} className={inputClass}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>
      <div>
        <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Notes</label>
        <textarea value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} rows={3} className={cn(inputClass, 'resize-none')} />
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
        <button type="button" onClick={() => setEditing(false)} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[12px] font-semibold px-3 py-1.5 rounded-lg">Cancel</button>
        <button onClick={() => update.mutate()} disabled={update.isPending} className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50 flex items-center gap-1">
          <Save className="h-3 w-3" /> {update.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ─── Roles ───────────────────────────────────────────────────────────────────

function RolesTab({ bp, canWrite, canDelete }: { bp: BusinessPartnerFull; canWrite: boolean; canDelete: boolean }) {
  const queryClient = useQueryClient();
  const { data: allRoleTypes = [] } = useQuery<RoleType[]>({
    queryKey: ['partner-role-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/partner-types/role-types').then((r) => r.data?.data ?? r.data ?? []),
  });

  const assigned = new Set(bp.roles.map((r) => r.roleType.id));
  const available = allRoleTypes.filter((rt) => !assigned.has(rt.id));

  const addRole = useMutation({
    mutationFn: (roleTypeId: number) =>
      client.post(`/business-partners/${bp.id}/roles`, { roleTypeId }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      notify.success('Role added', { code: 'BP-ROLE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add role'),
  });

  const removeRole = useMutation({
    mutationFn: (roleId: number) =>
      client.delete(`/business-partners/${bp.id}/roles/${roleId}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      notify.success('Role removed', { code: 'BP-ROLE-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove role'),
  });

  const togglePrimary = useMutation({
    mutationFn: ({ roleTypeId, isPrimary }: { roleTypeId: number; isPrimary: boolean }) =>
      client.post(`/business-partners/${bp.id}/roles`, { roleTypeId, isPrimary }).then((r) => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['business-partners'] }),
    onError: (err: any) => notify.apiError(err, 'Failed to update'),
  });

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold text-slate-400 uppercase mb-2">Current roles</p>
        {bp.roles.length === 0 ? (
          <p className="text-[12px] text-slate-400 italic">No roles assigned.</p>
        ) : (
          <div className="space-y-1.5">
            {bp.roles.map((r) => (
              <div key={r.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
                <Briefcase className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                <span className="text-[13px] font-medium text-slate-800 flex-1">{r.roleType.name}</span>
                {canWrite && (
                  <button
                    onClick={() => togglePrimary.mutate({ roleTypeId: r.roleType.id, isPrimary: !r.isPrimary })}
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-semibold border transition-colors',
                      r.isPrimary
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300',
                    )}
                  >
                    {r.isPrimary ? 'Primary' : 'Set primary'}
                  </button>
                )}
                {canDelete && (
                  <button
                    onClick={() => { if (confirm(`Remove role "${r.roleType.name}"?`)) removeRole.mutate(r.id); }}
                    className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-600"
                    title="Remove role"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {canWrite && available.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-slate-400 uppercase mb-2">Add a role</p>
          <div className="flex flex-wrap gap-2">
            {available.map((rt) => (
              <button
                key={rt.id}
                onClick={() => addRole.mutate(rt.id)}
                disabled={addRole.isPending}
                className="rounded-full border border-slate-200 bg-white hover:border-blue-400 hover:bg-blue-50 text-slate-700 hover:text-blue-700 text-[12px] font-medium px-3 py-1 flex items-center gap-1"
              >
                <Plus className="h-3 w-3" />
                {rt.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Relationships ───────────────────────────────────────────────────────────

function RelationshipsTab({ bp, canWrite, canDelete }: { bp: BusinessPartnerFull; canWrite: boolean; canDelete: boolean }) {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);

  const grouped = bp.outgoingRelationships.reduce<Record<string, Relationship[]>>((acc, r) => {
    (acc[r.targetType] ||= []).push(r);
    return acc;
  }, {});

  const remove = useMutation({
    mutationFn: (id: number) => client.delete(`/business-partner-relationships/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      notify.success('Relationship removed', { code: 'BP-REL-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove'),
  });

  const renderGroup = (label: string, type: string, icon: React.ReactNode) => {
    const items = grouped[type] || [];
    if (items.length === 0) return null;
    return (
      <div>
        <p className="text-[11px] font-semibold text-slate-400 uppercase mb-2 flex items-center gap-1.5">{icon}{label} ({items.length})</p>
        <div className="space-y-1.5">
          {items.map((r) => (
            <div key={r.id} className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-slate-800">{r.relationshipType.name}</span>
                  {r.isPrimary && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">PRIMARY</span>}
                </div>
                {r.roleInContext && <p className="text-[12px] text-slate-600">{r.roleInContext}</p>}
                <p className="text-[11px] text-slate-400 font-mono">{r.targetType} #{r.targetId}</p>
                {(r.validFrom || r.validTo) && (
                  <p className="text-[10px] text-slate-400">
                    {r.validFrom ? `from ${formatDate(r.validFrom)}` : ''}
                    {r.validTo ? ` to ${formatDate(r.validTo)}` : ''}
                  </p>
                )}
              </div>
              {canDelete && (
                <button
                  onClick={() => { if (confirm('Remove this relationship?')) remove.mutate(r.id); }}
                  className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-600 shrink-0"
                  title="Remove"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {bp.outgoingRelationships.length === 0 && (
        <p className="text-[12px] text-slate-400 italic text-center py-6">No relationships yet.</p>
      )}

      {renderGroup('Organizations', 'organization', <Building2 className="h-3 w-3" />)}
      {renderGroup('Projects', 'project', <FolderKanban className="h-3 w-3" />)}
      {renderGroup('Departments', 'department', <ChevronRight className="h-3 w-3" />)}
      {renderGroup('Teams', 'team', <ChevronRight className="h-3 w-3" />)}

      {canWrite && (
        <div className="pt-2 border-t border-slate-100">
          <button
            onClick={() => setShowAdd(true)}
            className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1"
          >
            <Plus className="h-3 w-3" /> Add relationship
          </button>
        </div>
      )}

      {showAdd && (
        <AddRelationshipModal
          partnerId={bp.id}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}

// ─── Add Relationship Modal ──────────────────────────────────────────────────

function AddRelationshipModal({ partnerId, onClose }: { partnerId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [targetType, setTargetType] = useState<'project' | 'organization'>('project');
  const [targetId, setTargetId] = useState<number | null>(null);
  const [relationshipTypeId, setRelationshipTypeId] = useState<number | null>(null);
  const [roleInContext, setRoleInContext] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  const { data: relTypes = [] } = useQuery<RelationshipType[]>({
    queryKey: ['partner-relationship-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/partner-types/relationship-types').then((r) => r.data?.data ?? r.data ?? []),
  });

  const { data: projects = [] } = useQuery<any[]>({
    queryKey: ['projects-for-rel'],
    enabled: targetType === 'project',
    queryFn: () => client.get('/projects?perPage=200').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });

  const { data: orgs = [] } = useQuery<any[]>({
    queryKey: ['orgs-for-rel'],
    enabled: targetType === 'organization',
    queryFn: () => client.get('/business-partners?partnerType=organization&perPage=200').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });

  const applicableRelTypes = relTypes.filter((rt) => {
    if (!rt.applicableTargetTypes) return true;
    return rt.applicableTargetTypes.split(',').map((s) => s.trim()).includes(targetType);
  });

  const create = useMutation({
    mutationFn: () =>
      client.post('/business-partner-relationships', {
        sourcePartnerId: partnerId,
        targetType,
        targetId,
        relationshipTypeId,
        roleInContext: roleInContext.trim() || undefined,
        isPrimary,
      }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      notify.success('Relationship added', { code: 'BP-REL-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add relationship'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetId || !relationshipTypeId) {
      notify.warning('Select a target and a relationship type', { code: 'BP-REL-400' });
      return;
    }
    create.mutate();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[460px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-base font-bold text-slate-900">Add Relationship</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-3">
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Target type</label>
            <div className="grid grid-cols-2 gap-2">
              {(['project', 'organization'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => { setTargetType(t); setTargetId(null); }}
                  className={cn(
                    'rounded-lg border-2 px-3 py-2 text-sm font-medium capitalize',
                    targetType === t ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">{targetType === 'project' ? 'Project' : 'Organization'}</label>
            <select value={targetId ?? ''} onChange={(e) => setTargetId(Number(e.target.value) || null)} className={inputClass}>
              <option value="">Select...</option>
              {targetType === 'project'
                ? projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)
                : orgs.map((o: any) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Relationship type</label>
            <select value={relationshipTypeId ?? ''} onChange={(e) => setRelationshipTypeId(Number(e.target.value) || null)} className={inputClass}>
              <option value="">Select...</option>
              {applicableRelTypes.map((rt) => <option key={rt.id} value={rt.id}>{rt.name}</option>)}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Role in context (optional)</label>
            <input
              value={roleInContext}
              onChange={(e) => setRoleInContext(e.target.value)}
              placeholder='e.g. "Operations Manager"'
              className={inputClass}
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700 pt-1">
            <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-blue-600" />
            Mark as primary
          </label>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[12px] font-semibold px-3 py-1.5 rounded-lg">Cancel</button>
            <button type="submit" disabled={create.isPending} className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50">
              {create.isPending ? 'Adding...' : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SocialEditField({ icon, label, value, onChange }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 flex items-center gap-1.5">
        {icon}
        {label}
      </label>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="https://..." className={inputClass} />
    </div>
  );
}
