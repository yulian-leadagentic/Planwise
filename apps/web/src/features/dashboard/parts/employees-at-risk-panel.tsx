import { ExternalLink, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/shared/empty-state';
import { OpsAvatar } from './ops-shared';

/**
 * Employees at Risk panel (feat/ops-complete).
 *
 * Sits alongside "Projects at Risk" on the Risk & Review tab.
 * Definition per the spec: employees who are OVERLOADED (this week's
 * logged/planned hours exceed weekly capacity) AND carry at least
 * one overdue task. Server aggregates both signals — no new sources.
 *
 * The panel is opinionated (no filter box, no sort) because the row
 * count is already small by construction. Each overdue-task chip
 * opens the Task drawer; the project link deep-links to the project
 * detail page.
 */

type OverdueTask = {
  id: number; code: string; name: string;
  projectId: number | null;
  projectName: string | null;
  daysOverdue: number | null;
};

type EmployeeAtRisk = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  position: string | null;
  department: string | null;
  hoursWeek: number;
  capacity: number;
  overloadPct: number;
  overdueCount: number;
  overdueTasks: OverdueTask[];
};

export function EmployeesAtRiskPanel({
  employees,
  onOpenTask,
  onOpenProject,
}: {
  employees: EmployeeAtRisk[];
  onOpenTask: (taskId: number) => void;
  onOpenProject: (projectId: number) => void;
}) {
  if (employees.length === 0) {
    return (
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        <EmptyState
          icon={Users}
          title="No employees at risk"
          description="Nobody is currently overloaded AND carrying overdue tasks."
        />
      </div>
    );
  }

  return (
    <div className="rounded-[14px] border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-900 overflow-hidden">
      <div className="bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-900/60 px-4 py-2">
        <p className="text-[11px] uppercase tracking-wider font-semibold text-red-700 dark:text-red-300">
          Overloaded AND overdue
        </p>
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {employees.map((e) => (
          <li key={e.id} className="flex items-start gap-3 px-4 py-3">
            <OpsAvatar firstName={e.firstName} lastName={e.lastName} size={32} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] font-bold text-slate-900 dark:text-slate-100">
                  {e.firstName} {e.lastName}
                </span>
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-[5px] bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800 tracking-wide">
                  OVERLOADED · <span className="font-mono tabular-nums">{e.overloadPct}%</span>
                </span>
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-[5px] bg-red-100 text-red-800 dark:bg-red-950/70 dark:text-red-200 tracking-wide">
                  <span className="font-mono tabular-nums">{e.overdueCount}</span> OVERDUE
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                {e.position ?? 'Employee'}
                {e.department && <span> · {e.department}</span>}
                {' · '}
                <span className="font-mono tabular-nums">{e.hoursWeek}h</span>
                <span className="text-slate-400 dark:text-slate-500">/{e.capacity}h this week</span>
              </p>
              <ul className="mt-2 space-y-1">
                {e.overdueTasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 text-[12px] group">
                    <span className="w-1 h-3 rounded-sm bg-red-500 shrink-0" aria-hidden="true" />
                    <button
                      type="button"
                      onClick={() => onOpenTask(t.id)}
                      className="text-left text-slate-800 dark:text-slate-100 hover:text-blue-700 hover:underline truncate max-w-[220px] focus-visible:outline-none focus-visible:border-blue-500"
                    >
                      <span className="font-mono tabular-nums text-slate-400 dark:text-slate-500 mr-1">{t.code}</span>
                      {t.name}
                    </button>
                    {t.projectId != null && t.projectName && (
                      <button
                        type="button"
                        onClick={() => onOpenProject(t.projectId!)}
                        className="text-[10px] text-slate-400 dark:text-slate-500 hover:text-blue-700 hover:underline truncate max-w-[140px] focus-visible:outline-none focus-visible:border-blue-500"
                      >
                        {t.projectName}
                      </button>
                    )}
                    <span className={cn('ml-auto shrink-0 text-[10px] font-bold text-red-600 bg-red-50 dark:bg-red-950/50 dark:text-red-300 px-1.5 py-0.5 rounded font-mono tabular-nums')}>
                      {t.daysOverdue}d late
                    </span>
                    <button
                      type="button"
                      onClick={() => onOpenTask(t.id)}
                      aria-label={`Open task ${t.code}`}
                      className="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-blue-600 hover:bg-blue-50 transition-colors opacity-0 group-hover:opacity-100 focus-visible:outline-none focus-visible:border-blue-500 shrink-0"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
