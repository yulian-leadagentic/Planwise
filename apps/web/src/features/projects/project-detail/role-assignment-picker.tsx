import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { inputClass } from './constants';
import type { ProjectRoleTypeRow } from './types';

/* ─── Role Assignment Picker ────────────────────────────────────────────────
   Generic picker for any ProjectRoleType (Supplier, Architect, Engineer, …).
   Creates a project_partner_role row.

   People UX M3 (2026-09-27, T-02/T-03/T-20/T-21): the candidate source is
   now `/admin/project-role-types/:code/eligible-parties?projectId=…` —
   the same endpoint used by New Project's TeamRolePicker and the project-
   list role cell. It returns every party of the role's allowed kind, with
   an `eligible` flag and a plain-English `reasons[]` array on the
   ineligible ones. Rows that fail an eligibility check appear disabled
   with the reason visible in the row itself (matches the AssigneeManager
   "External" pattern), so users understand WHY someone is missing instead
   of just missing them.

   BM2 Phase C — representation pickers layered on top:
     • When the participant is an ORG AND the role's requiresContactPerson
       flag is true, a contact-person picker appears. That org's `worker_of`
       people surface first; a "Show all people" toggle widens the list.
       Submits `contactPartyId`.
     • When the participant is a PERSON, an optional "on behalf of"
       employer picker appears (org BP search). Prefilled with the
       person's active worker_of employer(s) when unambiguous.
       Submits `onBehalfOfPartyId`.
   Both fields are optional at the API level (see project-partner-roles.service.ts);
   the picker just streamlines the collection UX. */

interface EligibleParty {
  id: number;
  userId: number | null;
  partnerType: 'person' | 'organization';
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  avatarUrl: string | null;
  position: string | null;
  department: string | null;
  eligible: boolean;
  reasons: string[];
}

interface BpForRepresentation {
  id: number;
  partnerType: 'person' | 'organization';
  displayName: string;
  partnerRelationshipsA?: Array<{
    id: number;
    partyBId: number;
    type: { code: string } | null;
    validTo?: string | null;
  }>;
}

/**
 * Human-readable criteria block for the currently-selected role. Replaces
 * the raw-code banner ("must hold role \"employee\"" / "/partners") with
 * plain English that matches the M4 glossary and the ineligibility
 * reasons rendered on each disabled row.
 */
function roleCriteriaLines(role: ProjectRoleTypeRow): string[] {
  const lines: string[] = [];
  if (role.allowedPartnerKind === 'organization') {
    lines.push('Must be an Organization');
  } else if (role.allowedPartnerKind === 'person') {
    lines.push('Must be a person Contact');
  }
  if (role.requiredPartnerRoleCode) {
    const label = role.requiredPartnerRoleCode === 'employee'
      ? 'Employee'
      : role.requiredPartnerRoleCode.replace(/_/g, ' ');
    lines.push(`Must be an ${label}`);
  }
  const profs = Array.isArray(role.requiredProfessionIds) ? role.requiredProfessionIds : [];
  if (profs.length > 0) {
    lines.push('Needs a required job title');
  }
  if (role.isPrimaryRequired) lines.push('One primary assignment required');
  if (role.requiresContactPerson) lines.push('Contact person required when the party is an Organization');
  return lines;
}

export function RoleAssignmentPicker({
  role,
  projectId,
  existingPartyIds: _existingPartyIds,
  onClose,
}: {
  role: ProjectRoleTypeRow;
  projectId: number;
  /** Kept for source compatibility; the server now handles this via
   *  the `projectId` query param on eligible-parties. */
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
  // People UX M3 (T-21) — "Show all people" toggle for the contact-person
  // picker. When off (the default), only the org's worker_of people are
  // listed; when on, every person BP shows up.
  const [showAllContacts, setShowAllContacts] = useState(false);

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  // People UX M3 (T-02) — single eligibility source. The FE previously
  // called `/business-partners` with partial filters (kind + partner-
  // role only, missing the job-title check), so ineligible names
  // surfaced in the picker and then 400'd on submit. Now we call the
  // dedicated endpoint that mirrors the write path's checks, returns
  // ineligible candidates annotated with reasons, and excludes parties
  // already assigned on this project via the `projectId` query param.
  const { data: candidates = [], isLoading: candidatesLoading } = useQuery<EligibleParty[]>({
    queryKey: ['project-role-eligible-parties', role.code, projectId],
    queryFn: () =>
      client
        .get(`/admin/project-role-types/${encodeURIComponent(role.code)}/eligible-parties`, {
          params: { projectId },
        })
        .then((r) => {
          const d = r.data?.data ?? r.data;
          return Array.isArray(d) ? d : [];
        }),
  });

  const selectedParty = candidates.find((p) => p.id === selectedPartyId) ?? null;
  const showContactPicker =
    !!selectedParty
    && selectedParty.partnerType === 'organization'
    && !!role.requiresContactPerson;
  const showOnBehalfPicker =
    !!selectedParty
    && selectedParty.partnerType === 'person';

  // Persons scoped to the selected org's workers (people UX M3 · T-21).
  // Fetched only when the contact-person picker is open AND the user
  // has NOT toggled "Show all people". Uses the existing server-side
  // `employerId` filter so the picker matches the CustomerContactPicker
  // rule: only that org's staff.
  const { data: orgWorkers = [] } = useQuery<BpForRepresentation[]>({
    queryKey: ['bp-persons-worker-of', selectedPartyId],
    enabled: showContactPicker && !showAllContacts && !!selectedPartyId,
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/business-partners', {
      params: {
        partnerType: 'person',
        employerId: selectedPartyId,
        perPage: 500,
      },
    }).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });

  // Full person BP list — only fetched when the operator asks for it
  // (Show all people). Keeps the default view small and scoped.
  const { data: allPersons = [] } = useQuery<BpForRepresentation[]>({
    queryKey: ['bp-persons-for-representation-all'],
    enabled: showContactPicker && showAllContacts,
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/business-partners', {
      params: { partnerType: 'person', perPage: 500 },
    }).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });

  // Contact-person options — worker_of first when "Show all" is off;
  // when on, list everyone but keep the worker_of rows on top and tag
  // them so the operator can find them quickly.
  const contactOptions = useMemo(() => {
    if (!showContactPicker) return [] as BpForRepresentation[];
    if (!showAllContacts) return orgWorkers;
    const workerIds = new Set(orgWorkers.map((p) => p.id));
    const workers = allPersons.filter((p) => workerIds.has(p.id));
    const rest = allPersons.filter((p) => !workerIds.has(p.id));
    return [...workers, ...rest];
  }, [showContactPicker, showAllContacts, orgWorkers, allPersons]);
  const contactWorkerIds = useMemo(
    () => new Set(orgWorkers.map((p) => p.id)),
    [orgWorkers],
  );

  // Orgs (for the on-behalf-of picker). Fetched lazily.
  const { data: orgBps = [] } = useQuery<BpForRepresentation[]>({
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

  // Selected person's active worker_of employers, for the "current
  // employer" hint in the on-behalf-of picker. When the selected party
  // isn't a person, we don't have this data on the eligible-parties
  // payload, so we look it up from the on-behalf orgs list lazily —
  // NOT here (avoids an extra request per selection).
  const personEmployerIds = useMemo<number[]>(() => [], []);

  useEffect(() => {
    // Clear representation fields whenever the participant flips —
    // otherwise a stale contactPartyId from a previous org would be
    // sent along after switching to a person.
    setContactPartyId(null);
    setOnBehalfOfPartyId(null);
    setShowAllContacts(false);
  }, [selectedPartyId]);

  const create = useMutation({
    mutationFn: () =>
      client.post('/project-partner-roles', {
        projectId,
        partyId: selectedPartyId,
        roleId: role.id,
        isPrimary,
        titleInProject: titleInProject.trim() || undefined,
        contactPartyId: showContactPicker ? contactPartyId : undefined,
        onBehalfOfPartyId: showOnBehalfPicker ? onBehalfOfPartyId : undefined,
      }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
      queryClient.invalidateQueries({ queryKey: ['assignee-candidates', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-role-eligible-parties'] });
      notify.success(`Added ${role.name}`, { code: 'PPR-ADD-201' });
      onClose();
    },
    onError: (err: unknown) => notify.apiError(err, `Failed to add ${role.name}`),
  });

  const criteria = useMemo(() => roleCriteriaLines(role), [role]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[520px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Add {role.name}</h3>
          <button onClick={onClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          {/* People UX M3 (T-20) — plain-English criteria replace the
              raw-code banner ("must hold role \"employee\"" / "/partners").
              The wording matches the ineligibility reasons rendered
              below on each disabled row, so the criteria and per-row
              reasons speak with one voice. */}
          {criteria.length > 0 && (
            <div className="rounded-lg bg-slate-50 dark:bg-slate-800/50 px-3 py-2 text-[11px] text-slate-600 dark:text-slate-300">
              <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px] mb-1">
                Criteria
              </div>
              <ul className="list-disc ps-4 space-y-0.5">
                {criteria.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">{role.name}</label>
            {/* Options render as a native <select>; disabled <option>s
                carry the reason inline (" — Must be an Employee") so
                the row itself, not a tooltip, tells the user why they
                can't be picked. Eligible rows come first, ineligible
                second, each group alphabetised by displayName. */}
            <select
              value={selectedPartyId ?? ''}
              onChange={(e) => setSelectedPartyId(Number(e.target.value) || null)}
              className={inputClass}
            >
              <option value="">
                {candidatesLoading ? 'Loading…' : 'Select...'}
              </option>
              {candidates
                .filter((c) => c.eligible)
                .map((p) => (
                  <option key={p.id} value={p.id}>{p.displayName}</option>
                ))}
              {candidates.some((c) => !c.eligible) && (
                <option disabled>──────────</option>
              )}
              {candidates
                .filter((c) => !c.eligible)
                .map((p) => (
                  <option key={p.id} value={p.id} disabled>
                    {p.displayName} — {p.reasons.join(', ') || 'Not eligible'}
                  </option>
                ))}
            </select>
            {!candidatesLoading && candidates.filter((c) => c.eligible).length === 0 && (
              <p className="text-[12px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 px-2 py-1.5 rounded mt-1">
                No eligible {role.allowedPartnerKind === 'organization' ? 'organizations' : 'people'} yet.
                Add one that meets the criteria above under People or Partners first.
              </p>
            )}
          </div>

          {/* Representation — contact person for an org participant.
              People UX M3 (T-21): worker_of people surface first; a
              "Show all people" toggle widens the list to everyone. */}
          {showContactPicker && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase block">
                  Contact person at {selectedParty?.displayName} {role.requiresContactPerson ? <span className="text-amber-600">*</span> : <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>}
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 select-none cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showAllContacts}
                    onChange={(e) => setShowAllContacts(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-600 text-blue-600"
                  />
                  Show all people
                </label>
              </div>
              <select
                value={contactPartyId ?? ''}
                onChange={(e) => setContactPartyId(Number(e.target.value) || null)}
                className={inputClass}
              >
                <option value="">— Pick a person —</option>
                {contactOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                    {showAllContacts && contactWorkerIds.has(p.id) ? ' · works at this Organization' : ''}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                The person who is the day-to-day contact for this Organization on this project.
              </p>
            </div>
          )}

          {/* Representation — on-behalf-of employer for a person participant. */}
          {showOnBehalfPicker && (
            <div>
              <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">
                On behalf of (Organization) <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>
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
                Pin the Organization this person represents on THIS project — useful for freelancers or people who work for two firms.
              </p>
            </div>
          )}

          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Title on Project (optional)</label>
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
