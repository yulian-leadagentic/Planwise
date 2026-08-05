import { cn } from '@/lib/utils';
import { ACCENTS } from './constants';

export function Section({
  label, count, accent, action, children,
}: {
  label: string;
  count: number;
  accent: keyof typeof ACCENTS;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-2">
          {label}
          <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold', ACCENTS[accent].badge)}>{count}</span>
        </p>
        {action}
      </div>
      {children}
    </div>
  );
}
