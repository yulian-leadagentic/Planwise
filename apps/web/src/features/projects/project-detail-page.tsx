import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Pencil, MessageSquare } from 'lucide-react';
import { useState, lazy, Suspense } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ProjectDiscussion } from '@/features/messaging/project-discussion';
import { DiscussionDrawer } from '@/features/messaging/discussion-drawer';
import { ActivityFeed } from './activity-feed';
import { FilesTab } from './files-tab';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { useConfirm } from '@/components/shared/confirm-dialog';

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
import { useProject, useProjectMembers } from '@/hooks/use-projects';
import { useAuthStore } from '@/stores/auth.store';
import { usePermissions } from '@/hooks/use-permissions';
import { PresenceIndicator } from '@/components/shared/presence-indicator';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import { getInitials, formatShortDate, formatBudget } from './project-detail/utils';
import type { Tab } from './project-detail/types';
import { ProjectCloseControl } from './project-detail/project-close-control';
import { ProjectPrevNext } from './project-detail/project-prev-next';
import { ProjectInfoTab } from './project-detail/project-info-tab';
import { TeamTab } from './project-detail/team-tab';
import { ProjectStatusEditor } from './project-detail/project-status-editor';
import { ProjectCategoryEditor } from './project-detail/project-category-editor';
import { OpenInDriveButton } from '@/features/drive/open-in-drive-button';

export function ProjectDetailPage() {
  const confirm = useConfirm();
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
  const timeline = startLabel && endLabel ? `${startLabel} — ${endLabel}` : startLabel || endLabel || null;

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
              {/* Inline status editor (PR-002). Replaces the previous
                  read-only pill. Backend accepts `status` on PATCH via
                  UpdateProjectDto — see projects.controller#update. */}
              <ProjectStatusEditor projectId={projectId} status={project.status} />
              {/* Inline category (project-type) editor (PR-003). Same
                  contract — PATCH `/projects/:id` with `projectTypeId`.
                  `projectType` is eager-loaded by projects.service#findOne
                  but the shared Project type doesn't yet declare it — so
                  we structurally narrow just this one prop here. */}
              <ProjectCategoryEditor
                projectId={projectId}
                projectType={
                  (project as unknown as { projectType?: { id: number; name: string; color: string | null } | null })
                    .projectType ?? null
                }
              />
              {project.number && (
                <span className="text-[13px] text-slate-400 dark:text-slate-500 font-mono">
                  {project.number}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Open in Drive — ensures the project folder in the
                  configured Shared Drive and opens it in a new tab.
                  Toast surfaces gracefully when Drive isn't
                  configured; the header still renders the button so a
                  fresh admin discovers the integration. */}
              <OpenInDriveButton entity="project" id={projectId} size="md" />
              {/* Close / Reopen — distinct from Delete. Close marks the
                  project as "done" (keeps all data, just hides from
                  default list); Delete soft-removes it. T3.6+7. */}
              <ProjectCloseControl project={project} projectId={projectId} />
              <button
                onClick={async () => {
                  if (await confirm(`Delete project "${project.name}"? This cannot be undone.`)) {
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
