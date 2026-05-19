import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Settings, Plus, UserPlus, X, Pencil, Users, MessageSquare } from 'lucide-react';
import { useState, useMemo, useEffect, lazy, Suspense } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ProjectDiscussion } from '@/features/messaging/project-discussion';
import { DiscussionDrawer } from '@/features/messaging/discussion-drawer';
import { ActivityFeed } from './activity-feed';
import { FilesTab } from './files-tab';
import { CreateContactModal } from '@/features/partners/create-contact-modal';
import { PartnerDrawer } from '@/features/partners/partner-drawer';
import { PageSkeleton } from '@/components/shared/loading-skeleton';

// Lazy-load DnD-heavy components
const PlanningTab = lazy(() => import('./planning-modal').then(m => ({ default: m.PlanningTab })));
const KanbanBoard = lazy(() => import('@/features/tasks/kanban-board').then(m => ({ default: m.KanbanBoard })));
// M5 — Labor cost tab. Lazy too so the project page doesn't pay for it
// on every load; most users open Planning first and never touch Cost.
const LaborCostTab = lazy(() => import('./labor-cost-tab').then(m => ({ default: m.LaborCostTab })));
import { useProject, useProjectMembers, useAddProjectMember, useRemoveProjectMember } from '@/hooks/use-projects';
import { useAuthStore } from '@/stores/auth.store';
import { usePermissions } from '@/hooks/use-permissions';
import { PresenceIndicator } from '@/components/shared/presence-indicator';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import { formatDate } from '@/lib/date-utils';

type Tab = 'planning' | 'kanban' | 'team' | 'cost' | 'files' | 'discussion' | 'activity';

interface User {
  id: number;
  firstName: string;
  lastName: string;
  email?: string;
  avatarUrl?: string | null;
  position?: string | null;
}

function getInitials(firstName: string, lastName: string) {
  return `${firstName?.[0] ?? ''}${lastName?.[0] ?? ''}`.toUpperCase();
}

function formatShortDate(dateStr: string | null) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function formatBudget(amount: number) {
  return new Intl.NumberFormat('he-IL', {
    style: 'decimal',
    maximumFractionDigits: 0,
  }).format(amount);
}

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectId = Number(id);
  const [tab, setTab] = useState<Tab>('planning');
  const [showAddMember, setShowAddMember] = useState(false);
  const [showDiscussionDrawer, setShowDiscussionDrawer] = useState(false);

  const { data: project, isLoading } = useProject(projectId);
  const { data: members } = useProjectMembers(projectId);
  const currentUserId = useAuthStore((s) => s.user?.id);
  // Finance permission — gates the Cost tab visibility. Backend
  // already returns 403 on the labor-cost endpoint without it; hiding
  // the tab matches the policy in the UI.
  const { can, isAdmin } = usePermissions();
  const showFinance = isAdmin || can('finance', 'read');

  if (isLoading) return <PageSkeleton />;
  if (!project) return <p className="py-8 text-center text-slate-400">Project not found</p>;

  const leader = members?.find((m) => m.role?.toLowerCase() === 'leader' || m.role?.toLowerCase() === 'project leader');
  const memberCount = members?.length ?? 0;
  const startLabel = formatShortDate(project.startDate);
  const endLabel = formatShortDate(project.endDate);
  const timeline = startLabel && endLabel ? `${startLabel} \u2014 ${endLabel}` : startLabel || endLabel || null;

  // Per-project Workload was removed in favour of the global Operations
  // dashboard (/operations), which shows workload across all projects in one
  // place. Per-project workload was redundant with the operations view.
  const tabs: { key: Tab; label: string }[] = [
    { key: 'planning', label: 'Planning' },
    { key: 'kanban', label: 'Kanban' },
    { key: 'team', label: 'Team' },
    // Cost tab is gated by the Finance module permission. Backend
    // /projects/:id/labor-cost returns 403 to non-finance users — the
    // tab disappears from the UI so the user can't even try.
    ...(showFinance ? [{ key: 'cost' as const, label: 'Cost' }] : []),
    { key: 'files', label: 'Files' },
    { key: 'discussion', label: 'Discussion' },
    { key: 'activity', label: 'Activity' },
  ];

  return (
    <div className="bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200">
        <div className="px-5 pt-5 pb-0">
          {/* Back link */}
          <div className="mb-3 flex items-center justify-between gap-3">
            <button
              onClick={() => navigate('/projects')}
              className="flex items-center gap-1 text-[13px] text-slate-400 hover:text-slate-600 transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Projects
            </button>
            {/* Live presence — shows other users currently on this project. */}
            <PresenceIndicator projectId={projectId} currentUserId={currentUserId} />
          </div>

          {/* Title row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold tracking-tight text-slate-900">
                {project.name}
              </h1>
              <button onClick={() => navigate(`/projects/${projectId}/edit`)} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-500 hover:text-slate-700" aria-label="Edit project">
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <span className="rounded-[5px] bg-blue-50 px-2.5 py-1 text-[11px] font-bold tracking-wide text-blue-600 uppercase">
                {project.status}
              </span>
              {project.number && (
                <span className="text-[13px] text-slate-400 font-mono">
                  {project.number}
                </span>
              )}
            </div>
            <button
              onClick={() => {
                if (confirm(`Delete project "${project.name}"? This cannot be undone.`)) {
                  client.delete(`/projects/${projectId}`).then(() => {
                    queryClient.invalidateQueries({ queryKey: ['projects'] });
                    notify.success('Project deleted', { code: 'PROJECT-DELETE-200' });
                    navigate('/projects');
                  }).catch((err: any) => notify.apiError(err, 'Failed to delete project'));
                }
              }}
              className="bg-white border border-red-200 hover:border-red-400 text-red-600 text-[13px] font-semibold px-3.5 py-2 rounded-lg hover:bg-red-50"
            >
              Delete
            </button>
          </div>

          {/* Meta row */}
          <div className="mt-3 mb-4 flex items-center gap-3 text-xs text-slate-500">
            {/* Leader */}
            {leader && leader.user && (
              <>
                <div className="flex items-center gap-1.5">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-[9px] font-semibold text-indigo-600">
                    {getInitials(leader.user.firstName, leader.user.lastName)}
                  </div>
                  <span className="text-slate-700 text-xs font-medium">
                    {leader.user.firstName} {leader.user.lastName}
                  </span>
                  <span className="text-slate-400 text-xs">Leader</span>
                </div>
                <span className="text-slate-300">|</span>
              </>
            )}

            {/* Team count with stacked avatars */}
            <div className="flex items-center gap-1.5">
              <div className="flex -space-x-1.5">
                {(members ?? []).slice(0, 3).map((m) => (
                  <div
                    key={m.id}
                    className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-[8px] font-semibold text-slate-600 ring-2 ring-white"
                  >
                    {getInitials(m.user?.firstName ?? '', m.user?.lastName ?? '')}
                  </div>
                ))}
              </div>
              <span className="text-slate-500 text-xs">{memberCount} members</span>
            </div>

            {/* Budget */}
            {project.budget != null && (
              <>
                <span className="text-slate-300">|</span>
                <div className="flex items-center gap-1">
                  <span className="text-slate-500 text-xs">Budget:</span>
                  <span className="font-mono text-xs font-semibold text-slate-900">
                    &#8362;{formatBudget(project.budget)}
                  </span>
                </div>
              </>
            )}

            {/* Timeline */}
            {timeline && (
              <>
                <span className="text-slate-300">|</span>
                <div className="flex items-center gap-1">
                  <span className="text-slate-500 text-xs">Timeline:</span>
                  <span className="text-xs text-slate-700">{timeline}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="bg-white border-b border-slate-200">
        <div className="px-5">
          <div className="flex gap-6">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  'border-b-2 px-1 py-2.5 text-[13px] font-semibold transition-colors',
                  tab === t.key
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-slate-400 hover:text-slate-600',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab content */}
      <div className="px-5 py-6">
        {tab === 'planning' && <Suspense fallback={<div className="py-12 text-center text-sm text-slate-400">Loading planning...</div>}><PlanningTab projectId={projectId} /></Suspense>}
        {tab === 'kanban' && <Suspense fallback={<div className="py-12 text-center text-sm text-slate-400">Loading board...</div>}><KanbanBoard projectId={projectId} /></Suspense>}
        {tab === 'cost' && showFinance && <Suspense fallback={<div className="py-12 text-center text-sm text-slate-400">Loading labor cost...</div>}><LaborCostTab projectId={projectId} /></Suspense>}
        {tab === 'files' && <FilesTab projectId={projectId} />}
        {tab === 'activity' && <ActivityFeed projectId={projectId} />}
        {tab === 'discussion' && (
          <ProjectDiscussion projectId={projectId} />
        )}
        {tab === 'team' && (
          <TeamTab
            projectId={projectId}
            members={members ?? []}
            showAddMember={showAddMember}
            onToggleAddMember={setShowAddMember}
          />
        )}
      </div>

      {/* Floating Discussion Button (visible on all tabs except Discussion) */}
      {tab !== 'discussion' && (
        <button
          onClick={() => setShowDiscussionDrawer(true)}
          className="fixed bottom-6 right-6 z-30 flex items-center gap-2 rounded-full bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-lg hover:bg-blue-700 transition-colors"
        >
          <MessageSquare className="h-4 w-4" />
          Discussion
        </button>
      )}

      {/* Discussion Drawer */}
      <DiscussionDrawer
        open={showDiscussionDrawer}
        onClose={() => setShowDiscussionDrawer(false)}
        entityType="project"
        entityId={projectId}
        title={project.name}
      />
    </div>
  );
}

/* ─── Team Tab ──────────────────────────────────────────────────────────────── */

interface ProjectMember {
  id: number;
  projectId: number;
  userId: number;
  role: string | null;
  user?: {
    id: number;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
  };
  createdAt: string;
}

interface ProjectTeamPerson {
  relationshipId: number;
  businessPartnerId: number;
  userId: number | null;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  position: string | null;
  roleInContext: string | null;
  // Customer contacts may carry which rel-type wired them to the customer.
  relationshipTypeCode?: string;
  relationshipTypeName?: string;
}

interface ProjectRoleTypeRow {
  id: number;
  code: string;
  name: string;
  description: string | null;
  allowedPartnerKind: 'person' | 'organization' | 'any';
  requiredPartnerRoleCode: string | null;
  isPrimaryRequired: boolean;
  sortOrder: number;
  isSystem: boolean;
}

interface ProjectRoleAssignment {
  id: number;
  role: ProjectRoleTypeRow;
  party: {
    id: number;
    partnerType: 'person' | 'organization';
    displayName: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  };
  isPrimary: boolean;
  titleInProject: string | null;
  validFrom: string | null;
  validTo: string | null;
  status: string;
}

interface ProjectTeamData {
  customer: {
    relationshipId: number;
    organizationId: number;
    displayName: string;
    email: string | null;
    phone: string | null;
  } | null;
  customerContacts: ProjectTeamPerson[];
  projectTeam: ProjectTeamPerson[];
  roleAssignments: ProjectRoleAssignment[];
}

function TeamTab({
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
    mutationFn: (relationshipId: number) =>
      client.delete(`/business-partner-relationships/${relationshipId}`).then((r) => r.data),
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
    if (row.userId) {
      // Find legacy ProjectMember.id for this user (members from props)
      const m = members.find((mm) => mm.userId === row.userId);
      if (m) {
        removeMember.mutate(
          { projectId, memberId: m.id },
          {
            onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project-team', projectId] }),
            onError: () => notify.error('Failed to remove member'),
          },
        );
        return;
      }
    }
    // Fallback: soft-end the relationship directly.
    softEnd.mutate(row.relationshipId);
  };

  if (isLoading || !team) {
    return <p className="py-8 text-center text-sm text-slate-400">Loading team...</p>;
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-700">Project Team</h2>
        <p className="text-[11px] text-slate-400 mt-0.5">
          Connections between this project and your business partners. Disconnects are <strong>soft-ended</strong> (history preserved).
        </p>
      </div>

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
                className="flex items-center gap-1.5 rounded-md bg-white border border-amber-300 bg-amber-50 hover:border-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-800 transition-colors"
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
                    onRemove={() => {
                      if (confirm(`Remove ${a.party.displayName} as ${rt.name}?`)) {
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
          <p className="text-[12px] text-slate-400 italic">No internal members yet.</p>
        ) : (
          <div className="space-y-2">
            {team.projectTeam.map((row) => (
              <PersonRow key={row.relationshipId} row={row} onRemove={() => removeMyTeam(row)} accent="blue" onOpenProfile={setFocusedPartnerId} />
            ))}
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
            className="flex items-center gap-1.5 rounded-md bg-white border border-slate-200 hover:border-slate-400 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add Customer Contact
          </button>
        )}
      >
        {team.customerContacts.length === 0 ? (
          <p className="text-[12px] text-slate-400 italic">No customer contacts yet.</p>
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
                className="flex items-center gap-1.5 rounded-md bg-white border border-slate-200 hover:border-slate-400 px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors"
              >
                <UserPlus className="h-3.5 w-3.5" />
                Add {rt.name}
              </button>
            )}
          >
            {assignments.length === 0 ? (
              <p className="text-[12px] text-slate-400 italic">
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
                    onRemove={() => {
                      if (confirm(`Remove ${a.party.displayName} as ${rt.name}?`)) {
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
    </div>
  );
}

/* ─── Section + small subcomponents ───────────────────────────────────────── */

const ACCENTS = {
  indigo:  { border: 'border-indigo-200',  badge: 'bg-indigo-100 text-indigo-700' },
  blue:    { border: 'border-blue-200',    badge: 'bg-blue-100 text-blue-700' },
  violet:  { border: 'border-violet-200',  badge: 'bg-violet-100 text-violet-700' },
  emerald: { border: 'border-emerald-200', badge: 'bg-emerald-100 text-emerald-700' },
} as const;

function Section({
  label, count, accent, action, children,
}: {
  label: string;
  count: number;
  accent: keyof typeof ACCENTS;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2">
          {label}
          <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold', ACCENTS[accent].badge)}>{count}</span>
        </p>
        {action}
      </div>
      {children}
    </div>
  );
}

function OrgRow({ displayName, email, phone, bpId, onOpenProfile }: {
  displayName: string; email: string | null; phone: string | null; bpId: number;
  onOpenProfile?: (bpId: number) => void;
}) {
  return (
    <div className="rounded-lg border border-indigo-200 bg-white p-3 flex items-center gap-3">
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-indigo-700">
        <Users className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <button
          type="button"
          onClick={() => onOpenProfile?.(bpId)}
          className="text-sm font-semibold text-slate-900 hover:underline truncate text-left w-full"
          title="Open partner profile"
        >
          {displayName}
        </button>
        {(email || phone) && (
          <p className="text-[11px] text-slate-500">{email}{email && phone ? ' · ' : ''}{phone}</p>
        )}
      </div>
    </div>
  );
}

function PersonRow({ row, onRemove, accent, compact = false, onOpenProfile }: {
  row: ProjectTeamPerson;
  onRemove: () => void;
  accent: keyof typeof ACCENTS;
  compact?: boolean;
  onOpenProfile?: (bpId: number) => void;
}) {
  return (
    <div className={cn(
      'flex items-center gap-3 rounded-lg border bg-white',
      ACCENTS[accent].border,
      compact ? 'p-2' : 'p-3',
    )}>
      <div className={cn(
        'flex items-center justify-center rounded-full text-[10px] font-semibold shrink-0',
        ACCENTS[accent].badge,
        compact ? 'h-7 w-7' : 'h-8 w-8',
      )}>
        {getInitials(row.firstName ?? '', row.lastName ?? '') || row.displayName.slice(0, 2).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <button
          type="button"
          onClick={() => onOpenProfile?.(row.businessPartnerId)}
          className={cn('font-medium text-slate-900 hover:underline truncate text-left block w-full', compact ? 'text-[13px]' : 'text-sm')}
          title="Open partner profile"
        >
          {row.displayName}
        </button>
        <p className="text-[11px] text-slate-500 truncate">
          {[row.roleInContext, row.email].filter(Boolean).join(' · ') || row.position || '—'}
        </p>
      </div>
      <button
        onClick={onRemove}
        className="rounded p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50"
        title="End relationship"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// Shared input class used by the M4a pickers.
const inputClass = 'w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none';

/* ─── Role Assignment Row ─────────────────────────────────────────────────── */

function RoleAssignmentRow({
  assignment,
  onRemove,
  onOpenProfile,
}: {
  assignment: ProjectRoleAssignment;
  onRemove: () => void;
  onOpenProfile?: (bpId: number) => void;
}) {
  const p = assignment.party;
  const initials = getInitials(p.firstName ?? '', p.lastName ?? '') || p.displayName.slice(0, 2).toUpperCase();
  return (
    <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-white p-3">
      <div className={cn(
        'flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-semibold shrink-0',
        p.partnerType === 'organization' ? 'bg-emerald-100 text-emerald-700' : 'bg-violet-100 text-violet-700',
      )}>
        {p.partnerType === 'organization' ? <Users className="h-4 w-4" /> : initials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => onOpenProfile?.(p.id)}
            className="text-sm font-semibold text-slate-900 hover:underline truncate text-left"
            title="Open partner profile"
          >
            {p.displayName}
          </button>
          <span className="text-[10px] text-slate-400 font-mono">({p.partnerType})</span>
          {assignment.isPrimary && (
            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">PRIMARY</span>
          )}
        </div>
        {assignment.titleInProject && <p className="text-[11px] text-slate-500 truncate">{assignment.titleInProject}</p>}
        {(p.email || p.phone) && (
          <p className="text-[11px] text-slate-400 truncate">{p.email}{p.email && p.phone ? ' · ' : ''}{p.phone}</p>
        )}
      </div>
      <button
        onClick={onRemove}
        className="rounded p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50"
        title="End assignment"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/* ─── Customer Contact Picker ───────────────────────────────────────────────
   Adds a person → customer-org relationship. Uses 'contact_of_customer'
   rel type if it exists, falling back to 'worker_of'. The created row
   surfaces on every project of this customer. */

function CustomerContactPicker({
  customerOrgId,
  customerName,
  existingContactBpIds,
  onClose,
}: {
  customerOrgId: number;
  customerName: string;
  existingContactBpIds: number[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedPersonId, setSelectedPersonId] = useState<number | null>(null);
  const [titleAtCustomer, setTitleAtCustomer] = useState('');

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  const { data: persons = [] } = useQuery<any[]>({
    queryKey: ['bp-persons-for-customer-contact', customerOrgId],
    queryFn: () => client.get('/business-partners', {
      params: { partnerType: 'person', perPage: 500 },
    }).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });
  const filtered = persons.filter((p: any) => !existingContactBpIds.includes(p.id));

  const { data: relTypes = [] } = useQuery<any[]>({
    queryKey: ['partner-relationship-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/partner-types/relationship-types').then((r) => r.data?.data ?? r.data ?? []),
  });
  // Prefer a dedicated contact_of_customer type; else any person→org rel; else worker_of.
  const relType = relTypes.find((rt: any) => rt.code === 'contact_of_customer')
    ?? relTypes.find((rt: any) => rt.code === 'worker_of');

  const create = useMutation({
    mutationFn: () => {
      if (!selectedPersonId || !relType) {
        throw new Error('Missing person or relationship type');
      }
      return client.post('/business-partner-relationships', {
        sourcePartnerId: selectedPersonId,
        targetType: 'organization',
        targetId: customerOrgId,
        relationshipTypeId: relType.id,
        roleInContext: titleAtCustomer.trim() || undefined,
      }).then((r) => r.data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team'] });
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      notify.success('Contact added', { code: 'CUSTOMER-CONTACT-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add contact'),
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[440px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-900">Add Contact at {customerName}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          {!relType && (
            <p className="text-[12px] text-amber-700 bg-amber-50 px-2 py-1.5 rounded">
              No suitable relationship type found. Configure <code>contact_of_customer</code> or <code>worker_of</code> in admin first.
            </p>
          )}
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Person</label>
            <select
              value={selectedPersonId ?? ''}
              onChange={(e) => setSelectedPersonId(Number(e.target.value) || null)}
              className={inputClass}
            >
              <option value="">Select a person...</option>
              {filtered.map((p: any) => (
                <option key={p.id} value={p.id}>{p.displayName}{p.email ? ` — ${p.email}` : ''}</option>
              ))}
            </select>
            {filtered.length === 0 && (
              <p className="text-[10px] text-slate-400 mt-1">No people available. All are already contacts, or no persons exist yet.</p>
            )}
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Title at customer (optional)</label>
            <input
              value={titleAtCustomer}
              onChange={(e) => setTitleAtCustomer(e.target.value)}
              placeholder='e.g. "CFO", "Operations Manager"'
              className={inputClass}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[12px] font-semibold px-3 py-1.5 rounded-lg">Cancel</button>
            <button
              onClick={() => create.mutate()}
              disabled={create.isPending || !selectedPersonId || !relType}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
            >
              {create.isPending ? 'Adding...' : 'Add Contact'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Role Assignment Picker ────────────────────────────────────────────────
   Generic picker for any ProjectRoleType (Supplier, Architect, Engineer, …).
   Filters candidates by the role's allowedPartnerKind + requiredPartnerRoleCode.
   Creates a project_partner_role row. */

function RoleAssignmentPicker({
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

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  const { data: candidates = [] } = useQuery<any[]>({
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
  const filtered = candidates.filter((p: any) => !existingPartyIds.includes(p.id));

  const create = useMutation({
    mutationFn: () =>
      client.post('/project-partner-roles', {
        projectId,
        partyId: selectedPartyId,
        roleId: role.id,
        isPrimary,
        titleInProject: titleInProject.trim() || undefined,
      }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
      notify.success(`Added ${role.name}`, { code: 'PPR-ADD-201' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, `Failed to add ${role.name}`),
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[440px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-900">Add {role.name}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
            Eligible: <span className="font-mono font-semibold">{role.allowedPartnerKind}</span>
            {role.requiredPartnerRoleCode && (
              <> · must hold role <span className="font-mono font-semibold">{role.requiredPartnerRoleCode}</span></>
            )}
            {role.isPrimaryRequired && <> · one PRIMARY required</>}
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">{role.name}</label>
            <select
              value={selectedPartyId ?? ''}
              onChange={(e) => setSelectedPartyId(Number(e.target.value) || null)}
              className={inputClass}
            >
              <option value="">Select...</option>
              {filtered.map((p: any) => (
                <option key={p.id} value={p.id}>{p.displayName}</option>
              ))}
            </select>
            {filtered.length === 0 && (
              <p className="text-[12px] text-amber-700 bg-amber-50 px-2 py-1.5 rounded mt-1">
                No eligible parties. Add a {role.allowedPartnerKind}
                {role.requiredPartnerRoleCode ? ` with role "${role.requiredPartnerRoleCode}"` : ''} in /partners first.
              </p>
            )}
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Title / role-in-context (optional)</label>
            <input
              value={titleInProject}
              onChange={(e) => setTitleInProject(e.target.value)}
              placeholder={`e.g. "Lead ${role.name}"`}
              className={inputClass}
            />
          </div>
          {role.isPrimaryRequired && (
            <label className="flex items-center gap-2 text-sm text-slate-700 pt-1">
              <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-blue-600" />
              Mark as primary {role.name}
            </label>
          )}
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[12px] font-semibold px-3 py-1.5 rounded-lg">Cancel</button>
            <button
              onClick={() => create.mutate()}
              disabled={create.isPending || !selectedPartyId}
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

/* ─── Project BP Picker ────────────────────────────────────────────────────
   Legacy picker — still used by the Add Team Member dialog elsewhere. Kept
   for now; will be removed when M7 drops legacy surfaces.
     - 'customer-contact'  → adds a worker_of-the-customer to the project
                              (creates participates_in_project)
     - 'supplier'          → adds a supplier organization to the project
                              (creates supplier_of_project)
     - 'supplier-worker'   → adds a worker_of-this-supplier to the project
                              (creates participates_in_project)
   Validation rules in the backend prevent mismatches; the picker pre-filters
   client-side so users only see candidates that the rules would accept.
*/

type PickerMode = 'customer-contact' | 'supplier' | 'supplier-worker';

function ProjectBpPicker({
  mode,
  projectId,
  customerOrgId,
  supplierOrgId,
  existingBpIds,
  onClose,
}: {
  mode: PickerMode;
  projectId: number;
  customerOrgId: number | null;
  supplierOrgId: number | null;
  existingBpIds: number[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedBpId, setSelectedBpId] = useState<number | null>(null);
  const [roleInContext, setRoleInContext] = useState('');
  // When set, we surface the CreateContactModal pinned to a specific
  // employer org so users can add a brand-new contact without leaving
  // this picker. Currently only used for the customer-contact mode and
  // supplier-worker mode.
  const [createForOrgId, setCreateForOrgId] = useState<number | null>(null);

  const config = {
    'customer-contact': {
      title: 'Add Customer Contact',
      blurb: 'Pick a person who works at the customer organization. Only people whose Worker_of points to the customer of this project are listed.',
      partnerType: 'person' as const,
      relationshipCode: 'participates_in_project',
      filterEmployerOrgId: customerOrgId,
      showRoleInContext: true,
    },
    'supplier': {
      title: 'Add Supplier to Project',
      blurb: 'Pick an organization with the "supplier" role to add as a supplier on this project.',
      partnerType: 'organization' as const,
      relationshipCode: 'supplier_of_project',
      filterRoleCode: 'supplier',
      showRoleInContext: false,
    },
    'supplier-worker': {
      title: 'Add Supplier Worker',
      blurb: 'Pick a person who works at this supplier. Only Workers_of this supplier are listed.',
      partnerType: 'person' as const,
      relationshipCode: 'participates_in_project',
      filterEmployerOrgId: supplierOrgId,
      showRoleInContext: true,
    },
  }[mode];

  // Search the BP space with the right type filter.
  const { data: bps = [] } = useQuery<any[]>({
    queryKey: ['bp-picker', mode, search, customerOrgId, supplierOrgId],
    queryFn: () => client.get('/business-partners', {
      params: {
        partnerType: config.partnerType,
        roleType: (config as any).filterRoleCode,
        search: search || undefined,
        perPage: 100,
      },
    }).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });

  // Fetch worker_of relationships for the candidates so we can filter
  // persons to those actually employed by the right org.
  const filterEmployerOrgId = (config as any).filterEmployerOrgId as number | null | undefined;
  const filtered = bps.filter((bp: any) => {
    if (existingBpIds.includes(bp.id)) return false;
    if (config.partnerType === 'person' && filterEmployerOrgId) {
      const employers = (bp.outgoingRelationships ?? [])
        .filter((r: any) =>
          r.relationshipType?.code === 'worker_of' &&
          r.targetType === 'organization' &&
          (!r.validTo || new Date(r.validTo) > new Date()),
        )
        .map((r: any) => r.targetId);
      return employers.includes(filterEmployerOrgId);
    }
    return true;
  });

  // Resolve the relationship type id by code at submit time.
  const { data: allRelTypes = [] } = useQuery<any[]>({
    queryKey: ['partner-relationship-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/partner-types/relationship-types').then((r) => r.data?.data ?? r.data ?? []),
  });
  const relType = allRelTypes.find((rt: any) => rt.code === config.relationshipCode);

  const create = useMutation({
    mutationFn: () =>
      client.post('/business-partner-relationships', {
        sourcePartnerId: selectedBpId,
        targetType: 'project',
        targetId: projectId,
        relationshipTypeId: relType?.id,
        roleInContext: roleInContext.trim() || undefined,
      }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
      notify.success('Added to project', { code: 'PROJECT-TEAM-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add'),
  });

  const handleSubmit = () => {
    if (!selectedBpId || !relType) {
      notify.warning('Pick a candidate first', { code: 'PROJECT-TEAM-400' });
      return;
    }
    create.mutate();
  };

  const blockedReason =
    mode === 'customer-contact' && !customerOrgId
      ? 'No customer is set on this project — set the customer first.'
      : mode === 'supplier-worker' && !supplierOrgId
      ? 'Pick a supplier from the project first, then add its workers.'
      : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[560px] max-w-[92vw] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="text-base font-bold text-slate-900">{config.title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-[12px] text-slate-500">{config.blurb}</p>

          {blockedReason ? (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-[12px] text-amber-700">
              {blockedReason}
            </div>
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-semibold text-slate-400 uppercase">Search</label>
                  {/* Inline-create path. Only shown when the picker is scoped
                      to a specific employer org (customer-contact /
                      supplier-worker). Skips the trip to Partners → Contacts
                      and pre-pins the customer/supplier as the employer. */}
                  {filterEmployerOrgId && (
                    <button
                      type="button"
                      onClick={() => setCreateForOrgId(filterEmployerOrgId)}
                      className="flex items-center gap-1 rounded-md border border-slate-200 hover:border-blue-400 hover:text-blue-600 text-slate-600 text-[11px] font-semibold px-2 py-0.5"
                    >
                      <Plus className="h-3 w-3" /> New contact
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={config.partnerType === 'organization' ? 'Company name, email...' : 'Name, email...'}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none"
                  autoFocus
                />
                <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-white">
                  {filtered.length === 0 ? (
                    <div className="px-3 py-3 text-[12px] text-slate-400 text-center italic">
                      {search ? 'No matches.' : (
                        config.partnerType === 'organization'
                          ? 'No suppliers available. Add one in Partners → Organizations.'
                          : (filterEmployerOrgId
                              ? 'No people work for this organization yet — click "New contact" above to add one.'
                              : 'Type to search.')
                      )}
                    </div>
                  ) : filtered.slice(0, 50).map((bp: any) => (
                    <button
                      key={bp.id}
                      type="button"
                      onClick={() => setSelectedBpId(bp.id)}
                      className={cn(
                        'w-full text-left px-3 py-2 text-sm border-b border-slate-100 last:border-0 hover:bg-blue-50',
                        selectedBpId === bp.id && 'bg-blue-50',
                      )}
                    >
                      <p className="font-medium text-slate-800">{bp.displayName}</p>
                      {bp.email && <p className="text-[11px] text-slate-400">{bp.email}</p>}
                    </button>
                  ))}
                </div>
              </div>

              {config.showRoleInContext && (
                <div>
                  <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Role on this project (optional)</label>
                  <input
                    type="text"
                    value={roleInContext}
                    onChange={(e) => setRoleInContext(e.target.value)}
                    placeholder='e.g. "Client Operations Manager", "BIM Manager", "Site Lead"'
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              )}
            </>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[12px] font-semibold px-3 py-1.5 rounded-lg">Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={create.isPending || !selectedBpId || !!blockedReason}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
            >
              {create.isPending ? 'Adding...' : 'Add to Project'}
            </button>
          </div>
        </div>
      </div>

      {/* In-line "create new contact pinned to this customer/supplier" modal.
          When the user finishes creating, we invalidate the BP query and
          auto-select the new BP so they can hit "Add to Project" in one go. */}
      {createForOrgId != null && (
        <CreateContactModal
          preselectEmployerOrgId={createForOrgId}
          lockEmployer    /* this flow is 'create a contact FOR this customer/supplier' */
          onClose={() => setCreateForOrgId(null)}
          onCreated={(newBpId) => {
            setCreateForOrgId(null);
            setSelectedBpId(newBpId);
            queryClient.invalidateQueries({ queryKey: ['bp-picker'] });
          }}
        />
      )}
    </div>
  );
}

/* ─── Add Member Dialog ─────────────────────────────────────────────────────── */

function AddMemberDialog({
  projectId,
  existingMemberIds,
  onClose,
}: {
  projectId: number;
  existingMemberIds: number[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'individual' | 'template'>('individual');
  const [search, setSearch] = useState('');
  const [applying, setApplying] = useState(false);
  const queryClient = useQueryClient();

  const { data: users = [], isLoading: loadingUsers } = useQuery<User[]>({
    queryKey: ['users-active'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/users?isActive=true').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const { data: teamTemplates = [], isLoading: loadingTemplates } = useQuery<any[]>({
    queryKey: ['team-templates'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/config/team-templates').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const addMember = useAddProjectMember();

  const filteredUsers = useMemo(() => {
    const q = search.toLowerCase().trim();
    return users.filter((u) => {
      if (existingMemberIds.includes(u.id)) return false;
      if (!q) return true;
      const full = `${u.firstName ?? ''} ${u.lastName ?? ''}`.toLowerCase();
      return full.includes(q);
    });
  }, [users, search, existingMemberIds]);

  const handleAdd = (user: User) => {
    addMember.mutate(
      { projectId, userId: user.id },
      {
        onSuccess: () => {
          onClose();
        },
      },
    );
  };

  const handleApplyTemplate = async (template: any) => {
    const templateMemberIds: number[] = (template.members || [])
      .map((m: any) => m.userId ?? m.user?.id)
      .filter((id: any): id is number => typeof id === 'number')
      .filter((id: number) => !existingMemberIds.includes(id));

    if (templateMemberIds.length === 0) {
      notify.info('All members from this template are already on the project');
      return;
    }

    // Bypass the useAddProjectMember hook so we don't fire one toast per member.
    // Add all members in parallel via direct API calls, then show a single notification.
    setApplying(true);
    const results = await Promise.allSettled(
      templateMemberIds.map((userId) =>
        client.post(`/projects/${projectId}/members`, { userId }),
      ),
    );
    const added = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - added;

    // Refresh the members list
    queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'members'] });
    setApplying(false);

    if (added > 0 && failed === 0) {
      notify.success(
        `Added ${added} member${added !== 1 ? 's' : ''} from "${template.name}"`,
        { code: 'TEAM-APPLY-200' },
      );
    } else if (added > 0 && failed > 0) {
      notify.warning(
        `Added ${added}, ${failed} failed from "${template.name}"`,
        { code: 'TEAM-APPLY-207' },
      );
    } else {
      notify.error(`Could not add members from "${template.name}"`, {
        code: 'TEAM-APPLY-500',
      });
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl">
        {/* Dialog header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h3 className="text-sm font-bold text-slate-900">Add Team Member</h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200 px-5">
          <button
            onClick={() => setTab('individual')}
            className={cn(
              'border-b-2 px-1 py-2 text-xs font-semibold transition-colors mr-4',
              tab === 'individual'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-400 hover:text-slate-600',
            )}
          >
            Individual
          </button>
          <button
            onClick={() => setTab('template')}
            className={cn(
              'border-b-2 px-1 py-2 text-xs font-semibold transition-colors flex items-center gap-1',
              tab === 'template'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-400 hover:text-slate-600',
            )}
          >
            <Users className="h-3 w-3" />
            From Team Template
          </button>
        </div>

        {tab === 'individual' ? (
          <>
            {/* Search */}
            <div className="px-5 pt-4">
              <input
                type="text"
                placeholder="Search employees..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
                autoFocus
              />
            </div>

            {/* User list */}
            <div className="max-h-64 overflow-y-auto px-5 py-3">
              {loadingUsers ? (
                <p className="py-4 text-center text-xs text-slate-400">Loading...</p>
              ) : filteredUsers.length === 0 ? (
                <p className="py-4 text-center text-xs text-slate-400">
                  {search ? 'No matching employees' : 'No available employees'}
                </p>
              ) : (
                <div className="space-y-1">
                  {filteredUsers.map((user) => {
                    const fullName = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || 'Unknown';
                    const email = typeof user.email === 'string' ? user.email : '';
                    return (
                      <div
                        key={user.id}
                        className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50"
                      >
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-[9px] font-semibold text-indigo-600">
                          {getInitials(user.firstName ?? '', user.lastName ?? '')}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-800 truncate">{fullName}</p>
                          {email && <p className="text-xs text-slate-400 truncate">{email}</p>}
                        </div>
                        <button
                          onClick={() => handleAdd(user)}
                          disabled={addMember.isPending}
                          className="rounded-md bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-100 transition-colors disabled:opacity-50"
                        >
                          Add
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="max-h-80 overflow-y-auto px-5 py-4">
            {loadingTemplates ? (
              <p className="py-4 text-center text-xs text-slate-400">Loading templates...</p>
            ) : teamTemplates.length === 0 ? (
              <p className="py-4 text-center text-xs text-slate-400">
                No team templates available. Create one in Templates → Team Templates.
              </p>
            ) : (
              <div className="space-y-2">
                {teamTemplates.map((t) => {
                  const members = Array.isArray(t.members) ? t.members : [];
                  const availableCount = members
                    .map((m: any) => m.userId ?? m.user?.id)
                    .filter((id: any) => typeof id === 'number' && !existingMemberIds.includes(id))
                    .length;
                  const totalCount = members.length;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => handleApplyTemplate(t)}
                      disabled={applying || availableCount === 0}
                      className="w-full rounded-lg border border-slate-200 bg-white p-3 text-left hover:border-blue-400 hover:bg-blue-50/40 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-slate-900">{t.name}</p>
                          <p className="mt-0.5 text-xs text-slate-500">
                            {availableCount} of {totalCount} member{totalCount !== 1 ? 's' : ''} available
                          </p>
                          {members.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {members.slice(0, 6).map((m: any) => {
                                const u = m.user ?? {};
                                const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || 'Unknown';
                                return (
                                  <span
                                    key={m.id}
                                    className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600"
                                  >
                                    {name}
                                  </span>
                                );
                              })}
                              {members.length > 6 && (
                                <span className="text-[11px] text-slate-400">+{members.length - 6} more</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Dialog footer spacer */}
        <div className="h-3" />
      </div>
    </div>
  );
}
