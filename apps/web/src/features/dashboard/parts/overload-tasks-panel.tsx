import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import client from '@/api/client';

/**
 * D3 · Overload Tasks panel.
 *
 * Lists the tasks the T3 scheduler could not place inside the
 * available runway — spec rule 13 ("לא בכוח"). Fed by:
 *   • `POST /scheduling/projects/:projectId/overload-scan` when
 *     `projectId` is set (single-project surfaces).
 *   • `GET /scheduling/overload-scan/all` when `projectId` is
 *     undefined (dashboard-level surfaces).
 *
 * Each row carries the PM-visible context (deliverable · zone · code),
 * the assignee responsible for the overload, and a red pill naming
 * the reason:
 *   • `overload`              → "עומס"
 *   • `predecessor-conflict`  → "לא ניתן לתזמן"
 *
 * The panel is intentionally compact; it is embedded alongside the
 * utilization heat-map, not on a page of its own, so the row-count
 * tells the PM "here's what you need to fix now".
 */

export type OverloadFlaggedTask = {
  taskId: number;
  taskCode: string;
  taskName: string;
  deliverableId: number;
  deliverableName: string;
  zoneId: number | null;
  zoneName: string | null;
  assigneeId: number | null;
  assigneeName: string | null;
  budgetHours: number | null;
  estimatedStartDate: string | null;
  endDate: string | null;
  infeasibleReason: 'overload' | 'predecessor-conflict';
  overflowDays?: number;
  projectId: number;
  projectName: string;
};

type Props = {
  projectId?: number;
  /**
   * When set, each flagged-task row renders an external-link button that
   * opens the task in a drawer. Omit for a read-only surface (dashboards
   * that aren't wired to a drawer).
   */
  onOpenTask?: (taskId: number) => void;
  /**
   * When set, the project chip opens the project detail. Only
   * surfaces on the all-projects variant where multiple projects can
   * appear in one list.
   */
  onOpenProject?: (projectId: number) => void;
  /**
   * Optional className forwarded to the panel container (so callers
   * can place it in a 1 / 2-col grid).
   */
  className?: string;
};

const REASON_LABEL: Record<OverloadFlaggedTask['infeasibleReason'], string> = {
  overload: 'עומס',
  'predecessor-conflict': 'לא ניתן לתזמן',
};
const REASON_ARIA: Record<OverloadFlaggedTask['infeasibleReason'], string> = {
  overload: 'Task overloaded — budgeted hours exceed assignee capacity',
  'predecessor-conflict': 'Task cannot be scheduled — predecessor conflict',
};

function initials(name: string | null): string {
  if (!name) return '—';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function OverloadTasksPanel({ projectId, onOpenTask, onOpenProject, className }: Props) {
  const isScoped = typeof projectId === 'number';

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: isScoped
      ? ['scheduling', 'overload-scan', 'project', projectId]
      : ['scheduling', 'overload-scan', 'all'],
    queryFn: async () => {
      if (isScoped) {
        const r = await client.post(`/scheduling/projects/${projectId}/overload-scan`);
        return (r.data?.data ?? r.data) as {
          projectId: number;
          projectName: string;
          scannedDeliverables: number;
          flaggedTasks: OverloadFlaggedTask[];
        };
      }
      const r = await client.get('/scheduling/overload-scan/all');
      return (r.data?.data ?? r.data) as {
        scannedProjects: number;
        scannedDeliverables: number;
        flaggedTasks: OverloadFlaggedTask[];
      };
    },
    staleTime: 60 * 1000,
  });

  const tasks: OverloadFlaggedTask[] = data?.flaggedTasks ?? [];

  return (
    <div
      className={cn(
        'rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden',
        className,
      )}
    >
      <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-100 dark:border-slate-800">
        <AlertTriangle className="h-4 w-4 text-red-500 dark:text-red-400" aria-hidden="true" />
        <h3 className="text-[15px] font-bold text-slate-900 dark:text-slate-100">
          Overload Tasks
        </h3>
        <span className="text-[11px] text-slate-400 dark:text-slate-500">
          · משימות עם עומס
        </span>
        {!isLoading && !isError && tasks.length > 0 && (
          <span className="ml-auto text-[11px] font-bold text-red-600 dark:text-red-400 font-mono tabular-nums">
            {tasks.length}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="py-6 text-center text-[12px] text-slate-400 dark:text-slate-500">
          Scanning schedule…
        </div>
      ) : isError ? (
        <div className="py-6 text-center text-[12px] text-slate-400 dark:text-slate-500">
          Couldn't load overload scan.{' '}
          <button
            type="button"
            onClick={() => refetch()}
            className="font-semibold text-blue-600 hover:underline"
          >
            Retry
          </button>
        </div>
      ) : tasks.length === 0 ? (
        <div className="text-center py-10 text-slate-400 dark:text-slate-500 text-[12px]">
          אין משימות עם עומס · All clear
        </div>
      ) : (
        <table className="w-full text-[12px]">
          <thead>
            <tr className="bg-[#FAFBFC] dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800 text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]">
              <th className="px-3 py-1.5 text-left w-10"></th>
              <th className="px-3 py-1.5 text-left">Task</th>
              <th className="px-3 py-1.5 text-left">Context</th>
              <th className="px-3 py-1.5 text-left">Assignee</th>
              <th className="px-3 py-1.5 text-left w-32">Reason</th>
              <th className="px-3 py-1.5 text-right w-24">Overflow</th>
              <th className="px-3 py-1.5 text-right w-10"></th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => {
              const label = REASON_LABEL[t.infeasibleReason];
              const aria = REASON_ARIA[t.infeasibleReason];
              return (
                <tr
                  key={t.taskId}
                  className="group border-b border-slate-50 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                >
                  <td className="px-3 py-2">
                    <div
                      className="w-6 h-6 rounded-full bg-violet-600 text-white text-[9px] font-semibold flex items-center justify-center shrink-0"
                      aria-label={t.assigneeName ?? 'Unassigned'}
                    >
                      {initials(t.assigneeName)}
                    </div>
                  </td>
                  <td className="px-3 py-2 min-w-0">
                    <div className="flex flex-col min-w-0">
                      <button
                        type="button"
                        onClick={() => onOpenTask?.(t.taskId)}
                        disabled={!onOpenTask}
                        className={cn(
                          'text-left text-sm font-semibold text-slate-900 dark:text-slate-100 truncate max-w-[280px]',
                          onOpenTask && 'hover:text-blue-700 hover:underline focus-visible:outline-none',
                        )}
                      >
                        {t.taskName}
                      </button>
                      <span className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
                        {t.taskCode}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 min-w-0">
                    <span className="text-[11px] text-slate-400 dark:text-slate-500 truncate block max-w-[220px]">
                      {t.deliverableName}
                      {t.zoneName && (
                        <>
                          <span className="mx-1">·</span>
                          {t.zoneName}
                        </>
                      )}
                    </span>
                    {onOpenProject ? (
                      <button
                        type="button"
                        onClick={() => onOpenProject(t.projectId)}
                        className="text-[11px] text-slate-500 dark:text-slate-400 hover:text-blue-700 hover:underline truncate max-w-[220px] block focus-visible:outline-none"
                      >
                        {t.projectName}
                      </button>
                    ) : (
                      <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate block max-w-[220px]">
                        {t.projectName}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-[12px] text-slate-700 dark:text-slate-200 truncate max-w-[160px]">
                    {t.assigneeName ?? (
                      <span className="text-slate-300 dark:text-slate-600">Unassigned</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className="inline-flex rounded-[5px] bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 text-[11px] font-bold tracking-[0.05em] px-2 py-0.5"
                      aria-label={aria}
                      title={aria}
                    >
                      {label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {typeof t.overflowDays === 'number' && t.overflowDays > 0 ? (
                      <span className="text-xs font-mono tabular-nums text-red-600 dark:text-red-400">
                        {t.overflowDays}d
                      </span>
                    ) : (
                      <span className="text-xs font-mono text-slate-300 dark:text-slate-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {onOpenTask && (
                      <button
                        type="button"
                        onClick={() => onOpenTask(t.taskId)}
                        aria-label={`Open task ${t.taskCode}`}
                        className="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-slate-700 transition-colors opacity-0 group-hover:opacity-100 focus-visible:outline-none focus-visible:border-blue-500"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
