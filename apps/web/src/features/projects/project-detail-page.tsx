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
}

interface ProjectTeamSupplier {
  relationshipId: number;
  organizationId: number;
  displayName: string;
  email: string | null;
  phone: string | null;
  workers: ProjectTeamPerson[];
}

interface ProjectTeamData {
  customer: {
    relationshipId: number;
    organizationId: number;
    displayName: string;
    email: string | null;
    phone: string | null;
  } | null;
  myTeam: ProjectTeamPerson[];
  customerContacts: ProjectTeamPerson[];
  suppliers: ProjectTeamSupplier[];
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
  const [picker, setPicker] = useState<null | 'customer-contact' | 'supplier' | 'supplier-worker'>(null);
  const [pickerSupplierId, setPickerSupplierId] = useState<number | null>(null);

  const { data: team, isLoading } = useQuery<ProjectTeamData>({
    queryKey: ['project-team', projectId],
    queryFn: () => client.get(`/projects/${projectId}/team`).then((r) => r.data?.data ?? r.data),
  });

  const softEnd = useMutation({
    mutationFn: (relationshipId: number) =>
      client.delete(`/business-partner-relationships/${relationshipId}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
      notify.success('Disconnected (soft-ended)', { code: 'PROJECT-TEAM-DELETE-200' });
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

      {/* Customer */}
      <Section
        label="Customer"
        count={team.customer ? 1 : 0}
        accent="indigo"
      >
        {team.customer ? (
          <OrgRow
            displayName={team.customer.displayName}
            email={team.customer.email}
            phone={team.customer.phone}
            bpId={team.customer.organizationId}
            // The customer is locked — changing it is a separate operation.
            // No remove button.
          />
        ) : (
          <p className="text-[12px] text-amber-600 italic">No customer set on this project (data inconsistency — contact admin).</p>
        )}
      </Section>

      {/* My Team */}
      <Section
        label="My Team"
        count={team.myTeam.length}
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
        {team.myTeam.length === 0 ? (
          <p className="text-[12px] text-slate-400 italic">No internal members yet.</p>
        ) : (
          <div className="space-y-2">
            {team.myTeam.map((row) => (
              <PersonRow key={row.relationshipId} row={row} onRemove={() => removeMyTeam(row)} accent="blue" />
            ))}
          </div>
        )}
      </Section>

      {/* Customer Contacts */}
      <Section
        label={team.customer ? `${team.customer.displayName} Contacts` : 'Customer Contacts'}
        count={team.customerContacts.length}
        accent="violet"
        action={(
          <button
            onClick={() => setPicker('customer-contact')}
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
          <p className="text-[12px] text-slate-400 italic">No customer contacts on this project yet.</p>
        ) : (
          <div className="space-y-2">
            {team.customerContacts.map((row) => (
              <PersonRow key={row.relationshipId} row={row} onRemove={() => softEnd.mutate(row.relationshipId)} accent="violet" />
            ))}
          </div>
        )}
      </Section>

      {/* Suppliers */}
      <Section
        label="Suppliers"
        count={team.suppliers.length}
        accent="emerald"
        action={(
          <button
            onClick={() => setPicker('supplier')}
            className="flex items-center gap-1.5 rounded-md bg-white border border-slate-200 hover:border-slate-400 px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add Supplier
          </button>
        )}
      >
        {team.suppliers.length === 0 ? (
          <p className="text-[12px] text-slate-400 italic">No suppliers on this project yet.</p>
        ) : (
          <div className="space-y-3">
            {team.suppliers.map((sup) => (
              <div key={sup.relationshipId} className="rounded-lg border border-emerald-200 bg-emerald-50/30 p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <a href={`/partners?focus_bp=${sup.organizationId}`} className="text-sm font-semibold text-slate-900 hover:underline truncate block">
                      {sup.displayName}
                    </a>
                    {(sup.email || sup.phone) && (
                      <p className="text-[11px] text-slate-500">{sup.email}{sup.email && sup.phone ? ' · ' : ''}{sup.phone}</p>
                    )}
                  </div>
                  <button
                    onClick={() => { setPickerSupplierId(sup.organizationId); setPicker('supplier-worker'); }}
                    className="flex items-center gap-1 rounded-md bg-white border border-slate-200 hover:border-slate-400 px-2 py-1 text-[11px] font-semibold text-slate-700"
                  >
                    <UserPlus className="h-3 w-3" />
                    Add Worker
                  </button>
                  <button
                    onClick={() => { if (confirm(`Disconnect ${sup.displayName} from this project? Their workers will also need to be removed separately.`)) softEnd.mutate(sup.relationshipId); }}
                    className="rounded p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50"
                    title="End supplier on project"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {sup.workers.length > 0 ? (
                  <div className="space-y-1.5 ml-3 border-l-2 border-emerald-200 pl-3">
                    {sup.workers.map((w) => (
                      <PersonRow key={w.relationshipId} row={w} onRemove={() => softEnd.mutate(w.relationshipId)} accent="emerald" compact />
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-400 italic ml-3">No workers from this supplier on the project yet.</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Add Member (internal) modal */}
      {showAddMember && (
        <AddMemberDialog
          projectId={projectId}
          existingMemberIds={members.map((m) => m.userId)}
          onClose={() => onToggleAddMember(false)}
        />
      )}

      {/* Picker for the 3 BP-driven add flows */}
      {picker && (
        <ProjectBpPicker
          mode={picker}
          projectId={projectId}
          customerOrgId={team.customer?.organizationId ?? null}
          supplierOrgId={pickerSupplierId}
          existingBpIds={[
            ...team.myTeam.map((p) => p.businessPartnerId),
            ...team.customerContacts.map((p) => p.businessPartnerId),
            ...team.suppliers.flatMap((s) => [s.organizationId, ...s.workers.map((w) => w.businessPartnerId)]),
          ]}
          onClose={() => { setPicker(null); setPickerSupplierId(null); }}
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

function OrgRow({ displayName, email, phone, bpId }: {
  displayName: string; email: string | null; phone: string | null; bpId: number;
}) {
  return (
    <div className="rounded-lg border border-indigo-200 bg-white p-3 flex items-center gap-3">
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-indigo-700">
        <Users className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <a href={`/partners?focus_bp=${bpId}`} className="text-sm font-semibold text-slate-900 hover:underline truncate block">{displayName}</a>
        {(email || phone) && (
          <p className="text-[11px] text-slate-500">{email}{email && phone ? ' · ' : ''}{phone}</p>
        )}
      </div>
    </div>
  );
}

function PersonRow({ row, onRemove, accent, compact = false }: {
  row: ProjectTeamPerson;
  onRemove: () => void;
  accent: keyof typeof ACCENTS;
  compact?: boolean;
}) {
  const profileLink = `/partners?focus_bp=${row.businessPartnerId}`;
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
        <p className={cn('font-medium text-slate-900 truncate', compact ? 'text-[13px]' : 'text-sm')}>
          {row.displayName}
        </p>
        <p className="text-[11px] text-slate-500 truncate">
          {[row.roleInContext, row.email].filter(Boolean).join(' · ') || row.position || '—'}
        </p>
      </div>
      <a href={profileLink} className="text-[11px] text-blue-600 hover:underline shrink-0" title="Open partner profile">
        Profile →
      </a>
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

/* ─── Project BP Picker ────────────────────────────────────────────────────
   One reusable picker driving three structured add-flows on the Team tab:
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

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

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
                <label className="text-[11px] font-semibold text-slate-400 uppercase mb-1 block">Search</label>
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
                    <p className="px-3 py-3 text-[12px] text-slate-400 text-center italic">
                      {search ? 'No matches.' : (
                        config.partnerType === 'organization'
                          ? 'No suppliers available. Add one in Partners → Organizations.'
                          : (filterEmployerOrgId
                              ? 'No people Worker_of this organization. Add a contact in Partners → Contacts and set their employer.'
                              : 'Type to search.')
                      )}
                    </p>
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
