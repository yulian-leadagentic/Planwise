import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { Modal } from '@/components/shared/modal';
import { inputClass } from './constants';
import type { ProjectRoleTypeRow } from './types';
import {
  buildOrgOptions,
  isExternalProjectRole,
  NO_ORG_KEY,
  orgOptionLabel,
  type EligibleParty,
} from './role-org-first';

/**
 * Choose "a" / "an" by the word's initial letter (a/e/i/o/u).
 * Simple by design — the project's role-code catalog (customer,
 * employee, supplier, organization, person contact, admin) is fully
 * covered without the honest/unicorn edge cases.
 */
function article(word: string): 'a' | 'an' {
  const first = word.trim().charAt(0).toLowerCase();
  return 'aeiou'.includes(first) ? 'an' : 'a';
}

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
   the picker just streamlines the collection UX.

   QA6 BM2-4 (2026-11-25) — EXTERNAL roles (see `isExternalProjectRole`)
   pick the organization first:
     • every eligible-parties call carries `excludeInternal=true`, so the
       home org and its people never appear;
     • step 1 lists organizations (plus "No organization" for eligible
       freelancers); step 2 lists only that organization's eligible
       contacts (`organizationId=`), with the organization itself first
       when it can hold the role;
     • a person picked under an organization is submitted with
       `onBehalfOfPartyId` = that organization, so the separate
       on-behalf picker is not shown;
     • organization-only roles (Supplier) select the organization as the
       party; their contact-person list drops the "Show all people"
       toggle and company employees.
   Internal roles (Team Leader, qualification-gated roles) keep the flat
   list unchanged. */

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
function roleCriteriaLines(role: ProjectRoleTypeRow, external: boolean): string[] {
  const lines: string[] = [];
  if (role.allowedPartnerKind === 'organization') {
    lines.push(`Must be ${article('organization')} organization`);
  } else if (role.allowedPartnerKind === 'person') {
    lines.push(`Must be ${article('person contact')} person contact`);
  }
  if (role.requiredPartnerRoleCode) {
    const label = role.requiredPartnerRoleCode.replace(/_/g, ' ').toLowerCase();
    lines.push(`Must be ${article(label)} ${label}`);
  }
  const profs = Array.isArray(role.requiredProfessionIds) ? role.requiredProfessionIds : [];
  if (profs.length > 0) {
    lines.push('Needs a required job title');
  }
  if (external) lines.push('Outside parties only: company employees are not listed');
  if (role.isPrimaryRequired) lines.push('One primary assignment required');
  if (role.requiresContactPerson) lines.push('Contact person required when the party is an organization');
  return lines;
}

function fetchEligibleParties(
  code: string,
  params: Record<string, string | number | boolean>,
): Promise<EligibleParty[]> {
  return client
    .get(`/admin/project-role-types/${encodeURIComponent(code)}/eligible-parties`, { params })
    .then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    });
}

const labelClass = 'text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block';
const emptyClass = 'text-[12px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 px-2 py-1.5 rounded mt-1';

/** TA-1: subtle "N not eligible" expander. Only rendered when there are
 *  ineligible candidates to explain, so M3's "understand WHY someone's
 *  missing" stays available without a wall of disabled rows. */
function IneligibleExpander({ candidates }: { candidates: EligibleParty[] }) {
  const [open, setOpen] = useState(false);
  const ineligible = candidates.filter((c) => !c.eligible);
  if (ineligible.length === 0) return null;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-[11px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 underline decoration-dotted underline-offset-2"
      >
        {ineligible.length} not eligible · {open ? 'hide' : 'show why'}
      </button>
      {open && (
        <ul className="mt-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 px-2 py-1.5 text-[11px] text-slate-500 dark:text-slate-400 space-y-0.5 max-h-40 overflow-y-auto">
          {ineligible.map((p) => (
            <li key={p.id} className="leading-snug">
              <span className="text-slate-600 dark:text-slate-300 font-medium">{p.displayName}</span>
              {p.reasons.length > 0 && (
                <span className="text-slate-400 dark:text-slate-500">: {p.reasons.join(' · ')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RoleAssignmentPicker({
  role,
  projectId,
  existingPartyIds: _existingPartyIds,
  hasExistingPrimary = false,
  onClose,
}: {
  role: ProjectRoleTypeRow;
  projectId: number;
  /** Kept for source compatibility; the server now handles this via
   *  the `projectId` query param on eligible-parties. */
  existingPartyIds: number[];
  /** TA-3: true when a primary of this role already exists on the project.
   *  When false (or role is the customer role and none exists yet), the
   *  picker auto-sets isPrimary and hides the toggle in favour of a
   *  muted hint — the confusing checkbox only shows when the operator
   *  is genuinely deciding whether to move primary. */
  hasExistingPrimary?: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  // QA6 BM2-4 — organization-first flow for external roles.
  const orgFirst = isExternalProjectRole(role);
  // Organization-only roles: the organization picked in step 1 IS the
  // party. Otherwise step 2 picks a contact of that organization.
  const orgIsParty = role.allowedPartnerKind === 'organization';
  const [selectedOrgKey, setSelectedOrgKey] = useState('');
  const [selectedPartyId, setSelectedPartyId] = useState<number | null>(null);
  const [titleInProject, setTitleInProject] = useState('');
  // TA-3: auto-primary when the role is `customer` OR the role requires
  // a primary and none exists yet on the project. The visible checkbox
  // (see below) is hidden in that case; state stays true so the POST
  // still carries `isPrimary: true`.
  const autoPrimary =
    role.code === 'customer' || (role.isPrimaryRequired && !hasExistingPrimary);
  const [isPrimary, setIsPrimary] = useState(autoPrimary);
  // BM2 Phase C — representation state.
  const [contactPartyId, setContactPartyId] = useState<number | null>(null);
  const [onBehalfOfPartyId, setOnBehalfOfPartyId] = useState<number | null>(null);
  // People UX M3 (T-21) — "Show all people" toggle for the contact-person
  // picker. When off (the default), only the org's worker_of people are
  // listed; when on, every person BP shows up. Not offered for external
  // roles (QA6 BM2-4: only that organization's contacts).
  const [showAllContacts, setShowAllContacts] = useState(false);

  // People UX M3 (T-02) — single eligibility source. The FE previously
  // called `/business-partners` with partial filters (kind + partner-
  // role only, missing the job-title check), so ineligible names
  // surfaced in the picker and then 400'd on submit. Now we call the
  // dedicated endpoint that mirrors the write path's checks, returns
  // ineligible candidates annotated with reasons, and excludes parties
  // already assigned on this project via the `projectId` query param.
  const { data: candidates = [], isLoading: candidatesLoading } = useQuery<EligibleParty[]>({
    queryKey: ['project-role-eligible-parties', role.code, projectId, orgFirst ? 'external' : 'all'],
    queryFn: () =>
      fetchEligibleParties(
        role.code,
        orgFirst ? { projectId, excludeInternal: true } : { projectId },
      ),
  });

  // QA6 BM2-4 — step 1 options, from the AMEC-free payload.
  const { orgs: orgOptions, independentCount } = useMemo(
    () => buildOrgOptions(candidates),
    [candidates],
  );
  const step1Orgs = useMemo(
    () => (orgIsParty ? orgOptions.filter((o) => o.selfEligible) : orgOptions),
    [orgIsParty, orgOptions],
  );
  const selectedOrgId =
    selectedOrgKey !== '' && selectedOrgKey !== NO_ORG_KEY ? Number(selectedOrgKey) : null;
  const selectedOrg = orgOptions.find((o) => o.id === selectedOrgId) ?? null;

  // QA6 BM2-4 — step 2: only the chosen organization's parties, scoped
  // server-side (`organizationId`), still without AMEC.
  const scopedEnabled = orgFirst && !orgIsParty && selectedOrgKey !== '';
  const { data: scoped = [], isLoading: scopedLoading } = useQuery<EligibleParty[]>({
    queryKey: ['project-role-eligible-parties', role.code, projectId, 'external', selectedOrgKey],
    enabled: scopedEnabled,
    queryFn: () =>
      fetchEligibleParties(role.code, {
        projectId,
        excludeInternal: true,
        organizationId: selectedOrgKey,
      }),
  });
  // The organization itself first (when it can hold the role), then its
  // eligible people.
  const contactChoices = useMemo(() => {
    if (!scopedEnabled) return [] as EligibleParty[];
    const eligible = scoped.filter((c) => c.eligible);
    return [
      ...eligible.filter((c) => c.partnerType === 'organization'),
      ...eligible.filter((c) => c.partnerType === 'person'),
    ];
  }, [scopedEnabled, scoped]);

  const partyPool = scopedEnabled ? scoped : candidates;
  const selectedParty = partyPool.find((p) => p.id === selectedPartyId) ?? null;
  const showContactPicker =
    !!selectedParty
    && selectedParty.partnerType === 'organization'
    && !!role.requiresContactPerson;
  const showOnBehalfPicker =
    !orgFirst
    && !!selectedParty
    && selectedParty.partnerType === 'person';
  // QA6 BM2-4 — a person picked under an organization represents it.
  const orgFirstOnBehalfOf =
    orgFirst && selectedParty?.partnerType === 'person' ? selectedOrgId : null;

  // Persons scoped to the selected org's workers (people UX M3 · T-21).
  // Fetched only when the contact-person picker is open AND the user
  // has NOT toggled "Show all people". Uses the existing server-side
  // `employerId` filter so the picker matches the CustomerContactPicker
  // rule: only that org's staff. External roles also drop company
  // employees (`excludeInternal`, D1 rule).
  const { data: orgWorkers = [] } = useQuery<BpForRepresentation[]>({
    queryKey: ['bp-persons-worker-of', selectedPartyId, orgFirst ? 'external' : 'all'],
    enabled: showContactPicker && !showAllContacts && !!selectedPartyId,
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/business-partners', {
      params: {
        partnerType: 'person',
        employerId: selectedPartyId,
        perPage: 500,
        ...(orgFirst ? { excludeInternal: true } : {}),
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
    enabled: showContactPicker && showAllContacts && !orgFirst,
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
    if (!showAllContacts || orgFirst) return orgWorkers;
    const workerIds = new Set(orgWorkers.map((p) => p.id));
    const workers = allPersons.filter((p) => workerIds.has(p.id));
    const rest = allPersons.filter((p) => !workerIds.has(p.id));
    return [...workers, ...rest];
  }, [showContactPicker, showAllContacts, orgFirst, orgWorkers, allPersons]);
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

  const pickOrganization = (value: string) => {
    setSelectedOrgKey(value);
    // Organization-only roles: the organization is the party.
    setSelectedPartyId(orgIsParty ? Number(value) || null : null);
  };

  const create = useMutation({
    mutationFn: () =>
      client.post('/project-partner-roles', {
        projectId,
        partyId: selectedPartyId,
        roleId: role.id,
        isPrimary,
        titleInProject: titleInProject.trim() || undefined,
        contactPartyId: showContactPicker ? contactPartyId : undefined,
        onBehalfOfPartyId: showOnBehalfPicker
          ? onBehalfOfPartyId
          : orgFirstOnBehalfOf ?? undefined,
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

  const criteria = useMemo(() => roleCriteriaLines(role, orgFirst), [role, orgFirst]);
  // QA6 Supplier — actionable empty state: name the partner role the
  // organization is missing (e.g. "supplier") and where to set it.
  const requiredRoleLabel = role.requiredPartnerRoleCode
    ? role.requiredPartnerRoleCode.replace(/_/g, ' ').toLowerCase()
    : null;
  const isDirty =
    selectedOrgKey !== ''
    || selectedPartyId != null
    || titleInProject.trim().length > 0
    || contactPartyId != null
    || onBehalfOfPartyId != null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Add ${role.name}`}
      widthClass="w-[520px] max-w-[92vw]"
      isDirty={isDirty}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[12px] font-semibold px-3 py-1.5 rounded-lg"
          >
            Cancel
          </button>
          <button
            type="button"
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
        </>
      }
    >
      <div className="space-y-3">
        {/* People UX M3 (T-20) — plain-English criteria replace the
            raw-code banner ("must hold role \"employee\"" / "/partners"). */}
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

          {orgFirst ? (
            <>
              {/* QA6 BM2-4 — step 1: the organization. */}
              <div>
                <label htmlFor="role-picker-org" className={labelClass}>Organization</label>
                <select
                  id="role-picker-org"
                  value={selectedOrgKey}
                  onChange={(e) => pickOrganization(e.target.value)}
                  className={inputClass}
                >
                  <option value="">
                    {candidatesLoading ? 'Loading…' : 'Select an organization...'}
                  </option>
                  {step1Orgs.map((o) => (
                    <option key={o.id} value={String(o.id)}>
                      {orgIsParty ? o.displayName : orgOptionLabel(o)}
                    </option>
                  ))}
                  {!orgIsParty && independentCount > 0 && (
                    <option value={NO_ORG_KEY}>
                      No organization ({independentCount} independent {independentCount === 1 ? 'contact' : 'contacts'})
                    </option>
                  )}
                </select>
                {!candidatesLoading && step1Orgs.length === 0 && (orgIsParty || independentCount === 0) && (
                  <p className={emptyClass}>
                    {requiredRoleLabel
                      ? `No organization is marked as ${article(requiredRoleLabel)} ${requiredRoleLabel} yet. Open it under Organizations and add ${requiredRoleLabel.charAt(0).toUpperCase()}${requiredRoleLabel.slice(1)} to its Role(s), then try again.`
                      : 'No eligible organizations yet. Add one that meets the criteria above under Organizations first.'}
                  </p>
                )}
                {/* Organization-only roles: explain the ineligible
                    organizations here (e.g. "Must be a supplier"). */}
                {!candidatesLoading && orgIsParty && <IneligibleExpander candidates={candidates} />}
              </div>

              {/* QA6 BM2-4 — step 2: one of THAT organization's contacts. */}
              {scopedEnabled && (
                <div>
                  <label htmlFor="role-picker-contact" className={labelClass}>
                    {selectedOrg ? `Contact at ${selectedOrg.displayName}` : 'Contact'}
                  </label>
                  <select
                    id="role-picker-contact"
                    value={selectedPartyId ?? ''}
                    onChange={(e) => setSelectedPartyId(Number(e.target.value) || null)}
                    className={inputClass}
                  >
                    <option value="">
                      {scopedLoading ? 'Loading…' : 'Select a contact...'}
                    </option>
                    {contactChoices.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.partnerType === 'organization'
                          ? `${p.displayName} (the organization itself)`
                          : p.displayName}
                      </option>
                    ))}
                  </select>
                  {!scopedLoading && contactChoices.length === 0 && (
                    <p className={emptyClass}>
                      No eligible contacts at {selectedOrg?.displayName ?? 'this organization'} yet.
                    </p>
                  )}
                  {!scopedLoading && <IneligibleExpander candidates={scoped} />}
                </div>
              )}
            </>
          ) : (
            <div>
              <label className={labelClass}>{role.name}</label>
              {/* TA-1: eligible-only list. Ineligible parties are hidden
                  by default and surfaced on demand via the "N not
                  eligible" expander below, so a busy catalog doesn't
                  bury the eligible rows in a wall of disabled options. */}
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
              </select>
              {!candidatesLoading && candidates.filter((c) => c.eligible).length === 0 && (
                <p className={emptyClass}>
                  No eligible {role.allowedPartnerKind === 'organization' ? 'organizations' : 'people'} yet.
                  Add one that meets the criteria above under People or Partners first.
                </p>
              )}
              {!candidatesLoading && <IneligibleExpander candidates={candidates} />}
            </div>
          )}

          {/* Representation — contact person for an org participant.
              People UX M3 (T-21): worker_of people surface first; a
              "Show all people" toggle widens the list to everyone
              (internal roles only). */}
          {showContactPicker && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase block">
                  Contact person at {selectedParty?.displayName} {role.requiresContactPerson ? <span className="text-amber-600">*</span> : <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>}
                </label>
                {!orgFirst && (
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 select-none cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showAllContacts}
                      onChange={(e) => setShowAllContacts(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-600 text-blue-600"
                    />
                    Show all people
                  </label>
                )}
              </div>
              <select
                value={contactPartyId ?? ''}
                onChange={(e) => setContactPartyId(Number(e.target.value) || null)}
                className={inputClass}
              >
                <option value="">Pick a person...</option>
                {contactOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                    {showAllContacts && !orgFirst && contactWorkerIds.has(p.id) ? ' · works at this Organization' : ''}
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
              <label className={labelClass}>
                On behalf of (Organization) <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>
              </label>
              <select
                value={onBehalfOfPartyId ?? ''}
                onChange={(e) => setOnBehalfOfPartyId(Number(e.target.value) || null)}
                className={inputClass}
              >
                <option value="">None (unaffiliated on this project)</option>
                {orgBps.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.displayName}
                    {personEmployerIds.includes(o.id) ? ' · current employer' : ''}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                Pin the Organization this person represents on THIS project: useful for freelancers or people who work for two firms.
              </p>
            </div>
          )}

          <div>
            <label className={labelClass}>Title on Project (optional)</label>
            <input
              value={titleInProject}
              onChange={(e) => setTitleInProject(e.target.value)}
              placeholder={`e.g. "Lead ${role.name}"`}
              className={inputClass}
            />
          </div>
          {/* TA-3: primary control.
              - When this is the first customer (role.code === 'customer'
                with no existing primary) OR any other primary-required
                role with no primary yet: auto-set and hide the toggle,
                show a muted hint instead.
              - When a primary already exists (adding an additional
                assignment): render the checkbox so the operator can
                choose to move primary. */}
          {role.isPrimaryRequired && autoPrimary && (
            <p className="pt-1 text-[11.5px] text-slate-500 dark:text-slate-400">
              This will be the project's primary {role.name}.
            </p>
          )}
          {role.isPrimaryRequired && !autoPrimary && (
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 pt-1">
              <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600" />
              Mark as primary {role.name}
            </label>
          )}
      </div>
    </Modal>
  );
}
