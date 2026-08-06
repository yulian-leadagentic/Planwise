import { Clock, AlertCircle, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getTaskHealth } from '@/lib/task-health';
import { DueDateChip } from './due-date-chip';

export function TaskHealthBanner({ task, onUpdateDueDate }: { task: any; onUpdateDueDate: (value: string | null) => void }) {
  const health = getTaskHealth(task);
  if (health.level === 'ok' && health.reasons.length === 0) {
    return (
      <div className="px-5 py-2.5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 flex items-center gap-4 text-[11px] text-slate-600 dark:text-slate-300">
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" /> {health.loggedHours}h / {health.estimatedHours}h
        </span>
        <span className="tabular-nums font-semibold text-blue-600">{health.computedPct}% complete</span>
        <span className="ml-auto"><DueDateChip task={task} onUpdate={onUpdateDueDate} /></span>
      </div>
    );
  }

  const isCritical = health.level === 'critical';
  const bgCls = isCritical ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200';
  const textCls = isCritical ? 'text-red-700' : 'text-amber-700';
  const Icon = isCritical ? AlertCircle : AlertTriangle;

  return (
    <div className={cn('px-5 py-2.5 border-b flex items-start gap-2', bgCls)}>
      <Icon className={cn('h-4 w-4 shrink-0 mt-0.5', textCls)} />
      <div className="flex-1 min-w-0">
        <div className={cn('text-[11px] font-bold uppercase tracking-wider', textCls)}>
          {isCritical ? 'At Risk — Needs Attention' : 'Warning'}
        </div>
        <ul className={cn('mt-0.5 text-[12px] space-y-0.5', textCls)}>
          {health.reasons.map((r, i) => <li key={i}>• {r}</li>)}
        </ul>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-slate-600 dark:text-slate-300">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" /> {health.loggedHours}h / {health.estimatedHours}h
          </span>
          <span className="tabular-nums font-semibold">{health.computedPct}% complete</span>
          <DueDateChip task={task} onUpdate={onUpdateDueDate} />
        </div>
      </div>
    </div>
  );
}
