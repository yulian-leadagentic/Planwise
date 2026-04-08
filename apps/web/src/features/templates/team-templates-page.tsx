import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft, Trash2, Users, Search } from 'lucide-react';
import client from '@/api/client';
import { notify } from '@/lib/notify';

// ── Types ──────────────────────────────────────────────────────────────────────

interface UserInfo {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  avatarUrl?: string | null;
  userType?: string | null;
  position?: string | null;
}

interface TemplateMember {
  id: number;
  userId: number;
  role: string | null;
  user: UserInfo;
}

interface TeamTemplate {
  id: number;
  name: string;
  createdAt: string;
  creator?: { id: number; firstName: string; lastName: string } | null;
  members: TemplateMember[];
  _count: { members: number };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function userInitials(u: { firstName: string; lastName: string }) {
  return `${u.firstName?.[0] ?? ''}${u.lastName?.[0] ?? ''}`.toUpperCase();
}

function UserAvatar({ user, size = 'sm' }: { user: UserInfo; size?: 'sm' | 'md' }) {
  const px = size === 'sm' ? 'h-7 w-7 text-[10px]' : 'h-8 w-8 text-[11px]';
  if (user.avatarUrl) {
    return <img src={user.avatarUrl} alt="" className={`${px} rounded-full object-cover`} />;
  }
  return (
    <span className={`${px} inline-flex items-center justify-center rounded-full bg-blue-100 font-semibold text-blue-700`}>
      {userInitials(user)}
    </span>
  );
}

function TypeBadge({ type }: { type?: string | null }) {
  if (!type) return <span className="text-xs text-slate-400">--</span>;
  const isPartner = type.toLowerCase().includes('partner');
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        isPartner ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'
      }`}
    >
      {isPartner ? 'Partner' : 'Employee'}
    </span>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function TeamTemplatesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [showCreateInput, setShowCreateInput] = useState(false);

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: templates = [], isLoading } = useQuery<TeamTemplate[]>({
    queryKey: ['team-templates'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/config/team-templates').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  );

  // ── Mutations ──────────────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      client.post('/admin/config/team-templates', { name }).then((r) => r.data),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['team-templates'] });
      notify.success('Team template created');
      setShowCreateInput(false);
      setNewTemplateName('');
      setSelectedTemplateId(data?.id ?? null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create template'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      client.delete(`/admin/config/team-templates/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-templates'] });
      notify.success('Template deleted');
      if (selectedTemplateId) setSelectedTemplateId(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete template'),
  });

  const addMemberMutation = useMutation({
    mutationFn: (data: { templateId: number; userId: number; role?: string }) =>
      client
        .post(`/admin/config/team-templates/${data.templateId}/members`, {
          userId: data.userId,
          role: data.role || undefined,
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-templates'] });
      notify.success('Member added');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add member'),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (memberId: number) =>
      client.delete(`/admin/config/team-template-members/${memberId}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-templates'] });
      notify.success('Member removed');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove member'),
  });

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleCreate = () => {
    const trimmed = newTemplateName.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (selectedTemplate) {
    return (
      <EditorView
        template={selectedTemplate}
        onBack={() => setSelectedTemplateId(null)}
        onAddMember={(userId, role) =>
          addMemberMutation.mutate({ templateId: selectedTemplate.id, userId, role })
        }
        onRemoveMember={(memberId) => removeMemberMutation.mutate(memberId)}
        addingMember={addMemberMutation.isPending}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/templates')}
            className="rounded-lg p-1.5 hover:bg-slate-100"
          >
            <ArrowLeft className="h-5 w-5 text-slate-500" />
          </button>
          <h1 className="text-xl font-bold text-slate-800">Team Templates</h1>
        </div>
        <button
          onClick={() => setShowCreateInput(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-2"
        >
          <Plus className="h-4 w-4" /> New Template
        </button>
      </div>

      {/* Create inline form */}
      {showCreateInput && (
        <div className="bg-white rounded-[14px] border border-slate-200 p-4">
          <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">
            Template Name
          </label>
          <div className="flex gap-2">
            <input
              value={newTemplateName}
              onChange={(e) => setNewTemplateName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="e.g. BIM Coordination Team"
              className="flex-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            <button
              onClick={handleCreate}
              disabled={createMutation.isPending || !newTemplateName.trim()}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50"
            >
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button
              onClick={() => {
                setShowCreateInput(false);
                setNewTemplateName('');
              }}
              className="px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-500 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Loading */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="bg-white rounded-[14px] border border-slate-200 p-5 animate-pulse"
            >
              <div className="h-4 bg-slate-100 rounded w-2/3 mb-3" />
              <div className="h-3 bg-slate-100 rounded w-1/3" />
            </div>
          ))}
        </div>
      ) : templates.length === 0 ? (
        /* Empty state */
        <div className="bg-white rounded-[14px] border border-slate-200 p-12 text-center">
          <Users className="mx-auto h-12 w-12 text-slate-300" />
          <h3 className="mt-4 text-sm font-semibold text-slate-700">No team templates yet</h3>
          <p className="mt-1 text-sm text-slate-400">
            Create templates to save and reuse team compositions across projects.
          </p>
          <button
            onClick={() => setShowCreateInput(true)}
            className="mt-5 bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg"
          >
            Create Template
          </button>
        </div>
      ) : (
        /* Template cards */
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <div
              key={t.id}
              onClick={() => setSelectedTemplateId(t.id)}
              className="bg-white rounded-[14px] border border-slate-200 p-5 cursor-pointer hover:border-blue-300 hover:shadow-sm transition-all group"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <Users className="h-4 w-4 text-blue-500 shrink-0" />
                  <span className="text-sm font-semibold text-slate-800 truncate">
                    {t.name}
                  </span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete "${t.name}"?`)) deleteMutation.mutate(t.id);
                  }}
                  className="hover:bg-red-50 text-slate-300 hover:text-red-600 rounded-md p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-slate-400">
                  {t._count.members} member{t._count.members !== 1 ? 's' : ''}
                </span>
                {t.members.length > 0 && (
                  <div className="flex -space-x-1.5">
                    {t.members.slice(0, 5).map((m) => (
                      <UserAvatar key={m.id} user={m.user} size="sm" />
                    ))}
                    {t.members.length > 5 && (
                      <span className="h-7 w-7 inline-flex items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-500 ring-2 ring-white">
                        +{t.members.length - 5}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Editor View ────────────────────────────────────────────────────────────────

function EditorView({
  template,
  onBack,
  onAddMember,
  onRemoveMember,
  addingMember,
}: {
  template: TeamTemplate;
  onBack: () => void;
  onAddMember: (userId: number, role?: string) => void;
  onRemoveMember: (memberId: number) => void;
  addingMember: boolean;
}) {
  const [showAddSection, setShowAddSection] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleInput, setRoleInput] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);

  const { data: users = [] } = useQuery<UserInfo[]>({
    queryKey: ['users-active'],
    staleTime: 5 * 60 * 1000,
    enabled: showAddSection,
    queryFn: () =>
      client.get('/users?isActive=true').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const existingUserIds = useMemo(
    () => new Set(template.members.map((m) => m.userId)),
    [template.members],
  );

  const filteredUsers = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return users.filter((u) => {
      if (existingUserIds.has(u.id)) return false;
      if (!q) return true;
      const fullName = `${u.firstName} ${u.lastName}`.toLowerCase();
      return fullName.includes(q) || u.email.toLowerCase().includes(q);
    });
  }, [users, searchQuery, existingUserIds]);

  const handleAdd = () => {
    if (!selectedUserId) return;
    onAddMember(selectedUserId, roleInput.trim() || undefined);
    setSelectedUserId(null);
    setRoleInput('');
    setSearchQuery('');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="rounded-lg p-1.5 hover:bg-slate-100">
          <ArrowLeft className="h-5 w-5 text-slate-500" />
        </button>
        <h1 className="text-xl font-bold text-slate-800">{template.name}</h1>
        <span className="text-sm text-slate-400 ml-1">
          {template._count.members} member{template._count.members !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Members card */}
      <div className="bg-white rounded-[14px] border border-slate-200">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">Members</h2>
          <button
            onClick={() => setShowAddSection(!showAddSection)}
            className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-2"
          >
            <Plus className="h-4 w-4" /> Add Member
          </button>
        </div>

        {/* Add member section */}
        {showAddSection && (
          <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50">
            <div className="flex flex-col sm:flex-row gap-3">
              {/* User search / select */}
              <div className="flex-1">
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">
                  Search User
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setSelectedUserId(null);
                    }}
                    placeholder="Search by name or email..."
                    className="w-full pl-9 px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                {/* Dropdown results */}
                {searchQuery.trim() && !selectedUserId && (
                  <div className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm">
                    {filteredUsers.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-slate-400">No users found</div>
                    ) : (
                      filteredUsers.slice(0, 20).map((u) => (
                        <button
                          key={u.id}
                          onClick={() => {
                            setSelectedUserId(u.id);
                            setSearchQuery(`${u.firstName} ${u.lastName}`);
                          }}
                          className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-blue-50 text-sm"
                        >
                          <UserAvatar user={u} size="sm" />
                          <div className="min-w-0">
                            <div className="font-medium text-slate-700 truncate">
                              {u.firstName} {u.lastName}
                            </div>
                            <div className="text-xs text-slate-400 truncate">{u.email}</div>
                          </div>
                          <TypeBadge type={u.userType} />
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Role */}
              <div className="sm:w-48">
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">
                  Role (optional)
                </label>
                <input
                  value={roleInput}
                  onChange={(e) => setRoleInput(e.target.value)}
                  placeholder="e.g. Lead"
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
                />
              </div>

              {/* Add button */}
              <div className="flex items-end">
                <button
                  onClick={handleAdd}
                  disabled={!selectedUserId || addingMember}
                  className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2.5 rounded-lg disabled:opacity-50 whitespace-nowrap"
                >
                  {addingMember ? 'Adding...' : 'Add'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Members table */}
        {template.members.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Users className="mx-auto h-10 w-10 text-slate-300" />
            <p className="mt-2 text-sm text-slate-400">No members yet. Add members to this template.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[#FAFBFC]">
                  <th className="text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em] px-5 py-3">
                    Member
                  </th>
                  <th className="text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em] px-5 py-3">
                    Email
                  </th>
                  <th className="text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em] px-5 py-3">
                    Type
                  </th>
                  <th className="text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em] px-5 py-3">
                    Role
                  </th>
                  <th className="w-12 px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {template.members.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50/50">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <UserAvatar user={m.user} size="md" />
                        <span className="text-sm font-medium text-slate-700">
                          {m.user.firstName} {m.user.lastName}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-500">{m.user.email}</td>
                    <td className="px-5 py-3">
                      <TypeBadge type={m.user.userType} />
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-500">{m.role || '--'}</td>
                    <td className="px-5 py-3">
                      <button
                        onClick={() => removeMemberMutation_confirm(m, onRemoveMember)}
                        className="hover:bg-red-50 text-slate-300 hover:text-red-600 rounded-md p-1.5 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function removeMemberMutation_confirm(member: TemplateMember, onRemove: (id: number) => void) {
  if (confirm(`Remove ${member.user.firstName} ${member.user.lastName} from this template?`)) {
    onRemove(member.id);
  }
}
