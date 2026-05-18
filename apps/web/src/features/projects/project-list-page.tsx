import { useState, useMemo, useEffect, useRef, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, MessageSquare, Search, Send, UserCircle, Columns3, ChevronDown } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/shared/page-header';
import { useProjects } from '@/hooks/use-projects';
import { useFilterStore } from '@/stores/filter.store';
import { useDebounce } from '@/hooks/use-debounce';
import { DiscussionDrawer } from '@/features/messaging/discussion-drawer';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';

// localStorage key for the per-user "which Project Role Type columns
// are visible on the projects list" preference. Stored as a JSON
// array of role-type ids. Versioned so we can change the shape later
// without crashing on stale entries.
const ROLE_COLUMNS_LS_KEY = 'planwise:projects-list:role-columns:v1';

function loadRoleColumnIds(): number[] {
  try {
    const raw = localStorage.getItem(ROLE_COLUMNS_LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((n) => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

function saveRoleColumnIds(ids: number[]) {
  try {
    localStorage.setItem(ROLE_COLUMNS_LS_KEY, JSON.stringify(ids));
  } catch {
    /* localStorage quota / disabled — non-fatal, columns stay for this session only */
  }
}

// Group-by key — null (no group), a built-in field ('leader' /
// 'department' / 'status'), or `role:<id>` for a dynamic role-type
// column. Persisted in the same localStorage namespace.
const GROUP_BY_LS_KEY = 'planwise:projects-list:group-by:v1';

function loadGroupBy(): string | null {
  try {
    const raw = localStorage.getItem(GROUP_BY_LS_KEY);
    return raw && raw !== 'null' ? raw : null;
  } catch {
    return null;
  }
}

function saveGroupBy(v: string | null) {
  try {
    if (v == null) localStorage.removeItem(GROUP_BY_LS_KEY);
    else localStorage.setItem(GROUP_BY_LS_KEY, v);
  } catch {
    /* non-fatal */
  }
}

const statusColors: Record<string, { bg: string; text: string; label: string }> = {
  draft: { bg: 'bg-slate-100', text: 'text-slate-600', label: 'Draft' },
  active: { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Active' },
  on_hold: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'On Hold' },
  completed: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Completed' },
  cancelled: { bg: 'bg-red-100', text: 'text-red-700', label: 'Cancelled' },
};

export function ProjectListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { projectSearch, projectStatus, setProjectFilters } = useFilterStore();
  const debouncedSearch = useDebounce(projectSearch, 300);
  const [chatProjectId, setChatProjectId] = useState<number | null>(null);
  const [chatProjectName, setChatProjectName] = useState('');
  // "Filter by team member" — empty = no filter.
  const [memberFilter, setMemberFilter] = useState<number | null>(null);

  // Pull active users for the member dropdown (cached).
  const { data: activeUsers = [] } = useQuery({
    queryKey: ['users', 'active'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client.get('/users?isActive=true').then((r) => {
        const d = r.data?.data ?? r.data;
        const list = Array.isArray(d) ? d : d?.data ?? [];
        return list as Array<{ id: number; firstName: string; lastName: string }>;
      }),
  });

  const { data, isLoading } = useProjects({
    search: debouncedSearch || undefined,
    status: projectStatus.length ? projectStatus[0] : undefined,
    memberId: memberFilter ?? undefined,
    perPage: 100,
  });

  // Project Role Types catalog — drives the "Columns" customizer.
  // Each entry can optionally be added as a column on the table; the
  // value shows the active assignees on each project in that role.
  const { data: roleTypes = [] } = useQuery<Array<{
    id: number;
    code: string;
    name: string;
    sortOrder?: number;
  }>>({
    queryKey: ['admin', 'project-role-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/project-role-types').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
  });

  // Selected role-type ids (= visible columns). Initialized from
  // localStorage so the preference persists per browser without needing
  // a user-prefs backend table. Future: move to a server-side user
  // preference if/when we add cross-device sync.
  const [selectedRoleIds, setSelectedRoleIds] = useState<number[]>(() => loadRoleColumnIds());
  useEffect(() => { saveRoleColumnIds(selectedRoleIds); }, [selectedRoleIds]);

  // Visible role-type column descriptors, sorted by the catalog's
  // sortOrder so the columns line up with the admin's canonical order.
  const visibleRoleColumns = useMemo(() => {
    const byId = new Map(roleTypes.map((rt) => [rt.id, rt]));
    return selectedRoleIds
      .map((id) => byId.get(id))
      .filter((rt): rt is NonNullable<typeof rt> => !!rt)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
  }, [selectedRoleIds, roleTypes]);

  // Columns popover open/close + outside-click handling.
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const columnsMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (columnsMenuRef.current && !columnsMenuRef.current.contains(e.target as Node)) {
        setColumnsMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const toggleRoleColumn = (id: number) => {
    setSelectedRoleIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  // Unwrap the paginated response shape — the API wraps the list in
  // `{ data: { data: [...], meta: ... } }` so we drill twice. Declared
  // here (not at the bottom) because the groupedProjects useMemo below
  // references it in its dependency array; with the prior ordering the
  // dep-array evaluation hit the projects const while it was still in
  // its temporal-dead-zone, throwing "Cannot access 'y' before
  // initialization" at first render.
  const rawProjects = data?.data ?? data;
  const projects: any[] = Array.isArray(rawProjects) ? rawProjects : [];

  // ─── Group By ─────────────────────────────────────────────────────────
  // Single-value grouping (or null = no grouping). The dropdown lists
  // the three "structural" fields (Leader / Department / Status) plus
  // every role-type column the user has enabled. If the user removes a
  // role column that's currently the grouping key, we silently reset
  // to "No grouping" so we don't end up grouping by an invisible field.
  const [groupBy, setGroupBy] = useState<string | null>(() => loadGroupBy());
  useEffect(() => { saveGroupBy(groupBy); }, [groupBy]);
  useEffect(() => {
    if (groupBy?.startsWith('role:')) {
      const id = Number(groupBy.slice(5));
      if (!selectedRoleIds.includes(id)) setGroupBy(null);
    }
  }, [groupBy, selectedRoleIds]);

  /** Resolve the bucket label for a project under the active groupBy. */
  const groupLabelFor = (p: any): string => {
    if (!groupBy) return '';
    if (groupBy === 'leader') {
      return p.leader ? `${p.leader.firstName ?? ''} ${p.leader.lastName ?? ''}`.trim() : '(no leader)';
    }
    if (groupBy === 'department') {
      return p.department?.name ?? '(no department)';
    }
    if (groupBy === 'status') {
      return statusColors[p.status]?.label ?? p.status ?? '(no status)';
    }
    if (groupBy.startsWith('role:')) {
      const roleId = Number(groupBy.slice(5));
      const assigns = ((p.partnerRoles ?? []) as any[])
        .filter((r) => r.roleId === roleId)
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
      if (assigns.length === 0) {
        const rt = roleTypes.find((r) => r.id === roleId);
        return `(no ${rt?.name ?? 'assignee'})`;
      }
      // Group by primary assignee's display name (or first one).
      return assigns[0].party.displayName ?? '(unnamed)';
    }
    return '';
  };

  /**
   * Pre-bucketed projects. When groupBy is null we emit a single
   * "(all)" group so the render path is uniform. Otherwise we walk
   * projects once, key by groupLabelFor(), then sort groups
   * alphabetically with the "(no X)" empty group always last so it
   * doesn't bury real data at the top.
   */
  const groupedProjects = useMemo(() => {
    if (!groupBy) {
      return [{ key: '__all__', label: '', items: projects }];
    }
    const map = new Map<string, any[]>();
    for (const p of projects) {
      const label = groupLabelFor(p);
      const arr = map.get(label) ?? [];
      arr.push(p);
      map.set(label, arr);
    }
    const entries = Array.from(map.entries());
    const isEmpty = (label: string) => label.startsWith('(no ') || label === '(unnamed)';
    entries.sort((a, b) => {
      // Empty groups float to the bottom.
      const ea = isEmpty(a[0]);
      const eb = isEmpty(b[0]);
      if (ea !== eb) return ea ? 1 : -1;
      return a[0].localeCompare(b[0]);
    });
    return entries.map(([label, items]) => ({ key: label, label, items }));
    // intentionally not depending on groupLabelFor — its only inputs are
    // groupBy + roleTypes, both already in the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, groupBy, roleTypes]);

  // Fetch departments for display
  const { data: departments = [] } = useQuery({
    queryKey: ['departments'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/config/departments').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
  });

  const deleteProject = useMutation({
    mutationFn: (id: number) => client.delete(`/projects/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      notify.success('Project deleted', { code: 'PROJECT-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete'),
  });

  return (
    <div className="space-y-6">
      {/* Title only — the primary action (New Project) lives down in
          the filter row next to the Columns customizer so the user's
          eye can hop between "view config" and "create" without
          jumping back to the page header. */}
      <PageHeader
        title="Projects"
        description="Manage your engineering projects"
      />

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input value={projectSearch} onChange={(e) => setProjectFilters({ projectSearch: e.target.value })}
            placeholder="Search projects..." className="w-full pl-10 pr-4 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
        </div>
        <select value={projectStatus[0] ?? ''} onChange={(e) => setProjectFilters({ projectStatus: e.target.value ? [e.target.value] : [] })}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
          <option value="">All Status</option>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="on_hold">On Hold</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        {/* Filter by team member — matches projects where the user is leader OR an active member. */}
        <select
          value={memberFilter ?? ''}
          onChange={(e) => setMemberFilter(e.target.value ? Number(e.target.value) : null)}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm max-w-[200px]"
          title="Filter by team member"
        >
          <option value="">All Team Members</option>
          {activeUsers.map((u) => (
            <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>
          ))}
        </select>
        {memberFilter !== null && (
          <button
            type="button"
            onClick={() => setMemberFilter(null)}
            className="text-[12px] text-slate-500 hover:text-slate-700 underline"
          >
            Clear
          </button>
        )}

        {/* Group By — single dropdown. Options include the three
            "structural" project fields plus any role-type column the
            user has enabled. Persisted in localStorage so the chosen
            grouping survives reloads. */}
        <div className="ml-auto flex items-center gap-1.5">
          <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Group by</label>
          <select
            value={groupBy ?? ''}
            onChange={(e) => setGroupBy(e.target.value || null)}
            className="rounded-lg border border-slate-200 px-2 py-2 text-sm bg-white"
            title="Bucket projects by a field — value column header turns into the group label"
          >
            <option value="">No grouping</option>
            <option value="leader">Team Leader</option>
            <option value="department">Department</option>
            <option value="status">Status</option>
            {visibleRoleColumns.length > 0 && (
              <optgroup label="Role columns">
                {visibleRoleColumns.map((rt) => (
                  <option key={rt.id} value={`role:${rt.id}`}>{rt.name}</option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        {/* Columns customizer — lets the admin pick which Project
            Role Type assignments show as columns on the list. Stored
            per browser via localStorage (see selectedRoleIds above). */}
        <div className="relative" ref={columnsMenuRef}>
          <button
            type="button"
            onClick={() => setColumnsMenuOpen((o) => !o)}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
            title="Show / hide role columns"
          >
            <Columns3 className="h-4 w-4 text-slate-500" />
            Columns
            {selectedRoleIds.length > 0 && (
              <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-700">
                {selectedRoleIds.length}
              </span>
            )}
            <ChevronDown className="h-3 w-3 text-slate-400" />
          </button>
          {columnsMenuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-md border border-slate-200 bg-white shadow-lg">
              <div className="border-b border-slate-100 px-3 py-2">
                <p className="text-[12px] font-semibold text-slate-700">Role columns</p>
                <p className="text-[10px] text-slate-500">
                  Pick Project Role Types to add as columns on the list.
                </p>
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {roleTypes.length === 0 ? (
                  <p className="px-3 py-3 text-[12px] text-slate-400 italic">
                    No Project Role Types defined — add them in Admin → Project Role Types.
                  </p>
                ) : (
                  roleTypes.map((rt) => {
                    const checked = selectedRoleIds.includes(rt.id);
                    return (
                      <label
                        key={rt.id}
                        className="flex items-center gap-2 px-3 py-1.5 text-[13px] hover:bg-slate-50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleRoleColumn(rt.id)}
                          className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer"
                        />
                        <span className="text-slate-700">{rt.name}</span>
                      </label>
                    );
                  })
                )}
              </div>
              {selectedRoleIds.length > 0 && (
                <div className="border-t border-slate-100 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setSelectedRoleIds([])}
                    className="text-[11px] text-slate-500 hover:text-slate-700 underline"
                  >
                    Clear all
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Primary action — moved into the filter row so it sits
            next to the view-configuration controls (Group by /
            Columns). Same blue/style as the empty-state Create Project
            button below for consistency. */}
        <button
          onClick={() => navigate('/projects/new')}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" /> New Project
        </button>
      </div>

      {/* Project Table */}
      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-400">Loading projects...</div>
      ) : projects.length === 0 ? (
        <div className="rounded-[14px] border border-slate-200 bg-white py-12 text-center">
          <p className="text-sm text-slate-500">{projectSearch ? 'No projects match your search' : 'No projects yet'}</p>
          <button onClick={() => navigate('/projects/new')}
            className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Create Project</button>
        </div>
      ) : (
        <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3 text-left font-semibold">Project Code</th>
                  <th className="px-4 py-3 text-left font-semibold">Project Name</th>
                  {/* Team Leader is no longer a static column — it's just
                      another Project Role Type now (seeded as
                      'team_leader'). Add it via Columns customizer if
                      you want it on screen. */}
                  {/* Dynamic role-type columns — order follows the catalog
                      sortOrder via visibleRoleColumns. */}
                  {visibleRoleColumns.map((rt) => (
                    <th key={rt.id} className="px-4 py-3 text-left font-semibold">{rt.name}</th>
                  ))}
                  <th className="px-4 py-3 text-left font-semibold">Department</th>
                  <th className="px-4 py-3 text-left font-semibold">Status</th>
                  <th className="px-4 py-3 text-left font-semibold">Category</th>
                  <th className="px-4 py-3 text-right font-semibold">Budget</th>
                  <th className="px-4 py-3 text-center font-semibold">Completion</th>
                  <th className="px-4 py-3 text-right font-semibold">Cost</th>
                  <th className="px-4 py-3 text-right font-semibold">Hours</th>
                  <th className="px-4 py-3 text-center font-semibold">Chat</th>
                  <th className="px-4 py-3 text-center font-semibold w-10"></th>
                </tr>
              </thead>
              <tbody>
                {groupedProjects.map((g) => (
                  <Fragment key={g.key}>
                    {/* Section header row — rendered only when a Group
                        By is active. Spans every visible column so the
                        label sits across the full table width. Count
                        gives instant size feedback at the bucket level. */}
                    {groupBy && (
                      <tr className="bg-slate-100/80 border-y border-slate-200">
                        <td
                          colSpan={11 + visibleRoleColumns.length}
                          className="px-4 py-2 text-[12px] font-bold text-slate-700"
                        >
                          {g.label}
                          <span className="ml-3 font-normal text-slate-500">
                            · {g.items.length} project{g.items.length === 1 ? '' : 's'}
                          </span>
                        </td>
                      </tr>
                    )}
                    {g.items.map((p: any, idx: number) => {
                      const st = statusColors[p.status] ?? statusColors.draft;
                  const leader = p.leader;
                  const taskCount = p._count?.tasks ?? 0;
                  const completionRate = 0; // would need aggregation
                  const dept = p.department?.name ?? '-';
                  const categories = (p.categories ?? []).map((c: any) => c.serviceType?.name).filter(Boolean);
                  const category = categories.length > 0 ? categories.join(', ') : (p.projectType?.name ?? '-');

                  return (
                    <tr key={p.id}
                      onClick={() => navigate(`/projects/${p.id}`)}
                      className={cn('border-b border-slate-100 cursor-pointer hover:bg-blue-50/30 transition-colors',
                        idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/30')}>
                      <td className="px-4 py-3 font-mono text-slate-500">{p.number || '-'}</td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-800">{p.name}</p>
                      </td>
                      {/* Team Leader static cell removed — surface it via
                          the Columns customizer (it's seeded as a system
                          Project Role Type). The local `leader` const
                          is still used by the Send-message button further
                          down so we keep the destructure above. */}
                      {/* Dynamic role-type cells. Walks the project's
                          active ProjectPartnerRole assignments (loaded by
                          the list endpoint) and surfaces the assignees
                          for each visible role-type column. Multiple
                          assignees stack vertically (compact). Primary
                          assignee is bolded so the lead is obvious at
                          a glance. */}
                      {visibleRoleColumns.map((rt) => {
                        // Relation name on Project is `partnerRoles`
                        // (not `projectPartnerRoles` — that's the inverse
                        // side on BusinessPartner).
                        const assignees = ((p.partnerRoles ?? []) as any[])
                          .filter((r: any) => r.roleId === rt.id)
                          .sort((a: any, b: any) => Number(b.isPrimary) - Number(a.isPrimary));
                        return (
                          <td key={rt.id} className="px-4 py-3">
                            {assignees.length === 0 ? (
                              <span className="text-slate-300">—</span>
                            ) : (
                              <div className="flex flex-col gap-0.5 text-[12px]">
                                {assignees.map((a: any) => (
                                  <span
                                    key={a.id}
                                    className={cn(
                                      'truncate',
                                      a.isPrimary ? 'font-semibold text-slate-800' : 'text-slate-600',
                                    )}
                                    title={a.titleInProject ? `${a.party.displayName} — ${a.titleInProject}` : a.party.displayName}
                                  >
                                    {a.party.displayName}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-4 py-3 text-slate-600">{dept}</td>
                      <td className="px-4 py-3">
                        <span className={cn('rounded-[5px] px-2 py-0.5 text-[10px] font-bold', st.bg, st.text)}>{st.label}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{category}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700">
                        {p.budget ? `₪${Number(p.budget).toLocaleString()}` : '-'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-500 rounded-full" style={{ width: '0%' }} />
                          </div>
                          <span className="text-[11px] text-slate-500">0%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-500">-</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-500">-</td>
                      <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-center gap-0.5">
                          <button onClick={() => { setChatProjectId(p.id); setChatProjectName(p.name); }}
                            title="Project discussion"
                            className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors">
                            <MessageSquare className="h-3.5 w-3.5" />
                          </button>
                          {leader && (
                            <button onClick={() => { setChatProjectId(p.id); setChatProjectName(`Message to ${leader.firstName}`); }}
                              title={`Quick message to ${leader.firstName} ${leader.lastName}`}
                              className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors">
                              <Send className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => { if (confirm(`Delete "${p.name}"?`)) deleteProject.mutate(p.id); }}
                          className="w-7 h-7 rounded-md flex items-center justify-center text-slate-300 hover:text-red-600 hover:bg-red-50 transition-colors">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Discussion Drawer for chat */}
      {chatProjectId && (
        <DiscussionDrawer
          open={!!chatProjectId}
          onClose={() => setChatProjectId(null)}
          entityType="project"
          entityId={chatProjectId}
          title={chatProjectName}
        />
      )}
    </div>
  );
}
