import { useState } from 'react';
import { X, UserPlus, Search } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { tasksApi } from '@/api/tasks.api';
import { projectsApi, type AssigneeCandidate } from '@/api/projects.api';
import { queryKeys } from '@/lib/query-keys';

/**
 * Assignee picker inside the task drawer.
 *
 * Branch 2 · fix/assignee-source (PR-001/009). Previously loaded every
 * active User in the org — matched to the drawer, that meant admins
 * assigning to someone who wasn't on the project (and, on projects
 * with the sparse legacy ProjectMember row, the org-wide list masked
 * the missing project team). We now prefer the project-scoped
 * `/projects/:id/assignee-candidates` endpoint — same source the
 * task-tree picker reads, so both surfaces show the same set (Team
 * tab included). Falls back to the org-wide /users list when the task
 * has no projectId (personal tasks — see task-details-tab guard).
 */
export function AssigneeManager({
  taskId,
  projectId,
  assignees,
}: {
  taskId: number;
  projectId?: number | null;
  assignees: any[];
}) {
  const queryClient = useQueryClient();
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState('');

  // Project-scoped candidate list — internal team + role holders,
  // deduped, with `canAssign` reflecting whether the person has a
  // User account behind them.
  const { data: candidates = [] } = useQuery<AssigneeCandidate[]>({
    queryKey: ['assignee-candidates', projectId],
    queryFn: () => projectsApi.listAssigneeCandidates(projectId!),
    staleTime: 60 * 1000,
    enabled: showPicker && !!projectId,
  });

  // Fallback for personal (no-project) tasks — the endpoint above is
  // project-scoped, so a personal task can't use it. We keep the
  // org-wide /users source for that path only.
  const { data: allUsers = [] } = useQuery({
    queryKey: queryKeys.users.list(),
    queryFn: () => client.get('/users').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
    staleTime: 5 * 60 * 1000,
    enabled: showPicker && !projectId,
  });

  const addMutation = useMutation({
    mutationFn: (userId: number) => tasksApi.addAssignee(taskId, { userId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionBoard.all });
      // Auto-close the picker after 3s — the new assignee chip animates
      // in immediately so the user sees the change, but the picker stays
      // open briefly in case they want to add multiple people in a row.
      setSearch('');
      window.setTimeout(() => setShowPicker(false), 3000);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to assign'),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: number) => tasksApi.removeAssignee(taskId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionBoard.all });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove'),
  });

  const assignedIds = new Set((assignees ?? []).map((a: any) => a.user?.id));

  // Normalize both sources (candidate list vs org-wide users) into one
  // display shape so the render below stays a single branch. Rows carry
  // an optional `role`/`discipline` subtitle and a `canAssign` flag —
  // external contacts appear disabled with a tooltip, matching the
  // task-tree picker in planning-modal.
  type PickerRow = {
    key: string;
    userId: number | null;
    firstName: string | null;
    lastName: string | null;
    displayName: string;
    email: string | null;
    role: string | null;
    discipline: string | null;
    canAssign: boolean;
  };
  const rows: PickerRow[] = projectId
    ? (candidates as AssigneeCandidate[]).map((m) => ({
        key: `${m.partyId ?? 'u'}:${m.userId ?? 'x'}`,
        userId: m.userId,
        firstName: m.firstName,
        lastName: m.lastName,
        displayName: m.displayName,
        email: m.email,
        role: m.role,
        discipline: m.discipline,
        canAssign: m.canAssign,
      }))
    : (allUsers as any[]).map((u: any) => ({
        key: `u:${u.id}`,
        userId: u.id,
        firstName: u.firstName ?? null,
        lastName: u.lastName ?? null,
        displayName: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || `User #${u.id}`,
        email: u.email ?? null,
        role: null,
        discipline: u.position ?? u.department ?? null,
        canAssign: true,
      }));

  const filtered = rows.filter((r) => {
    if (r.userId != null && assignedIds.has(r.userId)) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const name = `${r.firstName ?? ''} ${r.lastName ?? ''} ${r.displayName}`.toLowerCase();
    return name.includes(q)
      || (r.email?.toLowerCase().includes(q) ?? false)
      || (r.role?.toLowerCase().includes(q) ?? false)
      || (r.discipline?.toLowerCase().includes(q) ?? false);
  });

  return (
    <div>
      <div className="flex items-center justify-between">
        {/* Header was previously slate-400 ("Assignees") — too low-contrast,
            and users couldn't tell whether the block belonged to the task
            or to the project (#55). Bumped to readable weight and renamed
            to "Assigned to this task" so the scope is unambiguous. */}
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200">
            Assigned to this task
          </label>
          <p className="text-[10.5px] text-slate-500 dark:text-slate-400 leading-tight">
            People responsible for completing this task.
          </p>
        </div>
        <button onClick={() => setShowPicker(!showPicker)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-blue-600 hover:bg-blue-50">
          <UserPlus className="h-3 w-3" /> Assign
        </button>
      </div>

      {showPicker && (
        <div className="mt-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
          <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 px-2.5 py-2">
            <Search className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people..."
              className="flex-1 bg-transparent text-[12px] outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500" autoFocus />
          </div>
          <div className="max-h-40 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-slate-400 dark:text-slate-500">
                {projectId && rows.length === 0
                  ? 'No project members yet'
                  : 'No users found'}
              </p>
            ) : (
              filtered.slice(0, 10).map((r) => {
                const disabled = !r.canAssign || r.userId == null;
                const name = `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || r.displayName;
                const initials = ((r.firstName?.[0] ?? '') + (r.lastName?.[0] ?? '')) || name[0] || '?';
                const title = disabled
                  ? 'External contact — no user account, cannot be task-assigned. Ask an admin to invite them.'
                  : (r.role || r.discipline || name);
                return (
                  <button
                    key={r.key}
                    disabled={disabled}
                    onClick={() => { if (!disabled && r.userId != null) addMutation.mutate(r.userId); }}
                    title={title}
                    className={cn(
                      'flex w-full items-start gap-2 px-3 py-1.5 text-[12px]',
                      disabled
                        ? 'opacity-60 cursor-not-allowed'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
                    )}
                  >
                    <div className={cn(
                      'mt-0.5 w-5 h-5 rounded-full text-[8px] font-semibold flex items-center justify-center shrink-0',
                      disabled
                        ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500'
                        : 'bg-blue-100 text-blue-600',
                    )}>
                      {initials}
                    </div>
                    <span className="flex-1 min-w-0 text-left">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-slate-700 dark:text-slate-200">{name}</span>
                        {disabled && (
                          <span className="rounded bg-amber-100 text-amber-700 text-[9px] font-semibold px-1 py-[1px] shrink-0">
                            External
                          </span>
                        )}
                      </span>
                      {(r.role || r.discipline) && (
                        <span className="block truncate text-[10px] text-slate-500 dark:text-slate-400">
                          {[r.role, r.discipline].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      <div className="mt-1.5 space-y-1">
        {(assignees ?? []).length === 0 && !showPicker ? (
          <p className="text-[12px] text-slate-400 dark:text-slate-500 italic">No assignees</p>
        ) : (
          (assignees ?? []).map((a: any) => (
            <div key={a.id} className="flex items-center gap-2 rounded-md bg-slate-50 dark:bg-slate-800/50 px-2 py-1.5 group">
              <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-600 text-[9px] font-semibold flex items-center justify-center">
                {(a.user?.firstName?.[0] ?? '') + (a.user?.lastName?.[0] ?? '')}
              </div>
              <span className="flex-1 text-[12px] text-slate-700 dark:text-slate-200">{a.user?.firstName} {a.user?.lastName}</span>
              {a.role && <span className="text-[10px] text-slate-400 dark:text-slate-500">({a.role})</span>}
              <button
                onClick={() => removeMutation.mutate(a.user?.id)}
                aria-label={`Remove ${a.user?.firstName ?? 'assignee'}`}
                className="opacity-60 group-hover:opacity-100 rounded p-1.5 text-slate-500 dark:text-slate-400 hover:text-red-600 hover:bg-red-50 transition-opacity">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
