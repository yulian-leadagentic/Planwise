/**
 * QA6 P3 (PR-073 / PR-074) — the one workload engine.
 *
 * Pure: no Prisma, no clock. `workload-loader.ts` reads the rows and
 * calls in here; `GET /workload/team`, `GET /workload/user/:id`, the
 * project workload panel, feasibility and the Operations "Team by
 * Department" tab all run through `computePersonWorkload`.
 *
 * Dates are calendar dates as `YYYY-MM-DD` keys, handled in UTC (Prisma
 * `@db.Date` columns come back as midnight-UTC, as in the scheduler).
 *
 * CAPACITY of a person on a day
 *   1. Week pattern: a WorkSchedule row for that weekday wins (its shift
 *      length minus the break, even on an org rest day). Without a row,
 *      an org rest day (`HrSettings.weeklyRestDays`, default Fri + Sat)
 *      is 0 and any other day is the person's `dailyStandardHours`
 *      (8 when it is not a positive number).
 *   2. Org calendar (CalendarDay, appliesTo all / employees_only), the
 *      way the scheduler reads it: a non-REGULAR row with 0 / no working
 *      hours is a day off; a row with working hours > 0 (holiday eve)
 *      stays a working day, capped at those hours.
 *   3. Absences (AbsenceRecord — HR enters them, there is no pending
 *      state): unit DAY takes `amount` (1 = whole day) × the day's
 *      capacity, unit HOUR takes `amount` hours. Never below 0.
 *
 * PLANNED hours of a task, per assignee
 *   • remaining = max(0, budgetHours − hours logged on the task by
 *     anyone), split evenly between the task's live assignees.
 *   • Spread evenly over the person's working days (step 1 + 2 above,
 *     absences ignored so a vacation day shows the clash instead of
 *     silently moving the work) from `estimatedStartDate ?? startDate`
 *     to `endDate`.
 *   • No end date → not on any day; counted in `undatedHours`.
 *   • An end date but no start → from today (or the end date when that
 *     is already past) to the end date.
 *   • A range with no working day of the person (a task due on a
 *     Friday) → the last working day before its end (up to 14 days
 *     back), else `undatedHours`.
 *   • End date before today → still spread over its own dates, and the
 *     share is also reported in `overdueHours`.
 */

export const DEFAULT_WEEKLY_REST_DAYS = [5, 6]; // Fri + Sat (Israeli work-week)
export const DEFAULT_DAILY_HOURS = 8;
const DAY_MS = 86_400_000;

// ─── Date keys ───────────────────────────────────────────────────────

export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseYmd(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

export function isValidYmd(key: unknown): key is string {
  if (typeof key !== 'string' || !YMD_RE.test(key)) return false;
  const d = parseYmd(key);
  return !Number.isNaN(d.getTime()) && ymd(d) === key;
}

export function addDaysYmd(key: string, n: number): string {
  return ymd(new Date(parseYmd(key).getTime() + n * DAY_MS));
}

export function dowOf(key: string): number {
  return parseYmd(key).getUTCDay();
}

/** Inclusive list of date keys. Caller bounds the span. */
export function datesBetween(fromKey: string, toKey: string): string[] {
  const out: string[] = [];
  for (let k = fromKey; k <= toKey; k = addDaysYmd(k, 1)) out.push(k);
  return out;
}

/** A Date column (or null) → its date key. */
export function keyOf(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : ymd(dt);
}

// ─── Work week ───────────────────────────────────────────────────────

export function normalizeRestDays(raw: unknown): number[] {
  if (Array.isArray(raw) && raw.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)) {
    return [...new Set(raw as number[])].sort((a, b) => a - b);
  }
  return [...DEFAULT_WEEKLY_REST_DAYS];
}

/**
 * First day of the work week: the first working day that follows a rest
 * day. Fri + Sat rest → Sunday (0); Sat + Sun rest → Monday (1); no rest
 * days → Sunday.
 */
export function weekStartsOn(restDays: number[]): number {
  const rest = new Set(restDays);
  if (rest.size === 0 || rest.size === 7) return 0;
  for (let d = 0; d < 7; d++) {
    if (!rest.has(d) && rest.has((d + 6) % 7)) return d;
  }
  return 0;
}

/** The 7-day work week holding `key`. */
export function workWeekOf(key: string, restDays: number[]): { from: string; to: string } {
  const start = weekStartsOn(restDays);
  const back = (dowOf(key) - start + 7) % 7;
  const from = addDaysYmd(key, -back);
  return { from, to: addDaysYmd(from, 6) };
}

// ─── Org calendar ────────────────────────────────────────────────────

export interface OrgCalendar {
  restDays: number[];
  /** Days off for everyone (holiday / rest rows with 0 or no working hours). */
  nonWorking: Set<string>;
  /** Shortened working days (holiday eve …): date → working hours. */
  partial: Map<string, number>;
  /** Name + type per calendar row, for the column headers. */
  labels: Map<string, { name: string; type: string }>;
}

export function buildOrgCalendar(
  restDaysRaw: unknown,
  rows: Array<{ date: Date | string; type: string; workingHours?: unknown; name?: string | null }>,
): OrgCalendar {
  const nonWorking = new Set<string>();
  const partial = new Map<string, number>();
  const labels = new Map<string, { name: string; type: string }>();
  for (const r of rows) {
    const key = keyOf(r.date as any);
    if (!key) continue;
    labels.set(key, { name: String(r.name ?? ''), type: String(r.type) });
    if (r.type === 'REGULAR') continue;
    const wh = r.workingHours == null ? null : Number(r.workingHours);
    if (wh === null || !Number.isFinite(wh) || wh <= 0) nonWorking.add(key);
    else partial.set(key, wh);
  }
  return { restDays: normalizeRestDays(restDaysRaw), nonWorking, partial, labels };
}

// ─── Person inputs ───────────────────────────────────────────────────

export interface ScheduleRow {
  dayOfWeek: number;
  shiftStart: string;
  shiftEnd: string;
  breakMinutes: number;
  effectiveFrom: Date | string;
}

export interface AbsenceRow {
  dateFrom: Date | string;
  dateTo: Date | string;
  unit: 'DAY' | 'HOUR' | string;
  amount: number;
}

export interface WorkloadTask {
  id: number;
  code: string | null;
  name: string;
  projectId: number | null;
  projectName: string | null;
  budgetHours: number;
  /** Hours logged on the task by anyone (all assignees). */
  loggedHours: number;
  /** Live assignees of the task (≥ 1 for a task we hold an assignment of). */
  assigneeCount: number;
  estimatedStartDate: Date | string | null;
  startDate: Date | string | null;
  endDate: Date | string | null;
}

export interface PersonInput {
  userId: number;
  dailyStandardHours: number | null;
  schedules: ScheduleRow[];
  absences: AbsenceRow[];
  tasks: WorkloadTask[];
  /** date key → hours the person logged; null = the caller may not see them. */
  loggedByDate: Map<string, number> | null;
}

export interface DayTask {
  taskId: number;
  hours: number;
}

export interface PersonDay {
  date: string;
  capacity: number;
  planned: number;
  logged: number | null;
  tasks: DayTask[];
}

export interface PersonWorkload {
  days: PersonDay[];
  totals: {
    capacity: number;
    planned: number;
    logged: number | null;
    undatedHours: number;
    overdueHours: number;
    utilizationPct: number;
    overloadedDays: number;
  };
  /** Task id → task, for whoever shapes the chips. */
  taskById: Map<number, WorkloadTask>;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

function shiftHours(s: ScheduleRow): number {
  const [sh, sm] = String(s.shiftStart).split(':').map(Number);
  const [eh, em] = String(s.shiftEnd).split(':').map(Number);
  const minutes = (eh * 60 + (em || 0)) - (sh * 60 + (sm || 0)) - (Number(s.breakMinutes) || 0);
  return Number.isFinite(minutes) ? Math.max(0, minutes / 60) : 0;
}

/** Hours per weekday (index = getUTCDay()) before the calendar and absences. */
export function weekPattern(person: Pick<PersonInput, 'dailyStandardHours' | 'schedules'>, restDays: number[]): number[] {
  const std = Number(person.dailyStandardHours);
  const daily = Number.isFinite(std) && std > 0 ? std : DEFAULT_DAILY_HOURS;
  // Latest effective row per weekday wins.
  const byDow = new Map<number, ScheduleRow>();
  for (const s of person.schedules ?? []) {
    const cur = byDow.get(s.dayOfWeek);
    if (!cur || new Date(s.effectiveFrom).getTime() > new Date(cur.effectiveFrom).getTime()) byDow.set(s.dayOfWeek, s);
  }
  return Array.from({ length: 7 }, (_, dow) => {
    const row = byDow.get(dow);
    if (row) return shiftHours(row);
    return restDays.includes(dow) ? 0 : daily;
  });
}

/** Is `key` a working day for someone with this pattern (absences aside)? */
export function isPersonWorkingDay(key: string, pattern: number[], cal: OrgCalendar): boolean {
  return pattern[dowOf(key)] > 0 && !cal.nonWorking.has(key);
}

/** Capacity before absences. */
export function baseCapacity(key: string, pattern: number[], cal: OrgCalendar): number {
  const base = pattern[dowOf(key)];
  if (base <= 0 || cal.nonWorking.has(key)) return 0;
  const cap = cal.partial.get(key);
  return cap != null ? Math.min(base, cap) : base;
}

/**
 * Working days in [fromKey, toKey] for a pattern — closed form (whole
 * weeks × working weekdays + a ≤ 6-day remainder − days off that fall
 * on a working weekday), so a task ending 9999-12-31 costs nothing.
 */
export function countPersonWorkingDays(fromKey: string, toKey: string, pattern: number[], cal: OrgCalendar): number {
  if (toKey < fromKey) return 0;
  const total = Math.floor((parseYmd(toKey).getTime() - parseYmd(fromKey).getTime()) / DAY_MS) + 1;
  const working = pattern.map((h) => h > 0);
  const perWeek = working.filter(Boolean).length;
  const full = Math.floor(total / 7);
  let n = full * perWeek;
  const startDow = dowOf(fromKey);
  for (let i = 0; i < total - full * 7; i++) if (working[(startDow + i) % 7]) n++;
  for (const h of cal.nonWorking) {
    if (h >= fromKey && h <= toKey && working[dowOf(h)]) n--;
  }
  return Math.max(0, n);
}

function absenceCut(key: string, capacity: number, absences: AbsenceRow[]): number {
  let cut = 0;
  for (const a of absences ?? []) {
    const from = keyOf(a.dateFrom as any);
    const to = keyOf(a.dateTo as any);
    if (!from || !to || key < from || key > to) continue;
    const amount = Math.max(0, Number(a.amount) || 0);
    cut += a.unit === 'HOUR' ? amount : Math.min(1, amount) * capacity;
  }
  return cut;
}

export interface ComputeOptions {
  /** Days to compute (sorted keys). */
  dates: string[];
  /** Today's date key — decides "no start" and "overdue". */
  today: string;
}

export function computePersonWorkload(person: PersonInput, cal: OrgCalendar, opts: ComputeOptions): PersonWorkload {
  const pattern = weekPattern(person, cal.restDays);
  const dates = opts.dates;
  const planned = new Map<string, number>();
  const chips = new Map<string, DayTask[]>();
  const taskById = new Map<number, WorkloadTask>();
  let undated = 0;
  let overdue = 0;

  for (const t of person.tasks ?? []) {
    const budget = Number(t.budgetHours) || 0;
    if (budget <= 0) continue;
    const remaining = Math.max(0, budget - (Number(t.loggedHours) || 0));
    const share = remaining / Math.max(1, Number(t.assigneeCount) || 1);
    if (share <= 0) continue;
    taskById.set(t.id, t);

    const endKey = keyOf(t.endDate as any);
    if (!endKey) {
      undated += share;
      continue;
    }
    if (endKey < opts.today) overdue += share;

    let startKey = keyOf((t.estimatedStartDate ?? t.startDate) as any) ?? (opts.today <= endKey ? opts.today : endKey);
    if (startKey > endKey) startKey = endKey;

    let spreadFrom = startKey;
    let spreadTo = endKey;
    let n = countPersonWorkingDays(spreadFrom, spreadTo, pattern, cal);
    if (n === 0) {
      // Due on a day off — the last working day before it.
      let k = addDaysYmd(endKey, -1);
      let found: string | null = null;
      for (let i = 0; i < 14; i++, k = addDaysYmd(k, -1)) {
        if (isPersonWorkingDay(k, pattern, cal)) { found = k; break; }
      }
      if (!found) {
        undated += share;
        continue;
      }
      spreadFrom = spreadTo = found;
      n = 1;
    }
    const daily = share / n;
    for (const d of dates) {
      if (d < spreadFrom || d > spreadTo) continue;
      if (!isPersonWorkingDay(d, pattern, cal)) continue;
      planned.set(d, (planned.get(d) ?? 0) + daily);
      const list = chips.get(d) ?? [];
      list.push({ taskId: t.id, hours: round2(daily) });
      chips.set(d, list);
    }
  }

  let capSum = 0;
  let planSum = 0;
  let logSum = 0;
  let overloadedDays = 0;
  const days: PersonDay[] = dates.map((date) => {
    const base = baseCapacity(date, pattern, cal);
    const capacity = Math.max(0, base - absenceCut(date, base, person.absences));
    const p = planned.get(date) ?? 0;
    const logged = person.loggedByDate ? person.loggedByDate.get(date) ?? 0 : null;
    capSum += capacity;
    planSum += p;
    if (logged != null) logSum += logged;
    if (p > 0 && p > capacity + 0.005) overloadedDays++;
    return {
      date,
      capacity: round2(capacity),
      planned: round2(p),
      logged: logged == null ? null : round2(logged),
      tasks: chips.get(date) ?? [],
    };
  });

  return {
    days,
    totals: {
      capacity: round2(capSum),
      planned: round2(planSum),
      logged: person.loggedByDate ? round2(logSum) : null,
      undatedHours: round2(undated),
      overdueHours: round2(overdue),
      utilizationPct: capSum > 0 ? Math.round((planSum / capSum) * 100) : 0,
      overloadedDays,
    },
    taskById,
  };
}

// ─── Chips: masking ──────────────────────────────────────────────────

export const MASKED_PROJECT_LABEL = 'Other project';
export const MASKED_PERSONAL_LABEL = 'Personal task';

export interface TaskChip {
  taskId: number | null;
  code: string | null;
  name: string;
  projectId: number | null;
  projectName: string | null;
  hours: number;
  masked?: true;
}

/**
 * A day's task chips for this caller. A task on a project the caller
 * cannot open keeps its hours but loses id, code, name and project
 * ("Other project"); someone else's personal task likewise ("Personal
 * task"). Masked chips of a day are merged into one per label so their
 * count gives nothing away either.
 */
export function shapeChips(
  dayTasks: DayTask[],
  taskById: Map<number, WorkloadTask>,
  canSee: (task: WorkloadTask) => boolean,
): TaskChip[] {
  const out: TaskChip[] = [];
  const masked = new Map<string, TaskChip>();
  for (const dt of dayTasks) {
    const t = taskById.get(dt.taskId);
    if (!t) continue;
    if (canSee(t)) {
      out.push({
        taskId: t.id,
        code: t.code ?? null,
        name: t.name,
        projectId: t.projectId,
        projectName: t.projectName ?? null,
        hours: dt.hours,
      });
      continue;
    }
    const label = t.projectId == null ? MASKED_PERSONAL_LABEL : MASKED_PROJECT_LABEL;
    const cur = masked.get(label);
    if (cur) cur.hours = round2(cur.hours + dt.hours);
    else masked.set(label, { taskId: null, code: null, name: label, projectId: null, projectName: null, hours: dt.hours, masked: true });
  }
  return [...out, ...masked.values()];
}
