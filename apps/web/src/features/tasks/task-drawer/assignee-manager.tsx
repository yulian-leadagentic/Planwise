import { useState } from 'react';
import { X, UserPlus, Search } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { tasksApi } from '@/api/tasks.api';
import { queryKeys } from '@/lib/query-keys';

export function AssigneeManager({ taskId, assignees }: { taskId: number; assignees: any[] }) {
  const queryClient = useQueryClient();
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState('');

  const { data: users = [] } = useQuery({
    queryKey: queryKeys.users.list(),
    queryFn: () => client.get('/users').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
    staleTime: 5 * 60 * 1000,
    enabled: showPicker,
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
  const filtered = (users as any[]).filter((u: any) => {
    if (assignedIds.has(u.id)) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return `${u.firstName} ${u.lastName}`.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q);
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
          <div className="max-h-32 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-slate-400 dark:text-slate-500">No users found</p>
            ) : (
              filtered.slice(0, 10).map((u: any) => (
                <button key={u.id} onClick={() => addMutation.mutate(u.id)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <div className="w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-[8px] font-semibold flex items-center justify-center">
                    {(u.firstName?.[0] ?? '')}{(u.lastName?.[0] ?? '')}
                  </div>
                  <span className="text-slate-700 dark:text-slate-200">{u.firstName} {u.lastName}</span>
                </button>
              ))
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
