import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Settings, Plus, UserPlus, X, Pencil } from 'lucide-react';
import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlanningTab } from './planning-modal';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { useProject, useProjectMembers, useAddProjectMember, useRemoveProjectMember } from '@/hooks/use-projects';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import { formatDate } from '@/lib/date-utils';

type Tab = 'planning' | 'team';

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
    { key: 'team', label: 'Team' },
  ];

  return (
    <div className="min-h-screen bg-slate-50">
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
              <button onClick={() => navigate(`/projects/${projectId}/edit`)} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-300 hover:text-slate-600" title="Edit project">
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
        {tab === 'planning' && <PlanningTab projectId={projectId} />}
        {tab === 'team' && (
          <TeamTab
            projectId={projectId}
            members={members ?? []}
            showAddMember={showAddMember}
            onToggleAddMember={setShowAddMember}
          />
        )}
      </div>
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
  const removeMember = useRemoveProjectMember();

  const handleRemove = (memberId: number) => {
    removeMember.mutate(
      { projectId, memberId },
      {
        onError: () => notify.error('Failed to remove member'),
      },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Team Members</h2>
        <button
          onClick={() => onToggleAddMember(true)}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 transition-colors"
        >
          <UserPlus className="h-3.5 w-3.5" />
          Add Member
        </button>
      </div>

      {members.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">
          No members yet. Add team members to this project.
        </p>
      ) : (
        <div className="space-y-2">
          {members.map((member) => (
            <div
              key={member.id}
              className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-semibold text-indigo-600">
                {getInitials(member.user?.firstName ?? '', member.user?.lastName ?? '')}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-900 truncate">
                  {member.user?.firstName} {member.user?.lastName}
                </p>
                {member.role && (
                  <p className="text-xs text-slate-400">{member.role}</p>
                )}
              </div>
              <button
                onClick={() => handleRemove(member.id)}
                className="rounded p-1 text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                title="Remove member"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add Member Dialog */}
      {showAddMember && (
        <AddMemberDialog
          projectId={projectId}
          existingMemberIds={members.map((m) => m.userId)}
          onClose={() => onToggleAddMember(false)}
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
  const [search, setSearch] = useState('');

  const { data: users = [], isLoading: loadingUsers } = useQuery<User[]>({
    queryKey: ['users-active'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/users?isActive=true').then((r) => {
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

        {/* Dialog footer spacer */}
        <div className="h-3" />
      </div>
    </div>
  );
}
