import { format, parseISO } from 'date-fns';

/**
 * QA6 P3 (PR-073 / PR-074) — labels for the workload range. The days come
 * from the API (`GET /workload/team` › days, `GET /dashboard/operations`
 * › week.days): the org work week, Sunday first with the default Fri + Sat
 * rest days. Dates are `YYYY-MM-DD` keys.
 */

/** "Sun 22 – Thu 26 Nov 2026" (month / year shown once when shared). */
export function formatWorkRange(dates: string[]): string {
  const sorted = [...dates].filter(Boolean).sort();
  if (sorted.length === 0) return '';
  const a = parseISO(sorted[0]);
  const b = parseISO(sorted[sorted.length - 1]);
  if (sorted[0] === sorted[sorted.length - 1]) return format(a, 'EEE d MMM yyyy');
  const sameYear = a.getFullYear() === b.getFullYear();
  const sameMonth = sameYear && a.getMonth() === b.getMonth();
  const left = sameMonth ? format(a, 'EEE d') : sameYear ? format(a, 'EEE d MMM') : format(a, 'EEE d MMM yyyy');
  return `${left} – ${format(b, 'EEE d MMM yyyy')}`;
}

/** Column header parts for one day: { weekday: 'Sun', date: '22/11' }. */
export function dayColumn(date: string): { weekday: string; date: string } {
  const d = parseISO(date);
  return { weekday: format(d, 'EEE'), date: format(d, 'dd/MM') };
}

/** The date key `n` days after `date`. */
export function shiftDateKey(date: string, n: number): string {
  const d = parseISO(date);
  d.setDate(d.getDate() + n);
  return format(d, 'yyyy-MM-dd');
}

/** Utilization % (0 when there is no capacity). */
export function utilizationPct(planned: number, capacity: number): number {
  return capacity > 0 ? Math.round((planned / capacity) * 100) : 0;
}

export type TeamWorkloadDay = {
  date: string;
  dayOfWeek: number;
  isWorkingDay: boolean;
  holiday: { name: string; type: string; workingHours: number } | null;
};

export type TeamWorkloadChip = {
  taskId: number | null;
  code: string | null;
  name: string;
  projectId: number | null;
  projectName: string | null;
  hours: number;
  masked?: true;
};

export type TeamWorkloadPerson = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  name: string;
  position: string | null;
  orgUnit: { id: number; name: string } | null;
  loggedVisible: boolean;
  days: Array<{ date: string; capacity: number; planned: number; logged: number | null; tasks: TeamWorkloadChip[] }>;
  totals: {
    capacity: number;
    planned: number;
    logged: number | null;
    undatedHours: number;
    overdueHours: number;
    utilizationPct: number;
    overloadedDays: number;
  };
};

export type TeamWorkload = {
  range: { from: string; to: string; today: string };
  workWeek: { restDays: number[]; weekStartsOn: number };
  days: TeamWorkloadDay[];
  people: TeamWorkloadPerson[];
  totals: { people: number; capacity: number; planned: number; logged: number | null; undatedHours: number; utilizationPct: number };
  orgUnits: Array<{ id: number; name: string; parentId: number | null; depth: number }>;
  scope: { myDeptOnly: boolean; orgUnitId: number | null; deptName: string | null };
};

/** People grouped by home unit, in first-seen order ("No department" last). */
export function groupByDepartment(people: TeamWorkloadPerson[]): Array<{ key: string; name: string; people: TeamWorkloadPerson[] }> {
  const groups = new Map<string, { key: string; name: string; people: TeamWorkloadPerson[] }>();
  for (const p of people) {
    const key = p.orgUnit ? String(p.orgUnit.id) : 'none';
    const name = p.orgUnit?.name ?? 'No department';
    if (!groups.has(key)) groups.set(key, { key, name, people: [] });
    groups.get(key)!.people.push(p);
  }
  const list = [...groups.values()];
  return [...list.filter((g) => g.key !== 'none'), ...list.filter((g) => g.key === 'none')];
}

/** Tooltip text for a day cell: one line per task. */
export function dayTasksTitle(tasks: TeamWorkloadChip[]): string {
  return tasks.map((t) => `${t.code ? `${t.code} ` : ''}${t.name} · ${t.hours}h`).join('\n');
}
