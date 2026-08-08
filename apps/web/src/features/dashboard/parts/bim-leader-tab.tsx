import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { OpsAvatar, OpsChevron, OpsErrorBanner, opsErrorMessage } from './ops-shared';

/**
 * BIM Leader tab (feat/ops-complete).
 *
 * Groups the caller's accessible projects by BIM Leader. Backend
 * resolves the leader via ProjectPartnerRole with role code
 * 'bim_leader' — same source the Task Kanban already uses, so the
 * name shown here matches what appears elsewhere in the app.
 *
 * Per leader: # active projects · # deliverables · # open tasks ·
 * # overdue. Row is expandable to the projects sitting under that
 * leader; each project row deep-links to /projects/:id.
 */

type BimProject = {
  id: number; name: string; number: string | null;
  status: string;
  department: { id: number; name: string } | null;
  openTasks: number; overdueTasks: number; deliverables: number;
};

type BimLeaderRow = {
  key: string;
  label: string;
  userId: number | null;
  projectCount: number;
  deliverableCount: number;
  openTaskCount: number;
  overdueCount: number;
  projects: BimProject[];
};

type BimLeaderResponse = {
  leaders: BimLeaderRow[];
  scope: { myDeptOnly: boolean; deptName: string | null };
};

export function BimLeaderTab({
  myDeptOnly,
  onOpenProject,
}: {
  myDeptOnly: boolean;
  onOpenProject: (projectId: number) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<BimLeaderResponse>({
    queryKey: ['dashboard', 'operations', 'bim-leaders', { myDeptOnly }],
    queryFn: () => client
      .get('/dashboard/operations/bim-leaders', { params: myDeptOnly ? { myDeptOnly: true } : {} })
      .then((r) => r.data?.data ?? r.data),
    staleTime: 60 * 1000,
    retry: 1,
  });

  if (isLoading) return <PageSkeleton />;
  if (isError) {
    return (
      <OpsErrorBanner
        title="Could not load BIM Leader breakdown"
        message={opsErrorMessage(error)}
        onRetry={() => refetch()}
      />
    );
  }

  const leaders = data?.leaders ?? [];

  if (leaders.length === 0) {
    return (
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        <EmptyState
          icon={ShieldCheck}
          title="No BIM Leaders to show"
          description={myDeptOnly
            ? 'No projects with an assigned BIM Leader in your department.'
            : 'No accessible projects have a BIM Leader assigned yet.'}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {isFetching && (
        <p className="text-[11px] text-slate-400 dark:text-slate-500 -mt-1">Refreshing…</p>
      )}
      {leaders.map((row) => {
        const open = !!expanded[row.key];
        return (
          <div
            key={row.key}
            className={cn(
              'rounded-[14px] border bg-white dark:bg-slate-900 overflow-hidden transition-colors',
              open ? 'border-slate-300 dark:border-slate-600' : 'border-slate-200 dark:border-slate-700',
            )}
          >
            <button
              type="button"
              onClick={() => setExpanded((prev) => ({ ...prev, [row.key]: !prev[row.key] }))}
              className={cn(
                'w-full flex items-center gap-3 px-4 py-3 text-left transition-colors',
                open ? 'bg-slate-50 dark:bg-slate-800/80' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
              )}
            >
              <OpsChevron open={open} />
              {row.userId != null ? (
                <OpsAvatar
                  firstName={row.label.split(' ')[0]}
                  lastName={row.label.split(' ').slice(1).join(' ')}
                  size={28}
                />
              ) : (
                <div className="w-7 h-7 rounded-full bg-slate-100 dark:bg-slate-800 border border-dashed border-slate-300 dark:border-slate-600 flex items-center justify-center shrink-0">
                  <span aria-hidden="true" className="text-[11px] font-bold text-slate-400 dark:text-slate-500">?</span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{row.label}</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="font-mono tabular-nums">{row.projectCount}</span> projects ·{' '}
                  <span className="font-mono tabular-nums">{row.deliverableCount}</span> deliverables
                </p>
              </div>
              <div className="hidden sm:flex items-center gap-4 shrink-0">
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">Open</p>
                  <p className="text-[13px] font-bold font-mono tabular-nums text-slate-800 dark:text-slate-100">{row.openTaskCount}</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">Overdue</p>
                  <p className={cn('text-[13px] font-bold font-mono tabular-nums', row.overdueCount > 0 ? 'text-red-600' : 'text-slate-500 dark:text-slate-400')}>{row.overdueCount}</p>
                </div>
              </div>
            </button>

            {open && (
              <div className="border-t border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800">
                {row.projects.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 px-4 py-2 pl-12 group hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors">
                    <div className="flex-1 min-w-0">
                      <button
                        type="button"
                        onClick={() => onOpenProject(p.id)}
                        className="text-left text-[13px] font-semibold text-slate-900 dark:text-slate-100 hover:text-blue-700 hover:underline truncate max-w-[400px] focus-visible:outline-none focus-visible:border-blue-500"
                      >
                        {p.name}
                      </button>
                      <p className="text-[11px] text-slate-400 dark:text-slate-500">
                        <span className="font-mono tabular-nums">{p.number ?? '—'}</span>
                        {p.department && <span> · {p.department.name}</span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                      <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        <span className="text-slate-400 dark:text-slate-500">deliv </span>{p.deliverables}
                      </span>
                      <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        <span className="text-slate-400 dark:text-slate-500">open </span>{p.openTasks}
                      </span>
                      <span className={cn('text-[11px] font-mono tabular-nums font-bold', p.overdueTasks > 0 ? 'text-red-600' : 'text-slate-400 dark:text-slate-500')}>
                        <span className="font-normal text-slate-400 dark:text-slate-500">overdue </span>{p.overdueTasks}
                      </span>
                      <button
                        type="button"
                        onClick={() => onOpenProject(p.id)}
                        aria-label={`Open project ${p.name}`}
                        className="w-7 h-7 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-blue-600 hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100 focus-visible:outline-none focus-visible:border-blue-500"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
