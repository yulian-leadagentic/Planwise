import { Check, Circle } from 'lucide-react';
import { formatDate } from '@/lib/date-utils';
import { formatCurrency, cn } from '@/lib/utils';
import type { LabelMilestone } from '@/types';

interface MilestoneTimelineProps {
  milestones: LabelMilestone[];
  className?: string;
}

export function MilestoneTimeline({ milestones, className }: MilestoneTimelineProps) {
  const sorted = [...milestones].sort((a, b) => {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
  });

  return (
    <div className={cn('relative', className)}>
      {/* Vertical line */}
      <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-border" />

      <div className="space-y-6">
        {sorted.map((milestone) => (
          <div key={milestone.id} className="relative flex items-start gap-4 pl-10">
            {/* Dot */}
            <div
              className={cn(
                'absolute left-2.5 flex h-3 w-3 items-center justify-center rounded-full',
                milestone.isCompleted
                  ? 'bg-green-500'
                  : 'border-2 border-brand-500 bg-background',
              )}
            >
              {milestone.isCompleted && <Check className="h-2 w-2 text-white" />}
            </div>

            {/* Content */}
            <div className="flex-1 rounded-lg border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                <h4
                  className={cn(
                    'text-sm font-medium',
                    milestone.isCompleted && 'line-through text-muted-foreground',
                  )}
                >
                  {milestone.name}
                </h4>
                {milestone.amount != null && (
                  <span className="text-sm font-medium text-brand-600">
                    {formatCurrency(milestone.amount)}
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                {milestone.dueDate && <span>Due: {formatDate(milestone.dueDate)}</span>}
                {milestone.isCompleted && milestone.completedAt && (
                  <span className="text-green-600">
                    Completed: {formatDate(milestone.completedAt)}
                  </span>
                )}
              </div>
              {milestone.notes && (
                <p className="mt-1 text-xs text-muted-foreground">{milestone.notes}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
