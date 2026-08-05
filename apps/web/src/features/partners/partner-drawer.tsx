import { useState, useEffect, useMemo } from 'react';
import { X, User as UserIcon, Building2, Pencil, Trash2, Plus, Save, ChevronRight, Briefcase, FolderKanban, Linkedin, Facebook, Twitter, Instagram } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { usePermissions } from '@/hooks/use-permissions';
import { formatDate } from '@/lib/date-utils';
import { useConfirm } from '@/components/shared/confirm-dialog';

const inputClass = 'w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none';

interface RoleType { id: number; code: string; name: string; category?: string | null }
interface SideTarget {
  kind: 'person' | 'organization' | 'project' | 'any';
  roleCodes?: string[];
  categoryCodes?: string[];
}

interface RelationshipType {
  id: number;
  code: string;
  name: string;
  applicableTargetTypes: string | null;
  // M3a — display labels.
  sideALabel: string | null;
  sideBLabel: string | null;
  inverseLabel: string | null;
  // M3.5 — structured targets (preferred).
  sideATargets: SideTarget[] | null;
  sideBTargets: SideTarget[] | null;
  // Legacy single-kind shim.
  sideAKind: string | null;
  sideBKind: string | null;
}

interface PartnerRole {
  id: number;
  isPrimary: boolean;
  roleType: RoleType;
}

interface RelationshipTarget {
  /** Human-readable name of the target (project name, org displayName, dept name). */
  targetName?: string;
  /** Optional secondary code (e.g. project.number, department.code). */
  targetCode?: string | null;
}

/**
 * A relationship where this partner is the TARGET (not the source).
 * Used to render lines like "Has contact: Sarah Smith" on the customer's
 * drawer — the inverse view of an outgoing 'Contact of customer' on Sarah.
 */
interface IncomingRelationship {
  id: number;
  relationshipType: RelationshipType;
  sourcePartnerId: number;
  sourceName: string;
  sourceKind: 'person' | 'organization';
  roleInContext: string | null;
  isPrimary: boolean;
  validFrom: string | null;
  validTo: string | null;
  status: string;
  notes: string | null;
}

interface Relationship extends RelationshipTarget {
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
  incomingRelationships: IncomingRelationship[];
  user: { id: number; isActive: boolean; lastLoginAt: string | null } | null;
  /**
   * Main Role — single primary categorization of the contact.
   * Optional (null on legacy BPs); drawer surfaces a soft prompt to set one.
   * Replaces the per-BP role chips (which still exist on disk as history
   * until M7 cleanup).
   */
  mainRoleTypeId: number | null;
  mainRoleType: RoleType | null;
}

export function PartnerDrawer({
  partnerId,
  onClose,
}: {
  partnerId: number;
  onClose: () => void;
}) {
  // Tabs simplified to (details | relationships). The legacy Roles tab is
  // gone — single Main Role lives in the header (see MainRoleHeaderField).
  // All additional role context is expressed via Relationships.
  const [tab, setTab] = useState<'details' | 'relationships'>('details');
  const { can, isAdmin } = usePermissions();
  const canWrite = isAdmin || can('partners', 'write');
  const canDelete = isAdmin || can('partners', 'delete');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const { data: bp, isLoading, isError, refetch } = useQuery<BusinessPartnerFull>({
    queryKey: ['business-partners', partnerId],
    queryFn: () => client.get(`/business-partners/${partnerId}`).then((r) => r.data?.data ?? r.data),
  });

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-[560px] max-w-[92vw] bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-700 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-slate-200 dark:border-slate-700 px-5 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 text-blue-700 shrink-0">
            {bp?.partnerType === 'organization' ? <Building2 className="h-5 w-5" /> : <UserIcon className="h-5 w-5" />}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 truncate">{bp?.displayName ?? '...'}</h2>
            <p className="text-[11px] text-slate-400 dark:text-slate-500">
              {bp?.partnerType === 'organization' ? 'Organization' : 'Person'}
              {bp?.user && ' · Has login account'}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 shrink-0" aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>

        {/* Main Role strip — single primary categorization. Always
            visible (header-adjacent) so a missing value is obvious
            and one click sets it. Sits BETWEEN the header and the
            tab bar so it doesn't compete with tab navigation. */}
        {bp && <MainRoleHeaderField bp={bp} canWrite={canWrite} />}

        {/* Tabs */}
        <div className="flex border-b border-slate-200 dark:border-slate-700 px-5">
          {([
            { key: 'details',      label: 'Details' },
            { key: 'relationships',label: `Relationships${bp ? ` (${(bp.outgoingRelationships?.length ?? 0) + (bp.incomingRelationships?.length ?? 0)})` : ''}` },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'border-b-2 px-3 py-2 text-xs font-semibold transition-colors',
                tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isError ? (
            <div className="text-sm text-slate-400 dark:text-slate-500 text-center py-8">
              Couldn't load this partner.{' '}
              <button onClick={() => refetch()} className="font-medium text-blue-600 hover:underline">Retry</button>
            </div>
          ) : isLoading || !bp ? (
            <div className="text-sm text-slate-400 dark:text-slate-500 text-center py-8">Loading...</div>
          ) : tab === 'details' ? (
            <DetailsTab bp={bp} canWrite={canWrite} canDelete={canDelete} onClose={onClose} />
          ) : (
            <RelationshipsTab bp={bp} canWrite={canWrite} canDelete={canDelete} />
          )}
        </div>
      </div>
    </>
  );
}

// ─── Main Role header strip ──────────────────────────────────────────────────
//
// Single primary categorization of the contact. Replaces the legacy
// per-BP role chips. Three states:
//   1. Unset + write permission  → yellow soft-prompt with inline dropdown
//   2. Set                        → compact "Main role: Customer" pill
//                                  (click pill → reveals dropdown for change)
//   3. Unset + no write permission → silent (nothing rendered)
//
// Dropdown options are filtered by appliesToKind: a person sees roles
// where appliesToKind in ('person','any'); an org sees ('organization','any').
// That way "Employee" doesn't show up on an org, and "Supplier" doesn't
// show up on a person.
function MainRoleHeaderField({ bp, canWrite }: { bp: BusinessPartnerFull; canWrite: boolean }) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(false);

  const { data: allRoleTypes = [] } = useQuery<RoleType[] & { appliesToKind?: string }[]>({
    queryKey: ['partner-role-types'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/admin/partner-types/role-types').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
  });

  // Filter the dropdown by the BP's kind. Catalog rows tagged 'any' are
  // shown for both. Also drop the 'employee' role from this dropdown —
  // the employee identity is granted by creating a User from the
  // Employees admin, not by tagging a partner here.
  const options = useMemo(() => {
    return allRoleTypes.filter((rt: any) => {
      if (rt.code === 'employee') return false;
      const kind = rt.appliesToKind ?? 'any';
      return kind === 'any' || kind === bp.partnerType;
    });
  }, [allRoleTypes, bp.partnerType]);

  const setRole = useMutation({
    mutationFn: (mainRoleTypeId: number | null) =>
      client.patch(`/business-partners/${bp.id}`, { mainRoleTypeId }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      queryClient.invalidateQueries({ queryKey: ['business-partners', bp.id] });
      notify.success('Main role updated', { code: 'BP-MAINROLE-200' });
      setPicking(false);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update main role'),
  });

  // Inline dropdown view — used by both the soft-prompt and the
  // change-role flow once a role is already set.
  const DropdownRow = (
    <select
      autoFocus
      value={bp.mainRoleTypeId ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        setRole.mutate(v === '' ? null : Number(v));
      }}
      onBlur={() => setPicking(false)}
      className="text-[12px] rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1 text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
    >
      <option value="">— None —</option>
      {options.map((rt) => (
        <option key={rt.id} value={rt.id}>{rt.name}</option>
      ))}
    </select>
  );

  // State 1 — unset and admin can write: soft prompt.
  if (!bp.mainRoleType && canWrite) {
    return (
      <div className="border-b border-amber-100 bg-amber-50/60 px-5 py-2 flex items-center gap-2">
        <span className="text-[11px] font-semibold text-amber-700">Main role not set</span>
        {DropdownRow}
        <span className="text-[10px] text-amber-600/80">Set the contact's primary categorization (Customer, Supplier, Consultant, ...)</span>
      </div>
    );
  }

  // State 3 — unset and no write permission: render nothing (the
  // viewer can't act on it; don't clutter the header).
  if (!bp.mainRoleType) return null;

  // State 2 — set: compact pill. Click to change (write only).
  return (
    <div className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/40 px-5 py-2 flex items-center gap-2">
      <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase">Main role</span>
      {picking ? (
        DropdownRow
      ) : (
        <button
          type="button"
          disabled={!canWrite}
          onClick={() => canWrite && setPicking(true)}
          className={cn(
            'text-[12px] font-semibold rounded-full px-2.5 py-0.5',
            'bg-blue-100 text-blue-700',
            canWrite ? 'hover:bg-blue-200 cursor-pointer' : 'cursor-default',
          )}
          title={canWrite ? 'Change main role' : ''}
        >
          {bp.mainRoleType.name}
        </button>
      )}
    </div>
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
      <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase">{label}</label>
      <p className="mt-1 text-[13px] text-slate-700 dark:text-slate-200">{render ? render() : (value || <span className="italic text-slate-400 dark:text-slate-500">—</span>)}</p>
    </div>
  );

  if (!editing) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-end gap-2">
          {canWrite && (
            <button onClick={() => setEditing(true)} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[12px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1">
              <Pencil className="h-3 w-3" /> Edit
            </button>
          )}
          {canDelete && !bp.user && (
            <button
              onClick={async () => { if (await confirm(`Remove "${bp.displayName}"?`)) remove.mutate(); }}
              className="bg-white dark:bg-slate-900 border border-red-200 hover:border-red-400 text-red-600 text-[12px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1"
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
                ? <span className="text-slate-700 dark:text-slate-200">{employerOrg?.displayName ?? bp.companyName ?? `#${employerRel.targetId}`}{employerRel.roleInContext ? <span className="text-slate-400 dark:text-slate-500"> · {employerRel.roleInContext}</span> : null}</span>
                : <span className="italic text-slate-400 dark:text-slate-500">—</span>
              }
            />
          )}
          {bp.partnerType === 'organization' && <Field label="Tax ID" value={bp.taxId} />}
          <Field label="Email" value={bp.email} />
          <Field label="Phone" value={bp.phone} />
          <Field label="Mobile" value={bp.mobile} />
          <Field label="Website" value={bp.website} render={() => bp.website ? (
            <a href={bp.website} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{bp.website}</a>
          ) : <span className="italic text-slate-400 dark:text-slate-500">—</span>} />
          <Field label="Address" value={bp.address} />
          <Field label="Status" value={bp.status} render={() => (
            <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', bp.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400')}>
              {bp.status}
            </span>
          )} />
          <Field label="Source" value={bp.source} />
        </div>

        {/* Social / online presence — only show when at least one is set */}
        {(bp.linkedinUrl || bp.facebookUrl || bp.twitterUrl || bp.instagramUrl) && (
          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase">Online presence</label>
            <div className="mt-1.5 flex items-center gap-2">
              {bp.linkedinUrl && (
                <a href={bp.linkedinUrl} target="_blank" rel="noopener noreferrer" title={bp.linkedinUrl} className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800">
                  <Linkedin className="h-4 w-4 text-[#0a66c2]" />
                </a>
              )}
              {bp.facebookUrl && (
                <a href={bp.facebookUrl} target="_blank" rel="noopener noreferrer" title={bp.facebookUrl} className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800">
                  <Facebook className="h-4 w-4 text-[#1877f2]" />
                </a>
              )}
              {bp.twitterUrl && (
                <a href={bp.twitterUrl} target="_blank" rel="noopener noreferrer" title={bp.twitterUrl} className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800">
                  <Twitter className="h-4 w-4 text-[#1da1f2]" />
                </a>
              )}
              {bp.instagramUrl && (
                <a href={bp.instagramUrl} target="_blank" rel="noopener noreferrer" title={bp.instagramUrl} className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800">
                  <Instagram className="h-4 w-4 text-[#e4405f]" />
                </a>
              )}
            </div>
          </div>
        )}

        {bp.notes && (
          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase">Notes</label>
            <p className="mt-1 text-[13px] text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{bp.notes}</p>
          </div>
        )}

        {/* M4a.3 — Job Titles. Lives on the Details tab (used to live on
            the now-removed Roles tab). Persons only; organizations don't
            have a profession concept. Drives the "Required Job Title"
            constraint on Project Role Types. */}
        {bp.partnerType === 'person' && (
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
            <JobTitlesSection bpId={bp.id} canWrite={canWrite} />
          </div>
        )}

        <div className="text-[11px] text-slate-400 dark:text-slate-500 pt-3 border-t border-slate-100 dark:border-slate-800">
          Created {formatDate(bp.createdAt)} · Updated {formatDate(bp.updatedAt)}
        </div>

        {bp.user && (
          <div className="rounded-md bg-slate-50 dark:bg-slate-800/50 px-3 py-2 text-[12px] text-slate-600 dark:text-slate-300">
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
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">First Name</label>
            <input value={form.firstName} onChange={(e) => setForm(f => ({ ...f, firstName: e.target.value }))} className={inputClass} />
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Last Name</label>
            <input value={form.lastName} onChange={(e) => setForm(f => ({ ...f, lastName: e.target.value }))} className={inputClass} />
          </div>
        </div>
      )}
      {bp.partnerType === 'organization' ? (
        <>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Company Name</label>
            <input value={form.companyName} onChange={(e) => setForm(f => ({ ...f, companyName: e.target.value }))} className={inputClass} />
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Tax ID</label>
            <input value={form.taxId} onChange={(e) => setForm(f => ({ ...f, taxId: e.target.value }))} className={inputClass} />
          </div>
        </>
      ) : (
        <div>
          <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Employer (organization)</label>
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
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
            Saving will sync the <code>worker_of</code> relationship to this organization.
          </p>
        </div>
      )}
      <div>
        <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Email</label>
        <input type="email" value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))} className={inputClass} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Phone</label>
          <input value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} className={inputClass} />
        </div>
        <div>
          <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Mobile</label>
          <input value={form.mobile} onChange={(e) => setForm(f => ({ ...f, mobile: e.target.value }))} className={inputClass} />
        </div>
      </div>
      <div>
        <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Website</label>
        <input value={form.website} onChange={(e) => setForm(f => ({ ...f, website: e.target.value }))} placeholder="https://..." className={inputClass} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <SocialEditField icon={<Linkedin className="h-3.5 w-3.5 text-[#0a66c2]" />} label="LinkedIn"   value={form.linkedinUrl}  onChange={(v) => setForm(f => ({ ...f, linkedinUrl: v }))}  />
        <SocialEditField icon={<Facebook className="h-3.5 w-3.5 text-[#1877f2]" />} label="Facebook"   value={form.facebookUrl}  onChange={(v) => setForm(f => ({ ...f, facebookUrl: v }))}  />
        <SocialEditField icon={<Twitter  className="h-3.5 w-3.5 text-[#1da1f2]" />} label="Twitter / X" value={form.twitterUrl}   onChange={(v) => setForm(f => ({ ...f, twitterUrl: v }))}   />
        <SocialEditField icon={<Instagram className="h-3.5 w-3.5 text-[#e4405f]" />} label="Instagram"  value={form.instagramUrl} onChange={(v) => setForm(f => ({ ...f, instagramUrl: v }))} />
      </div>
      <div>
        <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Address</label>
        <input value={form.address} onChange={(e) => setForm(f => ({ ...f, address: e.target.value }))} className={inputClass} />
      </div>
      <div>
        <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Status</label>
        <select value={form.status} onChange={(e) => setForm(f => ({ ...f, status: e.target.value }))} className={inputClass}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>
      <div>
        <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Notes</label>
        <textarea value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} rows={3} className={cn(inputClass, 'resize-none')} />
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
        <button type="button" onClick={() => setEditing(false)} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[12px] font-semibold px-3 py-1.5 rounded-lg">Cancel</button>
        <button onClick={() => update.mutate()} disabled={update.isPending} className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50 flex items-center gap-1">
          <Save className="h-3 w-3" /> {update.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ─── Job Titles (Professions) ────────────────────────────────────────────────

interface JobTitle {
  id: number;
  professionId: number;
  isPrimary: boolean;
  profession: { id: number; name: string };
}

function JobTitlesSection({ bpId, canWrite }: { bpId: number; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const { data: current = [], isLoading } = useQuery<JobTitle[]>({
    queryKey: ['bp-professions', bpId],
    queryFn: () =>
      client.get(`/business-partners/${bpId}/professions`).then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });
  const { data: catalog = [] } = useQuery<Array<{ id: number; name: string }>>({
    queryKey: ['professions'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/config/professions').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const assignedIds = new Set(current.map((c) => c.professionId));
  const primaryId = current.find((c) => c.isPrimary)?.professionId ?? null;
  const available = catalog.filter((p) => !assignedIds.has(p.id));

  // Single set-call replaces the whole list. The server diffs.
  const save = useMutation({
    mutationFn: (vars: { professionIds: number[]; primaryProfessionId: number | null }) =>
      client.put(`/business-partners/${bpId}/professions`, vars).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bp-professions', bpId] });
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update job titles'),
  });

  const addOne = (id: number) => {
    const next = Array.from(new Set([...current.map((c) => c.professionId), id]));
    save.mutate({ professionIds: next, primaryProfessionId: primaryId ?? id });
  };
  const removeOne = (id: number) => {
    const next = current.map((c) => c.professionId).filter((x) => x !== id);
    const nextPrimary = primaryId === id ? (next[0] ?? null) : primaryId;
    save.mutate({ professionIds: next, primaryProfessionId: nextPrimary });
  };
  const setPrimary = (id: number) => {
    save.mutate({ professionIds: current.map((c) => c.professionId), primaryProfessionId: id });
  };

  return (
    <div>
      <p className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-2">Job titles</p>
      {isLoading ? (
        <p className="text-[11px] text-slate-400 dark:text-slate-500">Loading…</p>
      ) : current.length === 0 ? (
        <p className="text-[12px] text-slate-400 dark:text-slate-500 italic mb-2">No job titles yet.</p>
      ) : (
        <div className="space-y-1.5 mb-2">
          {current.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 px-3 py-2">
              <Briefcase className="h-3.5 w-3.5 text-violet-500 shrink-0" />
              <span className="text-[13px] font-medium text-slate-800 dark:text-slate-100 flex-1">{c.profession.name}</span>
              {canWrite && (
                <button
                  onClick={() => setPrimary(c.professionId)}
                  title={c.isPrimary ? 'This is the primary job title' : 'Mark as primary'}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-semibold border transition-colors',
                    c.isPrimary
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600',
                  )}
                >
                  {c.isPrimary ? 'PRIMARY' : 'Make primary'}
                </button>
              )}
              {canWrite && (
                <button
                  onClick={() => removeOne(c.professionId)}
                  className="p-1 rounded hover:bg-red-50 text-slate-400 dark:text-slate-500 hover:text-red-600"
                  title="Remove job title"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canWrite && available.length > 0 && (
        <div>
          <p className="text-[10px] text-slate-400 dark:text-slate-500 mb-1">Add:</p>
          <div className="flex flex-wrap gap-2">
            {available.map((p) => (
              <button
                key={p.id}
                onClick={() => addOne(p.id)}
                disabled={save.isPending}
                className="rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-violet-400 hover:bg-violet-50 text-slate-700 dark:text-slate-200 hover:text-violet-700 text-[12px] font-medium px-3 py-1 flex items-center gap-1"
              >
                <Plus className="h-3 w-3" />
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {canWrite && catalog.length === 0 && (
        <p className="text-[11px] text-slate-400 dark:text-slate-500 italic">
          No job titles defined yet. Manage the list in{' '}
          <a href="/templates/types" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
            /templates/types → Job Titles
          </a>.
        </p>
      )}
    </div>
  );
}

// ─── Relationships ───────────────────────────────────────────────────────────

function RelationshipsTab({ bp, canWrite, canDelete }: { bp: BusinessPartnerFull; canWrite: boolean; canDelete: boolean }) {
  const confirm = useConfirm();
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
        <p className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-2 flex items-center gap-1.5">{icon}{label} ({items.length})</p>
        <div className="space-y-1.5">
          {items.map((r) => (
            <div key={r.id} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 px-3 py-2 flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-medium text-slate-800 dark:text-slate-100">{r.relationshipType.name}</span>
                  <span className="text-[12px] text-slate-400 dark:text-slate-500">→</span>
                  <span className="text-[13px] font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {r.targetName ?? `${r.targetType} #${r.targetId}`}
                  </span>
                  {r.targetCode && (
                    <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">({r.targetCode})</span>
                  )}
                  {r.isPrimary && (
                    <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">PRIMARY</span>
                  )}
                </div>
                {r.roleInContext && <p className="text-[12px] text-slate-600 dark:text-slate-300 mt-0.5">{r.roleInContext}</p>}
                {(r.validFrom || r.validTo) && (
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                    {r.validFrom ? `from ${formatDate(r.validFrom)}` : ''}
                    {r.validTo ? ` to ${formatDate(r.validTo)}` : ''}
                  </p>
                )}
              </div>
              {canDelete && (
                <button
                  onClick={async () => { if (await confirm('Remove this relationship?')) remove.mutate(r.id); }}
                  className="p-1 rounded hover:bg-red-50 text-slate-400 dark:text-slate-500 hover:text-red-600 shrink-0"
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

  // Incoming relationships — this partner is the target. Render with the
  // type's inverseLabel ("Has contact: Sarah") so the row reads correctly
  // from the receiving side.
  const incoming = bp.incomingRelationships ?? [];

  const removeIncoming = useMutation({
    mutationFn: (id: number) => client.delete(`/business-partner-relationships/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      notify.success('Relationship removed', { code: 'BP-REL-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove'),
  });

  return (
    <div className="space-y-4">
      {bp.outgoingRelationships.length === 0 && incoming.length === 0 && (
        <p className="text-[12px] text-slate-400 dark:text-slate-500 italic text-center py-6">No relationships yet.</p>
      )}

      {/* Outgoing — this partner is Side A. */}
      {renderGroup('Organizations', 'organization', <Building2 className="h-3 w-3" />)}
      {renderGroup('Projects', 'project', <FolderKanban className="h-3 w-3" />)}
      {renderGroup('Departments', 'department', <ChevronRight className="h-3 w-3" />)}
      {renderGroup('Teams', 'team', <ChevronRight className="h-3 w-3" />)}

      {/* Incoming — this partner is Side B. Use inverseLabel for natural reading. */}
      {incoming.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-2 flex items-center gap-1.5">
            <ChevronRight className="h-3 w-3 rotate-180" />
            Pointing at this partner ({incoming.length})
          </p>
          <div className="space-y-1.5">
            {incoming.map((r) => (
              <div key={`in-${r.id}`} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-amber-50/40 px-3 py-2 flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-medium text-slate-800 dark:text-slate-100">
                      {r.relationshipType.inverseLabel || `← ${r.relationshipType.name}`}
                    </span>
                    <span className="text-[12px] text-slate-400 dark:text-slate-500">←</span>
                    <span className="text-[13px] font-semibold text-slate-900 dark:text-slate-100 truncate">{r.sourceName}</span>
                    <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">({r.sourceKind})</span>
                    {r.isPrimary && (
                      <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">PRIMARY</span>
                    )}
                  </div>
                  {r.roleInContext && <p className="text-[12px] text-slate-600 dark:text-slate-300 mt-0.5">{r.roleInContext}</p>}
                </div>
                {canDelete && (
                  <button
                    onClick={async () => { if (await confirm('Remove this relationship?')) removeIncoming.mutate(r.id); }}
                    className="p-1 rounded hover:bg-red-50 text-slate-400 dark:text-slate-500 hover:text-red-600 shrink-0"
                    title="Remove"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {canWrite && (
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
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
          partnerKind={bp.partnerType}
          // Main Role is the source-of-truth now. The relationship-type
          // picker filters by `partnerRoleCodes` / `partnerRoleCategories`
          // so that a "Customer" rel-type only shows up when the BP's
          // Main Role is in its restricted set. Legacy roles array would
          // produce false positives.
          partnerRoleCodes={bp.mainRoleType ? [bp.mainRoleType.code] : []}
          partnerRoleCategories={bp.mainRoleType?.category ? [bp.mainRoleType.category] : []}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}

// ─── Add Relationship Modal ──────────────────────────────────────────────────

// M3.5 — Modal flow:
//   1. Pick the relationship type.
//   2. The form labels both sides from the type's sideALabel/sideBLabel.
//   3. The server pre-filters candidate targets via /candidates so we
//      don't even render parties that already have an active relation
//      of this type (duplicate prevention).
//   4. When sideBTargets allow multiple kinds, a tabbed kind selector
//      appears (e.g. Subcontractor → [Project] [Organization]).

interface CandidatesResponse {
  type: RelationshipType;
  kinds: string[];
  candidates: Record<string, Array<{ id: number; name: string; partnerType?: string; code?: string }>>;
  existingCount: number;
}

function AddRelationshipModal({
  partnerId,
  partnerKind,
  partnerRoleCodes,
  partnerRoleCategories,
  onClose,
}: {
  partnerId: number;
  partnerKind: 'person' | 'organization';
  partnerRoleCodes: string[];
  partnerRoleCategories: string[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [relationshipTypeId, setRelationshipTypeId] = useState<number | null>(null);
  const [chosenKind, setChosenKind] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [roleInContext, setRoleInContext] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);

  // Check whether the current partner can fit one specific side's targets.
  // Empty target list = permissive (no constraint).
  const fitsSide = (targets: SideTarget[] | null): boolean => {
    if (!targets || targets.length === 0) return true;
    return targets.some((t) => {
      const kindOk = t.kind === 'any' || t.kind === partnerKind;
      if (!kindOk) return false;
      const hasRoleConstraints = (t.roleCodes?.length ?? 0) > 0;
      const hasCatConstraints = (t.categoryCodes?.length ?? 0) > 0;
      if (!hasRoleConstraints && !hasCatConstraints) return true;
      const roleHit = (t.roleCodes ?? []).some((c) => partnerRoleCodes.includes(c));
      const catHit = (t.categoryCodes ?? []).some((c) => partnerRoleCategories.includes(c));
      return roleHit || catHit;
    });
  };
  /** Returns 'A', 'B', 'both' or null depending on which side(s) accept the
   *  current partner. */
  const sideFor = (type: RelationshipType): 'A' | 'B' | 'both' | null => {
    const a = fitsSide(type.sideATargets);
    const b = fitsSide(type.sideBTargets);
    if (a && b) return 'both';
    if (a) return 'A';
    if (b) return 'B';
    return null;
  };

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  const { data: allRelTypes = [] } = useQuery<RelationshipType[]>({
    queryKey: ['partner-relationship-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/partner-types/relationship-types').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  // Annotate each type with which side(s) accept this partner, and keep
  // only those where at least one side fits. For types where only Side B
  // fits, the modal will save the row in reverse (other party as source,
  // this partner as target).
  const annotatedRelTypes = allRelTypes
    .map((t) => ({ type: t, side: sideFor(t) }))
    .filter((x): x is { type: RelationshipType; side: 'A' | 'B' | 'both' } => x.side != null);
  const hiddenTypeCount = allRelTypes.length - annotatedRelTypes.length;

  const selectedEntry = annotatedRelTypes.find((x) => x.type.id === relationshipTypeId) || null;
  const selectedType = selectedEntry?.type ?? null;
  // When the type accepts the partner on either side, default to A.
  const forSide: 'A' | 'B' = selectedEntry?.side === 'B' ? 'B' : 'A';

  // The candidates endpoint does all the heavy lifting:
  //   - resolves sideBTargets into actual eligible parties per kind
  //   - excludes parties already in an active relationship of this type
  //   - groups by kind for the kind-tab UI
  const { data: candidatesData } = useQuery<CandidatesResponse>({
    queryKey: ['partner-rel-candidates', relationshipTypeId, partnerId, forSide],
    enabled: relationshipTypeId != null,
    queryFn: () =>
      client
        .get(
          `/admin/partner-types/relationship-types/${relationshipTypeId}/candidates?partyAId=${partnerId}&forSide=${forSide}`,
        )
        .then((r) => r.data?.data ?? r.data),
  });

  const kinds = candidatesData?.kinds ?? [];
  const candidates = candidatesData?.candidates ?? {};

  // Auto-pick the only kind if there's just one.
  useEffect(() => {
    if (kinds.length === 1 && chosenKind !== kinds[0]) setChosenKind(kinds[0]);
    if (kinds.length > 1 && chosenKind && !kinds.includes(chosenKind)) setChosenKind(null);
  }, [kinds, chosenKind]);

  // Reset selection when type changes.
  useEffect(() => {
    setTargetId(null);
    setChosenKind(null);
  }, [relationshipTypeId]);

  // The legacy POST body uses (sourcePartnerId, targetType, targetId). For
  // forSide='A' the current partner is the source; for 'B' they're the
  // target and the picked candidate becomes the source.
  const legacyTargetType =
    chosenKind === 'person' ? 'organization' /* persons-as-targets piggy-back the BP-target column */
    : (chosenKind as 'project' | 'organization' | null);

  const create = useMutation({
    mutationFn: () => {
      if (!chosenKind || !targetId) {
        throw new Error('Pick a target before saving');
      }
      const body =
        forSide === 'A'
          ? {
              sourcePartnerId: partnerId,
              targetType: legacyTargetType,
              targetId,
              relationshipTypeId,
              roleInContext: roleInContext.trim() || undefined,
              isPrimary,
            }
          : {
              // Side B: the picked candidate is the source, current partner is target.
              sourcePartnerId: targetId,
              targetType: 'organization' as const,
              targetId: partnerId,
              relationshipTypeId,
              roleInContext: roleInContext.trim() || undefined,
              isPrimary,
            };
      return client.post('/business-partner-relationships', body).then((r) => r.data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      queryClient.invalidateQueries({ queryKey: ['partner-rel-candidates'] });
      notify.success('Relationship added', { code: 'BP-REL-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add relationship'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!relationshipTypeId || !targetId) {
      notify.warning('Pick a relationship type and a target', { code: 'BP-REL-400' });
      return;
    }
    create.mutate();
  };

  // When the partner is on Side A we use the type's labels normally.
  // When the partner is on Side B, we read the sentence in reverse:
  //   "This partner is the {sideBLabel}, of someone playing {sideALabel}"
  // and we ask the user to pick that {sideALabel} party.
  const partnerSideLabel = forSide === 'A'
    ? (selectedType?.sideALabel || 'This partner')
    : (selectedType?.sideBLabel || 'This partner');
  const otherSideLabel = forSide === 'A'
    ? (selectedType?.sideBLabel || 'Other party')
    : (selectedType?.sideALabel || 'Other party');
  const optionsForChosenKind = chosenKind ? candidates[chosenKind] ?? [] : [];
  const exhausted =
    candidatesData != null &&
    kinds.length > 0 &&
    kinds.every((k) => (candidates[k] ?? []).length === 0);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[480px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Add Relationship</h3>
          <button onClick={onClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-3">
          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Relationship type</label>
            <select
              value={relationshipTypeId ?? ''}
              onChange={(e) => setRelationshipTypeId(Number(e.target.value) || null)}
              className={inputClass}
            >
              <option value="">Select...</option>
              {annotatedRelTypes.map(({ type, side }) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                  {side === 'B' ? ` — as ${type.sideBLabel || 'side B'}` : ''}
                </option>
              ))}
            </select>
            {hiddenTypeCount > 0 && (
              <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">
                {hiddenTypeCount} type{hiddenTypeCount > 1 ? 's' : ''} hidden — neither side accepts this partner ({partnerKind}
                {partnerRoleCodes.length > 0 ? ` with roles: ${partnerRoleCodes.join(', ')}` : ''}).
              </p>
            )}
            {annotatedRelTypes.length === 0 && (
              <p className="text-[12px] text-amber-700 bg-amber-50 px-2 py-1.5 rounded mt-1">
                No relationship types accept this partner on either side. Configure a type whose Side A or Side B matches this partner's kind/roles.
              </p>
            )}
          </div>

          {selectedType && (
            <>
              <div className="rounded-lg bg-blue-50/60 px-3 py-2 text-[12px] text-slate-700 dark:text-slate-200">
                <span className="font-semibold text-blue-700">{partnerSideLabel}</span>
                <span className="text-slate-400 dark:text-slate-500 mx-1.5">{forSide === 'B' ? '←' : '→'}</span>
                <span className="font-semibold text-violet-700">{otherSideLabel}</span>
                {forSide === 'B' && (
                  <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
                    INCOMING
                  </span>
                )}
                {selectedType.inverseLabel && forSide === 'A' && (
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 ml-2">(reads back as "{selectedType.inverseLabel}")</span>
                )}
                {candidatesData && candidatesData.existingCount > 0 && (
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                    {candidatesData.existingCount} existing relationship(s) of this type already on this partner — hidden from the list below.
                  </p>
                )}
              </div>

              {/* Multi-kind sideB ⇒ show a kind tab strip. */}
              {kinds.length > 1 && (
                <div>
                  <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Kind</label>
                  <div className="flex gap-2">
                    {kinds.map((k) => (
                      <button
                        type="button"
                        key={k}
                        onClick={() => { setChosenKind(k); setTargetId(null); }}
                        className={cn(
                          'rounded-lg border-2 px-3 py-1.5 text-[12px] font-medium capitalize',
                          chosenKind === k ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300',
                        )}
                      >
                        {k} <span className="text-[10px] text-slate-400 dark:text-slate-500">({(candidates[k] ?? []).length})</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {chosenKind && (
                <div>
                  <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">
                    {chosenKind === 'project' ? 'Project' : chosenKind === 'organization' ? 'Organization' : 'Person'}
                  </label>
                  {optionsForChosenKind.length > 0 ? (
                    <select
                      value={targetId ?? ''}
                      onChange={(e) => setTargetId(Number(e.target.value) || null)}
                      className={inputClass}
                    >
                      <option value="">Select...</option>
                      {optionsForChosenKind.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}{o.code ? ` (${o.code})` : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-[12px] text-amber-700 bg-amber-50 px-2 py-1.5 rounded">
                      No eligible {chosenKind}s — they may already be related to this partner under this type, or none match the type's role constraints.
                    </p>
                  )}
                </div>
              )}

              {exhausted && (
                <p className="text-[12px] text-amber-700 bg-amber-50 px-2 py-1.5 rounded">
                  No eligible parties for this relationship type. Either all candidates are already related, or the type has constraints that no parties match.
                </p>
              )}

              <div>
                <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Title / role in this context (optional)</label>
                <input
                  value={roleInContext}
                  onChange={(e) => setRoleInContext(e.target.value)}
                  placeholder='e.g. "Operations Manager"'
                  className={inputClass}
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 pt-1">
                <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600" />
                Mark as primary
              </label>
            </>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button type="button" onClick={onClose} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[12px] font-semibold px-3 py-1.5 rounded-lg">Cancel</button>
            <button type="submit" disabled={create.isPending || !selectedType || !targetId} className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50">
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
      <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 flex items-center gap-1.5">
        {icon}
        {label}
      </label>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="https://..." className={inputClass} />
    </div>
  );
}
