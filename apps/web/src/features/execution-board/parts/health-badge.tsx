import { AlertCircle, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

export function HealthBadge({ agg, size = 'sm' }: { agg: { critical: number; warning: number; ok: number }; size?: 'sm' | 'md' }) {
  const { critical, warning } = agg;
  if (critical === 0 && warning === 0) return null;
  const cls = size === 'md' ? 'text-[11px] px-2 py-1' : 'text-[10px] px-1.5 py-0.5';
  const iconSize = size === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3';
  return (
    <div className="flex items-center gap-1 shrink-0">
      {critical > 0 && (
        <span className={cn('flex items-center gap-1 rounded-full bg-red-100 text-red-700 font-bold', cls)}>
          <AlertCircle className={iconSize} />
          {critical}
        </span>
      )}
      {warning > 0 && (
        <span className={cn('flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 font-bold', cls)}>
          <AlertTriangle className={iconSize} />
          {warning}
        </span>
      )}
    </div>
  );
}
