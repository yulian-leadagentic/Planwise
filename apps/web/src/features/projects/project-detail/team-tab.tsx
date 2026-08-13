import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useRemoveProjectMember } from '@/hooks/use-projects';
import { PartnerDrawer } from '@/features/partners/partner-drawer';
import { Section } from './section';
import { OrgRow } from './org-row';
import { PersonRow } from './person-row';
import { RoleAssignmentRow } from './role-assignment-row';
import { TeamTableView } from './team-table-view';
import { CustomerContactPicker } from './customer-contact-picker';
import { RoleAssignmentPicker } from './role-assignment-picker';
import { AddMemberDialog } from './add-member-dialog';
import type {
  ProjectMember,
  ProjectRoleTypeRow,
  ProjectTeamData,
  ProjectTeamPerson,
} from './types';

/* ─── Team Tab ──────────────────────────────────────────────────────────────── */

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
  // M4a — pickers are now driven by the role catalog. Two kinds of add flows:
  //   - customerContact: adds a person → customer-org partner-relationship.
  //   - roleAssignment:  adds a party → project_partner_role for a specific
  //                      ProjectRoleType (Supplier, Architect, Engineer, …).
  const [showCustomerContactPicker, setShowCustomerContactPicker] = useState(false);
  const [roleAssignmentTarget, setRoleAssignmentTarget] = useState<ProjectRoleTypeRow | null>(null);
  // Profile-link clicks open the partner drawer overlay in-place rather
  // than navigating to /partners. Shared state across all team rows.
  const [focusedPartnerId, setFocusedPartnerId] = useState<number | null>(null);

  const { data: team, isLoading } = useQuery<ProjectTeamData>({
    queryKey: ['project-team', projectId],
    queryFn: () => client.get(`/projects/${projectId}/team`).then((r) => r.data?.data ?? r.data),
  });

  // The role catalog drives the dynamic sections below. We exclude
  // 'customer' (its own locked section) and 'participant' (handled by
  // the internal Project Team section).
  const { data: roleCatalog = [] } = useQuery<ProjectRoleTypeRow[]>({
    queryKey: ['project-role-types'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/project-role-types').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });
  const dynamicRoles = roleCatalog
    .filter((rt) => rt.code !== 'customer' && rt.code !== 'participant')
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  // Split dynamic roles into two buckets so the Team tab can show the
  // "obligatory" (isPrimaryRequired) ones at the top of the page — they
  // need to be staffed for the project to be considered complete — and
  // push everything else below the Customer section. Matches the user's
  // requested ordering: Obligatory -> Project Team -> Customer ->
  // Customer Contacts -> Other roles.
  const obligatoryRoles = dynamicRoles.filter((rt) => rt.isPrimaryRequired);
  const otherRoles = dynamicRoles.filter((rt) => !rt.isPrimaryRequired);

  const softEnd = useMutation({
    // BM2 ops-surfaces Phase A: customer-contact rows are party↔party
    // edges (`worker_of` at the customer org) → /partner-relationships.
    mutationFn: (relationshipId: number) =>
      client.delete(`/partner-relationships/${relationshipId}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
      notify.success('Disconnected (soft-ended)', { code: 'PROJECT-TEAM-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to disconnect'),
  });

  const removeRoleAssignment = useMutation({
    mutationFn: (id: number) =>
      client.delete(`/project-partner-roles/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
      notify.success('Disconnected', { code: 'PROJECT-PPR-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to disconnect'),
  });

  const removeMyTeam = (row: ProjectTeamPerson) => {
    // Internal employee — disconnect via legacy ProjectMember endpoint;
    // the write-through soft-ends the participates_in_project row.
    //
    // Bug fix: the backend route is `DELETE /projects/:id/members/:userId`
    // and the service looks up `projectMember.delete({ where:
    // projectId_userId })`. The earlier code passed `member.id` (the
    // ProjectMember row PK) as `memberId`, which Prisma then couldn't
    // find — producing the "Failed to remove member" error users were
    // seeing on the Team tab. Pass the user ID instead.
    if (row.userId) {
      removeMember.mutate(
        { projectId, memberId: row.userId },
        {
          onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project-team', projectId] }),
          onError: () => notify.error('Failed to remove member'),
        },
      );
      return;
    }
    // Fallback: soft-end the relationship directly.
    softEnd.mutate(row.relationshipId);
  };

  // View toggle — Cards (the existing per-section view) vs Table (a flat
  // searchable list of everyone on the project). The table is what the
  // user asked for in A6 and is useful when scanning "who has access /
  // what's their phone number" without scrolling through five sections.
  const [view, setView] = useState<'cards' | 'table'>('cards');

  if (isLoading || !team) {
    return <p className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">Loading team...</p>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Project Team</h2>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">
            Connections between this project and your business partners. Disconnects are <strong>soft-ended</strong> (history preserved).
          </p>
        </div>
        <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5 shrink-0">
          <button
            onClick={() => setView('cards')}
            className={cn(
              'rounded-md px-3 py-1 text-[12px] font-semibold transition-colors',
              view === 'cards' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100',
            )}
          >
            Cards
          </button>
          <button
            onClick={() => setView('table')}
            className={cn(
              'rounded-md px-3 py-1 text-[12px] font-semibold transition-colors',
              view === 'table' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100',
            )}
          >
            Table
          </button>
        </div>
      </div>

      {/* Table view — single flat list of everyone touching the project
          (internal team, role assignments, customer, customer contacts).
          Each row carries name, role, email, phone, and "kind" so
          there's a single scannable surface for the contact-info use
          case. The cards view stays the default since it's the way
          users add/remove people. */}
      {view === 'table' && (
        <TeamTableView team={team} />
      )}

      {view === 'cards' && (
      <>
      {/* (cards content below — wrapped in fragment so the next-section
          markers don't shift indentation across the diff) */}

      {/* Section ordering — per user request:
            1. Obligatory roles (isPrimaryRequired)
            2. Project Team (internal members)
            3. Customer
            4. Customer Contacts
            5. Other roles (non-required)
          The obligatory bucket floats to the top because those are the
          roles that MUST be staffed for the project to be considered
          complete — they need to be the first thing the admin sees. */}

      {/* Section 1 — Obligatory role assignments. Rendered first so a
          missing one is immediately visible. Emerald (action) accent
          to mirror the rest of the dynamic role sections. */}
      {obligatoryRoles.map((rt) => {
        const assignments = team.roleAssignments.filter((a) => a.role.id === rt.id);
        return (
          <Section
            key={`obligatory-${rt.id}`}
            label={rt.name}
            count={assignments.length}
            accent="emerald"
            action={(
              <button
                onClick={() => setRoleAssignmentTarget(rt)}
                className="flex items-center gap-1.5 rounded-md bg-white dark:bg-slate-900 border border-amber-300 bg-amber-50 hover:border-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-800 transition-colors"
              >
                <UserPlus className="h-3.5 w-3.5" />
                Add {rt.name}
              </button>
            )}
          >
            {assignments.length === 0 ? (
              <p className="text-[12px] text-amber-700 italic">
                <strong>Required.</strong> No {rt.name.toLowerCase()} on this project yet.
                {rt.allowedPartnerKind !== 'any' && ` Allowed: ${rt.allowedPartnerKind} only.`}
                {rt.requiredPartnerRoleCode && ` Must hold role "${rt.requiredPartnerRoleCode}".`}
              </p>
            ) : (
              <div className="space-y-2">
                {assignments.map((a) => (
                  <RoleAssignmentRow
                    key={a.id}
                    assignment={a}
                    onRemove={async () => {
                      if (await confirm(`Remove ${a.party.displayName} as ${rt.name}?`)) {
                        removeRoleAssignment.mutate(a.id);
                      }
                    }}
                    onOpenProfile={setFocusedPartnerId}
                  />
                ))}
              </div>
            )}
          </Section>
        );
      })}

      {/* Section 2 — Project Team (internal employees with User accounts). */}
      <Section
        label="Project Team"
        count={team.projectTeam.length}
        accent="blue"
        action={(
          <button
            onClick={() => onToggleAddMember(true)}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 transition-colors"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add Team Member
          </button>
        )}
      >
        {team.projectTeam.length === 0 ? (
          <p className="text-[12px] text-slate-400 dark:text-slate-500 italic">No internal members yet.</p>
        ) : (
          <div className="space-y-2">
            {team.projectTeam.map((row) => {
              // Cross-reference: every ProjectRoleType assignment this
              // member holds (Architect, Engineer, etc.). Previously the
              // Project Team section showed only the person's name +
              // email — users had no quick way to see "what role does
              // Yulian play on this project?" without scrolling to each
              // role section. Now the chip list of held roles renders
              // right next to the name.
              const heldRoles = team.roleAssignments
                .filter((a) => a.party.id === row.businessPartnerId)
                .map((a) => a.role.name);
              return (
                <PersonRow
                  key={row.relationshipId}
                  row={row}
                  onRemove={() => removeMyTeam(row)}
                  accent="blue"
                  onOpenProfile={setFocusedPartnerId}
                  heldRoles={heldRoles}
                />
              );
            })}
          </div>
        )}
      </Section>

      {/* Section 3 — Customer (locked, hardcoded). */}
      <Section label="Customer" count={team.customer ? 1 : 0} accent="indigo">
        {team.customer ? (
          <OrgRow
            displayName={team.customer.displayName}
            email={team.customer.email}
            phone={team.customer.phone}
            bpId={team.customer.organizationId}
            onOpenProfile={setFocusedPartnerId}
          />
        ) : (
          <p className="text-[12px] text-amber-600 italic">No customer set on this project (data inconsistency — contact admin).</p>
        )}
      </Section>

      {/* Section 4 — Customer Contacts (org-level: anyone with an active
          rel pointing at the customer org). Shared across every project
          of this customer; not project-scoped. */}
      <Section
        label={team.customer ? `${team.customer.displayName} Contacts` : 'Customer Contacts'}
        count={team.customerContacts.length}
        accent="violet"
        action={(
          <button
            onClick={() => setShowCustomerContactPicker(true)}
            disabled={!team.customer}
            title={!team.customer ? 'No customer on project' : undefined}
            className="flex items-center gap-1.5 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add Customer Contact
          </button>
        )}
      >
        {team.customerContacts.length === 0 ? (
          <p className="text-[12px] text-slate-400 dark:text-slate-500 italic">No customer contacts yet.</p>
        ) : (
          <div className="space-y-2">
            {team.customerContacts.map((row) => (
              <PersonRow
                key={row.relationshipId}
                row={row}
                onRemove={() => softEnd.mutate(row.relationshipId)}
                accent="violet"
                onOpenProfile={setFocusedPartnerId}
              />
            ))}
          </div>
        )}
      </Section>

      {/* Sections 5+ — Other (non-required) ProjectRoleTypes. Adding a
          new project_role_type in admin makes a new section appear here
          automatically. */}
      {otherRoles.map((rt) => {
        const assignments = team.roleAssignments.filter((a) => a.role.id === rt.id);
        return (
          <Section
            key={rt.id}
            label={rt.name}
            count={assignments.length}
            accent="emerald"
            action={(
              <button
                onClick={() => setRoleAssignmentTarget(rt)}
                className="flex items-center gap-1.5 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors"
              >
                <UserPlus className="h-3.5 w-3.5" />
                Add {rt.name}
              </button>
            )}
          >
            {assignments.length === 0 ? (
              <p className="text-[12px] text-slate-400 dark:text-slate-500 italic">
                No {rt.name.toLowerCase()} on this project yet.
                {rt.allowedPartnerKind !== 'any' && ` Allowed: ${rt.allowedPartnerKind} only.`}
                {rt.requiredPartnerRoleCode && ` Must hold role "${rt.requiredPartnerRoleCode}".`}
              </p>
            ) : (
              <div className="space-y-2">
                {assignments.map((a) => (
                  <RoleAssignmentRow
                    key={a.id}
                    assignment={a}
                    onRemove={async () => {
                      if (await confirm(`Remove ${a.party.displayName} as ${rt.name}?`)) {
                        removeRoleAssignment.mutate(a.id);
                      }
                    }}
                    onOpenProfile={setFocusedPartnerId}
                  />
                ))}
              </div>
            )}
          </Section>
        );
      })}

      {/* Add Member (internal) modal — unchanged. */}
      {showAddMember && (
        <AddMemberDialog
          projectId={projectId}
          existingMemberIds={members.map((m) => m.userId)}
          onClose={() => onToggleAddMember(false)}
        />
      )}

      {/* Customer-contact add flow. */}
      {showCustomerContactPicker && team.customer && (
        <CustomerContactPicker
          customerOrgId={team.customer.organizationId}
          customerName={team.customer.displayName}
          existingContactBpIds={team.customerContacts.map((p) => p.businessPartnerId)}
          onClose={() => setShowCustomerContactPicker(false)}
        />
      )}

      {/* Project-role add flow (Supplier, Architect, …). */}
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

      {/* Profile clicks open the partner drawer overlay in-place. On close,
          invalidate project-team so any role/rel edits made in the drawer
          flow back into the team view. */}
      {focusedPartnerId != null && (
        <PartnerDrawer
          partnerId={focusedPartnerId}
          onClose={() => {
            setFocusedPartnerId(null);
            queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
          }}
        />
      )}
      </>
      )}
    </div>
  );
}
