import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, ChevronDown, Check, Settings, Plus, UserPlus, X, Pencil, Users, MessageSquare, Archive } from 'lucide-react';
import { useState, useMemo, useEffect, useRef, lazy, Suspense } from 'react';
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
const DeliverablePlanningTab = lazy(() => import('./deliverable-planning-tab').then(m => ({ default: m.DeliverablePlanningTab })));
const KanbanBoard = lazy(() => import('@/features/tasks/kanban-board').then(m => ({ default: m.KanbanBoard })));
// M5 — Labor cost tab. Lazy too so the project page doesn't pay for it
// on every load; most users open Planning first and never touch Cost.
const LaborCostTab = lazy(() => import('./labor-cost-tab').then(m => ({ default: m.LaborCostTab })));
// Execution Board embedded as a project tab. The page accepts a
// `forcedProjectId` prop that hides its own project selector + page
// title, so it slots cleanly inside the Project tab bar without UX
// duplication.
const ProjectExecutionBoard = lazy(() =>
  import('@/features/execution-board/execution-board-page').then((m) => ({
    default: ({ projectId }: { projectId: number }) => <m.ExecutionBoardPage forcedProjectId={projectId} />,
  })),
);
import { useProject, useProjectMembers, useAddProjectMember, useRemoveProjectMember, useCloseProject, useReopenProject, useProjects } from '@/hooks/use-projects';
import { useAuthStore } from '@/stores/auth.store';
import { usePermissions } from '@/hooks/use-permissions';
import { PresenceIndicator } from '@/components/shared/presence-indicator';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import { formatDate } from '@/lib/date-utils';

type Tab = 'info' | 'planning' | 'schedule' | 'kanban' | 'execution' | 'team' | 'cost' | 'files' | 'discussion' | 'activity';

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
  // the tab matches the policy in the UI. No admin short-circuit —
  // see NO_ADMIN_BYPASS in RolesGuard.
  const { can } = usePermissions();
  const showFinance = can('finance', 'read');

  if (isLoading) return <PageSkeleton />;
  if (!project) return <p className="py-8 text-center text-slate-400 dark:text-slate-500">Project not found</p>;

  const leader = members?.find((m) => m.role?.toLowerCase() === 'leader' || m.role?.toLowerCase() === 'project leader');
  const memberCount = members?.length ?? 0;
  const startLabel = formatShortDate(project.startDate);
  const endLabel = formatShortDate(project.endDate);
  const timeline = startLabel && endLabel ? `${startLabel} \u2014 ${endLabel}` : startLabel || endLabel || null;

  // Per-project Workload was removed in favour of the global Operations
  // dashboard (/operations), which shows workload across all projects in one
  // place. Per-project workload was redundant with the operations view.
  const tabs: { key: Tab; label: string }[] = [
    { key: 'info', label: 'Project Info' },
    { key: 'planning', label: 'Planning' },
    { key: 'schedule', label: 'Deliverable Planning' },
    { key: 'kanban', label: 'Kanban' },
    { key: 'execution', label: 'Execution' },
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
    <div className="bg-slate-50 dark:bg-slate-800/50">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
        <div className="px-5 pt-5 pb-0">
          {/* Back link + prev/next navigation between projects the user
              can see. Client feedback 2026-08-02 — avoid returning to
              the list to jump between two projects. */}
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => navigate('/projects')}
                className="flex items-center gap-1 text-[13px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Projects
              </button>
              <ProjectPrevNext currentId={projectId} />
            </div>
            {/* Live presence — shows other users currently on this project. */}
            <PresenceIndicator projectId={projectId} currentUserId={currentUserId} />
          </div>

          {/* Title row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                {project.name}
              </h1>
              <button onClick={() => navigate(`/projects/${projectId}/edit`)} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100" aria-label="Edit project">
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <span className="rounded-[5px] bg-blue-50 px-2.5 py-1 text-[11px] font-bold tracking-wide text-blue-600 uppercase">
                {project.status}
              </span>
              {project.number && (
                <span className="text-[13px] text-slate-400 dark:text-slate-500 font-mono">
                  {project.number}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Close / Reopen — distinct from Delete. Close marks the
                  project as "done" (keeps all data, just hides from
                  default list); Delete soft-removes it. T3.6+7. */}
              <ProjectCloseControl project={project} projectId={projectId} />
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
                className="bg-white dark:bg-slate-900 border border-red-200 hover:border-red-400 text-red-600 text-[13px] font-semibold px-3.5 py-2 rounded-lg hover:bg-red-50"
              >
                Delete
              </button>
            </div>
          </div>

          {/* Closed-state banner — surfaces above the meta row so it's
              the first thing a user sees when they hit a closed project
              from a link or report. Re-open is one click. */}
          {project.closedAt && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-800 flex items-center justify-between">
              <span>
                <strong>This project is CLOSED.</strong> Closed on {new Date(project.closedAt).toLocaleDateString()} — all data preserved, hidden from the default project list.
              </span>
            </div>
          )}

          {/* Meta row */}
          <div className="mt-3 mb-4 flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
            {/* Leader */}
            {leader && leader.user && (
              <>
                <div className="flex items-center gap-1.5">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-[9px] font-semibold text-indigo-600">
                    {getInitials(leader.user.firstName, leader.user.lastName)}
                  </div>
                  <span className="text-slate-700 dark:text-slate-200 text-xs font-medium">
                    {leader.user.firstName} {leader.user.lastName}
                  </span>
                  <span className="text-slate-400 dark:text-slate-500 text-xs">Leader</span>
                </div>
                <span className="text-slate-300 dark:text-slate-600">|</span>
              </>
            )}

            {/* Team count with stacked avatars */}
            <div className="flex items-center gap-1.5">
              <div className="flex -space-x-1.5">
                {(members ?? []).slice(0, 3).map((m) => (
                  <div
                    key={m.id}
                    className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 dark:bg-slate-700 text-[8px] font-semibold text-slate-600 dark:text-slate-300 ring-2 ring-white"
                  >
                    {getInitials(m.user?.firstName ?? '', m.user?.lastName ?? '')}
                  </div>
                ))}
              </div>
              <span className="text-slate-500 dark:text-slate-400 text-xs">{memberCount} members</span>
            </div>

            {/* Budget — gated by finance permission. Same gate used by the
                Cost tab and labor-cost endpoints, so non-finance users don't
                see project value anywhere. */}
            {showFinance && project.budget != null && (
              <>
                <span className="text-slate-300 dark:text-slate-600">|</span>
                <div className="flex items-center gap-1">
                  <span className="text-slate-500 dark:text-slate-400 text-xs">Budget:</span>
                  <span className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">
                    &#8362;{formatBudget(project.budget)}
                  </span>
                </div>
              </>
            )}

            {/* Timeline */}
            {timeline && (
              <>
                <span className="text-slate-300 dark:text-slate-600">|</span>
                <div className="flex items-center gap-1">
                  <span className="text-slate-500 dark:text-slate-400 text-xs">Timeline:</span>
                  <span className="text-xs text-slate-700 dark:text-slate-200">{timeline}</span>
                </div>
              </>
            )}

            {/* Authoring Tool Version — surfaced near the project name
                (Y2) so the BIM tool/version is visible at a glance
                without opening Project Info. Hidden when unset. */}
            {(project as any).authoringToolVersion && (
              <>
                <span className="text-slate-300 dark:text-slate-600">|</span>
                <div className="flex items-center gap-1">
                  <span className="text-slate-500 dark:text-slate-400 text-xs">Authoring Tool:</span>
                  <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[11px] font-semibold text-violet-700">
                    {(project as any).authoringToolVersion}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
        {/* overflow-x-auto + flex-nowrap so the 9-tab strip stays one row
            even on narrow viewports. Without this, tabs wrapped onto a
            second line and the Kanban tab (5th of 9) ended up below the
            fold — exactly U5 in the bug list ("Kanban tab not opening").
            Tab "buttons" stop shrinking via shrink-0. */}
        <div className="px-5 overflow-x-auto">
          <div className="flex gap-6 flex-nowrap">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  'border-b-2 px-1 py-2.5 text-[13px] font-semibold transition-colors shrink-0 whitespace-nowrap',
                  tab === t.key
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200',
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
        {tab === 'info' && <ProjectInfoTab projectId={projectId} project={project} />}
        {tab === 'planning' && <Suspense fallback={<div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">Loading planning...</div>}><PlanningTab projectId={projectId} /></Suspense>}
        {tab === 'schedule' && <Suspense fallback={<div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">Loading schedule...</div>}><DeliverablePlanningTab projectId={projectId} /></Suspense>}
        {tab === 'kanban' && <Suspense fallback={<div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">Loading board...</div>}><KanbanBoard projectId={projectId} /></Suspense>}
        {tab === 'execution' && <Suspense fallback={<div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">Loading execution...</div>}><ProjectExecutionBoard projectId={projectId} /></Suspense>}
        {tab === 'cost' && showFinance && <Suspense fallback={<div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">Loading labor cost...</div>}><LaborCostTab projectId={projectId} /></Suspense>}
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
  // Profession IDs the party must hold AT LEAST ONE OF. When present we
  // filter the assignment dropdown to people who satisfy this — otherwise
  // the backend rejects the POST with "must hold one of these job titles".
  requiredProfessionIds: number[] | null;
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

/**
 * Close / Reopen control in the project header. Renders one of two
 * buttons depending on whether the project is already closed —
 * confirmation prompt on close because the visibility change is
 * surprising; reopen is one-click since nothing is destructive.
 */
function ProjectCloseControl({ project, projectId }: { project: any; projectId: number }) {
  const closeMutation = useCloseProject();
  const reopenMutation = useReopenProject();
  const isClosed = !!project.closedAt;
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (isClosed) {
            reopenMutation.mutate(projectId);
          } else {
            setShowCloseConfirm(true);
          }
        }}
        disabled={closeMutation.isPending || reopenMutation.isPending}
        className={
          isClosed
            ? 'bg-white dark:bg-slate-900 border border-emerald-200 hover:border-emerald-400 text-emerald-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg hover:bg-emerald-50 disabled:opacity-50'
            : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 disabled:opacity-50'
        }
      >
        {isClosed ? 'Re-open' : 'Close project'}
      </button>

      {/* Styled close-confirm — replaces the native browser confirm()
          which doesn't match the rest of the app and rendered an ugly
          dark dialog on the user's laptop. Same shape as the other
          confirm modals (pendingZoneMove, pendingTaskDelete, etc.):
          backdrop, centered card, header with icon, body, footer with
          Cancel + primary action. (T3.6 polish, 2026-06-29.) */}
      {showCloseConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm"
          onClick={() => setShowCloseConfirm(false)}
        >
          <div
            className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[460px] max-w-[92vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
                <Archive className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Close this project?</h3>
                <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-0.5">
                  "{project.name}" will be hidden from the default project list.
                </p>
              </div>
            </div>
            <div className="px-5 py-4 text-[13px] text-slate-700 dark:text-slate-200 space-y-2">
              <p>Closing keeps all data intact — tasks, time entries, files, history all stay.</p>
              <p className="text-slate-500 dark:text-slate-400">
                You can re-open it later from this same button. Filter the project list with
                <span className="font-semibold text-slate-700 dark:text-slate-200"> Status → Closed</span> to find it.
              </p>
            </div>
            <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
              <button
                onClick={() => setShowCloseConfirm(false)}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowCloseConfirm(false);
                  closeMutation.mutate(projectId);
                }}
                disabled={closeMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50"
              >
                Close project
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
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
      </>
      )}
    </div>
  );
}

/**
 * Flat table view of every person touching the project. Aggregates:
 *   • Internal team members (Project Team section)
 *   • Customer (the org itself — single row)
 *   • Customer contacts (people working at the customer org)
 *   • Role assignments (Architect / Engineer / etc.)
 *
 * Dedupes by businessPartnerId so a person assigned to multiple
 * role-types appears once with all roles listed in one cell.
 */
function TeamTableView({ team }: { team: ProjectTeamData }) {
  // Build a single deduped row list keyed by businessPartnerId.
  const rows = (() => {
    const byId = new Map<number, {
      bpId: number;
      displayName: string;
      email: string | null;
      phone: string | null;
      kinds: Set<string>;
      roles: Set<string>;
    }>();

    const upsert = (
      bpId: number,
      data: { displayName: string; email: string | null; phone: string | null },
      kind: string,
      role?: string,
    ) => {
      const existing = byId.get(bpId);
      if (existing) {
        existing.kinds.add(kind);
        if (role) existing.roles.add(role);
        return;
      }
      byId.set(bpId, {
        bpId,
        displayName: data.displayName,
        email: data.email,
        phone: data.phone,
        kinds: new Set([kind]),
        roles: new Set(role ? [role] : []),
      });
    };

    for (const m of team.projectTeam) {
      upsert(m.businessPartnerId, m, 'Project Team', m.roleInContext ?? undefined);
    }
    if (team.customer) {
      upsert(
        team.customer.organizationId,
        { displayName: team.customer.displayName, email: team.customer.email, phone: team.customer.phone },
        'Customer',
      );
    }
    for (const c of team.customerContacts) {
      upsert(c.businessPartnerId, c, 'Customer Contact', c.relationshipTypeName);
    }
    for (const a of team.roleAssignments) {
      upsert(
        a.party.id,
        { displayName: a.party.displayName, email: a.party.email ?? null, phone: a.party.phone ?? null },
        a.role.name,
        a.role.name,
      );
    }

    return Array.from(byId.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  })();

  // V6 — per-column sort + filter on the Team table. Sort cycles
  // none→asc→desc on header click; filter is a small input under each
  // header that does substring match (case-insensitive). Both live in
  // local component state — the dataset is small enough that
  // sort/filter happen client-side every render.
  type ColKey = 'name' | 'role' | 'kind' | 'email' | 'phone';
  const [sort, setSort] = useState<{ key: ColKey; dir: 'asc' | 'desc' } | null>(null);
  const [filters, setFilters] = useState<Record<ColKey, string>>({
    name: '', role: '', kind: '', email: '', phone: '',
  });
  const toggleSort = (key: ColKey) => {
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: 'asc' };
      if (s.dir === 'asc') return { key, dir: 'desc' };
      return null; // 3rd click clears
    });
  };
  const valueFor = (r: typeof rows[0], key: ColKey): string => {
    if (key === 'name') return r.displayName;
    if (key === 'role') return Array.from(r.roles).join(', ');
    if (key === 'kind') return Array.from(r.kinds).join(', ');
    if (key === 'email') return r.email ?? '';
    if (key === 'phone') return r.phone ?? '';
    return '';
  };
  const filtered = rows.filter((r) =>
    (Object.keys(filters) as ColKey[]).every((k) => {
      const f = filters[k].trim().toLowerCase();
      if (!f) return true;
      return valueFor(r, k).toLowerCase().includes(f);
    }),
  );
  const sorted = sort
    ? [...filtered].sort((a, b) => {
        const av = valueFor(a, sort.key).toLowerCase();
        const bv = valueFor(b, sort.key).toLowerCase();
        return sort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      })
    : filtered;

  if (rows.length === 0) {
    return <p className="py-12 text-center text-sm text-slate-400 dark:text-slate-500 italic">No people on this project yet.</p>;
  }

  const SortHeader = ({ k, label }: { k: ColKey; label: string }) => (
    <button
      type="button"
      onClick={() => toggleSort(k)}
      className="flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-100 cursor-pointer"
    >
      <span>{label}</span>
      <span className="text-slate-300 dark:text-slate-600 text-[9px] tabular-nums">
        {sort?.key === k ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
      </span>
    </button>
  );

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      <table className="w-full text-[13px]">
        <thead className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase text-slate-500 dark:text-slate-400 tracking-wider">
          <tr>
            <th className="px-4 py-2 text-left"><SortHeader k="name" label="Name" /></th>
            <th className="px-4 py-2 text-left"><SortHeader k="role" label="Role / Position" /></th>
            <th className="px-4 py-2 text-left"><SortHeader k="kind" label="Kind" /></th>
            <th className="px-4 py-2 text-left"><SortHeader k="email" label="Email" /></th>
            <th className="px-4 py-2 text-left"><SortHeader k="phone" label="Phone" /></th>
          </tr>
          {/* Filter input row — substring match against the cell's
              flattened text. Empty = pass-through. */}
          <tr className="bg-white dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800">
            {(['name', 'role', 'kind', 'email', 'phone'] as ColKey[]).map((k) => (
              <th key={k} className="px-3 py-1.5">
                <input
                  value={filters[k]}
                  onChange={(e) => setFilters((f) => ({ ...f, [k]: e.target.value }))}
                  placeholder="Filter…"
                  className="w-full rounded border border-slate-200 dark:border-slate-700 px-1.5 py-1 text-[11px] focus:border-blue-400 focus:outline-none"
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {sorted.length === 0 ? (
            <tr><td colSpan={5} className="px-4 py-8 text-center text-[12px] text-slate-400 dark:text-slate-500 italic">No rows match the active filters.</td></tr>
          ) : sorted.map((r) => (
            <tr key={r.bpId} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
              <td className="px-4 py-2 font-medium text-slate-800 dark:text-slate-100 truncate max-w-[200px]" title={r.displayName}>
                {r.displayName}
              </td>
              <td className="px-4 py-2 text-slate-600 dark:text-slate-300 truncate max-w-[220px]" title={Array.from(r.roles).join(', ')}>
                {r.roles.size > 0 ? Array.from(r.roles).join(', ') : <span className="text-slate-300 dark:text-slate-600">—</span>}
              </td>
              <td className="px-4 py-2">
                <div className="flex flex-wrap gap-1">
                  {Array.from(r.kinds).map((k) => (
                    <span key={k} className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:text-slate-300">
                      {k}
                    </span>
                  ))}
                </div>
              </td>
              <td className="px-4 py-2 text-slate-600 dark:text-slate-300 truncate max-w-[220px]" title={r.email ?? ''}>
                {r.email ? (
                  <a href={`mailto:${r.email}`} className="text-blue-600 hover:underline">{r.email}</a>
                ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
              </td>
              <td className="px-4 py-2 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                {r.phone ?? <span className="text-slate-300 dark:text-slate-600">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
        <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-2">
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
    <div className="rounded-lg border border-indigo-200 bg-white dark:bg-slate-900 p-3 flex items-center gap-3">
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-indigo-700">
        <Users className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <button
          type="button"
          onClick={() => onOpenProfile?.(bpId)}
          className="text-sm font-semibold text-slate-900 dark:text-slate-100 hover:underline truncate text-left w-full"
          title="Open partner profile"
        >
          {displayName}
        </button>
        {(email || phone) && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{email}{email && phone ? ' · ' : ''}{phone}</p>
        )}
      </div>
    </div>
  );
}

function PersonRow({ row, onRemove, accent, compact = false, onOpenProfile, heldRoles }: {
  row: ProjectTeamPerson;
  onRemove: () => void;
  accent: keyof typeof ACCENTS;
  compact?: boolean;
  onOpenProfile?: (bpId: number) => void;
  /** ProjectRoleType names this person holds on the project (Architect,
   *  Engineer, etc.). Rendered as small chips next to the name so users
   *  see at a glance what role each team member plays. Optional —
   *  Customer Contacts and other non-team rows don't pass this. */
  heldRoles?: string[];
}) {
  return (
    <div className={cn(
      'flex items-center gap-3 rounded-lg border bg-white dark:bg-slate-900',
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
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => onOpenProfile?.(row.businessPartnerId)}
            className={cn('font-medium text-slate-900 dark:text-slate-100 hover:underline truncate text-left', compact ? 'text-[13px]' : 'text-sm')}
            title="Open partner profile"
          >
            {row.displayName}
          </button>
          {heldRoles && heldRoles.length > 0 && (
            <div className="flex flex-wrap gap-1 shrink-0">
              {heldRoles.map((r) => (
                <span
                  key={r}
                  className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700"
                  title={`Project role: ${r}`}
                >
                  {r}
                </span>
              ))}
            </div>
          )}
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
          {[row.roleInContext, row.email].filter(Boolean).join(' · ') || row.position || '—'}
        </p>
      </div>
      <button
        onClick={onRemove}
        className="rounded p-1.5 text-slate-400 dark:text-slate-500 hover:text-red-600 hover:bg-red-50"
        title="End relationship"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// Shared input class used by the M4a pickers.
const inputClass = 'w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none';

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
    <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-white dark:bg-slate-900 p-3">
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
            className="text-sm font-semibold text-slate-900 dark:text-slate-100 hover:underline truncate text-left"
            title="Open partner profile"
          >
            {p.displayName}
          </button>
          <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">({p.partnerType})</span>
          {assignment.isPrimary && (
            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">PRIMARY</span>
          )}
        </div>
        {assignment.titleInProject && <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{assignment.titleInProject}</p>}
        {(p.email || p.phone) && (
          <p className="text-[11px] text-slate-400 dark:text-slate-500 truncate">{p.email}{p.email && p.phone ? ' · ' : ''}{p.phone}</p>
        )}
      </div>
      <button
        onClick={onRemove}
        className="rounded p-1.5 text-slate-400 dark:text-slate-500 hover:text-red-600 hover:bg-red-50"
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
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[440px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Add Contact at {customerName}</h3>
          <button onClick={onClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          {!relType && (
            <p className="text-[12px] text-amber-700 bg-amber-50 px-2 py-1.5 rounded">
              No suitable relationship type found. Configure <code>contact_of_customer</code> or <code>worker_of</code> in admin first.
            </p>
          )}
          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Person</label>
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
              <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">No people available. All are already contacts, or no persons exist yet.</p>
            )}
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Title at customer (optional)</label>
            <input
              value={titleAtCustomer}
              onChange={(e) => setTitleAtCustomer(e.target.value)}
              placeholder='e.g. "CFO", "Operations Manager"'
              className={inputClass}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button onClick={onClose} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[12px] font-semibold px-3 py-1.5 rounded-lg">Cancel</button>
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
  // Filter out already-assigned parties AND, when the role requires one
  // of a set of professions (Job Titles), parties who don't hold any of
  // them. Without this second pass, the dropdown happily offered names
  // that the backend would later reject with a 400 — see the user-facing
  // "must hold one of these job titles" error.
  const requiredProfIds: number[] = Array.isArray(role.requiredProfessionIds)
    ? role.requiredProfessionIds
    : [];
  const filtered = candidates.filter((p: any) => {
    if (existingPartyIds.includes(p.id)) return false;
    if (requiredProfIds.length === 0) return true;
    const partyProfIds: number[] = Array.isArray(p.professions)
      ? p.professions.map((x: any) => x.professionId)
      : [];
    return partyProfIds.some((id) => requiredProfIds.includes(id));
  });

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
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[440px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
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
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">{role.name}</label>
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
                {role.requiredPartnerRoleCode ? ` with role "${role.requiredPartnerRoleCode}"` : ''}
                {requiredProfIds.length > 0 ? ' who holds a required job title (see /partners → Job Titles)' : ''}
                {' '}in /partners first.
              </p>
            )}
          </div>
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
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[560px] max-w-[92vw] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">{config.title}</h2>
          <button onClick={onClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-[12px] text-slate-500 dark:text-slate-400">{config.blurb}</p>

          {blockedReason ? (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-[12px] text-amber-700">
              {blockedReason}
            </div>
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase">Search</label>
                  {/* Inline-create path. Only shown when the picker is scoped
                      to a specific employer org (customer-contact /
                      supplier-worker). Skips the trip to Partners → Contacts
                      and pre-pins the customer/supplier as the employer. */}
                  {filterEmployerOrgId && (
                    <button
                      type="button"
                      onClick={() => setCreateForOrgId(filterEmployerOrgId)}
                      className="flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 hover:border-blue-400 hover:text-blue-600 text-slate-600 dark:text-slate-300 text-[11px] font-semibold px-2 py-0.5"
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
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm focus:border-blue-500 focus:outline-none"
                  autoFocus
                />
                <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
                  {filtered.length === 0 ? (
                    <div className="px-3 py-3 text-[12px] text-slate-400 dark:text-slate-500 text-center italic">
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
                        'w-full text-left px-3 py-2 text-sm border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-blue-50',
                        selectedBpId === bp.id && 'bg-blue-50',
                      )}
                    >
                      <p className="font-medium text-slate-800 dark:text-slate-100">{bp.displayName}</p>
                      {bp.email && <p className="text-[11px] text-slate-400 dark:text-slate-500">{bp.email}</p>}
                    </button>
                  ))}
                </div>
              </div>

              {config.showRoleInContext && (
                <div>
                  <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Role on this project (optional)</label>
                  <input
                    type="text"
                    value={roleInContext}
                    onChange={(e) => setRoleInContext(e.target.value)}
                    placeholder='e.g. "Client Operations Manager", "BIM Manager", "Site Lead"'
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              )}
            </>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button onClick={onClose} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[12px] font-semibold px-3 py-1.5 rounded-lg">Cancel</button>
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
      // perPage=1000 — load every active user so the client-side search
      // can hit anyone in the company. Default page size is 20, which
      // silently dropped employees past row 20 (Alex Isakov was missing
      // from the Add Team Member picker on staging, 2026-06-21).
      client.get('/users?isActive=true&perPage=1000').then((r) => {
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
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 shadow-2xl">
        {/* Dialog header */}
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 px-5 py-4">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Add Team Member</h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
           aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200 dark:border-slate-700 px-5">
          <button
            onClick={() => setTab('individual')}
            className={cn(
              'border-b-2 px-1 py-2 text-xs font-semibold transition-colors mr-4',
              tab === 'individual'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200',
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
                : 'border-transparent text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200',
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
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
                autoFocus
              />
            </div>

            {/* User list */}
            <div className="max-h-64 overflow-y-auto px-5 py-3">
              {loadingUsers ? (
                <p className="py-4 text-center text-xs text-slate-400 dark:text-slate-500">Loading...</p>
              ) : filteredUsers.length === 0 ? (
                <p className="py-4 text-center text-xs text-slate-400 dark:text-slate-500">
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
                        className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                      >
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-[9px] font-semibold text-indigo-600">
                          {getInitials(user.firstName ?? '', user.lastName ?? '')}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{fullName}</p>
                          {email && <p className="text-xs text-slate-400 dark:text-slate-500 truncate">{email}</p>}
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
              <p className="py-4 text-center text-xs text-slate-400 dark:text-slate-500">Loading templates...</p>
            ) : teamTemplates.length === 0 ? (
              <p className="py-4 text-center text-xs text-slate-400 dark:text-slate-500">
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
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-left hover:border-blue-400 hover:bg-blue-50/40 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t.name}</p>
                          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
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
                                    className="inline-flex items-center gap-1 rounded-md bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-600 dark:text-slate-300"
                                  >
                                    {name}
                                  </span>
                                );
                              })}
                              {members.length > 6 && (
                                <span className="text-[11px] text-slate-400 dark:text-slate-500">+{members.length - 6} more</span>
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

/**
 * Project Info tab — a single-page summary + edit surface for the
 * "soft" metadata that doesn't justify its own data model yet:
 * authoring tool version, weekly meeting day, file system / hub link,
 * and a free-text summary of contracted services. Plus read-only tables
 * for files (delegated to FilesTab) and contacts (delegated to
 * TeamTableView).
 *
 * Edits use PATCH /projects/:id on blur (no save button — the form
 * autocommits on focus loss, same UX as the Description field on the
 * Edit Employee modal).
 */
function ProjectInfoTab({ projectId, project }: { projectId: number; project: any }) {
  const queryClient = useQueryClient();
  const { data: team } = useQuery<ProjectTeamData>({
    queryKey: ['project-team', projectId],
    queryFn: () => client.get(`/projects/${projectId}/team`).then((r) => r.data?.data ?? r.data),
  });

  const save = useMutation({
    mutationFn: (patch: Record<string, any>) =>
      client.patch(`/projects/${projectId}`, patch).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to save'),
  });

  // Local state mirrors the project record so users can edit without
  // round-tripping on every keystroke. Commits on blur.
  const [form, setForm] = useState({
    authoringToolVersion: project?.authoringToolVersion ?? '',
    weeklyMeetingDay: project?.weeklyMeetingDay ?? '',
    servicesPerContract: project?.servicesPerContract ?? '',
  });

  // If the project payload refreshes (e.g. after a save) refresh the
  // local form so external edits land in our UI too.
  useEffect(() => {
    setForm({
      authoringToolVersion: project?.authoringToolVersion ?? '',
      weeklyMeetingDay: project?.weeklyMeetingDay ?? '',
      servicesPerContract: project?.servicesPerContract ?? '',
    });
  }, [project?.id, project?.authoringToolVersion, project?.weeklyMeetingDay, project?.servicesPerContract]);

  const commitField = (field: keyof typeof form) => {
    const cur = (project?.[field] ?? '') as string;
    const next = form[field];
    if (cur === next) return; // no-op
    save.mutate({ [field]: next || null });
  };

  const inputCls = 'w-full rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none';

  return (
    <div className="space-y-6">
      {/* Quick-facts block — 4 free-text fields side by side on wide
          screens, stacked on narrow. Each commits on blur. */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Project Info</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1.5 block">Weekly Meeting Day</label>
            <input
              type="text"
              value={form.weeklyMeetingDay}
              placeholder='e.g. "Tuesdays at 10:00"'
              onChange={(e) => setForm((f) => ({ ...f, weeklyMeetingDay: e.target.value }))}
              onBlur={() => commitField('weeklyMeetingDay')}
              className={inputCls}
            />
          </div>
          <div>
            <label className="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1.5 block">Authoring Tool Version</label>
            <input
              type="text"
              value={form.authoringToolVersion}
              placeholder='e.g. "Revit 2024.2"'
              onChange={(e) => setForm((f) => ({ ...f, authoringToolVersion: e.target.value }))}
              onBlur={() => commitField('authoringToolVersion')}
              className={inputCls}
            />
          </div>
          <div className="md:col-span-2">
            <label className="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1.5 block">Services Per Contract</label>
            <textarea
              value={form.servicesPerContract}
              placeholder="What we deliver to this customer per the contract — free text."
              rows={4}
              onChange={(e) => setForm((f) => ({ ...f, servicesPerContract: e.target.value }))}
              onBlur={() => commitField('servicesPerContract')}
              className={cn(inputCls, 'resize-none')}
            />
          </div>
        </div>
        <p className="text-[11px] text-slate-400 dark:text-slate-500">Changes save automatically when you leave a field.</p>
      </div>

      {/* Contacts table — reuses TeamTableView for consistency with the
          Team tab's table view. */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Contacts &amp; Project Team</h3>
        {team ? <TeamTableView team={team} /> : <p className="py-6 text-center text-[12px] text-slate-400 dark:text-slate-500">Loading team…</p>}
      </div>

      {/* Files — reuses the existing FilesTab. Same drop-zone, same
          permission story; just a different framing on the page. */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Files</h3>
        <FilesTab projectId={projectId} />
      </div>
    </div>
  );
}

/**
 * Prev / Next controls between the projects the current user can see.
 * The list comes from the same /projects endpoint that powers the
 * Projects list, so access-controlled filtering is applied server-side
 * — no accidental navigation into projects the user isn't a member of.
 * (Client feedback 2026-08-02.)
 */
/**
 * Project picker — searchable dropdown of every project the user can
 * see. Replaces the old Prev/Next arrow pair per client feedback
 * (2026-08-02 item 1). Type to filter, click to navigate. Shows the
 * current project as the trigger label; the popover flags it with a
 * checkmark so users know where they are in the list.
 */
function ProjectPrevNext({ currentId }: { currentId: number }) {
  const navigate = useNavigate();
  const { data } = useProjects({ perPage: 500 });
  const list: any[] = Array.isArray(data?.data) ? data.data : [];
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
    else setSearch('');
  }, [open]);

  if (list.length <= 1) return null;

  const current = list.find((p) => p.id === currentId);
  const filtered = search.trim()
    ? list.filter((p) => {
        const q = search.trim().toLowerCase();
        return (
          (p.name ?? '').toLowerCase().includes(q) ||
          (p.number ?? '').toLowerCase().includes(q)
        );
      })
    : list;

  return (
    <div ref={wrapRef} className="relative ml-2 pl-2 border-l border-slate-200 dark:border-slate-700">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        dir="ltr"
        className="flex items-center gap-2 rounded-lg px-2.5 py-1 text-[12px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 min-w-[220px] max-w-[320px]"
        title="Switch project"
      >
        {/* Name in its own slot so a Hebrew name doesn't collide with
            the LTR project number. `dir="ltr"` on the outer button
            keeps the CHEVRON and NUMBER on the right regardless of
            the surrounding page direction; the name still renders
            RTL if its own characters demand it. */}
        <span className="truncate text-left flex-1">{current?.name ?? 'Select project'}</span>
        {current?.number && (
          <span className="shrink-0 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-mono text-[10px] px-1.5 py-0.5">
            {current.number}
          </span>
        )}
        <ChevronDown className={cn('h-3.5 w-3.5 text-slate-400 dark:text-slate-500 transition-transform shrink-0', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-2 top-full mt-1 z-40 w-[320px] rounded-xl bg-white dark:bg-slate-900 shadow-[0_12px_40px_rgba(0,0,0,0.12)] border border-black/5">
          <div className="p-2 border-b border-slate-100 dark:border-slate-800">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects…"
              className="w-full px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="max-h-80 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-[11px] text-slate-400 dark:text-slate-500 italic">No projects match</div>
            ) : (
              filtered.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate(`/projects/${p.id}`);
                  }}
                  dir="ltr"
                  className={cn(
                    'w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 hover:bg-slate-50 dark:hover:bg-slate-800/50',
                    p.id === currentId && 'bg-blue-50/60',
                  )}
                >
                  <span className={cn('flex-1 min-w-0 truncate', p.id === currentId ? 'font-semibold text-blue-700' : 'text-slate-700 dark:text-slate-200')}>
                    {p.name}
                  </span>
                  {p.number && (
                    <span className="shrink-0 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-mono text-[10px] px-1.5 py-0.5">
                      {p.number}
                    </span>
                  )}
                  {p.id === currentId && <Check className="h-3.5 w-3.5 text-blue-600 shrink-0" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
