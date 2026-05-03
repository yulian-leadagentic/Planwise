import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Settings, Plus, UserPlus, X, Pencil, Users, MessageSquare } from 'lucide-react';
import { useState, useMemo, useEffect, lazy, Suspense } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ProjectDiscussion } from '@/features/messaging/project-discussion';
import { DiscussionDrawer } from '@/features/messaging/discussion-drawer';
import { WorkloadPanel } from './workload-panel';
import { ActivityFeed } from './activity-feed';
import { FilesTab } from './files-tab';
import { PageSkeleton } from '@/components/shared/loading-skeleton';

// Lazy-load DnD-heavy components
const PlanningTab = lazy(() => import('./planning-modal').then(m => ({ default: m.PlanningTab })));
const KanbanBoard = lazy(() => import('@/features/tasks/kanban-board').then(m => ({ default: m.KanbanBoard })));
import { useProject, useProjectMembers, useAddProjectMember, useRemoveProjectMember } from '@/hooks/use-projects';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import { formatDate } from '@/lib/date-utils';

type Tab = 'planning' | 'kanban' | 'workload' | 'team' | 'files' | 'discussion' | 'activity';

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

  if (isLoading) return <PageSkeleton />;
  if (!project) return <p className="py-8 text-center text-slate-400">Project not found</p>;

  const leader = members?.find((m) => m.role?.toLowerCase() === 'leader' || m.role?.toLowerCase() === 'project leader');
  const memberCount = members?.length ?? 0;
  const startLabel = formatShortDate(project.startDate);
  const endLabel = formatShortDate(project.endDate);
  const timeline = startLabel && endLabel ? `${startLabel} \u2014 ${endLabel}` : startLabel || endLabel || null;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'planning', label: 'Planning' },
    { key: 'kanban', label: 'Kanban' },
    { key: 'workload', label: 'Workload' },
    { key: 'team', label: 'Team' },
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
          <button
            onClick={() => navigate('/projects')}
            className="mb-3 flex items-center gap-1 text-[13px] text-slate-400 hover:text-slate-600 transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Projects
          </button>

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
        {tab === 'workload' && <WorkloadPanel projectId={projectId} />}
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

interface UnifiedTeamRow {
  kind: 'internal' | 'external';
  id: number;
  userId: number | null;
  businessPartnerId: number | null;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  position: string | null;
  role: string | null;
  relationshipType: { id: number; code: string; name: string } | null;
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
  const [showAddPartner, setShowAddPartner] = useState(false);

  // Unified team — internal (login users) + external (BP relationships).
  const { data: team = [], isLoading } = useQuery<UnifiedTeamRow[]>({
    queryKey: ['project-team', projectId],
    queryFn: () => client.get(`/projects/${projectId}/team`).then((r) => r.data?.data ?? r.data ?? []),
  });

  const removeExternal = useMutation({
    mutationFn: (relationshipId: number) =>
      client.delete(`/business-partner-relationships/${relationshipId}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
      notify.success('Partner removed from project', { code: 'PROJECT-TEAM-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove partner'),
  });

  const handleRemove = (row: UnifiedTeamRow) => {
    if (row.kind === 'internal') {
      // ProjectMember.id passed via the legacy member shape
      removeMember.mutate(
        { projectId, memberId: row.id },
        {
          onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project-team', projectId] }),
          onError: () => notify.error('Failed to remove member'),
        },
      );
    } else {
      if (confirm('Remove this external partner from the project?')) {
        removeExternal.mutate(row.id);
      }
    }
  };

  const internal = team.filter((t) => t.kind === 'internal');
  const external = team.filter((t) => t.kind === 'external');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Team</h2>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Internal members (have logins) + external partners (clients, consultants, supplier reps). Manage profiles in <a href="/partners" className="text-blue-600 hover:underline">Partners</a>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddPartner(true)}
            className="flex items-center gap-1.5 rounded-md bg-white border border-slate-200 hover:border-slate-400 px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add Partner
          </button>
          <button
            onClick={() => onToggleAddMember(true)}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 transition-colors"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add Member
          </button>
        </div>
      </div>

      {isLoading ? (
        <p className="py-8 text-center text-sm text-slate-400">Loading...</p>
      ) : team.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">
          No team yet. Add internal members or external partners.
        </p>
      ) : (
        <div className="space-y-4">
          {/* Internal */}
          {internal.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-slate-400 uppercase mb-1.5">Internal Members ({internal.length})</p>
              <div className="space-y-2">
                {internal.map((row) => (
                  <TeamRow key={`int-${row.id}`} row={row} onRemove={() => handleRemove(row)} />
                ))}
              </div>
            </div>
          )}

          {/* External */}
          {external.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-slate-400 uppercase mb-1.5">External Partners ({external.length})</p>
              <div className="space-y-2">
                {external.map((row) => (
                  <TeamRow key={`ext-${row.id}`} row={row} onRemove={() => handleRemove(row)} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {showAddMember && (
        <AddMemberDialog
          projectId={projectId}
          existingMemberIds={members.map((m) => m.userId)}
          onClose={() => onToggleAddMember(false)}
        />
      )}

      {showAddPartner && (
        <AddProjectPartnerDialog
          projectId={projectId}
          existingBpIds={team.map((t) => t.businessPartnerId).filter((x): x is number => x != null)}
          onClose={() => setShowAddPartner(false)}
        />
      )}
    </div>
  );
}

/* ─── Team Row ─────────────────────────────────────────────────────────────── */

function TeamRow({ row, onRemove }: { row: UnifiedTeamRow; onRemove: () => void }) {
  const isExternal = row.kind === 'external';
  const profileLink = row.businessPartnerId
    ? `/partners?focus_bp=${row.businessPartnerId}`
    : (row.userId ? `/partners?focus=${row.userId}` : null);

  return (
    <div className={cn(
      'flex items-center gap-3 rounded-lg border bg-white p-3',
      isExternal ? 'border-violet-200' : 'border-slate-200',
    )}>
      <div className={cn(
        'flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-semibold shrink-0',
        isExternal ? 'bg-violet-100 text-violet-600' : 'bg-indigo-100 text-indigo-600',
      )}>
        {getInitials(row.firstName ?? '', row.lastName ?? '') || row.displayName.slice(0, 2).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-slate-900 truncate">{row.displayName}</p>
          {isExternal && row.relationshipType && (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-700">
              {row.relationshipType.name}
            </span>
          )}
        </div>
        {row.role && <p className="text-xs text-slate-500">{row.role}</p>}
        {row.email && <p className="text-[11px] text-slate-400">{row.email}</p>}
      </div>
      {profileLink && (
        <a href={profileLink} className="text-[11px] text-blue-600 hover:underline shrink-0" title="Open partner profile">
          Profile →
        </a>
      )}
      <button
        onClick={onRemove}
        className="rounded p-1.5 text-slate-500 hover:text-red-600 hover:bg-red-50 transition-colors"
        aria-label="Remove from team"
        title={isExternal ? 'Remove partner' : 'Remove member'}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/* ─── Add External Partner Dialog ──────────────────────────────────────────── */

function AddProjectPartnerDialog({
  projectId,
  existingBpIds,
  onClose,
}: {
  projectId: number;
  existingBpIds: number[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedBpId, setSelectedBpId] = useState<number | null>(null);
  const [relationshipTypeId, setRelationshipTypeId] = useState<number | null>(null);
  const [roleInContext, setRoleInContext] = useState('');

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  // BP picker — search persons + organizations across all of /business-partners
  const { data: bps = [] } = useQuery<any[]>({
    queryKey: ['bp-picker', search],
    queryFn: () =>
      client
        .get('/business-partners', { params: { search: search || undefined, perPage: 50 } })
        .then((r) => {
          const d = r.data?.data ?? r.data;
          return Array.isArray(d) ? d : (d?.data ?? []);
        }),
  });

  const filtered = bps.filter((bp: any) => !existingBpIds.includes(bp.id));

  // Relationship types applicable to projects (excluding project_member which is for login users only).
  const { data: allRelTypes = [] } = useQuery<any[]>({
    queryKey: ['partner-relationship-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/partner-types/relationship-types').then((r) => r.data?.data ?? r.data ?? []),
  });
  const relTypes = allRelTypes.filter((rt) => {
    if (rt.code === 'project_member') return false;
    const apply = rt.applicableTargetTypes?.split(',').map((s: string) => s.trim()) ?? [];
    return apply.length === 0 || apply.includes('project');
  });

  const create = useMutation({
    mutationFn: () =>
      client.post('/business-partner-relationships', {
        sourcePartnerId: selectedBpId,
        targetType: 'project',
        targetId: projectId,
        relationshipTypeId,
        roleInContext: roleInContext.trim() || undefined,
      }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
      notify.success('Partner added to project', { code: 'PROJECT-TEAM-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add partner'),
  });

  const handleSubmit = () => {
    if (!selectedBpId || !relationshipTypeId) {
      notify.warning('Pick a partner and a relationship type', { code: 'PROJECT-TEAM-400' });
      return;
    }
    create.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[560px] max-w-[92vw] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="text-base font-bold text-slate-900">Add External Partner</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-[12px] text-slate-500">
            Link an existing Business Partner — typically a contact at a customer or supplier — to this project. Won't create a login account.
            Need someone who isn't in the system? <a href="/partners?tab=contacts" className="text-blue-600 hover:underline">Add them in Partners → Contacts</a> first.
          </p>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Search Business Partner</label>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, email, company..."
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white">
              {filtered.length === 0 ? (
                <p className="px-3 py-3 text-[12px] text-slate-400 text-center italic">
                  {search ? 'No matches' : 'Start typing to search...'}
                </p>
              ) : filtered.slice(0, 30).map((bp: any) => (
                <button
                  key={bp.id}
                  type="button"
                  onClick={() => setSelectedBpId(bp.id)}
                  className={cn(
                    'w-full text-left px-3 py-2 text-sm border-b border-slate-100 last:border-0 hover:bg-blue-50',
                    selectedBpId === bp.id && 'bg-blue-50',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      'rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase',
                      bp.partnerType === 'person' ? 'bg-blue-100 text-blue-700' : 'bg-violet-100 text-violet-700',
                    )}>
                      {bp.partnerType === 'person' ? 'Person' : 'Org'}
                    </span>
                    <span className="font-medium text-slate-800">{bp.displayName}</span>
                    {bp.companyName && bp.partnerType === 'person' && (
                      <span className="text-[11px] text-slate-400">at {bp.companyName}</span>
                    )}
                  </div>
                  {bp.email && <p className="text-[11px] text-slate-400 ml-12">{bp.email}</p>}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Relationship Type *</label>
            <select
              value={relationshipTypeId ?? ''}
              onChange={(e) => setRelationshipTypeId(Number(e.target.value) || null)}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="">Select...</option>
              {relTypes.map((rt: any) => <option key={rt.id} value={rt.id}>{rt.name}</option>)}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Role in Context (optional)</label>
            <input
              type="text"
              value={roleInContext}
              onChange={(e) => setRoleInContext(e.target.value)}
              placeholder='e.g. "Client Operations Manager"'
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[12px] font-semibold px-3 py-1.5 rounded-lg">Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={create.isPending || !selectedBpId || !relationshipTypeId}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
            >
              {create.isPending ? 'Adding...' : 'Add to Team'}
            </button>
          </div>
        </div>
      </div>
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
