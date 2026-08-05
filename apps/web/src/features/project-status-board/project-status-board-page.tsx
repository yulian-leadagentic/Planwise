/**
 * Project Status Board — Notion-style table where rows = projects and
 * columns = stage milestones (URS Production, Architectural Review,
 * Stage 1, …). Each cell is a checkbox the user toggles to mark the
 * milestone complete on that project.
 *
 * Two columns are always shown leftmost (Year + Project Name); the rest
 * are admin-managed via the project_stage_milestones table (seed in
 * migration 20260521020000).
 */
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import client from '@/api/client';

interface Milestone {
  id: number;
  code: string;
  name: string;
  description: string | null;
  sortOrder: number;
}

interface ProjectRow {
  id: number;
  name: string;
  number: string | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
  year: number | null;
  statuses: Record<number, { isCompleted: boolean; completedAt: string | null }>;
}

interface BoardData {
  milestones: Milestone[];
  projects: ProjectRow[];
}

export function ProjectStatusBoardPage() {
  const scrollRef = useStickyHScroll();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<BoardData>({
    queryKey: ['project-status-board'],
    queryFn: () =>
      client.get('/project-status-board').then((r) => r.data?.data ?? r.data),
    staleTime: 30 * 1000,
  });

  // Optimistic toggle: flip the local cell immediately so the user sees
  // the click land, then write through and reconcile on success.
  const toggle = useMutation({
    mutationFn: ({ projectId, milestoneId }: { projectId: number; milestoneId: number }) =>
      client.post(`/project-status-board/toggle/${projectId}/${milestoneId}`).then((r) => r.data),
    onMutate: async ({ projectId, milestoneId }) => {
      await queryClient.cancelQueries({ queryKey: ['project-status-board'] });
      const prev = queryClient.getQueryData<BoardData>(['project-status-board']);
      if (prev) {
        const next: BoardData = {
          ...prev,
          projects: prev.projects.map((p) => {
            if (p.id !== projectId) return p;
            const cur = p.statuses[milestoneId]?.isCompleted ?? false;
            return {
              ...p,
              statuses: {
                ...p.statuses,
                [milestoneId]: { isCompleted: !cur, completedAt: !cur ? new Date().toISOString() : null },
              },
            };
          }),
        };
        queryClient.setQueryData(['project-status-board'], next);
      }
      return { prev };
    },
    onError: (err: any, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['project-status-board'], ctx.prev);
      notify.apiError(err, 'Failed to update milestone');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['project-status-board'] });
    },
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Project Status Board"
        description="Project × milestone checkpoint matrix. Click a cell to toggle the milestone as complete."
      />

      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">Loading…</div>
      ) : !data || data.projects.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500 italic">No active projects.</div>
      ) : (
        <div ref={scrollRef} className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                <th className="sticky left-0 z-10 bg-slate-50 dark:bg-slate-800/50 px-3 py-3 text-left font-semibold w-16">Year</th>
                <th className="sticky left-16 z-10 bg-slate-50 dark:bg-slate-800/50 px-3 py-3 text-left font-semibold min-w-[200px]">Project</th>
                {data.milestones.map((m) => (
                  <th
                    key={m.id}
                    className="px-3 py-3 text-center font-semibold min-w-[120px]"
                    title={m.description ?? undefined}
                  >
                    {m.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.projects.map((p, idx) => (
                <tr
                  key={p.id}
                  className={cn(
                    'border-b border-slate-100 dark:border-slate-800',
                    idx % 2 === 0 ? 'bg-white dark:bg-slate-900' : 'bg-slate-50/30',
                  )}
                >
                  <td className={cn(
                    'sticky left-0 z-10 px-3 py-2 text-slate-500 dark:text-slate-400 tabular-nums',
                    idx % 2 === 0 ? 'bg-white dark:bg-slate-900' : 'bg-slate-50/30',
                  )}>
                    {p.year ?? '—'}
                  </td>
                  <td className={cn(
                    'sticky left-16 z-10 px-3 py-2 max-w-[260px]',
                    idx % 2 === 0 ? 'bg-white dark:bg-slate-900' : 'bg-slate-50/30',
                  )}>
                    <Link
                      to={`/projects/${p.id}`}
                      className="block font-medium text-slate-800 dark:text-slate-100 hover:text-blue-600 truncate"
                      title={p.name}
                    >
                      {p.name}
                    </Link>
                    {p.number && (
                      <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">{p.number}</span>
                    )}
                  </td>
                  {data.milestones.map((m) => {
                    const status = p.statuses[m.id];
                    const checked = !!status?.isCompleted;
                    return (
                      <td key={m.id} className="px-3 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => toggle.mutate({ projectId: p.id, milestoneId: m.id })}
                          aria-label={`${checked ? 'Mark incomplete' : 'Mark complete'}: ${m.name} on ${p.name}`}
                          title={status?.completedAt ? `Completed ${new Date(status.completedAt).toLocaleDateString()}` : 'Click to mark complete'}
                          className={cn(
                            'inline-flex items-center justify-center w-5 h-5 rounded border transition-colors cursor-pointer',
                            checked
                              ? 'bg-emerald-500 border-emerald-600 text-white hover:bg-emerald-600'
                              : 'border-slate-300 dark:border-slate-600 hover:border-slate-400 dark:hover:border-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50',
                          )}
                        >
                          {checked && <Check className="h-3.5 w-3.5" />}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-slate-400 dark:text-slate-500">
        Milestones are admin-managed (catalog: <code>project_stage_milestones</code>). To add or rename columns, contact an admin — the in-app catalog editor is on the roadmap.
      </p>
    </div>
  );
}
