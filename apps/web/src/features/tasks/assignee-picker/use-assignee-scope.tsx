import { useState } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';

import { projectsApi } from '@/api/projects.api';
import { usersApi } from '@/api/users.api';
import { notify } from '@/lib/notify';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import type { DirectoryUser } from './assignee-options';

/**
 * QA6 package 1 — the "who may I assign" scope of a picker.
 *
 * `canManage` comes from GET /projects/:id (server: assertProjectManage,
 * leader or Admin). Only then can the picker widen to every employee;
 * the directory is fetched only after the toggle is turned on.
 */
export function useAssigneeScope(projectId: number | null | undefined, enabled: boolean) {
  const [showAllEmployees, setShowAllEmployees] = useState(false);
  const { data: project } = useQuery({
    queryKey: ['projects', projectId],
    queryFn: () => projectsApi.get(projectId as number),
    enabled: enabled && !!projectId,
    staleTime: 60 * 1000,
  });
  const canManage = !!(project as { canManage?: boolean } | undefined)?.canManage;
  const { data: allEmployees = [], isFetching: loadingEmployees } = useQuery({
    queryKey: queryKeys.users.allActive(),
    queryFn: () => usersApi.listAllActive(),
    enabled: enabled && canManage && showAllEmployees,
    staleTime: 5 * 60 * 1000,
  });
  return {
    canManage,
    showAllEmployees: canManage && showAllEmployees,
    setShowAllEmployees,
    allEmployees: allEmployees as DirectoryUser[],
    loadingEmployees,
  };
}

/** After POST /tasks/:id/assignees: refresh the Team when the server added him to it. */
export function afterAssigned(
  queryClient: QueryClient,
  projectId: number | null | undefined,
  /** `tasksApi.addAssignee` results: the `{ success, data }` envelope or the row. */
  results: unknown[],
  name: string,
): void {
  const added = (r: any) => r?.addedToTeam === true || r?.data?.addedToTeam === true;
  if (!projectId || !results.some(added)) return;
  queryClient.invalidateQueries({ queryKey: ['assignee-candidates', projectId] });
  queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
  notify.success(`${name} was added to the project team`, { code: 'TEAM-ADD-200' });
}

/** Leader / Admin only: widen the list from the Team to every employee. */
export function AllEmployeesToggle({
  checked,
  onChange,
  loading,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      aria-pressed={checked}
      className={cn(
        'flex w-full items-center gap-1.5 border-t border-slate-100 dark:border-slate-800 px-3 py-1.5 text-[11px] font-medium transition-all duration-150',
        checked
          ? 'text-blue-600 hover:bg-blue-50 dark:hover:bg-slate-800/50'
          : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-blue-600',
      )}
    >
      <Users className="h-3.5 w-3.5" />
      {checked ? 'Show the project team only' : 'Search all employees'}
      {loading && <span className="ml-auto text-slate-400">Loading…</span>}
    </button>
  );
}

/** Under a non-Team person in the widened list. */
export function JoinsTeamNote() {
  return (
    <span dir="rtl" className="block text-[10px] font-medium text-amber-700 dark:text-amber-400">
      יתווסף לצוות הפרויקט
    </span>
  );
}
