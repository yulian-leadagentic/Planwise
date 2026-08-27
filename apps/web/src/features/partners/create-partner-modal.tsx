import { useState, useEffect } from 'react';
import { X, User as UserIcon, Building2, AlertCircle, Linkedin, Facebook, Twitter, Instagram } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';

/**
 * Canonical Business Partner creation modal.
 *
 * Replaces the separate CreateContactModal + CreateOrganizationModal
 * pair; those two now live as thin wrappers that call this component
 * with `defaultPartnerType` + `lockPartnerType` set. Consolidation
 * done in ux/partner-contact so there's ONE form to maintain, ONE
 * validation surface, and ONE place to add fields going forward.
 *
 * Behaviour preserved from the specialised modals:
 *   • Full person field set — first/last, Hebrew names, Job Title
 *     (profession), Main Role, employer (with lockEmployer support
 *     for the project Team "add contact for this customer" flow),
 *     role-in-context, contact details, social URLs, notes.
 *   • Full org field set — company name (required), tax id, email,
 *     phone, website, address, Main Role, notes.
 *   • Partial-failure warnings on the person path — creating the BP
 *     is a single POST, but wiring the primary Job Title + the
 *     worker_of relationship happens in follow-up calls that can
 *     silently fail. We track those and surface a warning toast so
 *     users know to open the drawer and finish the setup, instead of
 *     seeing "Contact created" when the employer link never happened.
 */

const inputClass = 'w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none';

interface RelationshipType { id: number; code: string; name: string }
interface Organization { id: number; displayName: string; companyName: string | null }
interface RoleType { id: number; code: string; name: string; appliesToKind?: string }

export interface CreatePartnerModalProps {
  onClose: () => void;
  onCreated: (id: number) => void;
  /** Which mode the modal opens on. */
  defaultPartnerType: 'person' | 'organization';
  /** Hide the person/org toggle. Used by the compatibility wrappers
   *  so a "New Contact" entry point can't be flipped to Org mid-flow. */
  lockPartnerType?: boolean;
  /** Pre-select the employer dropdown to this org id (person mode only). */
  preselectEmployerOrgId?: number;
  /** With preselectEmployerOrgId, forbid the user from changing the
   *  employer. Used by the project Team picker where the surrounding
   *  flow explicitly means "add a contact for THIS customer". */
  lockEmployer?: boolean;
}

export function CreatePartnerModal({
  onClose,
  onCreated,
  defaultPartnerType,
  lockPartnerType = false,
  preselectEmployerOrgId,
  lockEmployer,
}: CreatePartnerModalProps) {
  const queryClient = useQueryClient();
  const [partnerType, setPartnerType] = useState<'person' | 'organization'>(defaultPartnerType);

  // ── Form state ──────────────────────────────────────────────────
  // One flat state object for both modes so switching the toggle
  // doesn't lose whatever the user already typed. Fields simply aren't
  // rendered in the wrong mode.
  const [form, setForm] = useState({
    // Person
    firstName: '',
    lastName: '',
    firstNameHe: '',
    lastNameHe: '',
    primaryProfessionId: '' as string,
    employerOrgId: preselectEmployerOrgId ? String(preselectEmployerOrgId) : ('' as string),
    roleInContext: '',
    linkedinUrl: '',
    facebookUrl: '',
    twitterUrl: '',
    instagramUrl: '',
    mobile: '',
    // Organization
    companyName: '',
    taxId: '',
    address: '',
    // Shared
    email: '',
    phone: '',
    website: '',
    notes: '',
    // BM2 QA-2 Commit 4 (2026-08-27) — Role(s) is now MULTI-select. The
    // array holds the chosen role-type ids in the order the user picked
    // them; the first pick is the primary. On submit we send
    // `initialRoleTypeIds: [...]` (the whole set) + `mainRoleTypeId`
    // (the primary) so the backend syncs one businessPartnerRole row per
    // pick and marks the primary via `syncMainRoleIntoRoles`.
    mainRoleTypeIds: [] as string[],
    // BM2 QA-2 Commit 4 (2026-08-27) — Discipline classification lookup.
    // Person-facing only; INFORMATIONAL, does not gate role eligibility.
    disciplineId: '' as string,
  });

  // Lock background scroll while open — matches the previous behaviour
  // of both wrappers.
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  // ── Data queries ────────────────────────────────────────────────
  const { data: roleTypes = [] } = useQuery<RoleType[]>({
    queryKey: ['partner-role-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/partner-types/role-types').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
  });
  // Filter the Main Role dropdown by the chosen partnerType so the
  // catalog's appliesToKind constraint is respected. Drop 'employee' —
  // employees are managed under /admin/employees, not here.
  const applicableRoles = roleTypes.filter((rt) => {
    if (rt.code === 'employee') return false;
    const kind = rt.appliesToKind ?? 'any';
    return kind === 'any' || kind === partnerType;
  });

  // Employer dropdown + worker_of wiring — only needed in person mode.
  const { data: orgs = [] } = useQuery<Organization[]>({
    queryKey: ['organizations-for-contact'],
    staleTime: 5 * 60 * 1000,
    enabled: partnerType === 'person',
    queryFn: () => client.get('/business-partners?partnerType=organization&perPage=200').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });

  const { data: relTypes = [] } = useQuery<RelationshipType[]>({
    queryKey: ['partner-relationship-types'],
    staleTime: 10 * 60 * 1000,
    enabled: partnerType === 'person',
    queryFn: () => client.get('/admin/partner-types/relationship-types').then((r) => r.data?.data ?? r.data ?? []),
  });

  const { data: professions = [] } = useQuery<Array<{ id: number; name: string }>>({
    queryKey: ['professions'],
    staleTime: 10 * 60 * 1000,
    enabled: partnerType === 'person',
    queryFn: () =>
      client.get('/admin/config/professions').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  // BM2 QA-2 Commit 4 (2026-08-27) — Discipline picker source.
  // Person-only surface, mirroring where Discipline is rendered in the
  // form below. Active-only rows would need a server filter; the admin
  // list already sorts by (sortOrder, name) so we surface everything and
  // trust the admin to hide via the `isActive` flag if a hidden option
  // is needed later.
  const { data: disciplines = [] } = useQuery<Array<{ id: number; name: string; nameHe: string | null; isActive: boolean }>>({
    queryKey: ['admin', 'disciplines', 'picker'],
    staleTime: 10 * 60 * 1000,
    enabled: partnerType === 'person',
    queryFn: () =>
      client.get('/admin/config/disciplines').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  // ── Submit ──────────────────────────────────────────────────────
  const create = useMutation({
    mutationFn: async () => {
      // BM2 QA-2 Commit 4 (2026-08-27) — Role(s) multi-select.
      // The chosen ids go on `initialRoleTypeIds` so the backend inserts
      // one `businessPartnerRole` row per pick at create time; the first
      // pick becomes the primary via `mainRoleTypeId` +
      // `syncMainRoleIntoRoles` on the service. Empty array → no roles
      // + no primary, same as the old "None" option.
      const roleIds = form.mainRoleTypeIds.map((s) => Number(s)).filter((n) => Number.isFinite(n));
      const primaryRoleId = roleIds[0];

      if (partnerType === 'organization') {
        const created: any = await client.post('/business-partners', {
          partnerType: 'organization',
          companyName: form.companyName.trim(),
          taxId: form.taxId.trim() || undefined,
          email: form.email.trim() || undefined,
          phone: form.phone.trim() || undefined,
          website: form.website.trim() || undefined,
          address: form.address.trim() || undefined,
          notes: form.notes.trim() || undefined,
          mainRoleTypeId: primaryRoleId ?? undefined,
          initialRoleTypeIds: roleIds.length > 0 ? roleIds : undefined,
        }).then((r) => r.data?.data ?? r.data);
        return { created, warnings: [] as string[] };
      }

      // Person path — the two follow-up calls can silently fail, so
      // we surface them via `warnings` (see comment on the toast below).
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
        mainRoleTypeId: primaryRoleId ?? undefined,
        initialRoleTypeIds: roleIds.length > 0 ? roleIds : undefined,
        // Discipline classification — person-facing only.
        disciplineId: form.disciplineId ? Number(form.disciplineId) : undefined,
      }).then((r) => r.data?.data ?? r.data);

      const warnings: string[] = [];

      // Set the primary Job Title if the user picked one.
      if (form.primaryProfessionId) {
        await client
          .put(`/business-partners/${created.id}/professions`, {
            professionIds: [Number(form.primaryProfessionId)],
            primaryProfessionId: Number(form.primaryProfessionId),
          })
          .catch(() => { warnings.push('job title'); });
      }

      // Wire the worker_of relationship to the chosen organization.
      // BM2 ops-surfaces Phase A: party↔party edges live on /partner-relationships now.
      if (form.employerOrgId) {
        const workerOf = relTypes.find((rt) => rt.code === 'worker_of');
        if (workerOf) {
          await client.post('/partner-relationships', {
            partyAId: created.id,
            partyBId: Number(form.employerOrgId),
            typeId: workerOf.id,
            titleAtB: form.roleInContext.trim() || undefined,
            isPrimary: true,
          }).catch(() => { warnings.push('employer link'); });
        } else {
          // The worker_of relationship type isn't configured — the user's
          // employer pick can't be materialised. Fail loudly (via warning)
          // rather than silently drop it.
          warnings.push('employer link');
        }
      }

      return { created, warnings };
    },
    onSuccess: ({ created, warnings }: { created: any; warnings: string[] }) => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      const noun = partnerType === 'person' ? 'Contact' : 'Organization';
      const code = partnerType === 'person' ? 'CONTACT-CREATE' : 'ORG-CREATE';
      if (warnings.length > 0) {
        notify.warning(
          `${noun} created, but couldn't save: ${warnings.join(', ')}. Open the ${noun.toLowerCase()} to finish setting it up.`,
          { code: `${code}-207` },
        );
      } else {
        notify.success(`${noun} created`, { code: `${code}-200` });
      }
      onCreated(created.id);
    },
    onError: (err: any) => notify.apiError(err, `Failed to create ${partnerType === 'person' ? 'contact' : 'organization'}`),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (partnerType === 'person') {
      // English name — REQUIRED. Accept either a first or a last name so a
      // single-name contact (e.g. an anglicised mononym) still saves.
      if (!form.firstName.trim() && !form.lastName.trim()) {
        notify.warning('Enter at least a first or last name (English)', { code: 'CONTACT-CREATE-400' });
        return;
      }
      // BM2 QA-2 Commit 4 (2026-08-27) — Hebrew is normally OPTIONAL, but
      // becomes REQUIRED when the contact is an organization employee
      // (`worker_of` an org). Detected via the Employer dropdown — when
      // the user has selected an org (or the modal was opened with
      // `preselectEmployerOrgId + lockEmployer` for the customer/supplier
      // contact flow), we need the Hebrew name too so the invoice / print
      // surfaces render correctly in Hebrew-first workflows.
      const isOrgEmployee = form.employerOrgId.trim().length > 0;
      if (isOrgEmployee && !form.firstNameHe.trim() && !form.lastNameHe.trim()) {
        notify.warning('Hebrew name is required for organization employees', {
          code: 'CONTACT-CREATE-400-HE',
        });
        return;
      }
    } else {
      if (!form.companyName.trim()) {
        notify.warning('Organization name is required', { code: 'ORG-CREATE-400' });
        return;
      }
    }
    create.mutate();
  };

  // ── Rendering ───────────────────────────────────────────────────
  const isPerson = partnerType === 'person';
  const titleIcon = isPerson
    ? <UserIcon className="h-4 w-4 text-blue-600" />
    : <Building2 className="h-4 w-4 text-violet-600" />;
  const titleText = lockPartnerType
    ? (isPerson ? 'Add Contact' : 'Add Organization')
    : 'Add Business Partner';
  const submitLabel = isPerson ? 'Create Contact' : 'Create Organization';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[560px] max-w-[92vw] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900 z-10">
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            {titleIcon}
            {titleText}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Person/org toggle — hidden when the caller has locked the
              type via the wrappers (CreateContactModal / CreateOrganizationModal). */}
          {!lockPartnerType && (
            <div className="grid grid-cols-2 gap-2">
              {(['person', 'organization'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setPartnerType(t)}
                  className={cn(
                    'flex items-center justify-center gap-2 rounded-lg border-2 px-4 py-3 text-sm font-medium transition-colors',
                    partnerType === t
                      ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600',
                  )}
                >
                  {t === 'person' ? <UserIcon className="h-4 w-4" aria-hidden="true" /> : <Building2 className="h-4 w-4" aria-hidden="true" />}
                  {t === 'person' ? 'Person' : 'Organization'}
                </button>
              ))}
            </div>
          )}

          {isPerson ? (
            <PersonForm
              form={form}
              setForm={setForm}
              orgs={orgs}
              professions={professions}
              personRoleTypes={applicableRoles}
              disciplines={disciplines}
              lockEmployer={!!lockEmployer}
            />
          ) : (
            <OrganizationForm
              form={form}
              setForm={setForm}
              orgRoleTypes={applicableRoles}
            />
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800 sticky bottom-0 bg-white dark:bg-slate-900">
            <button
              type="button"
              onClick={onClose}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={create.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50"
            >
              {create.isPending ? 'Creating...' : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Sub-forms per partner type ─────────────────────────────────────

type FormState = Parameters<Parameters<typeof CreatePartnerModal>[0]['onCreated']>[0] extends number ? never : never; // placeholder so TS doesn't infer
// (Real type is the useState-shape below — kept inline to avoid a
// separate declaration that would drift from the state initializer.)

function PersonForm({
  form,
  setForm,
  orgs,
  professions,
  personRoleTypes,
  disciplines,
  lockEmployer,
}: {
  form: any;
  setForm: React.Dispatch<React.SetStateAction<any>>;
  orgs: Organization[];
  professions: Array<{ id: number; name: string }>;
  personRoleTypes: RoleType[];
  disciplines: Array<{ id: number; name: string; nameHe: string | null; isActive: boolean }>;
  lockEmployer: boolean;
}) {
  void ({} as FormState);
  // BM2 QA-2 Commit 4 (2026-08-27) — Hebrew is REQUIRED when the contact
  // is an organization employee. Detected client-side by the presence of
  // an Employer selection (or a locked-in employer preselect from the
  // ProjectBpPicker's customer-contact / supplier-worker mode).
  const isOrgEmployee = String(form.employerOrgId ?? '').trim().length > 0;
  return (
    <>
      <p className="text-[12px] text-slate-500 dark:text-slate-400">
        A person who works at one of your customer or supplier organizations. The classification (customer-side vs supplier-side) is derived from the employer you pick — you don't tag it manually.
      </p>

      {orgs.length === 0 && (
        <div className="rounded-md bg-amber-50 border border-amber-200 dark:bg-amber-900/20 dark:border-amber-800 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>No organizations exist yet. Add one first (switch this modal to Organization), then come back here.</span>
        </div>
      )}

      {/* Identity — English name is REQUIRED (at least one of first / last);
          Hebrew is optional except when the contact is an org employee
          (worker_of an org), where both English AND Hebrew are required.
          The conditional-required label mirrors the state used by the
          submit-time guardrail. */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
            First Name <span className="text-red-600 dark:text-red-400">*</span>
          </label>
          <input value={form.firstName} onChange={(e) => setForm((f: any) => ({ ...f, firstName: e.target.value }))} className={inputClass} autoFocus />
        </div>
        <div>
          <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
            Last Name <span className="text-red-600 dark:text-red-400">*</span>
          </label>
          <input value={form.lastName} onChange={(e) => setForm((f: any) => ({ ...f, lastName: e.target.value }))} className={inputClass} />
        </div>
      </div>
      <p className="text-[11px] text-slate-400 dark:text-slate-500">Enter a first and/or last name in English (at least one).</p>
      {/* Hebrew names — bilingual search picks these up so contacts are
          findable in either language. Required for org employees, optional
          otherwise — the required marker + helper copy switches on
          `isOrgEmployee`. */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
            שם פרטי{' '}
            {isOrgEmployee ? (
              <span className="text-red-600 dark:text-red-400">*</span>
            ) : (
              <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>
            )}
          </label>
          <input dir="rtl" value={form.firstNameHe} onChange={(e) => setForm((f: any) => ({ ...f, firstNameHe: e.target.value }))} className={inputClass} />
        </div>
        <div>
          <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
            שם משפחה{' '}
            {isOrgEmployee ? (
              <span className="text-red-600 dark:text-red-400">*</span>
            ) : (
              <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>
            )}
          </label>
          <input dir="rtl" value={form.lastNameHe} onChange={(e) => setForm((f: any) => ({ ...f, lastNameHe: e.target.value }))} className={inputClass} />
        </div>
      </div>
      {isOrgEmployee && (
        <p className="text-[11px] text-amber-700 dark:text-amber-300">
          Hebrew name is required because this contact is being tagged as an organization employee.
        </p>
      )}

      {/* Job Title (Profession) */}
      <div>
        <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
          Job Title <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>
        </label>
        <select
          value={form.primaryProfessionId}
          onChange={(e) => setForm((f: any) => ({ ...f, primaryProfessionId: e.target.value }))}
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
        <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
          The person's actual profession (e.g. Architect, MEP Engineer). Used by project role pickers to suggest qualified candidates. Add more titles from the partner profile after creation.
        </p>
      </div>

      {/* BM2 QA-2 Commit 4 (2026-08-27) — Role(s), multi-select. Relabelled
          from "Main Role" to "Role(s)" so the multi-select semantics are
          visible in the label. First pick is the primary (used as
          `mainRoleTypeId`); all picks are written as `businessPartnerRole`
          rows via the DTO's `initialRoleTypeIds`. Eligibility on
          `project_partner_roles` reads the set (party.roles.some(...)) so
          any of the picks that matches passes the guard. */}
      <div>
        <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
          Role(s) <span className="text-slate-400 dark:text-slate-500 font-normal">(optional, multi)</span>
        </label>
        <RoleMultiSelect
          value={form.mainRoleTypeIds}
          onChange={(next) => setForm((f: any) => ({ ...f, mainRoleTypeIds: next }))}
          options={personRoleTypes}
        />
        <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
          Pick one or more categorizations (Customer, Supplier, Consultant…). The first pick is the primary. Project-level responsibilities are set via relationships.
        </p>
      </div>

      {/* BM2 QA-2 Commit 4 (2026-08-27) — Discipline picker. INFORMATIONAL
          only — display / search classification (Architecture / Structural /
          MEP / …). Never gates project-role eligibility (that lives on
          Profession + Role(s)). Sourced from /admin/config/disciplines
          managed via the /admin/disciplines admin page. */}
      <div>
        <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
          Discipline <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>
        </label>
        <select
          value={form.disciplineId}
          onChange={(e) => setForm((f: any) => ({ ...f, disciplineId: e.target.value }))}
          className={inputClass}
          disabled={disciplines.length === 0}
        >
          <option value="">
            {disciplines.length === 0
              ? 'No disciplines configured — add some in /admin/disciplines first'
              : '— None / set later —'}
          </option>
          {disciplines
            .filter((d) => d.isActive)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.nameHe ? ` · ${d.nameHe}` : ''}
              </option>
            ))}
        </select>
        <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
          Branch of engineering (display + search only). Managed under Admin → Disciplines.
        </p>
      </div>

      {/* Employer + role-in-context */}
      <div>
        <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Employer (organization)</label>
        {lockEmployer && form.employerOrgId ? (
          <div className={`${inputClass} bg-slate-50 dark:bg-slate-800/50 text-slate-700 dark:text-slate-200 cursor-not-allowed flex items-center justify-between`}>
            <span className="font-medium">
              {orgs.find((o) => String(o.id) === String(form.employerOrgId))?.displayName
                ?? `Organization #${form.employerOrgId}`}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">Locked</span>
          </div>
        ) : (
          <select value={form.employerOrgId} onChange={(e) => setForm((f: any) => ({ ...f, employerOrgId: e.target.value }))} className={inputClass}>
            <option value="">— None / unaffiliated —</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>{o.displayName}</option>
            ))}
          </select>
        )}
        <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
          Creates a <code>worker_of</code> relationship — the contact's "context" is defined here.
        </p>
      </div>
      {form.employerOrgId && (
        <div>
          <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Role at the organization (optional)</label>
          <input
            value={form.roleInContext}
            onChange={(e) => setForm((f: any) => ({ ...f, roleInContext: e.target.value }))}
            placeholder='e.g. "Operations Manager", "Buyer"'
            className={inputClass}
          />
        </div>
      )}

      {/* Contact details */}
      <div className="space-y-3">
        <h3 className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Contact details</h3>
        <div>
          <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Email</label>
          <input type="email" value={form.email} onChange={(e) => setForm((f: any) => ({ ...f, email: e.target.value }))} className={inputClass} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Phone</label>
            <input value={form.phone} onChange={(e) => setForm((f: any) => ({ ...f, phone: e.target.value }))} className={inputClass} />
          </div>
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Mobile</label>
            <input value={form.mobile} onChange={(e) => setForm((f: any) => ({ ...f, mobile: e.target.value }))} className={inputClass} />
          </div>
        </div>
      </div>

      {/* Online presence */}
      <div className="space-y-3">
        <h3 className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Online presence</h3>
        <SocialField icon={<Linkedin className="h-4 w-4 text-[#0a66c2]" />} label="LinkedIn"  value={form.linkedinUrl}  onChange={(v) => setForm((f: any) => ({ ...f, linkedinUrl: v }))}  placeholder="https://linkedin.com/in/..." />
        <SocialField icon={<Facebook className="h-4 w-4 text-[#1877f2]" />} label="Facebook"  value={form.facebookUrl}  onChange={(v) => setForm((f: any) => ({ ...f, facebookUrl: v }))}  placeholder="https://facebook.com/..." />
        <SocialField icon={<Twitter  className="h-4 w-4 text-[#1da1f2]" />} label="Twitter / X" value={form.twitterUrl}   onChange={(v) => setForm((f: any) => ({ ...f, twitterUrl: v }))}   placeholder="https://x.com/..." />
        <SocialField icon={<Instagram className="h-4 w-4 text-[#e4405f]" />} label="Instagram" value={form.instagramUrl} onChange={(v) => setForm((f: any) => ({ ...f, instagramUrl: v }))} placeholder="https://instagram.com/..." />
        <div>
          <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Website</label>
          <input value={form.website} onChange={(e) => setForm((f: any) => ({ ...f, website: e.target.value }))} placeholder="https://example.com" className={inputClass} />
        </div>
      </div>

      {/* Notes */}
      <div>
        <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Notes</label>
        <textarea value={form.notes} onChange={(e) => setForm((f: any) => ({ ...f, notes: e.target.value }))} rows={3} className={cn(inputClass, 'resize-none')} />
      </div>
    </>
  );
}

function OrganizationForm({
  form,
  setForm,
  orgRoleTypes,
}: {
  form: any;
  setForm: React.Dispatch<React.SetStateAction<any>>;
  orgRoleTypes: RoleType[];
}) {
  return (
    <>
      <p className="text-[12px] text-slate-500 dark:text-slate-400">
        Companies, customers, suppliers, municipalities, partner firms — anything that has its own legal identity.
      </p>

      <div>
        <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Organization Name *</label>
        <input value={form.companyName} onChange={(e) => setForm((f: any) => ({ ...f, companyName: e.target.value }))} className={inputClass} autoFocus />
      </div>

      <div>
        <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Tax ID</label>
        <input value={form.taxId} onChange={(e) => setForm((f: any) => ({ ...f, taxId: e.target.value }))} className={inputClass} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Email</label>
          <input type="email" value={form.email} onChange={(e) => setForm((f: any) => ({ ...f, email: e.target.value }))} className={inputClass} />
        </div>
        <div>
          <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Phone</label>
          <input value={form.phone} onChange={(e) => setForm((f: any) => ({ ...f, phone: e.target.value }))} className={inputClass} />
        </div>
      </div>

      <div>
        <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Website</label>
        <input value={form.website} onChange={(e) => setForm((f: any) => ({ ...f, website: e.target.value }))} className={inputClass} />
      </div>

      <div>
        <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Address</label>
        <input value={form.address} onChange={(e) => setForm((f: any) => ({ ...f, address: e.target.value }))} className={inputClass} />
      </div>

      {/* BM2 QA-2 Commit 4 (2026-08-27) — Role(s), multi-select (org side).
          Same multi-role model as the person form so organizations that
          double as e.g. customer + supplier can carry both roles.
          Discipline is deliberately NOT rendered on the org form — per
          the spec Discipline is a person-facing classification only. */}
      <div>
        <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
          Role(s) <span className="text-slate-400 dark:text-slate-500 font-normal">(optional, multi)</span>
        </label>
        <RoleMultiSelect
          value={form.mainRoleTypeIds}
          onChange={(next) => setForm((f: any) => ({ ...f, mainRoleTypeIds: next }))}
          options={orgRoleTypes}
        />
        <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
          Pick one or more categorizations (Customer, Supplier, Subcontractor…). The first pick is the primary. Project-level context lives on relationships.
        </p>
      </div>

      <div>
        <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Notes</label>
        <textarea value={form.notes} onChange={(e) => setForm((f: any) => ({ ...f, notes: e.target.value }))} rows={3} className={cn(inputClass, 'resize-none')} />
      </div>
    </>
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
      <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 flex items-center gap-1.5">
        {icon}
        {label}
      </label>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputClass} />
    </div>
  );
}

/**
 * BM2 QA-2 Commit 4 (2026-08-27) — chip-toggle multi-select for role
 * types. Renders every applicable role as a clickable pill; the first
 * pick is treated as the primary and gets a small "primary" badge so
 * users can see which one becomes `mainRoleTypeId` on save.
 *
 * State model: the value is a string[] of role-type ids in the order the
 * user picked them. Clicking an unselected pill appends its id; clicking
 * a selected pill removes it (if the removed id was the primary, the
 * next pick becomes the new primary automatically because it's simply
 * the new first element).
 *
 * Inline (not extracted to /components/shared) — the surface is small
 * and modal-specific; sharing would require a more general options
 * contract we don't need elsewhere yet.
 */
function RoleMultiSelect({
  value,
  onChange,
  options,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  options: RoleType[];
}) {
  const toggle = (id: number) => {
    const asStr = String(id);
    if (value.includes(asStr)) {
      onChange(value.filter((v) => v !== asStr));
    } else {
      onChange([...value, asStr]);
    }
  };
  if (options.length === 0) {
    return (
      <div className={cn(inputClass, 'text-slate-400 dark:text-slate-500 italic bg-slate-50 dark:bg-slate-800/40')}>
        No role types configured — add some under Admin → Partner Types first.
      </div>
    );
  }
  return (
    <div
      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 flex flex-wrap gap-1.5"
      role="group"
      aria-label="Role(s)"
    >
      {options.map((rt) => {
        const asStr = String(rt.id);
        const idx = value.indexOf(asStr);
        const selected = idx >= 0;
        const isPrimary = idx === 0;
        return (
          <button
            key={rt.id}
            type="button"
            onClick={() => toggle(rt.id)}
            aria-pressed={selected}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium border transition-colors',
              selected
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600',
            )}
          >
            {rt.name}
            {isPrimary && (
              <span
                className="ml-1 rounded-full bg-blue-600 dark:bg-blue-500 text-white text-[9px] uppercase tracking-wider px-1 py-[1px]"
                title="Primary — used for main-role filters and eligibility"
              >
                Primary
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
