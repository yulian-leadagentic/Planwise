import { dayColumn, type TeamWorkloadDay } from '../workload-range';

/**
 * QA6 P3 — the day columns of the Workload table, exactly the days the
 * API sent (org work week, Sunday first; a holiday keeps its column and
 * shows its name).
 */
export function WorkloadDayHeaders({ days }: { days: TeamWorkloadDay[] }) {
  return (
    <>
      {days.map((d) => {
        const col = dayColumn(d.date);
        return (
          <th key={d.date} data-date={d.date} className="px-2 py-3 text-center font-semibold" title={d.holiday?.name || undefined}>
            {col.weekday}<br /><span className="font-mono tabular-nums">{col.date}</span>
            {d.holiday && (
              <span className="block normal-case tracking-normal text-[9px] font-medium text-amber-600 truncate max-w-[72px] mx-auto">{d.holiday.name}</span>
            )}
          </th>
        );
      })}
    </>
  );
}
