import { Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/shared/empty-state';

/**
 * Service intensity panel (feat/ops-complete).
 *
 * Generalises the BIM/MEP load view to every ServiceType across
 * in-scope active projects. Server pre-aggregates open-task count,
 * overdue count and unique-project count per service so this stays
 * a single response.
 *
 * The colour bar uses the ServiceType's own `color` when present so
 * the visual matches how the same service is coloured elsewhere in
 * the app (planning grid, execution board). Falls back to slate.
 */

type ServiceRow = {
  id: number;
  name: string;
  code: string | null;
  color: string | null;
  openTasks: number;
  overdueTasks: number;
  projectCount: number;
  hoursLeft: number;
};

export function ServiceIntensityPanel({ services }: { services: ServiceRow[] }) {
  if (services.length === 0) {
    return (
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        <EmptyState
          icon={Layers}
          title="No service data"
          description="No open tasks with an assigned service type in the current scope."
        />
      </div>
    );
  }

  // Scale bar widths against the busiest service so the visual weight
  // reflects RELATIVE load rather than an absolute cap the operator
  // has no reference point for.
  const maxOpen = Math.max(...services.map((s) => s.openTasks), 1);

  return (
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      <div className="bg-[#FAFBFC] dark:bg-slate-800/60 border-b border-slate-100 dark:border-slate-800 px-4 py-2 flex items-center gap-2">
        <Layers className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400" aria-hidden="true" />
        <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400">
          Load by service
        </p>
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {services.map((s) => {
          const barPct = Math.round((s.openTasks / maxOpen) * 100);
          const barColor = s.color ?? '#3B82F6';
          const overdueRatio = s.openTasks > 0 ? Math.round((s.overdueTasks / s.openTasks) * 100) : 0;
          return (
            <li key={s.id} className="px-4 py-2.5">
              <div className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: barColor }} aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate">{s.name}</span>
                    {s.code && <span className="text-[10px] font-mono tabular-nums text-slate-400 dark:text-slate-500">{s.code}</span>}
                  </div>
                  <div className="mt-1 h-[4px] bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-300" style={{ width: `${barPct}%`, backgroundColor: barColor }} />
                  </div>
                </div>
                <div className="flex items-center gap-4 shrink-0 text-[11px]">
                  <div className="text-right">
                    <p className="text-slate-400 dark:text-slate-500 uppercase text-[10px] tracking-wide">Open</p>
                    <p className="font-mono tabular-nums font-bold text-slate-800 dark:text-slate-100">{s.openTasks}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-slate-400 dark:text-slate-500 uppercase text-[10px] tracking-wide">Overdue</p>
                    <p className={cn('font-mono tabular-nums font-bold', s.overdueTasks > 0 ? 'text-red-600' : 'text-slate-400 dark:text-slate-500')}>
                      {s.overdueTasks} <span className="text-slate-400 dark:text-slate-500 font-normal">({overdueRatio}%)</span>
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-slate-400 dark:text-slate-500 uppercase text-[10px] tracking-wide">Projects</p>
                    <p className="font-mono tabular-nums font-bold text-slate-800 dark:text-slate-100">{s.projectCount}</p>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
