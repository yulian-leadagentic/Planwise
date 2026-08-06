import { cn } from '@/lib/utils';
import { useAllowedTransitions } from '@/hooks/use-allowed-transitions';
import { STATUS_LABEL } from '@/lib/task-constants';
import { STATUS_COLORS } from '@/lib/constants';
import { STATUS_OPTIONS } from './constants';

export function StatusSelect({ currentStatus, onChange }: { currentStatus: string; onChange: (s: string) => void }) {
  const { allowedStatuses } = useAllowedTransitions(currentStatus);
  return (
    <select
      aria-label="Task status"
      value={currentStatus}
      onChange={(e) => onChange(e.target.value)}
      className={cn('rounded-[5px] px-2 py-0.5 text-[11px] font-bold border-0 cursor-pointer focus:outline-none', STATUS_COLORS[currentStatus] || STATUS_COLORS.not_started)}
    >
      {STATUS_OPTIONS.filter((s) => allowedStatuses.includes(s)).map((s) => (
        <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>
      ))}
    </select>
  );
}
