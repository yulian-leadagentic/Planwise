import { useState } from 'react';
import { X, UserPlus, Search } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usersApi } from '@/api/users.api';
import { notify } from '@/lib/notify';
import { tasksApi } from '@/api/tasks.api';
import { projectsApi, type AssigneeCandidate } from '@/api/projects.api';
import { queryKeys } from '@/lib/query-keys';
import { buildAssigneeOptions, employeeOptions, matchesSearch, type AssigneeOption } from '../assignee-picker/assignee-options';
import { useAssigneeScope, afterAssigned, AllEmployeesToggle, JoinsTeamNote } from '../assignee-picker/use-assignee-scope';
import { TeamJoinRequest } from '../assignee-picker/team-join-request-button';

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
 *
 * QA6 package 1: the list is the project's Team, employees only;
 * external contacts never appear. A leader / Admin can widen it to every
 * employee; a non-Team pick is marked "יתווסף לצוות הפרויקט" and the
 * server adds him to the Team as a participant before assigning.
 *
 * QA6 decision 2: a viewer who is not on the Team and cannot manage the
 * project cannot assign himself; the picker ends with "בקש ממנהל הפרויקט
 * להוסיף אותך" instead (POST /projects/:id/team-requests).
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
  // Every active user (all pages) — a bare GET /users returned only the
  // first 20, so most people were missing from this picker.
  const { data: allUsers = [] } = useQuery({
    queryKey: queryKeys.users.allActive(),
    queryFn: () => usersApi.listAllActive(),
    staleTime: 5 * 60 * 1000,
    enabled: showPicker && !projectId,
  });

  // QA6 — leader / Admin may widen the list to every employee.
  const scope = useAssigneeScope(projectId, showPicker);

  const addMutation = useMutation({
    mutationFn: (option: AssigneeOption) => tasksApi.addAssignee(taskId, { userId: option.userId }),
    onSuccess: (result, option) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionBoard.all });
      afterAssigned(queryClient, projectId, [result], option.displayName);
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

  const assignedIds = new Set<number>(
    (assignees ?? []).map((a: any) => a.user?.id).filter((id: unknown): id is number => typeof id === 'number'),
  );

  // Team (employees only) by default; every employee for a leader / Admin
  // who turned the toggle on. A personal task has no Team: every
  // employee, never an external contact.
  const rowsBeforeSearch: AssigneeOption[] = projectId
    ? buildAssigneeOptions({
        candidates: candidates as AssigneeCandidate[],
        allEmployees: scope.allEmployees,
        canManage: scope.canManage,
        showAllEmployees: scope.showAllEmployees,
        assignedUserIds: assignedIds,
      })
    : employeeOptions(allUsers as any[], true).filter((o) => !assignedIds.has(o.userId));
  const filtered = rowsBeforeSearch.filter((o) => matchesSearch(o, search));

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
                {projectId && rowsBeforeSearch.length === 0 && !search.trim()
                  ? 'No one on the project team to assign'
                  : 'No users found'}
              </p>
            ) : (
              filtered.slice(0, scope.showAllEmployees ? 30 : 10).map((r) => {
                const name = `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || r.displayName;
                const initials = ((r.firstName?.[0] ?? '') + (r.lastName?.[0] ?? '')) || name[0] || '?';
                return (
                  <button
                    key={r.key}
                    disabled={addMutation.isPending}
                    onClick={() => addMutation.mutate(r)}
                    title={r.onTeam ? (r.role || r.discipline || name) : `${name} will be added to the project team`}
                    className="flex w-full items-start gap-2 px-3 py-1.5 text-[12px] hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  >
                    <div className="mt-0.5 w-5 h-5 rounded-full text-[8px] font-semibold flex items-center justify-center shrink-0 bg-blue-100 text-blue-600">
                      {initials}
                    </div>
                    <span className="flex-1 min-w-0 text-left">
                      <span className="block truncate text-slate-700 dark:text-slate-200">{name}</span>
                      {(r.role || r.discipline) && (
                        <span className="block truncate text-[10px] text-slate-500 dark:text-slate-400">
                          {[r.role, r.discipline].filter(Boolean).join(' · ')}
                        </span>
                      )}
                      {!r.onTeam && <JoinsTeamNote />}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {projectId && scope.canManage && (
            <AllEmployeesToggle
              checked={scope.showAllEmployees}
              onChange={scope.setShowAllEmployees}
              loading={scope.loadingEmployees}
            />
          )}
          {/* QA6 decision 2 — not on the Team and not a manager: he is not
              in the list and cannot assign himself; he asks instead. */}
          {projectId && scope.selfAssign === 'request' && (
            <TeamJoinRequest projectId={projectId} className="border-t border-slate-100 dark:border-slate-800" />
          )}
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
