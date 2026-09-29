import { useState, useEffect, useMemo, useRef } from 'react';
import { User as UserIcon, Building2, Pencil, Trash2, Plus, Save, ChevronRight, Briefcase, FolderKanban, Linkedin, Facebook, Twitter, Instagram, Check, Search } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { usePermissions } from '@/hooks/use-permissions';
import { formatDate } from '@/lib/date-utils';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { CreatePartnerModal } from './create-partner-modal';
import { TextField, SelectField, TextAreaField, Field } from '@/components/shared/field';
import { Modal, Sheet } from '@/components/shared/modal';
import { Tabs, tabPanelId, tabTriggerId } from '@/components/shared/tabs';

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

/**
 * BM2 ops-surfaces Phase A: `outgoingRelationships` is a **client-side**
 * merge of the two real shapes returned by /business-partners:
 *   • `partnerRelationshipsA` — party↔party (BUT050) rows where this bp
 *     is party A. `targetType` is always `'organization'` (party B).
 *   • `projectPartnerRoles`   — project participation rows.
 * Delete/create routing per row lives on `sourceTable`; the UI keeps its
 * grouped rendering intact.
 */
interface Relationship extends RelationshipTarget {
  id: number;
  sourceTable: 'partner_relationship' | 'project_partner_role';
  targetType: 'project' | 'organization';
  targetId: number;
  roleInContext: string | null;
  isPrimary: boolean;
  validFrom: string | null;
  validTo: string | null;
  status: string;
  notes: string | null;
  relationshipType: RelationshipType;
}

/** Raw partner_relationships row where this bp is party A. */
interface PartnerRelationshipARow {
  id: number;
  typeId: number;
  type: RelationshipType;
  partyBId: number;
  partyB: { id: number; displayName: string; partnerType: string };
  titleAtB: string | null;
  isPrimary: boolean;
  validFrom: string | null;
  validTo: string | null;
  status: string;
  notes: string | null;
}

/** Raw project_partner_roles row where this bp is the party. */
interface ProjectPartnerRoleRow {
  id: number;
  roleId: number;
  role: { id: number; code: string; name: string };
  projectId: number;
  project: { id: number; name: string; number: string | null } | null;
  titleInProject: string | null;
  isPrimary: boolean;
  validFrom: string | null;
  validTo: string | null;
  status: string;
  notes: string | null;
}

interface BusinessPartnerFull {
  id: number;
  partnerType: 'person' | 'organization';
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  // People UX M2c (P-11 / P-37) — Hebrew names + Discipline surfaced so
  // the drawer edit mode can round-trip them. Same fields the create
  // modal writes; before M2c the drawer's payload silently dropped
  // both, so a value set at create time was invisible here.
  firstNameHe: string | null;
  lastNameHe: string | null;
  disciplineId: number | null;
  discipline: { id: number; name: string; nameHe: string | null } | null;
  companyName: string | null;
  taxId: string | null;
  email: string | null;
  /**
   * QA4 R2 IMP-9 (2026-09-29) — additional emails beyond the primary
   * (populated by contacts-import: generic mailboxes on orgs, alt
   * personal addresses on persons). Drawer shows one merged list;
   * the primary column above is kept as the dedup + notification key.
   */
  emails?: Array<{ id: number; email: string; isPrimary: boolean; createdAt: string }>;
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
  // BM2 ops-surfaces Phase A — new shape from /business-partners.
  partnerRelationshipsA: PartnerRelationshipARow[];
  projectPartnerRoles: ProjectPartnerRoleRow[];
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

/**
 * Merge the two real backend arrays into the unified `Relationship[]`
 * the drawer renders. Rows carry `sourceTable` so per-row delete routes
 * to /partner-relationships vs /project-partner-roles correctly.
 */
function mergeOutgoing(bp: {
  partnerRelationshipsA?: PartnerRelationshipARow[];
  projectPartnerRoles?: ProjectPartnerRoleRow[];
}): Relationship[] {
  const out: Relationship[] = [];
  for (const r of bp.partnerRelationshipsA ?? []) {
    out.push({
      id: r.id,
      sourceTable: 'partner_relationship',
      targetType: 'organization',
      targetId: r.partyBId,
      targetName: r.partyB?.displayName,
      roleInContext: r.titleAtB,
      isPrimary: r.isPrimary,
      validFrom: r.validFrom,
      validTo: r.validTo,
      status: r.status,
      notes: r.notes,
      relationshipType: r.type,
    });
  }
  for (const r of bp.projectPartnerRoles ?? []) {
    // Project rows synthesize a `relationshipType` shape from the
    // project-role's code/name so the existing renderer keeps working
    // ("→ Project X" chips).
    out.push({
      id: r.id,
      sourceTable: 'project_partner_role',
      targetType: 'project',
      targetId: r.projectId,
      targetName: r.project?.name,
      targetCode: r.project?.number ?? null,
      roleInContext: r.titleInProject,
      isPrimary: r.isPrimary,
      validFrom: r.validFrom,
      validTo: r.validTo,
      status: r.status,
      notes: r.notes,
      relationshipType: {
        id: r.roleId,
        code: r.role.code,
        name: r.role.name,
        applicableTargetTypes: null,
        sideALabel: null,
        sideBLabel: null,
        inverseLabel: null,
        sideATargets: null,
        sideBTargets: null,
        sideAKind: null,
        sideBKind: null,
      },
    });
  }
  return out;
}

export function PartnerDrawer({
  partnerId,
  onClose,
}: {
  partnerId: number;
  onClose: () => void;
}) {
  // Tabs simplified to (details | relationships). The legacy Roles tab is
  // gone; the primary role now surfaces as a small chip in the header
  // subtitle and is edited via the Details tab's Role(s) multi-select.
  // All additional role context is expressed via Relationships.
  const [tab, setTab] = useState<'details' | 'relationships'>('details');
  const { can, isAdmin } = usePermissions();
  const canWrite = isAdmin || can('partners', 'write');
  const canDelete = isAdmin || can('partners', 'delete');
  // QA3 Commit D (Item 6a) — "Add contact" flow launched from an org
  // drawer. Preselects the employer to THIS org and locks it so the
  // resulting person is worker_of this org from the start.
  const [addContactOpen, setAddContactOpen] = useState(false);

  // People UX M1 (P-07 / P-08) — Escape/backdrop/focus-trap semantics
  // now come from the shared Sheet shell. The shell yields Escape to
  // any Modal mounted on top, so hitting Escape inside "Add Relationship"
  // closes only that modal, not the drawer behind it.
  //
  // People UX U6 (P-07) — dirty-guard on Escape / backdrop when the
  // Details tab is in edit mode with unsaved changes. Lifted here so
  // the Sheet shell can wire `isDirty` (its built-in "Discard changes?"
  // confirm). DetailsTab computes the boolean (editing && form !==
  // initialForm) and pushes it up via `onDirtyChange`.
  const [detailsDirty, setDetailsDirty] = useState(false);

  const { data: bp, isLoading, isError, refetch } = useQuery<BusinessPartnerFull>({
    queryKey: ['business-partners', partnerId],
    queryFn: () => client.get(`/business-partners/${partnerId}`).then((r) => r.data?.data ?? r.data),
  });

  return (
    <Sheet
      open
      onClose={onClose}
      widthClass="w-[560px] max-w-[92vw]"
      bodyClassName="p-0"
      isDirty={detailsDirty}
      dirtyWarning="Discard your unsaved changes?"
    >
      {/* Custom header — the drawer wants an avatar cluster next to the
          title, so we omit Sheet's default title/close-X and render our
          own header inside children. */}
      <div className="flex items-start gap-3 border-b border-slate-200 dark:border-slate-700 px-5 py-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 shrink-0">
          {bp?.partnerType === 'organization' ? <Building2 className="h-5 w-5" /> : <UserIcon className="h-5 w-5" />}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 truncate">{bp?.displayName ?? '...'}</h2>
          <p className="text-[11px] text-slate-400 dark:text-slate-500">
            {bp?.partnerType === 'organization' ? 'Organization' : 'Person'}
            {/* People UX M2c follow-up — the standalone main-role pill
                is gone: the Details tab's Role(s) multi-select is the
                one editor. Keep the primary role visible as a compact
                chip in the header subtitle so casual reads still say
                "who this contact is". */}
            {bp?.mainRoleType && (
              <>
                {' · '}
                <span className="font-semibold text-slate-600 dark:text-slate-300">
                  {bp.mainRoleType.name}
                </span>
              </>
            )}
            {bp?.user && ' · Has login account'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 shrink-0"
          aria-label={`Close details for ${bp?.displayName ?? 'partner'}`}
        >
          <span aria-hidden="true" className="text-lg leading-none">×</span>
        </button>
      </div>

        {/* QA3 Commit D (Item 6a) — quick action strip for orgs.
            Renders "Add contact" so a user landing on a customer's
            drawer can create a person under that employer in one
            click, no navigation. Person-side drawers get no action
            (they have no "employer" to prefill). */}
        {bp?.partnerType === 'organization' && canWrite && (
          <div className="flex items-center justify-end gap-2 border-b border-slate-100 dark:border-slate-800 px-5 py-2 bg-slate-50/40 dark:bg-slate-800/30">
            <button
              type="button"
              onClick={() => setAddContactOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-400 dark:hover:border-blue-500 hover:text-blue-700 dark:hover:text-blue-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              title={`Add a new person working at ${bp.displayName}`}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add contact
            </button>
          </div>
        )}

        {/* Tabs — People UX M5 (E-27) follow-up. Uses the shared
            <Tabs> primitive so keyboard navigation, aria-selected /
            aria-controls, and the underline styling match every
            other tab bar in the app. Local state (no URL param) is
            kept because the drawer is a mount-and-close view. */}
        <div className="px-5">
          <Tabs
            idBase={`partner-drawer-${partnerId}`}
            ariaLabel="Partner details tabs"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'details', label: 'Details' },
              {
                value: 'relationships',
                label: 'Relationships',
                badge: bp
                  ? (bp.partnerRelationshipsA?.length ?? 0)
                    + (bp.projectPartnerRoles?.length ?? 0)
                    + (bp.incomingRelationships?.length ?? 0)
                  : undefined,
              },
            ]}
          />
        </div>

      {/* Content */}
      <div
        role="tabpanel"
        id={tabPanelId(`partner-drawer-${partnerId}`, tab)}
        aria-labelledby={tabTriggerId(`partner-drawer-${partnerId}`, tab)}
        className="flex-1 overflow-y-auto px-5 py-4"
      >
        {isError ? (
          <div className="text-sm text-slate-400 dark:text-slate-500 text-center py-8">
            Couldn't load this partner.{' '}
            <button type="button" onClick={() => refetch()} className="font-medium text-blue-600 hover:underline">Retry</button>
          </div>
        ) : isLoading || !bp ? (
          <div className="text-sm text-slate-400 dark:text-slate-500 text-center py-8">Loading...</div>
        ) : tab === 'details' ? (
          <DetailsTab
            bp={bp}
            canWrite={canWrite}
            canDelete={canDelete}
            onClose={onClose}
            onDirtyChange={setDetailsDirty}
          />
        ) : (
          <RelationshipsTab bp={bp} canWrite={canWrite} canDelete={canDelete} />
        )}
      </div>

      {/* QA3 Commit D (Item 6a) — the person-create modal launched from
          this drawer. Pinned to person mode + this org as the locked
          employer so the flow explicitly reads "add a contact at THIS
          org". */}
      {addContactOpen && bp?.partnerType === 'organization' && (
        <CreatePartnerModal
          defaultPartnerType="person"
          lockPartnerType
          preselectEmployerOrgId={bp.id}
          lockEmployer
          onClose={() => setAddContactOpen(false)}
          onCreated={() => setAddContactOpen(false)}
        />
      )}
    </Sheet>
  );
}

// ─── Details ─────────────────────────────────────────────────────────────────

function DetailsTab({
  bp,
  canWrite,
  canDelete,
  onClose,
  onDirtyChange,
}: {
  bp: BusinessPartnerFull;
  canWrite: boolean;
  canDelete: boolean;
  onClose: () => void;
  /** Bubbles the Details form's dirty state up to `PartnerDrawer` so the
   *  Sheet shell can gate Escape / backdrop close with a "Discard
   *  changes?" confirm (People UX U6 · P-07). */
  onDirtyChange: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);

  // Active worker_of relationship (persons only) — defines the contact's employer.
  // BM2 ops-surfaces Phase A: read from partnerRelationshipsA (party↔party).
  const employerRel = useMemo(
    () => (bp.partnerRelationshipsA ?? []).find(
      (r) => r.type.code === 'worker_of' && r.status === 'active',
    ),
    [bp.partnerRelationshipsA],
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
    () => orgs.find((o) => o.id === employerRel?.partyBId)
      ?? (employerRel ? { id: employerRel.partyBId, displayName: employerRel.partyB?.displayName ?? bp.companyName ?? 'Unknown' } : null),
    [orgs, employerRel, bp.companyName],
  );

  // Rebuild the form's initial values from the current bp + active
  // worker_of edge. Recomputed whenever the underlying bp changes (e.g.
  // after a save invalidates the list), which resets the diff baseline
  // used by the dirty-guard.
  const initialForm = useMemo(() => ({
    firstName: bp.firstName ?? '',
    lastName: bp.lastName ?? '',
    // People UX M2c — Hebrew names, Discipline, Role(s), Title at {Org}
    // are all edit-mode fields now. See DetailsTab render below.
    firstNameHe: bp.firstNameHe ?? '',
    lastNameHe: bp.lastNameHe ?? '',
    disciplineId: bp.disciplineId != null ? String(bp.disciplineId) : '',
    /** Ordered list of role-type ids the person/org carries. First entry
     *  is the primary (used as `mainRoleTypeId` on save). Mirrors the
     *  create-partner-modal's `mainRoleTypeIds` state so the two forms
     *  share one editing model. */
    roleTypeIds: (() => {
      const list = bp.roles ?? [];
      // Primary first, then everything else in stable order.
      const primary = list.find((r) => r.isPrimary);
      const rest = list.filter((r) => !r.isPrimary);
      const ordered = primary ? [primary, ...rest] : list;
      return ordered.map((r) => String(r.roleType.id));
    })(),
    /** Title at the current employer (M4 glossary: "Title at {Org}").
     *  Backed by `titleAtB` on the active worker_of relationship. Saved
     *  by PATCHing the same row on submit. */
    titleAtOrg: employerRel?.titleAtB ?? '',
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
    employerOrgId: employerRel?.partyBId ?? null as number | null,
  }), [bp, employerRel]);

  const [form, setForm] = useState(initialForm);

  // Re-sync form to the latest initialForm baseline when NOT editing —
  // covers async loads (orgs list, employerRel becoming available) and
  // post-save refetches. In edit mode we don't clobber the user's
  // in-progress changes.
  useEffect(() => {
    if (!editing) setForm(initialForm);
  }, [initialForm, editing]);

  // People UX U6 (P-07) — dirty-guard signal. True only while editing
  // and the form diverges from the snapshot. Shallow diff is enough —
  // roleTypeIds is the only array field.
  const isDirty = useMemo(() => {
    if (!editing) return false;
    return (Object.keys(initialForm) as Array<keyof typeof initialForm>).some((k) => {
      const a = (form as any)[k];
      const b = (initialForm as any)[k];
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return true;
        return a.some((v, i) => v !== b[i]);
      }
      return a !== b;
    });
  }, [editing, form, initialForm]);

  useEffect(() => {
    onDirtyChange(isDirty);
    return () => onDirtyChange(false);
  }, [isDirty, onDirtyChange]);

  // People UX M2c — discipline catalog + role-type catalog for the
  // person edit form. Both are cached elsewhere (create modal, admin
  // pages), so this hits warm data most of the time.
  const { data: disciplines = [] } = useQuery<Array<{ id: number; name: string; nameHe: string | null; isActive: boolean }>>({
    queryKey: ['admin', 'disciplines', 'picker'],
    staleTime: 10 * 60 * 1000,
    enabled: editing && bp.partnerType === 'person',
    queryFn: () =>
      client.get('/admin/config/disciplines').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const { data: roleTypes = [] } = useQuery<Array<{ id: number; code: string; name: string; appliesToKind?: string }>>({
    queryKey: ['partner-role-types'],
    staleTime: 10 * 60 * 1000,
    enabled: editing,
    queryFn: () => client.get('/admin/partner-types/role-types').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
  });
  // Same filter the create-partner-modal applies: drop 'employee'
  // (managed under People) and respect appliesToKind.
  const applicableRoleTypes = useMemo(
    () => roleTypes.filter((rt) => {
      if (rt.code === 'employee') return false;
      const kind = rt.appliesToKind ?? 'any';
      return kind === 'any' || kind === bp.partnerType;
    }),
    [roleTypes, bp.partnerType],
  );

  const update = useMutation({
    mutationFn: async () => {
      // People UX M2c — role diff: figure out what the multi-select
      // added, removed, and which id is now primary. Ordered array so
      // the first pick is the primary (matches create-partner-modal's
      // model). Numbers throughout to keep the API surface consistent.
      const nextRoleIds = form.roleTypeIds
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n));
      const nextPrimary = nextRoleIds[0] ?? null;
      const currentRoleIds = new Set((bp.roles ?? []).map((r) => r.roleType.id));
      const toAdd = nextRoleIds.filter((id) => !currentRoleIds.has(id));
      const toRemove = (bp.roles ?? []).filter((r) => !nextRoleIds.includes(r.roleType.id));

      // People UX U6 (P-09) — collect per-step failures. Mirrors the
      // `create-partner-modal` partial-failure pattern: the main BP
      // PATCH goes through `onError` normally, but every follow-up
      // call (roles diff, worker_of delete/create/patch) is captured
      // so `onSuccess` can decide between a success toast and a
      // sticky warning that names what didn't stick.
      const warnings: string[] = [];

      // 1. Update plain BP fields. Main Role goes on the same PATCH so
      //    the write is transactional server-side (the primary role
      //    also lives on `main_role_type_id`; the service's
      //    `syncMainRoleIntoRoles` keeps the two representations
      //    aligned).
      await client.patch(`/business-partners/${bp.id}`, {
        firstName: bp.partnerType === 'person' ? form.firstName.trim() || null : undefined,
        lastName: bp.partnerType === 'person' ? form.lastName.trim() || null : undefined,
        firstNameHe: bp.partnerType === 'person' ? form.firstNameHe.trim() || null : undefined,
        lastNameHe: bp.partnerType === 'person' ? form.lastNameHe.trim() || null : undefined,
        disciplineId:
          bp.partnerType === 'person'
            ? (form.disciplineId ? Number(form.disciplineId) : null)
            : undefined,
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
        // Send the primary role id (or null to clear). Explicit-null
        // matches the header pill's "clear" flow.
        mainRoleTypeId: nextPrimary,
      });

      // 2. Role diff — remove roles the multi-select deselected, add
      //    the new ones. The controller's addRole endpoint is
      //    idempotent (upsert on (bpId, roleTypeId)); order is fixed
      //    so we can await these serially without surprises.
      for (const row of toRemove) {
        await client
          .delete(`/business-partners/${bp.id}/roles/${row.roleType.id}`)
          .catch(() => { warnings.push(`role "${row.roleType.name}" (remove)`); });
      }
      for (const id of toAdd) {
        await client
          .post(`/business-partners/${bp.id}/roles`, { roleTypeId: id, isPrimary: id === nextPrimary })
          .catch(() => { warnings.push('role (add)'); });
      }

      // 3. For persons, sync the worker_of relationship to the chosen employer.
      // BM2 ops-surfaces Phase A: party↔party edges live on /partner-relationships now.
      if (bp.partnerType === 'person') {
        const newEmployerId = form.employerOrgId;
        const oldEmployerId = employerRel?.partyBId ?? null;
        const nextTitle = form.titleAtOrg.trim();
        // Title at {Org} — carried forward when the employer changes,
        // and (People UX U6 · P-09) PATCHed in-place when only the
        // title moved so we don't destroy the edge just to rewrite one
        // column.
        const oldTitle = employerRel?.titleAtB ?? '';
        // Old-title carry-over: if the user cleared the title while
        // swapping employers we still take the empty string; if they
        // didn't touch it, `nextTitle` already reflects the old value
        // (initialForm hydrated from employerRel.titleAtB).
        if (newEmployerId !== oldEmployerId) {
          // End the old worker_of (soft-delete) if it existed.
          if (employerRel) {
            await client
              .delete(`/partner-relationships/${employerRel.id}`)
              .catch(() => { warnings.push('previous employer link (remove)'); });
          }
          // Create the new one if employer is set.
          if (newEmployerId) {
            let workerOf: { id: number; code: string } | undefined;
            try {
              const relTypes = await client
                .get('/admin/partner-types/relationship-types')
                .then((r) => r.data?.data ?? r.data ?? []);
              workerOf = (Array.isArray(relTypes) ? relTypes : []).find(
                (rt: any) => rt.code === 'worker_of',
              );
            } catch {
              // Type catalog fetch failed — fall through to the warning.
            }
            if (workerOf) {
              await client
                .post('/partner-relationships', {
                  partyAId: bp.id,
                  partyBId: newEmployerId,
                  typeId: workerOf.id,
                  // People UX M2c / U6 P-09 — carry the (edited or
                  // preserved) Title at {Org} onto the fresh worker_of
                  // edge so the value survives an employer swap.
                  titleAtB: nextTitle || undefined,
                  isPrimary: true,
                })
                .catch(() => { warnings.push('new employer link (create)'); });
            } else {
              // No `worker_of` relationship-type row means the DB
              // isn't seeded — the employer pick can't be materialised.
              // Fail loudly (via warning) rather than silently drop it.
              warnings.push('new employer link (worker_of type missing)');
            }
          }
        } else if (employerRel && nextTitle !== oldTitle) {
          // Same employer, title changed — PATCH the existing edge
          // rather than delete+recreate (People UX U6 · P-09).
          await client
            .patch(`/partner-relationships/${employerRel.id}`, {
              titleAtB: nextTitle || null,
            })
            .catch(() => { warnings.push('Title at organization'); });
        }
      }

      return { warnings };
    },
    onSuccess: ({ warnings }) => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      if (warnings.length > 0) {
        // People UX U6 (P-09) — sticky warning naming the follow-up
        // calls that failed, matching create-partner-modal's copy so
        // the two surfaces read the same way.
        notify.warning(
          `Partner updated, but couldn't save: ${warnings.join(', ')}. Open the partner to finish setting it up.`,
          { code: 'BP-UPDATE-207' },
        );
      } else {
        notify.success('Updated', { code: 'BP-UPDATE-200' });
      }
      setEditing(false);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update'),
  });

  const remove = useMutation({
    mutationFn: () => client.delete(`/business-partners/${bp.id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      notify.success('Removed', { code: 'BP-DELETE-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove'),
  });

  // Read-only display "label + value" pair. Not a form control — the value
  // is rendered as static text — so a <span> heading is the correct
  // semantics (a <label> without htmlFor trips axe / screen readers try to
  // hunt for a control that isn't there).
  const Field = ({ label, value, render }: { label: string; value: string | null | undefined; render?: () => React.ReactNode }) => (
    <div>
      <span className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase block">{label}</span>
      <p className="mt-1 text-[13px] text-slate-700 dark:text-slate-200">{render ? render() : (value || <span className="italic text-slate-400 dark:text-slate-500">—</span>)}</p>
    </div>
  );

  if (!editing) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-end gap-2">
          {canWrite && (
            <button
              onClick={() => {
                // People UX U6 (P-07) — snapshot the form to the
                // current bp so the dirty-guard diff starts at zero
                // (any prior half-typed values from an earlier Cancel
                // don't leak forward as "unsaved changes").
                setForm(initialForm);
                setEditing(true);
              }}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[12px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1"
            >
              <Pencil className="h-3 w-3" /> Edit
            </button>
          )}
          {canDelete && !bp.user && (
            <button
              onClick={async () => {
                // People UX U2 — deleting a partner is permanent; name the
                // target and warn that relationships / project roles
                // pointing at it will fail if they still exist.
                const ok = await confirm(
                  `"${bp.displayName}" will be permanently removed. Any relationships or project roles that still reference this partner will be rejected by the backend.`,
                  {
                    title: `Remove "${bp.displayName}"?`,
                    variant: 'danger',
                    confirmLabel: 'Remove partner',
                  },
                );
                if (ok) remove.mutate();
              }}
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
              value={employerRel ? (employerOrg?.displayName ?? bp.companyName ?? `#${employerRel.partyBId}`) : null}
              render={() => employerRel
                ? <span className="text-slate-700 dark:text-slate-200">{employerOrg?.displayName ?? bp.companyName ?? `#${employerRel.partyBId}`}{employerRel.titleAtB ? <span className="text-slate-400 dark:text-slate-500"> · {employerRel.titleAtB}</span> : null}</span>
                : <span className="italic text-slate-400 dark:text-slate-500">—</span>
              }
            />
          )}
          {bp.partnerType === 'organization' && <Field label="Tax ID" value={bp.taxId} />}
          <Field label="Email" value={bp.email} />
          {/*
           * QA4 R2 IMP-9 — additional emails (generic office mailboxes
           * on orgs; secondary personal addresses on persons). Shown as
           * a compact stacked list under the primary; only rendered
           * when at least one additional row exists.
           */}
          {(() => {
            const additional = (bp.emails ?? []).filter(
              (e) => !e.isPrimary
                && e.email
                && e.email.toLowerCase() !== (bp.email ?? '').toLowerCase(),
            );
            if (additional.length === 0) return null;
            return (
              <Field
                label={`Additional emails · ${additional.length}`}
                value={additional.map((e) => e.email).join(' ')}
                render={() => (
                  <div className="flex flex-col gap-1">
                    {additional.map((e) => (
                      <a
                        key={e.id}
                        href={`mailto:${e.email}`}
                        className="text-blue-600 hover:underline text-[13px] break-all"
                      >
                        {e.email}
                      </a>
                    ))}
                  </div>
                )}
              />
            );
          })()}
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
            <span className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase block">Online presence</span>
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
            <span className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase block">Notes</span>
            <p className="mt-1 text-[13px] text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{bp.notes}</p>
          </div>
        )}

        {/* QA4 JT-3 (2026-09-29) — the old "Job Titles" section was
            split into two:
              • Position     — descriptive org title (CEO / VP / …),
                               single value, no gate.
              • Qualifications — functional capabilities (BIM Manager,
                               etc.); the gate stayed here.
            Both are person-only. For pure EXTERNAL contacts
            (`bp.user` is null → no login, so no employee/consultant
            relationship) we de-emphasize the Qualifications section
            since the eligibility gate rarely applies — mirrors TM-2's
            treatment of Discipline on Our-Team rows. Position stays. */}
        {bp.partnerType === 'person' && (
          <>
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
              <PositionSection bpId={bp.id} canWrite={canWrite} currentPosition={(bp as any).position ?? null} />
            </div>
            {bp.user ? (
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                <JobTitlesSection bpId={bp.id} canWrite={canWrite} />
              </div>
            ) : (
              <details className="pt-2 border-t border-slate-100 dark:border-slate-800 group">
                <summary className="cursor-pointer text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase list-none flex items-center gap-1 hover:text-slate-600 dark:hover:text-slate-300">
                  <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" aria-hidden="true" />
                  Qualifications
                  <span className="ml-1 text-[10px] font-normal text-slate-400 dark:text-slate-500 normal-case tracking-normal">
                    · rarely used for external contacts
                  </span>
                </summary>
                <div className="pt-2">
                  <JobTitlesSection bpId={bp.id} canWrite={canWrite} />
                </div>
              </details>
            )}
          </>
        )}

        {/* BM2 Phase D — Domains. Orgs only. Feeds the import dedup
            (`resolveOrgByDomainOrName` matches by owned domain first).
            Add + delete against /business-partners/:id/domains. */}
        {bp.partnerType === 'organization' && (
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
            <DomainsSection bpId={bp.id} canWrite={canWrite} canDelete={canDelete} />
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

  // Editing mode — People UX M5 (P-30) — every editable field uses the
  // shared TextField/SelectField/TextAreaField wrapper so the label
  // wires to the control via htmlFor/id, and any future validation
  // error text can drop in behind aria-describedby / aria-invalid.
  return (
    <div className="space-y-3">
      {bp.partnerType === 'person' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="First Name"
              name="drawer-firstName"
              value={form.firstName}
              onChange={(e) => setForm(f => ({ ...f, firstName: e.target.value }))}
            />
            <TextField
              label="Last Name"
              name="drawer-lastName"
              value={form.lastName}
              onChange={(e) => setForm(f => ({ ...f, lastName: e.target.value }))}
            />
          </div>
          {/* People UX M2c (P-11 / P-37) — Hebrew names live on the
              CreatePartnerModal but never showed up in the drawer edit
              path before. Adding them here so the drawer edits the
              same set of person fields as the create form; the M2c DoD
              is "what the create form captures can be seen and edited
              in the drawer." */}
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="שם פרטי (Hebrew first name)"
              name="drawer-firstNameHe"
              dir="rtl"
              value={form.firstNameHe}
              onChange={(e) => setForm(f => ({ ...f, firstNameHe: e.target.value }))}
            />
            <TextField
              label="שם משפחה (Hebrew last name)"
              name="drawer-lastNameHe"
              dir="rtl"
              value={form.lastNameHe}
              onChange={(e) => setForm(f => ({ ...f, lastNameHe: e.target.value }))}
            />
          </div>
          {/* People UX M2c — Discipline picker. Informational only (no
              eligibility gate); same catalog the create modal reads. */}
          <SelectField
            label="Discipline"
            name="drawer-discipline"
            value={form.disciplineId}
            onChange={(e) => setForm(f => ({ ...f, disciplineId: e.target.value }))}
            hint="Informational classification (Architecture / MEP / Structural / …). Doesn't affect assignments."
          >
            <option value="">— None / set later —</option>
            {disciplines
              .filter((d) => d.isActive || String(d.id) === form.disciplineId)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.nameHe ? ` · ${d.nameHe}` : ''}
                </option>
              ))}
          </SelectField>
          {/* People UX M2c — Role(s) multi-select with a primary
              marker. Same model as the create modal: an ordered array
              where the first entry is the primary. Save writes
              `mainRoleTypeId` and diffs the roles list via
              /business-partners/:id/roles. */}
          <RolesMultiSelectField
            value={form.roleTypeIds}
            onChange={(next) => setForm((f) => ({ ...f, roleTypeIds: next }))}
            options={applicableRoleTypes}
          />
        </>
      )}
      {bp.partnerType === 'organization' ? (
        <>
          <TextField
            label="Organization Name"
            name="drawer-companyName"
            value={form.companyName}
            onChange={(e) => setForm(f => ({ ...f, companyName: e.target.value }))}
          />
          <TextField
            label="Tax ID"
            name="drawer-taxId"
            value={form.taxId}
            onChange={(e) => setForm(f => ({ ...f, taxId: e.target.value }))}
          />
          {/* People UX M2c — org gets the same Role(s) editor. */}
          <RolesMultiSelectField
            value={form.roleTypeIds}
            onChange={(next) => setForm((f) => ({ ...f, roleTypeIds: next }))}
            options={applicableRoleTypes}
          />
        </>
      ) : (
        <>
          <SelectField
            label="Employer (organization)"
            name="drawer-employer"
            value={form.employerOrgId ?? ''}
            onChange={(e) => setForm(f => ({ ...f, employerOrgId: e.target.value ? Number(e.target.value) : null }))}
            hint="Saving will link this contact to the selected organization."
          >
            <option value="">— No employer —</option>
            {employerOrg && !orgs.some((o) => o.id === employerOrg.id) && (
              <option value={employerOrg.id}>{employerOrg.displayName}</option>
            )}
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>{o.displayName}</option>
            ))}
          </SelectField>
          {/* People UX M2c (P-11) — Title at {Org}. Backed by the
              `titleAtB` on the active worker_of edge; edits round-trip
              via PATCH /partner-relationships/:id or land on the new
              edge when the employer changes. Only visible when an
              employer is set — otherwise there's no edge to attach
              the title to. */}
          {form.employerOrgId && (
            <TextField
              label={`Title at ${employerOrg?.displayName ?? 'organization'}`}
              name="drawer-titleAtOrg"
              value={form.titleAtOrg}
              onChange={(e) => setForm(f => ({ ...f, titleAtOrg: e.target.value }))}
              placeholder='e.g. "Operations Manager", "Buyer"'
              hint="Optional. Free-text title within the employer organization."
            />
          )}
          {/* People UX M2c — Job Title (Profession) as a searchable
              combobox. Replaces the always-visible chip list in
              non-edit mode so admins can find a title in a long
              catalog by typing. "Saved" pill flashes after each save.
              The picker sets the PRIMARY profession — bulk chip
              management stays in the read view. */}
          <JobTitleCombobox bpId={bp.id} />
        </>
      )}
      <TextField
        label="Email"
        name="drawer-email"
        type="email"
        value={form.email}
        onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))}
      />
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Phone"
          name="drawer-phone"
          value={form.phone}
          onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))}
        />
        <TextField
          label="Mobile"
          name="drawer-mobile"
          value={form.mobile}
          onChange={(e) => setForm(f => ({ ...f, mobile: e.target.value }))}
        />
      </div>
      <TextField
        label="Website"
        name="drawer-website"
        value={form.website}
        onChange={(e) => setForm(f => ({ ...f, website: e.target.value }))}
        placeholder="https://..."
      />
      <div className="grid grid-cols-2 gap-3">
        <SocialEditField icon={<Linkedin className="h-3.5 w-3.5 text-[#0a66c2]" />} label="LinkedIn"   value={form.linkedinUrl}  onChange={(v) => setForm(f => ({ ...f, linkedinUrl: v }))}  />
        <SocialEditField icon={<Facebook className="h-3.5 w-3.5 text-[#1877f2]" />} label="Facebook"   value={form.facebookUrl}  onChange={(v) => setForm(f => ({ ...f, facebookUrl: v }))}  />
        <SocialEditField icon={<Twitter  className="h-3.5 w-3.5 text-[#1da1f2]" />} label="Twitter / X" value={form.twitterUrl}   onChange={(v) => setForm(f => ({ ...f, twitterUrl: v }))}   />
        <SocialEditField icon={<Instagram className="h-3.5 w-3.5 text-[#e4405f]" />} label="Instagram"  value={form.instagramUrl} onChange={(v) => setForm(f => ({ ...f, instagramUrl: v }))} />
      </div>
      <TextField
        label="Address"
        name="drawer-address"
        value={form.address}
        onChange={(e) => setForm(f => ({ ...f, address: e.target.value }))}
      />
      <SelectField
        label="Status"
        name="drawer-status"
        value={form.status}
        onChange={(e) => setForm(f => ({ ...f, status: e.target.value }))}
      >
        <option value="active">Active</option>
        <option value="inactive">Inactive</option>
      </SelectField>
      <TextAreaField
        label="Notes"
        name="drawer-notes"
        value={form.notes}
        onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
        rows={3}
        textareaClassName="resize-none"
      />

      <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
        <button
          type="button"
          onClick={() => {
            // People UX U6 (P-07) — drop half-typed changes when the
            // operator explicitly cancels. The dirty-guard on the
            // Sheet backdrop / Escape already prompts before losing
            // work; here the user has said they want to discard.
            setForm(initialForm);
            setEditing(false);
          }}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[12px] font-semibold px-3 py-1.5 rounded-lg"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => update.mutate()}
          disabled={update.isPending}
          className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50 flex items-center gap-1"
          aria-label={`Save changes to ${bp.displayName ?? (bp.partnerType === 'person' ? 'contact' : 'organization')}`}
        >
          <Save className="h-3 w-3" aria-hidden="true" /> {update.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ─── Role(s) multi-select (People UX M2c) ───────────────────────────────────
//
// Chip-toggle picker for `partner_role_types`. Ordered — the first pick is
// the primary and gets a small "Primary" badge. Mirrors the create modal's
// RoleMultiSelect visually + behaviourally, but wired into the shared
// Field wrapper (label + a11y). Save-side diffing lives on the drawer's
// update mutation.
function RolesMultiSelectField({
  value,
  onChange,
  options,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  options: Array<{ id: number; code: string; name: string; appliesToKind?: string }>;
}) {
  const toggle = (id: number) => {
    const asStr = String(id);
    if (value.includes(asStr)) {
      onChange(value.filter((v) => v !== asStr));
    } else {
      onChange([...value, asStr]);
    }
  };

  return (
    <Field
      label="Role(s)"
      hint="Pick one or more categorizations (Customer, Supplier, Consultant…). The first pick is the primary."
    >
      {({ ariaInvalid }) => (
        <div
          role="group"
          aria-label="Role(s)"
          aria-invalid={ariaInvalid || undefined}
          className={cn(
            'w-full rounded-lg border bg-white dark:bg-slate-900 p-2 flex flex-wrap gap-1.5',
            'border-slate-200 dark:border-slate-700',
          )}
        >
          {options.length === 0 ? (
            <span className="text-[12px] italic text-slate-400 dark:text-slate-500 px-1 py-0.5">
              No role types configured — add some under Admin → Contact & Organization Types first.
            </span>
          ) : (
            options.map((rt) => {
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
            })
          )}
        </div>
      )}
    </Field>
  );
}

// ─── Job Title combobox (People UX M2c) ─────────────────────────────────────
//
// Searchable single-select for the person's PRIMARY profession, with a
// "Saved" pill that flashes for ~2s after each save so the admin sees the
// write land. The old chip list stays in read-only mode below (for bulk
// add/remove); this combobox is the "one editor" the drawer surfaces on
// the edit form itself. When the primary changes we PUT the full
// profession list back so the server keeps its diff shape.
function JobTitleCombobox({ bpId }: { bpId: number }) {
  const queryClient = useQueryClient();
  const { data: current = [] } = useQuery<Array<{ professionId: number; isPrimary: boolean; profession: { id: number; name: string } }>>({
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

  const primary = current.find((c) => c.isPrimary) ?? current[0] ?? null;
  const primaryName = primary?.profession.name ?? '';

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Saved-badge visibility. Timer is cleared on unmount so a fast tab-out
  // doesn't leave a stale timeout.
  const [savedFlash, setSavedFlash] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  const save = useMutation({
    mutationFn: (nextPrimaryId: number | null) => {
      // Keep every profession the person currently holds; just move the
      // primary flag to the new pick (or add it to the list when the
      // person didn't have it yet).
      const ids = new Set(current.map((c) => c.professionId));
      if (nextPrimaryId != null) ids.add(nextPrimaryId);
      return client
        .put(`/business-partners/${bpId}/professions`, {
          professionIds: Array.from(ids),
          primaryProfessionId: nextPrimaryId,
        })
        .then((r) => r.data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bp-professions', bpId] });
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      setSavedFlash(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedFlash(false), 2000);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update job title'),
  });

  const q = query.trim().toLowerCase();
  const filtered = q
    ? catalog.filter((p) => p.name.toLowerCase().includes(q))
    : catalog;

  const pick = (id: number | null) => {
    setOpen(false);
    setQuery('');
    save.mutate(id);
  };

  return (
    <Field
      // JT-3b-4 (QA4 · 2026-09-29): relabelled after the JT-1 split.
      // The write still lives on `business_partner_professions`
      // (Qualifications catalog); the label reflects the concept.
      label="Qualification"
      hint="Determines which project roles this person can be assigned to. Searchable — type to filter."
      labelSuffix={
        savedFlash ? (
          <span
            role="status"
            className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300"
          >
            <Check className="h-3 w-3" aria-hidden="true" /> Saved
          </span>
        ) : null
      }
    >
      {({ id }) => (
        <div className="relative">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-300 dark:text-slate-600" aria-hidden="true" />
            <input
              id={id}
              type="text"
              value={open ? query : primaryName}
              placeholder={primaryName ? 'Change job title…' : 'Search job titles…'}
              onFocus={() => { setOpen(true); setQuery(''); }}
              onChange={(e) => { setOpen(true); setQuery(e.target.value); }}
              onBlur={() => {
                // Give a click on the option list time to register
                // before we collapse the menu.
                setTimeout(() => setOpen(false), 150);
              }}
              className={cn(
                'w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900',
                'pl-8 pr-3 py-2 text-sm text-slate-900 dark:text-slate-100',
                'placeholder:text-slate-400 dark:placeholder:text-slate-500',
                'focus:outline-none focus:border-blue-500 dark:focus:border-blue-400',
              )}
              autoComplete="off"
            />
          </div>
          {open && (
            <div className="absolute z-10 mt-1 w-full max-h-56 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg">
              {primary && (
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); pick(null); }}
                  className="w-full text-left px-3 py-2 text-[12px] text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 border-b border-slate-100 dark:border-slate-800"
                >
                  Clear current — {primary.profession.name}
                </button>
              )}
              {filtered.length === 0 ? (
                <div className="px-3 py-2 text-[12px] italic text-slate-400 dark:text-slate-500">
                  {catalog.length === 0
                    ? 'No job titles defined yet — add some under /templates/types → Job Titles.'
                    : 'No matches.'}
                </div>
              ) : (
                filtered.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); pick(p.id); }}
                    aria-selected={p.id === primary?.professionId}
                    className={cn(
                      'w-full text-left px-3 py-2 text-[13px] hover:bg-slate-50 dark:hover:bg-slate-800/60',
                      p.id === primary?.professionId
                        ? 'text-blue-700 dark:text-blue-300 font-semibold'
                        : 'text-slate-700 dark:text-slate-200',
                    )}
                  >
                    {p.name}
                    {p.id === primary?.professionId && (
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-blue-500">Current</span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </Field>
  );
}

// ─── Position (QA4 JT-3) ─────────────────────────────────────────────────────
//
// The descriptive org-title half of the JT-1 split — separated from
// the Qualifications gate so a "CEO" tag no longer accidentally
// qualifies someone for a project role that gates on CEO. Single
// value per person; catalog read-only for now (JT-4's admin backfill
// seeds the initial rows from the existing profession names — CEO /
// VP / HR manager / Finance — and full CRUD lands with the Admin
// > Positions page as a follow-up).

interface PositionCatalogRow { id: number; code: string; name: string; nameHe: string | null }

function PositionSection({
  bpId,
  canWrite,
  currentPosition,
}: {
  bpId: number;
  canWrite: boolean;
  currentPosition: { id: number; name: string; nameHe: string | null } | null;
}) {
  const queryClient = useQueryClient();
  const { data: catalog = [] } = useQuery<PositionCatalogRow[]>({
    queryKey: ['admin', 'config', 'positions'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/config/positions').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const save = useMutation({
    mutationFn: (positionId: number | null) =>
      client
        .patch(`/business-partners/${bpId}`, { positionId })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-partner', bpId] });
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update position'),
  });

  const currentId = currentPosition?.id ?? '';
  return (
    <div>
      <p
        className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1"
        title="Descriptive organizational position; does not affect project-role eligibility."
      >
        Position
      </p>
      <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-2">
        The person's role at their organization (e.g. CEO). Not a gate.
      </p>
      {canWrite ? (
        <select
          value={currentId}
          disabled={save.isPending}
          onChange={(e) => {
            const v = e.target.value;
            save.mutate(v === '' ? null : Number(v));
          }}
          className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-[12px] text-slate-700 dark:text-slate-200 focus:outline-none focus-visible:border-blue-500 disabled:opacity-50"
          aria-label="Position"
        >
          <option value="">— None —</option>
          {catalog.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}{p.nameHe ? ` · ${p.nameHe}` : ''}
            </option>
          ))}
        </select>
      ) : currentPosition ? (
        <p className="text-[12px] text-slate-700 dark:text-slate-200">{currentPosition.name}</p>
      ) : (
        <p className="text-[12px] text-slate-400 dark:text-slate-500 italic">No position set.</p>
      )}
      {catalog.length === 0 && canWrite && (
        <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-500 italic">
          No positions defined yet — run the JT-4 backfill or add rows via Admin › Positions.
        </p>
      )}
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
      <p
        className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1"
        title="Determines which project roles this person can be assigned to."
      >
        {/* QA4 JT-3 (2026-09-29): renamed "Job titles" → "Qualifications"
            after the JT-1 split — the descriptive org-title concept
            (CEO / VP / …) moved out into the separate Position field;
            what remains here is the eligibility-gate axis. */}
        Qualifications
      </p>
      <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-2">
        Determines which project roles this person can be assigned to.
      </p>
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

// ─── Domains (BM2 Phase D) ──────────────────────────────────────────────────
//
// An organization BP can own multiple email domains. The import
// dedup matches company-by-domain first (see resolveOrgByDomainOrName)
// so keeping this list accurate directly improves import quality.
//
// Line editor — no modal. Type a domain, hit Add.
//
// BM2 QA-2 Commit 12 (2026-08-30) — personal / free-email domains
// (gmail.com, yahoo.co.il, walla.co.il, …) are allowed on an org row
// but marked "personal". Server enforces:
//   • corporate domains — one org globally (unchanged); duplicate
//     attempts surface as a toast that names the current owner.
//   • personal domains — any org may add; they NEVER drive email→org
//     auto-matching, so the row is informational only.

interface BpDomain { id: number; partnerId: number; domain: string; isPersonal?: boolean }

function DomainsSection({ bpId, canWrite, canDelete }: { bpId: number; canWrite: boolean; canDelete: boolean }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [input, setInput] = useState('');

  const { data: domains = [], isLoading } = useQuery<BpDomain[]>({
    queryKey: ['bp-domains', bpId],
    queryFn: () =>
      client.get(`/business-partners/${bpId}/domains`).then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const add = useMutation({
    mutationFn: (domain: string) =>
      client.post(`/business-partners/${bpId}/domains`, { domain }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bp-domains', bpId] });
      // Invalidate the BP list too — future import dedup calls may key
      // off the changed domain list.
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      setInput('');
      notify.success('Domain added', { code: 'BP-DOMAIN-ADD-200' });
    },
    onError: (err: unknown) => notify.apiError(err, 'Failed to add domain'),
  });

  const remove = useMutation({
    mutationFn: (domainId: number) =>
      client.delete(`/business-partners/${bpId}/domains/${domainId}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bp-domains', bpId] });
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      notify.success('Domain removed', { code: 'BP-DOMAIN-DEL-200' });
    },
    onError: (err: unknown) => notify.apiError(err, 'Failed to remove domain'),
  });

  const submitAdd = () => {
    const v = input.trim().toLowerCase();
    if (!v) return;
    add.mutate(v);
  };

  return (
    <div>
      <p className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-2">Email domains</p>
      <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-2">
        Import dedup matches this org by its owned domains. A corporate domain can be owned by only
        one org; personal / free-email domains (gmail, yahoo, walla, …) may be listed on any org and
        never drive auto-matching.
      </p>
      {isLoading ? (
        <p className="text-[11px] text-slate-400 dark:text-slate-500">Loading…</p>
      ) : domains.length === 0 ? (
        <p className="text-[12px] text-slate-400 dark:text-slate-500 italic mb-2">No domains yet.</p>
      ) : (
        <div className="space-y-1.5 mb-2">
          {domains.map((d) => (
            <div key={d.id} className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 px-3 py-2">
              <span className="text-[13px] font-mono text-slate-800 dark:text-slate-100 flex-1 truncate">{d.domain}</span>
              {d.isPersonal && (
                <span
                  className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                  title="Personal / free-email domain — non-exclusive; never drives email→org auto-matching."
                >
                  Personal
                </span>
              )}
              {canDelete && (
                <button
                  onClick={async () => {
                    // People UX U2 — detaching a corporate domain breaks
                    // future email→org auto-matching in the import flow.
                    const ok = await confirm(
                      `Import dedup will stop matching addresses at "${d.domain}" to this organization.`,
                      {
                        title: `Detach domain "${d.domain}"?`,
                        variant: 'danger',
                        confirmLabel: 'Detach',
                      },
                    );
                    if (ok) remove.mutate(d.id);
                  }}
                  disabled={remove.isPending}
                  className="p-1 rounded hover:bg-red-50 text-slate-400 dark:text-slate-500 hover:text-red-600"
                  title="Remove domain"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canWrite && (
        <form
          onSubmit={(e) => { e.preventDefault(); submitAdd(); }}
          className="flex items-center gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="example.com"
            className={cn(inputClass, 'flex-1 font-mono text-[13px]')}
            spellCheck={false}
            autoComplete="off"
            disabled={add.isPending}
          />
          <button
            type="submit"
            disabled={add.isPending || !input.trim()}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-2 flex items-center gap-1 disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
            {add.isPending ? 'Adding…' : 'Add'}
          </button>
        </form>
      )}
    </div>
  );
}

// ─── Relationships ───────────────────────────────────────────────────────────

function RelationshipsTab({ bp, canWrite, canDelete }: { bp: BusinessPartnerFull; canWrite: boolean; canDelete: boolean }) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);

  // BM2 ops-surfaces Phase A: merge the two new-shape arrays into the
  // Relationship[] the renderer already knows how to group.
  const outgoing = useMemo(() => mergeOutgoing(bp), [bp]);
  const grouped = outgoing.reduce<Record<string, Relationship[]>>((acc, r) => {
    (acc[r.targetType] ||= []).push(r);
    return acc;
  }, {});

  // Per-row delete routes by sourceTable (party↔party vs project participation).
  const remove = useMutation({
    mutationFn: (row: { id: number; sourceTable: Relationship['sourceTable'] }) => {
      const path = row.sourceTable === 'project_partner_role'
        ? `/project-partner-roles/${row.id}`
        : `/partner-relationships/${row.id}`;
      return client.delete(path).then((r) => r.data);
    },
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
                  onClick={async () => {
                    // People UX U2 — name both parties of the relationship
                    // so the operator sees the exact edge being cut.
                    const target = r.targetName ?? `${r.targetType} #${r.targetId}`;
                    const ok = await confirm(
                      `The "${r.relationshipType.name}" link from ${bp.displayName} to ${target} will end.`,
                      {
                        title: `Remove relationship to ${target}?`,
                        variant: 'danger',
                        confirmLabel: 'Remove',
                      },
                    );
                    if (ok) remove.mutate({ id: r.id, sourceTable: r.sourceTable });
                  }}
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

  // BM2 ops-surfaces Phase A: incoming rows are always party↔party
  // (a project would appear as a *project participation* on the party's
  // side, not as an incoming edge here), so route to /partner-relationships.
  const removeIncoming = useMutation({
    mutationFn: (id: number) => client.delete(`/partner-relationships/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      notify.success('Relationship removed', { code: 'BP-REL-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove'),
  });

  return (
    <div className="space-y-4">
      {outgoing.length === 0 && incoming.length === 0 && (
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
            Pointing at this record ({incoming.length})
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
                    onClick={async () => {
                      // People UX U2 — incoming edges: name the source side.
                      const label = r.relationshipType.inverseLabel || r.relationshipType.name;
                      const ok = await confirm(
                        `The "${label}" link from ${r.sourceName} to ${bp.displayName} will end.`,
                        {
                          title: `Remove relationship from ${r.sourceName}?`,
                          variant: 'danger',
                          confirmLabel: 'Remove',
                        },
                      );
                      if (ok) removeIncoming.mutate(r.id);
                    }}
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

  const { data: allRelTypes = [] } = useQuery<RelationshipType[]>({
    queryKey: ['partner-relationship-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/partner-types/relationship-types').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  // D4-2 (2026-09-28) — the employer edge (`worker_of`) is edited under
  // the Details tab as "Employer" (M2c). Hiding it here keeps a single
  // path for changing it, so operators don't accidentally create a
  // second active employer edge via Relationships while the Details
  // tab shows a stale employer name.
  const HIDDEN_TYPE_CODES = new Set(['worker_of']);
  const visibleRelTypes = allRelTypes.filter((t) => !HIDDEN_TYPE_CODES.has(t.code));

  // Annotate each type with which side(s) accept this partner, and keep
  // only those where at least one side fits. For types where only Side B
  // fits, the modal will save the row in reverse (other party as source,
  // this partner as target).
  const annotatedRelTypes = visibleRelTypes
    .map((t) => ({ type: t, side: sideFor(t) }))
    .filter((x): x is { type: RelationshipType; side: 'A' | 'B' | 'both' } => x.side != null);
  const hiddenTypeCount = visibleRelTypes.length - annotatedRelTypes.length;

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

  // BM2 ops-surfaces Phase A: this modal used to always POST to the
  // legacy /business-partner-relationships facade; now it routes:
  //   • chosenKind === 'project' → POST /project-partner-roles (participation)
  //   • otherwise (person/organization) → POST /partner-relationships (party↔party)
  // Note: the candidates endpoint filters out project-typed relationship
  // types where the type still lists 'project' among its side targets,
  // but the routing here is defensive in case a legacy config remains.
  const create = useMutation({
    mutationFn: async () => {
      if (!chosenKind || !targetId) {
        throw new Error('Pick a target before saving');
      }
      if (chosenKind === 'project') {
        // Project participation lives on ProjectRoleType, not on
        // PartnerRelationshipType. Map the legacy rel-type code to the
        // project-role code and look it up.
        const relTypes: Array<{ id: number; code: string }> = await client.get('/admin/partner-types/relationship-types')
          .then((r) => r.data?.data ?? r.data ?? []);
        const legacyType = (Array.isArray(relTypes) ? relTypes : []).find(
          (rt) => rt.id === relationshipTypeId,
        );
        const projectRoleCode =
          legacyType?.code === 'customer_of_project' ? 'customer'
          : legacyType?.code === 'supplier_of_project' ? 'supplier'
          : legacyType?.code === 'participates_in_project' ? 'participant'
          : null;
        if (!projectRoleCode) {
          throw new Error(
            `Cannot map relationship type '${legacyType?.code}' to a project role.`,
          );
        }
        const roleTypes: Array<{ id: number; code: string }> = await client.get('/admin/project-role-types')
          .then((r) => r.data?.data ?? r.data ?? []);
        const role = (Array.isArray(roleTypes) ? roleTypes : []).find(
          (rt) => rt.code === projectRoleCode,
        );
        if (!role) {
          throw new Error(`project role type '${projectRoleCode}' missing`);
        }
        return client.post('/project-partner-roles', {
          projectId: targetId,
          partyId: partnerId,
          roleId: role.id,
          titleInProject: roleInContext.trim() || undefined,
          isPrimary,
        }).then((r) => r.data);
      }
      // party↔party (organization or person target)
      const body =
        forSide === 'A'
          ? {
              partyAId: partnerId,
              partyBId: targetId,
              typeId: relationshipTypeId,
              titleAtB: roleInContext.trim() || undefined,
              isPrimary,
            }
          : {
              // Side B: the picked candidate is party A, current partner is party B.
              partyAId: targetId,
              partyBId: partnerId,
              typeId: relationshipTypeId,
              titleAtB: roleInContext.trim() || undefined,
              isPrimary,
            };
      return client.post('/partner-relationships', body).then((r) => r.data);
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

  const isDirty = relationshipTypeId != null || targetId != null || roleInContext.trim().length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title="Add Relationship"
      widthClass="w-[480px] max-w-[92vw]"
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
            type="submit"
            form="add-relationship-form"
            disabled={create.isPending || !selectedType || !targetId}
            className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            {create.isPending ? 'Adding...' : 'Add'}
          </button>
        </>
      }
    >
      <form id="add-relationship-form" onSubmit={handleSubmit} className="space-y-3">
          {/* D4-2 (2026-09-28) — the form fields now use the shared
              a11y-wired <Field> wrapper from components/shared/field so
              label, aria-describedby, and aria-invalid are handled the
              same way as the rest of the drawer. */}
          <Field
            label="Relationship type"
            hint={
              hiddenTypeCount > 0
                ? `${hiddenTypeCount} type${hiddenTypeCount > 1 ? 's' : ''} hidden — neither side accepts this record (${partnerKind}${partnerRoleCodes.length > 0 ? ` with roles: ${partnerRoleCodes.join(', ')}` : ''}).`
                : undefined
            }
          >
            {({ id }) => (
              <select
                id={id}
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
            )}
          </Field>
          {annotatedRelTypes.length === 0 && (
            <p className="text-[12px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 px-2 py-1.5 rounded">
              No relationship types accept this record on either side. Configure a type whose first or second party matches this record's kind or roles.
            </p>
          )}

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
                optionsForChosenKind.length > 0 ? (
                  <Field
                    label={
                      chosenKind === 'project'
                        ? 'Project'
                        : chosenKind === 'organization'
                          ? (selectedType?.sideBLabel && forSide === 'A' ? selectedType.sideBLabel : 'Organization')
                          : 'Person'
                    }
                  >
                    {({ id }) => (
                      <select
                        id={id}
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
                    )}
                  </Field>
                ) : (
                  <p className="text-[12px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 px-2 py-1.5 rounded">
                    No eligible {chosenKind}s — they may already be related to this partner under this type, or none match the type's role constraints.
                  </p>
                )
              )}

              {exhausted && (
                <p className="text-[12px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 px-2 py-1.5 rounded">
                  No eligible parties for this relationship type. Either all candidates are already related, or the type has constraints that no parties match.
                </p>
              )}

              <Field label={`Title at ${otherSideLabel.toLowerCase()} (optional)`}>
                {({ id }) => (
                  <input
                    id={id}
                    value={roleInContext}
                    onChange={(e) => setRoleInContext(e.target.value)}
                    placeholder='e.g. "Operations Manager"'
                    className={inputClass}
                  />
                )}
              </Field>

              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 pt-1">
                <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600" />
                Mark as primary
              </label>
            </>
          )}

      </form>
    </Modal>
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
