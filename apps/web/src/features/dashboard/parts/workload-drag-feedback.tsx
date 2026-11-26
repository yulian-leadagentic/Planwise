import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * QA6 round 2 (26.11) · the drag feedback of the Workload board, built so
 * that starting a drag never moves the board. Before, the row reason was a
 * new line under the person's name, so every row the task could not go to
 * grew a line and the cell under the pointer slid away (about 53 px on
 * staging).
 *
 * The rule: drag feedback never takes part in layout.
 *   - A day cell's before/after preview is an absolutely positioned
 *     overlay inside the (relative) cell: `CellPreview`.
 *   - The person cell always renders a fixed-height second line
 *     (`PersonSubline`, h-4), dragging or not. While a drag is on, the
 *     row reason is an absolutely positioned badge over that line and the
 *     position text under it turns `invisible` (keeps its box).
 *   - Rows the task cannot go to are dimmed with opacity only.
 */

export type RowReasonTone = 'blocked' | 'approval' | 'team';

const REASON_TONE: Record<RowReasonTone, string> = {
  blocked: 'bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-400',
  approval: 'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400',
  team: 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400',
};

export type RowReason = { tone: RowReasonTone; text: string };

/** The person cell of a Workload row: avatar, name, and the fixed second line. */
export function WorkloadPersonCell({
  initials,
  name,
  subtitle,
  reason,
}: {
  initials: string;
  name: string;
  subtitle: string | null;
  /** Set only while a chip is being dragged. */
  reason: RowReason | null;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-600 text-[10px] font-semibold flex items-center justify-center shrink-0">
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-slate-700 dark:text-slate-200 truncate">{name}</p>
        <PersonSubline subtitle={subtitle} reason={reason} />
      </div>
    </div>
  );
}

/**
 * The second line of the person cell. Always rendered at h-4 (even with
 * no position / org unit), so a drag only paints over it.
 */
export function PersonSubline({ subtitle, reason }: { subtitle: string | null; reason: RowReason | null }) {
  return (
    <div className="relative h-4 min-w-0" data-testid="workload-person-subline">
      <p className={cn('truncate text-[10px] leading-4 text-slate-400 dark:text-slate-500', reason && 'invisible')}>{subtitle ?? ''}</p>
      {reason && (
        <span
          data-testid="workload-row-reason"
          className={cn(
            'pointer-events-none absolute inset-y-0 left-0 max-w-full truncate rounded-[5px] px-1.5 text-[10px] font-semibold leading-4',
            REASON_TONE[reason.tone],
          )}
        >
          {reason.text}
        </span>
      )}
    </div>
  );
}

/**
 * The preview over a day cell while a chip is dragged. Absolutely
 * positioned (inset 2px) inside the relative cell, never wider or taller
 * than the cell: long text is clipped, not wrapped into a taller box.
 */
export function CellPreview(
  props:
    | { variant: 'now' }
    | { variant: 'preview'; isOver: boolean; bad: boolean; children: ReactNode },
) {
  const base =
    'pointer-events-none absolute inset-[2px] z-10 flex items-center justify-center overflow-hidden rounded-[7px] border-[1.5px] px-0.5 text-center text-[10px] font-semibold leading-tight';
  if (props.variant === 'now') {
    return (
      <div data-testid="workload-cell-preview" className={cn(base, 'border-dashed border-slate-300 dark:border-slate-600 bg-white/90 dark:bg-slate-900/90 text-slate-500 dark:text-slate-400')}>
        Now
      </div>
    );
  }
  const { isOver, bad, children } = props;
  return (
    <div
      data-testid="workload-cell-preview"
      className={cn(
        base,
        'font-mono',
        isOver
          ? bad
            ? 'border-solid border-red-600 bg-red-600 text-white'
            : 'border-solid border-blue-600 bg-blue-600 text-white'
          : cn('border-dashed bg-white/90 dark:bg-slate-900/90', bad ? 'border-red-400 text-red-600 dark:text-red-400' : 'border-blue-400 text-blue-600 dark:text-blue-400'),
      )}
    >
      {children}
    </div>
  );
}
