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
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
  const removeMember = useRemoveProjectMember();
  const confirm = useConfirm();
  const { isAdmin, can: canPerm } = usePermissions();
  const canWritePartners = isAdmin || canPerm('partners', 'write');

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

  // "Our Team" rows — internal employees (party.user is set). Every
  // team member folds the roles they hold across the project into one
  // row so a person who is both a participant and an Architect appears
  // once.
  const teamRows: TeamRow[] = useMemo(() => {
    if (!team) return [];
    return team.projectTeam.map((m) => {
      const held = team.roleAssignments.filter((a) => a.party.id === m.businessPartnerId);
      const roleNames = held.map((a) => a.role.name);
      const roleIds = held.map((a) => a.role.id);
      return {
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
      };
    });
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

    // Role assignments — orgs and non-employee people. Skip anyone
    // already represented in the internal projectTeam list (they're
    // already surfaced in "Our Team").
    const teamBpIds = new Set(team.projectTeam.map((p) => p.businessPartnerId));
    for (const a of team.roleAssignments) {
      if (teamBpIds.has(a.party.id)) continue; // internal, shown under Our Team
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
  const coverage = useMemo(() => {
    return requiredRoles.map((rt) => {
      // team_leader also honours project.leaderId via ProjectPartnerRole,
      // so this simply reads the assignments list.
      const filled = team?.roleAssignments.filter((a) => a.role.id === rt.id) ?? [];
      return { role: rt, filled };
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
  // dialog instead of the generic RoleAssignmentPicker.
  const openAddForRole = (rt: ProjectRoleTypeRow) => {
    if (rt.code === 'participant') {
      onToggleAddMember(true);
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
        {canWritePartners && (
          <button
            type="button"
            onClick={() => setAddPickerOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-blue-700"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add person
          </button>
        )}
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
              {coverage.map(({ role, filled }) => (
                <CoverageChip
                  key={role.id}
                  role={role}
                  filled={filled}
                  onAdd={() => openAddForRole(role)}
                  onOpenProfile={openDrawer}
                  canWrite={canWritePartners}
                  teamLeaderBpIds={teamLeaderBpIds}
                />
              ))}
            </div>
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
  onAdd,
  onOpenProfile,
  canWrite,
  teamLeaderBpIds,
}: {
  role: ProjectRoleTypeRow;
  filled: ProjectRoleAssignment[];
  onAdd: () => void;
  onOpenProfile: (bpId: number) => void;
  canWrite: boolean;
  teamLeaderBpIds: Set<number>;
}) {
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
                          className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
                        >
                          <UserPlus className="h-3 w-3" aria-hidden="true" />
                          Add contact
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
                    {/* Role / Represents */}
                    <td className={CELL}>
                      {showRepresents
                        ? r.orgName ?? '—'
                        : r.roleNames.length > 0
                          ? (
                            <div className="flex flex-wrap gap-1">
                              {r.roleNames.map((n) => (
                                <span
                                  key={n}
                                  className="inline-flex items-center rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300"
                                >
                                  {n}
                                </span>
                              ))}
                            </div>
                          )
                          : r.rowType === 'related'
                            ? (
                              // D4-4 — related rows have no project role.
                              // Show a soft em-dash rather than the
                              // "Team member" fallback (they are NOT
                              // team members).
                              <span className="text-slate-300 dark:text-slate-600">—</span>
                            )
                            : (
                              <span className="text-[11.5px] italic text-slate-400 dark:text-slate-500">
                                Team member
                              </span>
                            )}
                    </td>
                    {/* Discipline */}
                    <td className={CELL}>
                      {r.discipline ? (
                        r.discipline
                      ) : (
                        <span className="text-slate-300 dark:text-slate-600">—</span>
                      )}
                    </td>
                    {/* Email */}
                    <td className={CELL}>
                      {r.email ? (
                        <a
                          href={`mailto:${r.email}`}
                          className="text-blue-600 dark:text-blue-400 hover:underline truncate"
                        >
                          {r.email}
                        </a>
                      ) : (
                        <span className="text-slate-300 dark:text-slate-600">—</span>
                      )}
                    </td>
                    {/* Phone */}
                    <td className={cn(CELL, 'font-mono whitespace-nowrap')}>
                      {r.phone ?? <span className="text-slate-300 dark:text-slate-600">—</span>}
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
