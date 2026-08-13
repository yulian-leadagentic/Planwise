import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { inputClass } from './constants';
import type { ProjectRoleTypeRow } from './types';

/* ─── Role Assignment Picker ────────────────────────────────────────────────
   Generic picker for any ProjectRoleType (Supplier, Architect, Engineer, …).
   Filters candidates by the role's allowedPartnerKind + requiredPartnerRoleCode.
   Creates a project_partner_role row.

   BM2 Phase C (2026-08-13) — representation pickers layered on top:
     • When the participant is an ORG AND the role's requiresContactPerson
       flag is true, a contact-person picker appears (person BP search).
       Submits `contactPartyId`.
     • When the participant is a PERSON, an optional "on behalf of"
       employer picker appears (org BP search). Prefilled with the
       person's active worker_of employer(s) when unambiguous.
       Submits `onBehalfOfPartyId`.
   Both fields are optional at the API level (see project-partner-roles.service.ts);
   the picker just streamlines the collection UX. */

// Small typed shape for what /business-partners returns to us here — we
// only touch the fields we use, and keep `partnerRelationshipsA` optional
// because organizations don't ship the include and it may be missing on
// legacy rows.
interface BpForPicker {
  id: number;
  partnerType: 'person' | 'organization';
  displayName: string;
  professions?: Array<{ professionId: number }>;
  partnerRelationshipsA?: Array<{
    id: number;
    partyBId: number;
    type: { code: string } | null;
    validTo?: string | null;
  }>;
}

export function RoleAssignmentPicker({
  role,
  projectId,
  existingPartyIds,
  onClose,
}: {
  role: ProjectRoleTypeRow;
  projectId: number;
  existingPartyIds: number[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedPartyId, setSelectedPartyId] = useState<number | null>(null);
  const [titleInProject, setTitleInProject] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  // BM2 Phase C — representation state.
  const [contactPartyId, setContactPartyId] = useState<number | null>(null);
  const [onBehalfOfPartyId, setOnBehalfOfPartyId] = useState<number | null>(null);

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  const { data: candidates = [] } = useQuery<BpForPicker[]>({
    queryKey: ['bp-candidates-for-role', role.id],
    queryFn: () => client.get('/business-partners', {
      params: {
        partnerType: role.allowedPartnerKind === 'any' ? undefined : role.allowedPartnerKind,
        roleType: role.requiredPartnerRoleCode ?? undefined,
        perPage: 500,
      },
    }).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });
  // Filter out already-assigned parties AND, when the role requires one
  // of a set of professions (Job Titles), parties who don't hold any of
  // them. Without this second pass, the dropdown happily offered names
  // that the backend would later reject with a 400 — see the user-facing
  // "must hold one of these job titles" error.
  const requiredProfIds: number[] = Array.isArray(role.requiredProfessionIds)
    ? role.requiredProfessionIds
    : [];
  const filtered = candidates.filter((p) => {
    if (existingPartyIds.includes(p.id)) return false;
    if (requiredProfIds.length === 0) return true;
    const partyProfIds: number[] = Array.isArray(p.professions)
      ? p.professions.map((x) => x.professionId)
      : [];
    return partyProfIds.some((id) => requiredProfIds.includes(id));
  });

  // ── Representation logic ───────────────────────────────────────────
  const selectedParty = candidates.find((p) => p.id === selectedPartyId) ?? null;
  const showContactPicker =
    !!selectedParty
    && selectedParty.partnerType === 'organization'
    && !!role.requiresContactPerson;
  const showOnBehalfPicker =
    !!selectedParty
    && selectedParty.partnerType === 'person';

  // Persons (for the contact-person picker). Fetched lazily.
  const { data: personBps = [] } = useQuery<BpForPicker[]>({
    queryKey: ['bp-persons-for-representation'],
    enabled: showContactPicker,
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/business-partners', {
      params: { partnerType: 'person', perPage: 500 },
    }).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });

  // Orgs (for the on-behalf-of picker). Fetched lazily.
  const { data: orgBps = [] } = useQuery<BpForPicker[]>({
    queryKey: ['bp-orgs-for-representation'],
    enabled: showOnBehalfPicker,
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/business-partners', {
      params: { partnerType: 'organization', perPage: 500 },
    }).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });

  // For a person participant, prefill on-behalf-of with their active
  // worker_of employer when unambiguous (exactly one). Runs when the
  // selection changes or the candidate data lands.
  const personEmployerIds = useMemo<number[]>(() => {
    if (!selectedParty || selectedParty.partnerType !== 'person') return [];
    const rels = selectedParty.partnerRelationshipsA ?? [];
    const now = new Date();
    return rels
      .filter((r) =>
        r.type?.code === 'worker_of'
        && (!r.validTo || new Date(r.validTo) > now),
      )
      .map((r) => r.partyBId);
  }, [selectedParty]);

  useEffect(() => {
    // Clear representation fields whenever the participant flips —
    // otherwise a stale contactPartyId from a previous org would be
    // sent along after switching to a person.
    setContactPartyId(null);
    setOnBehalfOfPartyId(personEmployerIds.length === 1 ? personEmployerIds[0] : null);
  }, [selectedPartyId, personEmployerIds]);

  const create = useMutation({
    mutationFn: () =>
      client.post('/project-partner-roles', {
        projectId,
        partyId: selectedPartyId,
        roleId: role.id,
        isPrimary,
        titleInProject: titleInProject.trim() || undefined,
        // BM2 Phase C — send only the field that matches the participant's
        // kind; the backend rejects contactPartyId on a person and
        // onBehalfOfPartyId on an org.
        contactPartyId: showContactPicker ? contactPartyId : undefined,
        onBehalfOfPartyId: showOnBehalfPicker ? onBehalfOfPartyId : undefined,
      }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
      notify.success(`Added ${role.name}`, { code: 'PPR-ADD-201' });
      onClose();
    },
    onError: (err: unknown) => notify.apiError(err, `Failed to add ${role.name}`),
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[480px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Add {role.name}</h3>
          <button onClick={onClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div className="rounded-lg bg-slate-50 dark:bg-slate-800/50 px-3 py-2 text-[11px] text-slate-600 dark:text-slate-300">
            Eligible: <span className="font-mono font-semibold">{role.allowedPartnerKind}</span>
            {role.requiredPartnerRoleCode && (
              <> · must hold role <span className="font-mono font-semibold">{role.requiredPartnerRoleCode}</span></>
            )}
            {requiredProfIds.length > 0 && (
              <> · must hold a required job title</>
            )}
            {role.isPrimaryRequired && <> · one PRIMARY required</>}
            {role.requiresContactPerson && <> · contact person required for orgs</>}
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">{role.name}</label>
            <select
              value={selectedPartyId ?? ''}
              onChange={(e) => setSelectedPartyId(Number(e.target.value) || null)}
              className={inputClass}
            >
              <option value="">Select...</option>
              {filtered.map((p) => (
                <option key={p.id} value={p.id}>{p.displayName}</option>
              ))}
            </select>
            {filtered.length === 0 && (
              <p className="text-[12px] text-amber-700 bg-amber-50 px-2 py-1.5 rounded mt-1">
                No eligible parties. Add a {role.allowedPartnerKind}
                {role.requiredPartnerRoleCode ? ` with role "${role.requiredPartnerRoleCode}"` : ''}
                {requiredProfIds.length > 0 ? ' who holds a required job title (see /partners → Job Titles)' : ''}
                {' '}in /partners first.
              </p>
            )}
          </div>

          {/* Representation — contact person for an org participant. */}
          {showContactPicker && (
            <div>
              <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">
                Contact person at {selectedParty?.displayName} {role.requiresContactPerson ? <span className="text-amber-600">*</span> : <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>}
              </label>
              <select
                value={contactPartyId ?? ''}
                onChange={(e) => setContactPartyId(Number(e.target.value) || null)}
                className={inputClass}
              >
                <option value="">— Pick a person —</option>
                {personBps.map((p) => (
                  <option key={p.id} value={p.id}>{p.displayName}</option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                The person who is the day-to-day contact for this organization on this project. Reads as "Org — contact: Person".
              </p>
            </div>
          )}

          {/* Representation — on-behalf-of employer for a person participant. */}
          {showOnBehalfPicker && (
            <div>
              <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">
                On behalf of (employer) <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>
              </label>
              <select
                value={onBehalfOfPartyId ?? ''}
                onChange={(e) => setOnBehalfOfPartyId(Number(e.target.value) || null)}
                className={inputClass}
              >
                <option value="">— None / unaffiliated on this project —</option>
                {orgBps.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.displayName}
                    {personEmployerIds.includes(o.id) ? ' · current employer' : ''}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                Pin the employer this person represents on THIS project — useful for freelancers or people who work for two firms. Reads as "Person (on behalf of Org)".
              </p>
            </div>
          )}

          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Title / role-in-context (optional)</label>
            <input
              value={titleInProject}
              onChange={(e) => setTitleInProject(e.target.value)}
              placeholder={`e.g. "Lead ${role.name}"`}
              className={inputClass}
            />
          </div>
          {role.isPrimaryRequired && (
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 pt-1">
              <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600" />
              Mark as primary {role.name}
            </label>
          )}
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button onClick={onClose} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[12px] font-semibold px-3 py-1.5 rounded-lg">Cancel</button>
            <button
              onClick={() => create.mutate()}
              disabled={
                create.isPending
                || !selectedPartyId
                // Require a contact person when the role demands one.
                || (showContactPicker && role.requiresContactPerson === true && !contactPartyId)
              }
              className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
            >
              {create.isPending ? 'Adding...' : `Add ${role.name}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
