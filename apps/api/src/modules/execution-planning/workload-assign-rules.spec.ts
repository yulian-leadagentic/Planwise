/**
 * QA6 PR-063 — the pure drag-and-drop rules in workload-engine.ts
 * (locked spec D1, D5, D6 and the service gate). The web runs the same
 * rules for dimming and the before→after preview.
 */
import {
  OrgUnitLike,
  buildOrgCalendar,
  countOrgWorkingDays,
  departmentOf,
  isOrgWorkingDay,
  normalizeIdList,
  planMoveDates,
  providesService,
  resolveEffectiveServiceId,
  shiftByWorkingDays,
  workingDayDelta,
} from './workload-engine';

// Fri + Sat rest; Tuesday 2026-12-01 is a holiday, Wednesday 2026-12-02 a short eve (still working).
const cal = buildOrgCalendar([5, 6], [
  { date: new Date('2026-12-01T00:00:00Z'), type: 'HOLIDAY', workingHours: 0, name: 'Holiday' },
  { date: new Date('2026-12-02T00:00:00Z'), type: 'HOLIDAY_EVE', workingHours: 4, name: 'Eve' },
]);
const plain = buildOrgCalendar([5, 6], []);
const d = (key: string) => new Date(`${key}T00:00:00Z`);
const TODAY = '2026-11-22'; // Sunday

describe('org working days', () => {
  it('rest days and calendar days off are not working days; a short eve is', () => {
    expect(isOrgWorkingDay('2026-11-26', cal)).toBe(true); // Thu
    expect(isOrgWorkingDay('2026-11-27', cal)).toBe(false); // Fri
    expect(isOrgWorkingDay('2026-11-28', cal)).toBe(false); // Sat
    expect(isOrgWorkingDay('2026-12-01', cal)).toBe(false); // holiday
    expect(isOrgWorkingDay('2026-12-02', cal)).toBe(true); // eve
    expect(countOrgWorkingDays('2026-11-22', '2026-11-28', plain)).toBe(5);
    expect(countOrgWorkingDays('2026-11-29', '2026-12-05', cal)).toBe(4);
  });

  it('workingDayDelta is signed and counts working days between the columns', () => {
    expect(workingDayDelta('2026-11-23', '2026-11-24', plain)).toBe(1); // Mon → Tue
    expect(workingDayDelta('2026-11-24', '2026-11-23', plain)).toBe(-1); // Tue → Mon
    expect(workingDayDelta('2026-11-26', '2026-11-29', plain)).toBe(1); // Thu → next Sun
    expect(workingDayDelta('2026-11-22', '2026-11-26', plain)).toBe(4);
    expect(workingDayDelta('2026-11-24', '2026-11-24', plain)).toBe(0);
    expect(workingDayDelta('2026-11-30', '2026-12-02', cal)).toBe(1); // over the holiday
  });

  it('shiftByWorkingDays lands on working days and skips rest days and holidays', () => {
    expect(shiftByWorkingDays('2026-11-26', 1, plain)).toBe('2026-11-29'); // Thu + 1 → Sun
    expect(shiftByWorkingDays('2026-11-29', -1, plain)).toBe('2026-11-26');
    expect(shiftByWorkingDays('2026-11-30', 1, cal)).toBe('2026-12-02'); // Mon + 1 skips the holiday
    expect(shiftByWorkingDays('2026-11-24', 0, cal)).toBe('2026-11-24');
    // A calendar with no working day at all never hangs.
    expect(typeof shiftByWorkingDays('2026-11-24', 3, buildOrgCalendar([0, 1, 2, 3, 4, 5, 6], []))).toBe('string');
  });
});

describe('planMoveDates — D5 (a day column → another)', () => {
  it('shifts the whole task by the working-day delta and keeps its working-day length', () => {
    // Sun..Tue (3 working days) dragged from Mon to Wed: +2.
    const out = planMoveDates({ estimatedStartDate: d('2026-11-22'), startDate: null, endDate: d('2026-11-24') }, '2026-11-23', '2026-11-25', plain, TODAY);
    expect(out).toEqual({ changed: true, estimatedStartDate: '2026-11-24', endDate: '2026-11-26' });
    expect(countOrgWorkingDays(out.estimatedStartDate!, out.endDate!, plain)).toBe(3);
    // Over the weekend: Wed..Thu + 1 → Thu..Sun.
    expect(planMoveDates({ estimatedStartDate: d('2026-11-25'), endDate: d('2026-11-26') }, '2026-11-25', '2026-11-26', plain, TODAY))
      .toEqual({ changed: true, estimatedStartDate: '2026-11-26', endDate: '2026-11-29' });
  });

  it('same column (delta 0) changes nothing — a pure reassign', () => {
    expect(planMoveDates({ estimatedStartDate: d('2026-11-23'), endDate: d('2026-11-23') }, '2026-11-23', '2026-11-23', plain, TODAY))
      .toEqual({ changed: false, estimatedStartDate: '2026-11-23', endDate: '2026-11-23' });
  });

  it('writes the effective start explicitly (startDate, else today) and never touches startDate', () => {
    // No estimate: the actual start is where the window begins.
    expect(planMoveDates({ estimatedStartDate: null, startDate: d('2026-11-23'), endDate: d('2026-11-24') }, '2026-11-24', '2026-11-25', plain, TODAY))
      .toEqual({ changed: true, estimatedStartDate: '2026-11-24', endDate: '2026-11-25' });
    // No start at all: from today, as the engine spreads it.
    expect(planMoveDates({ estimatedStartDate: null, startDate: null, endDate: d('2026-11-24') }, '2026-11-23', '2026-11-24', plain, TODAY))
      .toEqual({ changed: true, estimatedStartDate: '2026-11-23', endDate: '2026-11-25' });
  });

  it('no drop day or no end date → no date change', () => {
    expect(planMoveDates({ estimatedStartDate: d('2026-11-23'), endDate: d('2026-11-24') }, '2026-11-23', null, plain, TODAY).changed).toBe(false);
    expect(planMoveDates({ estimatedStartDate: d('2026-11-23'), endDate: null }, '2026-11-23', '2026-11-25', plain, TODAY))
      .toEqual({ changed: false, estimatedStartDate: '2026-11-23', endDate: null });
  });
});

describe('planMoveDates — D6 (tray drop, no source column)', () => {
  const task = { estimatedStartDate: d('2026-11-24'), startDate: null, endDate: d('2026-11-25') }; // Tue..Wed

  it('a drop inside the window of a task that is not overdue keeps the dates', () => {
    expect(planMoveDates(task, null, '2026-11-25', plain, TODAY).changed).toBe(false);
    expect(planMoveDates(task, null, '2026-11-24', plain, TODAY).changed).toBe(false);
  });

  it('a drop outside the window starts the window on the drop day with its working-day length', () => {
    // 2 working days starting Thursday → Thu..Sun.
    expect(planMoveDates(task, null, '2026-11-26', plain, TODAY)).toEqual({ changed: true, estimatedStartDate: '2026-11-26', endDate: '2026-11-29' });
    expect(planMoveDates(task, null, '2026-11-22', plain, TODAY)).toEqual({ changed: true, estimatedStartDate: '2026-11-22', endDate: '2026-11-23' });
  });

  it('an overdue task is anchored on the drop day even when the day is inside its old window', () => {
    const overdue = { estimatedStartDate: d('2026-11-10'), endDate: d('2026-11-12') }; // Tue..Thu, before today
    expect(planMoveDates(overdue, null, '2026-11-11', plain, TODAY)).toEqual({ changed: true, estimatedStartDate: '2026-11-11', endDate: '2026-11-15' });
    // No start and overdue: a one-day window on the drop day.
    expect(planMoveDates({ estimatedStartDate: null, startDate: null, endDate: d('2026-01-08') }, null, '2026-11-23', plain, TODAY))
      .toEqual({ changed: true, estimatedStartDate: '2026-11-23', endDate: '2026-11-23' });
  });
});

describe('the service gate', () => {
  it('effective service: task.phaseId → projectDeliverable.serviceId → deliverableTemplate.phaseId', () => {
    expect(resolveEffectiveServiceId({ phaseId: 7, deliverableServiceId: 8, templatePhaseId: 9 })).toBe(7);
    expect(resolveEffectiveServiceId({ phaseId: null, deliverableServiceId: 8, templatePhaseId: 9 })).toBe(8);
    expect(resolveEffectiveServiceId({ phaseId: null, projectDeliverable: null, deliverableTemplate: { phaseId: 9 } })).toBe(9);
    expect(resolveEffectiveServiceId({ projectDeliverable: { serviceId: 4 } })).toBe(4);
    expect(resolveEffectiveServiceId({})).toBeNull();
  });

  it('providesService: no service, a lifecycle phase, or no requirement → true; else hold any one', () => {
    const bim = { kind: 'service', requiredProfessionIds: [3, 5] };
    expect(providesService({ qualificationIds: [] }, null)).toBe(true);
    expect(providesService({ qualificationIds: [] }, { kind: 'phase', requiredProfessionIds: [3] })).toBe(true);
    expect(providesService({ qualificationIds: [] }, { kind: 'service', requiredProfessionIds: null })).toBe(true);
    expect(providesService({ qualificationIds: [] }, { kind: 'service', requiredProfessionIds: [] })).toBe(true);
    expect(providesService({ qualificationIds: [5] }, bim)).toBe(true);
    expect(providesService({ qualificationIds: [4] }, bim)).toBe(false);
    expect(providesService({ qualificationIds: null }, bim)).toBe(false);
  });

  it('normalizeIdList keeps distinct positive integers, sorted', () => {
    expect(normalizeIdList([5, '3', 3, -1, 0, 'x', 2.5])).toEqual([3, 5]);
    expect(normalizeIdList(null)).toEqual([]);
    expect(normalizeIdList({ a: 1 })).toEqual([]);
  });
});

describe('departmentOf — D1 (the top-level org unit)', () => {
  // Staging tree: Building › {BIM management, MEP coordination › Team Asaf}; Infrastructure.
  const units: OrgUnitLike[] = [
    { id: 1, name: 'Building', parentId: null, path: '/1/' },
    { id: 2, name: 'BIM management', parentId: 1, path: '/1/2/' },
    { id: 3, name: 'MEP coordination', parentId: 1, path: '/1/3/' },
    { id: 4, name: 'Team Asaf', parentId: 3, path: '/1/3/4/' },
    { id: 10, name: 'Infrastructure', parentId: null, path: '/10/' },
    // A unit whose path was never written: parentId is walked instead.
    { id: 5, name: 'Old team', parentId: 3, path: '/' },
  ];
  const byId = new Map(units.map((u) => [u.id, u]));

  it('Daniel (BIM management) and Yair (Team Asaf) are the same department; Infrastructure is another', () => {
    expect(departmentOf(byId.get(2), byId)?.name).toBe('Building');
    expect(departmentOf(byId.get(4), byId)?.name).toBe('Building');
    expect(departmentOf(byId.get(10), byId)?.name).toBe('Infrastructure');
    expect(departmentOf(byId.get(1), byId)?.id).toBe(1);
  });

  it('falls back to parentId, treats an unknown unit as its own department, and no unit as none', () => {
    expect(departmentOf(byId.get(5), byId)?.id).toBe(1);
    expect(departmentOf({ id: 99, name: 'Gone', parentId: null, path: null }, byId)?.id).toBe(99);
    expect(departmentOf(null, byId)).toBeNull();
  });
});
