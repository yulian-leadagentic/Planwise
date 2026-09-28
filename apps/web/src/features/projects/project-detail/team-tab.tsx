/**
 * Team tab — Phase 5 rebuild (Wave 3, 2026-09-28).
 *
 * Replaces the old Cards/Sections + flat-table layout with a single
 * dense, organized table designed to scale to 60+ people:
 *
 *   1. Population segmented control ("Our Team | Stakeholders | All",
 *      slate track / white selected — deliberately NOT blue).
 *   2. Coverage strip — required project-role types shown as filled
 *      chips (green ✓) or empty amber "⚠ Role +" affordances that
 *      launch role-first Add for that specific role.
 *   3. Toolbar — search · Filters popover (Role / Discipline / Labor
 *      Category / Status; active filters render as chips with a live
 *      "N of M" count) · Group dropdown (Discipline / Project Role /
 *      Flat) · Table/Cards toggle · primary + Add person.
 *   4. Table — collapsible group headers with sticky <thead> AND
 *      sticky group headers on scroll; sortable columns.
 *   5. Add flow is ROLE-FIRST — pick a Project Role, then the eligible
 *      party picker (RoleAssignmentPicker / AddMemberDialog for the
 *      participant role); ineligible rows disabled with a reason.
 *
 * Data comes from GET /projects/:id/team — the `discipline` field on
 * every person shape was added in the matching backend commit.
 *
 * No cost / allocation column anywhere on this screen (belongs on a
 * separate Workload view). "Team member" replaces "Participant" per
 * the D9 glossary; "Labor Category" replaces "Seniority". Blue is
 * reserved for the primary CTA, active tab, and links; everything
 * else uses muted slate.
 */
import {
  UserPlus,
  Filter as FilterIcon,
  Search as SearchIcon,
  ChevronDown,
  ChevronRight,
  X,
  ExternalLink,
  Check,
  AlertTriangle,
  Users as UsersIcon,
  Building2,
  Upload as UploadIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Sentry from '@sentry/react';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';
import { useRemoveProjectMember } from '@/hooks/use-projects';
import { PartnerDrawer } from '@/features/partners/partner-drawer';
import { MultiSelectFilter } from '@/components/shared/multi-select-filter';
import { EmptyState } from '@/components/shared/empty-state';
import { Modal } from '@/components/shared/modal';
import { ContactsImportWizard } from '@/features/data-import/contacts/contacts-import-wizard';
import { RoleAssignmentPicker } from './role-assignment-picker';
import { CustomerContactPicker } from './customer-contact-picker';
import { AddMemberDialog } from './add-member-dialog';
import { getInitials } from './utils';
import type {
  CustomerRelatedRow,
  ProjectMember,
  ProjectRoleAssignment,
  ProjectRoleTypeRow,
  ProjectTeamData,
  ProjectTeamPerson,
} from './types';

/* ─── Types ─────────────────────────────────────────────────────────── */

type Population = 'team' | 'stake' | 'all';
type GroupBy = 'discipline' | 'role' | 'flat';
type ViewMode = 'table' | 'cards';
type StatusFilter = 'active' | 'inactive' | 'all';
type SortKey = 'name' | 'role' | 'discipline' | 'email' | 'phone' | 'type';
type SortDir = 'asc' | 'desc';
// 'related' — D4-4 read-only stakeholder derived from a
// party-to-customer edge (Consultant / Supplier / PM). Rows of this type
// are visually distinguished by a `contextBadge` next to the name, hold
// no ProjectPartnerRole, and never expose the row `✕` action.
type RowType = 'employee' | 'contact' | 'org' | 'related';

/**
 * Unified row shape used across all three populations. Every table row
 * (Our Team / Stakeholders / All) reduces to one of these before render
 * so grouping, sorting, filtering and remove semantics have a single
 * source of truth.
 */
interface TeamRow {
  rowKey: string;                         // stable list key
  bpId: number;                           // BusinessPartner id (for the drawer)
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  discipline: string | null;              // for group / filter
  disciplineId: number | null;
  seniorityName: string | null;           // Labor Category (internal only)
  seniorityId: number | null;
  roleNames: string[];                    // project roles this row holds
  roleIds: number[];
  roleNamesLabel: string;                 // joined for the Role cell
  rowType: RowType;                       // Employee | Contact | Org
  isTeamLeader: boolean;                  // for the indigo avatar accent
  orgName: string | null;                 // for stakeholders grouping ("Represents"/org header)
  orgId: number | null;
  // D4-4 — short read-only badge for parties standing-related to the
  // customer via consultant_of / supplier_of / pm_supervision_for.
  // Non-null identifies a "context" row: no ✕, excluded from Project
  // Role filter (they have no roleIds), rendered under the customer
  // org group in Stakeholders. The base rowType stays 'related'; the
  // party's underlying kind is preserved in `partyKind` for the badge.
  contextBadge: string | null;
  contextTitle: string | null;            // titleAtCustomer (fuller label)
  partyKind: 'organization' | 'person' | null;
  // Remove behaviour is context-specific — the caller supplies a
  // closure so the table doesn't need to know about mutations.
  onRemove: (() => void) | null;
  // Optional profile-drawer target when different from bpId (unused
  // today — kept as an escape hatch for org headers that link back to
  // the org profile rather than the contact person).
}

/* ─── Small style helpers ──────────────────────────────────────────── */

const CELL = 'px-3 py-2 text-[13px] text-slate-700 dark:text-slate-200 align-middle';
const H_CELL = 'px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400';

const seg = (on: boolean) =>
  cn(
    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-semibold transition-colors',
    on
      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
      : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100',
  );

/* ─── Team Tab ─────────────────────────────────────────────────────── */

export function TeamTab({
  projectId,
  members,
  showAddMember,
  onToggleAddMember,
}: {
  projectId: number;
  members: ProjectMember[];
  showAddMember: boolean;
  onToggleAddMember: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const removeMember = useRemoveProjectMember();
  const confirm = useConfirm();
  const { isAdmin, can: canPerm } = usePermissions();
  const canWritePartners = isAdmin || canPerm('partners', 'write');
  // QA4 D9 (2026-09-28) — separate gate from `partners:write`: importing
  // stakeholders in bulk is a distinct authority even for a PM who can
  // add people one at a time. Mirrors the wizard's own permission check
  // on /admin/data-import.
  const canImportContacts = isAdmin || canPerm('data-import/contacts', 'write');

  // ─── Data ──────────────────────────────────────────────────────────
  const {
    data: team,
    isLoading,
    isError,
    refetch: refetchTeam,
  } = useQuery<ProjectTeamData>({
    queryKey: ['project-team', projectId],
    queryFn: () => client.get(`/projects/${projectId}/team`).then((r) => r.data?.data ?? r.data),
  });

  const { data: roleCatalog = [] } = useQuery<ProjectRoleTypeRow[]>({
    queryKey: ['project-role-types'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/project-role-types').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  // QA4 D7 (2026-09-28) — discipline catalog for the inline Discipline
  // cell. Long staleTime because the list changes rarely and the same
  // key is used by the partner drawer / create-partner modal, so we hit
  // warm cache most of the time.
  const { data: disciplineCatalog = [] } = useQuery<Array<{ id: number; name: string; nameHe: string | null; isActive: boolean }>>({
    queryKey: ['admin', 'disciplines', 'picker'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/config/disciplines').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const customerContactRoleType = roleCatalog.find((rt) => rt.code === 'customer_contact') ?? null;

  // Roles that appear in the "+ Add" role-first picker — excludes the
  // system-locked ones (customer / participant / customer_contact) so
  // the operator can't create nonsense duplicates through this flow.
  const addableRoles = useMemo(
    () =>
      roleCatalog
        .filter((rt) => rt.code !== 'customer' && rt.code !== 'participant' && rt.code !== 'customer_contact')
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [roleCatalog],
  );

  // Required (isPrimaryRequired) roles power the Coverage strip.
  const requiredRoles = useMemo(
    () => roleCatalog.filter((rt) => rt.isPrimaryRequired).sort((a, b) => a.sortOrder - b.sortOrder),
    [roleCatalog],
  );

  // ─── UI state ──────────────────────────────────────────────────────
  const [population, setPopulation] = useState<Population>('team');
  const [view, setView] = useState<ViewMode>('table');
  const [groupBy, setGroupBy] = useState<GroupBy>('discipline');
  const [search, setSearch] = useState('');

  // Filters (multi-select). Empty set = no filter.
  const [roleFilter, setRoleFilter] = useState<Set<number>>(new Set());
  const [disciplineFilter, setDisciplineFilter] = useState<Set<number>>(new Set());
  const [laborFilter, setLaborFilter] = useState<Set<number>>(new Set());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersAnchorRef = useRef<HTMLButtonElement>(null);

  // Table interaction state.
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>({ key: 'name', dir: 'asc' });
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Drawer + add flows.
  const [focusedPartnerId, setFocusedPartnerId] = useState<number | null>(null);
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  const [roleAssignmentTarget, setRoleAssignmentTarget] = useState<ProjectRoleTypeRow | null>(null);
  const [showCustomerContactPicker, setShowCustomerContactPicker] = useState(false);
  // QA4 D9 — project-scoped contacts import (Excel). Mounts the shared
  // ContactsImportWizard in a modal with defaultProjectId={projectId}
  // so imported people land as stakeholders on THIS project. `dirty`
  // flag is fed by the wizard so the modal can gate discard on close.
  const [showImportContacts, setShowImportContacts] = useState(false);
  const [importContactsDirty, setImportContactsDirty] = useState(false);
  // showAddMember (participant role) is lifted state; opening happens
  // via onToggleAddMember, which the parent detail-page owns.

  // ─── Mutations ─────────────────────────────────────────────────────
  const softEnd = useMutation({
    mutationFn: (relationshipId: number) =>
      client.delete(`/partner-relationships/${relationshipId}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
      queryClient.invalidateQueries({ queryKey: ['assignee-candidates', projectId] });
      notify.success('Removed from project', { code: 'PROJECT-TEAM-DELETE-200' });
    },
    onError: (err: unknown) => notify.apiError(err, 'Failed to remove from project'),
  });

  const removeRoleAssignment = useMutation({
    mutationFn: (id: number) =>
      client.delete(`/project-partner-roles/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
      queryClient.invalidateQueries({ queryKey: ['assignee-candidates', projectId] });
      notify.success('Removed from project', { code: 'PROJECT-PPR-DELETE-200' });
    },
    onError: (err: unknown) => notify.apiError(err, 'Failed to remove from project'),
  });

  // ─── QA4 D7 inline-edit mutations ──────────────────────────────────
  // Extends and supersedes D3's ChangeRoleModal — the reassignment
  // logic now lives here so the inline Project Role cell can trigger it
  // directly without a modal. Ordering: CREATE new PPR first (runs
  // server-side eligibility), THEN soft-end the source PPR (only when
  // one exists) — a failure between the two calls leaves the member
  // over-covered rather than stranded unassigned.

  /** Reassign a party from one Project Role to another (D3 mechanism,
   *  inline). `sourcePprId === null` means "add a role" — used when the
   *  row currently holds no non-participant role. */
  const reassignRole = useMutation({
    mutationFn: async (vars: {
      partyId: number;
      sourcePprId: number | null;
      targetRoleId: number;
    }) => {
      const created = await client
        .post('/project-partner-roles', {
          projectId,
          partyId: vars.partyId,
          roleId: vars.targetRoleId,
        })
        .then((r) => r.data);
      if (vars.sourcePprId != null) {
        try {
          await client.delete(`/project-partner-roles/${vars.sourcePprId}`);
        } catch (e) {
          notify.apiError(e, 'New role added, but the old role could not be ended');
        }
      }
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
      queryClient.invalidateQueries({ queryKey: ['assignee-candidates', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-role-eligible-parties'] });
      notify.success('Role updated', { code: 'PPR-CHANGE-200' });
    },
    onError: (err: unknown) => notify.apiError(err, 'Failed to update role'),
  });

  /** Single-field PATCH /business-partners/:id — used by the inline
   *  Discipline / Email / Phone cells. Field values flow through the
   *  same UpdateBusinessPartnerDto that the partner-drawer's Save uses,
   *  so validation rules (email format, discipline id existence) match. */
  const updateBP = useMutation({
    mutationFn: (vars: {
      bpId: number;
      patch: { disciplineId?: number | null; email?: string | null; phone?: string | null };
      successMessage: string;
      successCode: string;
    }) =>
      client.patch(`/business-partners/${vars.bpId}`, vars.patch).then((r) => r.data),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      queryClient.invalidateQueries({ queryKey: ['business-partner', vars.bpId] });
      notify.success(vars.successMessage, { code: vars.successCode });
    },
    onError: (err: unknown) => notify.apiError(err, 'Failed to save change'),
  });

  // ─── Remove helpers ────────────────────────────────────────────────
  const confirmRemovePerson = async (row: ProjectTeamPerson) => {
    const who = row.displayName || 'this person';
    const heldRoles =
      team?.roleAssignments
        .filter((a) => a.party.id === row.businessPartnerId)
        .map((a) => a.role.name) ?? [];
    const rolesLine =
      heldRoles.length > 0
        ? `\nTheir project roles will end: ${heldRoles.join(', ')}.`
        : '';
    const leaderLine = heldRoles.some((n) => /team\s*leader/i.test(n))
      ? "\n\nThey are the Team Leader on this project — remove or reassign leadership first if you don't want to lose the assignment."
      : '';
    const ok = await confirm(
      `${who} will lose active membership on this project.${rolesLine}${leaderLine}`,
      {
        title: `Remove ${who} from this project?`,
        variant: 'danger',
        confirmLabel: 'Remove',
      },
    );
    if (!ok) return;
    if (row.userId) {
      removeMember.mutate(
        { projectId, memberId: row.userId },
        {
          onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: ['project-team', projectId] }),
        },
      );
      return;
    }
    softEnd.mutate(row.relationshipId);
  };

  const confirmRemoveRoleAssignment = async (a: ProjectRoleAssignment) => {
    const who = a.party.displayName;
    const leaderLine = a.role.code === 'team_leader'
      ? '\n\nThey will also lose leader access to the project (project.leaderId is cleared).'
      : '';
    const requiredLine = a.role.isPrimaryRequired
      ? ` This is a required project role — the project will show as under-staffed until another ${a.role.name.toLowerCase()} is added.`
      : '';
    const ok = await confirm(
      `${who} will no longer be the ${a.role.name} on this project.${requiredLine}${leaderLine}`,
      {
        title: `Remove ${who} as ${a.role.name}?`,
        variant: 'danger',
        confirmLabel: 'Remove',
      },
    );
    if (ok) removeRoleAssignment.mutate(a.id);
  };

  // ─── Row assembly ──────────────────────────────────────────────────
  // Team-Leader detection — used to give the leader an indigo avatar
  // accent regardless of population.
  const teamLeaderBpIds = useMemo(() => {
    const s = new Set<number>();
    for (const a of team?.roleAssignments ?? []) {
      if (a.role.code === 'team_leader') s.add(a.party.id);
    }
    return s;
  }, [team]);

  // "Our Team" rows — internal employees (party has a linked `User`).
  // QA4 D1 (2026-09-28): the population is now the UNION of
  //   • `projectTeam` (employees with a `participant` PPR mirror) — the
  //     established path;
  //   • employees found ONLY in `roleAssignments` — e.g. a Team Leader
  //     or BIM Manager added without a participant mirror (which is
  //     legal for role-first adds and legacy data).
  // Previously the "orphan employee" case landed in Stakeholders,
  // which read as "add succeeded but no one appeared under Our Team".
  // D2 (following commit) ensures new adds also write the participant
  // mirror; this classifier keeps both existing rows and any future
  // races correct. Every team member folds the roles they hold across
  // the project into one row.
  const teamRows: TeamRow[] = useMemo(() => {
    if (!team) return [];
    const out: TeamRow[] = [];
    const seen = new Set<number>();

    for (const m of team.projectTeam) {
      const held = team.roleAssignments.filter((a) => a.party.id === m.businessPartnerId);
      const roleNames = held.map((a) => a.role.name);
      const roleIds = held.map((a) => a.role.id);
      seen.add(m.businessPartnerId);
      out.push({
        rowKey: `team-${m.relationshipId}`,
        bpId: m.businessPartnerId,
        displayName: m.displayName,
        firstName: m.firstName,
        lastName: m.lastName,
        email: m.email,
        phone: m.phone,
        discipline: m.discipline?.name ?? null,
        disciplineId: m.discipline?.id ?? null,
        seniorityName: m.seniorityLevel?.name ?? null,
        seniorityId: m.seniorityLevel?.id ?? null,
        roleNames,
        roleIds,
        roleNamesLabel: roleNames.length > 0 ? roleNames.join(', ') : 'Team member',
        rowType: 'employee',
        isTeamLeader: teamLeaderBpIds.has(m.businessPartnerId),
        orgName: null,
        orgId: null,
        contextBadge: null,
        contextTitle: null,
        partyKind: 'person',
        onRemove: () => confirmRemovePerson(m),
      });
    }

    // Orphan employees — party.user is set but no participant mirror
    // exists for them yet. Group by party.id so a person holding two
    // non-participant roles renders as ONE Our-Team row.
    const orphanByBp = new Map<number, ProjectRoleAssignment[]>();
    for (const a of team.roleAssignments) {
      if (a.party.user?.id == null) continue;
      if (seen.has(a.party.id)) continue;
      const list = orphanByBp.get(a.party.id) ?? [];
      list.push(a);
      orphanByBp.set(a.party.id, list);
    }
    for (const [bpId, held] of orphanByBp) {
      const first = held[0]!;
      const roleNames = held.map((a) => a.role.name);
      const roleIds = held.map((a) => a.role.id);
      out.push({
        rowKey: `team-orphan-${bpId}`,
        bpId,
        displayName: first.party.displayName,
        firstName: first.party.firstName,
        lastName: first.party.lastName,
        email: first.party.email ?? null,
        phone: first.party.phone ?? null,
        discipline: first.party.discipline?.name ?? null,
        disciplineId: first.party.discipline?.id ?? null,
        // Labor Category (seniority) — not surfaced on
        // roleAssignments.party today; leave blank rather than fetch.
        // The row will simply not participate in the Labor Category
        // filter until a participant mirror lands (D2).
        seniorityName: null,
        seniorityId: null,
        roleNames,
        roleIds,
        roleNamesLabel: roleNames.length > 0 ? roleNames.join(', ') : 'Team member',
        rowType: 'employee',
        isTeamLeader: teamLeaderBpIds.has(bpId),
        orgName: null,
        orgId: null,
        contextBadge: null,
        contextTitle: null,
        partyKind: 'person',
        // Remove goes through the role assignment itself — no
        // participant mirror to end. Using the first held role for the
        // confirm copy keeps the message concrete.
        onRemove: () => confirmRemoveRoleAssignment(first),
      });
    }

    return out;
  }, [team, teamLeaderBpIds]);

  // Stakeholders — external role assignments (orgs and non-employee
  // people) + the customer org + customer contacts. Rows are keyed by
  // {roleAssignmentId | customerContactRelationshipId | customer-org}
  // so a party assigned to multiple stakeholder roles produces one row
  // per role (they're genuinely different attachments).
  const stakeholderRows: TeamRow[] = useMemo(() => {
    if (!team) return [];
    const out: TeamRow[] = [];

    // Customer org row.
    if (team.customer) {
      out.push({
        rowKey: `customer-org-${team.customer.organizationId}`,
        bpId: team.customer.organizationId,
        displayName: team.customer.displayName,
        firstName: null,
        lastName: null,
        email: team.customer.email,
        phone: team.customer.phone,
        discipline: null,
        disciplineId: null,
        seniorityName: null,
        seniorityId: null,
        roleNames: ['Customer'],
        roleIds: [],
        roleNamesLabel: 'Customer',
        rowType: 'org',
        isTeamLeader: false,
        orgName: team.customer.displayName,
        orgId: team.customer.organizationId,
        contextBadge: null,
        contextTitle: null,
        partyKind: 'organization',
        onRemove: null, // customer is locked
      });
    }

    // Customer contacts (project-scoped person rows).
    for (const c of team.customerContacts) {
      out.push({
        rowKey: `cc-${c.relationshipId}`,
        bpId: c.businessPartnerId,
        displayName: c.displayName,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone,
        discipline: c.discipline?.name ?? null,
        disciplineId: c.discipline?.id ?? null,
        seniorityName: null,
        seniorityId: null,
        roleNames: [c.relationshipTypeName ?? 'Customer contact'],
        roleIds: [],
        roleNamesLabel: c.relationshipTypeName ?? 'Customer contact',
        rowType: 'contact',
        isTeamLeader: false,
        orgName: team.customer?.displayName ?? null,
        orgId: team.customer?.organizationId ?? null,
        contextBadge: null,
        contextTitle: null,
        partyKind: 'person',
        onRemove: async () => {
          const who = c.displayName || 'this contact';
          const ok = await confirm(
            `${who} will no longer be listed as a customer contact on this project.`,
            {
              title: `Remove ${who} from customer contacts?`,
              variant: 'danger',
              confirmLabel: 'Remove',
            },
          );
          if (ok) removeRoleAssignment.mutate(c.relationshipId);
        },
      });
    }

    // QA4 D1 (2026-09-28) — classify by EMPLOYEE status, not by
    // participant-mirror membership. A roleAssignment whose party has
    // a linked internal User is an employee → surfaced under Our Team
    // via `teamRows` above (rolled up onto their projectTeam row when
    // present, or as an "orphan employee" row below when the
    // participant mirror is missing). Everyone else (orgs, freelancers,
    // customer contacts, related parties) stays in Stakeholders.
    // Previously the split keyed on presence in `team.projectTeam`,
    // which only contains `participant` PPRs — so employees added via
    // a non-participant PPR (Team Leader, BIM Manager…) landed in
    // Stakeholders. See docs/bm2/qa4-round1.md §D0-D1.
    const teamBpIds = new Set(team.projectTeam.map((p) => p.businessPartnerId));
    for (const a of team.roleAssignments) {
      // Employee = linked User row on the party. Already-surfaced-under-
      // Our-Team-via-projectTeam rows are skipped either way, but we
      // ALSO skip employees who have NO projectTeam row: `orphanTeamRows`
      // (below) picks those up as first-class Our-Team rows so an
      // employee added via team_leader / BIM Manager (no participant
      // mirror) still shows under Our Team.
      if (a.party.user?.id != null) continue;
      if (teamBpIds.has(a.party.id)) continue; // legacy safety net
      const isOrg = a.party.partnerType === 'organization';
      out.push({
        rowKey: `ra-${a.id}`,
        bpId: a.party.id,
        displayName: a.party.displayName,
        firstName: a.party.firstName,
        lastName: a.party.lastName,
        email: a.party.email ?? null,
        phone: a.party.phone ?? null,
        discipline: a.party.discipline?.name ?? null,
        disciplineId: a.party.discipline?.id ?? null,
        seniorityName: null,
        seniorityId: null,
        roleNames: [a.role.name],
        roleIds: [a.role.id],
        roleNamesLabel: a.role.name,
        rowType: isOrg ? 'org' : 'contact',
        isTeamLeader: !isOrg && teamLeaderBpIds.has(a.party.id),
        orgName: a.onBehalfOfParty?.displayName ?? (isOrg ? a.party.displayName : null),
        orgId: a.onBehalfOfParty?.id ?? (isOrg ? a.party.id : null),
        contextBadge: null,
        contextTitle: null,
        partyKind: isOrg ? 'organization' : 'person',
        onRemove: () => confirmRemoveRoleAssignment(a),
      });
    }

    // D4-4 — customer's Consultant / Supplier / PM parties as read-only
    // context rows. They are grouped under the customer org (orgName =
    // customer displayName) so they land in the same Stakeholders group
    // as customer contacts. `roleIds: []` means the Project Role
    // filter naturally excludes them (they are NOT participants).
    // `onRemove: null` blocks the `✕` action (they have no
    // ProjectPartnerRole to delete).
    const CTX_SHORT: Record<CustomerRelatedRow['typeCode'], string> = {
      consultant_of: 'Consultant',
      supplier_of: 'Supplier',
      pm_supervision_for: 'PM',
    };
    for (const c of team.customerRelated ?? []) {
      out.push({
        rowKey: `crel-${c.relationshipId}`,
        bpId: c.partyId,
        displayName: c.displayName,
        firstName: null,
        lastName: null,
        email: c.email,
        phone: c.phone,
        discipline: c.discipline?.name ?? null,
        disciplineId: c.discipline?.id ?? null,
        seniorityName: null,
        seniorityId: null,
        // No project role — Project Role filter excludes them.
        roleNames: [],
        roleIds: [],
        // Sort by role uses this; keep it consistent with the badge so
        // "Consultant" rows cluster together on a role sort.
        roleNamesLabel: CTX_SHORT[c.typeCode] ?? c.typeLabel,
        rowType: 'related',
        isTeamLeader: false,
        orgName: team.customer?.displayName ?? null,
        orgId: team.customer?.organizationId ?? null,
        contextBadge: CTX_SHORT[c.typeCode] ?? c.typeLabel,
        contextTitle: c.titleAtCustomer,
        partyKind: c.partyKind,
        onRemove: null, // read-only — no ProjectPartnerRole exists to delete
      });
    }

    return out;
  }, [team, teamLeaderBpIds]);

  const allRows: TeamRow[] = useMemo(() => [...teamRows, ...stakeholderRows], [teamRows, stakeholderRows]);

  // ─── Filter options ────────────────────────────────────────────────
  const source = population === 'team' ? teamRows : population === 'stake' ? stakeholderRows : allRows;

  const disciplineOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const r of source) if (r.disciplineId != null) seen.set(r.disciplineId, r.discipline!);
    return Array.from(seen.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [source]);

  const laborOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const r of source) if (r.seniorityId != null) seen.set(r.seniorityId, r.seniorityName!);
    return Array.from(seen.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [source]);

  const roleOptions = useMemo(
    () =>
      addableRoles.map((r) => ({ value: r.id, label: r.name })),
    [addableRoles],
  );

  // ─── Filtering ─────────────────────────────────────────────────────
  const activeFilterCount =
    roleFilter.size +
    disciplineFilter.size +
    laborFilter.size +
    (statusFilter !== 'active' ? 1 : 0) +
    (search.trim() ? 1 : 0);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return source.filter((r) => {
      if (q) {
        const hay = [r.displayName, r.email, r.phone].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (roleFilter.size > 0) {
        if (!r.roleIds.some((id) => roleFilter.has(id))) return false;
      }
      if (disciplineFilter.size > 0) {
        if (r.disciplineId == null || !disciplineFilter.has(r.disciplineId)) return false;
      }
      if (laborFilter.size > 0) {
        if (r.seniorityId == null || !laborFilter.has(r.seniorityId)) return false;
      }
      // Status is informational for now — every row we load is active
      // in the sense that its valid window covers `now` (backend
      // filter). We keep the control for API parity with the spec.
      if (statusFilter === 'inactive') return false;
      return true;
    });
  }, [source, search, roleFilter, disciplineFilter, laborFilter, statusFilter]);

  // ─── Sorting ───────────────────────────────────────────────────────
  const sortValue = (r: TeamRow, k: SortKey): string => {
    if (k === 'name') return r.displayName;
    if (k === 'role') return r.roleNamesLabel;
    if (k === 'discipline') return r.discipline ?? '';
    if (k === 'email') return r.email ?? '';
    if (k === 'phone') return r.phone ?? '';
    if (k === 'type') return r.rowType;
    return '';
  };
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) =>
      sortValue(a, sort.key).localeCompare(sortValue(b, sort.key)) * dir,
    );
  }, [filtered, sort]);

  // ─── Grouping ──────────────────────────────────────────────────────
  const groups = useMemo(() => {
    // Stakeholders always group by organization regardless of the
    // "Group" dropdown — spec §4 bullet 2. Everywhere else uses the
    // dropdown value.
    const effectiveGroup: GroupBy | 'org' = population === 'stake' ? 'org' : groupBy;
    const bins = new Map<string, TeamRow[]>();
    const order: string[] = [];
    const addTo = (key: string, r: TeamRow) => {
      if (!bins.has(key)) {
        bins.set(key, []);
        order.push(key);
      }
      bins.get(key)!.push(r);
    };
    for (const r of sorted) {
      if (effectiveGroup === 'flat') {
        addTo('__flat__', r);
      } else if (effectiveGroup === 'discipline') {
        addTo(r.discipline ?? 'No discipline', r);
      } else if (effectiveGroup === 'role') {
        const label = r.roleNames.length > 0 ? r.roleNames[0] : 'Team member';
        addTo(label, r);
      } else if (effectiveGroup === 'org') {
        addTo(r.orgName ?? 'Unaffiliated', r);
      }
    }
    return order.map((k) => ({ key: k, rows: bins.get(k)! }));
  }, [sorted, groupBy, population]);

  const collapseAll = () => setCollapsedGroups(new Set(groups.map((g) => g.key)));
  const expandAll = () => setCollapsedGroups(new Set());
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsedGroups.has(g.key));

  const toggleGroup = (k: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  // ─── Coverage strip helpers ────────────────────────────────────────
  // QA4 D5 (2026-09-28) — the `customer` role is special:
  // getTeam EXCLUDES role.code='customer' from `roleAssignments`
  // (`projects.service.ts` ~1345), so reading `filled` from that list
  // ALWAYS returned []. Previously the coverage chip therefore showed
  // "Customer · not assigned" even on projects that had a customer,
  // and its "+" opened the generic RoleAssignmentPicker which POSTed a
  // duplicate customer PPR. We now special-case the customer coverage
  // row to read `team.customer` and render a dedicated chip; the "+"
  // routes to the project edit form (canonical customer path via
  // `customerOrgId` → `setProjectCustomer`, which soft-ends the old
  // customer row and never creates a duplicate).
  const coverage = useMemo(() => {
    return requiredRoles.map((rt) => {
      if (rt.code === 'customer') {
        return { role: rt, filled: [] as ProjectRoleAssignment[], customer: team?.customer ?? null };
      }
      // team_leader also honours project.leaderId via ProjectPartnerRole,
      // so this simply reads the assignments list.
      const filled = team?.roleAssignments.filter((a) => a.role.id === rt.id) ?? [];
      return { role: rt, filled, customer: null };
    });
  }, [requiredRoles, team]);

  // ─── Loading / error ───────────────────────────────────────────────
  if (isLoading) {
    return (
      <p className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">Loading team…</p>
    );
  }
  if (isError || !team) {
    return (
      <div className="py-8 flex flex-col items-center gap-3 text-sm">
        <p className="text-red-600 dark:text-red-400 font-medium">Couldn't load the team for this project.</p>
        <button
          type="button"
          onClick={() => refetchTeam()}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[13px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
        >
          Retry
        </button>
      </div>
    );
  }

  // Counts for the segmented control ─ live, filter-independent.
  const counts = { team: teamRows.length, stake: stakeholderRows.length, all: allRows.length };

  const totalUnfiltered = source.length;

  // ─── Row actions ──────────────────────────────────────────────────
  const openDrawer = (bpId: number) => setFocusedPartnerId(bpId);

  // Trigger the role-first add for a specific role (from coverage
  // chip). The "participant" role opens the internal team-member
  // dialog instead of the generic RoleAssignmentPicker; the
  // "customer" role NEVER opens the generic picker — customer is
  // assigned via `customerOrgId` on Project Info / Edit
  // (`setProjectCustomer`) so history is preserved and duplicate
  // customer PPRs are impossible. See QA4 D5.
  const openAddForRole = (rt: ProjectRoleTypeRow) => {
    if (rt.code === 'participant') {
      onToggleAddMember(true);
      return;
    }
    if (rt.code === 'customer') {
      navigate(`/projects/${projectId}/edit`);
      return;
    }
    setRoleAssignmentTarget(rt);
  };

  const clearAllFilters = () => {
    setRoleFilter(new Set());
    setDisciplineFilter(new Set());
    setLaborFilter(new Set());
    setStatusFilter('active');
    setSearch('');
  };

  return (
    <div className="space-y-4">
      {/* Header row — heading + primary "+ Add person" CTA. */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Project Team</h2>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 max-w-lg">
            Company staff and outside parties, separated. Removals are <strong>ended</strong> (history preserved).
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canImportContacts && (
            <button
              type="button"
              onClick={() => setShowImportContacts(true)}
              title="Bulk-load stakeholders from a developer Excel sheet"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
            >
              <UploadIcon className="h-3.5 w-3.5" aria-hidden="true" />
              Import contacts (Excel)
            </button>
          )}
          {canWritePartners && (
            <button
              type="button"
              onClick={() => setAddPickerOpen(true)}
              title="Add anyone to the project in a role"
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-blue-700"
            >
              <UserPlus className="h-3.5 w-3.5" />
              Add person
            </button>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
        {/* Toolbar row 1 — segmented population control + view toggle. */}
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 dark:border-slate-800 px-3 py-2">
          <div
            role="tablist"
            aria-label="Team population"
            className="inline-flex rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5"
          >
            {(
              [
                { id: 'team', label: 'Our Team', n: counts.team },
                { id: 'stake', label: 'Stakeholders', n: counts.stake },
                { id: 'all', label: 'All', n: counts.all },
              ] as { id: Population; label: string; n: number }[]
            ).map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={population === p.id}
                onClick={() => setPopulation(p.id)}
                className={seg(population === p.id)}
              >
                <span>{p.label}</span>
                <span className="font-mono text-[10px] opacity-60">{p.n}</span>
              </button>
            ))}
          </div>

          <div className="flex-1" />

          <label className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 h-[34px] min-w-[180px]">
            <SearchIcon className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email, phone…"
              aria-label="Search team members"
              className="flex-1 bg-transparent text-[13px] text-slate-700 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none"
            />
          </label>

          {/* Filters button + popover. */}
          <div className="relative">
            <button
              ref={filtersAnchorRef}
              type="button"
              onClick={() => setFiltersOpen((v) => !v)}
              aria-expanded={filtersOpen}
              aria-haspopup="dialog"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 h-[34px] text-[12.5px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
            >
              <FilterIcon className="h-3.5 w-3.5" aria-hidden="true" />
              Filters
              {activeFilterCount > 0 && (
                <span className="rounded-full bg-blue-600 px-1.5 text-[10px] font-bold text-white font-mono">
                  {activeFilterCount}
                </span>
              )}
            </button>
            {filtersOpen && (
              <FiltersPopover
                onClose={() => setFiltersOpen(false)}
                roleOptions={roleOptions}
                disciplineOptions={disciplineOptions}
                laborOptions={laborOptions}
                roleFilter={roleFilter}
                setRoleFilter={setRoleFilter}
                disciplineFilter={disciplineFilter}
                setDisciplineFilter={setDisciplineFilter}
                laborFilter={laborFilter}
                setLaborFilter={setLaborFilter}
                statusFilter={statusFilter}
                setStatusFilter={setStatusFilter}
              />
            )}
          </div>

          {/* Group dropdown. Stakeholders always groups by org (spec) —
              the dropdown is disabled there to reflect that. */}
          <select
            aria-label="Group rows by"
            value={population === 'stake' ? 'org' : groupBy}
            disabled={population === 'stake'}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            className="h-[34px] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 text-[12.5px] font-semibold text-slate-700 dark:text-slate-200 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {population === 'stake' ? (
              <option value="org">Group: Organization</option>
            ) : (
              <>
                <option value="discipline">Group: Discipline</option>
                <option value="role">Group: Project Role</option>
                <option value="flat">Group: Flat</option>
              </>
            )}
          </select>

          {/* Table / Cards toggle. */}
          <div
            role="group"
            aria-label="View"
            className="inline-flex items-center rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5 h-[34px]"
          >
            <button
              type="button"
              aria-pressed={view === 'table'}
              onClick={() => setView('table')}
              className={cn(
                'rounded-md px-3 h-[30px] text-[12px] font-semibold',
                view === 'table'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400',
              )}
            >
              Table
            </button>
            <button
              type="button"
              aria-pressed={view === 'cards'}
              onClick={() => setView('cards')}
              className={cn(
                'rounded-md px-3 h-[30px] text-[12px] font-semibold',
                view === 'cards'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400',
              )}
            >
              Cards
            </button>
          </div>
        </div>

        {/* Active filter chips row (+ "N of M" count). */}
        {(activeFilterCount > 0 || filtered.length !== totalUnfiltered) && (
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30 px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Filters
            </span>
            {search.trim() && (
              <FilterChip label={`Search: ${search.trim()}`} onClear={() => setSearch('')} />
            )}
            {[...roleFilter].map((id) => {
              const opt = roleOptions.find((o) => o.value === id);
              if (!opt) return null;
              return (
                <FilterChip
                  key={`role-${id}`}
                  label={`Role: ${opt.label}`}
                  onClear={() => {
                    const next = new Set(roleFilter);
                    next.delete(id);
                    setRoleFilter(next);
                  }}
                />
              );
            })}
            {[...disciplineFilter].map((id) => {
              const opt = disciplineOptions.find((o) => o.value === id);
              if (!opt) return null;
              return (
                <FilterChip
                  key={`disc-${id}`}
                  label={`Discipline: ${opt.label}`}
                  onClear={() => {
                    const next = new Set(disciplineFilter);
                    next.delete(id);
                    setDisciplineFilter(next);
                  }}
                />
              );
            })}
            {[...laborFilter].map((id) => {
              const opt = laborOptions.find((o) => o.value === id);
              if (!opt) return null;
              return (
                <FilterChip
                  key={`labor-${id}`}
                  label={`Labor Category: ${opt.label}`}
                  onClear={() => {
                    const next = new Set(laborFilter);
                    next.delete(id);
                    setLaborFilter(next);
                  }}
                />
              );
            })}
            {statusFilter !== 'active' && (
              <FilterChip
                label={`Status: ${statusFilter === 'inactive' ? 'Inactive only' : 'All'}`}
                onClear={() => setStatusFilter('active')}
              />
            )}
            <button
              type="button"
              onClick={clearAllFilters}
              className="text-[12px] font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100"
            >
              Clear
            </button>
            <div className="ml-auto text-[12px] text-slate-500 dark:text-slate-400">
              Showing <strong className="text-slate-700 dark:text-slate-200">{filtered.length}</strong> of {totalUnfiltered}
            </div>
          </div>
        )}

        {/* Coverage strip — required roles. */}
        {coverage.length > 0 && (
          <div className="border-b border-slate-100 dark:border-slate-800 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
              Required roles · coverage
            </div>
            <div className="flex flex-wrap gap-2">
              {coverage.map(({ role, filled, customer }) => (
                <CoverageChip
                  key={role.id}
                  role={role}
                  filled={filled}
                  customer={customer}
                  onAdd={() => openAddForRole(role)}
                  onOpenProfile={openDrawer}
                  canWrite={canWritePartners}
                  teamLeaderBpIds={teamLeaderBpIds}
                />
              ))}
            </div>
          </div>
        )}

        {/* TA-4: no-customer hint. Stakeholders groups by customer org;
            without one, customer contacts can't be attached (the
            "Add contact" button is already correctly hidden). The
            Coverage strip above already offers the "Customer" +
            affordance — this hint just explains why the customer
            group is missing. */}
        {population === 'stake' && !team.customer && (
          <div className="border-b border-slate-100 dark:border-slate-800 px-3 py-2 text-[12px] text-slate-500 dark:text-slate-400">
            Set the project's customer to attach customer contacts.
          </div>
        )}

        {/* Group control row — Collapse all / Expand all shortcut. */}
        {view === 'table' && groups.length > 0 && (
          <div className="flex items-center justify-end gap-2 border-b border-slate-100 dark:border-slate-800 px-3 py-1.5">
            <button
              type="button"
              onClick={allCollapsed ? expandAll : collapseAll}
              className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100"
            >
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
          </div>
        )}

        {/* Body — either Table or Cards. */}
        {view === 'table' ? (
          <TableBody
            groups={groups}
            population={population}
            sort={sort}
            setSort={setSort}
            collapsedGroups={collapsedGroups}
            toggleGroup={toggleGroup}
            openDrawer={openDrawer}
            canWrite={canWritePartners}
            onAddContactAtOrg={
              customerContactRoleType && team.customer
                ? () => setShowCustomerContactPicker(true)
                : null
            }
            customerName={team.customer?.displayName ?? null}
            projectId={projectId}
            roleAssignments={team.roleAssignments}
            addableRoles={addableRoles}
            disciplineCatalog={disciplineCatalog}
            reassignRolePending={reassignRole.isPending}
            updateBPPending={updateBP.isPending}
            onReassignRole={(vars) => reassignRole.mutate(vars)}
            onUpdateBP={(vars) => updateBP.mutate(vars)}
          />
        ) : (
          <CardsBody rows={sorted} openDrawer={openDrawer} />
        )}

        {/* Empty state */}
        {groups.length === 0 && (
          <div className="p-8">
            <EmptyState
              icon={activeFilterCount > 0 ? FilterIcon : UsersIcon}
              title={activeFilterCount > 0 ? 'No rows match the active filters' : 'No one on this project yet'}
              description={
                activeFilterCount > 0
                  ? 'Clear filters or search terms to see everyone on this project.'
                  : "Click + Add person to bring someone onto the project."
              }
            />
          </div>
        )}
      </div>

      {/* ─── Overlays ───────────────────────────────────────────────── */}
      {addPickerOpen && (
        <RoleFirstPicker
          addableRoles={addableRoles}
          participantRole={roleCatalog.find((rt) => rt.code === 'participant') ?? null}
          onClose={() => setAddPickerOpen(false)}
          onPickRole={(rt) => {
            setAddPickerOpen(false);
            openAddForRole(rt);
          }}
          onPickParticipant={() => {
            setAddPickerOpen(false);
            onToggleAddMember(true);
          }}
        />
      )}

      {showAddMember && (
        <AddMemberDialog
          projectId={projectId}
          existingMemberIds={members.map((m) => m.userId)}
          onClose={() => onToggleAddMember(false)}
        />
      )}

      {roleAssignmentTarget && (
        <RoleAssignmentPicker
          role={roleAssignmentTarget}
          projectId={projectId}
          existingPartyIds={team.roleAssignments
            .filter((a) => a.role.id === roleAssignmentTarget.id)
            .map((a) => a.party.id)}
          hasExistingPrimary={team.roleAssignments.some(
            (a) => a.role.id === roleAssignmentTarget.id && a.isPrimary,
          )}
          onClose={() => setRoleAssignmentTarget(null)}
        />
      )}

      {showCustomerContactPicker && team.customer && customerContactRoleType && (
        <CustomerContactPicker
          projectId={projectId}
          customerOrgId={team.customer.organizationId}
          customerName={team.customer.displayName}
          customerContactRoleId={customerContactRoleType.id}
          existingContactBpIds={team.customerContacts.map((p) => p.businessPartnerId)}
          onClose={() => setShowCustomerContactPicker(false)}
        />
      )}

      {/*
        QA4 D9 — project-scoped contacts import. Mounts the same
        six-stage wizard shipped on /admin/data-import, but seeded with
        this project so committed rows land on THIS project as
        stakeholders (see commit.service.ts `attachToProjectId` +
        `pickProjectRoleId`). Wrapped in a Sentry.ErrorBoundary
        (mirrors D10) so a wizard-side crash keeps the Team tab usable.
      */}
      {showImportContacts && (
        <Modal
          open={showImportContacts}
          onClose={() => {
            setShowImportContacts(false);
            setImportContactsDirty(false);
          }}
          title="Import contacts from Excel"
          description="Upload a developer stakeholders sheet — matched rows attach to this project."
          widthClass="w-[960px] max-w-[95vw]"
          bodyClassName="p-5"
          isDirty={importContactsDirty}
          dirtyWarning="Discard the row decisions you already made on the Preview step?"
        >
          <Sentry.ErrorBoundary
            fallback={({ error, resetError }) => (
              <div className="rounded-[14px] border border-red-200 dark:border-red-900/60 bg-red-50/60 dark:bg-red-950/30 p-5">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                      Contacts importer hit an error
                    </h3>
                    <p className="mt-1 text-[13px] text-slate-600 dark:text-slate-300">
                      Close the dialog, refresh the page, and try again. If the
                      problem persists, use the standalone importer at
                      /admin/data-import and file a bug.
                    </p>
                    {import.meta.env.DEV && error instanceof Error && (
                      <pre className="mt-3 max-h-32 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-slate-900/40 p-2 text-[11px] font-mono text-slate-700 dark:text-slate-200">
                        {error.message}
                      </pre>
                    )}
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          resetError();
                          setShowImportContacts(false);
                          setImportContactsDirty(false);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          >
            <ContactsImportWizard
              defaultProjectId={projectId}
              onDirtyChange={setImportContactsDirty}
              onDone={() => {
                queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
                setImportContactsDirty(false);
                setShowImportContacts(false);
              }}
            />
          </Sentry.ErrorBoundary>
        </Modal>
      )}

      {focusedPartnerId != null && (
        <PartnerDrawer
          partnerId={focusedPartnerId}
          onClose={() => {
            setFocusedPartnerId(null);
            queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
          }}
        />
      )}
    </div>
  );
}

/* ─── FilterChip ───────────────────────────────────────────────────── */

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-0.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear ${label}`}
        className="text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-100"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </span>
  );
}

/* ─── FiltersPopover ───────────────────────────────────────────────── */

function FiltersPopover({
  onClose,
  roleOptions,
  disciplineOptions,
  laborOptions,
  roleFilter,
  setRoleFilter,
  disciplineFilter,
  setDisciplineFilter,
  laborFilter,
  setLaborFilter,
  statusFilter,
  setStatusFilter,
}: {
  onClose: () => void;
  roleOptions: { value: number; label: string }[];
  disciplineOptions: { value: number; label: string }[];
  laborOptions: { value: number; label: string }[];
  roleFilter: Set<number>;
  setRoleFilter: (s: Set<number>) => void;
  disciplineFilter: Set<number>;
  setDisciplineFilter: (s: Set<number>) => void;
  laborFilter: Set<number>;
  setLaborFilter: (s: Set<number>) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (s: StatusFilter) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={wrapRef}
      role="dialog"
      aria-label="Filters"
      className="absolute right-0 top-full z-40 mt-2 w-[320px] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg p-3 space-y-3"
    >
      <FilterGroup label="Project Role">
        <MultiSelectFilter
          options={roleOptions}
          selected={roleFilter}
          onChange={setRoleFilter}
          placeholder="Roles"
          triggerClassName="w-full"
        />
      </FilterGroup>
      <FilterGroup label="Discipline">
        <MultiSelectFilter
          options={disciplineOptions}
          selected={disciplineFilter}
          onChange={setDisciplineFilter}
          placeholder="Disciplines"
          triggerClassName="w-full"
        />
      </FilterGroup>
      <FilterGroup label="Labor Category">
        <MultiSelectFilter
          options={laborOptions}
          selected={laborFilter}
          onChange={setLaborFilter}
          placeholder="Labor Categories"
          triggerClassName="w-full"
        />
      </FilterGroup>
      <FilterGroup label="Status">
        <div className="flex gap-1">
          {(['active', 'inactive', 'all'] as StatusFilter[]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={statusFilter === s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                'flex-1 rounded-md px-2 py-1 text-[11.5px] font-semibold border',
                statusFilter === s
                  ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-transparent'
                  : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-400 dark:hover:border-slate-500',
              )}
            >
              {s === 'active' ? 'Active only' : s === 'inactive' ? 'Inactive only' : 'All'}
            </button>
          ))}
        </div>
      </FilterGroup>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}

/* ─── CoverageChip ─────────────────────────────────────────────────── */

function CoverageChip({
  role,
  filled,
  customer,
  onAdd,
  onOpenProfile,
  canWrite,
  teamLeaderBpIds,
}: {
  role: ProjectRoleTypeRow;
  filled: ProjectRoleAssignment[];
  /** QA4 D5 — customer coverage bypass. When role.code === 'customer'
   *  the coverage row reads `team.customer` (getTeam excludes the
   *  customer role from `roleAssignments`); pass it through so we can
   *  render "Customer · {name} ✓" without a fake PPR. Non-customer
   *  chips pass null. */
  customer: { organizationId: number; displayName: string } | null;
  onAdd: () => void;
  onOpenProfile: (bpId: number) => void;
  canWrite: boolean;
  teamLeaderBpIds: Set<number>;
}) {
  // QA4 D5 — customer role uses `team.customer`, not `filled`. When
  // set, render a filled chip whose click opens the customer org's
  // profile drawer (matches other filled chips). When unset, render
  // the amber "not assigned" affordance whose "+" navigates to Project
  // Info / Edit (handled by openAddForRole) so the customer is
  // assigned via `customerOrgId` → `setProjectCustomer` — never a
  // second customer PPR.
  if (role.code === 'customer') {
    if (customer) {
      return (
        <button
          type="button"
          onClick={() => onOpenProfile(customer.organizationId)}
          title={`Open ${customer.displayName}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-2 pr-2.5 py-0.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
        >
          <span className="text-slate-400 dark:text-slate-500 font-medium">{role.name}</span>
          <span>·</span>
          <span>{customer.displayName}</span>
          <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={canWrite ? onAdd : undefined}
        disabled={!canWrite}
        aria-label={`Assign ${role.name}`}
        title="Assign the customer on Project Info / Edit"
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold',
          'border border-dashed border-amber-400 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300',
          canWrite ? 'hover:border-amber-500' : 'opacity-60 cursor-not-allowed',
        )}
      >
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        <span>{role.name}</span>
        <span>· not assigned</span>
        <span className="text-amber-700 dark:text-amber-400 font-bold">+</span>
      </button>
    );
  }

  if (filled.length === 0) {
    return (
      <button
        type="button"
        onClick={canWrite ? onAdd : undefined}
        disabled={!canWrite}
        aria-label={`Add ${role.name}`}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold',
          'border border-dashed border-amber-400 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300',
          canWrite ? 'hover:border-amber-500' : 'opacity-60 cursor-not-allowed',
        )}
      >
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        <span>{role.name}</span>
        <span>· not assigned</span>
        <span className="text-amber-700 dark:text-amber-400 font-bold">+</span>
      </button>
    );
  }
  return (
    <>
      {filled.map((a) => {
        const isLeader = teamLeaderBpIds.has(a.party.id);
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onOpenProfile(a.party.id)}
            title={`Open ${a.party.displayName}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-1 pr-2.5 py-0.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
          >
            <Avatar
              displayName={a.party.displayName}
              firstName={a.party.firstName}
              lastName={a.party.lastName}
              isLeader={isLeader}
              size="xs"
            />
            <span className="text-slate-400 dark:text-slate-500 font-medium">{role.name}</span>
            <span>·</span>
            <span>{a.party.displayName}</span>
            <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          </button>
        );
      })}
    </>
  );
}

/* ─── Avatar ───────────────────────────────────────────────────────── */

function Avatar({
  displayName,
  firstName,
  lastName,
  isLeader,
  size = 'sm',
}: {
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  isLeader?: boolean;
  size?: 'xs' | 'sm';
}) {
  const initials =
    getInitials(firstName ?? '', lastName ?? '') || displayName.slice(0, 2).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex items-center justify-center rounded-full font-semibold shrink-0',
        size === 'xs' ? 'h-5 w-5 text-[9px]' : 'h-6 w-6 text-[10px]',
        isLeader
          ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 ring-1 ring-indigo-300 dark:ring-indigo-600'
          : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-200',
      )}
    >
      {initials}
    </span>
  );
}

/* ─── Table body (with grouping + sticky headers) ──────────────────── */

function TableBody({
  groups,
  population,
  sort,
  setSort,
  collapsedGroups,
  toggleGroup,
  openDrawer,
  canWrite,
  onAddContactAtOrg,
  customerName,
  projectId,
  roleAssignments,
  addableRoles,
  disciplineCatalog,
  reassignRolePending,
  updateBPPending,
  onReassignRole,
  onUpdateBP,
}: {
  groups: { key: string; rows: TeamRow[] }[];
  population: Population;
  sort: { key: SortKey; dir: SortDir } | null;
  setSort: (s: { key: SortKey; dir: SortDir } | null) => void;
  collapsedGroups: Set<string>;
  toggleGroup: (k: string) => void;
  openDrawer: (bpId: number) => void;
  canWrite: boolean;
  onAddContactAtOrg: (() => void) | null;
  /** QA4 D8 — used to spell out the customer's name in the grey
   *  "Add contact" button so it doesn't read as a duplicate of the
   *  blue "Add person" CTA. Nullable — the button only shows when
   *  `onAddContactAtOrg` is set, which itself gates on a customer. */
  customerName: string | null;
  /** QA4 D7 — inline-edit context. `projectId` scopes the
   *  eligible-parties query the Project Role cell fires when opened.
   *  `roleAssignments` maps party -> held PPRs so the cell knows which
   *  PPR to soft-end on reassign, and which roles to hide from the
   *  target list (duplicates are pointless). */
  projectId: number;
  roleAssignments: ProjectRoleAssignment[];
  addableRoles: ProjectRoleTypeRow[];
  disciplineCatalog: Array<{ id: number; name: string; nameHe: string | null; isActive: boolean }>;
  reassignRolePending: boolean;
  updateBPPending: boolean;
  onReassignRole: (vars: { partyId: number; sourcePprId: number | null; targetRoleId: number }) => void;
  onUpdateBP: (vars: {
    bpId: number;
    patch: { disciplineId?: number | null; email?: string | null; phone?: string | null };
    successMessage: string;
    successCode: string;
  }) => void;
}) {
  const showType = population === 'all';
  const showRepresents = population === 'stake';

  const columns: { key: SortKey; label: string; className?: string }[] = showRepresents
    ? [
        { key: 'name', label: 'Contact' },
        { key: 'type', label: 'Type' },
        { key: 'role', label: 'Represents' },
        { key: 'discipline', label: 'Discipline' },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: 'Phone' },
      ]
    : [
        { key: 'name', label: 'Name' },
        ...(showType ? [{ key: 'type' as SortKey, label: 'Type' }] : []),
        { key: 'role', label: 'Project Role' },
        { key: 'discipline', label: 'Discipline' },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: 'Phone' },
      ];

  const toggleSort = (k: SortKey) => {
    setSort(
      !sort || sort.key !== k
        ? { key: k, dir: 'asc' }
        : sort.dir === 'asc'
          ? { key: k, dir: 'desc' }
          : null,
    );
  };

  return (
    <div className="max-h-[70vh] overflow-auto">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 z-20 bg-slate-50 dark:bg-slate-800/80 backdrop-blur">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={H_CELL}>
                <button
                  type="button"
                  onClick={() => toggleSort(c.key)}
                  className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-100"
                >
                  <span>{c.label}</span>
                  <span className="text-slate-300 dark:text-slate-600 text-[9px] font-mono">
                    {sort?.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
                  </span>
                </button>
              </th>
            ))}
            <th scope="col" className={cn(H_CELL, 'w-[80px] text-right')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>

        {groups.map((g) => {
          const collapsed = collapsedGroups.has(g.key);
          const isFlat = g.key === '__flat__';
          const isOrgGroup = population === 'stake';
          const groupLabel = isFlat
            ? ''
            : isOrgGroup
              ? g.key
              : g.key;
          const totalCols = columns.length + 1;
          return (
            <tbody key={g.key} className="divide-y divide-slate-100 dark:divide-slate-800">
              {!isFlat && (
                <tr
                  className={cn(
                    'sticky z-10 bg-slate-50/95 dark:bg-slate-800/95 backdrop-blur',
                    // Second sticky row — offset so it sits UNDER the
                    // main header. Uses a fixed 34px approx table
                    // header height; Tailwind's `top-*` doesn't cover
                    // arbitrary values without config, so we inline
                    // the style.
                  )}
                  style={{ top: 34 }}
                >
                  <td colSpan={totalCols} className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleGroup(g.key)}
                        aria-expanded={!collapsed}
                        className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100"
                      >
                        {collapsed ? (
                          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        <span>{groupLabel}</span>
                        <span className="text-slate-400 dark:text-slate-500 font-mono font-medium">
                          {g.rows.length}
                        </span>
                      </button>
                      {isOrgGroup && canWrite && onAddContactAtOrg && (
                        <button
                          type="button"
                          onClick={onAddContactAtOrg}
                          title="Attach a person from the customer as a stakeholder"
                          className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
                        >
                          <Building2 className="h-3 w-3" aria-hidden="true" />
                          {customerName ? `Add contact at ${customerName}` : 'Add customer contact'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )}
              {!collapsed &&
                g.rows.map((r) => (
                  <tr
                    key={r.rowKey}
                    className="group hover:bg-slate-50/60 dark:hover:bg-slate-800/40"
                  >
                    {/* Name */}
                    <td className={CELL}>
                      <div className="flex items-center gap-2 min-w-0">
                        <Avatar
                          displayName={r.displayName}
                          firstName={r.firstName}
                          lastName={r.lastName}
                          isLeader={r.isTeamLeader}
                        />
                        <button
                          type="button"
                          onClick={() => openDrawer(r.bpId)}
                          className="font-semibold text-slate-900 dark:text-slate-100 hover:underline truncate text-left"
                          title="Open profile"
                        >
                          {r.displayName}
                        </button>
                        {/* D4-4 — party-to-customer edge badge. Muted
                            convention differentiates read-only context
                            rows from project participants. */}
                        {r.contextBadge && (
                          <ContextBadge
                            label={r.contextBadge}
                            title={r.contextTitle}
                          />
                        )}
                      </div>
                    </td>
                    {/* Type — All view only */}
                    {showType && (
                      <td className={CELL}>
                        <TypePill type={r.rowType} />
                      </td>
                    )}
                    {showRepresents && (
                      <td className={CELL}>
                        <TypePill type={r.rowType} />
                      </td>
                    )}
                    {/* Role / Represents — QA4 D7: inline-editable
                        Project Role cell (supersedes the D3 Change-role
                        row-action button). Each pill click-to-edits its
                        own PPR; the "Team member" fallback click adds a
                        role. Represents view stays read-only (orgName).
                        Related / non-employee rows stay read-only. */}
                    <td className={CELL}>
                      {showRepresents ? (
                        r.orgName ?? '—'
                      ) : (
                        <ProjectRoleCell
                          row={r}
                          projectId={projectId}
                          roleAssignments={roleAssignments}
                          addableRoles={addableRoles}
                          canEdit={canWrite && r.rowType === 'employee'}
                          pending={reassignRolePending}
                          onReassign={onReassignRole}
                        />
                      )}
                    </td>
                    {/* Discipline — inline-editable for person BPs. */}
                    <td className={CELL}>
                      <DisciplineCell
                        row={r}
                        catalog={disciplineCatalog}
                        canEdit={canWrite && r.rowType !== 'related' && r.rowType !== 'org'}
                        pending={updateBPPending}
                        onUpdate={onUpdateBP}
                      />
                    </td>
                    {/* Email — click-to-edit inline input. */}
                    <td className={CELL}>
                      <EmailCell
                        row={r}
                        canEdit={canWrite && r.rowType !== 'related'}
                        pending={updateBPPending}
                        onUpdate={onUpdateBP}
                      />
                    </td>
                    {/* Phone — click-to-edit inline input. */}
                    <td className={cn(CELL, 'font-mono whitespace-nowrap')}>
                      <PhoneCell
                        row={r}
                        canEdit={canWrite && r.rowType !== 'related'}
                        pending={updateBPPending}
                        onUpdate={onUpdateBP}
                      />
                    </td>
                    {/* Row actions */}
                    <td className={cn(CELL, 'text-right')}>
                      <div className="inline-flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <button
                          type="button"
                          onClick={() => openDrawer(r.bpId)}
                          aria-label={`Open ${r.displayName}`}
                          title="Open profile"
                          className="rounded p-1 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        {r.onRemove && canWrite && (
                          <button
                            type="button"
                            onClick={r.onRemove}
                            aria-label={`Remove ${r.displayName} from project`}
                            title="Remove from project"
                            className="rounded p-1 text-slate-400 dark:text-slate-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
                          >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

/* ─── QA4 D7 inline-editable cells ──────────────────────────────────
   Small, self-contained cells that manage their own local editing
   state. All four follow the People-page inline pattern (`get-columns.tsx`):
   click-to-edit affordance, ESC cancels, commit on blur/Enter or on
   select-change, and the row is disabled while the enclosing mutation
   is in-flight. Success/error toasts come from the parent mutation. */

/**
 * Project Role — pill-per-role rendering, but each pill is a click
 * target that opens an inline `<select>` scoped to reassigning that
 * specific PPR. The "Team member" italic fallback (no non-participant
 * roles yet) opens the same select in "add role" mode (POST only, no
 * DELETE). Target options are filtered to `addableRoles` whose
 * `allowedPartnerKind` matches the party (or is 'any'), minus roles
 * the party already holds — the server still runs the full eligibility
 * check (allowedPartnerKind + requiredPartnerRoleCode +
 * requiredProfessionIds) on the POST and toasts the reason on 4xx.
 *
 * QA4 D7 follow-up (2026-09-28): while the editor is open we expose a
 * lazy "N target roles not eligible — show why" expander mirroring the
 * New-Project TeamPartyPicker pattern (`project-form-page.tsx`
 * ~1517-1543) and RoleAssignmentPicker (~334-378). The eligibility
 * endpoint is party-per-role-scoped (`GET /admin/project-role-types/
 * :code/eligible-parties?projectId=…` returns the full party list),
 * so we defer the fetch until the user clicks the expander, then fire
 * `Promise.all(addableRoles.map(rt => queryClient.fetchQuery(...)))`
 * in ONE round-trip. Cache key is per (roleCode, projectId, partyId)
 * so opening the same cell twice reuses the react-query cache; the
 * `<select>` itself still renders instantly from the client-side
 * pre-filter (kind rules + already-held roles). If every addableRole
 * turns out to be eligible for this party, the expander stays hidden.
 */
function ProjectRoleCell({
  row,
  projectId,
  roleAssignments,
  addableRoles,
  canEdit,
  pending,
  onReassign,
}: {
  row: TeamRow;
  projectId: number;
  roleAssignments: ProjectRoleAssignment[];
  addableRoles: ProjectRoleTypeRow[];
  canEdit: boolean;
  pending: boolean;
  onReassign: (vars: { partyId: number; sourcePprId: number | null; targetRoleId: number }) => void;
}) {
  const queryClient = useQueryClient();

  // `editingSourcePprId === undefined` → not editing.
  // `null` → editing in "add role" mode (row currently holds no PPR).
  // `number` → editing an existing PPR (reassign mode).
  const [editingSourcePprId, setEditingSourcePprId] = useState<number | null | undefined>(undefined);

  // QA4 D7 follow-up — ineligibility expander state (scoped per open).
  // `ineligibleRows === null` → not yet fetched. Populated array →
  // fetched; empty means every addableRole is eligible for this party.
  const [ineligibleRows, setIneligibleRows] = useState<Array<{ roleName: string; reasons: string[] }> | null>(null);
  const [ineligibleLoading, setIneligibleLoading] = useState(false);
  const [showIneligible, setShowIneligible] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  // Reset expander state whenever the editor closes so re-opening the
  // same cell starts clean (react-query still serves the fetch from
  // cache — this only resets the local UI toggle).
  useEffect(() => {
    if (editingSourcePprId === undefined) {
      setIneligibleRows(null);
      setIneligibleLoading(false);
      setShowIneligible(false);
    }
  }, [editingSourcePprId]);

  // PPRs THIS party holds — used to (a) resolve source pprId for pill
  // clicks by role name, (b) hide already-held roles from the target
  // dropdown.
  const heldPprs = useMemo(
    () => roleAssignments
      .filter((a) => a.party.id === row.bpId)
      .map((a) => ({ pprId: a.id, roleId: a.role.id, roleName: a.role.name })),
    [roleAssignments, row.bpId],
  );

  // Target options: kind-match + not already held. Server enforces the
  // rest (requiredPartnerRoleCode, requiredProfessionIds).
  const heldRoleIds = useMemo(() => new Set(heldPprs.map((h) => h.roleId)), [heldPprs]);
  const targetOptions = useMemo(
    () => addableRoles.filter((rt) => {
      if (heldRoleIds.has(rt.id)) return false;
      if (rt.allowedPartnerKind === 'any') return true;
      return row.partyKind ? rt.allowedPartnerKind === row.partyKind : true;
    }),
    [addableRoles, heldRoleIds, row.partyKind],
  );

  /**
   * Fetch eligibility for every addableRole for THIS party in one
   * `Promise.all`. Each per-role query hits `/admin/project-role-types/
   * :code/eligible-parties?projectId=…` (which returns the full party
   * list), then narrows to this party's row so we can surface the
   * plain-English `reasons[]`. react-query dedupes on the
   * (roleCode, projectId, partyId) key, so re-opening the same cell
   * is a warm read.
   */
  const loadIneligibility = async () => {
    if (ineligibleRows) {
      setShowIneligible((v) => !v);
      return;
    }
    setIneligibleLoading(true);
    try {
      const results = await Promise.all(
        addableRoles.map((rt) =>
          queryClient
            .fetchQuery<{ eligible: boolean; reasons: string[] }>({
              queryKey: ['role-eligibility', rt.code, projectId, row.bpId],
              staleTime: 60 * 1000,
              queryFn: () =>
                client
                  .get(`/admin/project-role-types/${encodeURIComponent(rt.code)}/eligible-parties`, {
                    params: { projectId },
                  })
                  .then((r) => {
                    const d = r.data?.data ?? r.data;
                    const list = (Array.isArray(d) ? d : []) as Array<{
                      id: number;
                      eligible: boolean;
                      reasons: string[];
                    }>;
                    const hit = list.find((p) => p.id === row.bpId);
                    return {
                      eligible: hit?.eligible ?? false,
                      reasons: Array.isArray(hit?.reasons) ? hit!.reasons : [],
                    };
                  }),
            })
            .then((data) => ({ roleName: rt.name, ...data })),
        ),
      );
      setIneligibleRows(
        results
          .filter((r) => !r.eligible)
          .map(({ roleName, reasons }) => ({ roleName, reasons })),
      );
      setShowIneligible(true);
    } catch {
      // Silent — the reassign mutation surfaces real errors on save.
      // Reset to null so the user can retry.
      setIneligibleRows(null);
    } finally {
      setIneligibleLoading(false);
    }
  };

  // Read-only render for related / contact / org rows, or when the
  // caller says we can't edit.
  if (!canEdit) {
    return row.roleNames.length > 0 ? (
      <div className="flex flex-wrap gap-1">
        {row.roleNames.map((n) => (
          <span
            key={n}
            className="inline-flex items-center rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300"
          >
            {n}
          </span>
        ))}
      </div>
    ) : row.rowType === 'related' ? (
      <span className="text-slate-300 dark:text-slate-600">—</span>
    ) : (
      <span className="text-[11.5px] italic text-slate-400 dark:text-slate-500">Team member</span>
    );
  }

  // Editing — render the inline select. Wrapped in a div so the
  // ineligibility expander (below) shares a focus scope with the
  // <select>: onBlur only closes the editor when focus leaves BOTH
  // children (i.e. the user clicked outside the cell).
  if (editingSourcePprId !== undefined) {
    const sourceRoleName =
      editingSourcePprId != null
        ? heldPprs.find((h) => h.pprId === editingSourcePprId)?.roleName ?? null
        : null;
    const showExpander = ineligibleLoading || ineligibleRows === null || ineligibleRows.length > 0;
    const ineligibleCount = ineligibleRows?.length ?? 0;
    return (
      <div
        ref={editorRef}
        className="flex flex-col gap-1 min-w-[9rem]"
        onBlur={(e) => {
          // React onBlur bubbles via focusout — close only when focus
          // truly leaves the wrapper (relatedTarget is outside).
          const next = e.relatedTarget as Node | null;
          if (editorRef.current && next && editorRef.current.contains(next)) {
            return;
          }
          setEditingSourcePprId(undefined);
        }}
      >
        <select
          autoFocus
          disabled={pending}
          defaultValue=""
          aria-label={
            sourceRoleName
              ? `Change ${sourceRoleName} for ${row.displayName}`
              : `Add project role for ${row.displayName}`
          }
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setEditingSourcePprId(undefined);
            }
          }}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (!Number.isFinite(next) || next <= 0) {
              setEditingSourcePprId(undefined);
              return;
            }
            onReassign({
              partyId: row.bpId,
              sourcePprId: editingSourcePprId,
              targetRoleId: next,
            });
            setEditingSourcePprId(undefined);
          }}
          className={cn(
            'w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[12px] text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none',
            pending && 'opacity-50 cursor-wait',
          )}
        >
          <option value="">
            {sourceRoleName ? `Change ${sourceRoleName} to…` : 'Select a role…'}
          </option>
          {targetOptions.map((rt) => (
            <option key={rt.id} value={rt.id}>{rt.name}</option>
          ))}
        </select>
        {/* QA4 D7 follow-up — lazy "N target roles not eligible — show
            why" expander. Hidden entirely when the fetch confirms every
            addableRole is eligible for this party. */}
        {addableRoles.length > 0 && showExpander && (
          <div>
            <button
              type="button"
              onClick={loadIneligibility}
              disabled={ineligibleLoading || pending}
              aria-expanded={ineligibleRows ? showIneligible : false}
              className="text-[11px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 underline decoration-dotted underline-offset-2 disabled:opacity-60 disabled:cursor-wait focus:outline-none focus:ring-2 focus:ring-blue-400 rounded"
            >
              {ineligibleLoading
                ? 'Checking eligibility…'
                : ineligibleRows === null
                  ? 'Show why other roles may not be eligible'
                  : `${ineligibleCount} not eligible — ${showIneligible ? 'hide' : 'show why'}`}
            </button>
            {ineligibleRows && showIneligible && ineligibleRows.length > 0 && (
              <ul className="mt-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 px-2 py-1.5 text-[11px] text-slate-500 dark:text-slate-400 space-y-0.5 max-h-40 overflow-y-auto">
                {ineligibleRows.map((r) => (
                  <li key={r.roleName} className="leading-snug">
                    <span className="text-slate-600 dark:text-slate-300 font-medium">{r.roleName}</span>
                    {r.reasons.length > 0 && (
                      <>
                        {' '}
                        <span className="text-slate-400 dark:text-slate-500">— {r.reasons.join(' · ')}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    );
  }

  // At-rest — pills (or "Team member" fallback) with click-to-edit.
  if (row.roleNames.length > 0) {
    return (
      <div className="flex flex-wrap gap-1">
        {heldPprs.map((h) => (
          <button
            key={h.pprId}
            type="button"
            onClick={() => setEditingSourcePprId(h.pprId)}
            title="Change role (click to reassign)"
            className="inline-flex items-center rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:text-blue-700 dark:hover:text-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            {h.roleName}
          </button>
        ))}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditingSourcePprId(null)}
      title="Add project role"
      className="text-[11.5px] italic text-slate-400 dark:text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 hover:not-italic focus:outline-none focus:ring-2 focus:ring-blue-400 rounded"
    >
      Team member
    </button>
  );
}

/**
 * Discipline — always-visible `<select>` when editable (People pattern).
 * Writes `disciplineId` via PATCH /business-partners/:id. Read-only
 * text on organization and related rows.
 */
function DisciplineCell({
  row,
  catalog,
  canEdit,
  pending,
  onUpdate,
}: {
  row: TeamRow;
  catalog: Array<{ id: number; name: string; nameHe: string | null; isActive: boolean }>;
  canEdit: boolean;
  pending: boolean;
  onUpdate: (vars: {
    bpId: number;
    patch: { disciplineId?: number | null; email?: string | null; phone?: string | null };
    successMessage: string;
    successCode: string;
  }) => void;
}) {
  if (!canEdit) {
    return row.discipline
      ? <>{row.discipline}</>
      : <span className="text-slate-300 dark:text-slate-600">—</span>;
  }
  const currentId = row.disciplineId ?? '';
  return (
    <select
      aria-label={`Discipline for ${row.displayName}`}
      value={currentId}
      disabled={pending}
      onKeyDown={(e) => {
        if (e.key === 'Escape') (e.target as HTMLSelectElement).blur();
      }}
      onChange={(e) => {
        const raw = e.target.value;
        const next = raw === '' ? null : Number(raw);
        if (next === (row.disciplineId ?? null)) return;
        onUpdate({
          bpId: row.bpId,
          patch: { disciplineId: next },
          successMessage: 'Discipline updated',
          successCode: 'BP-DISCIPLINE-200',
        });
      }}
      className={cn(
        'rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[12px] text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none',
        pending && 'opacity-50 cursor-wait',
      )}
    >
      <option value="">— None —</option>
      {catalog
        .filter((d) => d.isActive || d.id === row.disciplineId)
        .map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
    </select>
  );
}

/**
 * Email — click-to-edit inline text input. Enter/blur commits, ESC
 * cancels. Empty allowed; a non-empty value must match a light email
 * shape (contains `@` with dots on the right side) or the save is
 * rejected inline with red text. Full server validation still runs.
 */
function EmailCell({
  row,
  canEdit,
  pending,
  onUpdate,
}: {
  row: TeamRow;
  canEdit: boolean;
  pending: boolean;
  onUpdate: (vars: {
    bpId: number;
    patch: { disciplineId?: number | null; email?: string | null; phone?: string | null };
    successMessage: string;
    successCode: string;
  }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const validate = (v: string): string | null => {
    const s = v.trim();
    if (s.length === 0) return null;
    // Light guard — server has the authoritative rule.
    if (!/^\S+@\S+\.\S+$/.test(s)) return 'Not a valid email address';
    return null;
  };

  const commit = () => {
    const s = draft.trim();
    const err = validate(s);
    if (err) {
      setError(err);
      return;
    }
    const next = s.length === 0 ? null : s;
    setEditing(false);
    setError(null);
    if (next === (row.email ?? null)) return;
    onUpdate({
      bpId: row.bpId,
      patch: { email: next },
      successMessage: 'Email updated',
      successCode: 'BP-EMAIL-200',
    });
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
    setDraft('');
  };

  if (!canEdit) {
    return row.email ? (
      <a
        href={`mailto:${row.email}`}
        className="text-blue-600 dark:text-blue-400 hover:underline truncate"
      >
        {row.email}
      </a>
    ) : (
      <span className="text-slate-300 dark:text-slate-600">—</span>
    );
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-0.5">
        <input
          autoFocus
          type="email"
          value={draft}
          disabled={pending}
          placeholder="name@example.com"
          aria-label={`Email for ${row.displayName}`}
          onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
          className={cn(
            'w-full min-w-[10rem] rounded-md border px-2 py-1 text-[12px] bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 focus:outline-none',
            error
              ? 'border-red-500 focus:border-red-500'
              : 'border-slate-200 dark:border-slate-700 focus:border-blue-500',
            pending && 'opacity-50 cursor-wait',
          )}
        />
        {error && (
          <span className="text-[10.5px] text-red-600 dark:text-red-400">{error}</span>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => { setDraft(row.email ?? ''); setEditing(true); }}
      aria-label={`Edit email for ${row.displayName}`}
      className={cn(
        'text-left w-full truncate rounded focus:outline-none focus:ring-2 focus:ring-blue-400',
        row.email
          ? 'text-blue-600 dark:text-blue-400 hover:underline'
          : 'text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400',
      )}
    >
      {row.email ?? '—'}
    </button>
  );
}

/**
 * Phone — click-to-edit inline text input. Enter/blur commits, ESC
 * cancels. No format guard beyond trim; the server normalises.
 */
function PhoneCell({
  row,
  canEdit,
  pending,
  onUpdate,
}: {
  row: TeamRow;
  canEdit: boolean;
  pending: boolean;
  onUpdate: (vars: {
    bpId: number;
    patch: { disciplineId?: number | null; email?: string | null; phone?: string | null };
    successMessage: string;
    successCode: string;
  }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = () => {
    const s = draft.trim();
    const next = s.length === 0 ? null : s;
    setEditing(false);
    if (next === (row.phone ?? null)) return;
    onUpdate({
      bpId: row.bpId,
      patch: { phone: next },
      successMessage: 'Phone updated',
      successCode: 'BP-PHONE-200',
    });
  };

  const cancel = () => {
    setEditing(false);
    setDraft('');
  };

  if (!canEdit) {
    return row.phone
      ? <>{row.phone}</>
      : <span className="text-slate-300 dark:text-slate-600">—</span>;
  }

  if (editing) {
    return (
      <input
        autoFocus
        type="tel"
        value={draft}
        disabled={pending}
        placeholder="+972 …"
        aria-label={`Phone for ${row.displayName}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        className={cn(
          'w-full min-w-[8rem] rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[12px] font-mono text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none',
          pending && 'opacity-50 cursor-wait',
        )}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => { setDraft(row.phone ?? ''); setEditing(true); }}
      aria-label={`Edit phone for ${row.displayName}`}
      className={cn(
        'text-left w-full truncate rounded focus:outline-none focus:ring-2 focus:ring-blue-400',
        row.phone
          ? 'text-slate-700 dark:text-slate-200 hover:text-blue-600 dark:hover:text-blue-400'
          : 'text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400',
      )}
    >
      {row.phone ?? '—'}
    </button>
  );
}

function TypePill({ type }: { type: RowType }) {
  // D4-4 — 'related' rows are read-only party↔customer context, not
  // project participants; the pill label makes that distinction
  // visible in the All and Stakeholders views.
  const label =
    type === 'employee'
      ? 'Employee'
      : type === 'contact'
        ? 'Contact'
        : type === 'related'
          ? 'Related'
          : 'Org';
  return (
    <span className="inline-flex items-center rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
      {label}
    </span>
  );
}

/**
 * D4-4 — small muted badge that names the party-to-customer edge type
 * (Consultant / Supplier / PM). Rendered next to the name on rows of
 * type 'related'. Muted convention per spec: bg-slate-100 /
 * text-slate-500, dark variants, small `rounded` (NOT rounded-full).
 */
function ContextBadge({ label, title }: { label: string; title?: string | null }) {
  return (
    <span
      className="inline-flex items-center rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:text-slate-400"
      title={title ? `${label} — ${title}` : `${label} (related to customer)`}
    >
      {label}
    </span>
  );
}

/* ─── Cards body (fallback view — keeps the toggle useful) ─────────── */

function CardsBody({ rows, openDrawer }: { rows: TeamRow[]; openDrawer: (bpId: number) => void }) {
  if (rows.length === 0) return null;
  return (
    <div className="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
      {rows.map((r) => (
        <button
          key={r.rowKey}
          type="button"
          onClick={() => openDrawer(r.bpId)}
          className="text-left rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 hover:border-slate-400 dark:hover:border-slate-500 focus:outline-none focus:border-blue-500"
        >
          <div className="flex items-center gap-2">
            <Avatar
              displayName={r.displayName}
              firstName={r.firstName}
              lastName={r.lastName}
              isLeader={r.isTeamLeader}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <div className="font-semibold text-slate-900 dark:text-slate-100 truncate text-[13px]">
                  {r.displayName}
                </div>
                {r.contextBadge && (
                  <ContextBadge label={r.contextBadge} title={r.contextTitle} />
                )}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                {r.roleNames.length > 0
                  ? r.roleNames.join(', ')
                  : r.rowType === 'related'
                    ? r.contextTitle ?? 'Related to customer'
                    : 'Team member'}
              </div>
            </div>
          </div>
          {(r.email || r.discipline) && (
            <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400 truncate">
              {r.discipline && <span>{r.discipline}</span>}
              {r.discipline && r.email && <span> · </span>}
              {r.email && <span className="text-blue-600 dark:text-blue-400">{r.email}</span>}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

/* ─── RoleFirstPicker — role-first Add flow ────────────────────────── */

function RoleFirstPicker({
  addableRoles,
  participantRole,
  onClose,
  onPickRole,
  onPickParticipant,
}: {
  addableRoles: ProjectRoleTypeRow[];
  participantRole: ProjectRoleTypeRow | null;
  onClose: () => void;
  onPickRole: (rt: ProjectRoleTypeRow) => void;
  onPickParticipant: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Add person to project"
      description="First pick the project role — the next step lists only the parties who are eligible for it."
      widthClass="w-[520px] max-w-[92vw]"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-200 dark:border-slate-700 px-3.5 py-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50"
        >
          Cancel
        </button>
      }
    >
      <div className="space-y-2">
        {participantRole && (
          <button
            type="button"
            onClick={onPickParticipant}
            className="flex w-full items-start gap-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-left hover:border-slate-400 dark:hover:border-slate-500"
          >
            <UserPlus className="h-4 w-4 mt-0.5 text-blue-600" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Team member (internal)</div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                Adds a company employee to the project team.
              </div>
            </div>
          </button>
        )}
        {addableRoles.map((rt) => (
          <button
            key={rt.id}
            type="button"
            onClick={() => onPickRole(rt)}
            className="flex w-full items-start gap-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-left hover:border-slate-400 dark:hover:border-slate-500"
          >
            <UserPlus className="h-4 w-4 mt-0.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">
                {rt.name}
                {rt.isPrimaryRequired && (
                  <span className="ml-2 rounded-full bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 dark:text-amber-300">
                    REQUIRED
                  </span>
                )}
              </div>
              {rt.description && (
                <div className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2">
                  {rt.description}
                </div>
              )}
            </div>
          </button>
        ))}
      </div>
    </Modal>
  );
}

