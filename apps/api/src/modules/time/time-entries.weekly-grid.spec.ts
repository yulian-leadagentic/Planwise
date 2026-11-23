/**
 * GET /time-entries/weekly — the shared `WeeklyGrid` shape
 * (packages/shared/src/types/time.types.ts) that /time/grid,
 * /time/summary and the /time calendar render. Locks the response shape
 * and the numbers, plus the matching week mode of /time-entries/daily.
 *
 * Fixture week: Mon 2025-03-03 … Sun 2025-03-09 (in the past, so every
 * day counts for overtime / missing).
 *   Mon  task 11 ×2 entries (120 + 60), clocked 08–12 + 13–17 (480)
 *   Tue  task 12 (entry.projectId NULL → via the task), 240; clock open
 *   Wed  task-less entry on project 60, 30; work calendar HOLIDAY_EVE 5h
 *   Thu  sick record (not attendance, nothing expected)
 *   Schedule Sun–Thu 08:00–17:00, 30 min break → 510 a day
 */
import { ForbiddenException } from '@nestjs/common';

import { TimeEntriesService } from './time-entries.service';
import { TimeEntriesController } from './time-entries.controller';

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

const TOWER = { id: 59, name: 'Tower A' };
const BRIDGE = { id: 60, name: 'Bridge' };
const MODEL_TASK = { id: 11, name: 'Model L2', code: 'T-11', projectId: 59, budgetHours: '40', project: TOWER, zone: { id: 4, name: 'L2' } };
const CLASH_TASK = { id: 12, name: 'Clash', code: 'T-12', projectId: 59, budgetHours: null, project: TOWER, zone: null };

const ENTRIES = [
  { id: 1, userId: 30, date: local(2025, 3, 3), minutes: 120, startTime: '08:00', endTime: '10:00', projectId: 59, taskId: 11, project: TOWER, task: MODEL_TASK },
  { id: 2, userId: 30, date: local(2025, 3, 3), minutes: 60, startTime: '10:00', endTime: '11:00', projectId: 59, taskId: 11, project: TOWER, task: MODEL_TASK },
  { id: 3, userId: 30, date: local(2025, 3, 4), minutes: 240, startTime: null, endTime: null, projectId: null, taskId: 12, project: null, task: CLASH_TASK },
  { id: 4, userId: 30, date: local(2025, 3, 5), minutes: 30, startTime: null, endTime: null, projectId: 60, taskId: null, project: BRIDGE, task: null },
];

const CLOCKS = [
  { id: 101, userId: 30, date: local(2025, 3, 3), status: 'completed', clockIn: local(2025, 3, 3, 8), clockOut: local(2025, 3, 3, 12), totalMinutes: 240, expectedMinutes: 510 },
  { id: 102, userId: 30, date: local(2025, 3, 3), status: 'completed', clockIn: local(2025, 3, 3, 13), clockOut: local(2025, 3, 3, 17), totalMinutes: 240, expectedMinutes: null },
  { id: 103, userId: 30, date: local(2025, 3, 4), status: 'clocked_in', clockIn: local(2025, 3, 4, 9), clockOut: null, totalMinutes: null, expectedMinutes: null },
  { id: 104, userId: 30, date: local(2025, 3, 6), status: 'sick', clockIn: local(2025, 3, 6), clockOut: null, totalMinutes: 0, expectedMinutes: null },
];

const SCHEDULES = [0, 1, 2, 3, 4].map((dayOfWeek) => ({
  dayOfWeek,
  shiftStart: '08:00',
  shiftEnd: '17:00',
  breakMinutes: 30,
  effectiveFrom: local(2020, 1, 1),
  effectiveUntil: null,
}));

const CALENDAR = [{ date: local(2025, 3, 5), type: 'HOLIDAY_EVE', workingHours: '5' }];

function makeService(over: { entries?: any[]; clocks?: any[] } = {}) {
  const prisma: any = {
    timeEntry: { findMany: jest.fn(async () => over.entries ?? ENTRIES) },
    timeClock: { findMany: jest.fn(async () => over.clocks ?? CLOCKS) },
    workSchedule: { findMany: jest.fn(async () => SCHEDULES) },
    calendarDay: { findMany: jest.fn(async () => CALENDAR) },
  };
  return { prisma, service: new TimeEntriesService(prisma, { write: jest.fn() } as any) };
}

const DAYS = ['2025-03-03', '2025-03-04', '2025-03-05', '2025-03-06', '2025-03-07', '2025-03-08', '2025-03-09'];

describe('GET /time-entries/weekly — shared WeeklyGrid shape', () => {
  it('top level: weekStart, rows, clock, dailyTotals, weekSummary', async () => {
    const out: any = await makeService().service.getWeeklyGrid(30, '2025-03-03');
    expect(Object.keys(out).sort()).toEqual(['clock', 'dailyTotals', 'rows', 'weekStart', 'weekSummary']);
    expect(out.weekStart).toBe('2025-03-03');
  });

  it('rows: one per task / task-less project, 7 day cells (null or { id, minutes, entries })', async () => {
    const { rows }: any = await makeService().service.getWeeklyGrid(30, '2025-03-03');
    // sorted by project name, then task name
    expect(rows.map((r: any) => [r.type, r.projectName, r.taskName])).toEqual([
      ['project', 'Bridge', undefined],
      ['task', 'Tower A', 'Clash'],
      ['task', 'Tower A', 'Model L2'],
    ]);
    for (const r of rows) expect(Object.keys(r.days)).toEqual(DAYS);

    const model = rows[2];
    expect(model).toMatchObject({
      type: 'task',
      taskId: 11,
      taskName: 'Model L2',
      projectId: 59,
      projectName: 'Tower A',
      labelPath: 'Tower A / L2',
      weekTotalMinutes: 180,
      budgetHours: 40,
    });
    // two entries in one cell: id = the first, minutes = the sum, entries for the calendar
    expect(model.days['2025-03-03']).toMatchObject({ id: 1, minutes: 180 });
    expect(model.days['2025-03-03'].entries.map((e: any) => e.id)).toEqual([1, 2]);
    expect(model.days['2025-03-04']).toBeNull();

    const clash = rows[1];
    expect(clash).toMatchObject({ projectId: 59, labelPath: 'Tower A', weekTotalMinutes: 240 });
    expect(clash).not.toHaveProperty('budgetHours');
    expect(clash.days['2025-03-04']).toMatchObject({ id: 3, minutes: 240 });

    const bridge = rows[0];
    expect(bridge).toMatchObject({ type: 'project', projectId: 60, projectName: 'Bridge', labelPath: 'Bridge', weekTotalMinutes: 30 });
    expect(bridge).not.toHaveProperty('taskId');
    expect(bridge.days['2025-03-05']).toMatchObject({ id: 4, minutes: 30 });
  });

  it('clock: attendance days only — first in, last out (null while open), clocked and expected minutes', async () => {
    const { clock }: any = await makeService().service.getWeeklyGrid(30, '2025-03-03');
    expect(Object.keys(clock).sort()).toEqual(['2025-03-03', '2025-03-04']); // the sick record is not a clock
    expect(clock['2025-03-03']).toEqual({
      clockIn: local(2025, 3, 3, 8).toISOString(),
      clockOut: local(2025, 3, 3, 17).toISOString(),
      totalMinutes: 480,
      expectedMinutes: 510,
    });
    expect(clock['2025-03-04']).toEqual({
      clockIn: local(2025, 3, 4, 9).toISOString(),
      clockOut: null,
      totalMinutes: null,
      expectedMinutes: 510,
    });
  });

  it('dailyTotals: every day has { logged, clocked, diff }', async () => {
    const { dailyTotals }: any = await makeService().service.getWeeklyGrid(30, '2025-03-03');
    expect(Object.keys(dailyTotals)).toEqual(DAYS);
    expect(dailyTotals['2025-03-03']).toEqual({ logged: 180, clocked: 480, diff: -300 });
    expect(dailyTotals['2025-03-04']).toEqual({ logged: 240, clocked: null, diff: null });
    expect(dailyTotals['2025-03-05']).toEqual({ logged: 30, clocked: null, diff: null });
    expect(dailyTotals['2025-03-06']).toEqual({ logged: 0, clocked: null, diff: null });
  });

  it('weekSummary: expected follows the schedule, the work calendar and leave; net over past days', async () => {
    const { weekSummary }: any = await makeService().service.getWeeklyGrid(30, '2025-03-03');
    // expected: Mon 510 + Tue 510 + Wed 300 (calendar 5h) + Thu 0 (sick) + Fri/Sat 0 + Sun 510
    // worked:   Mon 480 (clocked) + Tue 240 (open clock → logged) + Wed 30 (logged) = 750
    expect(weekSummary).toEqual({
      totalLogged: 450,
      totalClocked: 480,
      totalExpected: 1830,
      overtimeMinutes: 0,
      missingMinutes: 1080,
    });
  });

  it('overtime when worked exceeds expected', async () => {
    const long = [{ ...CLOCKS[0], totalMinutes: 2400 }, CLOCKS[3]]; // keep Thursday's sick record
    const { weekSummary }: any = await makeService({ clocks: long }).service.getWeeklyGrid(30, '2025-03-03');
    // worked 2400 + 240 + 30 = 2670 vs expected 1830 → +840
    expect(weekSummary).toMatchObject({ overtimeMinutes: 840, missingMinutes: 0 });
  });

  it('days that have not ended yet do not count towards overtime / missing', async () => {
    const { weekSummary }: any = await makeService({ entries: [], clocks: [] }).service.getWeeklyGrid(30, '2099-01-05');
    expect(weekSummary).toMatchObject({ totalExpected: 2550, overtimeMinutes: 0, missingMinutes: 0 });
  });

  it('queries live entries of the user; projectId narrows rows (through the entry or its task)', async () => {
    const { prisma, service } = makeService();
    await service.getWeeklyGrid(30, '2025-03-03', { projectId: 59 });
    const where = prisma.timeEntry.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ userId: 30, deletedAt: null });
    expect(where.OR).toEqual([{ projectId: 59 }, { task: { projectId: 59 } }]);
  });

  it('no weekStart → the empty shape', async () => {
    const out: any = await makeService().service.getWeeklyGrid(30, '');
    expect(out).toEqual({
      weekStart: '',
      rows: [],
      clock: {},
      dailyTotals: {},
      weekSummary: { totalLogged: 0, totalClocked: 0, totalExpected: 0, overtimeMinutes: 0, missingMinutes: 0 },
    });
  });
});

describe('GET /time-entries/daily?weekStart= — agrees with the weekly grid', () => {
  it('uses the same attendance and expected rules per day', async () => {
    const days: any[] = await makeService().service.getWeekDailyBreakdown(30, '2025-03-03');
    expect(days.map((d) => d.date)).toEqual(DAYS);
    // the day's attendance in the TimeClock shape: latest record, first-in → last-out span
    expect(days[0]).toMatchObject({
      clock: { id: 102, clockIn: local(2025, 3, 3, 8), clockOut: local(2025, 3, 3, 17), totalMinutes: 480 },
      totalLogged: 180,
      difference: -300,
      isBalanced: false,
    });
    expect(days[1].clock).toMatchObject({ id: 103, clockOut: null, totalMinutes: null }); // still open
    expect(days[0].expected).toEqual({ shiftStart: '08:00', shiftEnd: '17:00', breakMinutes: 30, expectedMinutes: 510 });
    expect(days[2].expected).toMatchObject({ expectedMinutes: 300 }); // HOLIDAY_EVE 5h
    expect(days[3]).toMatchObject({ clock: null, expected: null }); // sick: no clock, nothing expected
    expect(days[4]).toMatchObject({ clock: null, expected: null, totalLogged: 0 }); // Friday: no schedule
  });
});

describe('GET /time-entries/weekly — controller', () => {
  function make(canView: boolean) {
    const svc: any = { getWeeklyGrid: jest.fn(async () => ({})) };
    const scope: any = { assertCanViewEmployee: jest.fn(async () => { if (!canView) throw new ForbiddenException(); }) };
    return { ctrl: new TimeEntriesController(svc, {} as any, scope, {} as any), svc, scope };
  }

  it('passes ?projectId= through as a number', async () => {
    const { ctrl, svc } = make(true);
    await ctrl.getWeeklyGrid({ id: 30 }, '2025-03-03', undefined, '59');
    expect(svc.getWeeklyGrid).toHaveBeenCalledWith(30, '2025-03-03', { projectId: 59 });
    await ctrl.getWeeklyGrid({ id: 30 }, '2025-03-03', undefined, '');
    expect(svc.getWeeklyGrid).toHaveBeenLastCalledWith(30, '2025-03-03', {});
  });

  it('the ?userId= privacy rule is unchanged', async () => {
    const { ctrl, svc, scope } = make(false);
    await expect(ctrl.getWeeklyGrid({ id: 30 }, '2025-03-03', 77, '59')).rejects.toThrow(ForbiddenException);
    expect(scope.assertCanViewEmployee).toHaveBeenCalledWith({ id: 30 }, 77, 'attendance and time entries');
    expect(svc.getWeeklyGrid).not.toHaveBeenCalled();
  });
});
