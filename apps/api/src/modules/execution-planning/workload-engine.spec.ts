/**
 * QA6 P3 (PR-073 / PR-074) — the workload engine: work week from
 * HrSettings.weeklyRestDays, capacity (schedule / dailyStandardHours /
 * calendar / absences), planned = remaining hours split between the
 * assignees, undated tasks off the days, masking of task chips.
 */
import {
  OrgCalendar,
  PersonInput,
  WorkloadTask,
  buildOrgCalendar,
  computePersonWorkload,
  countPersonWorkingDays,
  datesBetween,
  shapeChips,
  weekPattern,
  weekStartsOn,
  workWeekOf,
} from './workload-engine';

// Sun 22 … Sat 28 Nov 2026.
const WEEK = datesBetween('2026-11-22', '2026-11-28');
const TODAY = '2026-11-22';
const ISRAEL = buildOrgCalendar([5, 6], []);

function person(over: Partial<PersonInput> = {}): PersonInput {
  return { userId: 1, dailyStandardHours: 8, schedules: [], absences: [], tasks: [], loggedByDate: null, ...over };
}

function task(over: Partial<WorkloadTask> = {}): WorkloadTask {
  return {
    id: 1, code: 'T-1', name: 'Model walls', projectId: 59, projectName: 'P59',
    budgetHours: 10, loggedHours: 0, assigneeCount: 1,
    estimatedStartDate: '2026-11-22', startDate: null, endDate: '2026-11-26',
    ...over,
  };
}

const byDate = (wl: ReturnType<typeof computePersonWorkload>) => new Map(wl.days.map((d) => [d.date, d]));

describe('work week from HrSettings.weeklyRestDays', () => {
  it('a Fri + Sat org starts its week on Sunday, and Sunday is a working day', () => {
    expect(weekStartsOn([5, 6])).toBe(0);
    expect(workWeekOf('2026-11-25', [5, 6])).toEqual({ from: '2026-11-22', to: '2026-11-28' });
    // On a Sunday the week is THIS week, not next Monday's (the PR-074 0% bug).
    expect(workWeekOf('2026-11-22', [5, 6])).toEqual({ from: '2026-11-22', to: '2026-11-28' });
    const wl = computePersonWorkload(person(), ISRAEL, { dates: WEEK, today: TODAY });
    expect(wl.days.map((d) => d.capacity)).toEqual([8, 8, 8, 8, 8, 0, 0]);
  });

  it('a Sat + Sun org starts on Monday; an unset / bad value falls back to Fri + Sat', () => {
    expect(weekStartsOn([6, 0])).toBe(1);
    expect(workWeekOf('2026-11-22', [0, 6])).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    expect(buildOrgCalendar(null, []).restDays).toEqual([5, 6]);
    expect(buildOrgCalendar(['x'], []).restDays).toEqual([5, 6]);
    const weekend = buildOrgCalendar([0, 6], []);
    const wl = computePersonWorkload(person(), weekend, { dates: WEEK, today: TODAY });
    expect(wl.days.map((d) => d.capacity)).toEqual([0, 8, 8, 8, 8, 8, 0]);
  });
});

describe('capacity', () => {
  it('no schedule row → the person’s dailyStandardHours; not a positive number → 8', () => {
    expect(weekPattern(person({ dailyStandardHours: 8.4 }), [5, 6])).toEqual([8.4, 8.4, 8.4, 8.4, 8.4, 0, 0]);
    expect(weekPattern(person({ dailyStandardHours: null }), [5, 6])[0]).toBe(8);
    expect(weekPattern(person({ dailyStandardHours: 0 }), [5, 6])[0]).toBe(8);
  });

  it('a schedule row wins for its weekday (even on a rest day); the latest effective row wins', () => {
    const p = person({
      schedules: [
        { dayOfWeek: 1, shiftStart: '08:00', shiftEnd: '17:00', breakMinutes: 60, effectiveFrom: '2026-01-01' }, // 8h
        { dayOfWeek: 1, shiftStart: '09:00', shiftEnd: '14:00', breakMinutes: 0, effectiveFrom: '2026-06-01' }, // 5h — newer
        { dayOfWeek: 5, shiftStart: '08:00', shiftEnd: '12:00', breakMinutes: 0, effectiveFrom: '2026-01-01' }, // Friday 4h
      ],
    });
    const wl = computePersonWorkload(p, ISRAEL, { dates: WEEK, today: TODAY });
    expect(wl.days.map((d) => d.capacity)).toEqual([8, 5, 8, 8, 8, 4, 0]);
  });

  it('calendar: a holiday with no hours is off; a holiday eve keeps its hours and stays a working day', () => {
    const cal = buildOrgCalendar([5, 6], [
      { date: new Date('2026-11-23T00:00:00Z'), type: 'HOLIDAY', workingHours: null, name: 'Holiday' },
      { date: new Date('2026-11-24T00:00:00Z'), type: 'HOLIDAY_EVE', workingHours: '5.00', name: 'Eve' },
      { date: new Date('2026-11-25T00:00:00Z'), type: 'REGULAR', workingHours: null, name: 'Plain' },
    ]);
    const wl = computePersonWorkload(person({ tasks: [task({ budgetHours: 8 })] }), cal, { dates: WEEK, today: TODAY });
    const d = byDate(wl);
    expect(d.get('2026-11-23')!.capacity).toBe(0);
    expect(d.get('2026-11-24')!.capacity).toBe(5);
    expect(d.get('2026-11-25')!.capacity).toBe(8);
    // Sun, Tue (eve), Wed, Thu → 4 working days for the spread; Monday gets nothing.
    expect(d.get('2026-11-23')!.planned).toBe(0);
    expect(d.get('2026-11-24')!.planned).toBe(2);
    expect(wl.totals.capacity).toBe(8 + 0 + 5 + 8 + 8);
  });

  it('absences come off: a whole day, half a day (DAY 0.5) and hours', () => {
    const p = person({
      absences: [
        { dateFrom: '2026-11-22', dateTo: '2026-11-23', unit: 'DAY', amount: 1 }, // Sun + Mon off
        { dateFrom: '2026-11-24', dateTo: '2026-11-24', unit: 'DAY', amount: 0.5 },
        { dateFrom: '2026-11-25', dateTo: '2026-11-25', unit: 'HOUR', amount: 3 },
        { dateFrom: '2026-11-26', dateTo: '2026-11-26', unit: 'HOUR', amount: 20 }, // never below 0
      ],
    });
    const wl = computePersonWorkload(p, ISRAEL, { dates: WEEK, today: TODAY });
    expect(wl.days.map((d) => d.capacity)).toEqual([0, 0, 4, 5, 0, 0, 0]);
    expect(wl.totals.capacity).toBe(9);
  });
});

describe('planned hours', () => {
  it('remaining hours (budget − logged on the task) are split between the 2 assignees, spread over Sun–Thu', () => {
    const wl = computePersonWorkload(
      person({ tasks: [task({ budgetHours: 20, loggedHours: 4, assigneeCount: 2 })] }),
      ISRAEL,
      { dates: WEEK, today: TODAY },
    );
    // (20 − 4) / 2 = 8h for this person, over 5 working days.
    expect(wl.totals.planned).toBe(8);
    expect(wl.days.map((d) => d.planned)).toEqual([1.6, 1.6, 1.6, 1.6, 1.6, 0, 0]);
    expect(wl.days[0].tasks).toEqual([{ taskId: 1, hours: 1.6 }]);
  });

  it('fully logged tasks plan nothing (floor 0)', () => {
    const wl = computePersonWorkload(person({ tasks: [task({ budgetHours: 10, loggedHours: 12 })] }), ISRAEL, { dates: WEEK, today: TODAY });
    expect(wl.totals.planned).toBe(0);
    expect(wl.days.every((d) => d.tasks.length === 0)).toBe(true);
  });

  it('a task with no end date is on no day — it is counted in undatedHours', () => {
    const wl = computePersonWorkload(
      person({ tasks: [task({ estimatedStartDate: null, endDate: null, budgetHours: 12 })] }),
      ISRAEL,
      { dates: WEEK, today: TODAY },
    );
    expect(wl.totals.planned).toBe(0);
    expect(wl.totals.undatedHours).toBe(12);
    expect(wl.days.every((d) => d.planned === 0)).toBe(true);
  });

  it('the spread starts at estimatedStartDate, else startDate, else today', () => {
    const est = computePersonWorkload(person({ tasks: [task({ estimatedStartDate: '2026-11-25', startDate: '2026-11-22', budgetHours: 4 })] }), ISRAEL, { dates: WEEK, today: TODAY });
    expect(est.days.map((d) => d.planned)).toEqual([0, 0, 0, 2, 2, 0, 0]);
    const act = computePersonWorkload(person({ tasks: [task({ estimatedStartDate: null, startDate: '2026-11-25', budgetHours: 4 })] }), ISRAEL, { dates: WEEK, today: TODAY });
    expect(act.days.map((d) => d.planned)).toEqual([0, 0, 0, 2, 2, 0, 0]);
    const none = computePersonWorkload(person({ tasks: [task({ estimatedStartDate: null, startDate: null, budgetHours: 4 })] }), ISRAEL, { dates: WEEK, today: '2026-11-25' });
    expect(none.days.map((d) => d.planned)).toEqual([0, 0, 0, 2, 2, 0, 0]);
  });

  it('a task due on a Friday is done on Thursday', () => {
    const wl = computePersonWorkload(
      person({ tasks: [task({ estimatedStartDate: '2026-11-27', endDate: '2026-11-27', budgetHours: 6 })] }),
      ISRAEL,
      { dates: WEEK, today: TODAY },
    );
    expect(byDate(wl).get('2026-11-26')!.planned).toBe(6);
    expect(wl.totals.undatedHours).toBe(0);
  });

  it('an overdue task keeps its own dates and is reported in overdueHours', () => {
    const wl = computePersonWorkload(
      person({ tasks: [task({ estimatedStartDate: '2026-11-01', endDate: '2026-11-05', budgetHours: 10 })] }),
      ISRAEL,
      { dates: WEEK, today: TODAY },
    );
    expect(wl.totals.planned).toBe(0);
    expect(wl.totals.overdueHours).toBe(10);
  });

  it('an absence day keeps its planned share, so the clash shows (planned > capacity)', () => {
    const wl = computePersonWorkload(
      person({ tasks: [task({ budgetHours: 10 })], absences: [{ dateFrom: '2026-11-22', dateTo: '2026-11-22', unit: 'DAY', amount: 1 }] }),
      ISRAEL,
      { dates: WEEK, today: TODAY },
    );
    expect(wl.days[0]).toMatchObject({ capacity: 0, planned: 2 });
    expect(wl.totals.overloadedDays).toBe(1);
  });

  it('a task ending 9999-12-31 is counted in closed form (fast)', () => {
    const t0 = Date.now();
    const wl = computePersonWorkload(
      person({ tasks: [task({ estimatedStartDate: '2026-01-01', endDate: '9999-12-31', budgetHours: 1000 })] }),
      ISRAEL,
      { dates: WEEK, today: TODAY },
    );
    expect(Date.now() - t0).toBeLessThan(200);
    // ~2M working days → a sliver a day, never the whole budget in the viewed week.
    expect(wl.totals.planned).toBeLessThan(0.05);
    expect(wl.days[0].tasks).toHaveLength(1);
  });

  it('countPersonWorkingDays matches a day-by-day count', () => {
    const cal: OrgCalendar = buildOrgCalendar([5, 6], [
      { date: '2026-12-03', type: 'HOLIDAY', workingHours: 0, name: 'H' },
      { date: '2026-12-05', type: 'HOLIDAY', workingHours: 0, name: 'Sat holiday' },
    ]);
    const pattern = weekPattern(person(), cal.restDays);
    const days = datesBetween('2026-11-20', '2026-12-31');
    const slow = days.filter((d) => pattern[new Date(`${d}T00:00:00Z`).getUTCDay()] > 0 && !cal.nonWorking.has(d)).length;
    expect(countPersonWorkingDays('2026-11-20', '2026-12-31', pattern, cal)).toBe(slow);
  });

  it('logged per day only when the caller may see it', () => {
    const seen = computePersonWorkload(person({ loggedByDate: new Map([['2026-11-23', 6.5]]) }), ISRAEL, { dates: WEEK, today: TODAY });
    expect(seen.days[1].logged).toBe(6.5);
    expect(seen.totals.logged).toBe(6.5);
    const hidden = computePersonWorkload(person({ loggedByDate: null }), ISRAEL, { dates: WEEK, today: TODAY });
    expect(hidden.days.every((d) => d.logged === null)).toBe(true);
    expect(hidden.totals.logged).toBeNull();
  });
});

describe('task chips — masking', () => {
  const tasks = new Map<number, WorkloadTask>([
    [1, task({ id: 1, projectId: 59, projectName: 'Mine' })],
    [2, task({ id: 2, code: 'SEC-1', name: 'Secret', projectId: 60, projectName: 'Secret project' })],
    [3, task({ id: 3, code: 'SEC-2', name: 'Secret 2', projectId: 61, projectName: 'Secret 2' })],
    [4, task({ id: 4, code: null, name: 'Dentist', projectId: null, projectName: null })],
  ]);
  const canSee = (t: WorkloadTask) => t.projectId === 59;

  it('a task of a project the caller cannot open keeps its hours, loses name / code / ids; masked chips merge', () => {
    const chips = shapeChips(
      [{ taskId: 1, hours: 1 }, { taskId: 2, hours: 2 }, { taskId: 3, hours: 0.5 }, { taskId: 4, hours: 1 }],
      tasks,
      canSee,
    );
    expect(chips[0]).toMatchObject({ taskId: 1, name: 'Model walls', projectName: 'Mine', hours: 1 });
    expect(chips).toContainEqual({ taskId: null, code: null, name: 'Other project', projectId: null, projectName: null, hours: 2.5, masked: true });
    expect(chips).toContainEqual({ taskId: null, code: null, name: 'Personal task', projectId: null, projectName: null, hours: 1, masked: true });
    const json = JSON.stringify(chips);
    expect(json).not.toContain('Secret');
    expect(json).not.toContain('SEC-');
    expect(json).not.toContain('Dentist');
  });
});
