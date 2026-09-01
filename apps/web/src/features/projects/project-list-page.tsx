import { useState, useMemo, useEffect, useRef, Fragment } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Plus, Trash2, MessageSquare, Search, Send, UserCircle, Columns3, ChevronDown } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/shared/page-header';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';
import { useProjects, useProjectTypes } from '@/hooks/use-projects';
import { useFilterStore } from '@/stores/filter.store';
import { useDebounce } from '@/hooks/use-debounce';
import { DiscussionDrawer } from '@/features/messaging/discussion-drawer';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { PeopleMultiSelect } from '@/components/shared/people-multi-select';

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
  draft: { bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-600 dark:text-slate-300', label: 'Draft' },
  active: { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Active' },
  on_hold: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'On Hold' },
  completed: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Completed' },
  cancelled: { bg: 'bg-red-100', text: 'text-red-700', label: 'Cancelled' },
};

export function ProjectListPage() {
  const confirm = useConfirm();
  const tableScrollRef = useStickyHScroll();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { projectSearch, projectStatus, setProjectFilters } = useFilterStore();
  // Finance permission gate — controls visibility of the Budget /
  // Cost / Hours columns. NO admin short-circuit: even admins need
  // an explicit Finance read grant in /admin/roles.
  const { can: canPerm, isAdmin } = usePermissions();
  const showFinance = canPerm('finance', 'read');
  // In-cell editing gates. `isAdmin ||` bypass matches the project-wide
  // convention (see e.g. project-detail-page): an admin can always
  // write / re-assign, non-admins need the explicit module grant.
  const canWriteProjects = isAdmin || canPerm('projects', 'write');
  const canWritePartners = isAdmin || canPerm('partners', 'write');
  const debouncedSearch = useDebounce(projectSearch, 300);
  const [chatProjectId, setChatProjectId] = useState<number | null>(null);
  const [chatProjectName, setChatProjectName] = useState('');
  // "Filter by team member" — empty = no filter. Widened from single-
  // value to a set (memberIds[]) with UNION semantics so a chip stack
  // "Alice, Bob" returns projects on which EITHER appears via ANY of
  // the person-on-project paths (leader / legacy member / partner-role
  // party / partner-role contact). Backend widening lives on the
  // GET /projects `memberIds[]` query param (fix/people-filter).
  const [memberFilter, setMemberFilter] = useState<number[]>([]);

  // Pull active users for the member dropdown (cached). `avatarUrl` is
  // included so the PeopleMultiSelect chips + option rows render the
  // real photo instead of falling back to initials on every row.
  const { data: activeUsers = [] } = useQuery({
    queryKey: ['users', 'active'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client.get('/users?isActive=true&perPage=1000').then((r) => {
        const d = r.data?.data ?? r.data;
        const list = Array.isArray(d) ? d : d?.data ?? [];
        return list as Array<{
          id: number;
          firstName: string;
          lastName: string;
          avatarUrl?: string | null;
          position?: string | null;
          department?: string | null;
        }>;
      }),
  });

  // Status filter is a single dropdown with values from the ProjectStatus
  // enum plus a synthetic "closed" option (T3.6 follow-up). When the user
  // picks "closed", we send `closedOnly=true` to the API and clear the
  // real status filter — closed is a separate dimension (closedAt
  // timestamp) but exposing it in the same dropdown matches the user's
  // mental model ("status = closed").
  const isClosedFilter = projectStatus[0] === '__closed__';
  const apiStatus = isClosedFilter ? undefined : (projectStatus.length ? projectStatus[0] : undefined);

  // Per-column client-side filters (Tier C #3). Chevron in the column
  // header opens a small popover with an input; typed text narrows the
  // visible rows without a server round-trip. Empty string = no filter.
  // Kept as a single object so adding another column later is a one-key
  // append with no new useState.
  // Per-column client-side filters. Text columns (code, name) get a
  // substring input; enum-ish columns (type, status, role[N]) get a
  // dropdown whose OPTIONS are derived from the currently-loaded rows
  // (QA3 · A · item 2) — never from the full catalog/enum, so users
  // aren't offered filter values that don't exist on screen.
  //   • `roles` — keyed by role-type id so a dynamic role column carries
  //     its own filter without needing a new useState per column.
  //   • Empty option-list → filter chevron hidden (see hasFilterableXxx
  //     memos below).
  const [colFilters, setColFilters] = useState<{
    code: string;
    name: string;
    type: string;
    status: string;
    roles: Record<number, string>;
  }>({ code: '', name: '', type: '', status: '', roles: {} });
  // openColFilter — one popover open at a time. Role columns use a
  // synthetic key `role:<id>` so the discriminated union stays flat.
  const [openColFilter, setOpenColFilter] = useState<string | null>(null);

  const { data, isLoading } = useProjects({
    search: debouncedSearch || undefined,
    status: apiStatus,
    memberIds: memberFilter.length > 0 ? memberFilter : undefined,
    closedOnly: isClosedFilter ? true : undefined,
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
  const rawList: any[] = Array.isArray(rawProjects) ? rawProjects : [];
  // Apply per-column client-side filters on top of what the API returned.
  // Case-insensitive substring on text columns; exact-match id on the
  // typed dropdown. Empty filter values pass through untouched.
  const projects: any[] = rawList.filter((p) => {
    const codeFilter = colFilters.code.trim().toLowerCase();
    if (codeFilter && !String(p.number ?? '').toLowerCase().includes(codeFilter)) return false;
    const nameFilter = colFilters.name.trim().toLowerCase();
    if (nameFilter && !String(p.name ?? '').toLowerCase().includes(nameFilter)) return false;
    if (colFilters.type && String(p.projectTypeId ?? '') !== colFilters.type) return false;
    if (colFilters.status && String(p.status ?? '') !== colFilters.status) return false;
    // Role-column filters — one per visible role-type column. Value is
    // a party.displayName (matched exactly against the assignments on
    // that role). Synthetic `__none__` bucket matches projects with no
    // assignee on that role, so users can filter "who's missing a lead".
    for (const [roleIdStr, wanted] of Object.entries(colFilters.roles)) {
      if (!wanted) continue;
      const roleId = Number(roleIdStr);
      const assignees = ((p.partnerRoles ?? []) as any[])
        .filter((r: any) => r.roleId === roleId)
        .map((r: any) => r.party?.displayName ?? null);
      if (wanted === '__none__') {
        if (assignees.length > 0) return false;
      } else if (!assignees.includes(wanted)) {
        return false;
      }
    }
    return true;
  });

  // ─── Per-column filter option sets ───────────────────────────────
  // QA3 · A · item 2 — every enum-ish column's filter dropdown is
  // sourced from the DISTINCT values actually present in `rawList`
  // (server-returned rows, before client-side col filters), NOT from
  // the full ProjectType catalog / ProjectStatus enum / users list.
  // Empty option list → the filter chevron is hidden entirely for that
  // column (see `hasCategoryFilterable` etc). rawList is the right
  // source (not `projects`) so a user who has narrowed by e.g. Status
  // can still switch to a different status — filtering by column A
  // must never drop options for column B.

  /** Category (ProjectType) options — [id, name][], alpha sort. */
  const categoryFilterOptions = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of rawList) {
      if (p?.projectType?.id && p?.projectType?.name) {
        map.set(p.projectType.id, p.projectType.name);
      }
    }
    return Array.from(map.entries()).sort(([, a], [, b]) => a.localeCompare(b));
  }, [rawList]);

  /** Status options — [value, label][], sorted by label. Empty when
   *  every row shares the same status (nothing to pick between). */
  const statusFilterOptions = useMemo(() => {
    const present = new Set<string>();
    for (const p of rawList) {
      if (p?.status) present.add(String(p.status));
    }
    return Array.from(present)
      .map((v) => [v, statusColors[v]?.label ?? v] as [string, string])
      .sort(([, a], [, b]) => a.localeCompare(b));
  }, [rawList]);

  /** Role-column options — Map<roleId, Array<{ value, label }>>. Each
   *  role's dropdown is derived from that role's assignee.displayName
   *  values across rawList. If any project has no assignee on the role
   *  we prepend a synthetic `__none__` bucket labelled "— None". */
  const roleFilterOptionsByRoleId = useMemo(() => {
    const out = new Map<number, Array<{ value: string; label: string }>>();
    for (const rt of visibleRoleColumns) {
      const names = new Set<string>();
      let anyEmpty = false;
      for (const p of rawList) {
        const assignments = ((p?.partnerRoles ?? []) as any[]).filter((r) => r?.roleId === rt.id);
        if (assignments.length === 0) {
          anyEmpty = true;
        } else {
          for (const a of assignments) {
            if (a?.party?.displayName) names.add(a.party.displayName);
          }
        }
      }
      const opts = Array.from(names)
        .sort((a, b) => a.localeCompare(b))
        .map((n) => ({ value: n, label: n }));
      if (anyEmpty) opts.unshift({ value: '__none__', label: '— None' });
      out.set(rt.id, opts);
    }
    return out;
  }, [rawList, visibleRoleColumns]);

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

  /**
   * In-cell status change. Fires against the permissive
   * projects.service#update — no core-fields guardrail, so a
   * status-only PATCH is accepted. Optimistic: we snapshot every
   * ['projects', …] cache, patch the target row's status in place,
   * and on error roll every snapshot back so the badge doesn't
   * "stick" on a value the server rejected. Success invalidates the
   * broad ['projects'] prefix so any dependent list (filtered,
   * grouped) refetches.
   *
   * Close / reopen is a SEPARATE dimension (closedAt timestamp)
   * with its own POST endpoints — not offered here to keep the
   * inline editor to the four active statuses the status filter
   * already exposes.
   */
  const updateProjectStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      client.patch(`/projects/${id}`, { status }).then((r) => r.data),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: ['projects'] });
      const snapshots = queryClient.getQueriesData<any>({ queryKey: ['projects'] });
      for (const [key, cached] of snapshots) {
        if (!cached) continue;
        // Cache shape: { data: [...], meta: {...} } | { data: {...} } | array.
        const rows: any[] | undefined = cached?.data?.data
          ? cached.data.data
          : Array.isArray(cached?.data) ? cached.data
          : Array.isArray(cached) ? cached
          : undefined;
        if (!rows) continue;
        const idx = rows.findIndex((p: any) => p?.id === id);
        if (idx === -1) continue;
        // Immutable patch — clone the container so React-Query sees a
        // new reference and the table re-renders.
        const nextRows = rows.slice();
        nextRows[idx] = { ...nextRows[idx], status };
        const next = cached?.data?.data
          ? { ...cached, data: { ...cached.data, data: nextRows } }
          : Array.isArray(cached?.data)
            ? { ...cached, data: nextRows }
            : nextRows;
        queryClient.setQueryData(key, next);
      }
      return { snapshots };
    },
    onError: (err: any, _vars, ctx) => {
      // Revert every touched cache to its pre-mutation snapshot.
      if (ctx?.snapshots) {
        for (const [key, prev] of ctx.snapshots) {
          queryClient.setQueryData(key, prev);
        }
      }
      notify.apiError(err, 'Failed to update status');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  /**
   * In-cell Category (project-type) change (QA3 · A · item 1). Same
   * PATCH endpoint + optimistic-snapshot shape as `updateProjectStatus`
   * above — projectTypeId is on UpdateProjectDto via PartialType, so
   * the DTO already accepts it. The optimistic patch replaces both
   * `projectTypeId` AND the embedded `projectType` object (name + color
   * that the read-mode cell renders) so the pill flips instantly
   * without waiting for the invalidate refetch. Error rolls back;
   * success invalidates the whole ['projects'] prefix.
   */
  const projectTypesQuery = useProjectTypes();
  const updateProjectCategory = useMutation({
    mutationFn: ({ id, projectTypeId }: { id: number; projectTypeId: number }) =>
      client.patch(`/projects/${id}`, { projectTypeId }).then((r) => r.data),
    onMutate: async ({ id, projectTypeId }) => {
      await queryClient.cancelQueries({ queryKey: ['projects'] });
      const snapshots = queryClient.getQueriesData<any>({ queryKey: ['projects'] });
      const nextType = (projectTypesQuery.data ?? []).find((t: any) => t.id === projectTypeId) ?? null;
      for (const [key, cached] of snapshots) {
        if (!cached) continue;
        const rows: any[] | undefined = cached?.data?.data
          ? cached.data.data
          : Array.isArray(cached?.data) ? cached.data
          : Array.isArray(cached) ? cached
          : undefined;
        if (!rows) continue;
        const idx = rows.findIndex((p: any) => p?.id === id);
        if (idx === -1) continue;
        const nextRows = rows.slice();
        nextRows[idx] = {
          ...nextRows[idx],
          projectTypeId,
          projectType: nextType
            ? { id: nextType.id, name: nextType.name, color: nextType.color ?? null }
            : nextRows[idx].projectType,
        };
        const next = cached?.data?.data
          ? { ...cached, data: { ...cached.data, data: nextRows } }
          : Array.isArray(cached?.data)
            ? { ...cached, data: nextRows }
            : nextRows;
        queryClient.setQueryData(key, next);
      }
      return { snapshots };
    },
    onError: (err: any, _vars, ctx) => {
      if (ctx?.snapshots) {
        for (const [key, prev] of ctx.snapshots) {
          queryClient.setQueryData(key, prev);
        }
      }
      notify.apiError(err, 'Failed to update category');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  /**
   * Add a role holder — POST /project-partner-roles. The cell picker
   * feeds us the party id it looked up from the candidates list, so
   * we don't have to re-resolve here. We DO NOT optimistically patch
   * the cache: the ProjectPartnerRole row's `id` is server-assigned
   * and is needed for a subsequent DELETE, so we wait for the write
   * to return and then invalidate ['projects'] to refetch it in
   * full — matches the pattern useAddProjectMember already uses.
   */
  const addRoleHolder = useMutation({
    mutationFn: (v: { projectId: number; roleId: number; partyId: number }) =>
      client.post('/project-partner-roles', v).then((r) => r.data),
    onError: (err: any) => notify.apiError(err, 'Failed to assign role'),
  });

  /**
   * Remove a role holder — DELETE /project-partner-roles/:id, which
   * soft-ends the row (sets valid_to=now). We identify the target by
   * assignmentId, not by (roleId, partyId), because the candidate may
   * hold the same role multiple times historically (unlikely today
   * but the schema doesn't forbid it).
   *
   * Note: the DELETE endpoint requires `partners:delete`. The cell
   * gate is `partners:write`; a user with write-but-not-delete will
   * hit a 403 on removals and see the toast — accepted trade-off,
   * matches how the Team tab does it.
   */
  const removeRoleHolder = useMutation({
    mutationFn: (assignmentId: number) =>
      client.delete(`/project-partner-roles/${assignmentId}`).then((r) => r.data),
    onError: (err: any) => notify.apiError(err, 'Failed to remove role holder'),
  });

  /**
   * Save = diff. Called by RoleHolderCell after the popover commits
   * — we compute added/removed userIds vs current holders, translate
   * userIds → partyIds via the candidates list (POST needs partyId),
   * fire the parallel POSTs + DELETEs, then invalidate ['projects']
   * once so a single refetch reflects the new holders on every list
   * query. Failures on individual writes surface via the mutation
   * error toasts above; a partial success still invalidates so the
   * UI shows the writes that landed.
   */
  const saveRoleHolders = async (args: {
    projectId: number;
    roleId: number;
    currentAssignments: Array<{ id: number; partyId: number | null; userId: number | null }>;
    nextUserIds: number[];
    candidates: Array<{ userId: number | null; partyId: number | null }>;
  }) => {
    const { projectId, roleId, currentAssignments, nextUserIds, candidates } = args;
    const currentUserIds = currentAssignments
      .map((a) => a.userId)
      .filter((u): u is number => u != null);
    const nextSet = new Set(nextUserIds);
    const currentSet = new Set(currentUserIds);
    const addedUserIds = nextUserIds.filter((u) => !currentSet.has(u));
    const removedAssignments = currentAssignments.filter(
      (a) => a.userId != null && !nextSet.has(a.userId),
    );
    const userIdToPartyId = new Map(
      candidates
        .filter((c) => c.userId != null && c.partyId != null)
        .map((c) => [c.userId as number, c.partyId as number]),
    );

    const ops: Promise<any>[] = [];
    for (const uid of addedUserIds) {
      const partyId = userIdToPartyId.get(uid);
      if (partyId == null) continue; // unassignable candidate — skipped
      ops.push(addRoleHolder.mutateAsync({ projectId, roleId, partyId }));
    }
    for (const a of removedAssignments) {
      ops.push(removeRoleHolder.mutateAsync(a.id));
    }
    if (ops.length === 0) return;
    // allSettled — one failure shouldn't block the rest from writing;
    // the failing mutation toasts on its own.
    await Promise.allSettled(ops);
    queryClient.invalidateQueries({ queryKey: ['projects'] });
  };

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
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 dark:text-slate-500" />
          <input value={projectSearch} onChange={(e) => setProjectFilters({ projectSearch: e.target.value })}
            placeholder="Search projects..." className="w-full pl-10 pr-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm focus:border-blue-500 focus:outline-none" />
        </div>
        {/* Status dropdown — includes a synthetic "Closed" option that
            flips closedOnly on the API. The user expected to find closed
            projects via the same status control, so we surface it here
            instead of behind a separate checkbox. (T3.6 follow-up.) */}
        <select value={projectStatus[0] ?? ''} onChange={(e) => setProjectFilters({ projectStatus: e.target.value ? [e.target.value] : [] })}
          className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm">
          <option value="">All Status</option>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="on_hold">On Hold</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
          <option disabled>──────────</option>
          <option value="__closed__">Closed</option>
        </select>
        {/* Filter by team member — replaces the retested native <select>
            (unsorted, single-select, no search) with the reusable chip-
            based PeopleMultiSelect. Backend widening on `memberIds[]`
            makes the filter walk leader + legacy members + partner-role
            party + partner-role contact, so Alex Isakov now returns
            every project he's on regardless of the path. */}
        <PeopleMultiSelect
          people={activeUsers.map((u) => ({
            userId: u.id,
            displayName: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || `User #${u.id}`,
            avatarUrl: u.avatarUrl ?? null,
            subtitle: u.position ?? u.department ?? null,
          }))}
          value={memberFilter}
          onChange={setMemberFilter}
          placeholder="All Team Members"
          title="Filter projects by team member"
          triggerClassName="w-64"
        />

        {/* Group By — single dropdown. Options include the three
            "structural" project fields plus any role-type column the
            user has enabled. Persisted in localStorage so the chosen
            grouping survives reloads. */}
        <div className="ml-auto flex items-center gap-1.5">
          <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Group by</label>
          <select
            value={groupBy ?? ''}
            onChange={(e) => setGroupBy(e.target.value || null)}
            className="h-9 rounded-lg border border-slate-200 dark:border-slate-700 px-3 text-sm bg-white dark:bg-slate-900"
            title="Bucket projects by a field — value column header turns into the group label"
          >
            <option value="">No grouping</option>
            <option value="leader">Team Leader</option>
            {/* Department group-by removed (V3) — field is unused. */}
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
            className="flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50"
            title="Show / hide role columns"
          >
            <Columns3 className="h-4 w-4 text-slate-500 dark:text-slate-400" />
            Columns
            {selectedRoleIds.length > 0 && (
              <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-700">
                {selectedRoleIds.length}
              </span>
            )}
            <ChevronDown className="h-3 w-3 text-slate-400 dark:text-slate-500" />
          </button>
          {columnsMenuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg">
              <div className="border-b border-slate-100 dark:border-slate-800 px-3 py-2">
                <p className="text-[12px] font-semibold text-slate-700 dark:text-slate-200">Role columns</p>
                <p className="text-[10px] text-slate-500 dark:text-slate-400">
                  Pick Project Role Types to add as columns on the list.
                </p>
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {roleTypes.length === 0 ? (
                  <p className="px-3 py-3 text-[12px] text-slate-400 dark:text-slate-500 italic">
                    No Project Role Types defined — add them in Admin → Project Role Types.
                  </p>
                ) : (
                  roleTypes.map((rt) => {
                    const checked = selectedRoleIds.includes(rt.id);
                    return (
                      <label
                        key={rt.id}
                        className="flex items-center gap-2 px-3 py-1.5 text-[13px] hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleRoleColumn(rt.id)}
                          className="h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-600 cursor-pointer"
                        />
                        <span className="text-slate-700 dark:text-slate-200">{rt.name}</span>
                      </label>
                    );
                  })
                )}
              </div>
              {selectedRoleIds.length > 0 && (
                <div className="border-t border-slate-100 dark:border-slate-800 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setSelectedRoleIds([])}
                    className="text-[11px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 underline"
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
          className="flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-sm font-semibold text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" /> New Project
        </button>
      </div>

      {/* Project Table */}
      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">Loading projects...</div>
      ) : projects.length === 0 ? (
        // Empty state — distinguish "no projects in DB" from "filter
        // hides them" so users with a stale status filter persisted in
        // localStorage (U6 in the bug list) can recover. The filter
        // store is zustand+persist, so a prior session's status pick
        // sticks across reloads.
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-12 text-center space-y-3">
          {(() => {
            const hasFilter = !!projectSearch || projectStatus.length > 0 || memberFilter.length > 0;
            return hasFilter ? (
              <>
                <p className="text-sm text-slate-500 dark:text-slate-400">No projects match your current filters.</p>
                <button
                  onClick={() => {
                    setProjectFilters({ projectSearch: '', projectStatus: [] });
                    setMemberFilter([]);
                  }}
                  className="rounded-lg bg-slate-200 dark:bg-slate-700 px-4 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600"
                >
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <p className="text-sm text-slate-500 dark:text-slate-400">No projects yet.</p>
                <button onClick={() => navigate('/projects/new')}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Create Project</button>
              </>
            );
          })()}
        </div>
      ) : (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
          <div ref={tableScrollRef} className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="px-4 py-3 text-left font-semibold">
                    <ColumnHeaderWithFilter
                      label="Project Code"
                      isOpen={openColFilter === 'code'}
                      onToggle={() => setOpenColFilter((c) => c === 'code' ? null : 'code')}
                      value={colFilters.code}
                      hasFilter={!!colFilters.code}
                    >
                      <input
                        type="text"
                        autoFocus
                        value={colFilters.code}
                        onChange={(e) => setColFilters((f) => ({ ...f, code: e.target.value }))}
                        placeholder="Filter code…"
                        className="w-full px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 text-[12px] focus:border-blue-500 focus:outline-none"
                      />
                      {colFilters.code && (
                        <button
                          type="button"
                          onClick={() => setColFilters((f) => ({ ...f, code: '' }))}
                          className="mt-1.5 text-[11px] text-blue-600 hover:text-blue-700 font-medium"
                        >
                          Clear
                        </button>
                      )}
                    </ColumnHeaderWithFilter>
                  </th>
                  <th className="px-4 py-3 text-left font-semibold">
                    <ColumnHeaderWithFilter
                      label="Project Name"
                      isOpen={openColFilter === 'name'}
                      onToggle={() => setOpenColFilter((c) => c === 'name' ? null : 'name')}
                      value={colFilters.name}
                      hasFilter={!!colFilters.name}
                    >
                      <input
                        type="text"
                        autoFocus
                        value={colFilters.name}
                        onChange={(e) => setColFilters((f) => ({ ...f, name: e.target.value }))}
                        placeholder="Filter name…"
                        className="w-full px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 text-[12px] focus:border-blue-500 focus:outline-none"
                      />
                      {colFilters.name && (
                        <button
                          type="button"
                          onClick={() => setColFilters((f) => ({ ...f, name: '' }))}
                          className="mt-1.5 text-[11px] text-blue-600 hover:text-blue-700 font-medium"
                        >
                          Clear
                        </button>
                      )}
                    </ColumnHeaderWithFilter>
                  </th>
                  {/* Team Leader is no longer a static column — it's just
                      another Project Role Type now (seeded as
                      'team_leader'). Add it via Columns customizer if
                      you want it on screen. */}
                  {/* Dynamic role-type columns — order follows the catalog
                      sortOrder via visibleRoleColumns. Each column gets
                      an in-header filter (QA3 · A · item 2) sourced from
                      the assignee.displayName values actually present in
                      the loaded rows for THAT role. Empty option list →
                      chevron hidden. */}
                  {visibleRoleColumns.map((rt) => {
                    const roleKey = `role:${rt.id}`;
                    const opts = roleFilterOptionsByRoleId.get(rt.id) ?? [];
                    const current = colFilters.roles[rt.id] ?? '';
                    return (
                      <th key={rt.id} className="px-4 py-3 text-left font-semibold">
                        {opts.length === 0 ? (
                          rt.name
                        ) : (
                          <ColumnHeaderWithFilter
                            label={rt.name}
                            isOpen={openColFilter === roleKey}
                            onToggle={() => setOpenColFilter((c) => c === roleKey ? null : roleKey)}
                            value={current}
                            hasFilter={!!current}
                          >
                            <select
                              autoFocus
                              value={current}
                              onChange={(e) => setColFilters((f) => ({
                                ...f,
                                roles: { ...f.roles, [rt.id]: e.target.value },
                              }))}
                              className="w-full px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 text-[12px] focus:border-blue-500 focus:outline-none"
                            >
                              <option value="">All {rt.name.toLowerCase()}</option>
                              {opts.map((o) => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                            {current && (
                              <button
                                type="button"
                                onClick={() => setColFilters((f) => ({
                                  ...f,
                                  roles: { ...f.roles, [rt.id]: '' },
                                }))}
                                className="mt-1.5 text-[11px] text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium"
                              >
                                Clear
                              </button>
                            )}
                          </ColumnHeaderWithFilter>
                        )}
                      </th>
                    );
                  })}
                  {/* Department column removed (V3) — field is unused. */}
                  <th className="px-4 py-3 text-left font-semibold">
                    {/* Status per-column filter (QA3 · A · item 2). The
                        top-level status <select> above already narrows
                        server-side by a single status; this in-header
                        picker narrows the client view within whatever
                        the server returned, sourced from distinct
                        statuses actually present. Hidden when only one
                        status is on screen. */}
                    {statusFilterOptions.length === 0 ? (
                      'Status'
                    ) : (
                      <ColumnHeaderWithFilter
                        label="Status"
                        isOpen={openColFilter === 'status'}
                        onToggle={() => setOpenColFilter((c) => c === 'status' ? null : 'status')}
                        value={colFilters.status}
                        hasFilter={!!colFilters.status}
                      >
                        <select
                          autoFocus
                          value={colFilters.status}
                          onChange={(e) => setColFilters((f) => ({ ...f, status: e.target.value }))}
                          className="w-full px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 text-[12px] focus:border-blue-500 focus:outline-none"
                        >
                          <option value="">All statuses</option>
                          {statusFilterOptions.map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                        {colFilters.status && (
                          <button
                            type="button"
                            onClick={() => setColFilters((f) => ({ ...f, status: '' }))}
                            className="mt-1.5 text-[11px] text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium"
                          >
                            Clear
                          </button>
                        )}
                      </ColumnHeaderWithFilter>
                    )}
                  </th>
                  <th className="px-4 py-3 text-left font-semibold">
                    {/* Category filter — options derived from rawList
                        via categoryFilterOptions memo. Hidden when
                        there's nothing to pick between. */}
                    {categoryFilterOptions.length === 0 ? (
                      'Category'
                    ) : (
                      <ColumnHeaderWithFilter
                        label="Category"
                        isOpen={openColFilter === 'type'}
                        onToggle={() => setOpenColFilter((c) => c === 'type' ? null : 'type')}
                        value={colFilters.type}
                        hasFilter={!!colFilters.type}
                      >
                        <select
                          autoFocus
                          value={colFilters.type}
                          onChange={(e) => setColFilters((f) => ({ ...f, type: e.target.value }))}
                          className="w-full px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 text-[12px] focus:border-blue-500 focus:outline-none"
                        >
                          <option value="">All categories</option>
                          {categoryFilterOptions.map(([id, name]) => (
                            <option key={id} value={String(id)}>{name}</option>
                          ))}
                        </select>
                        {colFilters.type && (
                          <button
                            type="button"
                            onClick={() => setColFilters((f) => ({ ...f, type: '' }))}
                            className="mt-1.5 text-[11px] text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium"
                          >
                            Clear
                          </button>
                        )}
                      </ColumnHeaderWithFilter>
                    )}
                  </th>
                  {/* Finance-gated columns. Hidden entirely when the
                      caller lacks finance:read so the table degrades
                      to a hours/team/status view (still useful for
                      non-finance project managers). */}
                  {showFinance && (
                    <>
                      <th className="px-4 py-3 text-right font-semibold">Budget</th>
                    </>
                  )}
                  <th className="px-4 py-3 text-center font-semibold">Completion</th>
                  {showFinance && (
                    <>
                      <th className="px-4 py-3 text-right font-semibold">Cost</th>
                      <th className="px-4 py-3 text-right font-semibold">Hours</th>
                    </>
                  )}
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
                      <tr className="bg-slate-100/80 dark:bg-slate-800/80 border-y border-slate-200 dark:border-slate-700">
                        <td
                          colSpan={(showFinance ? 11 : 8) + visibleRoleColumns.length}
                          className="px-4 py-2 text-[12px] font-bold text-slate-700 dark:text-slate-200"
                        >
                          {g.label}
                          <span className="ml-3 font-normal text-slate-500 dark:text-slate-400">
                            · {g.items.length} project{g.items.length === 1 ? '' : 's'}
                          </span>
                        </td>
                      </tr>
                    )}
                    {g.items.map((p: any, idx: number) => {
                  // Status swatch moved into <StatusCell/> — the read-
                  // only badge and the inline <select> both live there.
                  const leader = p.leader;
                  const taskCount = p._count?.tasks ?? 0;
                  // Server-side rollup from `projects.service#findAll` —
                  // budget-hours-weighted mean of task.completionPct with
                  // a simple-mean fallback (matches the in-project
                  // Progress engine). Clamp defensively — a stray
                  // out-of-range value shouldn't blow the bar layout.
                  const completionRate = Math.max(
                    0,
                    Math.min(100, Math.round(Number(p.completionPct ?? 0))),
                  );
                  const dept = p.department?.name ?? '-';
                  // Category cell reads `projectType` directly (single FK
                  // via `projects.service#findAll`). The historical
                  // `p.categories` (many-to-many service-types) is a
                  // decorative field that lived elsewhere and was mixed
                  // into this cell in v1 — dropped now that the cell is
                  // inline-editable against `projectTypeId` (spec: single
                  // Category = ProjectType).

                  return (
                    <tr key={p.id}
                      className={cn('border-b border-slate-100 dark:border-slate-800 hover:bg-blue-50/30 transition-colors',
                        idx % 2 === 0 ? 'bg-white dark:bg-slate-900' : 'bg-slate-50/30')}>
                      {/* Navigation lives on the project-code and name
                          cells ONLY. Using react-router's <Link> so we
                          get a real <a> — keyboard focus, Enter to open,
                          Ctrl/Cmd-click for new-tab, screen-reader
                          "link" role for free. Every other cell is now
                          non-navigating, freeing them for inline editors
                          (status, role holders) without needing defensive
                          stopPropagation on every control. */}
                      <td className="px-4 py-3 font-mono whitespace-nowrap">
                        <Link
                          to={`/projects/${p.id}`}
                          className="text-slate-500 dark:text-slate-400 hover:text-blue-600 hover:underline focus:outline-none focus-visible:text-blue-600 focus-visible:underline"
                        >
                          {p.number || '-'}
                        </Link>
                      </td>
                      <td className="px-4 py-3 max-w-[280px]">
                        {/* Long project names were overflowing the cell
                            (no min-w-0 on the parent flex/grid context,
                            no truncate on the inner <p>). Cap the cell
                            at 280px and truncate with a hover tooltip
                            so the full name is still discoverable. */}
                        <Link
                          to={`/projects/${p.id}`}
                          className="block font-semibold text-slate-800 dark:text-slate-100 truncate hover:text-blue-600 hover:underline focus:outline-none focus-visible:text-blue-600 focus-visible:underline"
                          title={p.name}
                        >
                          {p.name}
                        </Link>
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
                        const assignments = ((p.partnerRoles ?? []) as any[])
                          .filter((r: any) => r.roleId === rt.id)
                          .sort((a: any, b: any) => Number(b.isPrimary) - Number(a.isPrimary));
                        return (
                          <td key={rt.id} className="px-4 py-3">
                            <RoleHolderCell
                              projectId={p.id}
                              roleName={rt.name}
                              assignments={assignments}
                              canEdit={canWritePartners}
                              onSave={(nextUserIds, candidates) => saveRoleHolders({
                                projectId: p.id,
                                roleId: rt.id,
                                currentAssignments: assignments.map((a: any) => ({
                                  id: a.id,
                                  partyId: a.party?.id ?? null,
                                  userId: a.party?.user?.id ?? null,
                                })),
                                nextUserIds,
                                candidates,
                              })}
                            />
                          </td>
                        );
                      })}
                      {/* Department cell removed (V3) — header dropped above. */}
                      <td className="px-4 py-3">
                        <StatusCell
                          value={p.status}
                          canEdit={canWriteProjects}
                          onChange={(status) => updateProjectStatus.mutate({ id: p.id, status })}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <CategoryCell
                          value={p.projectType ?? null}
                          options={projectTypesQuery.data ?? []}
                          canEdit={canWriteProjects}
                          onChange={(projectTypeId) => updateProjectCategory.mutate({ id: p.id, projectTypeId })}
                        />
                      </td>
                      {/* Finance-gated cells — mirror the header gates
                          so the row stays column-aligned for either
                          permission state. */}
                      {showFinance && (
                        <td className="px-4 py-3 text-right font-mono text-slate-700 dark:text-slate-200">
                          {p.budget ? `₪${Number(p.budget).toLocaleString()}` : '-'}
                        </td>
                      )}
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <div className="w-16 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-500 rounded-full" style={{ width: `${completionRate}%` }} />
                          </div>
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">{completionRate}%</span>
                        </div>
                      </td>
                      {showFinance && (
                        <>
                          {/* Cost — rolled-up labor cost from `findAll`.
                              Finance-gated on the server (stripped by
                              omitBudget when the caller lacks
                              finance:read), so under the `showFinance`
                              client gate it's always present when
                              non-zero. Formatted like Budget above. */}
                          <td className="px-4 py-3 text-right font-mono text-slate-700 dark:text-slate-200">
                            {p.actualCost && Number(p.actualCost) > 0
                              ? `₪${Number(p.actualCost).toLocaleString()}`
                              : '-'}
                          </td>
                          {/* Hours — rolled-up logged hours (task-
                              scoped, includes unrateable minutes to
                              match `getLaborCost#totalLoggedHours`).
                              tabular-nums keeps the column tidy. */}
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">
                            {p.actualHours && Number(p.actualHours) > 0
                              ? `${Number(p.actualHours).toFixed(1)}h`
                              : '-'}
                          </td>
                        </>
                      )}
                      <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-center gap-0.5">
                          <button onClick={() => { setChatProjectId(p.id); setChatProjectName(p.name); }}
                            title="Project discussion"
                            className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-blue-600 hover:bg-blue-50 transition-colors">
                            <MessageSquare className="h-3.5 w-3.5" />
                          </button>
                          {leader && (
                            <button onClick={() => { setChatProjectId(p.id); setChatProjectName(`Message to ${leader.firstName}`); }}
                              title={`Quick message to ${leader.firstName} ${leader.lastName}`}
                              className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-emerald-600 hover:bg-emerald-50 transition-colors">
                              <Send className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                        <button onClick={async () => { if (await confirm(`Delete "${p.name}"?`)) deleteProject.mutate(p.id); }}
                          className="w-7 h-7 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-red-600 hover:bg-red-50 transition-colors">
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

/**
 * Table-column header with a small filter chevron on the right. Click
 * the chevron to open a compact popover with the filter control
 * (input, select — any children). Closes on outside click.
 *
 * Tier C #3 — per-column filtering on the Projects list, 2026-06-30.
 * The `label` retains its uppercase-tracked look; the chevron tints
 * blue when a filter is active so the user can see at a glance
 * which columns are narrowed.
 */
function ColumnHeaderWithFilter({
  label,
  isOpen,
  onToggle,
  hasFilter,
  children,
}: {
  label: string;
  isOpen: boolean;
  onToggle: () => void;
  value?: string;
  hasFilter: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onToggle();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [isOpen, onToggle]);
  return (
    <div ref={ref} className="relative inline-flex items-center gap-1">
      <span>{label}</span>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'flex items-center justify-center w-[16px] h-[16px] rounded transition-colors',
          hasFilter ? 'text-blue-600' : 'text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-100',
        )}
        aria-label={`Filter ${label}`}
        title={hasFilter ? `${label} is filtered` : `Filter ${label}`}
      >
        <ChevronDown className="h-3 w-3" />
      </button>
      {isOpen && (
        <div className="absolute left-0 top-full z-40 mt-1 w-[240px] rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.12)] border border-black/5 bg-white dark:bg-slate-900 p-3">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Status cell — badge by default, click → native <select> in place.
 *
 * The four active statuses match what the top status filter offers
 * (:334–337) and what the seed enums accept. `close` / `reopen` is
 * a separate axis (project.closedAt timestamp) with its own dedicated
 * POST endpoints and is NOT surfaced here — mixing them into the same
 * dropdown blurred the user's mental model in prior rounds.
 *
 * UX contract:
 *   • Read-only when `canEdit=false` — click is a no-op.
 *   • Click → open <select> autofocused and pre-open (size=1 to keep
 *     it compact; the browser handles the native option list).
 *   • Change → commit (blur is implicit after the pick).
 *   • Escape → cancel + revert to badge.
 *   • Blur without a change → cancel + revert to badge.
 *   • The select's own events don't bubble; the row has no onClick
 *     any more but any table-level handler further up won't fire.
 */
function StatusCell({
  value,
  canEdit,
  onChange,
}: {
  value: string;
  canEdit: boolean;
  onChange: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (editing) {
      // Focus + open the dropdown on the same frame the <select>
      // mounts so the picker feels click-through.
      queueMicrotask(() => selectRef.current?.focus());
    }
  }, [editing]);

  const st = statusColors[value] ?? statusColors.draft;

  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (canEdit) setEditing(true);
        }}
        disabled={!canEdit}
        title={canEdit ? 'Change status' : undefined}
        aria-label={canEdit ? `Change status (currently ${st.label})` : `Status: ${st.label}`}
        className={cn(
          'rounded-[5px] px-2 py-0.5 text-[10px] font-bold',
          st.bg,
          st.text,
          canEdit && 'cursor-pointer hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
          !canEdit && 'cursor-default',
        )}
      >
        {st.label}
      </button>
    );
  }

  return (
    <select
      ref={selectRef}
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        const next = e.target.value;
        setEditing(false);
        if (next !== value) onChange(next);
      }}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          setEditing(false);
        }
      }}
      className="rounded-[5px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
    >
      {/* Only the four editable-in-place statuses — closed is a
          separate action (POST /projects/:id/close|reopen). */}
      <option value="draft">Draft</option>
      <option value="active">Active</option>
      <option value="on_hold">On Hold</option>
      <option value="completed">Completed</option>
    </select>
  );
}

/**
 * Category (project-type) cell — plain-text pill by default, click →
 * native <select> in place. Mirrors StatusCell's contract exactly:
 *
 *   • Read-only when `canEdit=false` — click is a no-op.
 *   • Click → open <select> autofocused so the picker feels
 *     click-through.
 *   • Change → commit; Escape / blur without change → cancel + revert.
 *   • stopPropagation on click / change / keydown so the row navigation
 *     (project-code and name cells) never fires.
 *
 * Options come from `useProjectTypes()` cached upstream — the same
 * `/admin/config/project-types` catalog the New-Project form uses (PR-021).
 * We render `— None` for `projectTypeId=null` so a legacy project without
 * a category still surfaces something clickable. The <select> deliberately
 * does NOT expose a "None" write value: `CreateProjectDto.projectTypeId`
 * is required, so clearing it via PATCH would 400 — the write only
 * offers real catalog ids.
 *
 * QA3 · A · item 1.
 */
function CategoryCell({
  value,
  options,
  canEdit,
  onChange,
}: {
  value: { id: number; name: string; color?: string | null } | null;
  options: Array<{ id: number; name: string; color?: string | null }>;
  canEdit: boolean;
  onChange: (nextTypeId: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (editing) {
      queueMicrotask(() => selectRef.current?.focus());
    }
  }, [editing]);

  const label = value?.name ?? '—';

  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (canEdit) setEditing(true);
        }}
        disabled={!canEdit}
        title={canEdit ? 'Change category' : undefined}
        aria-label={canEdit ? `Change category (currently ${label})` : `Category: ${label}`}
        className={cn(
          'block w-full rounded-md text-left text-slate-600 dark:text-slate-300 -mx-1 px-1 py-0.5',
          canEdit && 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
          !canEdit && 'cursor-default',
        )}
      >
        {label}
      </button>
    );
  }

  return (
    <select
      ref={selectRef}
      value={value?.id ?? ''}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        const nextId = Number(e.target.value);
        setEditing(false);
        if (!Number.isFinite(nextId) || nextId <= 0) return;
        if (nextId === value?.id) return;
        onChange(nextId);
      }}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          setEditing(false);
        }
      }}
      className="rounded-[5px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
    >
      {/* Placeholder when the project has no category set — kept
          disabled so a user can't PATCH projectTypeId to an invalid
          value (server DTO makes it required). */}
      {value?.id == null && <option value="" disabled>— None</option>}
      {options.map((t) => (
        <option key={t.id} value={t.id}>{t.name}</option>
      ))}
    </select>
  );
}

/**
 * Role-holder cell — displays the active assignees for one role
 * column, and swaps to an in-cell PeopleMultiSelect when the user
 * clicks (if they hold partners:write).
 *
 * Candidates fetch is lazy — /projects/:id/assignee-candidates
 * only fires the first time the user opens THIS cell, so we don't
 * spam the API with N×M requests for every row × role column on
 * page load. Cached under ['assignee-candidates', projectId] so
 * multiple role columns on the same row share the same fetch.
 *
 * canAssign=false candidates (external contacts with no linked User
 * — TaskAssignee.userId still writes to User.id, so they cannot be
 * chosen as an assignee). PeopleMultiSelect keys on `userId` and
 * has no disabled-option affordance today, so we filter them out
 * before feeding the picker — see "Follow-up" in the branch report.
 * Once the picker grows a `disabled` prop, drop the filter and pass
 * the full list with a disabled reason.
 *
 * Save flow:
 *   1. On popover close (blur / outside-click), diff nextValue
 *      against the currently-selected userIds and hand the delta
 *      to onSave (the parent computes party ids, fires POST/DELETE,
 *      invalidates ['projects']).
 *   2. Toast on error (parent's mutation), otherwise the invalidated
 *      list refetch redraws the cell.
 */
function RoleHolderCell({
  projectId,
  roleName,
  assignments,
  canEdit,
  onSave,
}: {
  projectId: number;
  roleName: string;
  assignments: any[];
  canEdit: boolean;
  onSave: (
    nextUserIds: number[],
    candidates: Array<{ userId: number | null; partyId: number | null }>,
  ) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  // Buffer the picker's selection so the parent only sees the final
  // diff on close (avoids one POST/DELETE per option toggle).
  const [buffer, setBuffer] = useState<number[] | null>(null);

  // Current-holder ids (userId only — external contacts without a
  // User row aren't representable in the picker keyed on userId).
  // Filter to non-null so a mixed row (person with User + external
  // contact without) still initializes the picker with the assignable
  // subset. External holders remain visible in the read-only summary.
  const currentUserIds = useMemo(
    () => assignments
      .map((a: any) => a?.party?.user?.id)
      .filter((u: any): u is number => typeof u === 'number'),
    [assignments],
  );

  // Lazy candidates fetch — only kick off when the user opens the
  // picker on this row. Shared across role columns on the same
  // project via the query key.
  const { data: candidates = [] } = useQuery<
    Array<{
      userId: number | null;
      partyId: number | null;
      displayName: string;
      avatarUrl: string | null;
      role: string | null;
      discipline: string | null;
      canAssign: boolean;
    }>
  >({
    queryKey: ['assignee-candidates', projectId],
    enabled: open,
    staleTime: 60 * 1000,
    queryFn: () =>
      client.get(`/projects/${projectId}/assignee-candidates`).then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  // Only assignable rows go into the picker (see docstring). Map to
  // the PeopleMultiSelect `Person` shape.
  const people = useMemo(
    () => candidates
      .filter((c) => c.canAssign && c.userId != null)
      .map((c) => ({
        userId: c.userId as number,
        displayName: c.displayName,
        avatarUrl: c.avatarUrl,
        subtitle: c.discipline ?? c.role ?? null,
      })),
    [candidates],
  );

  // Read-only display — click opens the picker (when allowed). We
  // deliberately match the pre-edit markup so the layout doesn't
  // shift when a user without permission views the same cell.
  const summary = (
    <div className={cn(
      'flex flex-col gap-0.5 text-[12px]',
      assignments.length === 0 && 'text-slate-300 dark:text-slate-600',
    )}>
      {assignments.length === 0 ? (
        <span>—</span>
      ) : (
        assignments.map((a: any) => (
          <span
            key={a.id}
            className={cn(
              'truncate',
              a.isPrimary ? 'font-semibold text-slate-800 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300',
            )}
            title={a.titleInProject ? `${a.party.displayName} — ${a.titleInProject}` : a.party.displayName}
          >
            {a.party.displayName}
          </span>
        ))
      )}
    </div>
  );

  if (!canEdit) return summary;

  // Editor open — mount the PeopleMultiSelect. Its own popover floats
  // attached, so we keep it visually "in-cell" (the trigger lives in
  // the cell). Wrap in a container that swallows clicks so the popover
  // interaction doesn't propagate to any table-level handler.
  if (open) {
    return (
      <div
        className="relative"
        onClick={(e) => e.stopPropagation()}
      >
        <PeopleMultiSelect
          people={people}
          value={buffer ?? currentUserIds}
          onChange={(ids) => setBuffer(ids)}
          placeholder="Add holder…"
          title={`Edit ${roleName}`}
          triggerClassName="min-w-[220px]"
        />
        {/* Commit button — small, so a picker close can happen via
            the built-in outside-click OR the explicit save. On save,
            hand the diff up and close. */}
        <div className="mt-1 flex gap-1">
          <button
            type="button"
            onClick={async () => {
              const nextIds = buffer ?? currentUserIds;
              setOpen(false);
              setBuffer(null);
              await onSave(nextIds, candidates);
            }}
            className="rounded-lg bg-blue-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-700"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); setBuffer(null); }}
            className="rounded-lg border border-slate-200 dark:border-slate-700 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      title={`Edit ${roleName}`}
      className="block w-full rounded-md text-left hover:bg-slate-50 dark:hover:bg-slate-800/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 -mx-1 px-1 py-0.5"
    >
      {summary}
    </button>
  );
}
